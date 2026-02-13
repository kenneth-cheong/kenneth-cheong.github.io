import json
import requests
import os

def lambda_handler(event, context):
    location = event['location']
    language = event['language']
    target = event['target']

    if "http" not in target:
        target = "https://"+target

    apikey = os.environ.get("API_KEY")

    api_url = "https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_site/live"

    headers = {
        'Authorization': apikey,
        'Content-Type': 'application/json'
    }
    
    payload = [{
        "target": target,
        "location_name": location,
        "language_name": language,
        "sort_by": "search_volume",
        }]

    response = requests.post(api_url, headers=headers, json=payload)

    # Parse DataForSEO results and limit to top 200 keywords
    data = response.json()
    tasks = data.get('tasks', [])
    if not tasks or not tasks[0].get('result'):
        print(f"DataForSEO error: {data}")
        return {"error": "No keywords found in DataForSEO response"}

    # result is usually a list of keyword objects
    raw_results = tasks[0]['result']
    
    # Identify if result is a list of dicts, or a list containing one list of dicts
    if isinstance(raw_results, list) and len(raw_results) > 0 and isinstance(raw_results[0], list):
        raw_results = raw_results[0]
        
    if not isinstance(raw_results, list):
        print(f"Unexpected results structure: {type(raw_results)}")
        return {"error": f"Unexpected data structure from DataForSEO: {type(raw_results)}"}

    # Dynamic limit: use top 200 keywords to stay within prompt limits and speed up AI
    # Safety check: ensure x is a dict before calling get()
    sorted_results = sorted(
        [x for x in raw_results if isinstance(x, dict)], 
        key=lambda x: x.get('search_volume', 0) or 0, 
        reverse=True
    )[:200]

    keyword_data = {}
    for result in sorted_results:
        kw = result['keyword']
        keyword_data[kw] = {
            'search_volume': result.get('search_volume', 0),
            'competition': (result.get('competition_index', 0) or 0) / 100.0 if result.get('competition_index') else 0
        }

    skip_ai = event.get('skip_ai', False)
    if skip_ai:
        return keyword_data

    # 3. Call OpenAI Responses API (Faster & more consistent)
    gpt_key = os.environ.get('GPT_KEY') or os.environ.get('OPENAI_API_KEY')
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {gpt_key}",
        "Content-Type": "application/json"
    }

    instructions = (
        "You are an expert SEO consultant. Your goal is to select the most valuable keyword suggestions "
        "from the provided list based on High Intent, Consideration, and Broad Search Intent.\n\n"
        "RULES:\n"
        "1. Select up to 50 high-quality keywords.\n"
        "2. Output exactly one JSON object where keys are the keywords.\n"
        "3. For each keyword, include: search_volume, competition, search_intent, and reason_for_choosing.\n"
        "4. Search intent must be one of: navigational, informational, commercial, transactional.\n"
        "5. If a keyword is non-English, include its translation in the 'reason_for_choosing'.\n"
        "6. Do not include markdown formatting or backticks. Return ONLY the JSON object."
    )

    # Filter to top 50 for the AI step to stay safe and fast
    top_50_data = {k: v for i, (k, v) in enumerate(keyword_data.items()) if i < 50}
    prompt = f"Target Site: {target}\nLocation: {location}\nLanguage: {language}\n\nKeyword Data: {json.dumps(top_50_data)}"

    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": prompt}
        ],
        "response_format": { "type": "json_object" }
    }

    try:
        res = requests.post(url, headers=headers, json=payload)
        res_data = res.json()
        
        if 'choices' not in res_data:
            return {"error": f"AI Error: {res_data.get('error', 'Unknown error')}"}
            
        raw_content = res_data['choices'][0]['message']['content']
        return json.loads(raw_content)
    except Exception as e:
        print(f"Error in AI generation: {str(e)}")
        return {"error": "Failed to generate optimized keyword list"}