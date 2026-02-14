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
            url = body.get('url')
            if not task_id:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'task_id is required'})
                }
            if not url:
                return {
                    'statusCode': 400,
                    'headers': {'Access-Control-Allow-Origin': '*'},
                    'body': json.dumps({'error': 'url is required'})
                }
            
            microdata_url = "https://api.dataforseo.com/v3/on_page/microdata"
            payload = [{
                "id": task_id,
                "url": url
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

        elif action == 'pull_content':
            target_url = body.get('url')
            if not target_url:
                return {'statusCode': 400, 'headers': {'Access-Control-Allow-Origin': '*'}, 'body': json.dumps({'error': 'URL is required'})}

            parsing_url = "https://api.dataforseo.com/v3/on_page/content_parsing/live"
            payload = [{"url": target_url, "enable_javascript": True, "enable_browser_rendering": True}]
            
            print(f"Pulling content for: {target_url}")
            response = requests.post(parsing_url, headers=headers, json=payload)
            res_json = response.json()
            
            # Reconstruct HTML from content parsing
            html_content = ""
            page_title = ""
            first_h1 = ""
            
            try:
                for task in res_json.get('tasks', []):
                    for result in task.get('result', []):
                        for item in result.get('items', []):
                            if item.get('type') == 'content_parsing_element':
                                page_content = item.get('page_content', {})
                                
                                # Process title if available
                                if not page_title:
                                    page_title = item.get('meta', {}).get('title', '')

                                def process_topic(topic):
                                    nonlocal first_h1
                                    topic_html = ""
                                    level = topic.get('level', 2)
                                    # Fallback if level is weird
                                    if not isinstance(level, int) or level < 1 or level > 6:
                                        level = 2
                                    
                                    h_tag = f"h{level}"
                                    title = topic.get('h_title', '')
                                    if title:
                                        topic_html += f"<{h_tag}>{title}</{h_tag}>\n"
                                        if level == 1 and not first_h1:
                                            first_h1 = title
                                    
                                    for content_key in ['primary_content', 'secondary_content']:
                                        content_list = topic.get(content_key, [])
                                        if content_list:
                                            for content_item in content_list:
                                                text = content_item.get('text', '')
                                                if text:
                                                    topic_html += f"<p>{text}</p>\n"
                                    
                                    return topic_html

                                # Process main topics
                                main_topics = page_content.get('main_topic', [])
                                if main_topics:
                                    for topic in main_topics:
                                        html_content += process_topic(topic)
                                
                                # Process secondary topics
                                secondary_topics = page_content.get('secondary_topic', [])
                                if secondary_topics:
                                    for topic in secondary_topics:
                                        html_content += process_topic(topic)
            except Exception as e:
                print(f"Error parsing content: {str(e)}")
            
            return {
                'statusCode': 200,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({
                    'html': html_content,
                    'title': page_title,
                    'raw_response': res_json # for debugging
                })
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
