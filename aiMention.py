import json
import os
import requests
import time
import re
from concurrent.futures import ThreadPoolExecutor

# Note: In a real AWS Lambda environment, these would be in environment variables
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
BRIGHTDATA_TOKEN = os.environ.get('BRIGHTDATA_TOKEN')
ANTHROPIC_API_KEY = os.environ.get('ANTHROPIC_API_KEY')
DATAFORSEO_AUTH = os.environ.get('DATAFORSEO_AUTH')

# Google AI Overview is read off the live SERP, which keys on Google's own
# location/language ids rather than the display labels the UI sends.
DFS_LOCATION_CODES = {
    'singapore': 2702, 'south korea': 2410, 'malaysia': 2458, 'japan': 2392,
    'germany': 2276, 'france': 2250, 'hong kong': 2344, 'taiwan': 2158,
    'thailand': 2764, 'vietnam': 2704, 'australia': 2036, 'canada': 2124,
    'united kingdom': 2826, 'united states': 2840,
}
DFS_LANGUAGE_CODES = {
    'english': 'en', 'korean': 'ko', 'japanese': 'ja', 'german': 'de',
    'french': 'fr', 'thai': 'th', 'vietnamese': 'vi', 'malay': 'ms',
    'tamil': 'ta', 'chinese (simplified)': 'zh-CN', 'chinese (traditional)': 'zh-TW',
}
# The UI's "Global" option has no SERP equivalent — Google always answers from
# somewhere — so it resolves to the US result set.
DFS_DEFAULT_LOCATION = 2840

# Bright Data's sync /scrape endpoint blocks for up to 60s, then answers 202 +
# snapshot_id. Must stay above 60s or we abort exactly as that reply lands and
# never reach the polling fallback; stays under the 180s Lambda/API GW ceiling.
BRIGHTDATA_SCRAPE_TIMEOUT = 120

def lambda_handler(event, context):
    """
    Main Lambda handler for AI Mentions Verification.
    """
    try:
        body = event.get('body', event)
        if isinstance(body, str):
            body = json.loads(body)
            
        action = body.get('action')
        if action == 'poll_snapshot':
            snapshot_id = body.get('snapshot_id')
            brand = body.get('brand')
            url = body.get('url')
            model = body.get('model')
            if not snapshot_id:
                return error_response("Missing snapshot_id")
            
            check = check_brightdata_snapshot(snapshot_id)
            if "error" in check:
                return error_response(check["error"])
            
            if check["status"] == "running":
                return success_response({"status": "running", "message": "Snapshot still processing"})
            
            # Finished! Process and Grade
            data = check["data"]
            results = data if isinstance(data, list) else [data]
            text = extract_answer(results[0]) if results else ""

            if not text:
                return error_response("Snapshot finished but no content extracted")
            
            text = strip_html(text)
            grading = grade_response(text, brand, url)
            grading_data = json.loads(grading)
            
            return success_response({
                "status": "success",
                "model": model,
                "response": text,
                "analysis": grading_data
            })

        if action != 'verify_mentions':
            return error_response("Invalid action")
            
        prompt = body.get('prompt')
        brand = body.get('brand')
        url = body.get('url')
        location = body.get('location', 'Global')
        language = body.get('language', 'English')
        models = body.get('models', ['gpt-4o-mini', 'gemini-3.1-flash-lite-preview', 'perplexity', 'copilot'])

        if not prompt or not brand:
            return error_response("Missing prompt or brand")

        # 1. Parallel Query all requested models
        results = {}
        with ThreadPoolExecutor(max_workers=max(len(models), 1)) as executor:
            future_to_model = {executor.submit(query_model, m, prompt, location, language): m for m in models}
            for future in future_to_model:
                model_name = future_to_model[future]
                try:
                    results[model_name] = future.result()
                except Exception as e:
                    results[model_name] = {"error": str(e)}

        # 2. Grade each response using a "Grader" LLM
        verified_results = []
        for model_name, res in results.items():
            if "error" in res:
                verified_results.append({
                    "model": model_name,
                    "status": "error",
                    "error": res["error"]
                })
                continue

            if res.get('status') == 'no_ai_overview':
                # Google rendered no AI Overview for this query. That is a real
                # finding about visibility, not a failure, so it grades as a
                # clean zero instead of an error card.
                verified_results.append({
                    "model": model_name,
                    "status": "no_ai_overview",
                    "response": "",
                    "analysis": {
                        "is_mentioned": False, "sentiment": "neutral",
                        "sentiment_reason": "", "sentiment_theme": "",
                        "is_cited": False, "citation_urls": [], "rank": 0,
                        "mention_snippet": "", "visibility_score": 0
                    }
                })
                continue

            try:
                raw_text = res.get('text', '')
                if not raw_text:
                    raise ValueError("Empty response text")
                
                # Strip HTML before returning to UI
                raw_text = strip_html(raw_text)
                
                grading = grade_response(raw_text, brand, url)
                # Attempt to parse it locally to ensure it's valid JSON
                grading_data = json.loads(grading)

                if res.get('citations'):
                    apply_aio_citations(grading_data, res['citations'], url)

                verified_results.append({
                    "model": model_name,
                    "status": "success",
                    "response": raw_text,
                    "analysis": grading_data
                })
            except Exception as grade_err:
                # Handle pending snapshots separately in the UI
                if isinstance(res, dict) and res.get('status') == 'snapshot_pending':
                    verified_results.append(res) # Pass through the pending status
                    continue

                verified_results.append({
                    "model": model_name,
                    "status": "error",
                    "error": f"Grading failed: {str(grade_err)}",
                    "response": res.get('text', '') if isinstance(res, dict) else str(res)
                })

        return success_response({
            "brand": brand,
            "url": url,
            "prompt": prompt,
            "location": location,
            "verification": verified_results
        })

    except Exception as e:
        return error_response(str(e))

def query_model(model_name, prompt, location, language='English'):
    """Router for different LLM providers."""
    m_lower = model_name.lower()
    is_aio = 'aio' in m_lower or 'ai-overview' in m_lower or 'ai_overview' in m_lower

    # Pre-flight API key check
    if m_lower.startswith('gpt') and not OPENAI_API_KEY:
        return {"error": "OpenAI API Key not configured in environment"}
    if m_lower.startswith('gemini') and not GOOGLE_API_KEY:
        return {"error": "Google API Key not configured in environment"}
    if ('perplexity' in m_lower or 'copilot' in m_lower or 'search' in m_lower) and not BRIGHTDATA_TOKEN:
        return {"error": "Search Engine API Token not configured in environment"}
    if ('claude' in m_lower or 'anthropic' in m_lower) and not ANTHROPIC_API_KEY:
        return {"error": "Anthropic API Key not configured in environment"}
    if is_aio and not DATAFORSEO_AUTH:
        return {"error": "DataForSEO credentials not configured in environment"}

    # Checked before the provider prefixes so google-aio can't fall into Gemini.
    if is_aio:
        return query_google_aio(prompt, location, language)

    if m_lower.startswith('gpt'):
        return query_openai(model_name, prompt, location)
    elif m_lower.startswith('gemini'):
        return query_gemini(model_name, prompt, location)
    elif 'perplexity' in m_lower or 'search' in m_lower:
        return query_perplexity(prompt, location)
    elif 'copilot' in m_lower:
        return query_copilot(prompt, location)
    elif 'claude' in m_lower or 'anthropic' in m_lower:
        return query_claude(model_name, prompt, location)
    else:
        return {"error": f"Model {model_name} not supported"}

def query_openai(model, prompt, location):
    """OpenAI API handler using urllib."""
    system_prompt = f"""You are a highly intelligent assistant researching market presence. 
The user is located in {location}. 
When recommending brands or explaining solutions, ALWAYS include real-world citations and URLs (e.g. [Brand Name](https://example.com)) if they are relevant to the query. 
Provide a detailed, modern, and helpful response with active links."""
    
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.7
    }
    
    response = requests.post(url, json=payload, headers=headers, timeout=60)
    response.raise_for_status()
    data = response.json()
    return {"text": data['choices'][0]['message']['content']}

def query_gemini(model, prompt, location):
    """Google Gemini API handler."""
    m_target = "gemini-2.5-flash"

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{m_target}:generateContent?key={GOOGLE_API_KEY}"
    headers = {"Content-Type": "application/json"}

    # Enhanced prompt for citations
    full_prompt = f"User Location: {location}\n\n{prompt}\n\nPlease include relevant citations and URLs in your response."

    payload = {
        "contents": [{
            "parts": [{"text": full_prompt}]
        }]
    }

    for attempt in range(4):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=60)
            if response.status_code == 429:
                wait = 5 * (2 ** attempt)  # 5s, 10s, 20s, 40s
                time.sleep(wait)
                continue
            response.raise_for_status()
            data = response.json()
            if 'candidates' in data and len(data['candidates']) > 0:
                return {"text": data['candidates'][0]['content']['parts'][0]['text']}
            return {"error": f"Gemini returned an empty result. Response: {json.dumps(data)}"}
        except requests.exceptions.RequestException as e:
            safe_msg = re.sub(r'key=[A-Za-z0-9_\-]+', 'key=REDACTED', str(e))
            if attempt < 3:
                time.sleep(5 * (2 ** attempt))
                continue
            return {"error": f"Gemini API Error: {safe_msg}"}
    return {"error": "Gemini API Error: rate limit exceeded after retries"}

def query_claude(model, prompt, location):
    """Anthropic Claude API handler."""
    # Ensure model is valid for Claude, default to claude-haiku-4-5 as requested
    m_target = model if ("claude-" in model.lower()) else "claude-haiku-4-5"
    
    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
    }
    
    # Enhanced prompt for citations
    system_prompt = f"You are a market research assistant. User Location: {location}. Provide detailed answers with real-world citations and URLs where possible."
    
    payload = {
        "model": m_target,
        "max_tokens": 1025,
        "thinking": {
            "type": "enabled",
            "budget_tokens": 1024
        },
        "messages": [
            {"role": "user", "content": prompt}
        ],
        "system": system_prompt
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
        
        # Extract content - skip 'thinking' type blocks for primary text
        text_parts = []
        for content in data.get('content', []):
            if content.get('type') == 'text':
                text_parts.append(content.get('text', ''))
        
        if text_parts:
            return {"text": "\n".join(text_parts)}
        return {"error": f"Claude returned an empty result. Response: {json.dumps(data)}"}
    except requests.exceptions.RequestException as e:
        # Check if we can extract error from response body
        if hasattr(e, 'response') and e.response is not None:
            try:
                err_data = e.response.json()
                if 'error' in err_data:
                    return {"error": f"Claude API Error: {err_data['error'].get('message', str(e))}"}
            except: pass
        return {"error": f"Claude API Connection Error: {str(e)}"}

def query_perplexity(prompt, location):
    """Perplexity via Search Dataset API."""
    url = "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m7dhdot1vw9a7gc1n&notify=false&include_errors=true"
    headers = {
        "Authorization": f"Bearer {BRIGHTDATA_TOKEN}",
        "Content-Type": "application/json"
    }
    
    # Normalize location to 2-letter uppercase code
    loc = location.strip().upper()
    if loc == 'GLOBAL' or 'UNITED STATES' in loc or 'US' in loc:
        country_code = 'US'
    elif 'SINGAPORE' in loc or 'SG' in loc:
        country_code = 'SG'
    elif 'UNITED KINGDOM' in loc or 'UK' in loc or 'GREAT BRITAIN' in loc:
        country_code = 'GB'
    else:
        country_code = loc[:2]

    payload = {
        "input": [{
            "url": "https://www.perplexity.ai",
            "prompt": prompt,
            "country": country_code,
            "index": 1
        }]
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=BRIGHTDATA_SCRAPE_TIMEOUT)
        response.raise_for_status()
        data = response.json()

        # Handle snapshot in progress
        if isinstance(data, dict) and 'snapshot_id' in data:
            return {
                "model": "perplexity",
                "status": "snapshot_pending",
                "snapshot_id": data['snapshot_id']
            }

        print(data)
        results = data if isinstance(data, list) else [data]
        if results and len(results) > 0:
            text = extract_answer(results[0])
            if text:
                return {"text": text}
        return {"error": "Wait, the search engine responded but no content was extracted. Please try again."}
    except Exception as e:
        return {"error": f"Search Connection Error: {str(e)}"}

def query_copilot(prompt, location):
    """Microsoft Copilot via Search Dataset API."""
    url = "https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m7di5jy6s9geokz8w&notify=false&include_errors=true"
    headers = {
        "Authorization": f"Bearer {BRIGHTDATA_TOKEN}",
        "Content-Type": "application/json"
    }
    
    # Use same normalization logic
    loc = location.strip().upper()
    if loc == 'GLOBAL' or 'UNITED STATES' in loc or 'US' in loc:
        country_code = 'US'
    elif 'SINGAPORE' in loc or 'SG' in loc:
        country_code = 'SG'
    elif 'UNITED KINGDOM' in loc or 'UK' in loc or 'GREAT BRITAIN' in loc:
        country_code = 'GB'
    else:
        country_code = loc[:2]

    payload = {
        "input": [{
            "url": "https://copilot.microsoft.com/chats",
            "prompt": prompt,
            "index": 1,
            "country": country_code
        }]
    }
    
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=BRIGHTDATA_SCRAPE_TIMEOUT)
        response.raise_for_status()
        data = response.json()

        # Handle snapshot in progress
        if isinstance(data, dict) and 'snapshot_id' in data:
            return {
                "model": "copilot",
                "status": "snapshot_pending",
                "snapshot_id": data['snapshot_id']
            }

        print(data)
        results = data if isinstance(data, list) else [data]
        if results and len(results) > 0:
            text = extract_answer(results[0])
            if text:
                return {"text": text}
        return {"error": "Wait, the search engine responded (Copilot) but no content was extracted. Please try again."}
    except Exception as e:
        return {"error": f"Search Connection Error (Copilot): {str(e)}"}

def query_google_aio(prompt, location, language):
    """Google AI Overview, read off the live SERP via DataForSEO.

    Unlike the chat engines there is nothing to ask: the AI Overview either
    renders for a query or it doesn't, and "it didn't" is a real answer about
    visibility rather than an error — hence the no_ai_overview status.
    """
    task = {
        "keyword": prompt[:700],
        "location_code": DFS_LOCATION_CODES.get((location or '').strip().lower(), DFS_DEFAULT_LOCATION),
        "language_code": DFS_LANGUAGE_CODES.get((language or '').strip().lower(), 'en'),
        "device": "desktop",
        # AI Overviews are lazy-loaded; without this the block comes back empty.
        "load_async_ai_overview": True,
    }

    try:
        response = requests.post(
            "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
            json=[task],
            headers={"Authorization": DATAFORSEO_AUTH, "Content-Type": "application/json"},
            timeout=90)
        response.raise_for_status()
        data = response.json()
    except Exception as e:
        return {"error": f"Google AIO Connection Error: {str(e)}"}

    tasks = data.get('tasks') or []
    if not tasks:
        return {"error": "Google AIO: DataForSEO returned no tasks"}
    t0 = tasks[0]
    if (t0.get('status_code') or 0) >= 40000:
        return {"error": f"Google AIO: {t0.get('status_message', 'task error')}"}
    results = t0.get('result') or []
    if not results:
        return {"error": "Google AIO: DataForSEO returned no result"}

    items = results[0].get('items') or []
    aio = next((i for i in items if i.get('type') == 'ai_overview'), None)
    if not aio:
        return {"status": "no_ai_overview"}

    text, citations = extract_aio(aio)
    if not text:
        return {"status": "no_ai_overview"}
    return {"text": text, "citations": citations}


def extract_aio(aio):
    """Answer text + reference links out of a SERP ai_overview block.

    The block carries the whole answer in `markdown`; its `items` only repeat
    that same text in fragments, so they are a fallback, not an addition.
    References hang off both the block and each element.
    """
    parts = []
    if isinstance(aio.get('markdown'), str) and aio['markdown'].strip():
        parts.append(aio['markdown'])
    else:
        for sub in (aio.get('items') or []):
            for field in ('markdown', 'text'):
                val = sub.get(field)
                if isinstance(val, str) and val.strip():
                    parts.append(val)
                    break

    refs = list(aio.get('references') or [])
    for sub in (aio.get('items') or []):
        refs += (sub.get('references') or [])

    citations, seen = [], set()
    for r in refs:
        u = (r or {}).get('url')
        if isinstance(u, str) and u.strip() and u not in seen:
            seen.add(u)
            citations.append({"url": u, "title": r.get('title') or '', "domain": r.get('domain') or ''})
    return "\n\n".join(parts).strip(), citations


def domain_of(u):
    if not u:
        return ""
    s = re.sub(r'^https?://', '', str(u).strip(), flags=re.I).split('/')[0].split('?')[0].lower()
    return s[4:] if s.startswith('www.') else s


def apply_aio_citations(analysis, citations, url):
    """An AI Overview's sources are structured data, so they beat the grader's
    reading of the prose — the answer text carries no inline links for it to find.
    """
    analysis['citation_urls'] = [c['url'] for c in citations]
    target = domain_of(url)
    cited = False
    if target:
        for c in citations:
            d = domain_of(c['url'])
            if d == target or d.endswith('.' + target) or target.endswith('.' + d):
                cited = True
                break
    analysis['is_cited'] = cited


def extract_answer(res):
    """Pull the assistant's answer out of a Bright Data record.

    answer_html carries the whole rendered page (~600KB of chrome, CSS and JS),
    so the plain-text fields must win or the grader scores page furniture.
    """
    if not isinstance(res, dict):
        return ""
    for field in ('answer_text_markdown', 'answer_text', 'answer',
                  'answer_section_html', 'answer_html', 'Response'):
        val = res.get(field)
        if isinstance(val, str) and val.strip():
            return val
    return ""

def strip_html(text):
    """Helper to remove HTML tags while preserving line breaks."""
    if not text:
        return ""
    # Drop script/style blocks outright; tag-stripping alone would leave their
    # CSS and JS bodies behind as text.
    text = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', text, flags=re.I | re.S)
    # Replace common block-level element endings with newlines
    text = re.sub(r'<(p|br|div|li|h[1-6])[^>]*>', '\n', text, flags=re.I)
    # Remove all remaining tags
    text = re.sub(r'<[^>]+>', '', text)
    # Collapse multiple newlines and trim
    text = re.sub(r'\n\s*\n', '\n\n', text)
    return text.strip()

def check_brightdata_snapshot(snapshot_id):
    """Checks Bright Data Snapshot endpoint once."""
    url = f"https://api.brightdata.com/datasets/v3/snapshot/{snapshot_id}"
    headers = {
        "Authorization": f"Bearer {BRIGHTDATA_TOKEN}",
        "Content-Type": "application/json"
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=60)
        response.raise_for_status()
        data = response.json()
        
        # Bright Data returns status: 'running' or a dict with 'message' if still in progress
        is_running = isinstance(data, dict) and (data.get('status') == 'running' or 'message' in data)
        
        if is_running:
            return {"status": "running"}
        
        return {"status": "finished", "data": data}
    except Exception as e:
        return {"error": f"Snapshot Check Error: {str(e)}"}

def grade_response(ai_text, brand, url):
    """Uses a Grader LLM (GPT-4o-mini) to extract structured metrics."""
    # Strip HTML to prevent UI breakage and improve grading accuracy
    clean_text = strip_html(ai_text)
    
    grader_prompt = f"""
Analyze the following AI response for a specific brand mention.
BRAND TO TRACK: {brand}
TARGET URL: {url}

AI RESPONSE:
---
{clean_text[:10000]}
---

Output your analysis in strictly JSON format:
{{
  "is_mentioned": boolean,
  "sentiment": "positive" | "negative" | "neutral",
  "sentiment_reason": "one short sentence (<=160 chars) explaining WHY you chose that sentiment, grounded in the response's actual wording; empty string if not mentioned",
  "sentiment_theme": "a 2-4 word Title Case label for the SPECIFIC angle of the mention so mentions sharing an angle can be grouped (e.g. 'Convenient Locations', 'Pricing Concerns', 'Reliable Service'); empty string if not mentioned",
  "is_cited": boolean (did it provide a link?),
  "citation_urls": ["list", "of", "urls", "found", "in", "the", "response"],
  "rank": integer (if it's a list, what position is the brand? 0 if not in list),
  "mention_snippet": "the VERBATIM sentence(s) mentioning the brand, copied exactly (no paraphrase); empty string if not mentioned",
  "visibility_score": integer (0-100 based on prominence and sentiment)
}}
"""
    api_url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "gpt-4o-mini",
        "messages": [{"role": "user", "content": grader_prompt}],
        "response_format": { "type": "json_object" }
    }
    
    response = requests.post(api_url, json=payload, headers=headers, timeout=60)
    response.raise_for_status()
    result = response.json()
    return result['choices'][0]['message']['content']

def success_response(data):
    return {
        "statusCode": 200,
        "headers": { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        "body": json.dumps(data)
    }

def error_response(msg):
    return {
        "statusCode": 400,
        "headers": { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        "body": json.dumps({"error": msg})
    }

