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
        
        api_key = os.environ.get('OPENAI_API_KEY')

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # Determine the image source for the prompt
        image_source = image_url if image_url else f"data:image/jpeg;base64,{image_data}" if image_data else None
        
        if not image_source:
             return {
                'statusCode': 400,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': 'No image source provided (URL or base64)'})
            }

        # Build the system and user messages
        system_msg = "You are an expert in accessibility, SEO, and visual content analysis."
        
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

        # Vision API request structure
        payload = {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system_msg},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt_text},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_source
                            }
                        }
                    ]
                }
            ],
            "max_tokens": 100,
            "temperature": 0.5
        }

        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )

        resp_json = response.json()
        
        if 'error' in resp_json:
            return {
                'statusCode': response.status_code,
                'headers': {'Access-Control-Allow-Origin': '*'},
                'body': json.dumps({'error': resp_json['error'].get('message', 'OpenAI API error')})
            }

        alt_text = resp_json['choices'][0]['message']['content'].strip()
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
