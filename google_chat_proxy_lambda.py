import json
import urllib.request
import urllib.error

def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Content-Type": "application/json"
    }

    # Handle CORS preflight (only needed if OPTIONS is ever routed here)
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        # --- Parse incoming body ---
        body = event
        if 'body' in event and isinstance(event['body'], str):
            print(f"[PARSE] Decoding JSON from event['body'] string")
            body = json.loads(event['body'])
        else:
            print(f"[PARSE] Using raw event as body (keys: {list(event.keys())})")

        target_url    = body.get('url')
        target_method = body.get('method', 'POST')
        target_body   = body.get('body')
        access_token  = body.get('accessToken')

        # --- Guard ---
        if not target_url or not access_token:
            print(f"[ERROR] Missing url or accessToken. url={target_url}, token_present={bool(access_token)}")
            return {'statusCode': 400, 'headers': headers, 'body': json.dumps({"error": "Missing url or accessToken"})}

        # --- Debug logging ---
        request_body_str = json.dumps(target_body) if target_body else None
        print(f"[REQUEST] {target_method} {target_url}")
        print(f"[REQUEST BODY] {request_body_str[:500] if request_body_str else 'None'}")
        print(f"[TOKEN] Bearer ...{access_token[-10:]}")  # Only last 10 chars for safety

        req = urllib.request.Request(
            target_url,
            data=request_body_str.encode('utf-8') if request_body_str else None,
            headers={
                'Authorization': f'Bearer {access_token}',
                'Content-Type': 'application/json',
                'Accept-Encoding': 'identity'  # Force uncompressed for urllib
            },
            method=target_method
        )

        try:
            with urllib.request.urlopen(req) as response:
                res_body = response.read().decode('utf-8')
                print(f"[RESPONSE] {response.status} OK - {res_body[:300]}")
                return {
                    'statusCode': response.status,
                    'headers': headers,
                    'body': res_body
                }

        except urllib.error.HTTPError as e:
            res_body = e.read().decode('utf-8')
            print(f"[HTTP ERROR] {e.code} {e.reason} - Response body: {res_body[:500]}")
            return {
                'statusCode': e.code,
                'headers': headers,
                'body': res_body
            }

    except Exception as e:
        print(f"[EXCEPTION] {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({"error": str(e)})
        }
