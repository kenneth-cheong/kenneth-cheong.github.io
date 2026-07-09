import json
import requests
import os

def lambda_handler(event, context):
    keywords = event['keywords']
    location = event['location']
    language = event['language']

    api_url = "https://api.dataforseo.com/v3/dataforseo_labs/google/serp_competitors/live"
    headers = {
        'Authorization': ('Basic ' + os.environ.get('DATAFORSEO_AUTH', '')),
        "Content-Type": "application/json"
    }
    payload=[{
        "keywords":keywords,
        "location_name": location,
        "language_name": language}]


    data = requests.post(api_url, headers=headers, data=json.dumps(payload)).json()

    output ={}

    print(data)

    tasks = data.get('tasks', [])
    if tasks and tasks[0].get('result') is not None:
        result_pkg = tasks[0]['result'][0]
        if result_pkg and result_pkg.get('items') is not None:
            for result in result_pkg['items']:
                output[result['domain']] = {}
                for key, value in result['keywords_positions'].items():
                    output[result['domain']][key] = value[0]

    # Fallback to regular SERP API if no results or very few results
    if not output:
        print("No results from Labs API, falling back to SERP API...")
        serp_api_url = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
        for kw in keywords:
            serp_payload = [{
                "keyword": kw,
                "location_name": location,
                "language_name": language,
                "device": "desktop",
                "os": "windows"
            }]
            try:
                serp_response = requests.post(serp_api_url, headers=headers, json=serp_payload)
                serp_data = serp_response.json()
                if serp_data.get('tasks') and serp_data['tasks'][0].get('result'):
                    serp_result = serp_data['tasks'][0]['result'][0]
                    if serp_result.get('items'):
                        for item in serp_result['items']:
                            if item.get('type') == 'organic' and item.get('domain'):
                                domain = item['domain']
                                if domain not in output:
                                    output[domain] = {}
                                output[domain][kw] = item.get('rank_absolute')
            except Exception as e:
                print(f"Fallback for keyword '{kw}' failed: {e}")
    
    if not output:
        print('none found even with fallback')
        
    return(
        {
            "statusCode": 200,
            "body": output
        }
    )