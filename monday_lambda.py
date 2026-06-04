import json
import requests
import os
import base64
import time
import traceback
from datetime import datetime
from pymongo import MongoClient
from bson import ObjectId

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY') or os.environ.get('MONDAY_TOKEN')
MONDAY_API_URL = "https://api.monday.com/v2"
SERANKING_TOKEN = os.environ.get('SERANKING_TOKEN') or "4181980cafdc89bc7bd8c7e9d26725f18cd617ef"
DATAFORSEO_API_KEY = os.environ.get('DATAFORSEO_API_KEY') or os.environ.get('API_KEY')

# MongoDB Config
MONGODB_URI = os.environ.get('MONGODB_URI')
MONGODB_DATABASE = 'monday_db'
mongo_client = None

def get_db():
    global mongo_client
    if mongo_client is None:
        if not MONGODB_URI:
            return None
        try:
            mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
            mongo_client.admin.command('ping')
        except Exception as e:
            print(f"MongoDB connection error: {str(e)}")
            return None
    return mongo_client[MONGODB_DATABASE]

class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId): return str(o)
        if isinstance(o, datetime): return o.isoformat()
        return super(JSONEncoder, self).default(o)

def get_clean_openai_key(body):
    raw_key = body.get('openai_key') or os.environ.get('OPENAI_API_KEY') or os.environ.get('GPT_KEY')
    if not raw_key or str(raw_key).lower() in ["null", "undefined", ""]:
        raw_key = os.environ.get('GPT_KEY') or os.environ.get('OPENAI_API_KEY')
    if not raw_key:
        return None
    s_key = str(raw_key).strip()
    if s_key.lower().startswith('bearer '):
        s_key = s_key[7:].strip()
    s_key = s_key.replace('"', '').replace("'", "")
    if len(s_key) > 8:
        print(f"[DEBUG] Using Key: {s_key[:4]}...{s_key[-4:]}")
    return s_key

def openai_proxy(body):
    openai_key = get_clean_openai_key(body)
    if not openai_key:
        return {"statusCode": 401, "body": json.dumps({"error": "OpenAI Key Missing"})}
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

def google_refresh_token(body):
    refresh_token = body.get('refresh_token')
    client_id = body.get('client_id')
    client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
    if not refresh_token or not client_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing refresh_token or client_id"})}
    if not client_secret:
        return {"statusCode": 500, "body": json.dumps({"error": "GOOGLE_CLIENT_SECRET environment variable not configured"})}
    try:
        r = requests.post('https://oauth2.googleapis.com/token', data={
            'refresh_token': refresh_token,
            'client_id': client_id,
            'client_secret': client_secret,
            'grant_type': 'refresh_token'
        }, timeout=15)
        return {"statusCode": r.status_code, "body": r.text}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def tiktok_auth(body):
    auth_code = body.get('auth_code')
    if not auth_code:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing auth_code"})}
    try:
        r = requests.post(
            'https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/',
            json={
                "app_id": "7530162592132792321",
                "secret": "622e73187d25951998792c27e8c85c9ec1c6a831",
                "auth_code": auth_code
            },
            headers={"Content-Type": "application/json"},
            timeout=15
        )
        data = r.json()
        access_token = data.get('data', {}).get('access_token')
        if access_token:
            return {"statusCode": 200, "body": json.dumps({"access_token": access_token})}
        return {"statusCode": 400, "body": json.dumps({"error": data.get('message', 'Auth failed'), "raw": data})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def linkedin_get_ad_accounts(body):
    access_token = body.get('access_token')
    if not access_token:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing access_token"})}
    try:
        url = "https://api.linkedin.com/rest/adAccounts?q=search&search=(status:(values:List(ACTIVE)))&count=100"
        r = requests.get(
            url,
            headers={
                'Authorization': f'Bearer {access_token}',
                'LinkedIn-Version': '202510',
                'X-Restli-Protocol-Version': '2.0.0'
            },
            timeout=15
        )
        data = r.json()
        elements = data.get('elements', [])
        return {"statusCode": r.status_code, "body": json.dumps({"elements": elements, "_raw": data})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

def get_board_items(body):
    if not MONDAY_API_KEY:
        return {"statusCode": 500, "body": json.dumps({"error": "MONDAY_API_KEY environment variable not configured"})}
    params = body.get('data', body)
    cursor = params.get('cursor')
    limit = params.get('limit', 100)
    
    # Use provided board_id or fall back to environment variable
    board_id = params.get('board_id') or os.environ.get('MONDAY_BOARD_ID')
    
    if not board_id:
        return {"statusCode": 500, "body": json.dumps({"error": "No MONDAY_BOARD_ID found in params or env"})}
    try:
        cursor_param = f', cursor: "{cursor}"' if cursor else ''
        query_str = f"""query {{
    boards(ids: [{board_id}]) {{
        columns {{ id title }}
        items_page(limit: {limit}{cursor_param}) {{
            cursor
            items {{
                id
                name
                column_values {{
                    id
                    text
                }}
            }}
        }}
    }}
}}"""
        print(f"[DEBUG] Monday Query with cursor: {cursor}")
        response = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": MONDAY_API_KEY, "API-Version": "2024-04"},
            json={"query": query_str},
            timeout=30
        )
        print(f"[DEBUG] Monday API Response Status: {response.status_code}")
        if response.status_code != 200:
            return {"statusCode": response.status_code, "body": json.dumps({"error": response.text})}
        data = response.json()
        if 'errors' in data:
            return {"statusCode": 400, "body": json.dumps({"error": data['errors'][0]['message'] if data['errors'] else "Unknown error"})}
        try:
            board_data = data['data']['boards'][0]
            items_page = board_data['items_page']
            items = items_page.get('items', [])
            new_cursor = items_page.get('cursor')
            columns = board_data.get('columns', [])
            
            print(f"[DEBUG] Retrieved {len(items)} items, next_cursor: {new_cursor}")
            return {"statusCode": 200, "body": json.dumps({"items": items, "cursor": new_cursor, "columns": columns})}
        except (KeyError, IndexError, TypeError) as e:
            return {"statusCode": 500, "body": json.dumps({"error": f"Failed to parse Monday.com response: {str(e)}"})}
    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Monday.com API request timed out"})}
    except Exception as e:
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

# ── Monday GraphQL helper (updated for crawler support) ──────────────────────
def run_monday_graphql(query, variables=None, api_key=None):
    """Execute a raw GraphQL query against Monday.com and return parsed JSON."""
    key = api_key or MONDAY_API_KEY
    if not key:
        return {"error": "MONDAY_API_KEY not configured and no api_key provided"}
    start_time = time.time()
    try:
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
            
        r = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": key, "API-Version": "2024-04"},
            json=payload,
            timeout=30
        )
        if r.status_code != 200:
            return {"error": f"Monday API HTTP {r.status_code}", "detail": r.text[:500]}
        data = r.json()
        print(f"[MONDAY-GQL] Query completed in {time.time() - start_time:.2f}s")
        if "errors" in data and data["errors"]:
            error_msg = data["errors"][0].get("message", "GraphQL error")
            print(f"[MONDAY-GQL] ERROR: {error_msg}")
            return {"error": error_msg, "graphql_errors": data["errors"]}
        return data.get("data", data)
    except requests.exceptions.Timeout:
        return {"error": "Monday.com API timed out"}
    except Exception as e:
        return {"error": str(e)}
# ───────────────────────────────────────────────────────────────────────────

# ── Google Chat MCP helper ──────────────────────────────────────────────────
def run_google_chat_mcp_tool(tool_name, tool_input, access_token):
    """
    Execute a tool call against the Google Chat MCP server.
    Endpoint: https://chatmcp.googleapis.com/mcp/v1
    Protocol: JSON-RPC 2.0
    """
    if not access_token:
        return {"error": "Google Workspace access token missing. Please authenticate first."}
    
    mcp_endpoint = "https://chatmcp.googleapis.com/mcp/v1"
    
    # Map our Claude tool names back to MCP tool names if needed
    # (Though we can just use the same names in the Claude definition)
    
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": tool_input
        }
    }
    
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    try:
        print(f"[MCP] Calling {tool_name} with {json.dumps(tool_input)}")
        r = requests.post(mcp_endpoint, headers=headers, json=payload, timeout=30)
        
        if r.status_code != 200:
            return {"error": f"MCP API HTTP {r.status_code}", "detail": r.text[:500]}
            
        data = r.json()
        if "error" in data:
            print(f"[MCP] JSON-RPC Error: {json.dumps(data['error'])}")
            return {"error": "MCP JSON-RPC Error", "detail": data["error"]}
            
        # The result of a tools/call is usually in data["result"]
        if "result" in data:
            res = data["result"]
            # If the result is already in the MCP content format, return it directly
            if isinstance(res, dict) and "content" in res:
                return res
            
            # If it's a raw object, try to make it more readable for Claude
            try:
                # If it looks like a list of items (common in search results)
                if isinstance(res, list):
                    return {"items": res, "count": len(res)}
                if isinstance(res, dict):
                    # Flatten common response wrappers
                    if "conversations" in res: return res["conversations"]
                    if "messages" in res: return res["messages"]
                    if "items" in res: return res["items"]
            except:
                pass
                
            return res
            
        return data
        
    except requests.exceptions.Timeout:
        return {"error": "Google Chat MCP API timed out"}
    except Exception as e:
        print(f"[MCP] Exception: {str(e)}")
        return {"error": str(e)}
# ───────────────────────────────────────────────────────────────────────────


# ── Google Chat Standard API helper ──────────────────────────────────────────
def list_google_chat_spaces_standard(access_token, page_size=100):
    """
    Directly call the Google Chat API (v1) to list spaces.
    Useful as a fallback if MCP tools fail.
    """
    url = "https://chat.googleapis.com/v1/spaces"
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"pageSize": page_size}
    
    try:
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return {"error": f"Google Chat API HTTP {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def list_google_chat_messages_standard(access_token, space_name, page_size=20, filter_str=None):
    """
    Directly call the Google Chat API (v1) to list messages in a space.
    """
    url = f"https://chat.googleapis.com/v1/{space_name}/messages"
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"pageSize": page_size}
    if filter_str:
        params["filter"] = filter_str
    
    try:
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return {"error": f"Google Chat API HTTP {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def search_google_chat_messages_standard(access_token, query, order_by="CREATE_TIME_DESC"):
    """
    User-level Google Chat message search.
    Step 1: Try the admin search endpoint.
    Step 2 (Fallback): List all spaces, fuzzy-match by name, then fetch messages from matching space.
    """
    headers = {"Authorization": f"Bearer {access_token}"}
    
    # Step 1: Try admin search endpoint first
    url = "https://chat.googleapis.com/v1/spaces/-/messages:search"
    params = {"query": query, "orderBy": order_by}
    
    try:
        print(f"[GCHAT] Searching via Standard API: {query}")
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code == 200:
            return r.json()
        print(f"[GCHAT] Admin search failed ({r.status_code}), using space-name fallback.")
    except Exception as e:
        print(f"[GCHAT] Admin search exception: {e}")
    
    # Step 2: Fuzzy fallback — list spaces, find the matching one, fetch its messages
    try:
        all_spaces = []
        next_page_token = None
        pages = 0
        while pages < 10:
            params_spaces = {"pageSize": 100}
            if next_page_token:
                params_spaces["pageToken"] = next_page_token
            res = requests.get("https://chat.googleapis.com/v1/spaces", headers=headers, params=params_spaces, timeout=20)
            if res.status_code != 200:
                return {"error": f"Google Chat API {res.status_code}", "detail": res.text[:400]}
            data = res.json()
            all_spaces.extend(data.get("spaces", []))
            next_page_token = data.get("nextPageToken")
            pages += 1
            if not next_page_token:
                break
        
        # Fuzzy match: strip hyphens, spaces, case-insensitive
        q_clean = query.lower().replace("-", " ").replace("_", " ")
        q_words = [w for w in q_clean.split() if len(w) > 2]  # skip short words
        
        best_space = None
        best_score = 0
        for space in all_spaces:
            name = (space.get("displayName") or space.get("name") or "").lower().replace("-", " ").replace("_", " ")
            score = sum(1 for w in q_words if w in name)
            if score > best_score:
                best_score = score
                best_space = space
        
        if not best_space or best_score == 0:
            return {"error": "Space not found", "detail": f"No space matching '{query}' found among {len(all_spaces)} spaces. Try using exact keywords.", "spaces_checked": len(all_spaces)}
        
        space_id = best_space["name"]  # e.g. "spaces/XXXXXXXX"
        print(f"[GCHAT] Matched space: {best_space.get('displayName')} ({space_id}) with score {best_score}")
        
        msg_params = {"pageSize": 25, "orderBy": "createTime desc"}
        msg_res = requests.get(f"https://chat.googleapis.com/v1/{space_id}/messages", headers=headers, params=msg_params, timeout=20)
        if msg_res.status_code != 200:
            return {"error": f"Messages fetch failed {msg_res.status_code}", "detail": msg_res.text[:400]}
        
        result = msg_res.json()
        result["_matched_space"] = best_space.get("displayName") or space_id
        return result
        
    except Exception as e:
        return {"error": str(e)}

def run_google_ads_report(customer_id, query, token):
    url = f"https://googleads.googleapis.com/v22/customers/{customer_id}/googleAds:searchStream"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "developer-token": "mmWDgUpTcZSkkrj-7nnebg",
        "login-customer-id": "4695999392"
    }
    payload = {"query": query}
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.status_code != 200:
            return {"error": f"Google Ads API {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}

def run_gsc_performance(site_url, tool_input, token):
    import urllib.parse
    from datetime import datetime, timedelta
    
    encoded_site = urllib.parse.quote_plus(site_url)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    # Strip siteUrl and other internal fields from payload
    payload = {k: v for k, v in tool_input.items() if k not in ['siteUrl', 'action']}
    
    # Defaults
    if 'startDate' not in payload:
        payload['startDate'] = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    if 'endDate' not in payload:
        payload['endDate'] = datetime.now().strftime('%Y-%m-%d')
    if 'dimensions' not in payload:
        payload['dimensions'] = ['query']
        
    try:
        # Prepare variations of the site URL to handle different GSC property types
        import urllib.parse
        domain = site_url.split("//")[-1].split("/")[0]
        
        variations = [
            site_url,                       # 1. As provided (e.g. https://example.com/)
            site_url.rstrip('/'),           # 2. No trailing slash (e.g. https://example.com)
            f"sc-domain:{domain}",          # 3. Domain property (sc-domain:example.com)
            domain                          # 4. Raw domain (example.com)
        ]
        
        # Remove duplicates while preserving order
        unique_variations = []
        for v in variations:
            if v not in unique_variations: unique_variations.append(v)

        last_error = None
        for v in unique_variations:
            encoded_v = urllib.parse.quote(v, safe='')
            target_url = f"https://www.googleapis.com/webmasters/v3/sites/{encoded_v}/searchAnalytics/query"
            
            print(f"[GSC] Trying variation: {v}")
            r = requests.post(target_url, headers=headers, json=payload, timeout=20)
            
            if r.status_code == 200:
                print(f"[GSC] Success using variation: {v}")
                return r.json()
            
            last_error = r.text
            print(f"[GSC] Variation {v} failed: {r.status_code}")

        # If all variations failed, report the last error
        print(f"[GSC] All variations failed. Last error: {last_error}")
        
        # Try to get user identity to help debug permission issues
        user_info = "Unknown Account"
        try:
            ident_res = requests.get("https://www.googleapis.com/oauth2/v3/userinfo", headers=headers, timeout=5)
            if ident_res.status_code == 200:
                user_info = ident_res.json().get('email', 'Email hidden')
        except: pass
        
        error_detail = f"Account: {user_info}. Property tried: {site_url}. " + (last_error[:400] if last_error else "Unknown Error")
        return {"error": "GSC Permission Denied", "detail": error_detail}

    except Exception as e:
        return {"error": str(e)}

def run_ga4_report(property_id, tool_input, token):
    url = f"https://analyticsdata.googleapis.com/v1beta/{property_id}:runReport"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Strip internal fields and GA4-specific keys handled separately
    payload = {k: v for k, v in tool_input.items() if k not in ['propertyId', 'action', 'metrics', 'dimensions', 'startDate', 'endDate']}

    # Build dateRanges from startDate/endDate or default to last 30 days
    if 'dateRanges' not in payload:
        start = tool_input.get('startDate', '30daysAgo')
        end = tool_input.get('endDate', 'today')
        payload['dateRanges'] = [{"startDate": start, "endDate": end}]

    # GA4 API requires metrics/dimensions as array of objects {name: ...}, not plain strings
    raw_metrics = tool_input.get('metrics')
    if raw_metrics:
        payload['metrics'] = [{"name": m} if isinstance(m, str) else m for m in raw_metrics]
    else:
        payload['metrics'] = [{"name": "sessions"}, {"name": "activeUsers"}]

    raw_dims = tool_input.get('dimensions')
    if raw_dims:
        payload['dimensions'] = [{"name": d} if isinstance(d, str) else d for d in raw_dims]
        
    try:
        print(f"[GA4] Querying {property_id} with payload: {payload}")
        r = requests.post(url, headers=headers, json=payload, timeout=30)
        if r.status_code != 200:
            return {"error": f"GA4 API {r.status_code}", "detail": r.text[:500]}
        return r.json()
    except Exception as e:
        return {"error": str(e)}

# ── Agentic loop: Claude + Monday.com tool use ──────────────────────────────
def claude_chat_with_tools(body):
    """
    Full agentic loop:
      1. Send messages to Claude with a monday_graphql tool defined.
      2. If Claude calls the tool, execute the GraphQL query against Monday.com.
      3. Feed the result back to Claude.
      4. Repeat until Claude returns a final text response.
      5. Return { reply, tool_calls_summary } to the browser.

    Expected body fields:
      system     - system prompt string
      messages   - list of {role, content} conversation history
      max_tokens - int (optional, defaults to 4096)
      model      - Claude model ID (optional)
    """
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return {"statusCode": 500, "body": json.dumps({"error": "ANTHROPIC_API_KEY environment variable not configured"})}

    model      = body.get('model') or os.environ.get('CLAUDE_MODEL', 'claude-haiku-4-5')
    system     = body.get('system', '')
    messages   = list(body.get('messages', []))   # mutable copy for the loop
    max_tokens = int(body.get('max_tokens', 4096))
    thinking   = body.get('thinking')  # e.g. {"type": "enabled", "budget_tokens": 8000}

    if not messages:
        return {"statusCode": 400, "body": json.dumps({"error": "No messages provided"})}

    # Tool definitions
    tools = [{
            "name": "search_messages_standard",
            "description": "PRIMARY TOOL for finding messages. Use this IMMEDIATELY if the user provides a space name or keywords. This tool searches across ALL spaces simultaneously. MANDATORY: Always set 'orderBy': 'CREATE_TIME_DESC'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The space name or keywords (e.g., '1-company-announcements')."},
                    "orderBy": {"type": "string", "enum": ["CREATE_TIME_DESC", "CREATE_TIME_ASC"], "description": "Set to 'CREATE_TIME_DESC'."}
                },
                "required": ["query"]
            }
        },
        {
            "name": "monday_graphql",
            "description": (
                "Execute a GraphQL query against the Monday.com API. "
                "Use this to discover boards, fetch items, column values, updates, "
                "people assignments, statuses, and any other workspace data."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "A valid Monday.com GraphQL query string."
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "list_my_spaces",
            "description": "List all Google Chat spaces you are a member of using the standard Google Chat API. Use this if 'search_conversations' fails.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pageSize": {"type": "integer", "description": "Max results (default 100)."}
                }
            }
        },
        {
            "name": "list_messages_standard",
            "description": "Lists messages starting from the OLDEST. Do NOT use this if the user wants recent messages; use search_messages_standard instead.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "spaceName": {
                        "type": "string",
                        "description": "The resource name (e.g., 'spaces/XXXXXXXX')."
                    },
                    "pageSize": {"type": "integer", "description": "Max results (default 20)."},
                    "filter": {"type": "string", "description": "A query filter (e.g. 'createTime > \"2026-05-01T00:00:00Z\"')."}
                },
                "required": ["spaceName"]
            }
        },
        {
            "name": "send_message",
            "description": "Send a message to a specific Google Chat space. Requires the space resource name (e.g. 'spaces/XXXXXXXX').",
            "input_schema": {
                "type": "object",
                "properties": {
                    "conversationId": {
                        "type": "string",
                        "description": "The target space resource name (e.g., 'spaces/XXXXXXXX')."
                    },
                    "messageText": {
                        "type": "string",
                        "description": "The message body (Markdown supported)."
                    },
                    "threadId": {"type": "string"}
                },
                "required": ["conversationId", "messageText"]
            }
        },

        {
            "name": "get_gsc_performance",
            "description": "Fetch Google Search Console performance data (clicks, impressions, ctr, position).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "siteUrl": {"type": "string", "description": "The site URL (e.g., 'sc-domain:example.com')."},
                    "startDate": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "endDate": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "dimensions": {"type": "array", "items": {"type": "string", "enum": ["query", "page", "country", "device", "date"]}}
                },
                "required": ["siteUrl"]
            }
        },
        {
            "name": "get_ga4_report",
            "description": "Fetch Google Analytics 4 report data (sessions, users, conversions).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "propertyId": {"type": "string", "description": "The GA4 Property ID (e.g., 'properties/12345')."},
                    "startDate": {"type": "string", "description": "Start date (YYYY-MM-DD)."},
                    "endDate": {"type": "string", "description": "End date (YYYY-MM-DD)."},
                    "metrics": {"type": "array", "items": {"type": "string"}},
                    "dimensions": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["propertyId"]
            }
        },
        {
            "name": "get_ads_report",
            "description": "Fetch performance data from Google Ads using GAQL. Metrics include cost_micros, clicks, impressions, conversions, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "customerId": {"type": "string", "description": "The Google Ads Customer ID."},
                    "query": {"type": "string", "description": "The GAQL query string."}
                },
                "required": ["customerId", "query"]
            }
        },
        {
            "name": "get_seranking_report",
            "description": "Fetch SE Ranking SEO keyword rankings, groups, and positions for a specific site/campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "siteId": {"type": "string", "description": "The SE Ranking Site ID (Campaign ID)."},
                    "includePositions": {"type": "boolean", "description": "Whether to fetch current ranking positions (pos, change, date)."}
                },
                "required": ["siteId"]
            }
        },
        {
            "name": "get_dataforseo_keyword_suggestions",
            "description": "Discover new keyword ideas, search volume, and CPC using DataForSEO's Google Ads database.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keywords": {"type": "array", "items": {"type": "string"}, "description": "Seed keywords for research."},
                    "location_name": {"type": "string", "description": "Location name (e.g., 'Singapore', 'United States')."},
                    "language_name": {"type": "string", "description": "Language name (e.g., 'English')."}
                },
                "required": ["keywords"]
            }
        },
        {
            "name": "dataforseo_serp",
            "description": "Get Google organic SERP results for a keyword. Returns the top-ranking pages, their URLs, titles, descriptions, and positions.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keyword": {"type": "string", "description": "The search keyword to get SERP results for."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States', 'United Kingdom'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."},
                    "depth": {"type": "integer", "description": "Number of results to return (default 10, max 100).", "default": 10}
                },
                "required": ["keyword"]
            }
        },
        {
            "name": "dataforseo_search_volume",
            "description": "Get Google Ads search volume, competition level, and CPC for a list of keywords.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "keywords": {"type": "array", "items": {"type": "string"}, "description": "List of keywords to get search volume for (max 1000)."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."}
                },
                "required": ["keywords"]
            }
        },
        {
            "name": "dataforseo_backlinks_summary",
            "description": "Get a backlink summary for a domain or URL: total backlinks, referring domains, domain rank, and broken pages.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain or URL to get backlinks for, e.g. 'example.com' or 'https://example.com/page'."},
                    "include_subdomains": {"type": "boolean", "description": "Whether to include subdomains (default True).", "default": True}
                },
                "required": ["target"]
            }
        },
        {
            "name": "dataforseo_domain_rank_overview",
            "description": "Get a domain's organic traffic rank overview: estimated traffic, number of keywords ranking, and authority score.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain to analyse, e.g. 'example.com'."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."}
                },
                "required": ["target"]
            }
        },
        {
            "name": "dataforseo_ranked_keywords",
            "description": "Get keywords a domain currently ranks for organically in Google, including positions, search volume, and URLs.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "description": "Domain to get ranked keywords for, e.g. 'example.com'."},
                    "location_name": {"type": "string", "description": "Location name, e.g. 'Singapore', 'United States'."},
                    "language_name": {"type": "string", "description": "Language name, e.g. 'English'."},
                    "limit": {"type": "integer", "description": "Max number of keywords to return (default 100, max 1000).", "default": 100},
                    "filters": {"type": "array", "description": "Optional filters, e.g. [[\"ranked_serp_element.serp_item.rank_group\",\"<\",\"11\"]] for top-10 keywords.", "items": {}}
                },
                "required": ["target"]
            }
        },
        {
            "name": "save_memory_note",
            "description": "STRICT MANDATE. Use this tool whenever you learn a new preference, fact, or logic about the user or their projects to remember for future sessions.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "The specific insight to remember (e.g., 'User prefers tables for SEO data')."},
                    "tag": {"type": "string", "enum": ["Preference", "Project Logic", "Fact", "General"], "description": "Category of the memory."}
                },
                "required": ["text", "tag"]
            }
        }
    ]

    anthropic_headers = {
        "x-api-key": anthropic_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    if thinking:
        anthropic_headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"

    tool_call_log = []   # human-readable summary for the UI
    MAX_TOOL_ROUNDS = 8  # safety cap to prevent infinite loops

    try:
        for round_num in range(MAX_TOOL_ROUNDS + 1):

            payload = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": messages
            }
            if system:
                payload["system"] = system
            if tools:
                payload["tools"] = tools
            if thinking:
                payload["thinking"] = thinking

            # ── Data size logging ──────────────────────────────────────────────
            sys_size = len(system) if system else 0
            msg_size = len(json.dumps(messages))
            total_est = sys_size + msg_size
            print(f"[LOG] Anthropic Request - Round {round_num}")
            print(f"      System Prompt Size: {sys_size} chars")
            print(f"      Messages Size:      {msg_size} chars")
            print(f"      Estimated Total:    {total_est} chars")
            # ───────────────────────────────────────────────────────────────────

            r = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=anthropic_headers,
                json=payload,
                timeout=60,
            )

            if r.status_code != 200:
                err_body = r.text[:1000]
                print(f"[TOOLS] Anthropic error {r.status_code}: {err_body}")
                return {"statusCode": r.status_code, "body": json.dumps({"error": f"Anthropic API error {r.status_code}", "detail": err_body})}

            response_data = r.json()
            stop_reason   = response_data.get("stop_reason")
            content_blocks = response_data.get("content", [])

            # ── Tool result logging ────────────────────────────────────────────
            usage = response_data.get("usage", {})
            print(f"      Response usage: {json.dumps(usage)}")
            # ───────────────────────────────────────────────────────────────────

            # ── Final answer: no more tool calls ──────────────────────────
            if stop_reason == "end_turn":
                final_text = "\n\n".join(
                    block["text"] for block in content_blocks
                    if block.get("type") == "text" and block.get("text", "").strip()
                )
                thinking_text = "\n\n".join(
                    block["thinking"] for block in content_blocks
                    if block.get("type") == "thinking" and block.get("thinking", "").strip()
                ) or None
                summary = "\n".join(tool_call_log) if tool_call_log else None
                return {
                    "statusCode": 200,
                    "body": json.dumps({
                        "reply": final_text,
                        "thinking": thinking_text,
                        "tool_calls_summary": summary,
                        "rounds": round_num,
                        "memory_updates": [t for t in tool_call_log if t.startswith("MEM_SAVE:")],
                        "debug_stats": {
                            "system_chars": sys_size,
                            "messages_chars": msg_size,
                            "total_est_chars": total_est,
                            "usage": usage
                        }
                    })
                }

            # ── Tool use: execute each tool call and feed results back ────
            if stop_reason == "tool_use":
                # Add assistant's full response (including tool_use blocks) to history
                messages.append({"role": "assistant", "content": content_blocks})

                # Build the tool_result message with one result per tool_use block
                tool_results = []
                for block in content_blocks:
                    if block.get("type") != "tool_use":
                        continue

                    tool_id    = block.get("id", f"call_{int(time.time())}")
                    tool_name  = block["name"]
                    tool_input = block.get("input", {})

                    if tool_name == "monday_graphql":
                        gql_query = tool_input.get("query", "")
                        print(f"[TOOLS] Executing monday_graphql: {gql_query[:120]}...")
                        tool_call_log.append(f"▸ {gql_query[:100].strip()}{'…' if len(gql_query) > 100 else ''}")

                        result_data = run_monday_graphql(gql_query)
                        result_str  = json.dumps(result_data)

                        # Truncate very large payloads to prevent blowing token budget
                        if len(result_str) > 40000:
                            print(f"[TOOLS] Result truncated ({len(result_str)} chars)")
                            result_str = result_str[:40000] + "\n... [result truncated, refine query if needed]"

                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name in ["search_conversations", "list_messages", "search_messages", "send_message"]:
                        # Extract Google Access Token from body
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        
                        print(f"[TOOLS] Executing Google Chat MCP: {tool_name}")
                        tool_call_log.append(f"▸ Google Chat: {tool_name}")
                        
                        result_data = run_google_chat_mcp_tool(tool_name, tool_input, google_token)
                        result_str  = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_my_spaces":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        print(f"[TOOLS] Listing Google Chat Spaces via Standard API")
                        
                        page_size = tool_input.get('pageSize', 100)
                        result_data = list_google_chat_spaces_standard(google_token, page_size)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_messages_standard":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        space_name = tool_input.get('spaceName')
                        page_size = tool_input.get('pageSize', 20)
                        filter_str = tool_input.get('filter')
                        
                        print(f"[TOOLS] Listing Google Chat Messages via Standard API for {space_name}")
                        result_data = list_google_chat_messages_standard(google_token, space_name, page_size, filter_str)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "search_messages_standard":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        query = tool_input.get('query')
                        order_by = tool_input.get('orderBy', 'CREATE_TIME_DESC')
                        
                        print(f"[TOOLS] Searching Google Chat Messages via Standard API for {query}")
                        result_data = search_google_chat_messages_standard(google_token, query, order_by)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    
                    elif tool_name == "get_ads_report":
                        customerId = tool_input.get("customerId")
                        query = tool_input.get("query")
                        ads_token = body.get('google_tokens', {}).get('ads')
                        
                        print(f"[TOOLS] Fetching Google Ads Report for {customerId}")
                        result_data = run_google_ads_report(customerId, query, ads_token)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })

                    elif tool_name == "get_gsc_performance":
                        siteUrl = tool_input.get("siteUrl")
                        gsc_token = body.get('google_tokens', {}).get('gsc')
                        
                        print(f"[TOOLS] Fetching GSC Performance for {siteUrl}")
                        result_data = run_gsc_performance(siteUrl, tool_input, gsc_token)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })

                    elif tool_name == "get_ga4_report":
                        propertyId = tool_input.get("propertyId")
                        ga4_token = body.get('google_tokens', {}).get('ga4')
                        
                        print(f"[TOOLS] Fetching GA4 Report for {propertyId}")
                        result_data = run_ga4_report(propertyId, tool_input, ga4_token)
                        result_str = json.dumps(result_data)
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     result_str
                        })
                    elif tool_name == "list_mcp_tools":
                        google_token = body.get('google_access_token') or (body.get('google_tokens', {}).get('workspace'))
                        print(f"[TOOLS] Listing Google Chat MCP Tools with Schemas")
                        
                        payload = {"jsonrpc": "2.0", "id": "list-tools-debug", "method": "tools/list", "params": {}}
                        headers = {"Authorization": f"Bearer {google_token}", "Content-Type": "application/json"}
                        r = requests.post("https://chatmcp.googleapis.com/mcp/v1", headers=headers, json=payload, timeout=30)
                        
                        # Return the full raw response so Claude can see the schemas
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     r.text
                        })
                    elif tool_name == "get_seranking_report":
                        site_id = str(tool_input.get("siteId", ""))
                        include_pos = tool_input.get("includePositions", True)
                        
                        # Validation: Prevent using Monday IDs (usually 10 digits) as SE Ranking Site IDs
                        if len(site_id) >= 10:
                            error_msg = f"Error: Site ID '{site_id}' looks like a Monday.com Item ID. SE Ranking Site IDs are usually 7-8 digits. Please check the context for 'target_site_id' or 'seranking_site_id' associated with the campaign."
                            tool_results.append({
                                "type": "tool_result",
                                "tool_use_id": tool_id,
                                "content": json.dumps({"error": error_msg}),
                                "is_error": True
                            })
                            continue
                        
                        ser_headers = {"Authorization": f"Token {SERANKING_TOKEN}", "Content-Type": "application/json"}
                        
                        # Fetch Keywords
                        kw_res = requests.get(f'https://api4.seranking.com/sites/{site_id}/keywords', headers=ser_headers)
                        keywords = kw_res.json() if kw_res.status_code == 200 else []
                        
                        # Fetch Groups
                        group_res = requests.get(f'https://api4.seranking.com/keyword-groups/{site_id}', headers=ser_headers)
                        groups = group_res.json() if group_res.status_code == 200 else []
                        group_map = {str(g.get('id')): g.get('name', 'Unknown') for g in groups if isinstance(g, dict) and 'id' in g} if isinstance(groups, list) else {}
                        
                        result_data = {"site_id": site_id, "keywords": []}
                        
                        if include_pos:
                            today = datetime.today().strftime('%Y-%m-%d')
                            pos_res = requests.get(f'https://api4.seranking.com/sites/{site_id}/positions?date_from={today}&date_to={today}', headers=ser_headers)
                            pos_data = pos_res.json() if pos_res.status_code == 200 else []
                            
                            pos_map = {}
                            if isinstance(pos_data, list) and len(pos_data) > 0 and 'keywords' in pos_data[0]:
                                for p in pos_data[0]['keywords']:
                                    if isinstance(p, dict) and p.get('id') and p.get('positions'):
                                        latest = p['positions'][-1]
                                        pos_map[str(p.get('id'))] = {"pos": latest.get('pos'), "change": latest.get('change')}
                            
                            if isinstance(keywords, list):
                                for kw in keywords:
                                    k_id = str(kw.get('id', ''))
                                    p_info = pos_map.get(k_id, {})
                                    result_data["keywords"].append({
                                        "name": kw.get('name'),
                                        "group": group_map.get(str(kw.get('group_id')), "No Group"),
                                        "position": p_info.get("pos", "Not Ranked"),
                                        "change": p_info.get("change", "-")
                                    })
                        else:
                            if isinstance(keywords, list):
                                for kw in keywords:
                                    result_data["keywords"].append({
                                        "name": kw.get('name'),
                                        "group": group_map.get(str(kw.get('group_id')), "No Group")
                                    })
                        
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": json.dumps(result_data)
                        })
                        tool_call_log.append(f"Fetched SE Ranking rankings for Site {site_id}")

                    elif tool_name == "get_dataforseo_keyword_suggestions":
                        seeds = tool_input.get("keywords", [])
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        payload = [{
                            "keywords": seeds,
                            "location_name": loc,
                            "language_name": lang,
                            "sort_by": "relevance"
                        }]
                        
                        try:
                            res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live", 
                                              headers=df_headers, json=payload, timeout=30)
                            tool_results.append({
                                "type":        "tool_result",
                                "tool_use_id": tool_id,
                                "content":     res.text
                            })
                            tool_call_log.append(f"Discovered keywords via DataForSEO for: {', '.join(seeds)}")
                        except Exception as e:
                            tool_results.append({
                                "type":        "tool_result",
                                "tool_use_id": tool_id,
                                "content":     json.dumps({"error": str(e)}),
                                "is_error":    True
                            })

                    elif tool_name == "dataforseo_serp":
                        keyword = tool_input.get("keyword", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        depth = tool_input.get("depth", 10)
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/serp/google/organic/live/regular",
                                headers=df_headers,
                                json=[{"keyword": keyword, "location_name": loc, "language_name": lang, "depth": depth, "se_type": "regular"}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched SERP results for: {keyword} ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_search_volume":
                        keywords = tool_input.get("keywords", [])
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live",
                                headers=df_headers,
                                json=[{"keywords": keywords, "location_name": loc, "language_name": lang}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Got search volume for {len(keywords)} keywords ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_backlinks_summary":
                        target = tool_input.get("target", "")
                        include_subdomains = tool_input.get("include_subdomains", True)
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/backlinks/summary/live",
                                headers=df_headers,
                                json=[{"target": target, "include_subdomains": include_subdomains}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched backlinks summary for: {target}")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_domain_rank_overview":
                        target = tool_input.get("target", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/dataforseo_labs/google/domain_rank_overview/live",
                                headers=df_headers,
                                json=[{"target": target, "location_name": loc, "language_name": lang}],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched domain rank overview for: {target}")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "dataforseo_ranked_keywords":
                        target = tool_input.get("target", "")
                        loc = tool_input.get("location_name", "Singapore")
                        lang = tool_input.get("language_name", "English")
                        limit = tool_input.get("limit", 100)
                        filters = tool_input.get("filters")
                        df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                        payload_item = {"target": target, "location_name": loc, "language_name": lang, "limit": limit}
                        if filters:
                            payload_item["filters"] = filters
                        try:
                            res = requests.post(
                                "https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live",
                                headers=df_headers,
                                json=[payload_item],
                                timeout=30
                            )
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": res.text})
                            tool_call_log.append(f"Fetched ranked keywords for: {target} ({loc})")
                        except Exception as e:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                    elif tool_name == "save_memory_note":
                        text = tool_input.get("text", "")
                        tag = tool_input.get("tag", "General")
                        print(f"[TOOLS] Saving Memory Note: [{tag}] {text}")
                        # We use a special prefix in the log to signal the frontend
                        tool_call_log.append(f"MEM_SAVE: {json.dumps({'tag': tag, 'text': text})}")
                        
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     "Success: Note saved to persistent memory modal."
                        })
                    else:
                        # Unknown tool — return an error so Claude can recover
                        tool_results.append({
                            "type":        "tool_result",
                            "tool_use_id": tool_id,
                            "content":     json.dumps({"error": f"Unknown tool: {tool_name}"}),
                            "is_error":    True
                        })

                messages.append({"role": "user", "content": tool_results})
                continue   # next round

            # ── Unexpected stop reason ────────────────────────────────────
            print(f"[TOOLS] Unexpected stop_reason: {stop_reason}")
            # Try to extract any text Claude produced anyway
            fallback_text = "\n\n".join(
                block.get("text", "") for block in content_blocks
                if block.get("type") == "text"
            ).strip()
            return {
                "statusCode": 200,
                "body": json.dumps({
                    "reply": fallback_text or f"Stopped unexpectedly ({stop_reason}).",
                    "tool_calls_summary": "\n".join(tool_call_log) or None
                })
            }

        # Exceeded MAX_TOOL_ROUNDS — return whatever Claude last said
        fallback = "\n\n".join(
            b.get("text", "") for b in content_blocks if b.get("type") == "text"
        ).strip()
        return {
            "statusCode": 200,
            "body": json.dumps({
                "reply": fallback or "I reached the maximum number of data lookups. Please refine your question.",
                "tool_calls_summary": "\n".join(tool_call_log) or None
            })
        }

    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Request timed out during agentic loop"})}
    except Exception as e:
        tb = traceback.format_exc()
        print(f"[TOOLS] Exception: {e}\n{tb}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e), "traceback": tb})}
# ───────────────────────────────────────────────────────────────────────────

# ── Prompt-building helpers (server-side prompts) ────────────────────────────

def _call_claude_simple(system_text, user_text, model='claude-haiku-4-5', max_tokens=4096):
    """Call Anthropic Messages API with a single user turn; return a Lambda result dict."""
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return {'statusCode': 500, 'body': json.dumps({'error': 'ANTHROPIC_API_KEY not configured'})}
    try:
        r = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key':          anthropic_key,
                'anthropic-version':  '2023-06-01',
                'content-type':       'application/json',
            },
            json={
                'model':      model,
                'max_tokens': max_tokens,
                'system':     system_text,
                'messages':   [{'role': 'user', 'content': user_text}]
            },
            timeout=60,
        )
        if r.status_code != 200:
            return {'statusCode': r.status_code,
                    'body': json.dumps({'error': f'Anthropic API error {r.status_code}',
                                        'detail': r.text[:500]})}
        text = r.json().get('content', [{}])[0].get('text', '')
        return {'statusCode': 200, 'body': json.dumps({'result': text, 'reply': text})}
    except requests.exceptions.Timeout:
        return {'statusCode': 504, 'body': json.dumps({'error': 'Anthropic API request timed out'})}
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}


def _build_geo_fetch_body(entities, start_date, end_date,
                          is_comparison=False, cmp_from=None, cmp_to=None):
    """Construct the claude_chat_with_tools body for a WorkDuo GEO visibility fetch."""
    entity_list = [
        f"- {e.get('name')} (entity_id: {e.get('entityId')}, project_id: {e.get('projectId')})"
        for e in entities if e.get('entityId')
    ]
    if is_comparison:
        system_text = (
            f'You are fetching HISTORICAL comparison data from WorkDuo. '
            f'For each entity, call get_visibility with metric="all", '
            f'start_date="{cmp_from}", end_date="{cmp_to}". '
            f'This is a prior-period request — the dates MUST be {cmp_from} to {cmp_to}. '
            'Return ONLY a raw JSON array: '
            '[{"entity_id":"...","name":"...","rows":[{"date":"YYYY-MM-DD","visibility":0.0,'
            '"sov":0.0,"mentions":0,"position":0.0}],"note":null}]'
        )
        user_text = (
            f'Fetch prior-period visibility from {cmp_from} to {cmp_to} '
            f'using start_date="{cmp_from}" and end_date="{cmp_to}" in the tool call. '
            'Return ONLY the JSON array:\n' + '\n'.join(entity_list)
        )
    else:
        system_text = (
            f'You are a data fetcher. For each WorkDuo entity call get_visibility with metric="all", '
            f'start_date="{start_date}", end_date="{end_date}". '
            'Return ONLY a raw JSON array — no markdown, no code fences, no explanation:\n'
            '[{"entity_id":"...","name":"...","rows":[{"date":"YYYY-MM-DD","visibility":0.0,'
            '"sov":0.0,"mentions":0,"position":0.0}],"note":null}]\n'
            'If a project has no data set rows to [] and put the note in "note".'
        )
        user_text = (
            f'Fetch WorkDuo visibility from {start_date} to {end_date} (metric="all") for each entity. '
            'Return ONLY the JSON array:\n' + '\n'.join(entity_list)
        )
    return {
        'model':      'claude-haiku-4-5',
        'max_tokens': 8192,
        'system':     [{'type': 'text', 'text': system_text}],
        'messages':   [{'role': 'user', 'content': [{'type': 'text', 'text': user_text}]}]
    }


def _audit_recommendations(body):
    site_url    = body.get('siteUrl', 'the website')
    issues      = body.get('issues', [])
    total_pages = int(body.get('totalPages', 0) or 0)
    issue_list  = '\n'.join(
        f"- {i.get('label', '')}: {i.get('affected', 0)} of {total_pages} pages affected"
        for i in issues
    )
    system = 'You are a technical SEO expert providing actionable audit recommendations.'
    user = (
        f'A site audit of "{site_url}" ({total_pages} pages crawled) found the following issues:\n\n'
        f'{issue_list}\n\n'
        'Generate 5-7 prioritised, actionable recommendations to fix these issues. '
        'Return ONLY a JSON array with no markdown, where each item has:\n'
        '- priority: "high", "medium", or "low"\n'
        '- title: short title (max 8 words)\n'
        '- issue: one sentence describing the problem\n'
        '- recommendation: 1-2 sentences of specific actionable advice\n'
        '- impact: one sentence on the SEO/UX benefit of fixing this\n\n'
        'JSON array only, no other text.'
    )
    return _call_claude_simple(system, user, max_tokens=2500)


def _competitor_insights(body):
    target_domain = body.get('targetDomain', '')
    location      = body.get('location', '')
    summary       = body.get('summary', '')
    keywords      = body.get('keywords', '')
    domain_part   = f' for target domain "{target_domain}"' if target_domain else ''
    loc_part      = f' in {location}'                        if location      else ''
    system = 'You are a senior SEO strategist providing strategic competitive analysis insights.'
    user = (
        f'A competitor analysis was run{domain_part}{loc_part}.\n\n'
        f'Competitors found and their keyword rankings:\n{summary}\n\n'
        f'Keywords analysed: {keywords or "see above"}\n\n'
        'Generate 5-7 strategic insights and recommendations. '
        'Return ONLY a JSON array where each item has:\n'
        '- type: "insight" or "recommendation"\n'
        '- title: short title (max 8 words)\n'
        '- detail: 2-3 sentences of specific, actionable strategic advice\n'
        '- priority: "high", "medium", or "low" (recommendations only — set "—" for insights)\n'
        '- icon: one of "crosshairs", "chess", "chart-line", "lightbulb", "exclamation-triangle", "trophy", "key"\n\n'
        'JSON array only, no other text.'
    )
    return _call_claude_simple(system, user, max_tokens=2800)


def _strategy_auto_populate(body):
    text   = (body.get('text') or '')[:100000]
    system = 'You are an expert SEO strategist extracting structured business context from raw text.'
    user   = (
        'Analyze the following text and extract key business signals for an SEO strategy.\n'
        'Return ONLY a valid JSON object with the following fields:\n'
        '- client_profile: A concise description of the business.\n'
        '- objectives: An array of objectives from these exact options: '
        '["lead_generation", "brand_authority", "local_visibility", "ecommerce_revenue", '
        '"service_enquiries", "niche_dominance"]. Pick at most 3.\n'
        '- target_audience: Brief description of the target customer.\n'
        '- market_context: Key competitors or market landscape info.\n'
        '- seed_keywords: 3-5 primary keywords found in the text.\n\n'
        f'TEXT:\n{text}'
    )
    return _call_claude_simple(system, user, max_tokens=2000)


def _strategy_generate(body):
    inputs        = body.get('inputs', {})
    discovery     = body.get('discoveryData', [])
    objectives_str = ', '.join(inputs.get('objectives', [])) or 'General Growth'
    system = 'You are the Digimetrics Strategy Engine, a senior SEO strategist.'
    user = (
        'Analyse the client context below and devise 3 to 5 distinct keyword-led SEO strategies '
        'that are genuinely tailored to this specific business, market, and set of objectives. '
        'Do NOT use generic template strategy names — invent strategy angles that make sense for this client.\n\n'
        f'CLIENT PROFILE: {inputs.get("clientProfile", "")}\n'
        f'BUSINESS OBJECTIVES: {objectives_str}\n'
        f'TARGET AUDIENCE: {inputs.get("targetAudience", "General")}\n'
        f'MARKET CONTEXT: {inputs.get("marketContext", "Standard Industry")}\n'
        f'KEYWORD INFLUENCERS (constraints, preferences, brand rules, terms to include/avoid): '
        f'{inputs.get("keywordInfluencers", "None specified")}\n'
        f'SEMANTIC DATA SIGNALS: {json.dumps(discovery[:10])}\n\n'
        'TASK: Based on the above context, determine how many strategies (3-5) are warranted and '
        'what angles are most valuable for this client. Each strategy should target a meaningfully '
        'different audience segment, intent type, or growth lever — avoid overlap. '
        'Name each strategy to reflect the specific opportunity, not a generic category.\n\n'
        'OUTPUT FORMAT (MANDATORY JSON):\n'
        'Return ONLY a JSON object with a "strategies" array. Each strategy MUST have:\n'
        '- "name": Descriptive, client-specific strategy name '
        '(e.g. "Relocation-Season Demand Capture" not "Long-Tail")\n'
        '- "focus": 1-sentence strategic core specific to this client\n'
        '- "target_keywords": Array of 10-15 primary keyword themes relevant to this strategy\n'
        '- "content_approach": Brief content strategy tailored to this angle\n'
        '- "expected_impact": "High", "Medium", or "Very High"\n'
        '- "time_to_rank": Est. months (number)\n'
        '- "recommended": boolean (true for exactly one)\n'
        '- "keyword_data": { "primary_theme": "Core theme", "semantic_clusters": '
        '[ { "topic": "Topic 1", "keywords": ["kw1","kw2","kw3","kw4","kw5"], "intent": "Informational" } ], '
        '"longtail_opportunities": "2-3 sentences explaining the long-tail opportunity" }\n\n'
        'Return compact valid JSON only. No prose.'
    )
    return _call_claude_simple(system, user, max_tokens=4000)


def _strategy_recommendations(body):
    strategy  = body.get('strategy', {})
    audit_ctx = body.get('auditContext', {})
    has_audit = bool(audit_ctx)
    audit_block = (
        f'\nAUDIT DATA (real metrics from the client\'s website):\n{json.dumps(audit_ctx)}\n'
        if has_audit else ''
    )
    kw_list = ', '.join((strategy.get('target_keywords') or [])[:8])
    system  = 'You are a senior SEO strategist reviewing a client website.'
    user    = (
        'Based on the chosen SEO strategy and audit data below, generate a detailed action plan.\n\n'
        'CHOSEN STRATEGY:\n'
        f'- Name: {strategy.get("name", "")}\n'
        f'- Focus: {strategy.get("focus", "")}\n'
        f'- Content Approach: {strategy.get("content_approach", "")}\n'
        f'- Primary Keywords: {kw_list}\n'
        f'{audit_block}'
        'OUTPUT (MANDATORY JSON):\n'
        'Return ONLY a JSON object with exactly two keys:\n\n'
        '1. "strengths": array of 4-8 items representing what the site is already doing well. Each item:\n'
        '   { "title": "Short win title", "detail": "1-sentence explanation", '
        '"category": "Content|Technical SEO|Performance|Domain & Trust" }\n'
        f'   {"Base these on PASSING checks and good scores in the audit data." if has_audit else "Generate plausible general strengths."}\n\n'
        '2. "recommendations": array of 5-8 prioritized actions. Each item:\n'
        '   { "task": "Action title", "description": "Specific actionable step", '
        '"priority": "High|Medium|Low", "effort": "Quick|Medium|Strategic", '
        '"impact": "High|Medium|Low", "rationale": "Why this matters for the strategy", '
        '"category": "Content|Technical SEO|Performance|Domain & Trust" }\n'
        f'   {"Base Technical SEO, Performance, and Domain & Trust items on FAILING or WARN checks in the audit. Do NOT flag items that are already passing." if has_audit else "Include at least 1 item per category."}\n\n'
        'Compact valid JSON only. No prose.'
    )
    return _call_claude_simple(system, user, max_tokens=3500)


# ── Claude Haiku chat handler (simple, no tools) ────────────────────────────
def claude_chat(body):
    """
    Proxy a chat request to Anthropic's Messages API.

    Expected body fields:
      model      - e.g. "claude-haiku-4-5"  (optional, defaults to env CLAUDE_MODEL)
      system     - system prompt string
      messages   - list of {role, content} dicts
      max_tokens - int (optional, defaults to 4096)
    """
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')
    if not anthropic_key:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": "ANTHROPIC_API_KEY environment variable not configured"})
        }

    model      = body.get('model') or os.environ.get('CLAUDE_MODEL', 'claude-3-5-sonnet-20241022')
    system     = body.get('system', '')
    messages   = body.get('messages', [])
    max_tokens = int(body.get('max_tokens', 4096))

    if not messages:
        return {"statusCode": 400, "body": json.dumps({"error": "No messages provided"})}

    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages
    }
    if system:
        payload["system"] = system

    print(f"[CLAUDE] model={model} messages={len(messages)} max_tokens={max_tokens}")

    try:
        r = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": anthropic_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        if r.status_code != 200:
            err_body = r.text[:1000]
            print(f"[CHAT] Anthropic error {r.status_code}: {err_body}")
            return {"statusCode": r.status_code, "body": json.dumps({"error": f"Anthropic API error {r.status_code}", "detail": err_body})}
        return {"statusCode": r.status_code, "body": r.text}
    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Anthropic API request timed out"})}
    except Exception as e:
        print(f"[CLAUDE] Exception: {str(e)}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
# ───────────────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    # Standard CORS headers
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, anthropic-version",
    }

    # Handle Preflight
    if isinstance(event, dict) and event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers}

    try:
        # Parse body
        if isinstance(event, dict):
            if 'body' in event and isinstance(event['body'], str):
                try:
                    body = json.loads(event['body'])
                except:
                    body = {}
            else:
                body = event
        else:
            try:
                body = json.loads(event)
            except:
                body = {}

        action = body.get('action')
        result = None

        if action == 'openai_proxy':
            result = openai_proxy(body)
        elif action == 'openai_upload':
            result = openai_upload(body)
        elif action == 'download_file':
            result = download_file(body)
        elif action == 'google_token_exchange':
            result = google_token_exchange(body)
        elif action == 'google_refresh_token':
            result = google_refresh_token(body)
        elif action == 'linkedin_get_ad_accounts':
            result = linkedin_get_ad_accounts(body)
        elif action == 'tiktok_auth':
            result = tiktok_auth(body)
        elif action == 'get_board_items':
            result = get_board_items(body)
        elif action == 'claude_chat':
            result = claude_chat(body)
        elif action == 'claude_chat_with_tools':
            result = claude_chat_with_tools(body)
        elif action == 'keyword_discovery':
            # Direct access to DataForSEO for the Strategy Engine
            seeds = body.get('keywords', [])
            if isinstance(seeds, str): seeds = [seeds]
            loc = body.get('location', 'Singapore')
            lang = body.get('language', 'English')
            
            df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
            payload = [{
                "keywords": seeds,
                "location_name": loc,
                "language_name": lang,
                "sort_by": "relevance"
            }]
            
            try:
                res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/keywords_for_keywords/live", 
                                  headers=df_headers, json=payload, timeout=30)
                result = {"statusCode": res.status_code, "body": res.text}
            except Exception as e:
                result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        elif action == 'fetch_boards':
            db = get_db()
            if not db: 
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                user_id = body.get('data', {}).get('userId', 'default_workspace')
                user_data = db.boards.find_one({"userId": user_id})
                result = {"statusCode": 200, "body": json.dumps({"boards": user_data.get('boards', []) if user_data else []}, cls=JSONEncoder)}
        elif action == 'save_boards':
            db = get_db()
            if not db: 
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                data = body.get('data', {})
                user_id = data.get('userId')
                if not user_id: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Missing userId"})}
                else:
                    update_doc = {
                        "userId": user_id,
                        "boards": data.get('boards', []),
                        "folders": data.get('folders', []),
                        "lastUpdated": datetime.utcnow()
                    }
                    db.boards.update_one({"userId": user_id}, {"$set": update_doc}, upsert=True)
                    result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'fetch_teams_config':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                doc = db.teams_config.find_one({"orgId": "digimetrics"})
                result = {"statusCode": 200, "body": json.dumps({"teams": doc.get('teams', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'save_teams_config':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                teams = body.get('teams', [])
                db.teams_config.update_one(
                    {"orgId": "digimetrics"},
                    {"$set": {"teams": teams, "lastUpdated": datetime.utcnow()}},
                    upsert=True
                )
                result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'save_tool_log':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                log = body.get('log', {})
                if log:
                    log['orgId'] = 'digimetrics'
                    log['savedAt'] = datetime.utcnow()
                    db.tool_logs.insert_one(log)
                result = {"statusCode": 200, "body": json.dumps({"success": True}, cls=JSONEncoder)}
        elif action == 'fetch_tool_logs':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                limit = min(int(body.get('limit', 500)), 1000)
                since = body.get('since')   # ts > since  (incremental updates)
                before = body.get('before') # ts < before (backward cursor pagination)
                query = {"orgId": "digimetrics"}
                if since:
                    query["ts"] = {"$gt": since}
                elif before:
                    query["ts"] = {"$lt": before}
                logs = list(db.tool_logs.find(query, {"_id": 0, "savedAt": 0, "orgId": 0}).sort("ts", -1).limit(limit))
                result = {"statusCode": 200, "body": json.dumps({"logs": logs, "has_more": len(logs) == limit}, cls=JSONEncoder)}
        elif action == 'clear_tool_logs':
            db = get_db()
            if db is None:
                result = {"statusCode": 500, "body": json.dumps({"error": "MongoDB not configured"})}
            else:
                deleted = db.tool_logs.delete_many({"orgId": "digimetrics"})
                result = {"statusCode": 200, "body": json.dumps({"success": True, "deleted": deleted.deleted_count}, cls=JSONEncoder)}
        elif action == 'get_monday_data':
            params = body.get('data', body)
            query = params.get('query') or body.get('query')
            variables = params.get('variables') or body.get('variables')
            api_key = params.get('api_key') or body.get('api_key')
            result_data = run_monday_graphql(query, variables=variables, api_key=api_key)
            result = {"statusCode": 200, "body": json.dumps(result_data)}
        elif action == 'get_insights':
            db = get_db()
            if not db: 
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                if not email: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    doc = db.insights.find_one({"email": email.lower()})
                    result = {"statusCode": 200, "body": json.dumps({"insights": doc.get('insights', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'get_forensic_audits':
            db = get_db()
            if not db:
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                if not email:
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    doc = db.forensic_audits.find_one({"email": email.lower()})
                    result = {"statusCode": 200, "body": json.dumps({"audits": doc.get('audits', []) if doc else []}, cls=JSONEncoder)}
        elif action == 'save_forensic_audits':
            db = get_db()
            if not db:
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                audits = body.get('audits', [])
                if not email:
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    db.forensic_audits.update_one(
                        {"email": email.lower()},
                        {"$set": {"audits": audits, "updated_at": datetime.now()}},
                        upsert=True
                    )
                    result = {"statusCode": 200, "body": json.dumps({"status": "success"})}
        elif action == 'save_insights':
            db = get_db()
            if not db: 
                result = {"statusCode": 500, "body": json.dumps({"error": "DB Connection Failed"})}
            else:
                email = body.get('email')
                insights = body.get('insights', [])
                if not email: 
                    result = {"statusCode": 400, "body": json.dumps({"error": "Email missing"})}
                else:
                    db.insights.update_one(
                        {"email": email.lower()},
                        {"$set": {"insights": insights, "updated_at": datetime.now()}},
                        upsert=True
                    )
                    result = {"statusCode": 200, "body": json.dumps({"status": "success"})}
        elif action == 'get_keyword_metrics_batch':
            keywords = body.get('keywords', [])
            location = body.get('location', 'Singapore')
            language = body.get('language', 'English')
            
            print(f"[DEBUG] get_keyword_metrics_batch: {len(keywords)} keywords for {location}/{language}")
            
            if not keywords:
                result = {"statusCode": 400, "body": json.dumps({"error": "No keywords provided"})}
            elif not DATAFORSEO_API_KEY:
                print("[ERROR] DATAFORSEO_API_KEY is missing from environment")
                result = {"statusCode": 500, "body": json.dumps({"error": "DataForSEO API Key not configured on server"})}
            else:
                df_headers = {"Authorization": DATAFORSEO_API_KEY, "Content-Type": "application/json"}
                # DataForSEO search_volume endpoint
                # Note: keywords must be a list, and it supports max 700 per task
                payload = [{
                    "keywords": keywords[:700], 
                    "location_name": location,
                    "language_name": language
                }]
                
                try:
                    res = requests.post("https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live", 
                                      headers=df_headers, json=payload, timeout=30)
                    print(f"[DEBUG] DataForSEO Status: {res.status_code}")
                    
                    if res.status_code == 200:
                        data = res.json()
                        formatted_results = []
                        if 'tasks' in data and data['tasks']:
                            for task in data['tasks']:
                                if 'result' in task and task['result']:
                                    for item in task['result']:
                                        formatted_results.append({
                                            "keyword": item.get('keyword'),
                                            "metrics": {
                                                "volume": item.get('search_volume'),
                                                "difficulty": item.get('competition_index'),
                                                "cpc": item.get('cpc')
                                            }
                                        })
                        print(f"[DEBUG] Returning {len(formatted_results)} results")
                        result = {"statusCode": 200, "body": json.dumps({"results": formatted_results})}
                    else:
                        print(f"[ERROR] DataForSEO Error: {res.text}")
                        result = {"statusCode": res.status_code, "body": res.text}
                except Exception as e:
                    print(f"[ERROR] Lambda Exception: {str(e)}")
                    result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        elif action == 'get_seranking_sites':
            ser_headers = {"Authorization": f"Token {SERANKING_TOKEN}", "Content-Type": "application/json"}
            try:
                r = requests.get('https://api4.seranking.com/sites', headers=ser_headers, timeout=10)
                if r.status_code == 200:
                    sites = [{"id": s.get('id'), "title": s.get('title', 'Untitled'), "url": s.get('name', '')} for s in r.json()]
                    result = {"statusCode": 200, "body": json.dumps({"sites": sites})}
                else:
                    result = {"statusCode": r.status_code, "body": r.text}
            except Exception as e:
                result = {"statusCode": 500, "body": json.dumps({"error": str(e)})}
        # ── Server-side prompt actions ────────────────────────────────────
        elif action == 'geo_fetch_visibility':
            cwt_body = _build_geo_fetch_body(
                entities   = body.get('entities', []),
                start_date = body.get('startDate', ''),
                end_date   = body.get('endDate', '')
            )
            result = claude_chat_with_tools(cwt_body)
        elif action == 'geo_fetch_comparison':
            cwt_body = _build_geo_fetch_body(
                entities       = body.get('entities', []),
                start_date     = body.get('startDate', ''),
                end_date       = body.get('endDate', ''),
                is_comparison  = True,
                cmp_from       = body.get('cmpFrom', ''),
                cmp_to         = body.get('cmpTo', '')
            )
            result = claude_chat_with_tools(cwt_body)
        elif action == 'audit_recommendations':
            result = _audit_recommendations(body)
        elif action == 'competitor_insights':
            result = _competitor_insights(body)
        elif action == 'strategy_auto_populate':
            result = _strategy_auto_populate(body)
        elif action == 'strategy_generate':
            result = _strategy_generate(body)
        elif action == 'strategy_recommendations':
            result = _strategy_recommendations(body)
        else:
            result = {"statusCode": 400, "body": json.dumps({"error": f"Invalid Action: {action}"})}

        # Final check on result
        if not result:
            result = {"statusCode": 500, "body": json.dumps({"error": "No result produced"})}
        
        if 'headers' not in result:
            result['headers'] = headers
        else:
            # Merge CORS headers into existing headers if any
            result['headers'].update(headers)

        return result

    except Exception as e:
        tb = traceback.format_exc()
        print(f"[CRITICAL ERROR] {str(e)}\n{tb}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": "Internal Server Error", "detail": str(e), "traceback": tb})
        }
