import json
import os
import time
import requests

# ─────────────────────────────────────────────────────────────────────────────
# Performance Marketing Module (Phase 2, Step 6)
#
# Two modes, mirroring the SEO module's straight-through Starter/Pro logic:
#
#   STARTER — sales-friendly, AI-generated media-buying opportunity analysis from
#   the minimal inputs a salesperson can collect on a first call: which channels
#   suit the business, a budget split summing to 100%, an estimated budget range,
#   opportunities, quick wins, watch-outs and sales talking points.
#
#   PRO — account-level diagnosis from the data the CSM/client exports (Google Ads,
#   Meta Ads, GA4, conversion-tracking status, landing pages, CPL/CPA/ROAS, audience,
#   historical performance, creatives). Diagnoses root causes across nine areas
#   (tracking, targeting, budget, landing page, creative, keyword quality, bidding
#   strategy, funnel, market competitiveness), with priorities, an action plan and
#   an internal-vs-escalate decision.
#
# Mirrors social_media_strategy_lambda.py: requests → Anthropic Messages API,
# CLAUDE_API_KEY / ANTHROPIC_API_KEY env var, returns {'answer': <raw JSON str>}.
# Deployed handler: lambda_function.lambda_handler (file zipped as lambda_function.py).
# ─────────────────────────────────────────────────────────────────────────────

CORS = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}

# MediaOne internal Google Ads benchmarks (Singapore / SGD, Q1 2026) — shared with
# the SEM Benchmark tool. Used by Pro Mode to ground metric comparisons.
BENCHMARKS = "Avg CPC S$0.68 · Avg CTR 2.61% · Avg CPA S$2.56 · Avg ROAS 2.51x (Google Ads, Singapore, Q1 2026)"


def _call_deepseek(api_key, system_prompt, input_text, max_tokens=4096):
    """Single DeepSeek chat-completions call with one retry on transient errors.
    Returns (status_code, answer_or_error_text)."""
    _TRANSIENT = {503, 529}
    for attempt in range(2):
        response = requests.post(
            'https://api.deepseek.com/chat/completions',
            headers={
                'Authorization': f'Bearer {api_key}',
                'content-type':  'application/json'
            },
            json={
                'model':      'deepseek-chat',
                'max_tokens': max_tokens,
                'messages':   [
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user',   'content': input_text},
                ],
            },
            timeout=120
        )
        if response.status_code == 200:
            response_json = response.json()
            choices = response_json.get('choices') or [{}]
            answer = choices[0].get('message', {}).get('content', '')
            answer = answer.strip()
            if answer.startswith('```'):
                answer = answer.split('\n', 1)[-1]
            if answer.endswith('```'):
                answer = answer.rsplit('```', 1)[0]
            return 200, answer.strip()
        if response.status_code in _TRANSIENT and attempt == 0:
            time.sleep(3)
            continue
        break
    return response.status_code, f"API Error {response.status_code}: {response.text}"


def _call_anthropic(api_key, system_prompt, input_text, max_tokens=4096):
    """Single Anthropic Messages call with one retry on transient errors.
    Returns (status_code, answer_or_error_text)."""
    _TRANSIENT = {503, 529}
    for attempt in range(2):
        response = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key':         api_key,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
            },
            json={
                'model':      'claude-haiku-4-5-20251001',
                'max_tokens': max_tokens,
                'system':     system_prompt,
                'messages':   [{'role': 'user', 'content': input_text}]
            },
            timeout=120
        )
        if response.status_code == 200:
            response_json = response.json()
            answer = response_json['content'][0]['text'] if response_json.get('content') else ''
            answer = answer.strip()
            if answer.startswith('```'):
                answer = answer.split('\n', 1)[-1]
            if answer.endswith('```'):
                answer = answer.rsplit('```', 1)[0]
            return 200, answer.strip()
        if response.status_code in _TRANSIENT and attempt == 0:
            time.sleep(3)
            continue
        break
    return response.status_code, f"API Error {response.status_code}: {response.text}"


def lambda_handler(event, context):
    # 1. Parse input robustly (same pattern as sibling lambdas)
    body = event.get('body', {})
    if isinstance(body, str):
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            body = {}
    if not body:
        body = event if isinstance(event, dict) else {}

    mode = str(body.get('mode', 'starter')).strip().lower()

    website_url       = body.get('website_url', '')
    business_category = body.get('business_category', '')
    target_country    = body.get('target_country', '') or 'Singapore'
    target_audience   = body.get('target_audience', '')
    monthly_budget    = body.get('monthly_budget', '')
    objectives        = body.get('objectives', '')
    current_platforms = body.get('current_platforms', [])
    rfq_notes         = body.get('rfq_notes', '')

    if isinstance(current_platforms, list):
        current_platforms = ', '.join([p for p in current_platforms if p]) or 'None / unknown'

    anthropic_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    deepseek_key  = os.environ.get('DEEPSEEK_API_KEY')

    # ── PRO MODE: account-level diagnosis (still on Anthropic) ───────────────
    if mode == 'pro':
        if not anthropic_key:
            return {'statusCode': 500, 'headers': CORS,
                    'body': json.dumps({'error': 'Missing ANTHROPIC_API_KEY / CLAUDE_API_KEY env var.'})}
        return _run_pro(
            anthropic_key, body,
            website_url, business_category, target_country, target_audience,
            monthly_budget, objectives, current_platforms, rfq_notes,
        )

    if not deepseek_key and not anthropic_key:
        return {'statusCode': 500, 'headers': CORS,
                'body': json.dumps({'error': 'Missing DEEPSEEK_API_KEY and ANTHROPIC_API_KEY / CLAUDE_API_KEY env var.'})}

    # 2. Strategist persona (system prompt) — Starter Mode, sales-friendly
    system_prompt = """
You are a senior performance marketing strategist and media buyer with 15+ years planning paid
media (Google Search, Google Display/Demand Gen, Meta, TikTok, LinkedIn, YouTube) for B2B and B2C
clients, with deep knowledge of the Singapore and SEA market. You work for a digital agency and are
preparing a STARTER-LEVEL media-buying opportunity analysis for a salesperson to use on a first
call with a prospect. The salesperson is NOT a paid-media expert, so your output must be clear,
confident, and free of jargon — but commercially sharp and specific to this business.

You are given only the minimal information a salesperson can collect early. Do NOT ask for more
data; make reasonable, clearly-reasoned assumptions from the business category, audience, country,
and budget. Never invent specific account metrics (you have no ad-account access at this stage).

Choose ONLY from these platforms, using the exact names:
"Google Search Ads", "Google Demand Gen / Display", "Meta Ads (Facebook/Instagram)",
"TikTok Ads", "LinkedIn Ads", "YouTube Ads".

Pick the channels that genuinely fit this business, audience, and budget — do not spread a small
budget across everything. For budgets under S$5,000/month, recommend AT MOST 2 platforms — spreading
such a budget across 3+ channels dilutes spend below the threshold needed for any of them to work and
is not acceptable. Only go to 3 platforms for budgets of S$5,000/month or more, and only if each
platform can still receive a meaningful share.

Return ONLY raw JSON (no markdown, no code fences, no commentary) with EXACTLY this shape:

{
  "executive_summary": "2-3 sentences a salesperson can say aloud: the headline opportunity and the recommended approach.",
  "platform_recommendations": [
    {
      "platform": "one of the allowed platform names",
      "suitability": "High | Medium | Low",
      "budget_share_pct": <integer 0-100>,
      "monthly_budget": "currency-formatted amount for this platform's share, e.g. 'S$2,000'",
      "primary_objective": "e.g. Lead generation, Sales/Conversions, Awareness, Traffic",
      "rationale": "1-2 sentences on WHY this channel fits this business & audience",
      "expected_outcome": "a realistic, qualitative expected result — no fabricated exact numbers"
    }
  ],
  "estimated_budget_range": {
    "currency": "ISO-ish label, e.g. 'SGD'",
    "conservative": "currency-formatted monthly amount to see meaningful signal",
    "recommended": "currency-formatted monthly amount for solid results",
    "aggressive": "currency-formatted monthly amount to compete hard",
    "rationale": "1-2 sentences explaining the range for this category & market"
  },
  "opportunities": [
    { "title": "short opportunity headline", "insight": "what's true about this market/business", "recommended_action": "the concrete move" }
  ],
  "quick_wins": ["3-5 things that can be set up fast for early traction"],
  "watch_outs": ["3-5 risks, common mistakes, or things to verify before spending"],
  "sales_talking_points": ["4-6 punchy lines the salesperson can use to sound credible and build urgency"]
}

RULES:
- budget_share_pct across platform_recommendations MUST sum to exactly 100.
- If a monthly budget is given, set each platform's monthly_budget to its share of that budget and
  make estimated_budget_range bracket around it. If no budget is given, propose a sensible range for
  the category in the target country and base monthly_budget figures on the "recommended" amount.
- Use the target country's typical currency (Singapore → SGD with 'S$'). Keep numbers realistic.
- Provide 2 platform_recommendations for budgets under S$5,000/month (up to 3 only for larger budgets)
  and 3-4 opportunities.
- Every string must be properly escaped with no literal newlines. No trailing commas.
- Output the JSON object ONLY.
""".strip()

    # 3. Specific input block
    input_text = f"""
BUSINESS WEBSITE: {website_url}
BUSINESS CATEGORY / WHAT THEY SELL: {business_category}
TARGET COUNTRY / MARKET: {target_country}
TARGET AUDIENCE: {target_audience}
STATED MONTHLY BUDGET: {monthly_budget if monthly_budget else 'Not provided — propose a sensible range'}
PLATFORMS THEY CURRENTLY USE: {current_platforms}
CAMPAIGN OBJECTIVES / GOALS: {objectives}
RFQ / DISCUSSION NOTES: {rfq_notes if rfq_notes else 'None provided'}

Produce the Starter performance-marketing opportunity analysis now.
""".strip()

    # 4. Call DeepSeek (default) or Anthropic (fallback if DEEPSEEK_API_KEY not configured)
    try:
        if deepseek_key:
            status, answer = _call_deepseek(deepseek_key, system_prompt, input_text)
        else:
            status, answer = _call_anthropic(anthropic_key, system_prompt, input_text)
        if status == 200:
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'answer': answer})}
        msg = 'The AI service is temporarily unavailable. Please try again in a moment.' \
              if status in (503, 529) else f'AI service returned an error ({status}). Please try again.'
        return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'error': msg})}
    except Exception as e:
        return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'error': str(e)})}


# ─────────────────────────────────────────────────────────────────────────────
# PRO MODE — account-level diagnosis
# ─────────────────────────────────────────────────────────────────────────────
def _run_pro(api_key, body,
             website_url, business_category, target_country, target_audience,
             monthly_budget, objectives, current_platforms, rfq_notes):

    # Pro-only inputs (the account data a CSM/client can export)
    google_ads_export    = body.get('google_ads_export', '')
    meta_ads_export      = body.get('meta_ads_export', '')
    ga4_data             = body.get('ga4_data', '')
    conversion_tracking  = body.get('conversion_tracking', '')
    landing_pages        = body.get('landing_pages', '')
    cpl                  = body.get('cpl', '')
    cpa                  = body.get('cpa', '')
    roas                 = body.get('roas', '')
    audience_data        = body.get('audience_data', '')
    historical           = body.get('historical_performance', '')
    creatives            = body.get('creatives', '')

    system_prompt = f"""
You are a senior performance marketing auditor and media buyer with 15+ years running paid media
(Google Search, Demand Gen/Display, Meta, TikTok, LinkedIn, YouTube) for B2B and B2C clients, with
deep knowledge of the Singapore and SEA market. A CSM has exported account-level data and needs a
PRO-LEVEL DIAGNOSIS: what is wrong, why, how to fix it, and whether the CSM can handle it internally
or must escalate to a senior media buyer.

You diagnose root causes across these NINE areas — assess EVERY one, even if data is thin (say so):
1. Tracking — conversion tracking, tags/pixels, GA4 setup, data integrity
2. Targeting — audiences, geo, demographics, match types, placements
3. Budget — total spend level, pacing, allocation across campaigns/channels
4. Landing Page — relevance, speed, conversion experience, message match
5. Creative — ad copy/visuals, fatigue, variety, hooks, CTAs
6. Keyword Quality — search terms, negatives, intent match, Quality Score (Search only; mark N/A if no Search)
7. Bidding Strategy — bid strategy fit, targets (tCPA/tROAS), learning phase
8. Funnel — lead→customer flow, follow-up, drop-off, offer/form friction
9. Market Competitiveness — auction pressure, CPC vs benchmark, seasonality, share

Ground metric judgements in MediaOne benchmarks where relevant: {BENCHMARKS}. Adjust expectations by
industry and budget. NEVER invent data that was not provided — if a field is empty, base that area's
status on what is available and flag the missing data as something to collect. Be specific and
commercially sharp; the reader is a CSM, not necessarily a paid-media expert.

Return ONLY raw JSON (no markdown, no code fences, no commentary) with EXACTLY this shape:

{{
  "executive_summary": "2 sentences max: the headline diagnosis and the single biggest lever.",
  "overall_health": "Healthy | Needs Work | Critical",
  "key_metrics": [
    {{ "label": "e.g. CPL", "value": "the client's figure or 'Not provided'", "benchmark": "the comparison point", "status": "good | warning | bad", "note": "<= 10 words" }}
  ],
  "diagnosis": [
    {{ "area": "Tracking", "status": "ok | warning | critical", "finding": "<= 18 words", "evidence": "<= 10 words, or 'No data provided'", "recommendation": "<= 18 words, one concrete fix", "priority": "High | Medium | Low" }}
  ],
  "root_causes": ["1-3 items, each <= 12 words"],
  "action_plan": [
    {{ "priority": "High | Medium | Low", "action": "<= 16 words", "owner": "Media Buyer | CSM | Client | Developer", "expected_impact": "<= 10 words" }}
  ],
  "escalation": {{
    "handle_internally": ["<= 12 words each"],
    "escalate_to_specialist": [ {{ "issue": "<= 10 words", "reason": "<= 15 words" }} ]
  }}
}}

RULES:
- "diagnosis" MUST contain all NINE areas in the order above, using those exact "area" names.
- BE CONCISE — obey every word cap above. Short, sharp, scannable. Do NOT pad or repeat.
- key_metrics: include CPL, CPA and ROAS when given (compare to benchmark); add CPC/CTR if present.
- Provide 3-4 action_plan items, ordered High → Low priority.
- Every string must be properly escaped with no literal newlines. No trailing commas.
- Output the JSON object ONLY.
""".strip()

    input_text = f"""
BUSINESS WEBSITE: {website_url}
BUSINESS CATEGORY / WHAT THEY SELL: {business_category}
TARGET COUNTRY / MARKET: {target_country}
TARGET AUDIENCE: {target_audience}
STATED MONTHLY BUDGET: {monthly_budget if monthly_budget else 'Not provided'}
PLATFORMS CURRENTLY USED: {current_platforms}
CAMPAIGN OBJECTIVES / GOALS: {objectives}

— ACCOUNT-LEVEL DATA (Pro inputs) —
CONVERSION TRACKING STATUS: {conversion_tracking if conversion_tracking else 'Not provided'}
CURRENT CPL (cost per lead): {cpl if cpl else 'Not provided'}
CURRENT CPA (cost per acquisition): {cpa if cpa else 'Not provided'}
CURRENT ROAS: {roas if roas else 'Not provided'}
LANDING PAGE URLs: {landing_pages if landing_pages else 'Not provided'}
AUDIENCE / TARGETING SETUP: {audience_data if audience_data else 'Not provided'}
HISTORICAL PERFORMANCE / TRENDS: {historical if historical else 'Not provided'}
CURRENT CREATIVES (description or paste): {creatives if creatives else 'Not provided'}

GOOGLE ADS EXPORT:
{google_ads_export if google_ads_export else 'Not provided'}

META ADS EXPORT:
{meta_ads_export if meta_ads_export else 'Not provided'}

GA4 DATA:
{ga4_data if ga4_data else 'Not provided'}

RFQ / DISCUSSION NOTES: {rfq_notes if rfq_notes else 'None provided'}

Produce the Pro account-level diagnosis now.
""".strip()

    try:
        status, answer = _call_anthropic(api_key, system_prompt, input_text, max_tokens=2200)
        if status == 200:
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'answer': answer})}
        msg = 'The AI service is temporarily unavailable. Please try again in a moment.' \
              if status in (503, 529) else f'AI service returned an error ({status}). Please try again.'
        return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'error': msg})}
    except Exception as e:
        return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'error': str(e)})}
