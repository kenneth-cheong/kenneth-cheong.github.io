import json
import requests
import os

MONDAY_API_KEY = os.environ.get('MONDAY_API_KEY')
MONDAY_API_URL = "https://api.monday.com/v2"

def lambda_handler(event, context):
    headers = {
        "Authorization": MONDAY_API_KEY,
        "API-Version": "2023-10",
        "Content-Type": "application/json"
    }

    try:
        body = event
        action = body.get('action')
        fetch_type = body.get('fetch_type')
        cursor = body.get('cursor')
        
        # Handle get_updates action
        if action == 'get_updates':
            limit = body.get('limit', 30)
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
            u_res = requests.post(MONDAY_API_URL, headers=headers, json={"query": updates_query})
            u_data = u_res.json()
            if 'errors' in u_data:
                return response(400, u_data)
            
            updates = u_data.get('data', {}).get('updates', [])
            return response(200, {"updates": updates})
        
        elif fetch_type == 'all_campaigns':
            # Target folders to draw project boards from
            target_folders = [
                'PSG V3 Campaigns', '9. PSG Campaigns', '9. Regular Campaigns',
                '9. After-PSG Campaigns', 'Regular Campaign in Old Board', 'SaaS Campaign'
            ]
            
            # 1. Fetch Folders
            q_folders = '{ folders (limit: 100) {name id} }'
            f_res = requests.post(MONDAY_API_URL, headers=headers, json={"query": q_folders}).json()
            folders_data = f_res.get('data', {}).get('folders', [])
            folder_ids = {str(f['id']) for f in folders_data if f['name'] in target_folders}
            
            # 2. Fetch Boards
            q_boards = '{ boards (limit: 1000) {board_folder_id name id} }'
            b_res = requests.post(MONDAY_API_URL, headers=headers, json={"query": q_boards}).json()
            boards_data = b_res.get('data', {}).get('boards', [])
            
            # Filter targeted boards
            target_board_dict = {str(b['id']): b['name'] for b in boards_data if str(b.get('board_folder_id')) in folder_ids}
            target_board_ids = list(target_board_dict.keys())
            
            # 3. Batch Query Items Across Boards (Limit to 50 target boards and 10 items each to prevent timeout/complexity issues)
            # You can paginate or parallelize this in the future if limits are hit
            boards_query_list = ",".join(target_board_ids[:40]) 
            
            all_campaign_query = f'''
            {{
              boards (ids: [{boards_query_list}]) {{
                id
                name
                items_page (limit: 15) {{
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
            
            c_res = requests.post(MONDAY_API_URL, headers=headers, json={"query": all_campaign_query})
            c_data = c_res.json()
            if 'errors' in c_data:
                return response(400, c_data)
                
            # Aggregate items into a flat list, preserving board names
            flat_items = []
            for board in c_data.get('data', {}).get('boards', []):
                board_name = board['name']
                b_items = board.get('items_page', {}).get('items', [])
                for itm in b_items:
                    itm['board'] = {"name": board_name, "id": board['id']}
                    flat_items.append(itm)
                    
            return response(200, {
                "items": flat_items
            })
            
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
                res = requests.post(MONDAY_API_URL, headers=headers, json={"query": query})
                data = res.json()
                if 'errors' in data: return response(400, data)
                
                board = data['data']['boards'][0]
                items_res = board['items_page']
                return response(200, {
                    "boardName": board['name'],
                    "items": items_res['items'],
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
                res = requests.post(MONDAY_API_URL, headers=headers, json={"query": query})
                data = res.json()
                if 'errors' in data or 'data' not in data or 'next_items_page' not in data['data']:
                    return response(400, {"error": "Failed to fetch next page", "data": data})
                    
                items_res = data['data']['next_items_page']
                return response(200, {
                    "items": items_res['items'],
                    "cursor": items_res.get('cursor')
                })

    except Exception as e:
        return response(500, {"error": str(e)})

def response(status, body):
    return {
        'statusCode': status,
        'body': body,
        'headers': {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json"
        }
    }
