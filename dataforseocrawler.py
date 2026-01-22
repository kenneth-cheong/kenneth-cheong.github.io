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
        # Use the provided auth header from the example
        auth_header = 'Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM='
        
        headers = {
            'Authorization': auth_header,
            'Content-Type': 'application/json'
        }

        if action == 'initiate':
            url = body.get('url')
            max_pages = int(body.get('max_pages', 5))
            max_depth = int(body.get('max_depth', 1))
            
            if not url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'URL is required'})
                }
            
            # Extract target domain for DataForSEO
            target = url.replace('https://', '').replace('http://', '').split('/')[0]
            
            post_url = "https://api.dataforseo.com/v3/on_page/task_post"
            payload = [{
                "target": target,
                "start_url": url,
                "force_sitewide_checks": True,
                "check_spell": True,
                "max_crawl_pages": max_pages,
                "enable_javascript": True,
                "max_crawl_depth": max_depth,
                "validate_micromarkup": True
            }]
            
            response = requests.post(post_url, headers=headers, json=payload)
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps(response.json())
            }

        elif action == 'get_results':
            task_id = body.get('task_id')
            if not task_id:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'task_id is required'})
                }
            
            pages_url = "https://api.dataforseo.com/v3/on_page/pages"
            payload = [{
                "id": task_id,
                "limit": 1000
            }]
            
            response = requests.post(pages_url, headers=headers, json=payload)
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps(response.json())
            }

        return {
            'statusCode': 400,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': 'Invalid action'})
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }
