import json
import requests
import os

def lambda_handler(event, context):
    """
    AWS Lambda handler for DataForSEO On-Page Crawler.
    Supports initiating a crawl task and retrieving results.
    """
    try:
        # Support both API Gateway (json body) and direct Lambda invocation
        if isinstance(event.get('body'), str):
            body = json.loads(event['body'])
        else:
            body = event if event else {}

        action = body.get('action', 'initiate')
        print(f"Action: {action}, Body: {body}")
        
        # Use the provided auth header
        auth_header = 'Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM='
        
        headers = {
            'Authorization': auth_header,
            'Content-Type': 'application/json'
        }

        if action == 'initiate':
            url = body.get('url')
            max_pages = int(body.get('max_pages', 5))
            max_depth = int(body.get('max_depth', 1))
            enable_js = body.get('enable_javascript', True)
            check_spell = body.get('check_spell', True)
            
            if not url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'URL is required'})
                }
            
            target = url.replace('https://', '').replace('http://', '').split('/')[0]
            print(f"Initiating crawl for URL: {url}, Target: {target}, JS: {enable_js}, Spell: {check_spell}")
            
            post_url = "https://api.dataforseo.com/v3/on_page/task_post"
            payload = [{
                "target": target,
                "start_url": url,
                "force_sitewide_checks": True,
                "check_spell": check_spell,
                "max_crawl_pages": max_pages,
                "enable_javascript": enable_js,
                "max_crawl_depth": max_depth,
                "validate_micromarkup": True
            }]
            
            response = requests.post(post_url, headers=headers, json=payload)
            res_json = response.json()
            print(f"Task Post Response: {res_json}")
            
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps(res_json)
            }

        elif action == 'get_results':
            task_id = body.get('task_id')
            limit = int(body.get('limit', 1000))
            
            if not task_id:
                return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'task_id required'})}
            
            pages_url = "https://api.dataforseo.com/v3/on_page/pages"
            payload = [{ "id": task_id, "limit": limit }]
            
            response = requests.post(pages_url, headers=headers, json=payload)
            res_json = response.json()
            print(f"Pages Response for {task_id}: {res_json.get('status_message')}")
            
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps(res_json)
            }

        elif action == 'get_microdata':
            task_id = body.get('task_id')
            if not task_id:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'task_id is required'})
                }
            
            microdata_url = "https://api.dataforseo.com/v3/on_page/microdata"
            payload = [{
                "id": task_id,
                "limit": 100
            }]
            
            print(f"Fetching microdata for Task ID: {task_id}")
            response = requests.post(microdata_url, headers=headers, json=payload)
            res_json = response.json()
            print(f"Microdata Response Status: {response.status_code}, Body: {res_json}")
            
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps(res_json)
            }

        return {
            'statusCode': 400,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': 'Invalid action'})
        }

    except Exception as e:
        print(f"Lambda Exception: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }
