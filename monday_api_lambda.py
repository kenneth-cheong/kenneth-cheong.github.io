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
        board_id = '2845615047'
        cursor = body.get('cursor')
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
