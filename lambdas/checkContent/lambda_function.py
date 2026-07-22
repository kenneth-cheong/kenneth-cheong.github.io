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
_LLM_FN = 'checkContent'


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

# Content Checker supports two text providers so the tool's "AI Model" picker
# (Claude Haiku / DeepSeek) actually changes the model that reviews the content.
# Anthropic stays the default when no provider is sent, preserving old behaviour.
_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
_DEEPSEEK_MODEL  = 'deepseek-chat'
_MAX_TOKENS      = 4096


def lambda_handler(event, context):
    brand_guide = event.get('brand_guide', '')
    other_sources = event.get('other_sources', '')
    instructions = event.get('instructions', '')
    content = event.get('content', '')
    keyword = event.get('keyword', '')
    tone = event.get('tone', '')
    provider = _normalise_provider(event.get('provider'))

    if not content:
        return {'statusCode': 400, 'body': json.dumps({'error': 'Content is required.'})}

    prompt = build_prompt(content, brand_guide, other_sources, instructions, keyword, tone)

    try:
        raw = call_model(prompt, provider)
        json_match = re.search(r'\{.*\}', raw, re.DOTALL)
        parsed = json.loads(json_match.group() if json_match else raw)
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'},
            'body': json.dumps(parsed)
        }
    except Exception as e:
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}


def _normalise_provider(value):
    """Only 'deepseek' switches away from the Anthropic default; anything else
    (including 'both', which has no compare mode for checking) resolves to
    Anthropic."""
    return 'deepseek' if str(value or '').lower() == 'deepseek' else 'anthropic'


def call_model(prompt, provider):
    """Return the raw model text for the given provider. Falls back to Anthropic
    if DeepSeek is requested but its key is not configured."""
    if provider == 'deepseek':
        deepseek_key = os.environ.get('DEEPSEEK_API_KEY')
        if deepseek_key:
            return _call_deepseek(prompt, deepseek_key)
        # No DeepSeek key -> degrade gracefully rather than error out.
    return _call_anthropic(prompt)


def _call_anthropic(prompt):
    api_key = os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        raise RuntimeError('CLAUDE_API_KEY not set.')
    headers = {
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
    }
    payload = {
        'model': _ANTHROPIC_MODEL,
        'max_tokens': _MAX_TOKENS,
        'messages': [{'role': 'user', 'content': prompt}]
    }
    response = requests.post('https://api.anthropic.com/v1/messages', headers=headers, json=payload, timeout=120)
    response.raise_for_status()
    return response.json()['content'][0]['text']


def _call_deepseek(prompt, api_key):
    headers = {'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'}
    payload = {
        'model': _DEEPSEEK_MODEL,
        'max_tokens': _MAX_TOKENS,
        'messages': [{'role': 'user', 'content': prompt}],
        # The prompt asks for a JSON object only; ask DeepSeek to enforce it.
        'response_format': {'type': 'json_object'}
    }
    response = requests.post('https://api.deepseek.com/chat/completions', headers=headers, json=payload, timeout=120)
    response.raise_for_status()
    return response.json()['choices'][0]['message']['content']


def build_prompt(content, brand_guide, other_sources, instructions, keyword='', tone=''):
    sections = []
    if brand_guide:
        sections.append(f"**Brand Guidelines:**\n{brand_guide}")
    if other_sources:
        sections.append(f"**Reference Guidelines/Sources:**\n{other_sources}")
    if instructions:
        sections.append(f"**Additional Instructions:**\n{instructions}")
    context_block = '\n\n'.join(sections)

    keyword_block = f"""
SEO KEYWORD CHECKS (target keyword: "{keyword}"):
- Keyword absent from the first 100 words of the content -> seo/critical
- Keyword density below 0.5% or above 3% of total words -> seo/warning
- No natural opportunity for a subheading containing the keyword -> seo/suggestion
- Keyword used in an awkward or unnatural way -> seo/warning
""" if keyword else ""

    tone_block = f"""
TONE CONSISTENCY (target tone: {tone}):
- Sentences or phrases clearly inconsistent with a {tone} tone -> readability/warning
- Vocabulary level mismatched for a {tone} audience -> readability/suggestion
""" if tone else ""

    structural_block = """
STRUCTURAL SEO (always check these):
- Final paragraph has no clear call-to-action -> seo/suggestion
- First paragraph does not state the main value proposition or claim -> seo/warning
- Content over 150 words with no subheading opportunities (reads as unbroken block) -> readability/suggestion
"""

    return f"""You are an expert SEO editor and brand compliance reviewer. Analyse the content below and return ONLY a valid JSON object — no markdown fences, no text outside the JSON.

{context_block}

**Content to Analyse:**
{content}
{keyword_block}{tone_block}{structural_block}
Return this exact JSON structure:

{{
  "summary": {{
    "flesch_score": <integer 0-100, calculated from the content>,
    "flesch_label": <"Very Easy"|"Easy"|"Standard"|"Fairly Difficult"|"Difficult"|"Very Difficult">,
    "avg_sentence_length": <average words per sentence, integer>,
    "word_count": <total word count, integer>,
    "total_issues": <integer>,
    "by_type": {{
      "compliance": <integer>,
      "grammar": <integer>,
      "readability": <integer>,
      "seo": <integer>
    }}
  }},
  "issues": [
    {{
      "id": "issue_1",
      "type": <"compliance"|"grammar"|"readability"|"seo">,
      "severity": <"critical"|"warning"|"suggestion">,
      "original": <exact verbatim substring from content — character-perfect, as short as possible>,
      "suggested": <corrected replacement text>,
      "reason": <clear, specific explanation of the problem and its SEO or quality impact>
    }}
  ]
}}

Flesch Reading Ease: 90-100 Very Easy | 70-89 Easy | 60-69 Standard (ideal for web) | 50-59 Fairly Difficult | 30-49 Difficult | 0-29 Very Difficult

IMPORTANT: Only flag issues you are highly confident about. Do NOT flag intentional stylistic choices, deliberate short sentences for impact, or deliberate repetition for emphasis. When in doubt, do not flag.

GRAMMAR (flag only clear errors):
- Subject-verb agreement errors -> critical
- Incorrect tense -> critical
- Spelling mistakes -> critical
- Clear punctuation errors (missing apostrophes, run-on sentences) -> warning
- Dangling modifiers -> warning

READABILITY:
- Sentences over 30 words — suggest splitting -> warning
- Passive voice where active voice is clearly better -> warning
- Filler words (very, really, just, basically, actually, quite) -> suggestion
- Unexplained jargon for a general audience -> warning

SEO:
- Keyword stuffing (same phrase 3+ times in close proximity) -> warning
- Generic CTAs (click here, read more, learn more) -> warning
- Vague unsubstantiated superlatives (best, top, leading, number one) without evidence -> suggestion

COMPLIANCE (only if brand guide or guidelines provided):
- Brand voice violations -> critical
- Prohibited words or phrases -> critical
- Missing mandatory disclaimers -> critical
- Tone inconsistencies -> warning

The "original" field must be an exact verbatim substring of the content — used for UI highlighting.
Sort: critical first, then warnings, then suggestions. Maximum 20 issues."""
