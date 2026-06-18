import json
import requests
import os

def lambda_handler(event, context):
    location = event['location']
    language = event['language']
    target = event['target']
    keyword = event['keyword']

    prompt = "You are an digital marketing expert doing up a SEO keyword proposal. Output ONLY a short reason (up to 25 words, straight to the point, no need to mention the keyword) why this keyword should be selected. The keyword is '" + keyword + "', the targeted location is '" + location + "', the language is '" + language + "' and the target website is '" + target

    # DeepSeek if requested (OpenAI-compatible), else OpenAI/GPT (default → switch-back).
    provider = (event.get('provider') or '').lower()
    if provider == 'deepseek':
        url = "https://api.deepseek.com/chat/completions"
        model_id = "deepseek-chat"
        auth = f"Bearer {os.environ.get('DEEPSEEK_API_KEY', '')}"
    else:
        url = "https://api.openai.com/v1/chat/completions"
        model_id = "gpt-4o-mini"
        auth = os.environ['GPT_KEY']

    querystring = {"model": model_id, "messages": [{"role": "user", "content": prompt}]}
    headers = {
        "Content-Type": "application/json",
        'Authorization': auth
        }

    response = requests.post(url, headers=headers, json=querystring)

    return {
        'statusCode': 200,
        'body': response.json()['choices'][0]['message']['content']
    }
