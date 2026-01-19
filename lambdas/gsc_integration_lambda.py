import json
import requests

# GSC Integration Lambda
# This lambda acts as a CORS proxy for Google APIs using OAuth2 tokens provided by the client.

def lambda_handler(event, context):
    try:
        # Robustly handle both direct calls and API Gateway Proxy events
        data = event
        if isinstance(event.get('body'), str):
            try:
                data = json.loads(event['body'])
            except json.JSONDecodeError:
                # If body exists but isn't JSON, we'll likely fail the action check anyway
                pass
        
        # Merge if necessary, but typically we just need the body or the event
        action = data.get('action')
        url = data.get('url')
        site_url = data.get('site_url')
        access_token = data.get('access_token')
        
        if not action:
            return {
                'statusCode': 400,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
                    'Access-Control-Allow-Methods': 'OPTIONS,POST'
                },
                'body': json.dumps({'error': 'Missing action parameter'})
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
            if not url or not site_url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'Both url and site_url are required for inspection'})
                }
            return inspect_url(url, site_url, access_token)
        elif action == 'submitIndexing':
            if not url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'url is required for indexing submission'})
                }
            submission_type = data.get('type', 'URL_UPDATED')
            return submit_indexing(url, submission_type, access_token)
        elif action == 'querySearchAnalytics':
            if not site_url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'site_url is required for search analytics'})
                }
            return query_search_analytics(site_url, access_token, data.get('payload', {}))
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
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from Google ({response.status_code}): {response.text}"})
        }
    
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
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from Google ({response.status_code}): {response.text}"})
        }
    
    if response.status_code == 200:
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'result': 'Success', 'raw': data})
        }
    else:
        error_msg = data.get('error', {}).get('message', 'Indexing API Error')
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': error_msg, 'details': data.get('error', {})})
        }

def query_search_analytics(site_url, token, payload):
    """
    Calls the Search Console searchAnalytics:query API.
    API: https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/searchAnalytics/query
    """
    # site_url needs to be URL encoded for the path
    import urllib.parse
    encoded_site = urllib.parse.quote_plus(site_url)
    
    endpoint = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_site}/searchAnalytics/query"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    # Default payload if none provided
    if not payload:
        # Default to last 30 days, grouped by query
        from datetime import datetime, timedelta
        end_date = datetime.now().strftime('%Y-%m-%d')
        start_date = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
        payload = {
            "startDate": start_date,
            "endDate": end_date,
            "dimensions": ["query"],
            "rowLimit": 1000
        }

    response = requests.post(endpoint, headers=headers, json=payload)
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from Google Performance ({response.status_code}): {response.text}"})
        }

    if response.status_code == 200:
        return {
            'statusCode': 200,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'rows': data.get('rows', []), 'raw': data})
        }
    else:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': data.get('error', {}).get('message', 'GSC Performance API Error')})
        }
