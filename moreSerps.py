import json
import os
import requests


def lambda_handler(event, context):
    apikey = os.environ.get("API_KEY")
    page_types = event['page_types']
    location = event['location']
    keyword = event['keyword']
    language = event['language']
    try:
        user = event['user']
    except:
        pass
    try:
        target = event['targeted_url']
    except:
        pass
    
    # Try to extract limit from body if it's a proxy request, otherwise use event root
    try:
        requested_limit = event['limit']
    except:
        requested_limit = 10

    # Ensure page_types is a list
    if isinstance(page_types, str):
        page_types = [page_types]

    print("limit", requested_limit)

    # SERP - Always fetch 100 to ensure we have enough organic results
    url = "https://api.dataforseo.com/v3/serp/google/organic/live/regular"
    payload = [{
        "keyword": keyword,
        "location_name": location,
        "language_name": language,
        "depth": 50
    }]

    headers = {
        'Authorization': apikey,
        'Content-Type': 'application/json'
    }

    try:
        # Use requests.post for consistency
        response = requests.post(url, headers=headers, json=payload)
        response_data = response.json()
    except Exception as e:
        print(f"SERP API Error: {e}")
        return {"error": str(e)}

    serp_dict = {}
    entries = {}
    
    # Loop safely through items
    items = response_data.get('tasks', [{}])[0].get('result', [{}])[0].get('items', [])
    for item in items:
        # Only process organic items that have a URL and rank
        if item.get('type') != 'organic' or not item.get('url') or 'rank_group' not in item:
            continue
            
        rank_val = item['rank_group']
        rank_str = str(rank_val)
        
        entries[rank_str] = {
            'url': item['url'],
            'title': item.get('title', 'No Title'),
            'description': item.get('description', 'No Description')
        }
        
        # Target check
        try:
            if target and target in item['url']:
                serp_dict['target_rank'] = rank_val
        except:
            pass

        # Populate serp_dict for GPT classification
        serp_dict[rank_val] = {
            'url': item['url']
        }
        
        # Stop at 100 organic results (DataForSEO typically provides up to 100)
        if rank_val >= 101:
            break

    try:
        if not serp_dict:
            return {}
        print(serp_dict)

        prompt = (
            "Go to each URL and ascertain, for SEO content page type purposes, whether the page is a blog article, landing page, directory, or product/service page. "
            "Prioritize identifying pages as 'landing page' if they are focused on a specific offer or campaign with a clear call to action. "
            "A landing page is primarily designed for a specific conversion goal. A product/service page focuses on info about a specific product. "
            "A directory helps users find services near them. A blog article provides news and info. "
            "CRITICAL: EVALUATE EVERY SINGLE URL PROVIDED. DO NOT SKIP ANY. "
            "Return in the exact same JSON format with double quotes: " + json.dumps(serp_dict)
        )
        
        gpt_key = os.environ['GPT_KEY']
        gpt_url = "https://api.openai.com/v1/chat/completions"
        
        gpt_payload = {
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": prompt}],
            "response_format": { "type": "json_object" }
        }
        headers = {
            "Content-Type": "application/json",
            'Authorization': gpt_key
        }
        
        response = requests.post(gpt_url, headers=headers, json=gpt_payload)
        gpt_response = response.json()
        print(gpt_response)
        
        if 'choices' not in gpt_response:
            print(f"GPT Error: {gpt_response}")
            # Fallback: add titles/descriptions to serp_dict
            for k, v in serp_dict.items():
                s_key = str(k)
                if s_key in entries:
                    v['title'] = entries[s_key]['title']
                    v['description'] = entries[s_key]['description']
            return dict(list(serp_dict.items())[:requested_limit])

        content_str = gpt_response['choices'][0]['message']['content']
        output_dict = json.loads(content_str)
        
        # Map original data (title/desc) back to GPT typed results
        for key, value in output_dict.items():
            s_key = str(key)
            if s_key in entries:
                value['title'] = entries[s_key]['title']
                value['description'] = entries[s_key]['description']

        # Filter by page_type if requested
        final_dict = {}
        normalized_types = [t.lower() for t in page_types]
        
        if 'any' in normalized_types:
            final_dict = output_dict
        else:
            for key, value in output_dict.items():
                p_type = value.get('type', '').lower()
                if any(t.lower() in p_type for t in normalized_types):
                    final_dict[key] = value
        
        # If filtering returned nothing, fallback to first N unfiltered
        if not final_dict and output_dict:
            return dict(list(output_dict.items())[:requested_limit])

        return dict(list(final_dict.items())[:requested_limit])
                
    except Exception as e:
        print(f"Final Processing Error: {e}")
        # Last resort fallback
        return dict(list(serp_dict.items())[:requested_limit])