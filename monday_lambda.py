import json
import requests
import os
import base64

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY') or os.environ.get('MONDAY_TOKEN')
MONDAY_API_URL = "https://api.monday.com/v2"

def get_clean_openai_key(body):
    # Try all possible names for the key
    raw_key = body.get('openai_key') or os.environ.get('OPENAI_API_KEY') or os.environ.get('GPT_KEY')
    
    # If the frontend sent an empty string or "null", ignore it and fallback to AWS Env Var
    if not raw_key or str(raw_key).lower() in ["null", "undefined", ""]:
        raw_key = os.environ.get('GPT_KEY') or os.environ.get('OPENAI_API_KEY')

    if not raw_key:
        return None
        
    s_key = str(raw_key).strip()
    
    # Fix: Strip 'Bearer ' (case-insensitive)
    if s_key.lower().startswith('bearer '):
        s_key = s_key[7:].strip()
    
    # Fix: Strip any accidental quotes
    s_key = s_key.replace('"', '').replace("'", "")

    # DEBUG LOG (Safe): Shows first/last 4 chars in CloudWatch
    if len(s_key) > 8:
        print(f"[DEBUG] Using Key: {s_key[:4]}...{s_key[-4:]}")
    
    return s_key

def openai_proxy(body):
    openai_key = get_clean_openai_key(body)
    if not openai_key:
        return {"statusCode": 401, "body": json.dumps({"error": "OpenAI Key Missing"})}

    # Handle both nested and flat data structures
    params = body.get('data', body)
    url = f"https://api.openai.com/v1{params.get('endpoint') or body.get('endpoint')}"
    method = params.get('method') or body.get('method', 'POST')
    
    headers = {
        "Authorization": f"Bearer {openai_key}",
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json"
    }

    try:
        if method == 'GET':
            r = requests.get(url, headers=headers, timeout=30)
        elif method == 'DELETE':
            r = requests.delete(url, headers=headers, timeout=30)
        else:
            r = requests.post(url, headers=headers, json=params.get('data', body.get('data', {})), timeout=30)
        
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def openai_upload(body):
    openai_key = get_clean_openai_key(body)
    # Handle both nested and flat data structures
    params = body.get('data', body)
    content_b64 = params.get('content') or body.get('content')
    if not openai_key or not content_b64:
         return {"statusCode": 400, "body": json.dumps({"error": "Missing key or content"})}

    file_bytes = base64.b64decode(content_b64)
    files = {'file': (params.get('filename') or body.get('filename', 'file.json'), file_bytes), 'purpose': (None, 'assistants')}
    headers = {"Authorization": f"Bearer {openai_key}"}

    try:
        r = requests.post("https://api.openai.com/v1/files", headers=headers, files=files, timeout=60)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def download_file(body):
    # Handle both nested and flat data structures
    params = body.get('data', body)
    headers = {"Authorization": MONDAY_API_KEY}
    fileUrl = params.get('fileUrl') or body.get('fileUrl')
    try:
        r = requests.get(fileUrl, headers=headers, timeout=60)
        return {
            "statusCode": 200, 
            "body": json.dumps({
                "content": base64.b64encode(r.content).decode('utf-8'), 
                "contentType": r.headers.get('Content-Type')
            })
        }
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def google_token_exchange(body):
    """Exchange Google OAuth authorization code for access token."""
    # Handle both nested and flat data structures
    params = body.get('data', body)
    code = params.get('code') or body.get('code')
    client_id = params.get('client_id') or body.get('client_id')
    redirect_uri = params.get('redirect_uri') or body.get('redirect_uri', 'postmessage')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')

    if not code or not client_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing code or client_id"})}
    
    if not client_secret:
        return {"statusCode": 500, "body": json.dumps({"error": "GOOGLE_CLIENT_SECRET environment variable not configured"})}

    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'code': code,
            'client_id': client_id,
            'client_secret': client_secret,
            'redirect_uri': redirect_uri,
            'grant_type': 'authorization_code'
        }, timeout=15)
        
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def get_board_items(body):
    """Fetch board items from Monday.com with pagination support."""
    if not MONDAY_API_KEY:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "MONDAY_API_KEY environment variable not configured"})
        }
    
    # Handle nested data structure from frontend
    params = body.get('data', body)
    cursor = params.get('cursor')
    board_id = os.environ.get('MONDAY_BOARD_ID')
    
    if not board_id:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "MONDAY_BOARD_ID environment variable not configured"})
        }
    
    try:
        # Monday.com GraphQL query for board items using items_page
        # Build cursor parameter separately to avoid f-string issues
        cursor_param = f', cursor: "{cursor}"' if cursor else ''
        
        query_str = f"""query {{
    boards(ids: [2845615047]) {{
        items_page(limit: 100{cursor_param}) {{
            cursor
            items {{
                id
                name
                column_values {{
                    id
                    text
                    column {{
                        id
                        title
                    }}
                }}
            }}
        }}
    }}
}}"""
        
        print(f"[DEBUG] Monday Query with cursor: {cursor}")
        
        response = requests.post(
            MONDAY_API_URL,
            headers={
                "Authorization": MONDAY_API_KEY,
                "API-Version": "2023-10"
            },
            json={"query": query_str},
            timeout=30
        )
        
        print(f"[DEBUG] Monday API Response Status: {response.status_code}")
        
        if response.status_code != 200:
            print(f"[DEBUG] Monday API Error Response: {response.text}")
            return {
                "statusCode": response.status_code,
                "body": json.dumps({"error": response.text})
            }
        
        data = response.json()
        
        # Check for GraphQL errors
        if 'errors' in data:
            print(f"[DEBUG] GraphQL Errors: {data['errors']}")
            return {
                "statusCode": 400,
                "body": json.dumps({"error": data['errors'][0]['message'] if data['errors'] else "Unknown error"})
            }
        
        # Extract items - from items_page wrapper
        try:
            items_page = data['data']['boards'][0]['items_page']
            items = items_page.get('items', [])
            new_cursor = items_page.get('cursor')
            
            print(f"[DEBUG] Retrieved {len(items)} items, next_cursor: {new_cursor}")
            
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "items": items,
                    "cursor": new_cursor
                })
            }
        except (KeyError, IndexError, TypeError) as e:
            print(f"[DEBUG] Error parsing Monday response: {str(e)}")
            print(f"[DEBUG] Full response: {data}")
            return {
                "statusCode": 500,
                "body": json.dumps({"error": f"Failed to parse Monday.com response: {str(e)}"})
            }
            
    except requests.exceptions.Timeout:
        return {
            "statusCode": 504,
            "body": json.dumps({"error": "Monday.com API request timed out"})
        }
    except Exception as e:
        print(f"[DEBUG] Exception in get_board_items: {str(e)}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }

def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    }
    
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}
    
    try:
        body = json.loads(event.get('body', '{}')) if 'body' in event else event
    except:
        body = event

    action = body.get('action')
    
    if action == 'openai_proxy':
        result = openai_proxy(body)
    elif action == 'openai_upload':
        result = openai_upload(body)
    elif action == 'download_file':
        result = download_file(body)
    elif action == 'google_token_exchange':
        result = google_token_exchange(body)
    elif action == 'get_board_items':
        result = get_board_items(body)
    elif action == 'get_monday_data':
        # Legacy action for raw GraphQL queries
        # Handle both nested and flat data structures
        params = body.get('data', body)
        query = params.get('query') or body.get('query')
        r = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": MONDAY_API_KEY, "API-Version": "2023-10"},
            json={"query": query},
            timeout=30
        )
        result = {"statusCode": r.status_code, "body": r.text}
    else:
        result = {"statusCode": 400, "body": json.dumps({"error": "Invalid Action"})}
    
    # Ensure headers are included in response
    if 'headers' not in result:
        result['headers'] = headers
    
    return result
