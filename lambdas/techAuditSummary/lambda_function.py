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
_LLM_FN = 'techAuditSummary'


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

def lambda_handler(event, context):
    crawl = event.get('crawl', {})
    gtmetrix = event.get('gtmetrix', {})
    webpage_audit = event.get('webpage_audit', {})

    # 2. Construct Strategist Persona and Prompt
    instructions = (
        "You are a Senior Technical SEO Auditor. Your goal is to synthesize data into a clear technical report. "
        "\n\nFORMATTING RULES:\n"
        "1. Output exactly THREE HTML tables using a flexbox container: "
        "<div style='display: flex; gap: 20px; flex-wrap: wrap; margin-top: 20px;'>\n"
        "2. Each table MUST have class='summary-table'.\n"
        "3. ASSESSMENT COLORS: Use <span> tags with font-weight: bold; and color: #2e7d32 (Good), #ed6c02 (Moderate), or #d32f2f (Bad).\n"
        "4. ASSESSMENT LOGIC:\n"
        "   - 'Googlebot blocked': Specifically check if 'User-agent: Googlebot' is followed by 'Disallow: /' in robots_txt. If BOTH exist in that order, output 'Yes' (color: #d32f2f;). Otherwise, output 'No' (color: #2e7d32;).\n"
        "   - 'Google-safe site': If 'None Detected', 'Yes', or 'Clean' (case-insensitive) is found, output 'Good'. Otherwise assessment is 'Bad'.\n"
        "5. Table 1 (Site Overview & Security): Metric and Assessment. "
        "Include: CLS, LCP, TBT, PageSpeed, Googlebot blocked, Google-safe site, Sitemap.\n"
        "6. Table 2 (On-Page & Accessibility): Metric and Status/Count. "
        "Include: Duplicate Titles, Duplicate Descriptions, Missing H1 Tags, Missing Image Alt Text, Broken Links (4xx).\n"
        "7. Table 3 (Structure & Visibility): Metric and Assessment. "
        "Include: Schema Markup (Micromarkup), OG/Social Tags, SEO Friendly URLs, Mobile Friendly layout.\n"
        "8. STRICT COUNTS: Use the 'total_pages' provided to express counts as '0 out of {total_pages}'. DO NOT use 'X'.\n"
        "9. Output ONLY the raw HTML div and tables. No markdown formatting."
    )

    total_pages = event.get('total_pages', '10') # Default to 10 if missing

    prompt = (
        f"Analyze this data and provide 3 summary tables.\n\n"
        f"GTmetrix Performance: {json.dumps(gtmetrix)}\n\n"
        f"Webpage Audit Security: {json.dumps(webpage_audit)}\n\n"
        f"Website Crawl Data: {json.dumps(crawl)}\n\n"
        f"Total Pages Crawled: {total_pages}\n\n"
        f"CRITICAL: For every metric in Table 2 and Table 3 that requires a count, you MUST use the format 'N out of {total_pages}' where '{total_pages}' is exactly the value provided above. Do NOT use 0 unless there are truly 0 issues. If you see data in the 'Website Crawl Data', use it to calculate N."
    )

    # 3. Call OpenAI Responses API
    gpt_key = os.environ.get('GPT_KEY')
    url = "https://api.openai.com/v1/responses"
    headers = {
        "Authorization": 'Bearer ' + gpt_key,
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": "gpt-4o-mini",
        "instructions": instructions,
        "input": [
            {
                "role": "system",
                "content": instructions
            },
            {
                "role": "user",
                "content": prompt
            }
        ]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=295)
        response.raise_for_status()
        response_data = response.json()
        
        # Extract the content from the 'responses' endpoint structure
        # output is a list, usually the last item is the assistant response
        output_content = response_data['output'][-1]['content'][0]
        html_output = output_content.get('text', '')
        
        # Clean up any potential markdown headers if they slipped through
        html_output = html_output.replace('```html', '').replace('```', '')

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': html_output
        }

    except Exception as e:
        print(f"Error calling OpenAI API: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }