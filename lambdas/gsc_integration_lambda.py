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
        print(data)
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
        elif action == 'ga4ListProperties':
            return ga4_list_properties(access_token)
        elif action == 'ga4RunReport':
            property_id = data.get('propertyId')
            payload = data.get('payload', {})
            if not property_id:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'propertyId is required for ga4RunReport'})
                }
            return ga4_run_report(property_id, access_token, payload)
        elif action == 'adsListCustomers':
            login_customer_id = data.get('loginCustomerId')
            developer_token = data.get('developerToken')
            return ads_list_customers(access_token, login_customer_id, developer_token)
        elif action == 'adsSearchStream':
            customer_id = data.get('customerId')
            payload = data.get('payload', {})
            developer_token = data.get('developerToken')
            if not customer_id:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'customerId is required for adsSearchStream'})
                }
            login_customer_id = data.get('loginCustomerId')
            return ads_search_stream(customer_id, access_token, payload, login_customer_id, developer_token)
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
    print('user wants to index')

    endpoint = "https://indexing.googleapis.com/v3/urlNotifications:publish"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "url": url,
        "type": submission_type
    }
    
    response = requests.post(endpoint, headers=headers, json=payload)
    print(response)
    data = response.json()
    
    print(data)
    try:
        data = response.json()
        print(data)

    except Exception as e:
        print(e)
    
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

def ga4_list_properties(token):
    """
    Calls the Google Analytics Admin API to list accessible account summaries.
    """
    endpoint = "https://analyticsadmin.googleapis.com/v1beta/accountSummaries"
    headers = {"Authorization": f"Bearer {token}"}
    
    response = requests.get(endpoint, headers=headers)
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from GA4 Admin API ({response.status_code}): {response.text}"})
        }
    
    return {
        'statusCode': response.status_code,
        'headers': {'Access-Control-Allow-Origin': '*'},
        'body': json.dumps(data)
    }

def ga4_run_report(property_id, token, payload):
    """
    Calls the Google Analytics Data API to run a report.
    """
    endpoint = f"https://analyticsdata.googleapis.com/v1beta/{property_id}:runReport"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    response = requests.post(endpoint, headers=headers, json=payload)
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from GA4 Data API ({response.status_code}): {response.text}"})
        }
    
    return {
        'statusCode': response.status_code,
        'headers': {'Access-Control-Allow-Origin': '*'},
        'body': json.dumps(data)
    }

def ads_list_customers(token, login_customer_id, developer_token):
    """
    Calls the Google Ads API to list accessible customers using googleAds:search.
    """
    # Requires a login customer ID to search across
    if not login_customer_id:
        return {
            'statusCode': 400,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': 'Manager ID (loginCustomerId) is required to list properties.'})
        }
        
    endpoint = f"https://googleads.googleapis.com/v21/customers/{login_customer_id}/googleAds:search"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    if login_customer_id:
        headers["login-customer-id"] = str(login_customer_id)
    if developer_token:
        headers["developer-token"] = str(developer_token)
        
    payload = {
        "query": "SELECT customer_client.descriptive_name, customer_client.client_customer FROM customer_client WHERE customer_client.hidden = FALSE"
    }
        
    response = requests.post(endpoint, headers=headers, json=payload)
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from Google Ads API ({response.status_code}): {response.text}"})
        }
    
    return {
        'statusCode': response.status_code,
        'headers': {'Access-Control-Allow-Origin': '*'},
        'body': json.dumps(data)
    }

def ads_search_stream(customer_id, token, payload, login_customer_id=None, developer_token=None):
    """
    Calls the Google Ads API searchStream endpoint.
    """
    endpoint = f"https://googleads.googleapis.com/v22/customers/{customer_id}/googleAds:searchStream"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    if login_customer_id:
        headers["login-customer-id"] = str(login_customer_id)
    if developer_token:
        headers["developer-token"] = str(developer_token)
        
    response = requests.post(endpoint, headers=headers, json=payload)
    try:
        data = response.json()
    except json.JSONDecodeError:
        return {
            'statusCode': response.status_code,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': f"Non-JSON response from Google Ads API ({response.status_code}): {response.text}"})
        }
    
    return {
        'statusCode': response.status_code,
        'headers': {'Access-Control-Allow-Origin': '*'},
        'body': json.dumps(data)
    }
