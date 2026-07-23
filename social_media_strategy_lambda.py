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
_LLM_FN = 'socialMediaStrategy'
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

CORS = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}


def _llm_complete(provider, system_prompt, input_text, max_tokens=4096):
    """Single LLM call; returns (status_code, answer_or_error_text).
    provider 'deepseek' -> DeepSeek (OpenAI-compatible); anything else -> Anthropic Claude (default).
    Default preserves the original Claude behaviour, so the client can switch back to Claude at will."""
    if (provider or '').lower() == 'deepseek':
        key = os.environ.get('DEEPSEEK_API_KEY')
        if not key:
            return 500, 'Missing DEEPSEEK_API_KEY env var.'
        response = requests.post(
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
        if response.status_code != 200:
            return response.status_code, f"API Error: {response.text}"
        rj = response.json()
        answer = rj['choices'][0]['message']['content'] if rj.get('choices') else ''
    else:
        key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
        if not key:
            return 500, 'Missing ANTHROPIC_API_KEY env var.'
        response = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
            json={
                'model':      'claude-haiku-4-5-20251001',
                'max_tokens': max_tokens,
                'system':     system_prompt,
                'messages':   [{'role': 'user', 'content': input_text}],
            },
            timeout=120,
        )
        if response.status_code != 200:
            return response.status_code, f"API Error: {response.text}"
        rj = response.json()
        answer = rj['content'][0]['text'] if rj.get('content') else ''

    answer = (answer or '').strip()
    if answer.startswith('```'):
        answer = answer.split('\n', 1)[-1]
    if answer.endswith('```'):
        answer = answer.rsplit('```', 1)[0]
    return 200, answer.strip()


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

    # Social Media & Content Audit (Phase 2, Step 7) — separate task on the same endpoint
    if body.get('task') == 'social_audit':
        return _run_social_audit(body)

    brand_context        = body.get('brand_context', '')
    strategic_ambition   = body.get('strategic_ambition', '')
    strategic_challenge  = body.get('strategic_challenge', '')
    priority_audiences   = body.get('priority_audiences', [])
    proof_points         = body.get('proof_points', '')
    additional_info      = body.get('additional_info', '')

    # 2. Construct Unified Strategist Persona (System Prompt)
    system_prompt = """
You are a senior brand and social media strategist with over 15 years of experience shaping clear, differentiated, and commercially grounded brand positioning and content strategy frameworks for B2B and B2C organisations.

Your task is to synthesise the provided inputs into two things:
  A) A concise, high-level brand strategy articulation suitable for senior stakeholders and direct marketing use.
  B) A complete social media brand positioning and content strategy framework.

────────────────────────────────────────────
THINKING APPROACH
Before writing, you must:
- Identify what the brand is truly trying to be known for.
- Determine what makes the brand credible and differentiated.
- Understand the audience's expectations and decision context.
- Translate all of the above into clear, distilled, and strategically sharp language.
- Make clear strategic choices — never list options or present alternatives.
────────────────────────────────────────────

WHAT TO AVOID
- Generic positioning statements that could apply to any brand.
- Surface-level or vague marketing language and buzzwords.
- Overly long paragraphs or filler language.
- Contradictory or disconnected sections.
- Repeating or rephrasing the input — interpret and elevate it.
────────────────────────────────────────────

Your output must be formatted as raw JSON with exactly three top-level objects:

─── 1. "brand_foundation" ───
A high-level brand strategy block containing four fields:

  "strategic_intent":
    - A clear, directional positioning statement.
    - Must reflect the brand's ambition, differentiation, and relevance.
    - Must go beyond what the brand does — define what it stands for and how it should be perceived.
    - Must not be descriptive, generic, or interchangeable with another brand.

  "brand_essence":
    - A short, memorable phrase or single sentence.
    - Must capture the core emotional and functional value of the brand.
    - Must be simple, distinct, and easy to repeat — suitable to anchor campaigns.
    - Avoid clichés, generic slogans, or abstract wording.

  "value_proposition":
    - A credible, grounded, specific statement that articulates:
        • What the brand offers.
        • Why it is valuable to its audience.
        • What makes it different or preferable to alternatives.
    - Avoid exaggerated claims, buzzwords, or generic value statements.

  "brand_personality":
    - A list of 4–6 distinct personality traits.
    - Traits must be specific and usable in content, tone of voice, and communication.
    - Avoid generic traits unless meaningfully sharpened
      (e.g. not "professional" but "assured and authoritative").
    - Traits must align with strategic_intent and value_proposition.

─── 2. "house" ───
  "positioning":   A single positioning statement for social media.
  "objectives":    A list of exactly 3 distinct strategic objectives.
  "methods":       A fixed list of exactly 4 items: ["Inspire", "Cultivate", "Connect", "Amplify"].
  "explanation":   A single string containing a comprehensive strategic rationale. You MUST provide exactly four substantial paragraphs (at least 3 sentences each), one for each level of the house: 1) Strategic Intent, 2) Brand Essence, 3) Value Proposition, and 4) Brand Personality. You MUST use double line breaks (\\n\\n) between every paragraph so they are visually distinct. Do NOT return as an object.

─── 3. "grid" ───
  "primary_goal":  A single primary goal statement.
  "methods":       An object where keys are the 4 method names and each value is an object with:
    "strategy":    A specific strategy for that method.
    "audience":    Target priority audience(s) for that method.
    "pillars":     Specific content pillars or topics for that method.
    "keywords":    A comma-separated string of 4-6 words and short phrases the
                   captions for this method should actually use — the brand's own
                   vocabulary, product and category terms, and the language the
                   audience uses. These are copywriting cues for a caption writer,
                   NOT SEO keywords: no search volumes, no hashtags, no stuffing.
  "explanation":   A single string containing a detailed strategic rationale. You MUST provide exactly four substantial paragraphs (at least 3 sentences each), one for each method: 1) Inspire, 2) Cultivate, 3) Connect, and 4) Amplify. You MUST use double line breaks (\\n\\n) between every paragraph so they are visually distinct. Do NOT return as an object.

────────────────────────────────────────────
OUTPUT REQUIREMENTS
- Each section must be concise, intentional, and presentation-ready.
- Write as if the output will appear directly on a slide.
- Provide one clear, confident direction — no alternatives or options.
- All sections must be aligned and coherent as one unified strategy.
- Return ONLY the raw JSON object. No markdown, no code fences, no extra text.
- Ensure all string values are properly escaped and do NOT contain literal newlines (use \\n for line breaks).
- Ensure no trailing commas after the last items in objects or arrays.
────────────────────────────────────────────
""".strip()

    # 3. Construct Specific Input
    input_text = f"""
BRAND CONTEXT:
{brand_context}

STRATEGIC AMBITION:
{strategic_ambition}

CORE STRATEGIC CHALLENGE:
{strategic_challenge}

PRIORITY AUDIENCES:
{', '.join(priority_audiences) if isinstance(priority_audiences, list) else priority_audiences}

PROOF POINTS & CONSTRAINTS:
{proof_points}

ADDITIONAL SUPPORTING DOCUMENTS CONTENT:
{additional_info}

Generate the Brand Foundation and Social Media Strategy framework now.
""".strip()

    # 4. Call the LLM — DeepSeek if requested, else Anthropic Claude (default).
    provider = body.get('provider', 'anthropic')

    try:
        status, answer = _llm_complete(provider, system_prompt, input_text, max_tokens=4096)

        if status == 200:
            return {
                'statusCode': 200,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'answer': answer})
            }
        else:
            return {
                'statusCode': status,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'error': answer})
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


# ─────────────────────────────────────────────────────────────────────────────
# SOCIAL MEDIA & CONTENT AUDIT (Phase 2, Step 7)
#
# Starter — competitor & content-gap audit from first-call inputs: what the
#   client is doing, what competitors do better, missing content types, useful
#   platforms, recommended content themes, posting cadence.
# Pro — adds the data the CSM/client exports (social analytics, Meta Business
#   Suite, content calendars, creative samples, engagement, blog performance,
#   GA4 content) and deepens the recommendation: content pillars, campaign
#   angles, organic/paid integration, social SEO, blog-to-social repurposing
#   and creative improvements.
#
# Brevity-capped so generation stays within the HTTP API timeout.
# ─────────────────────────────────────────────────────────────────────────────
def _run_social_audit(body):
    mode = str(body.get('mode', 'starter')).strip().lower()
    is_pro = mode == 'pro'

    brand_name       = body.get('brand_name', '')
    client_website   = body.get('client_website', '')
    social_profiles  = body.get('social_profiles', '')
    target_audience  = body.get('target_audience', '')
    industry         = body.get('industry', '')
    competitors      = body.get('competitors', '')
    campaign_goals   = body.get('campaign_goals', '')
    rfq_notes        = body.get('rfq_notes', '')
    content_calendars= body.get('content_calendars', '')
    extra_context    = body.get('extra_context', '')

    # Pro-only inputs
    social_analytics = body.get('social_analytics', '')
    meta_suite       = body.get('meta_business_suite', '')
    calendar_samples = body.get('content_calendar_samples', '')
    creative_samples = body.get('creative_samples', '')
    engagement_data  = body.get('engagement_data', '')
    blog_performance = body.get('blog_performance', '')
    ga4_content      = body.get('ga4_content', '')

    depth = (
        "This is a PRO audit. Account/analytics data is provided below — read it and ground every "
        "judgement in it. Fill ALL output fields, including campaign_angles, organic_paid_integration, "
        "social_seo, blog_to_social and creative_improvements, and reflect the metrics in metrics_read."
        if is_pro else
        "This is a STARTER audit from first-call inputs (no analytics access). Focus on current_state, "
        "competitor_comparison, missing_content_types, recommended_platforms, content_pillars (as themes), "
        "posting_cadence and action_plan. You MAY leave the deeper Pro-only fields as empty arrays/strings."
    )

    system_prompt = f"""
You are a senior social media and content strategist with 15+ years auditing brands' social presence
and content against their competitors for B2B and B2C clients, with deep knowledge of the Singapore and
SEA market. A CSM needs a SOCIAL MEDIA & CONTENT AUDIT: what the client is doing now, what competitors
do better, where the gaps are, and what to do about it. Be specific, commercially sharp and scannable —
the reader is a CSM, not necessarily a social expert.

{depth}

NEVER invent data that was not provided — if you lack information for a field, base it on the website,
industry and audience, and say what to collect. Compare the client to the named competitors directly.

Return ONLY raw JSON (no markdown, no code fences, no commentary) with EXACTLY this shape:

{{
  "executive_summary": "<= 2 sentences: the headline finding and the single biggest opportunity.",
  "overall_health": "Strong | Developing | Underdeveloped",
  "current_state": {{ "summary": "<= 25 words on what the client is doing now", "active_platforms": ["platform names"], "strengths": ["<= 10 words each"], "gaps": ["<= 10 words each"] }},
  "competitor_comparison": [ {{ "competitor": "name", "doing_better": "<= 15 words", "opportunity": "<= 15 words for the client" }} ],
  "missing_content_types": ["content types/formats the client is not using, <= 8 words each"],
  "recommended_platforms": [ {{ "platform": "name", "why": "<= 12 words" }} ],
  "content_pillars": [ {{ "pillar": "name", "rationale": "<= 12 words", "formats": ["suggested formats"] }} ],
  "posting_cadence": "<= 25 words: cadence per platform",
  "campaign_angles": ["<= 12 words each"],
  "organic_paid_integration": "<= 25 words on how organic + paid should work together",
  "social_seo": ["<= 12 words each — social/profile/search optimisation moves"],
  "blog_to_social": ["<= 12 words each — blog-to-social repurposing ideas"],
  "creative_improvements": ["<= 12 words each"],
  "metrics_read": ["<= 12 words each — what the provided analytics indicate (Pro; [] if none)"],
  "action_plan": [ {{ "priority": "High | Medium | Low", "action": "<= 16 words", "owner": "Strategist | Content | Designer | CSM | Client", "expected_impact": "<= 10 words" }} ]
}}

RULES:
- Provide 2-4 competitor_comparison items (one per named competitor where possible), 3-5 content_pillars, 3-5 action_plan items (High → Low).
- BE CONCISE — obey every word cap. Short, sharp, scannable. Do NOT pad or repeat the inputs.
- Every string must be properly escaped with no literal newlines. No trailing commas.
- Output the JSON object ONLY.
""".strip()

    input_text = f"""
BRAND NAME: {brand_name if brand_name else 'Not provided'}
CLIENT WEBSITE: {client_website}
CLIENT SOCIAL PROFILES: {social_profiles if social_profiles else 'Not provided'}
INDUSTRY: {industry}
TARGET AUDIENCE: {target_audience}
COMPETITORS: {competitors if competitors else 'Not provided — infer likely competitors'}
CAMPAIGN GOALS: {campaign_goals}
EXISTING CONTENT CALENDAR(S): {content_calendars if content_calendars else 'Not provided'}
RFQ / DISCUSSION NOTES: {rfq_notes if rfq_notes else 'None provided'}
ADDITIONAL CONTEXT / UPLOADED BRIEFS: {extra_context if extra_context else 'None provided'}

— ACCOUNT / ANALYTICS DATA (Pro inputs) —
SOCIAL ANALYTICS EXPORTS: {social_analytics if social_analytics else 'Not provided'}
META BUSINESS SUITE DATA: {meta_suite if meta_suite else 'Not provided'}
CONTENT CALENDAR SAMPLES: {calendar_samples if calendar_samples else 'Not provided'}
CREATIVE SAMPLES: {creative_samples if creative_samples else 'Not provided'}
ENGAGEMENT DATA: {engagement_data if engagement_data else 'Not provided'}
BLOG PERFORMANCE: {blog_performance if blog_performance else 'Not provided'}
GA4 CONTENT DATA: {ga4_content if ga4_content else 'Not provided'}

Produce the {'Pro' if is_pro else 'Starter'} social media & content audit now.
""".strip()

    provider = body.get('provider', 'anthropic')
    try:
        status, answer = _llm_complete(provider, system_prompt, input_text, max_tokens=2600)
        if status == 200:
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'answer': answer})}
        return {'statusCode': status, 'headers': CORS, 'body': json.dumps({'error': answer})}
    except Exception as e:
        return {'statusCode': 500, 'headers': CORS, 'body': json.dumps({'error': str(e)})}



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
