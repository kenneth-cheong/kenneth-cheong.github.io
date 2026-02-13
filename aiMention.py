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
            text = ""
            if results and len(results) > 0:
                res = results[0]
                if model == 'perplexity':
                    text = res.get('answer_html') or res.get('answer') or res.get('answer_text') or res.get('Response')
                else: # copilot
                    text = res.get('answer_text') or res.get('answer_html') or res.get('answer') or res.get('Response')
            
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
                
                # Strip HTML before returning to UI
                raw_text = strip_html(raw_text)
                
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
    
    response = requests.post(url, json=payload, headers=headers)
    response.raise_for_status()
    data = response.json()
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
    
    try:
        response = requests.post(url, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()
        if 'candidates' in data and len(data['candidates']) > 0:
            return {"text": data['candidates'][0]['content']['parts'][0]['text']}
        return {"error": f"Gemini returned an empty result. Response: {json.dumps(data)}"}
    except requests.exceptions.RequestException as e:
        return {"error": f"Gemini API Error: {str(e)}"}

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
        response = requests.post(url, json=payload, headers=headers)
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
    
    try:
        response = requests.post(url, json=payload, headers=headers)
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
            res = results[0]
            text = res.get('answer_text') or res.get('answer_html') or res.get('answer') or res.get('Response')
            if text:
                return {"text": text}
        return {"error": "Wait, the search engine responded (Copilot) but no content was extracted. Please try again."}
    except Exception as e:
        return {"error": f"Search Connection Error (Copilot): {str(e)}"}

def strip_html(text):
    """Helper to remove HTML tags while preserving line breaks."""
    if not text:
        return ""
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
        response = requests.get(url, headers=headers)
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
    
    response = requests.post(api_url, json=payload, headers=headers)
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

