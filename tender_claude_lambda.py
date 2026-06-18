import json
import os
import base64
import boto3
import urllib3

# --- Configuration ---
# Deployed as the `claude` Lambda (TenderAI backend) behind
# https://2zsxqwth46.execute-api.ap-southeast-1.amazonaws.com/claude
# Called by tender.html and index.html's tender section with
# { action: 'analyze', model, prompt, max_tokens } → { ai_response }.
s3 = boto3.client('s3')
BUCKET_NAME = os.environ.get('TENDER_DOCS_BUCKET', 'tender-ai-documents-167633412846-ap-southeast-1-an')
CLAUDE_API_KEY = os.environ.get('CLAUDE_API_KEY')
OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY')

def lambda_handler(event, context):
    """Main entry point for TenderAI Backend."""
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,X-Api-Key",
        "Content-Type": "application/json"
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {"statusCode": 200, "headers": headers, "body": ""}

    try:
        body = json.loads(event.get('body', '{}'))
        action = body.get('action')

        if action == 'upload':
            return handle_upload(body, headers)
        elif action == 'analyze':
            return handle_analysis(body, headers)

        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": f"Unsupported action: {action}"})}
    except Exception as e:
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": "Server Error", "details": str(e)})}

def handle_upload(body, headers):
    """Saves a base64 encoded file to S3."""
    file_name = body.get('fileName')
    file_content = body.get('fileContent')

    if not file_name or not file_content:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "Missing fileName or fileContent"})}

    try:
        decoded_file = base64.b64decode(file_content)
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=f"uploads/{file_name}",
            Body=decoded_file,
            ContentType=body.get('contentType', 'application/pdf')
        )
        return {"statusCode": 200, "headers": headers, "body": json.dumps({"message": "Upload successful", "fileName": file_name})}
    except Exception as e:
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"error": "S3 Upload Failed", "details": str(e)})}

def handle_analysis(body, headers):
    """Routes analysis requests based on the requested model."""
    model = body.get('model', 'claude-sonnet-4-6')
    prompt = body.get('prompt')
    max_tokens = body.get('max_tokens', 4096)

    if not prompt:
        return {"statusCode": 400, "headers": headers, "body": json.dumps({"error": "No prompt provided"})}

    model_l = model.lower()
    if 'deepseek' in model_l:
        return call_deepseek(model, prompt, max_tokens, headers)
    elif 'gpt' in model_l:
        return call_openai(model, prompt, max_tokens, headers)
    else:
        return call_claude(model, prompt, max_tokens, headers)

def call_claude(model, prompt, max_tokens, headers):
    # FALLBACK TEST: Using Haiku for both to verify connection
    api_model = "claude-haiku-4-5"

    # If Haiku works, we can then try these Sonnet IDs one by one:
    # 1. "claude-3-5-sonnet-20240620"
    # 2. "claude-3-sonnet-20240229" (The older Claude 3 Sonnet)

    http = urllib3.PoolManager()
    payload = {
        "model": api_model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }

    response = http.request(
        'POST', 'https://api.anthropic.com/v1/messages',
        headers={
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body=json.dumps(payload)
    )

    result = json.loads(response.data.decode('utf-8'))
    if response.status != 200:
        return {"statusCode": response.status, "headers": headers, "body": json.dumps({"ai_response": f"Claude Error: {result}"})}

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"ai_response": result['content'][0]['text']})}

def call_deepseek(model, prompt, max_tokens, headers):
    """Calls DeepSeek API (OpenAI-compatible chat completions)."""
    if not DEEPSEEK_API_KEY:
        return {"statusCode": 500, "headers": headers, "body": json.dumps({"ai_response": "DeepSeek Error: DEEPSEEK_API_KEY not configured"})}

    http = urllib3.PoolManager()
    payload = {
        "model": "deepseek-chat",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }

    response = http.request(
        'POST', 'https://api.deepseek.com/chat/completions',
        headers={
            'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
            'content-type': 'application/json'
        },
        body=json.dumps(payload)
    )

    result = json.loads(response.data.decode('utf-8'))
    if response.status != 200:
        return {"statusCode": response.status, "headers": headers, "body": json.dumps({"ai_response": f"DeepSeek Error: {result}"})}

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"ai_response": result['choices'][0]['message']['content']})}

def call_openai(model, prompt, max_tokens, headers):
    """Calls OpenAI API."""
    http = urllib3.PoolManager()
    payload = {
        "model": "gpt-4o-mini",
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}]
    }

    response = http.request(
        'POST', 'https://api.openai.com/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {OPENAI_API_KEY}',
            'content-type': 'application/json'
        },
        body=json.dumps(payload)
    )

    result = json.loads(response.data.decode('utf-8'))
    if response.status != 200:
        return {"statusCode": response.status, "headers": headers, "body": json.dumps({"ai_response": f"OpenAI Error: {result}"})}

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"ai_response": result['choices'][0]['message']['content']})}
