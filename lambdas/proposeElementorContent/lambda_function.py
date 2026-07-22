import json
import requests

# ── LLM usage metering (CloudWatch EMF) — Digimetrics/LLM ─────────────────────
# Meters every Claude/DeepSeek/OpenAI call by transparently wrapping
# requests.post ONCE — all call sites report RAW token buckets (input, output,
# cache read/write, web-search requests) into Digimetrics/LLM (dims Provider,
# Provider+Model). Cost is derived at READ time from one central table, so no
# rates live here (nothing to go stale). Mirrors saas/backend/src/lib/
# llm-metric.mjs. Logs only; safe by construction — the real call runs first and
# is returned regardless of metering.
import json as _mllm_json
import time as _mllm_time
_LLM_FN = 'proposeElementorContent'


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


_LLM_HOSTS = ('api.anthropic.com', 'api.deepseek.com', 'api.openai.com')
try:
    _orig_requests_post = requests.post

    def _metered_requests_post(*a, **kw):
        resp = _orig_requests_post(*a, **kw)
        try:
            url = a[0] if a else kw.get('url', '')
            if isinstance(url, str) and any(h in url for h in _LLM_HOSTS) and not kw.get('stream'):
                try:
                    _body = resp.json()
                except Exception:
                    _body = None
                if isinstance(_body, dict):
                    _prov, _model, _b = _llm_buckets(_body, url)
                    if any(_b.values()):
                        _emit_llm_metric(_prov, _model, _b)
        except Exception:
            pass
        return resp

    requests.post = _metered_requests_post
except Exception:
    pass
# ── end LLM usage metering ────────────────────────────────────────────────────

import os
import time
import re
import ast

def lambda_handler(event, context):

    gpt_key = os.environ['GPT_KEY']

    # Access 'strings' directly as it's already a list
    strings = event['strings']

    num_strings = len(strings)

    print(num_strings)

    company_name = event['company_name']

    additional_instructions = event['instructions']

    input_messages = [
        {
            "role": "system",
            "content":
            f'''
            You are an SEO-trained website developer replacing the webpage template visible text to suit the use case of the client. 
            Step 1: Find out what you can about {company_name} from the internet.
            Step 2: Change the list of strings into the recommended text for the webpage. 

            Here are the additional instructions: {additional_instructions}.

            You MUST return a Python list containing EXACTLY {num_strings} strings. The number of strings in the output list MUST match the number of strings in the input list.
            If no changes are required for a specific string, return the same string in the output list.
            Don't add any additional labelling like numbers.
            Preserve any <br> tags.
            Use British spelling unless otherwise instructed.
            '''
        },
        {"role": "user", "content": str(strings)}
    ]


    # DeepSeek if requested (OpenAI-compatible), else OpenAI/GPT (default → switch-back).
    provider = (event.get('provider') or '').lower()
    if provider == 'deepseek':
        data = {"model": "deepseek-chat", "messages": input_messages}
        url = "https://api.deepseek.com/chat/completions"
        headers = {
            "Authorization": f"Bearer {os.environ.get('DEEPSEEK_API_KEY', '')}",
            "Content-Type": "application/json"
        }
    else:
        data = {"model": "gpt-4o-mini", "messages": input_messages}
        url = "https://api.openai.com/v1/chat/completions"
        headers = {
            "Authorization": gpt_key,
            "Content-Type": "application/json"
        }

    response = requests.post(url, headers=headers, json=data, timeout=175)
    print(response.json())

    try: # added try except block for error handling
        output = response.json()['choices'][0]['message']['content'] #New API retrieval path

        #output = response.json()['output'][0]['content'][0]['text'].replace('\n','').replace('```','').replace('python','') # old

        print(output)
        cleaned_output = output.replace('\n', '').replace('```', '').replace('python', '')  # Clean output

        print(len(ast.literal_eval(cleaned_output)))

        return ast.literal_eval(cleaned_output) # convert to python output

    except (KeyError, ValueError) as e:
        print(f"Error processing response: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e), 'full_response': response.json()})
        }