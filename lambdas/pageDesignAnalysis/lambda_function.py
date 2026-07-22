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
_LLM_FN = 'pageDesignAnalysis'


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

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
HAIKU_MODEL = "claude-haiku-4-5-20251001"
DFS_AUTH = ('Basic ' + os.environ.get('DATAFORSEO_AUTH', ''))

CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'OPTIONS,POST'
}


def call_claude(prompt, api_key, max_tokens=2048):
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


def fetch_page_blocks_via_dataforseo(url):
    """Returns (blocks_text, has_table, has_media, has_list) from JS-rendered DataForSEO parse."""
    resp = requests.post(
        "https://api.dataforseo.com/v3/on_page/content_parsing/live",
        headers={'Authorization': DFS_AUTH, 'Content-Type': 'application/json'},
        json=[{"url": url, "enable_javascript": True, "enable_browser_rendering": True}]
    , timeout=175)
    data = resp.json()

    text_chunks = []
    flags = {"table": False, "media": False, "list": False, "alt": False}

    def walk_items(items):
        for c in items or []:
            ctype = (c.get('type') or '').lower()
            if 'table' in ctype:
                flags['table'] = True
            if ctype in ('media', 'image') or 'image' in ctype:
                flags['media'] = True
                if c.get('alt') or c.get('alt_text'):
                    flags['alt'] = True
            if 'list' in ctype:
                flags['list'] = True
            txt = c.get('text')
            if txt:
                text_chunks.append(txt.replace('\n', ' '))

    try:
        for task in data['tasks']:
            for result in task['result']:
                for item in result['items']:
                    if item.get('type') != 'content_parsing_element':
                        continue
                    pc = item['page_content']
                    for section_key in ('main_topic', 'secondary_topic'):
                        for topic in (pc.get(section_key) or []):
                            txt = topic.get('h_title')
                            if txt:
                                text_chunks.append("HEADING: " + txt.replace('\n', ' '))
                            walk_items(topic.get('primary_content'))
                            walk_items(topic.get('secondary_content'))
                    for section_key in ('header', 'footer'):
                        section = pc.get(section_key) or {}
                        walk_items(section.get('primary_content'))
                        walk_items(section.get('secondary_content'))
    except (KeyError, TypeError, IndexError) as e:
        print(f"DataForSEO parse error: {e}")

    return '\n'.join(text_chunks)[:10000], flags


def lambda_handler(event, context):
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        url = event['url']
        api_key = os.environ['ANTHROPIC_API_KEY']

        page_text, flags = fetch_page_blocks_via_dataforseo(url)

        prompt = f"""Act as an SEO and UX Audit Specialist analyzing a competitor page.
URL: {url}

Below is the JS-rendered content extracted from the page (headings, text blocks, and detected element types). Detected block flags: tables={flags['table']}, media/images={flags['media']}, lists={flags['list']}, alt_text={flags['alt']}.

Based on this content, identify whether each design element is present and how it is used.

Respond ONLY with a valid JSON object (no markdown, no commentary) with this exact shape:
{{
  "url": "{url}",
  "elements": {{
    "paragraphs": {{ "present": <bool>, "details": "<1 sentence>" }},
    "ordered_lists": {{ "present": <bool>, "details": "<1 sentence>" }},
    "unordered_lists": {{ "present": <bool>, "details": "<1 sentence>" }},
    "infographics": {{ "present": <bool>, "details": "<1 sentence>" }},
    "charts": {{ "present": <bool>, "details": "<1 sentence>" }},
    "tables": {{ "present": <bool>, "details": "<1 sentence>" }},
    "images": {{ "present": <bool>, "details": "<1 sentence>" }},
    "alt_text": {{ "present": <bool>, "details": "<1 sentence>" }}
  }},
  "summary": "<1-2 sentence summary of the page's design strategy for SEO>"
}}

Page content:
{page_text}"""

        raw = call_claude(prompt, api_key)
        cleaned = raw.strip()
        if "```" in cleaned:
            cleaned = re.sub(r'^```(?:json)?\n?', '', cleaned)
            cleaned = re.sub(r'\n?```$', '', cleaned, flags=re.MULTILINE).strip()

        try:
            parsed_data = json.loads(cleaned)
        except Exception as e:
            return {
                'statusCode': 200,
                'headers': CORS,
                'body': {'url': url, 'raw_error': f"JSON Parse Error: {str(e)}", 'raw_content': raw}
            }

        return {'statusCode': 200, 'headers': CORS, 'body': parsed_data}

    except Exception as e:
        return {'statusCode': 500, 'headers': CORS, 'body': json.dumps({'error': str(e)})}
