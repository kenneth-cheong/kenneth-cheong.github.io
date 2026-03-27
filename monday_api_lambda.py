import json
import requests
import os
import base64

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY')
MONDAY_API_URL = "https://api.monday.com/v2"

def lambda_handler(event, context):
    headers = {
        "Authorization": MONDAY_API_KEY,
        "API-Version": "2023-10",
        "Content-Type": "application/json"
    }

    def safe_post(url, headers, query):
        try:
            r = requests.post(url, headers=headers, json={"query": query}, timeout=30)
            if r.status_code != 200:
                print(f"Non-200 status from Monday: {r.status_code} - {r.text}")
                return None
            return r.json()
        except Exception as e:
            print(f"safe_post encountered error: {str(e)}")
            return None

    try:
        body = event
        action = body.get('action')
        fetch_type = body.get('fetch_type')
        cursor = body.get('cursor')
        
        # Handle get_updates action
        if action == 'get_updates':
            limit = body.get('limit', 100)
            page = body.get('page', 1)
            updates_query = f'''
            {{
              updates (limit: {limit}, page: {page}) {{
                id
                text_body
                created_at
                creator {{
                  name
                }}
                item {{
                  name
                  url
                  board {{
                    name
                  }}
                }}
                replies {{
                  id
                  text_body
                  created_at
                  creator {{
                    name
                  }}
                }}
              }}
            }}
            '''
            u_data = safe_post(MONDAY_API_URL, headers, updates_query)
            if not u_data or 'errors' in u_data:
                return response(400, u_data or {"error": "Failed to fetch updates"})
            
            updates = u_data.get('data', {}).get('updates', [])
            return response(200, {"updates": updates})
        
        elif fetch_type == 'all_campaigns':
            # Compound cursor: { "b_idx": int, "i_cur": str, "b_ids": [str] }
            cursor_obj = {}
            if cursor:
                try:
                    cursor_obj = json.loads(base64.b64decode(cursor).decode('utf-8'))
                except:
                    pass
            
            board_index = cursor_obj.get('b_idx', 0)
            item_cursor = cursor_obj.get('i_cur')
            board_ids = cursor_obj.get('b_ids')
            
            if not board_ids:
                # 1. Fetch ALL Boards
                q_boards = '{ boards (limit: 1000) { id } }'
                b_res = safe_post(MONDAY_API_URL, headers, q_boards)
                if not b_res:
                    return response(500, {"error": "Failed to fetch boards from Monday API"})
                
                boards_data = b_res.get('data', {}).get('boards', [])
                board_ids = [str(b.get('id')) for b in boards_data if b.get('id')]
            
            flat_items = []
            new_item_cursor = None
            new_board_index = board_index
            
            # If we have an item cursor, we MUST finish fetching items from the current board first
            if item_cursor and board_index < len(board_ids):
                q_items = f'''
                {{
                  next_items_page (limit: 100, cursor: "{item_cursor}") {{
                    cursor
                    items {{
                      id
                      name
                      relative_link
                      column_values {{
                        id
                        text
                        column {{ id title }}
                      }}
                    }}
                  }}
                }}
                '''
                i_res = safe_post(MONDAY_API_URL, headers, q_items)
                if not i_res:
                    return response(500, {"error": "Failed to fetch page items"})
                data = i_res.get('data', {}).get('next_items_page', {})
                
                # Fetch board name for current board_id
                current_board_id = board_ids[board_index]
                q_board_info = f'{{ boards (ids: [{current_board_id}]) {{ name }} }}'
                bi_res = safe_post(MONDAY_API_URL, headers, q_board_info)
                board_name = 'Unknown'
                if bi_res:
                    boards = bi_res.get('data', {}).get('boards', [])
                    if boards:
                        board_name = boards[0].get('name', 'Unknown')
                
                for itm in data.get('items', []):
                    itm['board'] = {"name": board_name, "id": current_board_id}
                    flat_items.append(itm)
                
                new_item_cursor = data.get('cursor')
                if not new_item_cursor:
                    new_board_index += 1
                
                next_cursor_str = None
                if new_board_index < len(board_ids) or new_item_cursor:
                    next_cursor_str = base64.b64encode(json.dumps({
                        "b_idx": new_board_index,
                        "i_cur": new_item_cursor,
                        "b_ids": board_ids
                    }).encode('utf-8')).decode('utf-8')
                
                return response(200, {"items": flat_items, "cursor": next_cursor_str})

            # Process boards in batches
            batch_size = 20
            max_boards_per_call = 40
            boards_processed = 0
            
            while new_board_index < len(board_ids) and boards_processed < max_boards_per_call:
                current_batch = board_ids[new_board_index : new_board_index + batch_size]
                boards_query_list = ",".join(current_batch)
                
                q_batch = f'''
                {{
                  boards (ids: [{boards_query_list}]) {{
                    id
                    name
                    items_page (limit: 100) {{
                      cursor
                      items {{
                        id
                        name
                        relative_link
                        column_values {{
                          id
                          text
                          column {{ id title }}
                        }}
                      }}
                    }}
                  }}
                }}
                '''
                b_batch_res = safe_post(MONDAY_API_URL, headers, q_batch)
                
                if not b_batch_res or 'errors' in b_batch_res:
                    break
                    
                boards_in_res = b_batch_res.get('data', {}).get('boards', [])
                for b in boards_in_res:
                    board_name = b.get('name', 'Unknown')
                    board_id = b.get('id')
                    items_pg = b.get('items_page', {})
                    
                    if board_id:
                        for itm in items_pg.get('items', []):
                            itm['board'] = {"name": board_name, "id": board_id}
                            flat_items.append(itm)
                    
                    if items_pg.get('cursor'):
                        new_item_cursor = items_pg['cursor']
                        next_cursor_str = base64.b64encode(json.dumps({
                            "b_idx": new_board_index,
                            "i_cur": new_item_cursor,
                            "b_ids": board_ids
                        }).encode('utf-8')).decode('utf-8')
                        return response(200, {"items": flat_items, "cursor": next_cursor_str})
                    
                    new_board_index += 1
                    boards_processed += 1

            next_cursor_str = None
            if new_board_index < len(board_ids):
                next_cursor_str = base64.b64encode(json.dumps({
                    "b_idx": new_board_index,
                    "i_cur": None,
                    "b_ids": board_ids
                }).encode('utf-8')).decode('utf-8')

            return response(200, {"items": flat_items, "cursor": next_cursor_str})
            
        else:
            board_id = '2845615047'
            if not cursor:
                query = f'''
                {{
                  boards (ids: {board_id}) {{
                    name
                    items_page (limit: 100) {{
                      cursor
                      items {{
                        id
                        name
                        column_values {{
                          id
                          text
                          column {{ id title }}
                        }}
                      }}
                    }}
                  }}
                }}
                '''
                data = safe_post(MONDAY_API_URL, headers, query)
                if not data or 'errors' in data: return response(400, data or {"error": "Failed to fetch board"})
                
                board_list = data.get('data', {}).get('boards', [])
                if not board_list: return response(404, {"error": "Board not found"})
                board = board_list[0]
                items_res = board.get('items_page', {})
                return response(200, {
                    "boardName": board.get('name', 'Unknown'),
                    "items": items_res.get('items', []),
                    "cursor": items_res.get('cursor')
                })
            else:
                # Pagination using cursor
                query = f'''
                {{
                  next_items_page (limit: 100, cursor: "{cursor}") {{
                    cursor
                    items {{
                      id
                      name
                      column_values {{
                        id
                        text
                        column {{ id title }}
                      }}
                    }}
                  }}
                }}
                '''
                data = safe_post(MONDAY_API_URL, headers, query)
                if not data or 'errors' in data or 'data' not in data or 'next_items_page' not in data['data']:
                    return response(400, {"error": "Failed to fetch next page", "data": data or {}})
                    
                items_res = data['data']['next_items_page']
                return response(200, {
                    "items": items_res.get('items', []),
                    "cursor": items_res.get('cursor')
                })

    except Exception as e:
        return response(500, {"error": str(e)})

def response(status, body):
    if not isinstance(body, str):
        body = json.dumps(body)
    return {
        'statusCode': status,
        'body': body,
        'headers': {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
        }
    }
