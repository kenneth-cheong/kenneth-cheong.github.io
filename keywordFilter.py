import json
import requests
import os

def lambda_handler(event, context):
    keywords = event.get('keywords', [])
    gpt_key = os.environ.get('GPT_KEY')
    gpt_url = "https://api.openai.com/v1/chat/completions"

    if not keywords:
        return {
            'statusCode': 200,
            'body': json.dumps([])
        }

    prompt = f"""You are an SEO expert. I will provide a list of keywords/phrases extracted from search results or competitor pages. 
Your task is to filter out "non-relevant" or "generic" keywords that don't carry specific SEO value or topical relevance.

EXAMPLES TO REMOVE:
- Generic calls to action: "view all", "click here", "read more", "sign up"
- Common filler phrases: "increase in", "for your", "this is", "how to use"
- Generic geographic locations: "united states", "new york", "london", "singapore" (unless specifically related to local SEO intent)
- Navigation items: "home", "contact us", "privacy policy", "login"
- Numbers or single generic letters/symbols
- Very common verbs/prepositions without context

KEEP:
- Topic-specific nouns and phrases
- Branded terms
- High-intent search terms
- Industry-specific jargon

Keywords to filter:
{json.dumps(keywords)}

Output ONLY a JSON array of the cleaned keywords. No other text.
"""

    headers = {
        "Content-Type": "application/json",
        "Authorization": gpt_key
    }

    payload = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": "You are a helpful SEO assistant."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0
    }

    try:
        response = requests.post(gpt_url, headers=headers, json=payload)
        response_status = response.status_code
        response_data = response.json()
        
        if response_status == 200:
            cleaned_keywords_text = response_data['choices'][0]['message']['content']
            # Attempt to parse the JSON array
            try:
                # Basic cleaning in case of markdown fences
                cleaned_text = cleaned_keywords_text.replace("```json", "").replace("```", "").strip()
                cleaned_keywords = json.loads(cleaned_text)
                return {
                    'statusCode': 200,
                    'body': json.dumps(cleaned_keywords)
                }
            except:
                return {
                    'statusCode': 500,
                    'body': json.dumps({'error': f"Failed to parse AI response: {cleaned_keywords_text}"})
                }
        else:
            return {
                'statusCode': response_status,
                'body': json.dumps({'error': f"OpenAI API Error: {response_data.get('error', {}).get('message', 'Unknown error')}"})
            }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
