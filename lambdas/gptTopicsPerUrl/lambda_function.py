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
_LLM_FN = 'gptTopicsPerUrl'


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
from bs4 import BeautifulSoup

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
HAIKU_MODEL = "claude-haiku-4-5-20251001"

def call_claude(prompt, api_key, max_tokens=1024):
    resp = requests.post(
        ANTHROPIC_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        },
        json={
            "model": HAIKU_MODEL,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]
        },
        timeout=120
    )
    data = resp.json()
    if "content" not in data:
        raise ValueError(f"Anthropic error: {data}")
    return data["content"][0]["text"]

def lambda_handler(event, context):
    target = event['url']
    if 'https://' not in target and 'http://' not in target:
        target = 'https://' + target
    keyword = event['keyword']
    api_key = os.environ['ANTHROPIC_API_KEY']
    output = {target: {}}

    try:
        dfs_response = requests.post(
            "https://api.dataforseo.com/v3/on_page/content_parsing/live",
            headers={
                'Authorization': ('Basic ' + os.environ.get('DATAFORSEO_AUTH', '')),
                'Content-Type': 'application/json'
            },
            json=[{"url": target, "enable_javascript": True, "enable_browser_rendering": True}]
        , timeout=175)
        print(dfs_response.json())

        extracted_data = extract_page_text(dfs_response.json())
        print(extracted_data)

        word_count = 0
        for level, lines in extracted_data['headings'].items():
            output[target]['h' + str(level)] = lines
            for line in lines:
                word_count += len(line.split())
        output[target]['word_count'] = word_count + len(extracted_data['other_text'].split())

        prompt = (
            "You are an expert SEO analyst. Analyze the following headings and text from a webpage.\n\n"
            "1. Extract 5-15 distinct content topics with estimated word counts. Exclude company/product names.\n"
            "2. Classify page type: blog article, e-commerce, news, forum, database directory, landing page, product/service page, or social media page.\n"
            "3. Briefly evaluate CTAs.\n\n"
            "Output ONLY a JSON object in this exact format: "
            "{\"page_type\": \"<type>\", \"topics\": {\"<topic>\": <word_count>}}\n\n"
            f"Targeted keyword: {keyword}\nPage text:\n{json.dumps(output)}"
        )

        raw = call_claude(prompt, api_key)
        raw_clean = raw.replace("```json", "").replace("```python", "").replace("```", "").strip()
        gpt_output = json.loads(raw_clean)
        output[target]['topics'] = gpt_output.get('topics', {})
        output[target]['page_type'] = gpt_output.get('page_type', '')
        return {'statusCode': 200, 'body': output}

    except Exception as e:
        print(e)
        output[target]['topics'] = {}
        output[target]['page_type'] = ''
        return {'statusCode': 200, 'body': output}


def extract_page_text(json_response):
    try:
        headings = {level: [] for level in range(1, 7)}
        other_text = []
        for task in json_response['tasks']:
            for result in task['result']:
                for item in result['items']:
                    if item['type'] == 'content_parsing_element':
                        for section_key in ('main_topic', 'secondary_topic'):
                            for topic in (item['page_content'].get(section_key) or []):
                                headings[topic['level']].append(topic['h_title'].replace('\n', ' '))
                                for c in (topic.get('primary_content') or []):
                                    other_text.append(c['text'].replace('\n', ' '))
                                for c in (topic.get('secondary_content') or []):
                                    other_text.append(c['text'].replace('\n', ' '))
                        for section_key in ('header', 'footer'):
                            section = item['page_content'].get(section_key) or {}
                            for sub in ('primary_content', 'secondary_content'):
                                for c in (section.get(sub) or []):
                                    other_text.append(c.get('text', ''))
        return {'headings': headings, 'other_text': ' '.join(other_text)}
    except (KeyError, TypeError, IndexError) as e:
        print(f"extract_page_text error: {e}")
        return {'headings': {i: [] for i in range(1, 7)}, 'other_text': ''}
