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
_LLM_FN = 'contentPillar'
_LLM_SOURCE = 'unknown'
_LLM_TOOL = ''


def _set_llm_source(event):
    """Tag this invocation with the front-end that triggered it (saas | index).
    Read from the request body's `_source` (a body field, NOT a header — a custom
    header would force a CORS preflight on every agency Lambda). Lambda handles
    one event at a time per container, so a module global is safe here."""
    global _LLM_SOURCE, _LLM_TOOL
    src = ''
    tool = ''
    try:
        if isinstance(event, dict):
            body = event.get('body')
            if isinstance(body, str):
                try:
                    body = _mllm_json.loads(body or '{}')
                except Exception:
                    body = {}
            if not isinstance(body, dict):
                body = {}
            src = body.get('_source') or event.get('_source') or ''
            tool = body.get('_tool') or event.get('_tool') or ''
        src = str(src).strip().lower()
        tool = str(tool).strip()[:64]
    except Exception:
        src = ''
        tool = ''
    # Anything unrecognised stays 'unknown' so unattributed spend stays visible.
    _LLM_SOURCE = src if src in ('saas', 'index') else 'unknown'
    _LLM_TOOL = tool


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
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model'], ['Source'], ['Source', 'Provider']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'Source': _LLM_SOURCE, 'fn': fn or _LLM_FN, 'tool': _LLM_TOOL, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
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

def _llm_complete(provider, system_prompt, input_text, max_tokens=4096):
    """Returns (status_code, text_or_error).
    provider 'deepseek' -> DeepSeek (OpenAI-compatible); anything else -> Anthropic Claude (default).
    Default preserves the original Claude behaviour, so the client can switch back to Claude at will."""
    if (provider or '').lower() == 'deepseek':
        key = os.environ.get('DEEPSEEK_API_KEY')
        if not key:
            return 500, 'Missing DEEPSEEK_API_KEY env var.'
        r = requests.post(
            'https://api.deepseek.com/chat/completions',
            headers={'Authorization': f'Bearer {key}', 'content-type': 'application/json'},
            json={
                'model': 'deepseek-chat',
                'max_tokens': max_tokens,
                'messages': [
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': input_text},
                ],
            },
            timeout=120,
        )
        if r.status_code != 200:
            return r.status_code, f"API Error: {r.text}"
        d = r.json()
        return 200, (d['choices'][0]['message']['content'] if d.get('choices') else '')

    # default: Anthropic Claude
    key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not key:
        return 500, 'Missing ANTHROPIC_API_KEY env var.'
    r = requests.post(
        'https://api.anthropic.com/v1/messages',
        headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
        json={
            'model': 'claude-haiku-4-5-20251001',
            'max_tokens': max_tokens,
            'system': system_prompt,
            'messages': [{'role': 'user', 'content': input_text}],
        },
        timeout=60,
    )
    if r.status_code != 200:
        return r.status_code, f"API Error: {r.text}"
    d = r.json()
    return 200, (d['content'][0]['text'] if d.get('content') else '')


def lambda_handler(event, context):
    # 1. Parse Input Robustly
    body = event.get('body', {})
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            body = {}

    if not body:
        body = event if isinstance(event, dict) else {}

    business_model         = body.get('business_model', 'B2B')
    objectives             = body.get('objectives', [])
    audience_type          = body.get('audience_type', "")
    decision_complexity    = body.get('decision_complexity', 'Medium')
    platforms              = body.get('platforms', [])
    risk_sensitivity       = body.get('risk_sensitivity', 'Medium')
    promotional_tolerance  = body.get('promotional_tolerance', 'Medium')
    reference_urls         = body.get('reference_urls', {})
    additional_info        = body.get('additional_info', '')

    platforms_str = ', '.join(platforms)

    # 2. Construct Strategist Persona (System Prompt)
    system_prompt = f"""
You are a senior social media and content strategist with over 15 years of experience designing commercially accountable, performance-led content systems for B2B and B2C brands.
Your role is to design a non-negotiable content pillar framework that functions as a fixed operating system for a marketing team — not a list of ideas.

BRAND SPECIFICITY & GROUNDING:
- The output MUST mention the brand name and specific products or services where discoverable from the context provided.
- Each pillar and topic must be clearly linked to a real product, service, or customer challenge relevant to this specific company.
- Use actual values (names, features, benefits) based on the context. Do NOT use generic marketing fluff.

NEGATIVE CONSTRAINTS:
- STRICTLY FORBIDDEN: Do not use placeholders like [Brand Name], [Industry], [Product], [Product 1], [Service Name], etc.
- NEVER use square brackets [...] to indicate missing information.
- If a specific product name cannot be found, infer it from the context or describe it accurately without placeholders.

PLATFORM ENFORCEMENT:
- STRICTLY LIMIT all platform-related recommendations and the Platform Role Matrix to ONLY these active platforms: {platforms_str}.
- Do NOT mention or include any platforms NOT in that list.

Design Constraints:
- Limit the framework to 3–5 pillars maximum.
- Assign a percentage weighting to each pillar.
- Explicitly state what each pillar is responsible for achieving.
- Define guardrails that prevent overproduction of low-impact or vanity-driven content.
- Prioritise in this order: Revenue impact > Trust and authority building > Decision-stage enablement.
""".strip()

    # 3. Construct Specific Input
    input_text = f"""
COMMERCIAL CONTEXT:
- Business Model: {business_model}
- Primary Business Objectives: {', '.join(objectives)}
- Primary Audience Type: {audience_type}
- Decision Complexity: {decision_complexity}
- Brand Risk Sensitivity: {risk_sensitivity}
- Promotional Tolerance: {promotional_tolerance}
- Active Platforms: {platforms_str}

ADDITIONAL INPUT/CONTEXT:
{additional_info}

REFERENCES:
- Website: {reference_urls.get('website', 'N/A')}
- Brand Guide: {reference_urls.get('brandGuide', 'N/A')}
- Competitors: {reference_urls.get('competitors', 'N/A')}

Generate a defensible, strategy-led content pillar framework.
Return the response as nicely formatted HTML code (do not include ```html blocks, just the raw HTML).

Provide TWO distinct parts:
1. <h3>1. Strategic Content Pillar Framework</h3>
A <table> with the following structure:
- Column Headers (<thead>): The first cell is empty, subsequent cells are the names of the Content Pillars in ALL CAPS (e.g., PROJECTS SHOWCASE).
- Row 1: The first cell is <strong>Objective</strong>, subsequent cells are the strategic objective for that pillar. THESE MUST MENTION THE BRAND NAME AND SPECIFIC PRODUCTS.
- Row 2: The first cell is <strong>Main Topics</strong>, subsequent cells are a <ul> list of specific topics or content types for that pillar. THESE MUST BE RELATED TO SPECIFIC FEATURES OR USE CASES OF THE BRAND'S PRODUCTS. Use actual values based on the context rather than placeholders.

2. <h3>2. Platform Role Matrix</h3>
A <table> mapping each pillar to ONLY the active platforms stated: {platforms_str}. Use 'High', 'Medium', 'Low', or 'N/A' to indicate relative priority. Ensure NO other platforms are present.

Include a final section <h3>Execution Guardrails</h3> using an <ul> with <li> items.

FORMATTING: inside table cells, only the row-label cells (the first cell of each
row, e.g. Objective / Main Topics / the pillar name) may use <strong>. Do NOT bold
the body copy in any other cell — no <strong>/<b> around objectives, topics or the
priority values. The report styles those columns itself.
""".strip()

    # 4. Call the LLM — DeepSeek if requested, else Anthropic Claude (default).
    provider = body.get('provider', 'anthropic')
    try:
        status, answer = _llm_complete(provider, system_prompt, input_text, max_tokens=4096)

        if status != 200:
            return {
                'statusCode': status,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'error': answer})
            }

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': {'answer': answer}
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }



# ── LLM source attribution ────────────────────────────────────────────────────
# Wrap the handler ONCE so every model call made during this invocation is tagged
# with the front-end that triggered it. Appended at module end because
# lambda_handler must already be defined. Pairs with the metering block above.
try:
    _llm_orig_handler = lambda_handler

    def lambda_handler(event, context=None):
        _set_llm_source(event)
        return _llm_orig_handler(event, context)
except NameError:
    pass
