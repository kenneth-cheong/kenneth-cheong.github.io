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
_LLM_FN = 'onPageRecommendations'


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
import re

def call_claude(prompt, api_key, max_tokens=2048, system=None):
    import requests
    body = {"model": "claude-haiku-4-5-20251001", "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]}
    if system:
        body["system"] = system
    r = requests.post("https://api.anthropic.com/v1/messages",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json=body, timeout=120)
    data = r.json()
    if not data.get("content"):
        raise ValueError(f"Anthropic error: {data}")
    return data["content"][0]["text"]

def lambda_handler(event, context):
    data = event.get('data')
    kw = event.get('keywords')
    if data is None or not kw:
        return {"error": "data and keywords are required."}
    keywords = ','.join(kw) if isinstance(kw, (list, tuple)) else str(kw)

    prompt = 'Analyze the following website data for SEO optimization. Provide a JSON dictionary as output only (include ALL input values in the output).  Each key in the dictionary should correspond to the keys in the input data: "meta_title", "meta_description", "headings", "image_data", and "canonical_url". For "meta_title" and "meta_description", the dictionary value should be another dictionary with the following keys: "current_value", "suggested_value", and "rationale".  If no change is needed, "suggested_value" should be an empty string. For "headings", the dictionary value should be another dictionary. Within this, each heading tag (h1, h2, h3, h4) should be a key, and its value should be a list of dictionaries. Each dictionary in the list should contain: "current_value", "suggested_value", and "rationale". If no change is needed, "suggested_value" should be an empty string.  Each suggestion for headers should be individually assessed for keyword relevance and clarity. Headings should be concise and use relevant keywords, and they should flow logically. For "image_data", the dictionary value should be a list of dictionaries. Each dictionary in the list should contain the original image URL as the key, and a dictionary containing "current_value", "suggested_value", and "rationale" as the value. "current_value" refers to the current alt text. "suggested_value" refers to the suggested alt text. If no change is needed, "suggested_value" should be an empty string. Alt text should be descriptive and include relevant keywords where appropriate, focusing on what is visually present in the image. For "canonical_url", the dictionary value should be another dictionary with the following keys: "current_value", "suggested_value", and "rationale". If no change is needed, "suggested_value" should be an empty string. The goal is to improve the SEO performance of the website based on the provided data. Focus on keyword relevance, clarity, and user experience. Return ONLY VALID JSON. No other text. The keywords to target are "'+keywords+'"". Here is the input data:' + json.dumps(data)
    anthropic_key = os.environ.get('ANTHROPIC_API_KEY')

    try:
        content = call_claude(prompt, anthropic_key, max_tokens=8192)
        print(f"Raw response from Claude: {content}")  # Log the raw response

        # Extract JSON content - handle ```json ... ``` blocks
        json_string = extract_json(content)

        # Attempt to parse the extracted JSON
        try:
            parsed_data = json.loads(json_string)
            return parsed_data
        except json.JSONDecodeError as e:
            print(f"JSONDecodeError: {e}")
            print(f"Problematic JSON String: {json_string}")
            return {
                "error": "Failed to decode JSON from GPT response",
                "raw_response": content,
                "extracted_json": json_string,
                "exception": str(e)
            }


    except requests.exceptions.RequestException as e:
        print(f"RequestException: {e}")
        return {"error": "Failed to connect to GPT API", "exception": str(e)}
    except Exception as e:
        print(f"Unexpected error: {e}")
        return {"error": "An unexpected error occurred", "exception": str(e)}

def extract_json(text):
    """Extracts JSON string from the text, handling cases with ```json blocks.
    """
    # Match JSON within ```json ... ``` or just a bare JSON string
    match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if match:
        return match.group(1).strip()
    else:
        return text.strip()
