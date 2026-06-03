import json
import urllib.request
import urllib.error
import urllib.parse


def lambda_handler(event, context):
    # CORS Headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json"
    }

    # Handle CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        # Parse incoming body
        body = event
        if 'body' in event and isinstance(event['body'], str):
            body = json.loads(event['body'])

        # Expect: { "url": "https://mediaonenas.sg3.quickconnect.to/webapi/auth.cgi?..." }
        # The QuickConnect hostname (e.g. mediaonenas.sg3.quickconnect.to) acts as a relay
        # proxy — HTTPS requests to it are forwarded directly to the NAS, so no resolution needed.
        target_url = body.get('url')

        if not target_url:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({"error": "Provide 'url' in payload."})
            }

        print(f"[SYNOLOGY PROXY] Request URL: {target_url}")

        req = urllib.request.Request(
            target_url,
            headers={
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            method='GET'
        )

        try:
            with urllib.request.urlopen(req, timeout=15) as response:
                res_body = response.read().decode('utf-8')
                print(f"[RESPONSE] {response.status} - first 200 chars: {res_body[:200]}")
                return {
                    'statusCode': 200,
                    'headers': headers,
                    'body': res_body
                }

        except urllib.error.HTTPError as e:
            res_body = e.read().decode('utf-8')
            print(f"[HTTP ERROR] {e.code} - {res_body[:200]}")
            return {
                'statusCode': e.code,
                'headers': headers,
                'body': res_body
            }

    except Exception as e:
        import traceback
        print(f"[EXCEPTION] {traceback.format_exc()}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({"error": str(e)})
        }
