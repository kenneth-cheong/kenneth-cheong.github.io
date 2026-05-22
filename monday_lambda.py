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
    
    # Strip internal fields
    payload = {k: v for k, v in tool_input.items() if k not in ['propertyId', 'action']}
    
    # Basic GA4 report structure if missing
    if 'dateRanges' not in payload:
        payload['dateRanges'] = [{"startDate": "30daysAgo", "endDate": "today"}]
    if 'metrics' not in payload and 'metrics' in tool_input:
        # tool_input metrics is array of strings, GA4 wants array of objects
        payload['metrics'] = [{"name": m} for m in tool_input['metrics']]
    elif 'metrics' not in payload:
        payload['metrics'] = [{"name": "sessions"}, {"name": "activeUsers"}]
        
    if 'dimensions' not in payload and 'dimensions' in tool_input:
        payload['dimensions'] = [{"name": d} for d in tool_input['dimensions']]
        
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
                summary = "\n".join(tool_call_log) if tool_call_log else None
                return {
                    "statusCode": 200,
                    "body": json.dumps({
                        "reply": final_text,
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
