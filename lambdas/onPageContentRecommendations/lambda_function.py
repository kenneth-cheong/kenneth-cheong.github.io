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
_LLM_FN = 'onPageContentRecommendations'


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

DFS_AUTH = ('Basic ' + os.environ.get('DATAFORSEO_AUTH', ''))
CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

def call_claude(prompt, max_tokens=4096):
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    headers = {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
    }
    payload = {
        'model': CLAUDE_MODEL,
        'max_tokens': max_tokens,
        'messages': [{'role': 'user', 'content': prompt}]
    }
    response = requests.post(CLAUDE_URL, headers=headers, json=payload, timeout=175)
    response_data = response.json()
    print(response_data)
    return response_data['content'][0]['text']

def fetch_page_content(url):
    """Fetch structured page content via DataForSEO content_parsing/live."""
    parsing_url = 'https://api.dataforseo.com/v3/on_page/content_parsing/live'
    headers = {
        'Authorization': DFS_AUTH,
        'Content-Type': 'application/json'
    }
    payload = [{'url': url, 'enable_javascript': True, 'enable_browser_rendering': True}]
    response = requests.post(parsing_url, headers=headers, json=payload, timeout=60)
    res_json = response.json()

    html_content = ''
    try:
        for task in res_json.get('tasks', []):
            for result in task.get('result', []):
                for item in result.get('items', []):
                    if item.get('type') == 'content_parsing_element':
                        page_content = item.get('page_content', {})

                        def process_topic(topic):
                            topic_html = ''
                            level = topic.get('level', 2)
                            if not isinstance(level, int) or level < 1 or level > 6:
                                level = 2
                            h_tag = f'h{level}'
                            title = topic.get('h_title', '')
                            if title:
                                topic_html += f'<{h_tag}>{title}</{h_tag}>\n'
                            for content_key in ['primary_content', 'secondary_content']:
                                for content_item in (topic.get(content_key) or []):
                                    text = content_item.get('text', '')
                                    if text:
                                        topic_html += f'<p>{text}</p>\n'
                            return topic_html

                        for topic in (page_content.get('main_topic') or []):
                            html_content += process_topic(topic)
                        for topic in (page_content.get('secondary_topic') or []):
                            html_content += process_topic(topic)
    except Exception as e:
        print(f'Error parsing content: {e}')

    return html_content

def extract_json(text):
    match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text)
    if match:
        return match.group(1).strip()
    return text.strip()

def lambda_handler(event, context):
    url = event.get('url')
    keywords = event.get('keywords')

    if not url:
        return {'error': "Missing 'url' in event"}
    if not keywords:
        return {'error': "Missing 'keywords' in event"}

    try:
        keywords_string = ','.join(keywords)
    except TypeError:
        return {'error': "Invalid 'keywords' format. Must be a list of strings."}

    if '*' in url:
        prompt = (
            f'Make recommendations for a new page to be created to rank on Google for the keyword(s) "{keywords_string}". '
            f'Here is the newly proposed page url: {url}. '
            'Include the page type (e.g. blog, landing page, etc.), content types (e.g. carousel, infographic, video, etc.), '
            'image alt text, backlinks strategy, and body copy suggestions. '
            'Do NOT include recommendations for meta title, meta description, canonical URL, or headings as these are covered separately. '
            'Do not give generic recommendations but very specific ones. '
            'Output the recommendations in only html table formatting where the first column is the type, '
            'the second column is the suggested value and the third column is the rationale.'
        )
        content = call_claude(prompt, max_tokens=2048)
        return content.replace('```', '').replace('html', '').replace('<h1>', 'h1: ').replace('</h1>', '').replace('<h2>', 'h2: ').replace('</h2>', '').replace('<h3>', 'h3: ').replace('</h3>', '')
    else:
        print(f'Fetching page content for: {url}')
        page_html = fetch_page_content(url)

        if page_html:
            prompt = (
                f'The target URL is {url}. Here is the page content:\n\n{page_html}\n\n'
                f'Based on this content, come up with a list of dictionaries with the following keys: '
                '"current_value", "suggested_value", and "rationale". '
                'Focus on keyword relevance, clarity, and user experience. Return no other additional text. '
                f'Make recommendations on how specific sentences or body copy sections can be optimised to rank on Google for the keyword(s) "{keywords_string}". '
                'Do NOT include recommendations for meta title, meta description, canonical URL, or headings (h1/h2/h3/h4) as these are covered in separate sections.'
            )
        else:
            # Fallback: ask Claude to reason about the URL without content
            prompt = (
                f'The target URL is {url}. '
                f'Based on the URL structure and the keyword(s) "{keywords_string}", come up with a list of dictionaries with the following keys: '
                '"current_value", "suggested_value", and "rationale". '
                'Focus on keyword relevance, clarity, and user experience. Return no other additional text. '
                'Make recommendations on how body copy sections can be optimised to rank on Google for the given keywords. '
                'Do NOT include recommendations for meta title, meta description, canonical URL, or headings (h1/h2/h3/h4) as these are covered in separate sections.'
            )

        content = call_claude(prompt, max_tokens=4096)
        print(content[7400:])

        json_string = extract_json(content)

        try:
            parsed_data = json.loads(json_string)
            if isinstance(parsed_data, dict):
                parsed_data = [parsed_data]
            return parsed_data
        except json.JSONDecodeError as e:
            print(f'JSONDecodeError: {e}')
            print(f'Problematic JSON String: {json_string}')
            try:
                cleaned = content.replace('```', '').replace('json', '').replace('\n', '')
                parsed_data = json.loads(cleaned)
                if isinstance(parsed_data, dict):
                    parsed_data = [parsed_data]
                return parsed_data
            except Exception as e2:
                print(f'Fallback parse failed: {e2}')
                return []
