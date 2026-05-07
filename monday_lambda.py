import json
import requests
import os
import base64

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY') or os.environ.get('MONDAY_TOKEN')
MONDAY_API_URL = "https://api.monday.com/v2"

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
            headers={"Authorization": MONDAY_API_KEY, "API-Version": "2026-04"},
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
    try:
        payload = {"query": query}
        if variables:
            payload["variables"] = variables
            
        r = requests.post(
            MONDAY_API_URL,
            headers={"Authorization": key, "API-Version": "2026-04"},
            json=payload,
            timeout=30
        )
        if r.status_code != 200:
            return {"error": f"Monday API HTTP {r.status_code}", "detail": r.text[:500]}
        data = r.json()
        if "errors" in data and data["errors"]:
            return {"error": data["errors"][0].get("message", "GraphQL error"), "graphql_errors": data["errors"]}
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
    Directly call the Google Chat API (v1) to search messages.
    """
    url = "https://chat.googleapis.com/v1/spaces/messages:search"
    headers = {"Authorization": f"Bearer {access_token}"}
    params = {"query": query, "orderBy": order_by}
    
    try:
        r = requests.get(url, headers=headers, params=params, timeout=20)
        if r.status_code != 200:
            return {"error": f"Google Chat API HTTP {r.status_code}", "detail": r.text[:500]}
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
            "description": "Search for messages. MANDATORY: Always set 'orderBy': 'CREATE_TIME_DESC' to get the NEWEST messages first. This is the only way to see today's messages.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Keywords or space name."},
                    "orderBy": {"type": "string", "enum": ["CREATE_TIME_DESC", "CREATE_TIME_ASC"], "description": "Set to 'CREATE_TIME_DESC' for newest first."}
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
            "name": "search_conversations",
            "description": "Search for Google Chat conversations (Spaces, DMs, group chats) by name or participants.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "spaceNameQuery": {
                        "type": "string",
                        "description": "Search for conversations by name (e.g., 'justtest')."
                    },
                    "participants": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Filter by participant email addresses."
                    },
                    "pageSize": {"type": "integer", "description": "Max results (default 100)."}
                }
            }
        },
        {
            "name": "list_messages",
            "description": "Retrieve recent messages from a specific Google Chat conversation (Space).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "conversationId": {
                        "type": "string",
                        "description": "The ID (e.g., 'spaces/XXXXXXXX')."
                    },
                    "pageSize": {"type": "integer", "description": "Max messages (default 20)."},
                    "threadId": {"type": "string", "description": "Filter to specific thread."}
                },
                "required": ["conversationId"]
            }
        },
        {
            "name": "search_messages",
            "description": "Search messages with advanced filtering. Use this to get the NEWEST messages by setting 'orderBy' to 'CREATE_TIME_DESC'.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "searchParameters": {
                        "type": "object",
                        "properties": {
                            "keywords": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Search terms (can be empty if searching by space)."
                            },
                            "conversationId": {"type": "string", "description": "Scope to specific space ID."},
                            "orderBy": {
                                "type": "string",
                                "enum": ["CREATE_TIME_DESC", "CREATE_TIME_ASC"],
                                "description": "Set to 'CREATE_TIME_DESC' for newest first."
                            }
                        }
                    }
                }
            }
        },
        {
            "name": "send_message",
            "description": "Send a message to a specific Google Chat conversation (Space).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "conversationId": {
                        "type": "string",
                        "description": "The target space/DM ID."
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
            "name": "list_mcp_tools",
            "description": "List all available tools on the Google Chat MCP server. Use this if other tools return 'not found'.",
            "input_schema": {
                "type": "object",
                "properties": {}
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
                "tools": tools,
                "messages": messages,
            }
            if system:
                payload["system"] = system

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
                err_body = r.text[:500]
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

                    tool_id    = block["id"]
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
        print(f"[TOOLS] Exception: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
# ───────────────────────────────────────────────────────────────────────────

# ── Claude Haiku chat handler (simple, no tools) ────────────────────────────
def claude_chat(body):
    """
    Proxy a chat request to Anthropic's Messages API (Claude Haiku 4.5).

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

    model      = body.get('model') or os.environ.get('CLAUDE_MODEL', 'claude-haiku-4-5')
    system     = body.get('system', '')
    messages   = body.get('messages', [])
    max_tokens = int(body.get('max_tokens', 4096))

    if not messages:
        return {"statusCode": 400, "body": json.dumps({"error": "No messages provided"})}

    payload = {
        "model": model,
        #"max_tokens": max_tokens,
        "messages": messages,
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
        print(f"[CLAUDE] Response status: {r.status_code}")
        return {"statusCode": r.status_code, "body": r.text}
    except requests.exceptions.Timeout:
        return {"statusCode": 504, "body": json.dumps({"error": "Anthropic API request timed out"})}
    except Exception as e:
        print(f"[CLAUDE] Exception: {str(e)}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
# ───────────────────────────────────────────────────────────────────────────

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
    elif action == 'claude_chat':
        result = claude_chat(body)
    elif action == 'claude_chat_with_tools':               # ← agentic loop
        result = claude_chat_with_tools(body)
    elif action == 'get_monday_data':
        # Proxy action for raw GraphQL queries
        params = body.get('data', body)
        query = params.get('query') or body.get('query')
        variables = params.get('variables') or body.get('variables')
        api_key = params.get('api_key') or body.get('api_key')
        
        result_data = run_monday_graphql(query, variables=variables, api_key=api_key)
        
        # If run_monday_graphql returned an error dict instead of data
        status_code = 200
        if isinstance(result_data, dict) and "error" in result_data:
            if "HTTP" in str(result_data.get("error")):
                status_code = 400
        
        result = {"statusCode": status_code, "body": json.dumps(result_data)}
    else:
        result = {"statusCode": 400, "body": json.dumps({"error": "Invalid Action"})}

    if 'headers' not in result:
        result['headers'] = headers

    return result
