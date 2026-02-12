import json
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Note: In a real AWS Lambda environment, these would be in environment variables
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
GOOGLE_API_KEY = os.environ.get('GOOGLE_API_KEY')
BRIGHTDATA_TOKEN = os.environ.get('BRIGHTDATA_TOKEN')

def lambda_handler(event, context):
    """
    Main Lambda handler for AI Mentions Verification.
    """
    try:
        body = event.get('body', event)
        if isinstance(body, str):
            body = json.loads(body)
            
        action = body.get('action')
        if action != 'verify_mentions':
            return error_response("Invalid action")
            
        prompt = body.get('prompt')
        brand = body.get('brand')
        url = body.get('url')
        location = body.get('location', 'Global')
        models = body.get('models', ['gpt-4o-mini', 'gemini-1.5-flash', 'perplexity', 'copilot'])
        
        if not prompt or not brand:
            return error_response("Missing prompt or brand")

        # 1. Parallel Query all requested models
        results = {}
        with ThreadPoolExecutor(max_workers=max(len(models), 1)) as executor:
            future_to_model = {executor.submit(query_model, m, prompt, location): m for m in models}
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
                
            try:
                raw_text = res.get('text', '')
                if not raw_text:
                    raise ValueError("Empty response text")
                grading = grade_response(raw_text, brand, url)
                # Attempt to parse it locally to ensure it's valid JSON
                grading_data = json.loads(grading) 
                
                verified_results.append({
                    "model": model_name,
                    "status": "success",
                    "response": raw_text,
                    "analysis": grading_data
                })
            except Exception as grade_err:
                verified_results.append({
                    "model": model_name,
                    "status": "error",
                    "error": f"Grading failed: {str(grade_err)}",
                    "response": res.get('text', '')
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

def query_model(model_name, prompt, location):
    """Router for different LLM providers."""
    m_lower = model_name.lower()
    
    # Pre-flight API key check
    if m_lower.startswith('gpt') and not OPENAI_API_KEY:
        return {"error": "OpenAI API Key not configured in environment"}
    if m_lower.startswith('gemini') and not GOOGLE_API_KEY:
        return {"error": "Google API Key not configured in environment"}
    if ('perplexity' in m_lower or 'copilot' in m_lower or 'search' in m_lower) and not BRIGHTDATA_TOKEN:
        return {"error": "Search Engine API Token not configured in environment"}

    if m_lower.startswith('gpt'):
        return query_openai(model_name, prompt, location)
    elif m_lower.startswith('gemini'):
        return query_gemini(model_name, prompt, location)
    elif 'perplexity' in m_lower or 'search' in m_lower:
        return query_perplexity(prompt, location)
    elif 'copilot' in m_lower:
        return query_copilot(prompt, location)
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
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as response:
        data = json.loads(response.read().decode('utf-8'))
        return {"text": data['choices'][0]['message']['content']}

def query_gemini(model, prompt, location):
    """Google Gemini API handler."""
    # Respect user preference for gemini-3-flash-preview if provided, else fallback
    m_target = model if "preview" in model.lower() else ("gemini-2.0-flash-exp" if "flash" in model.lower() else "gemini-2.0-pro-exp")
    if "gemini-3" in model.lower(): m_target = "gemini-3-flash-preview" # User specific preference
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{m_target}:generateContent?key={GOOGLE_API_KEY}"
    headers = {"Content-Type": "application/json"}
    
    # Enhanced prompt for citations
    full_prompt = f"User Location: {location}\n\n{prompt}\n\nPlease include relevant citations and URLs in your response."
    
    payload = {
        "contents": [{
            "parts": [{"text": full_prompt}]
        }]
    }
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            if 'candidates' in data and len(data['candidates']) > 0:
                return {"text": data['candidates'][0]['content']['parts'][0]['text']}
            return {"error": f"Gemini returned an empty result. Response: {json.dumps(data)}"}
    except urllib.error.HTTPError as he:
        err_body = he.read().decode('utf-8')
        return {"error": f"Gemini API Error ({he.code}): {err_body}"}
    except Exception as e:
        return {"error": f"Gemini Connection Error: {str(e)}"}

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
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            print(data)
            results = data if isinstance(data, list) else [data]
            if results and len(results) > 0:
                res = results[0]
                text = res.get('answer_html') or res.get('answer') or res.get('answer_text') or res.get('Response')
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
    
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            print(data)
            results = data if isinstance(data, list) else [data]
            if results and len(results) > 0:
                res = results[0]
                text = res.get('answer_text') or res.get('answer_html') or res.get('answer') or res.get('Response')
                if text:
                    return {"text": text}
            return {"error": "Wait, the search engine responded (Copilot) but no content was extracted. Please try again."}
    except Exception as e:
        return {"error": f"Search Connection Error (Copilot): {str(e)}"}

def grade_response(ai_text, brand, url):
    """Uses a Grader LLM (GPT-4o-mini) to extract structured metrics."""
    grader_prompt = f"""
Analyze the following AI response for a specific brand mention.
BRAND TO TRACK: {brand}
TARGET URL: {url}

AI RESPONSE:
---
{ai_text}
---

Output your analysis in strictly JSON format:
{{
  "is_mentioned": boolean,
  "sentiment": "positive" | "negative" | "neutral",
  "is_cited": boolean (did it provide a link?),
  "citation_urls": ["list", "of", "urls", "found", "in", "the", "response"],
  "rank": integer (if it's a list, what position is the brand? 0 if not in list),
  "mention_snippet": "short quote of the mention",
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
    
    req = urllib.request.Request(api_url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req) as response:
        result = json.loads(response.read().decode('utf-8'))
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

