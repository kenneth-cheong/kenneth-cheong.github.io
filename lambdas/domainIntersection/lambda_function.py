import json
import requests
import os

def lambda_handler(event, context):
    location = event['location']
    language = event['language']
    target1 = event['target1']
    target2 = event['target2']

    apikey = os.environ.get("API_KEY")

    api_url = "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_intersection/live"

    headers = {
        'Authorization': apikey,
        'Content-Type': 'application/json'
    }
    
    payload = [{
        "target1": target1,
        "target2": target2,
        "location_name": location,
        "language_name": language,
        "limit": 1000,
        "order_by": ["keyword_data.keyword_info.search_volume,desc"]
        }]

    response = requests.request("POST", api_url, headers=headers, json=payload)

    output = {}

    data = response.json()
    tasks = data.get('tasks', [])
    if tasks and tasks[0].get('result') is not None:
        result_pkg = tasks[0]['result'][0]
        if result_pkg and result_pkg.get('items') is not None:
            for entry in result_pkg['items']:
                keyword = entry.get('keyword_data', {}).get('keyword')
                if not keyword:
                    continue
                output[keyword] = {}
                keyword_info = entry['keyword_data'].get('keyword_info', {})
                output[keyword]['search_volume'] = keyword_info.get('search_volume')
                output[keyword]['cpc'] = keyword_info.get('cpc')
                output[keyword]['competition_level'] = keyword_info.get('competition_level')

                if entry.get('first_domain_serp_element'):
                    output[keyword][entry['first_domain_serp_element']['domain']] = [
                        entry["first_domain_serp_element"].get('rank_group'),
                        entry["first_domain_serp_element"].get('url')
                    ]
                if entry.get('second_domain_serp_element'):
                    output[keyword][entry['second_domain_serp_element']['domain']] = [
                        entry["second_domain_serp_element"].get('rank_group'),
                        entry["second_domain_serp_element"].get('url')
                    ]

    return(output)