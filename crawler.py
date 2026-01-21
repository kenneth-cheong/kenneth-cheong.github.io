import json
import requests
import os
import base64

# DataForSEO Credentials - Recommended to set these in AWS Lambda Environment Variables
# If not set, system will look for fallback or error
DFSO_LOGIN = os.environ.get('DATAFORSEO_LOGIN', 'your_login')
DFSO_PASSWORD = os.environ.get('DATAFORSEO_PASSWORD', 'your_password')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY', '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')

def get_auth_header():
    auth_str = f"{DFSO_LOGIN}:{DFSO_PASSWORD}"
    encoded_auth = base64.b64encode(auth_str.encode('ascii')).decode('ascii')
    return {"Authorization": f"Basic {encoded_auth}", "Content-Type": "application/json"}

def lambda_handler(event, context):
    action = event.get('action', 'start_crawl') # Default to start
    
    if action == 'start_crawl':
        homepage = event.get('url')
        max_pages = int(event.get('max_pages', 10))
        
        post_data = [{
            "target": homepage,
            "max_crawl_pages": max_pages,
            "load_resources": True,
            "enable_javascript": True,
            "custom_user_agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
        }]
        
        response = requests.post("https://api.dataforseo.com/v3/on_page/task_post", 
                                 headers=get_auth_header(), 
                                 json=post_data)
        res_json = response.json()
        
        if res_json.get('status_code') == 20000:
            task_id = res_json['tasks'][0]['id']
            return {
                'statusCode': 200,
                'body': {'task_id': task_id, 'status': 'started'}
            }
        else:
            return {
                'statusCode': 400,
                'body': {'error': res_json.get('status_message', 'Failed to start task')}
            }

    elif action == 'get_status':
        task_id = event.get('task_id')
        response = requests.get(f"https://api.dataforseo.com/v3/on_page/summary/{task_id}", 
                                headers=get_auth_header())
        res_json = response.json()
        
        if res_json.get('status_code') == 20000:
            task_info = res_json['tasks'][0]['result'][0]
            crawl_progress = task_info.get('crawl_progress', 'unknown')
            crawl_status = task_info.get('crawl_status', 'in_progress')
            
            # Extract basic progress metrics
            pages_crawled = task_info.get('pages_crawled', 0)
            pages_in_queue = task_info.get('pages_in_queue', 0)
            
            return {
                'statusCode': 200,
                'body': {
                    'task_id': task_id,
                    'status': crawl_status,
                    'pages_crawled': pages_crawled,
                    'pages_in_queue': pages_in_queue,
                    'progress': crawl_progress
                }
            }
        else:
            return {
                'statusCode': 400,
                'body': {'error': res_json.get('status_message', 'Failed to get status')}
            }

    elif action == 'get_results':
        task_id = event.get('task_id')
        # Get pages results
        # payload for pages
        payload = [{
            "id": task_id,
            "limit": 100
        }]
        response = requests.post("https://api.dataforseo.com/v3/on_page/pages", 
                                 headers=get_auth_header(), 
                                 json=payload)
        res_json = response.json()
        
        if res_json.get('status_code') == 20000:
            pages = res_json['tasks'][0]['result'][0]['items']
            mapped_data = {}
            
            for page in pages:
                url = page.get('url')
                meta = page.get('meta', {})
                
                # Fetch OpenAI UI/UX review if needed (Optional, can be slow for many pages)
                # For efficiency, we might only do this for the homepage or a sample, 
                # but to match previous behavior, we'll try for each.
                uiux_summary = ""
                try:
                    # Only if we have content and it's an HTML page
                    if page.get('content_type') == 'text/html':
                        api_url = "https://api.openai.com/v1/chat/completions"
                        prompt = f"Evaluate if this webpage UI/UX is good based on its metadata. Title: {meta.get('title')}, Description: {meta.get('description')}. Output 'Good' or 'Bad' with a short summary why."
                        
                        querystring = {
                            "model": "gpt-4o-mini",
                            "messages": [{"role": "user", "content": prompt}]
                        }
                        headers = {
                            "Content-Type": "application/json",
                            'Authorization': f'Bearer {OPENAI_API_KEY}'
                        }
                        ai_res = requests.post(api_url, headers=headers, json=querystring)
                        uiux_summary = ai_res.json()['choices'][0]['message']['content']
                except Exception as e:
                    print(f"Skipping OpenAI for {url}: {e}")

                mapped_data[url] = {
                    'code': page.get('status_code'),
                    'title': meta.get('title', 'N/A'),
                    'description': meta.get('description', 'N/A'),
                    'canonical': meta.get('canonical', 'N/A'),
                    'hreflang': ", ".join(meta.get('hreflangs', [])) if meta.get('hreflangs') else "None",
                    'alt_text': "Included in analysis", # DataForSEO has separate images endpoint if needed
                    'h1': ", ".join(meta.get('h1', [])) if meta.get('h1') else "None",
                    'h2': ", ".join(meta.get('h2', [])) if meta.get('h2') else "None",
                    'word_count': page.get('meta', {}).get('content_info', {}).get('word_count', 0),
                    'uiux': uiux_summary
                }
            
            return {
                'statusCode': 200,
                'body': mapped_data
            }
        else:
            return {
                'statusCode': 400,
                'body': {'error': res_json.get('status_message', 'Failed to get results')}
            }

    return {
        'statusCode': 400,
        'body': {'error': 'Invalid action'}
    }
