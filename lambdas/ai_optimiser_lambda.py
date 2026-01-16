import json
import os
import requests

def lambda_handler(event, context):
    try:
        action = event.get('action', 'optimize')
        content = event.get('content', '')
        prompt_override = event.get('prompt', '')
        image_context = event.get('image_context', '')
        
        
        api_key = os.environ.get('OPENAI_API_KEY')
        if not api_key:
            return {'statusCode': 500, 'body': json.dumps({'error': 'API key not configured'})}

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        system_msg = "You are an expert SEO & content editor."
        user_msg = ""

        if action == "generate":
            user_msg = f"Generate SEO-optimized content based on this prompt: {prompt_override}"
        elif action == "rewrite":
            user_msg = f"Rewrite this content to be more engaging and SEO-friendly: {content}"
        elif action == "expand":
            user_msg = f"Expand this content with more details and supporting information: {content}"
        elif action == "shorten":
            user_msg = f"Shorten this content while maintaining key points: {content}"
        elif action == "simplify":
            user_msg = f"Simplify the language of this content for better readability: {content}"
        elif action == "continue":
            user_msg = f"Continue writing from where this leaves off: {content}"
        elif action == "alt_text":
            system_msg = "You are an accessibility and SEO specialist."
            user_msg = f"Generate a concise, descriptive alt text (max 125 chars) for an image in this context: {image_context}. Provide ONLY the alt text."
        else:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Invalid action'})}

        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg}
                ],
                "temperature": 0.7
            },
            timeout=25
        )

        resp_json = response.json()
        result_text = resp_json['choices'][0]['message']['content'] if 'choices' in resp_json else ""

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps({'result': result_text})
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
