import json
import requests
import os

SERANKING_API_KEY = os.environ.get('SERANKING_API_KEY')
SERANKING_API_URL = "https://api4.seranking.com"

def lambda_handler(event, context):
    headers = {
        "Authorization": f"Token {SERANKING_API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        body = event
        if 'body' in event and isinstance(event['body'], str):
            try:
                body = json.loads(event['body'])
            except:
                pass
        
        action = body.get('action', 'get_sites')
        data = body.get('data', {})
        # Handle siteId being in the top level or inside 'data'
        site_id = body.get('siteId') or data.get('siteId')

        if action == 'get_sites':
            url = f"{SERANKING_API_URL}/sites"
            res = requests.get(url, headers=headers)
        elif action == 'get_keywords':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/sites/{site_id}/keywords"
            res = requests.get(url, headers=headers)
        elif action == 'get_groups':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/keyword-groups/{site_id}"
            res = requests.get(url, headers=headers)
        elif action == 'get_positions':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            
            # Extract optional filters
            date_from = data.get('date_from') or body.get('date_from')
            date_to = data.get('date_to') or body.get('date_to')
            with_lp = str(data.get('with_landing_pages') or body.get('with_landing_pages') or "1")
            
            url = f"{SERANKING_API_URL}/sites/{site_id}/positions?with_landing_pages={with_lp}"
            if date_from: url += f"&date_from={date_from}"
            if date_to: url += f"&date_to={date_to}"
            
            res = requests.get(url, headers=headers)
        elif action == 'get_search_engines':
            if not site_id:
                return response(400, {"error": "Missing siteId"})
            url = f"{SERANKING_API_URL}/sites/{site_id}/search-engines"
            res = requests.get(url, headers=headers)
        elif action == 'get_system_search_engines':
            url = f"{SERANKING_API_URL}/system/search-engines"
            res = requests.get(url, headers=headers)
        else:
            return response(400, {"error": f"Unknown action: {action}"})

        return response(res.status_code, res.json())

    except Exception as e:
        print(f"Error: {str(e)}")
        return response(500, {"error": str(e)})

def response(status, body):
    return {
        'statusCode': status,
        'headers': {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json"
        },
        'body': json.dumps(body)
    }
