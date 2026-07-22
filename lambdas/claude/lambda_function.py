import json
import os
import base64
import boto3
import urllib3

# ── LLM usage metering (CloudWatch EMF) — Digimetrics/LLM ─────────────────────
# Meters every Claude/DeepSeek/OpenAI call at each LLM helper's
# response site (this Lambda uses urllib/urllib3, not requests) — all call sites report RAW token buckets (input, output,
# cache read/write, web-search requests) into Digimetrics/LLM (dims Provider,
# Provider+Model). Cost is derived at READ time from one central table, so no
# rates live here (nothing to go stale). Mirrors saas/backend/src/lib/
# llm-metric.mjs. Logs only; safe by construction — the real call runs first and
# is returned regardless of metering.
import json as _mllm_json
import time as _mllm_time
_LLM_FN = 'claude'


def _llm_provider(model, url=''):
    m = (model or '').lower()
    u = url or ''
    if 'deepseek' in m or 'deepseek' in u:
        return 'deepseek'
    if 'openai' in u or m.startswith('gpt') or m.startswith('o1') or m.startswith('o3'):
        return 'openai'
    if 'claude' in m or 'anthropic' in u:
        return 'claude'
    return 'other'


def _llm_buckets(body, url=''):
    """(provider, model, {in,out,cr,cw,ws}) from an Anthropic/OpenAI/DeepSeek body."""
    u = (body.get('usage') or {}) if isinstance(body, dict) else {}
    model = body.get('model') if isinstance(body, dict) else None
    prov = _llm_provider(model, url)
    if 'input_tokens' in u or 'output_tokens' in u:            # Anthropic shape
        stu = u.get('server_tool_use') or {}
        return prov, model, {'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
                             'cr': u.get('cache_read_input_tokens', 0),
                             'cw': u.get('cache_creation_input_tokens', 0),
                             'ws': stu.get('web_search_requests', 0)}
    out = u.get('completion_tokens', 0)                        # OpenAI / DeepSeek
    if 'prompt_cache_hit_tokens' in u or 'prompt_cache_miss_tokens' in u:   # DeepSeek
        cr = u.get('prompt_cache_hit_tokens', 0)
        inp = u.get('prompt_cache_miss_tokens', (u.get('prompt_tokens', 0) - cr))
    else:                                                      # OpenAI
        cr = (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)
        inp = u.get('prompt_tokens', 0) - cr
    return prov, model, {'in': max(0, inp), 'out': out, 'cr': cr, 'cw': 0, 'ws': 0}


def _emit_llm_metric(provider, model, b, fn=None):
    try:
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'fn': fn or _LLM_FN, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
    except Exception:
        pass


def _emit_llm_from_body(provider, body):
    try:
        if not isinstance(body, dict):
            return
        prov, model, b = _llm_buckets(body)
        if any(b.values()):
            _emit_llm_metric(provider or prov, model, b)
    except Exception:
        pass


# ── end LLM usage metering ────────────────────────────────────────────────────


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
    # Map the client's model choice to a current Anthropic model ID.
    # The Sonnet button sends 'claude-3-5-sonnet'; the Haiku button 'claude-3-haiku'.
    api_model = "claude-sonnet-4-6" if 'sonnet' in (model or '').lower() else "claude-haiku-4-5"

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
    if response.status == 200:
        _emit_llm_from_body('claude', result)
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
    if response.status == 200:
        _emit_llm_from_body('deepseek', result)
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
    if response.status == 200:
        _emit_llm_from_body('openai', result)
    if response.status != 200:
        return {"statusCode": response.status, "headers": headers, "body": json.dumps({"ai_response": f"OpenAI Error: {result}"})}

    return {"statusCode": 200, "headers": headers, "body": json.dumps({"ai_response": result['choices'][0]['message']['content']})}
