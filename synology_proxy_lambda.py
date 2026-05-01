import json
import urllib.request
import urllib.error
import urllib.parse
import socket

def resolve_quickconnect(nas_id):
    """
    Use Synology's QuickConnect relay protocol to find the actual
    server address (relay or direct HTTPS) for the given NAS ID.
    Returns (server_url, error_string).
    """
    # Modern QuickConnect API (v1)
    api_url = "https://global.quickconnect.to/api/v1/get_conn_info"
    payload = json.dumps({
        "id": nas_id,
        "command": "get_conn_info",
        "version": 1
    }).encode('utf-8')

    print(f"[QUICKCONNECT] Resolving NAS ID '{nas_id}' via {api_url}")
    req = urllib.request.Request(
        api_url,
        data=payload,
        headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw_data = resp.read().decode('utf-8')
            print(f"[QUICKCONNECT] API response: {raw_data}")
            data = json.loads(raw_data)
    except Exception as e:
        print(f"[QUICKCONNECT] API call failed: {e}")
        return None, f"QuickConnect API v1 failed: {str(e)}"

    # Try 'env' block first (relay/tunnel addresses)
    env = data.get('env', {})
    relay_ip = env.get('relay_ip')
    relay_port = env.get('relay_port')
    relay_https_port = env.get('relay_https_port') or relay_port

    if relay_ip and relay_https_port:
        relay_url = f"https://{relay_ip}:{relay_https_port}"
        print(f"[QUICKCONNECT] Using relay: {relay_url}")
        return relay_url, None

    # Fallback: try 'server' block (direct HTTPS)
    server = data.get('server', {})
    ddns = server.get('ddns')
    https_port = server.get('https_port') or server.get('external', {}).get('https', 443)
    if ddns:
        direct_url = f"https://{ddns}:{https_port}" if https_port != 443 else f"https://{ddns}"
        print(f"[QUICKCONNECT] Using direct DDNS: {direct_url}")
        return direct_url, None

    return None, f"Could not resolve QuickConnect address for NAS ID '{nas_id}'. Response: {json.dumps(data)[:300]}"


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

        # Expect: { "nas_id": "mediaonenas", "api_path": "/webapi/auth.cgi?..." }
        # OR legacy: { "url": "https://mediaonenas.sg3.quickconnect.to/webapi/auth.cgi?..." }
        nas_id = body.get('nas_id')
        api_path = body.get('api_path')       # e.g. "/webapi/auth.cgi?api=SYNO.API.Auth&..."
        target_url = body.get('url')          # Legacy full-URL mode

        # --- New mode: nas_id + api_path ---
        if nas_id and api_path:
            server_base, err = resolve_quickconnect(nas_id)
            if err:
                return {
                    'statusCode': 502,
                    'headers': headers,
                    'body': json.dumps({"error": err})
                }
            target_url = server_base + api_path

        elif target_url:
            # Legacy mode: extract nas_id from hostname and re-resolve
            parsed = urllib.parse.urlparse(target_url)
            hostname = parsed.hostname  # e.g. mediaonenas.sg3.quickconnect.to
            path_and_query = parsed.path + ('?' + parsed.query if parsed.query else '')

            if 'quickconnect.to' in hostname:
                nas_id = hostname.split('.')[0]  # "mediaonenas"
                server_base, err = resolve_quickconnect(nas_id)
                if err:
                    return {
                        'statusCode': 502,
                        'headers': headers,
                        'body': json.dumps({"error": err})
                    }
                target_url = server_base + path_and_query
            # else: use target_url as-is (direct IP/hostname)

        else:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({"error": "Provide 'nas_id'+'api_path', or 'url' in payload."})
            }

        print(f"[SYNOLOGY PROXY] Final request URL: {target_url}")

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
