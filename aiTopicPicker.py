import json
import requests
import os

def lambda_handler(event, context):
    primary_keyword = event.get('primary_keyword', '')
    secondary_keywords = event.get('secondary_keywords', [])
    all_topics = event.get('all_topics', [])
    location = event.get('location', 'Singapore')
    
    gpt_key = os.environ.get('GPT_KEY')
    gpt_url = "https://api.openai.com/v1/responses"
    
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
    }

    if not gpt_key:
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': 'GPT_KEY not found'})}

    # Prepare logic for OpenAI responses endpoint
    prompt = f"""You are an SEO expert. I have a list of content topics extracted from the top SERP competitors for the primary keyword: "{primary_keyword}" in {location}.
Secondary keywords (lower priority): {", ".join(secondary_keywords)}

Here are all the topics found across competitors:
{json.dumps(all_topics)}

Your task:
1. Analyse these topics and cherry-pick the most important ones (around 15-25 topics).
2. Prioritize topics that:
   - Are highly relevant to the primary keyword.
   - Appear frequently across competitors (implied by the list).
   - Are essential for ranking well on Google for this specific intent.
3. Use the web_search tool to verify current SEO trends for this keyword to improve your selection.
4. Return ONLY a JSON list of the selected topic strings. No explanations.
Format: ["Topic 1", "Topic 2", ...]"""

    data = {
        "model": "gpt-4o-mini",
        "input": [
            {"role": "user", "content": prompt}
        ],
        "tools": [
            {"type": "web_search"}
        ]
    }
    
    api_headers = {
        "Content-Type": "application/json",
        "Authorization": gpt_key
    }

    try:
        response = requests.post(gpt_url, headers=api_headers, json=data)
        response.raise_for_status()
        response_data = response.json()
        print("Response Data:", response_data)
        
        # Correctly traverse the responses endpoint output
        content = ""
        for item in response_data.get('output', []):
            if item.get('type') == 'message' and item.get('role') == 'assistant':
                for content_item in item.get('content', []):
                    if content_item.get('type') == 'output_text':
                        content = content_item.get('text', '')
                        break
                if content: break

        if not content:
            # Fallback for different response structures
            for item in response_data.get('output', []):
                if item.get('type') in ['text', 'output_text']:
                    content = item.get('content', [{}])[0].get('text', '')
                    if content: break

        # Clean response
        content = content.strip()
        if "```json" in content:
            content = content.split("```json")[1].split("```")[0].strip()
        elif "```" in content:
            content = content.split("```")[1].split("```")[0].strip()
        
        # Remove any leading/trailing trash that might break json.loads
        start_idx = content.find('[')
        end_idx = content.rfind(']')
        if start_idx != -1 and end_idx != -1:
            content = content[start_idx:end_idx+1]
        
        selected_topics = json.loads(content)
        return {
            'statusCode': 200,
            'headers': headers,
            'body': {'selected_topics': selected_topics}
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': str(e)})
        }
