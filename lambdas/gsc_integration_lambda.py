import json
import requests

# GSC Integration Lambda
# This lambda acts as a CORS proxy for Google APIs using OAuth2 tokens provided by the client.

def lambda_handler(event, context):
    try:
        action = event.get('action')
        url = event.get('url')
        site_url = event.get('site_url')
        access_token = event.get('access_token')
        
        if not action or not url:
            return {
                'statusCode': 400,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                    'Access-Control-Allow-Methods': 'OPTIONS,POST'
                },
                'body': json.dumps({'error': 'Missing action or url'})
            }

        if not access_token:
            return {
                'statusCode': 401,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
                },
                'body': json.dumps({'error': 'Access token is required. Please connect to Google Search Console.'})
            }
        
        if action == 'inspectUrl':
            if not site_url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'site_url is required for inspection'})
                }
            return inspect_url(url, site_url, access_token)
        elif action == 'submitIndexing':
            submission_type = event.get('type', 'URL_UPDATED')
            return submit_indexing(url, submission_type, access_token)
        else:
            return {
                'statusCode': 400,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': f'Invalid action: {action}'})
            }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }

def inspect_url(url, site_url, token):
    """
    Calls the Search Console URL Inspection API.
    API: https://searchconsole.googleapis.com/v1/urlInspection/index:inspect
    """
    endpoint = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "inspectionUrl": url,
        "siteUrl": site_url,
        "languageCode": "en-US"
    }
    
    response = requests.post(endpoint, headers=headers, json=payload)
    data = response.json()
    
    if response.status_code == 200:
        # Extract verdict
        verdict = data.get('inspectionResult', {}).get('indexStatusResult', {}).get('verdict', 'UNKNOWN')
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'status': verdict, 'raw': data})
        }
    else:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': data.get('error', {}).get('message', 'GSC API Error')})
        }

def submit_indexing(url, submission_type, token):
    """
    Calls the Google Indexing API.
    API: https://indexing.googleapis.com/v1/urlNotifications:publish
    """
    endpoint = "https://indexing.googleapis.com/v1/urlNotifications:publish"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "url": url,
        "type": submission_type
    }
    
    response = requests.post(endpoint, headers=headers, json=payload)
    data = response.json()
    
    if response.status_code == 200:
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'result': 'Success', 'raw': data})
        }
    else:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': data.get('error', {}).get('message', 'Indexing API Error')})
        }
