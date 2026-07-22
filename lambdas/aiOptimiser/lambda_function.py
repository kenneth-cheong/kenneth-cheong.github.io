import json
import os
import re
import time
import random
import requests
import boto3
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# ── Shared response helpers ───────────────────────────────────────────────────
# Every browser-facing return MUST carry CORS headers, INCLUDING errors — the
# API Gateway does not inject them, so a header-less error response is blocked by
# the browser and the caller sees an opaque "Failed to fetch" instead of the
# real {'error': …} message. Route all returns through _resp().
_CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
}

def _resp(status, payload, default=None):
    return {
        'statusCode': status,
        'headers':    _CORS,
        'body':       json.dumps(payload, default=default),
    }

def _safe_int(val, fallback=0):
    """int() that tolerates junk user input ('', 'abc', None) instead of
    raising ValueError → opaque 500."""
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return fallback

def _safe_float(val, fallback=None):
    try:
        return float(val)
    except (TypeError, ValueError):
        return fallback

# ── Shared Caption Learnings (DynamoDB) ───────────────────────────────────────
_CG_LEARNINGS_TABLE = 'cg_learnings'
_CG_WORKSPACE_ID    = 'digimetrics_cg'

def _cg_table():
    return boto3.resource('dynamodb', region_name='ap-southeast-1').Table(_CG_LEARNINGS_TABLE)

def _cg_json_default(o):
    # DynamoDB returns numbers as Decimal, which json.dumps can't serialise.
    from decimal import Decimal
    if isinstance(o, Decimal):
        return int(o) if o % 1 == 0 else float(o)
    raise TypeError(f'Object of type {type(o).__name__} is not JSON serializable')

def handle_author_profile(action, event):
    """Per-user Author Profile store (POV / E-E-A-T authorship), reusing the cg_learnings
    table. Keyed (workspace_id, id='author#<email>'). The profile is stored as a JSON
    string to sidestep DynamoDB's None/float restrictions on nested maps."""
    CORS = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST',
    }
    def _r(code, payload):
        return {'statusCode': code, 'headers': CORS, 'body': json.dumps(payload, default=_cg_json_default)}
    email = (event.get('userEmail') or event.get('user') or '').strip().lower()
    if not email:
        return _r(400, {'error': 'userEmail is required'})
    key_id = 'author#' + email
    try:
        table = _cg_table()
        if action == 'author_get':
            item = table.get_item(Key={'workspace_id': _CG_WORKSPACE_ID, 'id': key_id}).get('Item')
            if not item:
                return _r(200, {'profile': None})
            prof = item.get('profile')
            if isinstance(prof, str):
                try: prof = json.loads(prof)
                except Exception: prof = None
            return _r(200, {'profile': prof, 'updated_at': item.get('updated_at')})

        elif action == 'author_save':
            profile = event.get('profile')
            if not isinstance(profile, dict):
                return _r(400, {'error': 'profile object is required'})
            table.put_item(Item={
                'workspace_id': _CG_WORKSPACE_ID,
                'id':           key_id,
                'kind':         'author_profile',
                'profile':      json.dumps(profile),
                'updated_at':   int(time.time()),
                'updated_by':   email,
            })
            return _r(200, {'ok': True})

        elif action == 'author_delete':
            table.delete_item(Key={'workspace_id': _CG_WORKSPACE_ID, 'id': key_id})
            return _r(200, {'ok': True})
    except Exception as e:
        return _r(500, {'error': str(e)})


def handle_learnings(action, event):
    CORS = {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST',
    }
    try:
        table = _cg_table()
        if action == 'learnings_list':
            resp  = table.query(
                KeyConditionExpression=boto3.dynamodb.conditions.Key('workspace_id').eq(_CG_WORKSPACE_ID)
            )
            items = resp.get('Items', [])
            # Sort newest-first by id (timestamp-based)
            items.sort(key=lambda x: _safe_int(x.get('id', 0), 0), reverse=True)
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'items': items}, default=_cg_json_default)}

        elif action == 'learnings_upsert':
            entry = event.get('entry', {})
            if not entry or not entry.get('id') or not entry.get('text'):
                return {'statusCode': 400, 'headers': CORS, 'body': json.dumps({'error': 'Missing entry id or text'})}
            entry['workspace_id'] = _CG_WORKSPACE_ID
            entry['id']           = str(entry['id'])
            # DynamoDB rejects None values — strip them before writing
            item = {k: v for k, v in entry.items() if v is not None}
            table.put_item(Item=item)
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'ok': True})}

        elif action == 'learnings_delete':
            item_id = str(event.get('id', ''))
            if not item_id:
                return {'statusCode': 400, 'headers': CORS, 'body': json.dumps({'error': 'Missing id'})}
            table.delete_item(Key={'workspace_id': _CG_WORKSPACE_ID, 'id': item_id})
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'ok': True})}

    except Exception as e:
        return {'statusCode': 500, 'headers': CORS, 'body': json.dumps({'error': str(e)})}


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
_LLM_FN = 'aiOptimiser'
_LLM_SOURCE = 'unknown'


def _set_llm_source(event):
    """Tag this invocation with the front-end that triggered it (saas | index).
    Read from the request body's `_source` (a body field, NOT a header — a custom
    header would force a CORS preflight on every agency Lambda). Lambda handles
    one event at a time per container, so a module global is safe here."""
    global _LLM_SOURCE
    src = ''
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
        src = str(src).strip().lower()
    except Exception:
        src = ''
    # Anything unrecognised stays 'unknown' so unattributed spend stays visible.
    _LLM_SOURCE = src if src in ('saas', 'index') else 'unknown'


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
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model'], ['Source'], ['Source', 'Provider']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'Source': _LLM_SOURCE, 'fn': fn or _LLM_FN, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
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


# ==============================================================================
# Anthropic Messages API helper — backoff retries + circuit breaker
# ==============================================================================
# (connect, read) timeout. The read timeout is set well above the ~26.5s that
# was previously cutting long classification calls short and surfacing as 502s.
_ANTHROPIC_TIMEOUT = (10, 120)

# Invocation deadline (epoch secs), set at handler entry from the Lambda context.
# Upstream HTTP calls clamp their read timeout to this so a slow provider call
# can never outlive the invocation — without it, 120s-read × 3 retries (+backoff)
# exceeds the 180s function timeout and the client sees an opaque gateway
# timeout instead of a JSON error it can retry. Module-global is safe: a Lambda
# sandbox processes one event at a time.
_INVOKE_DEADLINE = None


def _secs_left():
    """Seconds until the invocation is killed (large sentinel outside Lambda)."""
    if not _INVOKE_DEADLINE:
        return 9999.0
    return _INVOKE_DEADLINE - time.time()


def _adaptive_timeout(base=_ANTHROPIC_TIMEOUT):
    """(connect, read) timeout with the read component clamped to finish ~8s
    before the invocation deadline, leaving room to serialise a real error
    response. Floors at 15s so a nearly-expired invocation still gets one
    honest (if brief) attempt rather than an instant failure."""
    read = max(15.0, min(float(base[1]), _secs_left() - 8.0))
    return (base[0], read)

# Circuit breaker. Lambda keeps module globals alive across warm invocations, so
# this state persists between calls: after a run of consecutive failures (e.g.
# the API is timing out) we "open" the breaker and fail fast for a short
# cool-down instead of making every caller sit through three slow timeouts and
# keep hammering an API that is already struggling.
_CB_FAIL_THRESHOLD = 4      # consecutive failures before the breaker opens
_CB_COOLDOWN_SECS  = 30     # how long to stay open before a trial request
_anthropic_circuit = {'fails': 0, 'opened_at': 0.0}


class AnthropicCircuitOpen(RuntimeError):
    """Raised when the Anthropic circuit breaker is open (cooling down)."""


def _anthropic_backoff(attempt):
    """Exponential backoff (1, 2, 4, 8s cap) with jitter so concurrent retries
    don't fire in lockstep and synchronise their next attempt."""
    base = min(2 ** attempt, 8)
    return base + random.uniform(0, 0.5 * base)


def _anthropic_request(api_key, request_body, max_retries=3,
                       max_continuations=4, timeout=_ANTHROPIC_TIMEOUT):
    """POST to the Anthropic Messages API with exponential-backoff retries on
    transient failures (timeouts, connection errors, 429/5xx/529), a circuit
    breaker that fails fast after repeated failures, and transparent
    continuation of the server-side tool loop when the model returns
    stop_reason == 'pause_turn' (e.g. while using web_fetch/web_search).
    Returns the final response JSON (dict). Raises on unrecoverable failure."""
    # Circuit breaker: while open and still cooling down, fail fast.
    if _anthropic_circuit['opened_at']:
        if (time.time() - _anthropic_circuit['opened_at']) < _CB_COOLDOWN_SECS:
            raise AnthropicCircuitOpen(
                "Anthropic API circuit breaker is open after repeated timeouts; "
                "cooling down — please retry in a few seconds."
            )
        # Cool-down elapsed → fall through and allow a single trial ("half-open")
        # request; success below resets the breaker, failure re-opens it.

    headers = {
        'x-api-key':         api_key,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
    }
    body          = dict(request_body)
    continuations = 0
    while True:
        resp_json = None
        last_err  = None
        for attempt in range(max_retries):
            # Don't start a retry the invocation can't survive — better to hand
            # the caller a retryable JSON error than die at the gateway.
            if attempt and _secs_left() < 30:
                last_err = f"{last_err} (skipped retry: invocation deadline)"
                break
            try:
                resp = requests.post(
                    'https://api.anthropic.com/v1/messages',
                    headers=headers, json=body, timeout=_adaptive_timeout(timeout),
                )
                if resp.status_code in (429, 500, 502, 503, 504, 529):
                    last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                    time.sleep(_anthropic_backoff(attempt))
                    continue
                resp_json = resp.json()
                break
            except requests.exceptions.RequestException as e:
                last_err = str(e)
                time.sleep(_anthropic_backoff(attempt))
        if resp_json is None:
            # Record the failure and trip the breaker once we hit the threshold.
            _anthropic_circuit['fails'] += 1
            if _anthropic_circuit['fails'] >= _CB_FAIL_THRESHOLD:
                _anthropic_circuit['opened_at'] = time.time()
                print(f"[aiOptimiser] Anthropic circuit breaker OPENED after "
                      f"{_anthropic_circuit['fails']} consecutive failures")
            raise RuntimeError(
                f"Anthropic request failed after {max_retries} retries: {last_err}"
            )
        # A response came back → the API is healthy; reset the breaker.
        _anthropic_circuit['fails']     = 0
        _anthropic_circuit['opened_at'] = 0.0
        # Server-tool loop hit its iteration cap — resume the same turn.
        if resp_json.get('stop_reason') == 'pause_turn' and continuations < max_continuations:
            continuations += 1
            msgs = list(body.get('messages', []))
            msgs.append({'role': 'assistant', 'content': resp_json.get('content', [])})
            body = dict(body)
            body['messages'] = msgs
            continue
        return resp_json


# ── DeepSeek: a drop-in TEXT provider for A/B model comparison ────────────────
# The SaaS AI Content Optimiser lets staff run the same pipeline through Haiku or
# DeepSeek (or both, side by side) to compare quality. DeepSeek's chat/completions
# API is OpenAI-shaped, so we only route PLAIN system+user text actions here — no
# server tools, image blocks or forced-JSON schema (those actions stay on Anthropic).
_DEEPSEEK_MODEL      = 'deepseek-chat'
_DEEPSEEK_MAX_TOKENS = 8192            # deepseek-chat hard output cap


def _deepseek_request(api_key, system_str, user_text, max_tokens=8096,
                      temperature=None, max_retries=3, timeout=_ANTHROPIC_TIMEOUT):
    """POST to the DeepSeek chat/completions API with the same exponential-backoff
    retry policy as the Anthropic path. Returns the parsed response JSON (dict).
    Raises on unrecoverable failure."""
    body = {
        'model':      _DEEPSEEK_MODEL,
        'max_tokens': min(_safe_int(max_tokens, 8096) or 8096, _DEEPSEEK_MAX_TOKENS),
        'messages':   [
            {'role': 'system', 'content': system_str or ''},
            {'role': 'user',   'content': user_text or ''},
        ],
    }
    if temperature is not None:
        body['temperature'] = temperature
    headers  = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    last_err = None
    for attempt in range(max_retries):
        if attempt and _secs_left() < 30:
            last_err = f"{last_err} (skipped retry: invocation deadline)"
            break
        try:
            resp = requests.post('https://api.deepseek.com/chat/completions',
                                 headers=headers, json=body, timeout=_adaptive_timeout(timeout))
            if resp.status_code in (429, 500, 502, 503, 504):
                last_err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                time.sleep(_anthropic_backoff(attempt))
                continue
            if resp.status_code != 200:
                raise RuntimeError(f"DeepSeek HTTP {resp.status_code}: {resp.text[:300]}")
            rj = resp.json()
            return rj
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            time.sleep(_anthropic_backoff(attempt))
    raise RuntimeError(f"DeepSeek request failed after {max_retries} retries: {last_err}")


def _deepseek_text(resp_json):
    """Extract the assistant text from a DeepSeek (OpenAI-shaped) response."""
    try:
        return (resp_json['choices'][0]['message']['content'] or '').strip()
    except (KeyError, IndexError, TypeError):
        return ''


def _deepseek_usage(resp_json):
    """Normalise DeepSeek's prompt/completion token counts to the Anthropic-style
    input/output shape the gateway + editor expect."""
    u = (resp_json or {}).get('usage') or {}
    return {'input_tokens':  u.get('prompt_tokens', 0),
            'output_tokens': u.get('completion_tokens', 0)}


_DATAFORSEO_CRAWLER_URL = (
    'https://ak9qsl9wgi.execute-api.ap-southeast-1.amazonaws.com/dataforseoCrawler'
)


def _dataforseo_pull_content(url, timeout=60):
    """Live single-page scrape via the existing dataforseoCrawler Lambda
    (DataForSEO 'pull_content'). Returns plain text (HTML stripped, title
    prepended, capped) or None on failure — so the caller can fall back."""
    try:
        resp = requests.post(
            _DATAFORSEO_CRAWLER_URL,
            headers={'Content-Type': 'application/json'},
            json={'action': 'pull_content', 'url': url},
            timeout=timeout,
        )
        data = resp.json()
        body = data.get('body') if isinstance(data, dict) else None
        if isinstance(body, str):
            body = json.loads(body)
        elif body is None:
            body = data
        html = (body or {}).get('html') or ''
        if not html:
            return None
        text  = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html)).strip()
        title = (body or {}).get('title') or (body or {}).get('first_h1') or ''
        if title:
            text = f"PAGE TITLE: {title}\n\n{text}"
        return text or None
    except Exception as e:
        print(f"[aiOptimiser] dataforseo pull_content failed for {url}: {e}")
        return None


def _extract_text(resp_json):
    """Concatenate all text blocks from a Messages API response. When server
    tools are used the content array also holds server_tool_use / tool_result
    blocks, so content[0] is not necessarily the text — scan for type=='text'."""
    parts = [
        b.get('text', '')
        for b in (resp_json.get('content') or [])
        if b.get('type') == 'text'
    ]
    return "\n".join(p for p in parts if p).strip()


# JSON schema for the AI Strategy Engine's company-research output. Used with
# output_config.format to force a valid JSON object (no prose preamble).
# additionalProperties:false and no string/number constraints — per the
# structured-outputs schema limitations.
_STRATEGY_RESEARCH_SCHEMA = {
    'type': 'object',
    'properties': {
        'client_profile':         {'type': 'string'},
        'target_audience':        {'type': 'string'},
        'market_context':         {'type': 'string'},
        'objectives':             {'type': 'array', 'items': {'type': 'string'}},
        'seed_keywords':          {'type': 'string'},
        'top_competitor_domains': {'type': 'array', 'items': {'type': 'string'}},
        'seo_keywords':           {'type': 'array', 'items': {'type': 'string'}},
        'client_website':         {'type': 'string'},
    },
    'required': [
        'client_profile', 'target_audience', 'market_context',
        'objectives', 'seed_keywords', 'top_competitor_domains', 'seo_keywords',
    ],
    'additionalProperties': False,
}

# ==============================================================================
# SYSTEM MESSAGE 1: STATIC CONSTITUTION
# This never changes between requests. It defines the AI's identity,
# universal quality standards, and absolute rules.
# ==============================================================================
SYSTEM_MSG_CONSTITUTION = """
You are an expert SEO & GEO content editor trained on the latest Search Quality 
Rater Guidelines (E-E-A-T). Your goal is to create high-quality, authoritative 
content that genuinely serves readers while being optimized for both traditional 
search engines and AI-powered search (ChatGPT, Gemini, Perplexity).

IMPORTANT OUTPUT RULE:
DO NOT wrap your response in markdown code blocks like ```markdown or ```.
Return raw text/markdown content only.

================================================================
UNIVERSAL QUALITY STANDARDS
================================================================

TONE & VOICE RULES (apply to ALL content types):
- Write in third-person, objective language by default
- In conversational formats (lifestyle, food, parenting), a warmer tone 
  is acceptable — but never fabricate first-person anecdotes or personal 
  experience claims to simulate authority
- Never invent statistics, ratings, or performance figures without a 
  cited, verifiable source. If no source exists, rephrase as general 
  market context or remove the claim entirely
- Maintain consistent tone throughout — do not shift between formal 
  technical writing and casual blog writing within the same article
- Eliminate filler phrases that carry no real informational value:
    * "This is very important for many people"
    * "In today's fast-paced world..."
    * "More and more people are choosing..."
    * "This is a must-have for anyone who..."
    * "In conclusion, [TOPIC] is very important for everyone"

================================================================
REQUIRED STRUCTURAL ELEMENTS (adapt to content type)
================================================================

Every article must include the following, adapted to suit the topic:

1. DEFINITION & OVERVIEW
   - Precise definition or description of what the topic is
   - Who it is for and what problem it solves
   - Bulleted list of primary features, functions, or offerings
   - Scope boundaries: what it is NOT or does NOT cover

2. HOW IT WORKS / WHAT TO EXPECT
   - For products: operating principle or underlying technology
   - For services: step-by-step service delivery or customer journey
   - For experiences (restaurants, travel): flow from arrival to completion
   - Break into sub-types if the process differs significantly between variants

3. TYPES, VARIANTS, OR TIERS
   - Use recognized industry/market classifications only
   - For each type: what it is, who it suits, advantages, limitations
   - Do NOT invent classification categories

4. COMPARISON TABLE
   - 4–6 leading options, providers, brands, or variants
   - Consistent columns relevant to the content type
   - Flag indicative values that are subject to change
   - Do NOT fabricate reviews, ratings, or scores

5. SELECTION / HOW TO CHOOSE GUIDE
   - Numbered, decision-oriented steps
   - Frame each step as a question the reader should ask themselves
   - Include at least one reference table, checklist, or decision framework
   - Address contextual factors: budget, location, use case, environment

6. PRACTICAL GUIDE (installation / onboarding / visit tips)
   - Numbered steps for sequential processes
   - Bullet points for non-sequential tips or precautions

7. TROUBLESHOOTING / COMMON ISSUES TABLE
   - Minimum 5–6 entries
   - Three columns adapted to content type:
     * Products:     Symptom | Probable Cause | Recommended Action
     * Services:     Common Concern | Why It Happens | What To Do
     * Experiences:  Common Disappointment | Likely Reason | How To Avoid

8. STANDARDS, ACCREDITATIONS, OR CREDENTIALS (where applicable)
   - Table format: Standard/Body | Region | What It Means for the Reader
   - Explain certifications in plain terms
   - Note that requirements vary by market

9. FAQ SECTION
   - Minimum 10 questions using natural language phrasing
   - Must include at least:
     * One question about cost or pricing expectations
     * One question about a common misconception
     * One question about evaluating quality or making the right choice
     * One question about what happens when things go wrong
     * One question about an edge case or exception

================================================================
TECHNICAL ACCURACY RULES
================================================================

- Only use classifications recognized within the relevant industry
- Where behavior or quality varies by provider/model/location, 
  state this explicitly rather than generalizing
- Distinguish between what is universal/standard vs. provider-dependent
- Do not overstate capabilities, guarantees, or outcomes
- Note limitations and exceptions honestly
- Describe mechanism chains accurately 
  (cause → physical/process effect → detection → response)
  rather than oversimplifying to "sensor detects and triggers"

================================================================
E-E-A-T CONTENT GUIDELINES
================================================================

1. EXPERIENCE: Include reviews, use cases, or anecdotal evidence 
   where possible. Use phrases like "Based on reported findings" 
   or "In documented cases" — never fabricated personal claims.
2. EXPERTISE: Provide deep, focused subject matter coverage 
   confined to the intent of the keyword/topic.
3. AUTHORITATIVENESS: Reference credible sources and cite them
   using absolute HTML hyperlinks (<a href="URL">text</a>).
   Do NOT use bracketed placeholders like [Source: Name].
   Anchor text must be a short 2–5 word phrase (the source name or
   concept) — never wrap a whole sentence or clause in the link.
4. TRUSTWORTHINESS: Be honest about limitations, scope boundaries,
   and where professional advice should be sought.
5. READABILITY: Write for clarity. Use simple language, avoid 
   unnecessary jargon, and keep sentences and paragraphs short.

================================================================
FORMATTING RULES
================================================================

- Use clear header hierarchy: H2 for major sections, H3 for subsections
- Use bulleted lists for unordered items, numbered lists for steps
- Use Markdown tables for comparisons and structured data
- Include media placeholders with descriptive captions:
    [IMAGE: description of what the image should show]
    [INFOGRAPHIC: description of data to visualize]
    [VIDEO: description of process to demonstrate]
- Avoid multiple empty lines between sections
- Every article must include at minimum:
    * 1 comparison table
    * 1 selection reference table or decision checklist
    * 1 troubleshooting or common issues table

================================================================
SEO & GEO OPTIMIZATION RULES
================================================================

- Place the primary focus keyword in the H1 title
- Use long-tail keyword variants naturally in H2/H3 subheadings, 
  FAQ phrasing, and opening/closing of major sections
- Do NOT keyword-stuff — every instance must serve the reader first
- Write FAQ entries as full natural-language questions that mirror 
  how people actually search (voice search friendly)
- Write to function as pillar/cornerstone content: comprehensive 
  enough to be cited by AI systems as an authoritative source
- The Definition/Overview section must be self-contained enough 
  to be used as a direct answer snippet

================================================================
ABSOLUTE PROHIBITIONS
================================================================

Never include the following regardless of content type:
- First-person anecdotes presented as fact or expertise
- Unverified statistics or outcome figures
- Classification categories not recognized by the relevant industry
- Vague advice without specific, actionable guidance
- Filler sentences that restate the obvious
- Redundant section summaries that only repeat what was just said
- Hype language without evidence: "world-class", "revolutionary", 
  "unparalleled", "best-in-class"
- Content that reads like it was written to fill word count 
  rather than answer a real reader question
"""


def _system_param(system_str):
    """System prompt as content blocks with prompt-cache breakpoints.

    The constitution prefix is byte-identical across every generate-path call,
    so fan-out callers (8–18 QA agents per optimiser run, gap→rewrite chains)
    pay its input tokens once per 5-minute cache window instead of on every
    call. A second breakpoint after the dynamic brief additionally caches the
    full prefix within a run (same settings ⇒ same brief). Prompts below the
    model's minimum cacheable length simply ignore the marker — no error."""
    if isinstance(system_str, str) and system_str.startswith(SYSTEM_MSG_CONSTITUTION):
        rest = system_str[len(SYSTEM_MSG_CONSTITUTION):].lstrip('\n')
        blocks = [{'type': 'text', 'text': SYSTEM_MSG_CONSTITUTION,
                   'cache_control': {'type': 'ephemeral'}}]
        if rest.strip():
            blocks.append({'type': 'text', 'text': rest,
                           'cache_control': {'type': 'ephemeral'}})
        return blocks
    return system_str


def build_dynamic_system_msg(
    content_type, target_reader, tone_register,
    primary_keyword, secondary_keywords,
    settings, linking_guidelines
):
    """
    SYSTEM MESSAGE 2: DYNAMIC ASSIGNMENT BRIEF
    Built per-request. Tells the AI what KIND of content it is writing,
    who it is writing for, and what the keyword/commercial context is.
    This separates the stable rules (Message 1) from the variable
    parameters (Message 2).
    """

    content_type_guidance = {
        "hardware":     "Apply full technical depth. Use IEC/ISO/ANSI/UL/JIS standards where relevant. Include formulas, spec tables, and wiring/installation guidance.",
        "software":     "Focus on use cases, integration steps, pricing tiers, and compatibility. Avoid over-technical implementation detail unless audience is developer-level.",
        "service":      "Focus on service delivery process, provider comparison, onboarding steps, and outcome expectations. Avoid fabricated testimonials.",
        "educational":  "Focus on curriculum, teaching methodology, student outcomes, enrolment process, and how to evaluate quality. Address both student and parent perspectives.",
        "fnb":          "Focus on cuisine, dining experience, menu highlights, ambience, and practical visit planning. Include dietary options and reservation tips.",
        "healthcare":   "Maintain clinical accuracy. Avoid making diagnostic or treatment claims. Always recommend consulting a qualified professional for individual cases.",
        "travel":       "Focus on practical logistics, experience quality, and situational advice. Include seasonal considerations and accessibility notes.",
        "ecommerce":    "Focus on product specifications, use cases, buyer considerations, and return/warranty policies. Avoid fabricated reviews.",
        "general":      "Apply universal quality standards. Match depth and vocabulary to the specified target reader and tone register."
    }.get(content_type.lower(), "Apply universal quality standards appropriate to the content type.")

    msg = f"""
================================================================
ASSIGNMENT BRIEF FOR THIS REQUEST
================================================================

CONTENT TYPE: {content_type}
CONTENT TYPE GUIDANCE: {content_type_guidance}

TARGET READER: {target_reader}
TONE REGISTER: {tone_register}

KEYWORD TARGETING:
{f"- PRIMARY FOCUS KEYWORD: '{primary_keyword}' — prioritize in H1, definition section, FAQ phrasing, and section openings." if primary_keyword else "- No primary keyword specified. Write for topical authority and reader value."}
{f"- SECONDARY KEYWORDS: {secondary_keywords} — include naturally only where they serve the reader. Do not force them." if secondary_keywords else ""}

AUDIENCE CONTEXT:
- Target Audience: {settings.get('audience', 'General')}
- Brand Tone: {settings.get('brandTone', 'Professional')}
- Target Market / Locale: {settings.get('locale', 'Global')}
- Industry: {settings.get('industry', 'General')}

{linking_guidelines}

{_author_pov_block({'authorProfile': settings.get('authorProfile'), 'pov': settings.get('pov')})}
"""
    return msg.strip()


def build_linking_guidelines(settings, action):
    """Builds the external linking strategy block if applicable."""
    if not (settings.get('suggestExternalLinks', False) or action == "add_links"):
        return ""

    target_locale   = settings.get('locale', 'Global')
    target_industry = settings.get('industry', 'General')

    return f"""
EXTERNAL LINKING STRATEGY:
1. CITATIONS: Proactively suggest links to credible external sources 
   to back up claims, statistics, or statements.
   - PREFERRED SOURCES: Government (.gov), Educational (.edu), 
     Major News Outlets, and established Industry Authorities.
2. COMPETITOR AVOIDANCE:
   - Target Market: {target_locale}
   - Industry: {target_industry}
   - RULE: Do NOT link to commercial entities that are direct
     competitors in the {target_industry} space within {target_locale}.
   - ACCEPTABLE: You MAY link to commercial sources if they are
     clearly NOT direct competitors in the target market
     (e.g. tools, complementary services, or global brands
     if targeting a local audience).
3. ANCHOR TEXT: The clickable text inside <a>…</a> MUST be a short
   NOUN PHRASE of 2–5 words — the name of the source, organisation,
   programme, or concept being cited.
   - It must NOT contain a verb (e.g. "installed", "reports", "shows",
     "walks", "helps") and must NOT run on into the rest of the sentence.
   - Link ONLY the entity/concept name, then CLOSE the tag before the
     verb or any following words.
   - NEVER wrap an entire sentence, clause, or full line in a link.
   - Correct: The <a href="URL">Housing Development Board</a> has
     installed solar panels on thousands of rooftops.
   - Wrong:   The <a href="URL">Housing Development Board has installed
     solar panels</a> on thousands of rooftops.
   - Correct: The <a href="URL">International Energy Agency</a> reports
     that solar is now the cheapest source of electricity.
   - Wrong:   The <a href="URL">International Energy Agency reports that
     solar</a> is now the cheapest source of electricity.
"""


def build_user_msg(action, content, prompt_override):
    """
    USER MESSAGE: Task instruction only.
    Kept deliberately lean — all quality rules and context
    live in the system messages above.
    """
    if action == "generate":
        if "CURRENT CONTENT:" in prompt_override:
            return (
                f"Task: Generate ONLY the specific additions required by "
                f"this SEO recommendation:\n\n{prompt_override}\n\n"
                f"RULES:\n"
                f"1. Do NOT return the entire article.\n"
                f"2. Do NOT duplicate existing content.\n"
                f"3. Return ONLY the new HTML fragment.\n"
                f"4. Ensure the style matches the provided context "
                f"but acts as a standalone addition."
            )
        return (
            f"Generate comprehensive, structured content following all "
            f"the guidelines above based on this prompt:\n\n{prompt_override}"
        )

    elif action == "rewrite":
        return (
            f"Rewrite the following content to strictly follow all quality, "
            f"E-E-A-T, and formatting guidelines above:\n\n{content}"
        )

    elif action == "expand":
        return (
            f"Expand the following content with greater depth, additional "
            f"sections where missing (refer to required structure above), "
            f"media placeholders, and a fuller FAQ section:\n\n{content}"
        )

    elif action == "shorten":
        return (
            f"Shorten the following content while preserving all E-E-A-T "
            f"principles, key facts, and grade-school readability. "
            f"Remove filler and redundancy first:\n\n{content}"
        )

    elif action == "simplify":
        return (
            f"Simplify the language of the following content for a "
            f"grade-school reading level. Preserve all factual accuracy, "
            f"structure, and meaning:\n\n{content}"
        )

    elif action == "continue":
        return (
            f"Continue writing the following content. The next sections "
            f"must follow all required structural elements and formatting "
            f"rules defined above. Do not repeat what has already been "
            f"written:\n\n{content}"
        )

    elif action == "add_links":
        return (
            f"Review the following HTML content and insert credible "
            f"external citations following the linking strategy above.\n\n"
            f"RULES:\n"
            f"1. PRESERVE all existing HTML tags exactly as they are.\n"
            f"2. INSERT at least 3–10 real, credible external links "
            f"embedded directly into sentence structure.\n"
            f"3. FORMAT: <a href=\"URL\" title=\"URL\">anchor text</a>\n"
            f"4. ANCHOR TEXT must be a short NOUN PHRASE of 2–5 words — the "
            f"name of the source, organisation, programme, or concept cited. "
            f"It must NOT contain a verb (installed, reports, shows, helps) "
            f"and must NOT run on into the rest of the sentence. Link ONLY "
            f"the entity/concept name, then close </a> BEFORE the verb or "
            f"any following words. NEVER wrap a whole sentence, clause, or "
            f"line in a link. E.g. link \"Housing Development Board\", never "
            f"\"Housing Development Board has installed solar panels\".\n"
            f"5. Do NOT append bracketed sources.\n"
            f"6. Return the full content as a valid HTML fragment.\n\n"
            f"CONTENT:\n{content}"
        )

    elif action == "translate":
        return (
            f"Translate the following content to English. Maintain all "
            f"structural elements (Markdown headers, lists, tables) and "
            f"original meaning precisely.\n\n"
            f"CONTENT:\n{content if content else prompt_override}"
        )

    elif action == "outline":
        return (
            f"Generate a detailed article outline for the following topic. "
            f"Use hierarchical headers (H2, H3) and descriptive bullet "
            f"points only. Reference the required structural elements above "
            f"to ensure no major section is missed. Do NOT write full "
            f"paragraphs, introductions, or FAQs unless specifically "
            f"requested.\n\nTOPIC: {prompt_override}"
        )

    return None


# ── STRUCTURED ACTIONS ────────────────────────────────────────────────────────
# Prompts for these actions are built server-side from structured data.
# The frontend sends only dynamic parameters — never the raw prompt text.

_STRUCTURED_ACTIONS = {
    'news_classify', 'html_fragment', 'luxury_copy', 'caption_critic', 'serp_analysis',
    'content_outline', 'content_section', 'content_polish', 'strategy_url_research',
    'smm_report', 'image_alt_rationale',
    'topic_extract', 'topic_hierarchy',
    'author_extract',
}

# Author Profile (POV / E-E-A-T authorship). Extracted from a crawled bio/LinkedIn/site,
# then user-confirmed and persisted; injected as a first-person voice layer at write time.
_AUTHOR_EXTRACT_SCHEMA = {
    'type': 'object',
    'properties': {
        'name':                {'type': 'string'},
        'headline':            {'type': 'string'},
        'years_experience':    {'type': ['integer', 'null']},
        'location':            {'type': 'string'},
        'expertise':           {'type': 'array', 'items': {'type': 'string'}},
        'communities':         {'type': 'array', 'items': {'type': 'string'}},
        'achievements':        {'type': 'array', 'items': {'type': 'string'}},
        'signature_pov':       {'type': 'array', 'items': {'type': 'string'}},
        'voice_notes':         {'type': 'string'},
        'credibility_summary': {'type': 'string'},
    },
    'required': ['name', 'expertise', 'signature_pov'],
    'additionalProperties': False,
}

# Forced-JSON schemas for the Topic Selection pipeline so the client's JSON.parse
# can't choke on a prose preamble.
_TOPIC_EXTRACT_SCHEMA = {
    'type': 'object',
    'properties': {
        'candidates': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'term':          {'type': 'string'},
                    'intent':        {'type': 'string',
                                      'enum': ['informational', 'commercial', 'transactional', 'navigational']},
                    'funnel':        {'type': 'string',
                                      'enum': ['awareness', 'consideration', 'decision']},
                    'heading_level': {'type': 'string', 'enum': ['h1', 'h2', 'h3', 'body']},
                    'entities':      {'type': 'array', 'items': {'type': 'string'}},
                },
                'required': ['term', 'intent', 'funnel'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['candidates'],
    'additionalProperties': False,
}

_TOPIC_HIERARCHY_SCHEMA = {
    'type': 'object',
    'properties': {
        'pillar': {
            'type': 'object',
            'properties': {
                'title':          {'type': 'string'},
                'central_entity': {'type': 'string'},
            },
            'required': ['title', 'central_entity'],
            'additionalProperties': False,
        },
        'nodes': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'id':           {'type': 'string'},
                    'title':        {'type': 'string'},
                    'parent_id':    {'type': ['string', 'null']},
                    'intent':       {'type': 'string'},
                    'bucket':       {'type': 'string'},
                    'relevance':    {'type': ['number', 'null']},
                    'why_belongs':  {'type': 'string'},
                    'content_type': {'type': 'string', 'enum': ['pillar', 'cluster', 'section']},
                },
                'required': ['id', 'title', 'parent_id', 'why_belongs', 'content_type'],
                'additionalProperties': False,
            },
        },
        'rejected': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'term':   {'type': 'string'},
                    'reason': {'type': 'string'},
                },
                'required': ['term', 'reason'],
                'additionalProperties': False,
            },
        },
    },
    'required': ['pillar', 'nodes'],
    'additionalProperties': False,
}


# ── Caption Generator: platform playbooks ──────────────────────────────────
# Each platform carries the hard, channel-native rules the model must respect.
# These are the difference between "generic copy with a label" and a post that
# actually fits where it will be published.
PLATFORM_SPECS = {
    'instagram': {
        'name': 'Instagram caption',
        'limit': 'Hard cap 2,200 characters. Sweet spot 80–150 words for a feed caption.',
        'hook': 'Only the first ~125 characters show before the "… more" fold. The hook MUST land in line one and create a reason to tap "more".',
        'hashtags': 'Up to 30 allowed; 5–12 is optimal. Mix ~2 broad reach tags, ~5 niche/specific tags, ~1 branded tag.',
        'cta': 'No clickable links in the caption body — use "link in bio", "DM us", "save this", or "tag a friend" style CTAs.',
        'structure': 'Hook line → 1–3 short scannable paragraphs (blank line between) → soft CTA → hashtag block at the very end.',
        'alt': True, 'onimage': True,
    },
    'linkedin': {
        'name': 'LinkedIn post',
        'limit': 'Hard cap ~3,000 characters; 150–300 words performs best.',
        'hook': 'Only ~210 characters (2–3 lines) show before "…see more". Front-load the insight or tension; never waste line one on a greeting.',
        'hashtags': '3–5 professional, topical hashtags placed at the end. No hashtag walls.',
        'cta': 'Links are fine (though they can suppress reach). Prefer a question or a "share your take" prompt to drive comments.',
        'structure': 'Punchy opening line → one-idea-per-line short paragraphs with white space → a concrete takeaway → a question or CTA.',
        'alt': False, 'onimage': False,
    },
    'facebook': {
        'name': 'Facebook post',
        'limit': 'No hard cap, but 40–120 words gets the most engagement. ~480 chars show before "See more".',
        'hook': 'Lead with a relatable, conversational hook. Front-load the point in the first sentence.',
        'hashtags': '0–3 hashtags only; hashtags do little on Facebook. Prefer none unless branded/campaign.',
        'cta': 'Links are clickable. A clear CTA + link is fine. Encourage comments/shares.',
        'structure': 'Conversational hook → short body → clear CTA. Warm and human, not corporate.',
        'alt': False, 'onimage': False,
    },
    'tiktok': {
        'name': 'TikTok caption',
        'limit': 'Keep the caption short — under ~150 characters. The video does the talking.',
        'hook': 'The caption complements an on-screen hook. Curiosity, payoff tease, or relatable one-liner.',
        'hashtags': '3–5 hashtags: blend 1–2 trending/broad with 2–3 niche. Include a content-category tag.',
        'cta': '"Follow for part 2", "comment X", "watch till the end" style native CTAs.',
        'structure': 'One tight caption line (or two) + hashtags. Always also propose the on-screen text hook.',
        'alt': False, 'onimage': True,
    },
    'x': {
        'name': 'X / Twitter post',
        'limit': 'Hard cap 280 characters — this is absolute. Count carefully.',
        'hook': 'The whole post is the hook. One sharp idea, no warm-up.',
        'hashtags': '0–2 hashtags maximum; often best with none. Hashtags reduce reach if overused.',
        'cta': 'Reply-bait, "RT if", or a single link at the end.',
        'structure': 'One self-contained, punchy post under 280 chars. If the idea is bigger, note a thread is needed.',
        'alt': False, 'onimage': False,
    },
    'threads': {
        'name': 'Threads post',
        'limit': 'Hard cap 500 characters. Conversational, lower-key than X.',
        'hook': 'Casual, human opener — like talking to a friend. No corporate tone.',
        'hashtags': 'At most 1 topic tag; Threads is not hashtag-driven.',
        'cta': 'Invite replies. Conversational prompts beat hard CTAs.',
        'structure': 'A short, natural post under 500 chars. Optional follow-up line.',
        'alt': False, 'onimage': False,
    },
    'youtube': {
        'name': 'YouTube post',
        'limit': 'For a community post: 1–3 sentences. For a description: 150–300 words.',
        'hook': 'First 1–2 lines show before the fold — make them keyword-aware and curiosity-driven.',
        'hashtags': '3–5 keyword hashtags placed at the end (these also appear above the title).',
        'cta': '"Subscribe", "watch the full video", "hit the bell". Links allowed.',
        'structure': 'Hook line → context → CTA to watch/subscribe. Keyword-aware for search.',
        'alt': False, 'onimage': False,
    },
    'pinterest': {
        'name': 'Pinterest pin description',
        'limit': 'Hard cap 500 characters; 100–200 is ideal.',
        'hook': 'Pinterest is a search engine — lead with the keyword and the value/outcome.',
        'hashtags': '2–5 specific, keyword-style hashtags.',
        'cta': '"Save this for later", "tap to shop", "read the full guide". Links allowed.',
        'structure': 'Keyword-rich first line → benefit/how-to detail → CTA → hashtags. Optimise for search intent.',
        'alt': True, 'onimage': False,
    },
    'gbp': {
        'name': 'Google Business Profile post',
        'limit': 'Hard cap 1,500 characters; 150–300 chars recommended — only ~80 show before truncation.',
        'hook': 'Front-load the offer/news and the local relevance in the first sentence.',
        'hashtags': 'No hashtags — they do nothing on GBP. Use plain, action-oriented copy.',
        'cta': 'Map to a GBP button: Book, Order, Buy, Learn more, Call, Sign up. State the action plainly.',
        'structure': 'Offer/news first → key details (what/when/where) → single clear CTA matching a GBP button.',
        'alt': False, 'onimage': False,
    },
}

# Length intent → guidance, refined by platform limits in the prompt.
LENGTH_INTENTS = {
    'punchy':    'PUNCHY — as short as possible while complete. Favour the shortest end of the platform range.',
    'standard':  'STANDARD — the platform sweet spot. Balanced, scannable.',
    'long':      'LONG-FORM — the richer end of the platform range (story/insight depth), without exceeding the hard cap.',
}

# Hook archetypes the user can force; "auto" lets the variation angle decide.
HOOK_STYLES = {
    'question':    'Open with a sharp, scroll-stopping QUESTION that voices an unspoken desire or challenges an assumption.',
    'stat':        'Open with a surprising STAT or number that reframes the topic. Use only numbers given in the brief — never invent figures.',
    'bold-claim':  'Open with a BOLD, unhedged CLAIM. No qualifiers, no warm-up.',
    'story':       'Open with a tiny, hyper-specific STORY moment (1–2 lines) that feels real.',
    'contrarian':  'Open with a CONTRARIAN take that reframes conventional wisdom on this topic.',
}

def _platform_key(label):
    l = (label or '').lower()
    if 'instagram' in l:                       return 'instagram'
    if 'linkedin' in l:                        return 'linkedin'
    if 'facebook' in l:                        return 'facebook'
    if 'tiktok' in l:                          return 'tiktok'
    if 'threads' in l:                         return 'threads'
    if 'twitter' in l or 'x post' in l or l.strip() in ('x', 'x / twitter post'):
        return 'x'
    if 'youtube' in l:                         return 'youtube'
    if 'pinterest' in l:                       return 'pinterest'
    if 'google business' in l or 'gbp' in l:   return 'gbp'
    return 'instagram'

# Strict output contract. The model returns ONE JSON object and nothing else,
# so the frontend can render hook / body / CTA / hashtags / alt text separately.
def _luxury_output_contract(spec):
    want_alt = 'true' if spec.get('alt') else 'false (set to null)'
    want_oi  = 'true' if spec.get('onimage') else 'false (set to null)'
    return (
        "OUTPUT FORMAT — return ONLY a single JSON object, no markdown fences, no prose before or after:\n"
        "{\n"
        '  "angle": "<the creative angle name you were given>",\n'
        '  "hook": "<the first line / scroll-stopper, plain text>",\n'
        '  "body": "<the main caption body; use \\n for line breaks; do NOT include the hook, CTA, or hashtags here>",\n'
        '  "cta": "<the call-to-action line, platform-appropriate>",\n'
        '  "caption": "<the FULL ready-to-paste post: hook + body + cta assembled with natural line breaks; include hashtags inline ONLY if placement is inline; never include them if placement is first-comment or none>",\n'
        '  "hashtags": ["#tag1", "#tag2"],\n'
        f'  "altText": "<accessibility alt text for the image, ~1 sentence>",   // include since alt useful for this platform = {want_alt}\n'
        f'  "onImageText": "<short punchy text to overlay on the visual>",        // include since on-image text useful = {want_oi}\n'
        '  "scores": { "hookStrength": <1-10>, "readability": <1-10>, "onBrand": <1-10> }\n'
        "}\n"
        "Keep the caption/hook/body/cta in the exact voice and language briefed above. All string values must be valid JSON "
        "(escape quotes and newlines). Do not output anything except this JSON object."
    )


def build_structured_prompt(action, body):
    """Return (system_str, user_str) for a structured action, or (None, None) if unknown."""

    if action == 'news_classify':
        articles = body.get('articles', [])
        # Bound the request size: a very long article list inflates both the
        # prompt and the JSON the model has to emit, which is what was pushing
        # this call past its read timeout and surfacing as a 502. Cap to a sane
        # batch so a single classification stays comfortably inside the window.
        _NEWS_CLASSIFY_CAP = 40
        if len(articles) > _NEWS_CLASSIFY_CAP:
            print(f"[aiOptimiser] news_classify: capping {len(articles)} articles "
                  f"to {_NEWS_CLASSIFY_CAP}")
            articles = articles[:_NEWS_CLASSIFY_CAP]
        date_str = body.get('date', '')
        article_list = '\n'.join(
            '[{i}] title: "{t}" | source: "{s}" | date: "{d}" | url: "{u}" | description: "{desc}"'.format(
                i=idx + 1,
                t=a.get('title', ''),
                s=a.get('source', ''),
                d=a.get('date', ''),
                u=a.get('url', ''),
                desc=(a.get('description') or '').replace('"', "'")
            )
            for idx, a in enumerate(articles)
        )
        system = (
            "You are an SEO Expert classifying and prioritising real SEO news articles "
            "for a digital marketing agency."
        )
        user = (
            "The following articles were fetched live from trusted SEO publication RSS feeds. "
            "Each has a REAL, VERIFIED URL from the feed — you MUST copy each URL EXACTLY as provided, "
            "with NO modifications.\n\n"
            f"ARTICLES TO CLASSIFY:\n{article_list}\n\n"
            f"Today's date is {date_str}.\n\n"
            "Your task: Select the 20–25 most important/relevant articles from the list above and classify each one.\n"
            "RULES:\n"
            "- DO NOT invent new articles — only use articles from the list above.\n"
            "- DO NOT modify URLs — copy the \"url\" field verbatim for each article.\n"
            "- Exclude generic SEO tips, clickbait, speculative rumours without corroboration.\n"
            "- Prioritise: Google algorithm updates, SERP changes, AI Overview/SGE news, ranking volatility, technical SEO changes.\n"
            "- Do NOT include low-quality articles that are merely opinion pieces without substance.\n"
            "- Ensure date coverage across the full date range if possible.\n"
            "- Return ONLY a JSON array (no markdown), each item having:\n"
            '  - "id": original article index (1-based)\n'
            '  - "title": verbatim from article\n'
            '  - "source": verbatim from article\n'
            '  - "date": verbatim from article\n'
            '  - "url": verbatim from article — NEVER modify\n'
            '  - "category": one of "Google Algorithm","SERP Changes","AI & Search","Technical SEO",'
            '"Content & E-E-A-T","Link Building","Tools & Platforms","Industry News"\n'
            '  - "subcategory": optional refined label\n'
            '  - "summary": your 1-2 sentence summary based on title and description\n'
            '  - "impact_score": integer 1-10\n'
            '  - "confidence_score": integer 1-10 (10 = official Google confirmation, 1 = unverified rumour)\n'
            '  - "immediate_risk": one of "Critical","High","Medium","Low","Monitor Only"\n'
            '  - "affected_factors": array from: ["Content Quality & Relevance","Backlink Authority",'
            '"Technical SEO","On-Page Optimisation","UX Signals","SERP / External Context"]\n'
            '  - "affected_industries": array of most affected industries\n'
            '  - "what_happened": 1-2 sentence factual description\n'
            '  - "why_it_matters": 1-2 sentence explanation of agency impact\n'
            '  - "what_to_monitor": specific metric or signal to watch\n'
            '  - "recommended_actions": array of 1-3 concrete specific actions (NOT generic advice)\n'
            '  - "urgency": one of "Immediate","High","Medium","Low"\n\n'
            "Return ONLY a JSON array, no other text."
        )
        return system, user

    elif action == 'html_fragment':
        recommendation  = body.get('recommendation', '')
        specific_hints  = body.get('specificHints', '')
        persona_context = body.get('personaContext', '')
        selected_topics = body.get('selectedTopics', '')
        persona_block   = f"\nSTRICTLY ADHERE TO THESE TARGET PERSONAS:\n{persona_context}" if persona_context else ''
        topics_block    = f"\nPRIORITIZE ADDRESSING THESE COMPETITOR TOPICS:\n{selected_topics}" if selected_topics else ''
        system = "You are an expert SEO content specialist generating targeted HTML fragments."
        user = (
            f'SEO RECOMMENDATION TO IMPLEMENT: "{recommendation}"{specific_hints}\n\n'
            "TASK: Generate ONLY the new HTML fragment needed to fulfill this recommendation.\n"
            f"{persona_block}{topics_block}\n\n"
            "PLACEMENT INSTRUCTION: Also determine the ideal placement for this new content. "
            "Prepend your response with a tag:\n"
            "- [PLACEMENT: TOP] for titles/intros.\n"
            "- [PLACEMENT: BOTTOM] for bios/FAQs.\n"
            "- [PLACEMENT: AFTER_H2: (exact text of heading)] for middle-section expansions.\n\n"
            "IMPORTANT: DO NOT return the original article headings or paragraphs. "
            "Return ONLY the tag and the new HTML fragment."
        )
        return system, user

    elif action == 'luxury_copy':
        content_type_label = body.get('contentTypeLabel', 'caption')
        f                  = body.get('fields', {})
        sample_text        = body.get('sampleText', '')
        brand_guide_text   = body.get('brandGuideText', '')
        webpage_text       = body.get('webpageText', '')
        variation_index    = _safe_int(body.get('variationIndex', 0), 0)
        language           = (f.get('language') or '').lower()
        previous_captions  = body.get('previousCaptions', []) or []
        has_images         = bool(body.get('images'))
        brand_learnings    = [str(l) for l in (f.get('brandLearnings') or []) if l and str(l).strip()]
        specific_instructions = (f.get('specificInstructions') or '').strip()

        # Resolve the platform playbook + formatting controls from the brief.
        spec = PLATFORM_SPECS[_platform_key(content_type_label)]
        length_intent    = (f.get('lengthIntent') or 'standard').lower()
        length_directive = LENGTH_INTENTS.get(length_intent, LENGTH_INTENTS['standard'])
        word_count       = f.get('wordCount')
        hook_style       = (f.get('hookStyle') or 'auto').lower()
        hook_directive   = HOOK_STYLES.get(hook_style)
        _ht_raw = str(f.get('hashtags') or 'none').lower()
        if _ht_raw in ('yes', 'true', 'inline'):
            ht_placement = 'inline'
        elif _ht_raw in ('first-comment', 'first_comment', 'comment'):
            ht_placement = 'first-comment'
        else:
            ht_placement = 'none'

        # ── Refinement mode ────────────────────────────────────────────────
        # The Caption Generator's "Refine selection" / inline-edit feature reuses
        # this action but sends the existing copy + an edit instruction instead of
        # a fresh brief. Detect it and rewrite the existing content rather than
        # generating something new from empty brief fields.
        if f.get('refinementMode'):
            current_content = (f.get('currentContent') or '').strip()
            selected_text   = (f.get('selectedText') or '').strip()
            instructions    = (f.get('instructions') or '').strip()

            system = (
                "You are a senior social media copy editor. You revise existing social copy "
                "according to the user's instruction. You preserve the parts the user did not ask "
                "to change, keep the original voice, tone and language (including Singlish or "
                "Chinese if the copy is in that language), and never add meta-commentary, "
                "explanations, labels, or questions back to the user."
            )

            user_parts = [
                f"Revise the following {content_type_label}.",
                f"CURRENT CONTENT:\n{current_content}",
            ]
            if selected_text:
                user_parts.append(
                    "The user highlighted ONLY this portion to change — leave the rest of the "
                    f"content intact and edit just this part in place:\n\"{selected_text}\""
                )
            else:
                user_parts.append("Apply the change to the whole content.")
            user_parts.append(f"INSTRUCTION:\n{instructions}")
            user_parts.append(
                "Do not invent facts, figures, prices, or offers that are not already in the current content. "
                "Preserve the EXACT capitalisation, spacing, and spelling of the brand name and any proper nouns "
                "already in the content — never lowercase or restyle them. "
                "Avoid em dashes (—); use commas, full stops, or short sentences instead."
            )
            user_parts.append(
                "Output ONLY the complete revised content, ready to publish — no preamble, "
                "no explanation, no labels, no questions."
            )
            return system, "\n\n".join(user_parts)

        CREATIVE_ANGLES = [
            { 'name': 'Atmospheric Opening',         'instruction': 'Lead with a cinematic, sensory scene that immerses the reader in a mood before any product or brand mention. Appeal to sight, texture, sound, or scent.' },
            { 'name': 'Provocative Question',        'instruction': "Open with a sharp, scroll-stopping question that challenges a common assumption or voices an unspoken desire the audience hasn't yet articulated." },
            { 'name': 'Contrarian Take',             'instruction': "Start with a statement that reframes conventional wisdom on this topic — something unexpected, counterintuitive, or quietly rebellious that earns the reader's curiosity." },
            { 'name': 'Micro-Story',                 'instruction': 'Open with a tiny, hyper-specific story (2–3 lines) — a single moment, a gesture, a detail — that feels like a real scene the reader could have lived.' },
            { 'name': 'Bold Declaration',            'instruction': 'Open with a confident, unhedged statement. No qualifiers, no warm-up. Claim the room from the very first word.' },
            { 'name': 'Cultural Hook',               'instruction': "Connect this content to a larger cultural movement, collective mood, or societal shift the audience is already living — name the thing they feel but haven't said out loud." },
            { 'name': 'Insider Angle',               'instruction': "Write as if sharing something most people don't know — a process secret, a craft-level insight, a behind-the-scenes truth. Give the reader a feeling of privileged access." },
            { 'name': 'Aspiration & Transformation', 'instruction': 'Lead with the desired future state: describe what life looks, feels, or sounds like after the transformation. Begin at the destination, not the journey.' },
            { 'name': 'Community & Belonging',       'instruction': 'Address the reader as a member of a specific tribe or movement that holds particular values. Write to make them feel seen, chosen, and part of something meaningful.' },
            { 'name': 'Minimalist / Haiku Energy',   'instruction': 'Three sentences maximum. Each line lands with weight. Heavy rhythm, deliberate white space, every single word earns its place — restraint is the technique.' },
        ]

        # Trend-format angles for the casual "viral / social-first" voice. The
        # literary CREATIVE_ANGLES above fight that voice, so swap in on-brand
        # social hooks when language == 'viral'.
        VIRAL_ANGLES = [
            { 'name': 'POV Hook',          'instruction': "Open with a 'POV:' framing that drops the reader straight into the experience or outcome (e.g. 'POV: you finally hired the right team'). Short and visual." },
            { 'name': "It's Giving",       'instruction': "Lead with an \"it's giving ___\" line that names the vibe or quality in a single trendy beat, then back it up in a line or two." },
            { 'name': 'Self-Aware Humour', 'instruction': "Open with a 'not me ___' / caught-in-the-act admission that pokes fun at how obsessed or extra the brand is about its craft." },
            { 'name': 'Signature Flex',    'instruction': "Use a 'the way we ___' construction to flex one specific thing the brand does better than anyone — quiet confidence, not bragging." },
            { 'name': 'Main Character',    'instruction': "Bold, main-character-energy flex. Unhedged confidence, claims the moment from word one — no warm-up, no qualifiers." },
            { 'name': 'Behind The Scenes', 'instruction': "Playful 'we don't talk about ___' tease that winks at the behind-the-scenes chaos or effort, then lands on the result." },
            { 'name': 'Hot Take',          'instruction': "Open with an 'unpopular opinion' / hot take that reframes how people think about this category, then defend it in one punchy line." },
            { 'name': 'Tell Me Without',   'instruction': "Use 'tell me you're ___ without telling me you're ___' to show the brand's quality through specific, knowing details." },
            { 'name': 'Result Reveal',     'instruction': "Celebratory reveal of the finished work — a 'did we cook or did we cook?' energy that lets the result speak. Hyped and proud." },
            { 'name': 'Casual Real-Talk',  'instruction': "No meme template — just talk to the reader like a friend who's genuinely great at this. Casual, specific, a little funny, zero corporate words." },
        ]

        _angles = VIRAL_ANGLES if language == 'viral' else CREATIVE_ANGLES
        angle = _angles[variation_index % len(_angles)]

        def _line(label, val):
            if isinstance(val, list):
                val = ', '.join(str(v) for v in val if v)
            return f"- {label}: {val}\n" if val else ''

        if language == 'xiaohongshu':
            system = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led content specifically for Xiao Hong Shu (小红书 / RED). "
                "You write in a natural, peer-to-peer tone that feels like a genuine personal recommendation, "
                "not a brand advertisement. Use conversational Chinese, relatable storytelling, and relevant "
                "hashtags (话题标签) in the Xiao Hong Shu style. Avoid corporate or salesy language."
            )
        elif language == 'chinese':
            system = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led, performance-aware social content for B2B and B2C brands in Chinese markets. "
                "Write in Chinese."
            )
        elif language == 'singlish':
            system = (
                "You are a born-and-bred Singaporean social media copywriter who writes in authentic, natural "
                "Singlish (Singaporean colloquial English) — the way locals actually text, caption, and talk. "
                "This is a HARD requirement: the copy must read as genuinely Singlish, not standard English with "
                "one 'lah' bolted on.\n\n"
                "How to write proper Singlish:\n"
                "- Use discourse particles naturally and VARY them — lah, leh, lor, sia, hor, ah, mah, meh, liao, "
                "walao, aiyo. Don't end every line with 'lah'.\n"
                "- Use real Singlish grammar and vocab: 'can'/'cannot' as standalone answers, 'die die must try', "
                "'shiok', 'steady', 'paiseh', 'jialat', 'chope', 'confirm plus chop', 'where got', 'got' as a verb "
                "('got promo'), 'already'/'liao' for completed action ('sold out liao'), dropped copula and "
                "topic-comment structure ('This one damn shiok', 'Price very worth it one').\n"
                "- Warm, friendly, kaypoh, hype-a-friend energy — not corporate.\n"
                "- Code-switch lightly where natural, but keep it readable.\n"
                "- Still keep the brand name, core message and CTA accurate. Err on the side of MORE Singlish, "
                "not less — the reader must immediately feel 'wah, this one properly Singlish'.\n\n"
                "You are still a strategist: the post must do its job (drive the CTA, reinforce positioning), "
                "just in a fully Singlish voice."
            )
        elif language == 'viral':
            system = (
                "You are a chronically-online social media copywriter who writes scroll-stopping, "
                "viral-native captions for Instagram, TikTok and Reels. You write the way real people "
                "actually post — casual, punchy, self-aware and culturally fluent.\n\n"
                "You use current internet vernacular and trend formats naturally where they fit — "
                "e.g. 'POV: …', \"it's giving …\", 'not me …', 'the way we …', 'main character energy', "
                "\"we don't talk about …\", 'tell me you … without telling me …', 'unpopular opinion' — "
                "but only when they genuinely land. Never force a meme or sound try-hard.\n\n"
                "How you write:\n"
                "- Short. Front-load the hook in the first 3-5 words; assume the reader is mid-scroll.\n"
                "- Conversational and human: contractions, lowercase energy, dry humour, a wink of confidence.\n"
                "- Lowercase styling is fine for the body, but ALWAYS write the brand name with its given "
                "capitalization (e.g. 'Anderco', never 'anderco').\n"
                "- One clear idea per caption. Use line breaks for rhythm.\n"
                "- Cut corporate filler entirely ('elevate', 'unlock', 'seamless', 'we are proud to', "
                "'in today's fast-paced world', 'nestled', 'curated').\n"
                "- Still land the brand's point and the CTA — viral but on-message, never random.\n\n"
                "You are still a strategist: the post must do its job (hook, positioning, CTA), just in a "
                "fully casual, trend-aware voice."
            )
        else:
            system = (
                "You are a senior social media strategist and copywriter with over 15 years of experience "
                "writing brand-led, performance-aware social content for B2B and B2C brands.\n\n"
                "Your task is not to simply write a caption, but to decide how the caption should function "
                "strategically within the brand's social media ecosystem.\n\n"
                "You must:\n"
                "- Identify the strategic role of the post\n"
                "- Write with a clear audience intent in mind\n"
                "- Reinforce brand positioning, not just deliver information\n"
                "- Be concise, intentional, and purposeful\n\n"
                "You must avoid: generic marketing language, over-explaining, and writing for engagement without "
                "strategic value. Assume the reader is scrolling quickly. Every line must earn its place.\n\n"
                "If trade-offs are required, prioritise: Clarity, Brand credibility, and Strategic intent.\n\n"
                "The final caption must feel like it was written by a human strategist, not an automated generator."
            )

        user = (
            f"Generate a {content_type_label} based on the brief below.\n\n"
            "STRATEGY\n"
            f"{_line('Post Role', f.get('postRole'))}"
            f"{_line('Strategy Context', f.get('strategyFit'))}"
            f"{_line('Core Message', f.get('coreMessage'))}"
            "AUDIENCE\n"
            f"{_line('Brand Name', f.get('brandName'))}"
            f"{_line('Target Sub-Groups', f.get('subgroups'))}"
            f"{_line('Pain Points', f.get('painpoints'))}"
            f"{_line('Audience Goals', f.get('audienceGoal'))}"
            "CONTENT BRIEF\n"
            f"{_line('Product / Service', f.get('productService'))}"
            f"{_line('Core Topic', f.get('postInfo'))}"
            f"{_line('Desired CTA', f.get('desiredAction'))}"
            f"{_line('USP', f.get('usp'))}"
            f"{_line('Constraints / Mandatories', f.get('constraints'))}"
            "BRAND & FORMAT\n"
            f"{_line('Brand POV', f.get('pov'))}"
            f"{_line('Tone of Voice', f.get('tone'))}"
            f"{_line('Language', f.get('language'))}"
            f"{_line('Word Count', f.get('wordCount'))}"
            f"{_line('Include Emojis', f.get('emojis'))}"
            f"{_line('Include Hashtags', f.get('hashtags'))}"
            f"{'SAMPLE REFERENCE (match this style and voice):' + chr(10) + sample_text + chr(10) if sample_text else ''}"
            f"{'BRAND GUIDE CONTEXT:' + chr(10) + brand_guide_text + chr(10) if brand_guide_text else ''}"
            f"{'REFERENCE CONTENT:' + chr(10) + webpage_text + chr(10) if webpage_text else ''}"
            + (
                "ALREADY-GENERATED VERSIONS — do NOT repeat or closely resemble any of these. "
                "Use a clearly different opening line, structure, and angle so this reads as a genuinely "
                "fresh alternative, not a paraphrase:\n"
                + "\n".join(
                    f"{i + 1}. {str(c)[:200]}" for i, c in enumerate(previous_captions[-6:])
                )
                + "\n\n"
                if previous_captions else ''
            )
            + (
                "BRAND LEARNINGS — notes from past interactions with this brand. Apply them where relevant:\n"
                + "\n".join(f"• {l}" for l in brand_learnings[:30])
                + "\n\n"
                if brand_learnings else ''
            )
            + (
                f"\nSPECIAL INSTRUCTIONS — HIGHEST USER PRIORITY. Follow these exactly, even if they override the writing rules below:\n{specific_instructions}\n"
                if specific_instructions else ''
            )
            + "WRITING RULES — apply every rule without exception:\n"
            "1. NEVER open with the brand name or a phrase like \"At [Brand], we believe...\" — "
            "lead instead with an atmospheric, sensory observation about the subject matter itself.\n"
            "2. Structure as 2-3 short paragraphs. The final paragraph is a single soft call to action.\n"
            "3. Weave the brand name in naturally mid-copy or in the closing line — never as the sentence opener.\n"
            "4. Before writing, determine the brand's editorial tone from BRAND GUIDE CONTEXT or SAMPLE REFERENCE "
            "if provided; otherwise infer from your knowledge of the brand. Never default to a generic style.\n"
            "5. Speak to the reader's aspirations and lived experience — not to what the brand does.\n"
            "6. Use varied sentence rhythm: mix short, punchy statements with slightly longer ones.\n"
            "7. Identify the brand's signature vocabulary from provided context, or infer from brand knowledge. "
            "Prioritise those words throughout.\n"
            f"CREATIVE APPROACH FOR THIS VARIATION — {angle['name'].upper()}: {angle['instruction']}\n"
            + (
                "\nSINGLISH OVERRIDE — this language takes priority over the writing rules above:\n"
                "- The copy MUST be in authentic Singlish throughout (particles, local vocab and grammar as briefed).\n"
                "- Relax rule 1: you do not need a cinematic/sensory literary opening. A natural, colloquial Singlish "
                "hook is better — open the way a Singaporean would actually start the caption.\n"
                "- Keep the energy local and conversational rather than polished/literary, while still hitting the "
                "strategic role and the CTA.\n"
                if language == 'singlish' else ''
            )
            + (
                "\nVIRAL/SOCIAL OVERRIDE — this voice takes priority over the writing rules above:\n"
                "- Ignore the cinematic/sensory literary opening in rule 1. Open with a punchy, casual, "
                "scroll-stopping hook the way a real creator would — a trend format (e.g. 'POV:', "
                "\"it's giving\", 'not me …', 'the way we …') is welcome where it actually fits.\n"
                "- Relax rule 2: it does NOT need to be 2-3 literary paragraphs. Short wins — one to a few "
                "tight lines with line breaks for rhythm is ideal.\n"
                "- Keep it conversational, human and a little funny — never polished/literary. Drop corporate "
                "phrasing entirely.\n"
                "- Still weave the brand in naturally and keep the CTA, just in a fully casual voice.\n"
                if language == 'viral' else ''
            )
            + (
                f"\nPLATFORM PLAYBOOK — {spec['name']} (follow exactly):\n"
                f"- Length: {spec['limit']}\n"
                f"- Hook: {spec['hook']}\n"
                f"- Structure: {spec['structure']}\n"
                f"- CTA style: {spec['cta']}\n"
                f"- Hashtags on this platform: {spec['hashtags']}\n"
            )
            + (
                f"\nTARGET LENGTH: aim for about {word_count}, but never exceed the platform hard cap above.\n"
                if word_count else f"\nTARGET LENGTH: {length_directive}\n"
            )
            + (
                "\nHASHTAGS: none — return an empty hashtags array and include no hashtags in the caption.\n"
                if ht_placement == 'none' else
                "\nHASHTAGS: provide them in the hashtags array for posting as the FIRST COMMENT. Do NOT put hashtags inside the caption text itself.\n"
                if ht_placement == 'first-comment' else
                "\nHASHTAGS: provide them in the hashtags array AND include them inline at the end of the caption text, per the platform norm above.\n"
            )
            + (
                "\nEMOJIS: Use emojis throughout the caption — scatter them naturally in the copy to enhance tone and energy. This is required.\n"
                if f.get('emojis') == 'yes' else
                "\nEMOJIS: Do NOT use any emojis anywhere in the caption.\n"
            )
            + (f"\nHOOK STYLE (overrides the variation angle for line one): {hook_directive}\n" if hook_directive else "")
            + (
                "\nVISUAL: One or more images for THIS post are attached. Look at them and write copy that genuinely "
                "fits what is shown — reference real visual details, mood, and subject. Do not contradict the image.\n"
                if has_images else ""
            )
            + (
                "\nGROUNDING: use only facts, figures, prices, and offers that appear in this brief, the attachments, "
                "or the image. Never invent statistics, claims, or promotions. Honour every Constraint / Mandatory exactly. "
                "Avoid em dashes (—); use commas or full stops instead.\n"
            )
            + (
                f"\nBRAND NAME LOCK — HIGHEST PRIORITY, overrides all styling rules above: write the brand name "
                f"EXACTLY as \"{f.get('brandName')}\" every single time it appears — identical capitalisation, "
                "spacing, and punctuation, character for character. Do NOT lowercase it, change its capitalisation, "
                "split or join its words, or restyle it, even when the caption otherwise uses lowercase or all-caps "
                "styling. The brand name is a proper noun and keeps its exact form always.\n"
                if f.get('brandName') else ''
            )
            + "\n" + _luxury_output_contract(spec)
        )
        return system, user

    elif action == 'caption_critic':
        # Comparative critic pass: score ALL caption variations against each
        # other for one brief, with an explicit rubric, so the scores are
        # relative and discriminating (not each variation marking its own work).
        f                  = body.get('fields', {})
        captions           = body.get('captions', []) or []
        content_type_label = body.get('contentTypeLabel', 'social post')
        language           = (f.get('language') or '').lower()
        spec               = PLATFORM_SPECS[_platform_key(content_type_label)]

        brief = []
        if f.get('brandName'):    brief.append(f"Brand: {f.get('brandName')}")
        if f.get('coreMessage'):  brief.append(f"Core message: {f.get('coreMessage')}")
        if f.get('subgroups'):    brief.append(f"Audience: {f.get('subgroups')}")
        if f.get('tone'):         brief.append(f"Intended tone: {f.get('tone')}")
        if f.get('pov'):          brief.append(f"Brand POV: {f.get('pov')}")
        brief_str = "\n".join(brief) if brief else "(no extra brief provided — judge on general craft)"

        numbered = "\n\n".join(f"[{i}]\n{str(c)[:1500]}" for i, c in enumerate(captions))

        lang_note = ""
        if language in ('chinese', 'xiaohongshu', 'singlish', 'viral'):
            lang_note = (
                f"\nThese captions are written in a {language} voice — judge them ON THEIR OWN TERMS "
                "(authenticity of that voice counts toward on-brand), not against formal English norms.\n"
            )

        system = (
            "You are a senior social media editor judging caption variations written for ONE brief, "
            f"all for the same {spec['name']}. Score them RELATIVE to each other and be discriminating: "
            "use the full 1-10 range and SPREAD the numbers — never bunch everything at 7-9. If two are "
            "close, still break the tie. Judge only what is written; do not rewrite or suggest edits."
        )
        user = (
            "BRIEF CONTEXT:\n" + brief_str + "\n"
            + lang_note
            + f"\nPLATFORM: {spec['name']}. Hook rule: {spec['hook']}\n\n"
            "Score each variation 1-10 on three dimensions, using these anchors "
            "(1-3 = weak/generic, 4-6 = competent, 7-8 = strong, 9-10 = exceptional):\n"
            "- hookStrength: does the FIRST line stop the scroll and pull the reader in?\n"
            "- readability: how easily it scans on a phone — sentence length, rhythm, clarity.\n"
            "- onBrand: fit to the brand voice, core message, audience and platform above.\n\n"
            "VARIATIONS:\n" + numbered + "\n\n"
            "Return ONLY this JSON object — no markdown fences, no prose before or after:\n"
            '{ "scores": [ { "index": <int matching the [n] label>, "hookStrength": <1-10>, '
            '"readability": <1-10>, "onBrand": <1-10>, "note": "<reason, max 12 words>" } ], '
            '"winner": <index of the single strongest overall>, "winnerReason": "<max 20 words>" }\n'
            "Include exactly one scores entry per variation. All values must be valid JSON."
        )
        return system, user

    elif action == 'serp_analysis':
        serp_results  = body.get('serpResults', [])
        target_domain = body.get('targetDomain', '')
        keyword       = body.get('keyword', '')
        all_keywords  = body.get('allKeywords', [keyword])
        all_kw_label  = ', '.join(all_keywords)
        multi         = len(all_keywords) > 1
        kw_label      = (
            f'keywords "{all_kw_label}" (SERP fetched for primary: "{keyword}")'
            if multi else f'keyword "{keyword}"'
        )
        target_kw   = f'all of the target keywords ({all_kw_label})' if multi else f'"{keyword}"'
        multi_block = (
            f'\nALL TARGET KEYWORDS: {all_kw_label}\n'
            'Optimise recommendations for ALL target keywords, not just the primary one.\n'
        ) if multi else ''

        system = (
            "You are an expert SEO strategist specializing in SERP analysis and competitive intelligence."
        )
        user = (
            f"Analyse the following top {len(serp_results)} Google SERP results for the {kw_label} "
            "and provide a SERP competitor analysis with URL mapping recommendation.\n\n"
            f"TARGET DOMAIN (our site): {target_domain}\n"
            f"{multi_block}"
            f"SERP RESULTS:\n{json.dumps(serp_results, indent=2)}\n\n"
            "YOUR TASKS:\n"
            '1. For each SERP result, classify its page_type as one of: "blog", "service", "product", '
            '"homepage", "category", "other". Root domain URLs MUST be classified as "homepage".\n'
            "2. Identify the competitor with the LOWEST domain authority (DA) ranking in the top 20.\n"
            f'3. On the target domain "{target_domain}", determine the most relevant existing URL that could rank '
            f"for {target_kw}. If none exists, suggest creating a new page.\n"
            '4. If suggesting a new page, classify it as: "Blog Page", "Service Page", or "Product Page" '
            "based on keyword intent.\n\n"
            "Return ONLY valid JSON in this exact format:\n"
            "{\n"
            '  "serp_results": [\n'
            '    { "rank": 1, "url": "...", "title": "...", "description": "...", "da": 0, '
            '"page_type": "blog|service|product|homepage|category|other" }\n'
            "  ],\n"
            '  "recommendation": {\n'
            '    "target_url": "<URL on target domain or suggested new URL path>",\n'
            '    "existing_or_new": "Existing|New",\n'
            '    "suggested_page_type": "Blog Page|Service Page|Product Page|N/A",\n'
            '    "weakest_competitor": { "url": "...", "da": 0, "page_type": "..." },\n'
            '    "rationale": "<explanation>",\n'
            '    "suggested_improvements": "<SEO/content recommendations>"\n'
            "  }\n"
            "}"
        )
        return system, user

    elif action == 'content_outline':
        topic           = body.get('topic', '')
        keyword         = body.get('keyword', '')
        page_type       = body.get('pageTypeContext', 'Any')
        persona_context = body.get('personaContext', '')
        deep_compare    = body.get('deepCompareContext', '')
        selected_topics = body.get('selectedTopics', '')
        target_wc       = _safe_int(body.get('targetWordCount', 0), 0)
        locale          = body.get('locale', 'Global')
        wc_block = (
            f"⚠️ MANDATORY TARGET WORD COUNT: {target_wc} words. You MUST plan enough sections and depth "
            f"to achieve this word count. Each section should average ~{round(target_wc / 8)} words. "
            "If the target is high, add more H2 sections and deeper H3 sub-topics. This is a hard requirement.\n"
        ) if target_wc > 0 else ''
        persona_block = (
            "THE OUTLINE MUST BE SPECIFICALLY TAILORED TO THESE PERSONAS "
            "(internal targeting context only — never name or analyse a persona in the article):\n"
            f"{persona_context}\n"
        ) if persona_context else ''
        # Research, compliance, house rules and the classified search intent are
        # INPUTS to the brief, not a layer applied after the draft exists.
        editorial_rules  = body.get('editorialRules', '')
        intent_brief     = body.get('intentBrief', '')
        compliance_instr = body.get('complianceInstruction', '')

        system = (
            "You are an expert SEO content strategist specializing in structured article outlines "
            "optimized for search and E-E-A-T signals."
        )
        user = (
            "Generate a structured article outline (H1, H2, H3) for the following topic and keyword.\n"
            f"TARGET PAGE TYPE: {page_type}\n"
            f"{intent_brief}"
            f"{persona_block}"
            f"{compliance_instr}\n"
            f"{deep_compare}\n"
            f"PRIORITIZE INCLUDING THESE CHERRY-PICKED TOPICS IDENTIFIED FROM COMPETITOR RESEARCH:\n{selected_topics}\n\n"
            f'TOPIC: "{topic}"\n'
            f'PRIMARY KEYWORD: "{keyword}"\n\n'
            f"{wc_block}"
            f"{_author_pov_block(body)}"
            "INSTRUCTIONS:\n"
            "1. Ensure the outline is unique and high-value.\n"
            "2. Cover the cherry-picked topics comprehensively.\n"
            "3. Account for EEAT principles.\n"
            '4. Include a single consolidated "Frequently Asked Questions (FAQ)" as the LAST H2 section '
            "with 4-6 relevant questions as H3 sub-items. Do NOT scatter FAQ-style content across other sections.\n"
            "5. The Conclusion/Summary section MUST be the SECOND-TO-LAST H2, appearing right before the FAQ. "
            "Do NOT place any conclusion/wrap-up content in the middle of the outline.\n"
            "6. Output in a clear, editable text format.\n"
            "7. Every H2 must be unique. Do not plan two sections that cover the same ground, "
            "and do not plan a second introduction.\n"
            "8. Plan the article to open with, in this order: H1, Author Bio, Published Date, "
            "AI Summary, Table of Contents. Do not write those blocks yourself, just leave room for them.\n\n"
            f"{editorial_rules}\n"
            f'LOCALE: "{locale}"\n'
            "Write content nuanced for this locale: use local spelling, terminology, cultural references, "
            "and units of measurement."
        )
        return system, user

    elif action == 'content_section':
        topic               = body.get('topic', '')
        primary_keyword     = body.get('primaryKeyword', '')
        secondary_keywords  = body.get('secondaryKeywords', '')
        page_type           = body.get('pageTypeContext', 'Any')
        persona_instruction = body.get('personaInstruction', '')
        compliance_instr    = body.get('complianceInstruction', '')
        deep_compare        = body.get('deepCompareContext', '')
        outline             = body.get('outline', '')
        recent_content      = body.get('recentContent', '')
        section_header      = body.get('sectionHeader', '')
        section_context     = body.get('sectionContext', '')
        ref_urls            = body.get('refUrls', '')
        section_target      = _safe_int(body.get('sectionTarget', 0), 0)
        total_target        = _safe_int(body.get('totalTarget', 0), 0)
        section_index       = _safe_int(body.get('sectionIndex', 0), 0)
        total_sections      = _safe_int(body.get('totalSections', 1), 1) or 1
        editorial_rules     = body.get('editorialRules', '')
        intent_brief        = body.get('intentBrief', '')
        used_headings       = body.get('usedHeadings') or []
        used_block = (
            "HEADINGS ALREADY WRITTEN IN THIS ARTICLE (never repeat one, and never write an H1 again):\n"
            + "\n".join(f"- {h}" for h in used_headings[:60]) + "\n\n"
        ) if used_headings and section_index > 0 else ''
        wc_block = (
            f"⚠️ MANDATORY WORD COUNT REQUIREMENT: You MUST write AT LEAST {section_target} words for "
            f"this section (section {section_index + 1} of {total_sections}). "
            f"The total article target is {total_target} words. "
            "This is a HARD MINIMUM — if your output is shorter, it will be rejected and you will be asked to rewrite. "
            "Write comprehensive, in-depth content to meet this target. "
            "Do NOT pad with filler — add genuine depth, examples, analysis, and detail.\n"
        ) if section_target > 0 else ''

        retry_text       = body.get('retryText', '')
        retry_word_count = _safe_int(body.get('retryWordCount', 0), 0)

        system = (
            "You are an expert SEO content writer creating high-quality, "
            "E-E-A-T optimized article sections."
        )
        base_user = (
            "Generate only the following section of a comprehensive, structured SEO article.\n"
            f"TARGET PAGE TYPE: {page_type}\n"
            f'TOPIC: "{topic}"\n'
            f'PRIMARY KEYWORD: "{primary_keyword}"\n'
            f'SECONDARY KEYWORDS: "{secondary_keywords}"\n'
            f"{intent_brief}"
            f"{compliance_instr}{persona_instruction}\n"
            f"{deep_compare}\n\n"
            f"{wc_block}"
            f"FULL APPROVED OUTLINE (FOR FLOW CONTEXT):\n{outline}\n\n"
            f"{used_block}"
            "PREVIOUSLY WRITTEN CONTENT (DO NOT REPEAT, USE FOR TRANSITION):\n"
            f"{recent_content or 'None (This is the start of the article)'}\n\n"
            f"CURRENT SECTION TO WRITE:\n{section_header}\n{section_context}\n\n"
            f"REFERENCE URLS (IF APPLICABLE):\n{ref_urls or 'None provided'}\n\n"
            f"{_author_pov_block(body)}"
            "CRITICAL CONTENT GUIDELINES (EEAT):\n"
            "1. EXPERIENCE (E): Write with a first-person perspective or direct experience.\n"
            "2. EXPERTISE (E): Provide deep, focused coverage of the intent.\n"
            "3. AUTHORITATIVENESS (A): Reference credible sources (placeholders like [Source: Name]).\n\n"
            "OUTPUT HYGIENE (publishable content ONLY):\n"
            "- Return ONLY the finished, publishable article prose for this section.\n"
            "- Convert headings into real Markdown headings (## / ###). NEVER print "
            "the literal label 'H1:', 'H2:', 'H3:' before a heading.\n"
            "- NEVER include editorial or meta text such as 'Word Count:', "
            "'Target Word Count', 'Section X of Y', 'Meta Description', 'Slug', or "
            "notes about hitting the word target. These are instructions to you, "
            "not content for the reader — the word count is an internal target and "
            "must not appear anywhere in your output.\n"
            "- Write THIS section only, once. Never restart the article: no H1, no fresh "
            "introduction to the topic, no heading that already exists in the outline above.\n"
            f"{editorial_rules}"
        )
        if retry_text:
            user = (
                f"Your previous output for this section was only {retry_word_count} words, "
                f"which is below the required minimum of {section_target} words.\n\n"
                "Please REWRITE and EXPAND this section to meet the word count target. "
                "Add more depth, examples, analysis, case studies, and detail. "
                "Do NOT simply pad — add genuinely useful content.\n\n"
                f"Your previous output:\n{retry_text}\n\n---\n\nOriginal instructions:\n{base_user}"
            )
        else:
            user = base_user
        return system, user

    elif action == 'content_polish':
        full_content    = body.get('fullContent', '')
        editorial_rules = body.get('editorialRules', '')
        system = (
            "You are an expert editor specializing in harmonizing AI-generated SEO articles "
            "into polished, cohesive content."
        )
        user = (
            "Below is a raw, section-by-section generated SEO article. "
            "It may contain redundant headers, repetitive introductions, or disjointed transitions "
            "due to the partitioned generation process.\n\n"
            "TASK:\n"
            "1. Harmonise the tone across the entire article.\n"
            '2. Remove redundant introductory phrases (e.g. "Definition and Importance" repeated across sections).\n'
            "3. Ensure logical transitions between sections.\n"
            "4. Keep all original information, but refine the formatting (Markdown H1, H2, H3) to be consistent and clean.\n"
            '5. Fix any "frankenstein" characteristics where paragraphs feel disconnected.\n'
            "6. Merge any section that restarts the article: keep ONE H1 and ONE introduction, "
            "and if the same H2 appears twice, merge the two blocks into a single section. "
            "Every H2 in the returned article must be unique.\n"
            "7. Delete any internal reasoning that leaked into the copy: paragraphs opening with "
            '"Rationale:", "Reasoning:", "Why this works:", editor notes, or persona analysis.\n'
            "8. Do not add facts, laws, statistics or regulator names that are not already in the draft.\n"
            "9. Return ONLY the final polished Markdown article.\n\n"
            f"{editorial_rules}\n"
            f"RAW ARTICLE CONTENT:\n{full_content}"
        )
        return system, user

    elif action == 'strategy_url_research':
        input_val     = body.get('input', '')
        is_url        = '.' in input_val or input_val.startswith('http')
        canonical_url = (
            (input_val if input_val.startswith('http') else 'https://' + input_val)
            if is_url else None
        )
        system = (
            "You are an expert SEO researcher analyzing companies and websites "
            "to build accurate SEO profiles."
        )
        scraped = body.get('_scraped_content')
        if scraped:
            user = (
                f"Below is the actual text content scraped live from {canonical_url}. "
                "Base the profile ONLY on this content — do not guess or substitute a "
                "different company.\n\n"
                f"PAGE CONTENT:\n\"\"\"\n{scraped[:80000]}\n\"\"\"\n\n"
                "Return ONLY a valid JSON object (no markdown, no explanation):\n"
                "{\n"
                '  "client_profile": "Exact industry and core offerings from the content",\n'
                '  "target_audience": "Key customer personas based on the content",\n'
                '  "market_context": "Main competitors and market trends for this specific business",\n'
                '  "objectives": ["lead_generation","brand_authority","local_visibility",'
                '"ecommerce_revenue","service_enquiries","niche_dominance"],\n'
                '  "seed_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",\n'
                '  "top_competitor_domains": ["domain1.com","domain2.com","domain3.com","domain4.com","domain5.com"],\n'
                '  "seo_keywords": ["primary keyword 1","primary keyword 2","primary keyword 3"]\n'
                "}"
            )
            return system, user
        if canonical_url:
            user = (
                f"Go to {canonical_url} and read the page. Based ONLY on what you find at that exact URL, "
                "fill in this SEO profile. Do not guess or substitute a different company.\n"
                "Return ONLY a valid JSON object (no markdown, no explanation):\n"
                "{\n"
                '  "client_profile": "Exact industry and core offerings from the site",\n'
                '  "target_audience": "Key customer personas based on site content",\n'
                '  "market_context": "Main competitors and market trends for this specific business",\n'
                '  "objectives": ["lead_generation","brand_authority","local_visibility",'
                '"ecommerce_revenue","service_enquiries","niche_dominance"],\n'
                '  "seed_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",\n'
                '  "top_competitor_domains": ["domain1.com","domain2.com","domain3.com","domain4.com","domain5.com"],\n'
                '  "seo_keywords": ["primary keyword 1","primary keyword 2","primary keyword 3"]\n'
                "}"
            )
        else:
            user = (
                f'Research the company "{input_val}" and build an accurate SEO profile.\n'
                "Return ONLY a valid JSON object (no markdown, no explanation):\n"
                "{\n"
                '  "client_profile": "Specific industry and core offerings",\n'
                '  "target_audience": "Key customer personas",\n'
                '  "market_context": "Main competitors and market trends",\n'
                '  "objectives": ["lead_generation","brand_authority","local_visibility",'
                '"ecommerce_revenue","service_enquiries","niche_dominance"],\n'
                '  "seed_keywords": "keyword1, keyword2, keyword3, keyword4, keyword5",\n'
                '  "top_competitor_domains": ["domain1.com","domain2.com","domain3.com","domain4.com","domain5.com"],\n'
                '  "seo_keywords": ["primary keyword 1","primary keyword 2","primary keyword 3"],\n'
                "  \"client_website\": \"the company's primary website domain e.g. example.com\"\n"
                "}"
            )
        return system, user

    elif action == 'smm_report':
        report_data    = body.get('reportData', '')
        report_period  = (body.get('reportPeriod') or '').strip()
        brand_name     = (body.get('brandName') or '').strip()
        additional_ctx = (body.get('additionalContext') or '').strip()
        language       = body.get('language', 'UK English')

        system = (
            "You are a senior social media strategist with over 15 years of experience in "
            "social media analytics, content strategy and performance reporting. "
            "You write client-ready reports that are polished, analytical and constructive."
        )

        brand_prefix  = (brand_name + " ") if brand_name else ""
        ctx_block     = ("Additional context: " + additional_ctx + "\n\n") if additional_ctx else ""
        cover_period  = ("<p>" + report_period + "</p>") if report_period else ""
        plat_period   = ('<p class="period">' + report_period + "</p>") if report_period else ""

        # When the client rasterises the report to page images, the figures are
        # read straight off the dashboard rather than from a flattened (and often
        # scrambled) text dump. Otherwise we fall back to the extracted text.
        data_block = (
            ("REPORT DATA:\n" + report_data) if report_data.strip()
            else "The report pages are attached above as images. Base your analysis solely on them."
        )

        user = (
            "Refer closely to the attached social media performance report and review all available "
            "data before writing the analysis. Do not make assumptions beyond the data provided. "
            "Where data is missing or unclear, note it professionally.\n\n"
            "NUMBER ACCURACY (critical): Read every metric directly from the report and reproduce each "
            "figure EXACTLY as shown, including its suffix (K, X, %) and any +/- sign. These dashboards "
            "use a COMMA as the decimal separator, not a thousands separator: '5,28K' means 5.28 thousand "
            "(≈5,280), '92,26K' means ≈92,260, '5,72%' means 5.72 percent, and '1,73X' means 1.73. "
            "Never reinterpret the comma as a thousands separator and never inflate a value's magnitude "
            "(e.g. do NOT turn '5,28K' into 528,000 or '5,72%' into 572%). A small percentage like '-22%' "
            "next to a metric is a period-over-period change, not the metric's value. Do not invent, "
            "estimate, or round away any number that is not visible in the report; if a figure is unclear, "
            "say so rather than guessing.\n\n"
            "DELTAS vs RATES (critical): A +/- percentage shown beside a SUB-metric is the period-over-period "
            "change in THAT sub-metric's own count, never the page's overall rate. For example "
            "'Followers increase 56 -19%' means the number of new followers fell 19% versus the prior period; "
            "it is NOT the follower growth rate. The follower growth rate is the percentage shown on the main "
            "Followers figure (e.g. '3,02K +2%' = +2% growth). Never describe a negative sub-metric delta as a "
            "'positive growth rate' or attach it to the wrong metric.\n\n"
            "DIRECTION CHECK (critical): Before you describe any metric, confirm the SIGN of its change. A value "
            "marked with a '+' (or shown in green / with an up arrow / no minus sign) has INCREASED; a value marked "
            "with a '-' (or shown in red / with a down arrow) has DECREASED. Never call a '+' change a decline, and "
            "never call a '-' change growth. A rise is an increase even when the number is small; a fall is a decrease. "
            "Re-read the sign for EVERY metric before writing the sentence about it — getting the direction backwards "
            "is the single worst error in this report.\n\n"
            "PERCENTAGE DISPLAY (critical): Quote the change percentage ONLY when the metric has INCREASED "
            "(e.g. 'followers grew +12% this period'). When a metric has DECREASED, do NOT print a bare negative "
            "percentage; instead describe the movement in words and frame it constructively — note the likely driver, "
            "the wider context and the opportunity to recover (e.g. 'reach eased slightly versus last period, a common "
            "seasonal dip that the next content push can rebuild'). Never open a sentence with a negative number.\n\n"
            "COVERAGE: In Page Reach, report the Impressions figure (with its change) alongside reach, paid "
            "reach, frequency and profile views whenever it is present in the data.\n\n"
            "Craft a clear, polished and client-ready social media performance report in " + language + ". "
            "The tone must be positive, constructive and professional, while still being analytical and useful. "
            "Lead with what is working; when a metric is down, treat it as context for an opportunity rather than a "
            "failure, and keep every decline framed around the path to improvement.\n\n"
            "STRUCTURE:\n"
            "For EACH platform found in the data, write a separate platform section containing:\n\n"
            "1. Followers\n"
            "   Analyse follower growth. Highlight positive growth trends, audience interest and what this "
            "may suggest about brand awareness or community-building performance.\n\n"
            "2. Page Reach\n"
            "   Analyse reach performance and visibility. Explain what the reach numbers suggest about "
            "content distribution, audience exposure and platform performance.\n\n"
            "3. Post Engagement / Engagement Rate\n"
            "   Analyse engagement performance, including likes, comments, shares, saves, clicks or any "
            "available metrics. Explain what the engagement rate indicates about audience relevance and "
            "content resonance.\n\n"
            "4. Content Performance\n"
            "   Review the best-performing and weaker-performing content. Identify what content themes, "
            "formats, topics or creative styles appear to be working best. Consider how user behaviour "
            "may differ across each platform.\n\n"
            "5. Key Insights\n"
            "   Summarise the main takeaways in proper sentences. Focus on what the data tells us about "
            "audience behaviour, content effectiveness and platform opportunities.\n\n"
            "RECOMMENDATIONS (after section 5, not numbered):\n"
            "Provide practical, strategic bullet-point recommendations covering:\n"
            "- Content creation improvements\n"
            "- Content formats to prioritise\n"
            "- Posting approach or frequency, if relevant\n"
            "- Platform-specific opportunities\n"
            "- Current social media trends relevant to the brand\n"
            "- Ways to improve reach, engagement and follower growth\n\n"
            "End the entire report with a 'Thank You.' closing.\n\n"
            "WRITING RULES:\n"
            "- Use proper sentences, not overly short bullet points (except in Recommendations)\n"
            "- Keep tone positive and constructive; avoid generic statements unless clearly supported\n"
            "- Show a change percentage only when the metric increased; describe decreases in words, never as a bare negative %\n"
            "- Double-check the up/down direction of every metric before stating it\n"
            "- Do not overstate performance if data does not support it\n"
            "- Write in " + language + " throughout\n"
            "- Keep it polished, concise and presentation-ready\n"
            "- Avoid em dashes (—); use commas, full stops, or short sentences instead\n\n"
            "HTML FORMAT — output this exact structure:\n"
            '<div class="smm-cover"><h1>' + brand_prefix + 'Social Media Report</h1>' + cover_period + '</div>\n\n'
            "Then for each platform:\n"
            '<div class="smm-platform">\n'
            '<h2 class="platform-title">' + brand_prefix + '[Platform Name]</h2>\n'
            + plat_period + '\n'
            '<h3 class="analysis-header">[PLATFORM] ANALYSIS &amp; RECOMMENDATIONS</h3>\n'
            "<h4>1. Followers</h4><p>...</p>\n"
            "<h4>2. Page Reach</h4><p>...</p>\n"
            "<h4>3. Post Engagement / Engagement Rate</h4><p>...</p>\n"
            "<h4>4. Content Performance</h4><p>...</p>\n"
            "<h4>5. Key Insights</h4><p>...</p>\n"
            "<h4>Recommendations</h4><ul><li><strong>Title</strong> — explanation.</li></ul>\n"
            "</div>\n\n"
            'End with: <div class="smm-thank-you"><p>Thank You.</p></div>\n\n'
            "Do NOT include <!DOCTYPE>, <html>, <head>, <body>, or <style> tags. "
            "Return ONLY the inner HTML fragment.\n\n"
            + ctx_block
            + data_block
        )
        return system, user

    elif action == 'image_alt_rationale':
        images             = body.get('images', [])
        primary_keyword    = body.get('primary_keyword', '')
        secondary_keywords = body.get('secondary_keywords', '')
        ranked_keywords    = body.get('ranked_keywords', [])
        page_context       = body.get('page_context', '')

        def _esc(v):
            return str(v if v is not None else '').replace('"', "'")

        ranked_kw_str = ', '.join(_esc(k) for k in ranked_keywords) if ranked_keywords else 'N/A'

        image_list = '\n'.join(
            'id={i} | current_alt: "{c}" | proposed_alt: "{p}" | already_optimised: {ao} | ranked_keyword: "{rk}" | image_url: "{u}"'.format(
                i=img.get('id', idx),
                c=_esc(img.get('current_alt', '')),
                p=_esc(img.get('proposed_alt', '')),
                ao='true' if img.get('already_optimised') else 'false',
                rk=_esc(img.get('ranked_keyword', '')),
                u=_esc(img.get('image_url', ''))
            )
            for idx, img in enumerate(images)
        )

        system = (
            "You are an SEO and web-accessibility expert reviewing image alt text. "
            "You explain, concisely and concretely, why a proposed alt text is an "
            "improvement for both accessibility (screen readers) and SEO , or why an "
            "existing alt text was deliberately left unchanged."
        )
        user = (
            "For each image below you are given its CURRENT alt text (may be empty), a "
            "PROPOSED alt text, an ALREADY_OPTIMISED flag, and (if applicable) the "
            "RANKED_KEYWORD the current alt already targets.\n\n"
            f"PAGE CONTEXT: {page_context or 'N/A'}\n"
            f"PRIMARY KEYWORD: {primary_keyword or 'N/A'}\n"
            f"SECONDARY KEYWORDS: {secondary_keywords or 'N/A'}\n"
            f"KEYWORDS THIS PAGE ALREADY RANKS FOR: {ranked_kw_str}\n\n"
            f"IMAGES:\n{image_list}\n\n"
            "For each image, write ONE specific sentence (max ~30 words):\n"
            "- If already_optimised is true: explain that the current alt text was kept UNCHANGED "
            "because it already targets the ranking keyword (name it), so altering it could weaken "
            "an existing ranking. Do NOT propose changes for these.\n"
            "- Otherwise: explain why the proposed alt is better, grounded in the actual difference "
            "between current and proposed (e.g. 'was empty', 'was a filename', 'lacked the subject', "
            "'now describes X and includes the keyword naturally'). Mention a keyword ONLY if the "
            "proposed alt genuinely and naturally uses it; never claim keyword usage that isn't there.\n"
            "Do NOT be generic or repeat the same sentence. If current and proposed are effectively "
            "identical (and not already_optimised), say the existing alt is already appropriate and "
            "needs no change.\n\n"
            "Return ONLY a JSON array (no markdown), each item having:\n"
            '  - "id": the integer image index exactly as given above (e.g. 0, 1, 2 , a bare number, not "[0]")\n'
            '  - "rationale": your one-sentence explanation\n\n'
            "Return ONLY the JSON array, no other text."
        )
        return system, user

    elif action == 'topic_extract':
        # Stage 2 of the Topic Selection pipeline. From ONE competitor page (already
        # scraped to text on the client), pull the subtopics a page legitimately ABOUT
        # the central entity would cover — tagged with intent + funnel stage. The
        # central-entity anchor is what keeps boilerplate/tangents out.
        central_entity = (body.get('central_entity') or '').strip()
        source_url     = (body.get('source_url') or '').strip()
        page_content   = (body.get('content') or body.get('page_html') or '')
        # Bound the page text so one long competitor page can't blow the window.
        if len(page_content) > 18000:
            page_content = page_content[:18000]
        system = (
            "You are a semantic SEO strategist extracting the topical building blocks of a page. "
            "You work for a digital marketing agency building a topical map around a central entity."
        )
        user = (
            f"CENTRAL ENTITY (the topic the target page will be about): \"{central_entity}\"\n"
            f"SOURCE URL (a competitor ranking page): {source_url or 'n/a'}\n\n"
            "COMPETITOR PAGE CONTENT (scraped text):\n"
            f"\"\"\"\n{page_content}\n\"\"\"\n\n"
            "Extract the distinct SUBTOPICS this page covers that a page genuinely about the "
            "central entity could legitimately include. RULES:\n"
            "- Only subtopics that ladder up to the central entity. If a block is unrelated to the "
            "central entity, DROP it — do not include it just because it is on the page.\n"
            "- IGNORE navigation, footer, cookie/consent text, author bios, boilerplate, CTAs, ads, "
            "and pure brand/marketing fluff.\n"
            "- Merge near-duplicates into one canonical term.\n"
            "- For each subtopic tag its dominant search intent and funnel stage.\n"
            "- Prefer 8-25 high-quality subtopics over an exhaustive dump.\n\n"
            "Return a JSON object with a \"candidates\" array; each item:\n"
            '  - "term": short canonical subtopic label (2-6 words)\n'
            '  - "intent": one of "informational","commercial","transactional","navigational"\n'
            '  - "funnel": one of "awareness","consideration","decision"\n'
            '  - "heading_level": "h1"|"h2"|"h3"|"body" (best guess of where it sat)\n'
            '  - "entities": array of 1-5 key entities/nouns the subtopic is about\n'
        )
        return system, user

    elif action == 'topic_hierarchy':
        # Stage 6. Given the FILTERED, anchored, scored topics, build the pillar>cluster>
        # supporting tree. Hard contract: every node must justify why it belongs, or it
        # goes to rejected[] — this is the anti-"rojak" lever.
        central_entity = (body.get('central_entity') or '').strip()
        source_context = (body.get('source_context') or '').strip()
        topics         = body.get('topics') or []
        if len(topics) > 120:
            topics = topics[:120]
        topic_lines = '\n'.join(
            '- term："{t}" | intent:{i} | bucket:{b} | relevance:{r}'.format(
                t=(tp.get('term') or ''),
                i=(tp.get('intent') or 'informational'),
                b=(tp.get('bucket') or 'table_stakes'),
                r=(tp.get('relevance') if tp.get('relevance') is not None else '')
            ) for tp in topics if isinstance(tp, dict)
        )
        system = (
            "You are a semantic SEO architect turning a filtered set of subtopics into a coherent "
            "topical map (content hierarchy) around a single central entity. Coherence matters more "
            "than coverage: a tight, logical tree beats a large incoherent one."
        )
        user = (
            f"CENTRAL ENTITY: \"{central_entity}\"\n"
            f"SOURCE CONTEXT (who the site is / its angle): {source_context or 'n/a'}\n\n"
            "CANDIDATE SUBTOPICS (already filtered for relevance; higher relevance = closer to the "
            f"central entity):\n{topic_lines}\n\n"
            "Build a topical hierarchy: ONE pillar (the central entity), then cluster nodes, then "
            "supporting nodes under clusters. HARD RULES:\n"
            "- Every node MUST have a non-empty \"why_belongs\" that justifies its link to its parent "
            "and to the central entity. If you cannot justify a candidate's place, DO NOT force it "
            "into the tree — put it in \"rejected\" with a reason instead.\n"
            "- Do not invent subtopics that aren't supported by the candidates (you MAY merge/rename "
            "for clarity).\n"
            "- Keep intents coherent: don't graft a transactional node under an informational cluster "
            "unless the relationship is real; note it in why_belongs if you do.\n"
            "- Assign each node a content_type: \"pillar\"|\"cluster\"|\"section\".\n\n"
            "Return a JSON object:\n"
            '  - "pillar": { "title": string, "central_entity": string }\n'
            '  - "nodes": array of { "id","title","parent_id"(null for pillar),"intent",'
            '"bucket","relevance"(number|null),"why_belongs","content_type" }\n'
            '  - "rejected": array of { "term","reason" }\n'
        )
        return system, user

    elif action == 'author_extract':
        # Build a factual author profile from crawled bio text (LinkedIn/about/site).
        # Facts only — the model must NOT invent credentials; blanks are fine.
        content   = (body.get('content') or '')
        name_hint = (body.get('name_hint') or '').strip()
        src       = (body.get('source_url') or '').strip()
        if len(content) > 16000:
            content = content[:16000]
        system = (
            "You are building a factual author profile for E-E-A-T authorship. You extract ONLY what "
            "the provided text supports — you never invent experience, employers, years, or awards."
        )
        user = (
            (f"NAME HINT (the person we're profiling): \"{name_hint}\"\n" if name_hint else "")
            + f"SOURCE: {src or 'n/a'}\n\n"
            "CRAWLED BIO / PROFILE TEXT:\n"
            f"\"\"\"\n{content}\n\"\"\"\n\n"
            "Extract a factual author profile. RULES:\n"
            "- Use ONLY facts supported by the text. If something isn't stated, leave it blank/empty — "
            "do NOT guess years of experience, employers, clients, or awards.\n"
            "- `signature_pov`: 3-6 SHORT first-person point-of-view lines this author could truthfully "
            "say, grounded strictly in the extracted facts (e.g. \"In my years working in search, I keep "
            "seeing...\"). These are angles a writer can weave into articles — not fabricated anecdotes.\n"
            "- `voice_notes`: one line on how this person writes/speaks (tone, register) if inferable.\n"
            "- `credibility_summary`: a 1-2 sentence author bio suitable for a byline / author schema.\n\n"
            "Return a JSON object with: name, headline, years_experience (integer or null), location, "
            "expertise[], communities[], achievements[], signature_pov[], voice_notes, credibility_summary."
        )
        return system, user

    return None, None


def _author_pov_block(src):
    """Build the AUTHOR VOICE & POV system block from a user-verified author profile.
    `src` is a dict carrying 'authorProfile' (dict) and 'pov' ({enabled, intensity}).
    Returns '' when there's no profile or POV is disabled.

    This is the sanctioned exception to the constitution's no-first-person rule: first
    person IS allowed here, but ONLY drawing on these user-confirmed facts — never invented."""
    prof = (src or {}).get('authorProfile') or {}
    pov  = (src or {}).get('pov') or {}
    if not prof or not pov.get('enabled', False):
        return ''
    name = (prof.get('name') or '').strip()
    expertise = prof.get('expertise') or []
    if not name and not expertise:
        return ''
    intensity = (pov.get('intensity') or 'medium').lower()
    intensity_line = {
        'light':  "INTENSITY: light — one or two subtle first-person touches at most; keep it mostly neutral.",
        'medium': "INTENSITY: medium — weave the author's lens into a few natural places where it adds authority.",
        'strong': "INTENSITY: strong — lead with the author's first-person experience and perspective throughout.",
    }.get(intensity, "INTENSITY: medium — weave the author's lens into a few natural places.")
    L = [
        "================================================================",
        "AUTHOR VOICE & POINT OF VIEW (user-verified — first person IS permitted here)",
        "================================================================",
        ("This section is written BY a real, verified author whose credentials are listed below. You "
         "MAY and SHOULD write in this author's first-person voice, weaving their genuine experience "
         "and point of view in where it strengthens authority (the 'Experience' in E-E-A-T). This is "
         "NOT fabrication — these are the author's real, user-confirmed credentials. STRICT RULE: draw "
         "ONLY on the facts listed here; NEVER invent experience, years, clients, employers, or "
         "achievements beyond this list. If a first-person claim isn't supported below, write it in "
         "neutral third person instead."),
    ]
    if name:
        headline = (prof.get('headline') or '').strip()
        L.append(f"AUTHOR: {name}" + (f" — {headline}" if headline else ""))
    yrs = prof.get('years_experience')
    if yrs or expertise:
        L.append("EXPERIENCE: " + (f"{yrs}+ years. " if yrs else "")
                 + ("Expertise: " + ", ".join(expertise) if expertise else ""))
    cred = (prof.get('communities') or []) + (prof.get('achievements') or [])
    if cred:
        L.append("CREDIBILITY: " + "; ".join(cred))
    pov_lines = prof.get('signature_pov') or []
    if pov_lines:
        L.append("POV / ANGLES TO WEAVE IN NATURALLY (don't dump all at once — pick what fits this section):")
        L += [f"  - {p}" for p in pov_lines[:6]]
    voice = (prof.get('voice_notes') or '').strip()
    if voice:
        L.append(f"VOICE: {voice}")
    L.append(intensity_line)
    return "\n".join(L) + "\n\n"


# ── SEO RSS Feed Fetcher ───────────────────────────────────────────────────────

SEO_RSS_FEEDS = [
    ('Search Engine Journal', 'https://www.searchenginejournal.com/feed/'),
    ('Search Engine Land', 'https://searchengineland.com/feed'),
    ('Google Search Central', 'https://developers.google.com/search/blog/rss.xml'),
    ('Moz Blog', 'https://moz.com/blog/feed'),
    ('Ahrefs Blog', 'https://ahrefs.com/blog/feed/'),
    ('SEMrush Blog', 'https://www.semrush.com/blog/feed/'),
    ('Barry Schwartz (RustyBrick)', 'https://www.seroundtable.com/rss.xml'),
]

_NS = {
    'atom': 'http://www.w3.org/2005/Atom',
    'content': 'http://purl.org/rss/1.0/modules/content/',
    'dc': 'http://purl.org/dc/elements/1.1/',
    'media': 'http://search.yahoo.com/mrss/',
}


def _text(el, tag):
    child = el.find(tag)
    return (child.text or '').strip() if child is not None else ''


def _parse_feed_date(date_str):
    """Parse RSS pub date to ISO date string; returns '' on failure."""
    if not date_str:
        return ''
    for fmt in (
        '%a, %d %b %Y %H:%M:%S %z',
        '%a, %d %b %Y %H:%M:%S %Z',
        '%Y-%m-%dT%H:%M:%S%z',
        '%Y-%m-%dT%H:%M:%SZ',
    ):
        try:
            return datetime.strptime(date_str.strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return date_str[:10] if len(date_str) >= 10 else date_str


def handle_topic_score(event):
    """Stage 4 relevance scoring via a DeepSeek judge (no embeddings dependency).
    Input: { anchor: str, items: [str,...] }. Returns { scores: [0..1,...] } aligned to
    items — how topically relevant each item is to the anchor (central entity). Graceful:
    on any failure returns scores:null + error so the client can fall back to the
    model-provided relevance instead of hard-failing the pipeline."""
    anchor = (event.get('anchor') or '').strip()
    items  = event.get('items') or []
    items  = [str(x or '').strip() for x in items][:256]  # bound the batch
    if not anchor or not items:
        return _resp(200, {'scores': None, 'error': 'anchor and items are required'})
    api_key = os.environ.get('DEEPSEEK_API_KEY')
    if not api_key:
        return _resp(200, {'scores': None, 'error': 'DEEPSEEK_API_KEY not configured'})
    numbered = '\n'.join(f'{i}. {t}' for i, t in enumerate(items))
    system = (
        "You are a semantic SEO relevance judge. Given a CENTRAL ENTITY and a numbered list of "
        "candidate subtopics, rate how topically relevant each subtopic is to the central entity "
        "on a 0.0-1.0 scale (1.0 = core subtopic of the entity; 0.0 = unrelated/boilerplate). "
        "Be strict: generic boilerplate (contact, pricing page, about us) scores low even if common."
    )
    user = (
        f"CENTRAL ENTITY: \"{anchor}\"\n\n"
        f"CANDIDATE SUBTOPICS:\n{numbered}\n\n"
        "Return ONLY a JSON object of the form {\"scores\":[{\"i\":0,\"score\":0.83}, ...]} with one "
        "entry per index above, no other text."
    )
    try:
        r = requests.post(
            'https://api.deepseek.com/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json={
                'model': 'deepseek-chat',
                'temperature': 0,
                'response_format': {'type': 'json_object'},
                'messages': [{'role': 'system', 'content': system},
                             {'role': 'user', 'content': user}],
            },
            timeout=120,
        )
        if r.status_code != 200:
            raise RuntimeError(f'DeepSeek HTTP {r.status_code}: {r.text[:300]}')
        txt = r.json()['choices'][0]['message']['content']
        parsed = json.loads(txt)
        raw = parsed.get('scores', parsed if isinstance(parsed, list) else [])
        # Align back to item order; default any missing index to 0.
        by_index = {}
        for row in raw:
            if isinstance(row, dict) and 'i' in row:
                try:
                    by_index[int(row['i'])] = float(row.get('score', 0))
                except (ValueError, TypeError):
                    pass
        scores = [round(max(0.0, min(1.0, by_index.get(i, 0.0))), 4) for i in range(len(items))]
        return _resp(200, {'scores': scores, 'model': 'deepseek-chat', 'count': len(scores)})
    except Exception as e:
        print(f"[aiOptimiser] topic_score failed: {e}")
        return _resp(200, {'scores': None, 'error': str(e)})


def fetch_seo_feeds_handler(event):
    days_back = int(event.get('days_back', 90))
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days_back)
    articles = []

    for source_name, feed_url in SEO_RSS_FEEDS:
        try:
            resp = requests.get(feed_url, timeout=10, headers={'User-Agent': 'Mozilla/5.0'})
            if resp.status_code != 200:
                continue
            root = ET.fromstring(resp.content)

            # Handle both RSS 2.0 (<channel><item>) and Atom (<entry>)
            channel = root.find('channel')
            items = channel.findall('item') if channel is not None else root.findall('{http://www.w3.org/2005/Atom}entry')

            for item in items:
                title = _text(item, 'title') or _text(item, '{http://www.w3.org/2005/Atom}title')
                url = _text(item, 'link') or _text(item, '{http://www.w3.org/2005/Atom}link')
                if not url:
                    link_el = item.find('{http://www.w3.org/2005/Atom}link')
                    url = link_el.get('href', '') if link_el is not None else ''
                pub_date = _text(item, 'pubDate') or _text(item, '{http://www.w3.org/2005/Atom}published')
                description = _text(item, 'description') or _text(item, '{http://www.w3.org/2005/Atom}summary')
                # Strip HTML tags from description
                description = re.sub(r'<[^>]+>', '', description).strip()[:300]

                date_str = _parse_feed_date(pub_date)

                # Filter by cutoff if we can parse the date
                if date_str and len(date_str) == 10:
                    try:
                        item_date = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
                        if item_date < cutoff:
                            continue
                    except ValueError:
                        pass

                if title and url:
                    articles.append({
                        'title': title,
                        'url': url,
                        'source': source_name,
                        'date': date_str,
                        'description': description,
                    })
        except Exception:
            continue

    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Methods': 'OPTIONS,POST',
        },
        'body': json.dumps({'articles': articles}),
    }


# ── OPTIMISER PROMPTS (migrated from client-side index.html) ───────────────────
# These prompts used to be assembled in the browser and sent as a raw `prompt`.
# They are now built here from structured parameters and run through the SAME
# `generate` path, so model behaviour is unchanged — only the string assembly
# moved server-side.

OPTIMISER_PROMPT_ACTIONS = {
    'optimiser_agent', 'content_gap', 'content_rewrite',
    'content_freeform', 'discovery_prompts',
}


def _ctx_block(c):
    """Shared context block injected into every Content Intelligence agent prompt.
    Mirrors the former client-side ctxBlock(c)."""
    c = c or {}
    lines = []
    if c.get('keyword'):        lines.append(f'PRIMARY KEYWORD: "{c["keyword"]}"')
    if c.get('secondary'):      lines.append(f'SECONDARY KEYWORDS:\n{c["secondary"]}')
    if c.get('topic'):          lines.append(f'TOPIC / BRIEF:\n{c["topic"]}')
    if c.get('location'):       lines.append(f'TARGET LOCATION: {c["location"]}')
    if c.get('language'):       lines.append(f'LANGUAGE: {c["language"]}')
    if c.get('pageType'):       lines.append(f'PAGE TYPE: {c["pageType"]}')
    if c.get('personas'):       lines.append(f'TARGET PERSONAS:\n{c["personas"]}')
    if c.get('selectedTopics'): lines.append(f'COMPETITOR TOPICS TO COVER:\n{c["selectedTopics"]}')
    if c.get('compliance'):     lines.append(f'COMPLIANCE REQUIREMENTS:\n{c["compliance"]}')
    if c.get('content'):
        lines.append('CURRENT DRAFT / CONTENT:\n"""\n' + str(c['content'])[:12000] + '\n"""')
    else:
        lines.append('(No draft provided yet - base your analysis on the topic, keyword and competitor context.)')
    return '\n\nCONTEXT:\n' + '\n\n'.join(lines) + '\n'


def _agent_prompt_base(key, c):
    """Return the task prompt string for a Content Intelligence agent, or None."""
    c = c or {}
    ctx = _ctx_block(c)

    if key == 'keyResearcher':
        return (f'Act as an SEO keyword strategist.{ctx}\n'
                'TASK - produce a KEY RESEARCH brief:\n'
                '1. Secondary and semantically related keywords (LSI / entities) to target, grouped by search intent.\n'
                '2. A KEYWORD PLACEMENT MAP: where the primary and secondary keywords should appear (title/H1, H2s, intro, URL slug, meta description, image alt text, anchor text).\n'
                '3. Recommended IMAGE ALT TEXT (3-5 examples) for likely images.\n'
                '4. Internal and external ANCHOR TEXT suggestions (natural, varied, non-spammy) and where to place them.\n'
                'Return concise, actionable Markdown with clear headings.')
    if key == 'marketResearcher':
        return (f'Act as a market and competitive strategist.{ctx}\n'
                'TASK - produce a MARKET RESEARCH brief with these sections:\n'
                '1. RED OCEAN - saturated angles and competitors already ranking for this topic (what everyone already says).\n'
                '2. BLUE OCEAN - underserved angles, gaps and contrarian positioning competitors miss.\n'
                '3. ADDRESSABLE MARKET - who is searching this, rough segments and demand signals.\n'
                '4. TARGET AUDIENCE - define 3 distinct personas (Persona A, B, C) each with goals, pains, objections and the message that converts them.\n'
                'Use the competitor topics and personas above if provided. Return structured Markdown.')
    if key == 'topicGenerator':
        return (f'Act as a content topic strategist.{ctx}\n'
                'TASK - generate a prioritised TOPIC / SUBTOPIC list that (a) covers what competitors rank for and (b) demonstrates E-E-A-T (Experience, Expertise, Authoritativeness, Trust).\n'
                'For each topic give: the angle, which E-E-A-T signal it strengthens, and why it matters for this keyword. Flag topics that need first-hand experience or author/expert credentials. Return a ranked Markdown list.')
    if key == 'factGatherer':
        grounded = (
            '\nYou have LIVE WEB SEARCH available - use it (up to 4 searches) to find CURRENT statistics and '
            'authoritative sources instead of relying on memory. Cite the actual source URL next to every '
            'statistic and reference you provide, and prefer primary sources published in the last 2 years. '
            'Do ALL searching first; only then produce the required output, with nothing before PART 1.'
        ) if c.get('webSearch') else ''
        return (f'Act as a research librarian.{ctx}{grounded}\n'
                'TASK - gather facts to support this content:\n'
                '1. Key statistics, data points and claims worth citing (and the type of source that would back each).\n'
                '2. Authoritative REFERENCES / sources to cite (government, standards bodies, primary research, reputable industry).\n'
                '3. For any draft above, list claims that currently LACK a citation and need one.\n'
                'Flag anything that must be verified before publishing. Return Markdown with a references list.')
    if key == 'povInfo':
        return (f'Act as a content design strategist.{ctx}\n'
                'TASK - propose proprietary INFORMATION ASSETS that present a point of view visually: list specific infographics, comparison TABLES, CHARTS/graphs, checklists or diagrams to create. For each: the title, what data/columns it shows, and where in the article it belongs. Include at least one ready-to-use Markdown TABLE example. Return Markdown.')
    if key == 'pov':
        return (f'Act as an editorial strategist.{ctx}\n'
                'TASK - define the POINT OF VIEW and uniqueness:\n'
                '1. Recommend the voice - FIRST-PARTY (our experience / proprietary data) vs THIRD-PARTY (objective / journalistic) - and where each fits.\n'
                '2. Confirm SEARCH INTENT (informational / commercial / transactional / navigational) and how the content should satisfy it.\n'
                '3. Define the UNIQUE ANGLE / thesis that differentiates this from competitors (what can we say that they cannot).\n'
                'Return Markdown.')
    if key == 'helpfulness':
        return (f'Act as a Google Search quality rater.{ctx}\n'
                "TASK - assess HELPFULNESS against Google's helpful-content guidance. Give a score out of 10 and justify it on: people-first value, satisfying the searcher's goal, depth and originality, demonstrated experience, trustworthiness, and whether the reader leaves feeling they learned enough. List the top concrete improvements that would raise the score. Return Markdown.")
    if key == 'branding':
        brand_tone = c.get('brandTone') or 'Professional'
        return (f'Act as a brand editor.{ctx}\n'
                f'TASK - audit the draft for BRAND consistency: tone of voice, terminology, banned/preferred words, capitalisation of product names, and alignment with the brand tone "{brand_tone}". List specific violations with the offending phrase and a suggested fix. If no draft is provided, give the brand guardrails to follow. Return Markdown.')
    if key == 'legal':
        juris = c.get('jurisdictions') or 'Singapore'
        return (f'Act as a compliance reviewer for jurisdiction "{juris}".{ctx}\n'
                'TASK - review for LEGAL and COMPLIANCE risk against the compliance requirements above and general advertising / consumer-protection norms: unsubstantiated claims, missing disclaimers, guarantees, absolute superlatives, regulated-industry rules. For each issue give severity, the phrase, and the required change. Return Markdown.')
    if key == 'factCheck':
        if c.get('webSearch'):
            return (f'Act as a fact-checker with LIVE WEB SEARCH.{ctx}\n'
                    'TASK - extract every checkable factual claim in the draft, then use web search (up to 4 searches, '
                    'spent on the most consequential claims) to VERIFY them against current authoritative sources. '
                    'Base verdicts on what you actually found, not memory: Verified / Contradicted / Needs Verification '
                    '(could not confirm online). When a claim is contradicted, state the correct value per the source. '
                    'Scrutinise dates, numbers, names and superlatives. Do ALL searching first; only then produce the '
                    'required output, with nothing before PART 1.\n'
                    'Your PART 2 deliverable is ONLY the audit — a Markdown table with columns '
                    'Claim | Verdict | Source | Note, where Source is the exact page URL (https://...) you verified '
                    'against, followed by a short "Verification notes" list. Do NOT write an article, a guide or any '
                    'rewritten/expanded content: you are auditing the draft, not replacing it.')
        return (f'Act as a fact-checker.{ctx}\n'
                'TASK - extract every checkable factual claim in the draft and rate each: Likely Accurate / Needs Verification / Likely Inaccurate, with reasoning and the source that would confirm it. Scrutinise dates, numbers, names and superlatives. Return a Markdown table with columns Claim | Verdict | Note.')
    if key == 'language':
        flesch = c.get('flesch')
        flesch_str = (f'{flesch} ({c.get("fleschLabel", "")})' if flesch is not None else 'not available')
        reading = c.get('readingLevel') or 'Grade 6-8 (Easy)'
        return (f'Act as a plain-language editor.{ctx}\n'
                f'The draft\'s computed Flesch Reading Ease is {flesch_str}; the target reading level is "{reading}".\n'
                'TASK - identify the sentences and paragraphs hurting readability (long sentences, passive voice, jargon) and rewrite the worst offenders more simply. Recommend the changes needed to hit the target reading ease. Return Markdown.')
    if key == 'length':
        wc = c.get('wordCount', 0)
        return (f'Act as a content depth analyst.{ctx}\n'
                f'The current draft is {wc} words.\n'
                'TASK - judge whether the length is SUFFICIENT to fully satisfy the query and match competitor depth (use the competitor topics above). State a recommended word-count range, list sub-topics that are thin or missing, and say where to expand or trim. Return Markdown.')
    if key == 'formatting':
        return (f'Act as a UX content editor.{ctx}\n'
                'TASK - review FORMATTING for scannability: heading usage, paragraph length, bullet / numbered lists, bolding of key terms, intro and summary blocks, white space, and mobile readability. List specific formatting fixes. Return Markdown.')
    if key == 'flow':
        return (f'Act as a developmental editor.{ctx}\n'
                'TASK - evaluate the logical FLOW: does the order of sections build naturally, are transitions smooth, is there repetition or any non-sequitur? Propose a re-ordering if needed and supply 2-3 transition sentences to smooth the roughest joins. Return Markdown.')
    if key == 'hierarchy':
        return (f'Act as an information architect.{ctx}\n'
                'TASK - audit the TOPICAL HIERARCHY: propose a clean H1-H4 outline that groups subtopics logically and signals topical authority and semantic relationships to search engines. Flag heading-level misuse, missing parent topics and orphaned points. Return the recommended heading tree in Markdown.')
    if key == 'faqs':
        return (f'Act as an SEO content writer.{ctx}\n'
                'TASK - generate 5-8 FAQs that match real "People Also Ask" intent for this keyword. Provide a concise, accurate answer (40-60 words) for each, filling gaps not already covered in the draft. Return Markdown using "### Question" followed by the answer.')
    if key == 'schemas':
        return (f'Act as a structured-data specialist.{ctx}\n'
                "TASK - recommend the JSON-LD SCHEMA types that fit this content (e.g. Article, FAQPage, HowTo, Product, BreadcrumbList, Organization) and explain why each helps. List the key properties to populate for the top recommendation. Return Markdown. (The dashboard's Schema Generator can build the final JSON-LD.)")
    if key == 'tocTldr':
        return (f'Act as a content editor.{ctx}\n'
                'TASK - produce two things: (1) a TABLE OF CONTENTS as a bulleted, anchor-link-style list of the article\'s sections, and (2) a TL;DR - a 3-5 bullet executive summary a reader can scan in 15 seconds. Base both on the draft / outline above. Return Markdown.')
    return None


# Structured-output contract appended to every agent prompt. The client
# (index.html renderAgentResult/parseAgentStructuredResult) renders the
# score/status/findings as a scorecard and falls back to raw Markdown if
# the JSON cannot be parsed, so this is safe to evolve.
_AGENT_JSON_SUFFIX = (
    '\n\nOUTPUT FORMAT (MANDATORY): Respond in exactly two parts.\n'
    'PART 1 - a single small JSON object, no code fences, no commentary:\n'
    '{"score": <integer 0-10 or null>, "status": "good"|"warn"|"bad", '
    '"summary": "<one-sentence headline takeaway>", '
    '"findings": [{"severity": "high"|"medium"|"low", "issue": "<specific issue, max 25 words>", "fix": "<concrete fix, max 25 words>"}]}\n'
    'Rules for PART 1: if the TASK is an audit or assessment of the draft, set "score" to an honest 0-10 rating '
    'of the current draft on this dimension (8-10 = "good", 5-7 = "warn", 0-4 = "bad") and list each concrete '
    'problem as a finding (max 10). If the TASK is research or content creation (nothing is being judged), set '
    '"score" to null, "status" to "good" and "findings" to []. Keep every JSON string short and on one line; '
    'do NOT put the deliverable inside the JSON.\n'
    'PART 2 - a line containing exactly ---CONTENT--- followed by the complete Markdown deliverable the TASK asked for.'
)


def _agent_prompt(key, c):
    """Full agent prompt: the task prompt plus the mandatory JSON output contract."""
    base = _agent_prompt_base(key, c)
    return (base + _AGENT_JSON_SUFFIX) if base else None


# Agents allowed to ground themselves with live web search when the client opts
# in (`webSearch: true` on the request). Server-side allowlist — searches cost
# real money and add latency, so only the agents whose whole job is factual
# accuracy get the tool, no matter what the client asks for.
_WEB_GROUNDED_AGENTS = {'factCheck', 'factGatherer'}


def _wants_web_grounding(event):
    """True when this optimiser_agent call should run with the web_search tool."""
    if str(event.get('agentKey', '')) not in _WEB_GROUNDED_AGENTS:
        return False
    ws = event.get('webSearch')
    if ws is None:
        ws = (event.get('context') or {}).get('webSearch')
    return bool(ws)


def build_optimiser_prompt(action, body):
    """Build the raw prompt string for a migrated optimiser action.
    Returns the prompt string, or None if it cannot be built."""

    if action == 'optimiser_agent':
        ctx = dict(body.get('context') or {})
        if _wants_web_grounding(body):
            ctx['webSearch'] = True   # the fact agents' prompts switch to grounded mode
        return _agent_prompt(body.get('agentKey', ''), ctx)

    if action == 'content_gap':
        page_type    = body.get('pageTypeContext', 'Any')
        personas     = body.get('personaContext', '')
        deep_compare = body.get('deepCompareContext', '')
        topics       = body.get('selectedTopics', '')
        keyword      = body.get('keyword', '')
        editor       = body.get('editorContent', '')
        persona_block = ("STRICTLY ADHERE TO THE FOLLOWING TARGET PERSONAS:\n" + personas) if personas else ""
        return (
            "ANALYSE THE FOLLOWING DATA FOR CONTENT GAPS AND IMPROVEMENT SUGGESTIONS.\n"
            f"TARGET PAGE TYPE: {page_type}\n"
            f"{persona_block}\n"
            f"{deep_compare}\n"
            "PRIORITIZE ANALYSING THESE SPECIFIC TOPICS CHOSEN BY THE USER:\n"
            f"{topics or 'No specific topics chosen, analyse overall gaps.'}\n\n"
            f'PRIMARY KEYWORD: "{keyword}"\n\n'
            "YOUR CURRENT EDITOR CONTENT:\n"
            f'"""\n{editor}\n"""\n\n'
            "INSTRUCTIONS:\n"
            "1. Compare your content vs the cherry-picked topics.\n"
            '2. Identify specific "Content Gaps" related to these topics.\n'
            "3. Provide 3-5 actionable steps to improve the SEO and value of your existing content.\n"
            "4. Keep the tone professional and constructive."
        ).strip()

    if action == 'content_rewrite':
        personas = body.get('personaContext', '')
        topics   = body.get('selectedTopics', '')
        keyword  = body.get('keyword', '')
        suggestions = body.get('suggestions', '')
        original    = body.get('originalContent', '')
        persona_block = ("STRICTLY ADHERE TO THESE TARGET PERSONAS DURING REWRITE:\n" + personas + "\n") if personas else ""
        topics_block  = ("ENSURE THESE COMPETITOR TOPICS ARE COVERED:\n" + topics + "\n") if topics else ""
        return (
            "REWRITE THE FOLLOWING ARTICLE BASED ON THE PROVIDED IMPROVEMENT SUGGESTIONS.\n\n"
            f"{persona_block}"
            f"{topics_block}\n"
            f'PRIMARY KEYWORD: "{keyword}"\n\n'
            "IMPROVEMENT SUGGESTIONS:\n"
            f'"""\n{suggestions}\n"""\n\n'
            "ORIGINAL ARTICLE CONTENT:\n"
            f'"""\n{original}\n"""\n\n'
            "INSTRUCTIONS:\n"
            "1. Integrate all the improvement suggestions into the article.\n"
            "2. Ensure the content gaps are filled and depth is added where suggested.\n"
            "3. Maintain a natural, professional flow.\n"
            "4. Do NOT just append the suggestions; fully integrate them into the existing structure.\n"
            "5. Return the full rewritten article in Markdown format. IMPORTANT: DO NOT include any markdown code block markers like ``` or ```markdown in your response."
        ).strip()

    if action == 'content_freeform':
        user_prompt = body.get('userPrompt', '')
        personas    = body.get('personaContext', '')
        topics      = body.get('selectedTopics', '')
        persona_block = ("STRICTLY ADHERE TO THESE TARGET PERSONAS:\n" + personas) if personas else ""
        topics_block  = ("PRIORITIZE ADDRESSING THESE COMPETITOR TOPICS:\n" + topics) if topics else ""
        return (
            f"PROMPT: {user_prompt}\n\n"
            f"{persona_block}\n"
            f"{topics_block}"
        ).strip()

    if action == 'discovery_prompts':
        keywords  = body.get('keywords', [])
        existing  = body.get('existingPrompts', [])
        kw_str    = ', '.join(keywords) if isinstance(keywords, list) else str(keywords)
        dedupe = ""
        if existing:
            dedupe = (f"IMPORTANT: Do NOT repeat any of these existing prompts: {json.dumps(existing)}. "
                      "Generate 10 COMPLETELY NEW and UNIQUE ones.")
        return (
            f"Based on these keywords: {kw_str}, generate 10 realistic user-intent questions or prompts "
            "that someone might ask a Generative AI engine (like ChatGPT or Perplexity) to search for "
            "services/products related to these keywords. The language of the prompts MUST match the language "
            "of the keywords FULLY.\n"
            f"{dedupe}\n"
            "Format: Return ONLY a JSON array of strings. Do not include any explanation or markdown formatting."
        )

    return None


def lambda_handler(event, context):
    global _INVOKE_DEADLINE
    try:  # noqa: SIM105 — context is None in unit tests / local invokes
        _INVOKE_DEADLINE = time.time() + context.get_remaining_time_in_millis() / 1000.0
    except Exception:
        _INVOKE_DEADLINE = None
    try:
        # ── Input parsing ──────────────────────────────────────────────────
        action             = event.get('action', 'optimize')
        source_action      = action  # pre-remap identity (OPTIMISER actions become 'generate')
        # Model provider for text generation. 'deepseek' routes plain system+user
        # text actions through DeepSeek instead of Anthropic Haiku (staff A/B model
        # comparison in the SaaS Content Optimiser). Defaults to Anthropic.
        provider           = str(event.get('provider') or 'anthropic').strip().lower()
        if provider not in ('anthropic', 'deepseek'):
            provider = 'anthropic'

        # ── Non-AI actions ─────────────────────────────────────────────────
        if action == 'fetch_seo_feeds':
            return fetch_seo_feeds_handler(event)

        # Topic Selection stage 4: score each candidate topic's relevance to the anchor
        # (central entity). DeepSeek judge — cheap, no embeddings dependency.
        if action == 'topic_score':
            return handle_topic_score(event)

        if action in ('learnings_list', 'learnings_upsert', 'learnings_delete'):
            return handle_learnings(action, event)

        # Author Profile persistence (per user) — "remembered for all articles".
        if action in ('author_get', 'author_save', 'author_delete'):
            return handle_author_profile(action, event)

        # ── Optimiser prompts (migrated from client) ───────────────────────
        # Build the prompt server-side from structured params, then run it
        # through the standard `generate` path so behaviour is unchanged.
        if action in OPTIMISER_PROMPT_ACTIONS:
            built_prompt = build_optimiser_prompt(action, event)
            if not built_prompt:
                return _resp(400, {'error': f"Could not build prompt for action '{action}'"})
            event = dict(event)
            event['prompt'] = built_prompt
            action = 'generate'

        # ── Structured actions: build prompt server-side ───────────────────
        if action in _STRUCTURED_ACTIONS:
            api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
            if not api_key:
                return _resp(500, {'error': 'API key not configured'})

            # The AI Strategy Engine's research is told to "read the page". Rather
            # than pay for Anthropic web_fetch, scrape the URL live via the existing
            # DataForSEO crawler Lambda and feed the real content to the model. Done
            # before build_structured_prompt so the prompt can embed the content.
            if action == 'strategy_url_research':
                iv    = (event.get('input') or '').strip()
                canon = (
                    (iv if iv.startswith('http') else 'https://' + iv)
                    if ('.' in iv or iv.startswith('http')) else None
                )
                if canon:
                    scraped = _dataforseo_pull_content(canon)
                    if scraped:
                        event = dict(event)
                        event['_scraped_content'] = scraped
                        print(f"[aiOptimiser] strategy_url_research: scraped "
                              f"{len(scraped)} chars via DataForSEO for {canon}")
                    else:
                        print(f"[aiOptimiser] strategy_url_research: DataForSEO "
                              f"scrape empty for {canon} — web_search fallback")

            system_str, user_str = build_structured_prompt(action, event)
            if system_str is None:
                return _resp(400, {'error': f"Unknown structured action: '{action}'"})

            settings_s   = event.get('settings', {})
            max_tokens_s = _safe_int(settings_s.get('maxTokens', event.get('max_tokens', 8096)), 8096)

            # Vision: when the caption generator sends image attachments, let the
            # model SEE the post's visuals so the caption actually matches them.
            # For the SMM report analyser the client rasterises the report PDF to
            # one image per page, so the model reads figures off the dashboard
            # instead of a flattened, scrambled text dump.
            # Frontend sends images as a list of base64 data URLs (or
            # {media_type, data} objects). Haiku 4.5 supports image input.
            user_content = user_str
            if action == 'luxury_copy':
                images, img_cap = event.get('images'), 6
            elif action == 'smm_report':
                images, img_cap = (event.get('reportImages') or event.get('images')), 25
            else:
                images, img_cap = None, 6
            if images:
                blocks = []
                for img in images[:img_cap]:  # cap to keep the request sane
                    media_type, data = None, None
                    if isinstance(img, dict):
                        media_type = img.get('media_type') or img.get('mediaType')
                        data = img.get('data')
                    elif isinstance(img, str):
                        s = img.strip()
                        if s.startswith('data:') and ',' in s:
                            header, data = s.split(',', 1)
                            media_type = header[5:].split(';')[0] or 'image/jpeg'
                        else:
                            data, media_type = s, 'image/jpeg'
                    if data:
                        blocks.append({
                            'type': 'image',
                            'source': {
                                'type': 'base64',
                                'media_type': media_type or 'image/jpeg',
                                'data': data,
                            },
                        })
                if blocks:
                    blocks.append({'type': 'text', 'text': user_str})
                    user_content = blocks

            request_body = {
                'model':      'claude-haiku-4-5-20251001',
                'max_tokens': max_tokens_s,
                'system':     system_str,
                'messages':   [{'role': 'user', 'content': user_content}]
            }
            temperature_s = _safe_float(settings_s.get('temperature'))
            if temperature_s is not None:
                request_body['temperature'] = temperature_s

            if action == 'strategy_url_research':
                # Always force a JSON object so the frontend's JSON.parse can't
                # choke on a prose preamble.
                request_body['output_config'] = {
                    'format': {
                        'type':   'json_schema',
                        'schema': _STRATEGY_RESEARCH_SCHEMA,
                    }
                }
                # If we couldn't scrape (bare company name, or scrape failed),
                # fall back to a direct web_search so the model still has real
                # data instead of guessing. allowed_callers=['direct'] avoids the
                # dynamic-filtering caller Haiku 4.5 doesn't support.
                if not event.get('_scraped_content'):
                    request_body['tools'] = [
                        {'type': 'web_search_20260209', 'name': 'web_search',
                         'allowed_callers': ['direct']},
                    ]

            # Topic Selection actions: force a JSON object so the client parse is safe.
            if action == 'topic_extract':
                request_body['output_config'] = {
                    'format': {'type': 'json_schema', 'schema': _TOPIC_EXTRACT_SCHEMA}
                }
            elif action == 'topic_hierarchy':
                request_body['output_config'] = {
                    'format': {'type': 'json_schema', 'schema': _TOPIC_HIERARCHY_SCHEMA}
                }
            elif action == 'author_extract':
                request_body['output_config'] = {
                    'format': {'type': 'json_schema', 'schema': _AUTHOR_EXTRACT_SCHEMA}
                }

            # DeepSeek can only serve plain system+user text — actions that force a
            # JSON schema, attach images or use server tools stay on Anthropic.
            use_deepseek = (
                provider == 'deepseek'
                and isinstance(user_content, str)
                and 'output_config' not in request_body
                and 'tools' not in request_body
            )
            try:
                if use_deepseek:
                    ds_key = os.environ.get('DEEPSEEK_API_KEY')
                    if not ds_key:
                        return _resp(500, {'error': 'DEEPSEEK_API_KEY not configured'})
                    resp_json   = _deepseek_request(ds_key, system_str, user_content,
                                                    max_tokens=max_tokens_s,
                                                    temperature=temperature_s)
                    result_text = _deepseek_text(resp_json)
                    usage_out   = _deepseek_usage(resp_json)
                else:
                    resp_json   = _anthropic_request(api_key, request_body)
                    result_text = _extract_text(resp_json)
                    _u          = resp_json.get('usage') or {}
                    usage_out   = {'input_tokens':  _u.get('input_tokens', 0),
                                   'output_tokens': _u.get('output_tokens', 0)}
                # Empty completion → surface as an error (same as the main path)
                # so the client can retry, instead of a 200 with '' that then
                # breaks a downstream JSON.parse or renders nothing.
                if not result_text:
                    print(f"[aiOptimiser] empty result for '{action}' "
                          f"(provider={'deepseek' if use_deepseek else 'anthropic'}). "
                          f"resp: {json.dumps(resp_json)[:1000]}")
                    stop = resp_json.get('stop_reason')
                    raise RuntimeError(
                        f"AI returned no content (stop_reason={stop}). "
                        f"The service may be busy — please retry."
                    )
            except Exception as e:
                print(f"Structured action '{action}' failed: {e}")
                return _resp(502, {'error': f"AI request failed: {e}"})
            return _resp(200, {'result': result_text, 'usage': usage_out})

        content            = event.get('content', '')
        prompt_override    = event.get('prompt', '')
        settings           = event.get('settings', {})
        primary_keyword    = event.get('primary_keyword', '')
        secondary_keywords = event.get('secondary_keywords', '')

        # ── Read content_type, target_reader, tone_register from settings ──
        # Frontend sends these inside the settings object (camelCase keys).
        # Fallback to top-level event keys for backward compatibility,
        # then to sensible defaults.
        content_type = (
            settings.get('contentType')
            or event.get('content_type')
            or 'general'
        )
        target_reader = (
            settings.get('targetReader')
            or event.get('target_reader')
            or 'General public'
        )
        tone_register = (
            event.get('tone_register')
            or settings.get('brandTone', 'Professional')
        )

        # ── API key ────────────────────────────────────────────────────────
        api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
        if not api_key:
            return _resp(500, {'error': 'API key not configured'})

        # ── Build message layers ───────────────────────────────────────────
        linking_guidelines = build_linking_guidelines(settings, action)

        dynamic_system_msg = build_dynamic_system_msg(
            content_type       = content_type,
            target_reader      = target_reader,
            tone_register      = tone_register,
            primary_keyword    = primary_keyword,
            secondary_keywords = secondary_keywords,
            settings           = settings,
            linking_guidelines = linking_guidelines
        )

        user_msg = build_user_msg(action, content, prompt_override)

        if user_msg is None:
            return _resp(400, {'error': f"Invalid action: '{action}'"})

        # ── Compose message array ──────────────────────────────────────────
        # Translate gets a lightweight override — no quality framework needed
        if action == "translate":
            system_str = (
                "You are a professional translator. "
                "Translate content accurately while preserving "
                "all structural elements (Markdown headers, lists, "
                "tables, HTML tags). Do not add commentary."
            )
        else:
            # Merge constitution + dynamic brief into a single system string
            system_str = SYSTEM_MSG_CONSTITUTION + "\n\n" + dynamic_system_msg

        # ── Call Anthropic ─────────────────────────────────────────────────
        print(f"Sending request to Anthropic — action: {action}, "
              f"content_type: {content_type}, "
              f"target_reader: {target_reader}")

        # Route through the hardened helper: exponential-backoff retries on
        # 429/5xx/529 + circuit breaker. A raw requests.post here used to
        # swallow an Anthropic error (no 'content' key) into result_text = ""
        # and return HTTP 200 {"result": ""}, which the UI silently ignored —
        # so an overloaded/rate-limited API looked like "the button does nothing".
        # Opt-in live web verification for the fact agents. Grounded calls always
        # run on Anthropic (DeepSeek's chat API has no server-side tools), even
        # in a staff DeepSeek comparison run.
        web_grounded = source_action == 'optimiser_agent' and _wants_web_grounding(event)

        if provider == 'deepseek' and not web_grounded:
            ds_key = os.environ.get('DEEPSEEK_API_KEY')
            if not ds_key:
                return _resp(500, {'error': 'DEEPSEEK_API_KEY not configured'})
            ds = _deepseek_request(
                ds_key, system_str,
                user_msg if isinstance(user_msg, str) else str(user_msg),
            )
            result_text = _deepseek_text(ds)
            # Normalise usage to the input/output shape the shared response uses.
            resp_json = {'usage': _deepseek_usage(ds)}
            if not result_text:
                raise RuntimeError(
                    "DeepSeek returned no content. "
                    "The service may be busy — please retry."
                )
        else:
            gen_body = {
                "model":      "claude-haiku-4-5-20251001",
                "max_tokens": 8096,
                "system":     _system_param(system_str),
                "messages":   [{"role": "user", "content": user_msg}]
            }
            if web_grounded:
                # Hard cap on searches per call — this is the entire marginal
                # cost of grounded mode. allowed_callers=['direct'] matches the
                # strategy_url_research usage (Haiku 4.5 constraint).
                gen_body['tools'] = [{'type': 'web_search_20260209', 'name': 'web_search',
                                      'allowed_callers': ['direct'], 'max_uses': 4}]
            resp_json = _anthropic_request(api_key, gen_body)

            # Concatenate every text block (the model may split its reply).
            result_text = "".join(
                block.get("text", "")
                for block in resp_json.get("content", [])
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()

            # Empty completion → surface it as an error so the caller can retry,
            # rather than returning an empty 200 that overwrites nothing silently.
            if not result_text:
                stop = resp_json.get("stop_reason")
                err  = resp_json.get("error", {})
                detail = err.get("message") if isinstance(err, dict) else str(err)
                raise RuntimeError(
                    detail or
                    f"Anthropic returned no content (stop_reason={stop}). "
                    f"The service may be busy — please retry."
                )

            # One bounded continuation when the reply hit the max_tokens ceiling,
            # so a long article arrives whole instead of amputated mid-sentence.
            # discovery_prompts is excluded: its contract is a bare JSON array and
            # a resumed reply can't be trusted to splice a truncated string.
            if (resp_json.get("stop_reason") == "max_tokens"
                    and source_action != 'discovery_prompts'
                    and _secs_left() > 45):
                try:
                    cont = _anthropic_request(api_key, {
                        "model":      "claude-haiku-4-5-20251001",
                        "max_tokens": 8096,
                        "system":     _system_param(system_str),
                        "messages":   [
                            {"role": "user", "content": user_msg},
                            {"role": "assistant", "content": result_text},
                            {"role": "user", "content":
                             "Continue exactly where you stopped — same voice, "
                             "same format. Do not repeat anything already "
                             "written and do not add any preamble."},
                        ],
                    }, max_retries=1)
                    more = "".join(
                        b.get("text", "") for b in cont.get("content", [])
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                    if more.strip():
                        u1, u2 = resp_json.get('usage') or {}, cont.get('usage') or {}
                        result_text = result_text + more
                        resp_json = dict(resp_json)
                        resp_json['usage'] = {
                            'input_tokens':  u1.get('input_tokens', 0) + u2.get('input_tokens', 0),
                            'output_tokens': u1.get('output_tokens', 0) + u2.get('output_tokens', 0),
                        }
                except Exception as ce:
                    print(f"[aiOptimiser] max_tokens continuation skipped: {ce}")

        # The model sometimes wraps the HTML in a markdown code fence and
        # appends commentary after it (e.g. ```html … ``` \n **Note:** …).
        # Prefer the content INSIDE the first fenced block; otherwise trim stray
        # leading/trailing fences. Keeps the fence + any trailing note out of the
        # editor and saved content.
        if action == "add_links":
            fence = re.search(r'```(?:html)?\s*([\s\S]*?)```', result_text,
                              re.IGNORECASE)
            if fence:
                result_text = fence.group(1).strip()
            elif result_text.startswith("```"):
                result_text = re.sub(r'^```(?:html)?\s*', '', result_text)
                result_text = re.sub(r'```\s*$', '', result_text).strip()

        # ── Post-processing for targeted fragment generation ───────────────
        if action == "generate" and "CURRENT CONTENT:" in prompt_override:
            placement_match = re.search(
                r'\[PLACEMENT:.*?\]', result_text, re.IGNORECASE
            )
            placement_tag = (
                placement_match.group(0) + "\n" if placement_match else ""
            )
            if "```" in result_text:
                result_text = (
                    result_text.split("```html")[-1]
                               .split("```")[-1]
                               .split("```")[0]
                               .strip()
                )
            else:
                result_text = re.sub(
                    r'\[PLACEMENT:.*?\]', '', result_text,
                    flags=re.IGNORECASE
                ).strip()

            result_text = placement_tag + result_text

        # ── Response ───────────────────────────────────────────────────────
        # Surface real model token usage so the editor can show actual consumption
        # (input + output) and an estimated cost instead of a words×1.3 guess.
        _usage = resp_json.get('usage') or {}
        return _resp(200, {
            'result': result_text,
            'usage': {
                'input_tokens':  _usage.get('input_tokens', 0),
                'output_tokens': _usage.get('output_tokens', 0),
            },
        })

    except Exception as e:
        return _resp(500, {'error': str(e)})


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
