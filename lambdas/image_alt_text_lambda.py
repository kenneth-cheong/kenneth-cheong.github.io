import json
import os
import requests

def lambda_handler(event, context):
    try:
            
        image_url = event.get('image_url', '')
        image_data = event.get('image_data', '') # For base64 data
        page_context = event.get('page_context', 'General content')
        image_placement = event.get('image_placement', 'Within content')
        primary_keyword = event.get('primary_keyword', '')
        secondary_keywords = event.get('secondary_keywords', '')
        
        api_key = os.environ.get('ANTHROPIC_API_KEY')

        if not image_url and not image_data:
            return {
                'statusCode': 400,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'No image source provided (URL or base64)'})
            }

        prompt_text = (
            f"Analyze the provided image and generate a concise, descriptive alt-text (max 125 chars).\n"
            f"Context: The image is placed {image_placement} in a document about: {page_context}.\n"
            f"Primary Target Keyword: {primary_keyword}\n"
            f"Secondary Keywords (if relevant): {secondary_keywords}\n\n"
            f"Instructions:\n"
            f"1. Describe what is visually present in the image accurately.\n"
            f"2. Integrate the PRIMARY TARGET KEYWORD naturally as a priority if it relates to the image.\n"
            f"3. Use Secondary Keywords only if they fit perfectly and don't dilute the primary targeting.\n"
            f"4. Do not start with 'Image of' or 'Picture of'.\n"
            f"5. Provide ONLY the final alt-text string."
        )

        # Build image block in Claude's format
        if image_url:
            image_block = {"type": "image", "source": {"type": "url", "url": image_url}}
        else:
            image_block = {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_data}}

        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 150,
                "system": "You are an expert in accessibility, SEO, and visual content analysis.",
                "messages": [{"role": "user", "content": [image_block, {"type": "text", "text": prompt_text}]}]
            },
            timeout=30
        )

        resp_json = response.json()

        if 'error' in resp_json:
            return {
                'statusCode': response.status_code,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': resp_json['error'].get('message', 'Anthropic API error')})
            }

        alt_text = resp_json['content'][0]['text'].strip()
        # Clean up any quotes if the model provided them
        alt_text = alt_text.replace('"', '').replace("'", "")

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps({'result': alt_text})
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*'},
            'body': json.dumps({'error': str(e)})
        }
