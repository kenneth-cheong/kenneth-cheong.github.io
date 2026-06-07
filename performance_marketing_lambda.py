import json
import os
import requests

# ─────────────────────────────────────────────────────────────────────────────
# Performance Marketing — Starter Opportunity Analysis (Phase 2, Step 6)
#
# Sales-friendly, AI-generated media-buying opportunity analysis. Takes the
# minimal "Starter" inputs a salesperson can collect on a first call and returns
# a structured recommendation: which paid channels suit this business, a budget
# split that sums to 100%, an estimated monthly budget range, concrete
# opportunities, quick wins, watch-outs, and sales talking points.
#
# Mirrors social_media_strategy_lambda.py: requests → Anthropic Messages API,
# CLAUDE_API_KEY / ANTHROPIC_API_KEY env var, returns {'answer': <raw JSON str>}.
# Deployed handler: lambda_function.lambda_handler (file zipped as lambda_function.py).
# ─────────────────────────────────────────────────────────────────────────────

CORS = {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'}


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
budget across everything. For a small budget, recommend fewer channels with conviction.

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
- Provide 2-4 platform_recommendations and 3-4 opportunities.
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

    # 4. Call Anthropic
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return {'statusCode': 500, 'headers': CORS,
                'body': json.dumps({'error': 'Missing ANTHROPIC_API_KEY / CLAUDE_API_KEY env var.'})}

    try:
        response = requests.post(
            'https://api.anthropic.com/v1/messages',
            headers={
                'x-api-key':         api_key,
                'anthropic-version': '2023-06-01',
                'content-type':      'application/json'
            },
            json={
                'model':      'claude-haiku-4-5-20251001',
                'max_tokens': 4096,
                'system':     system_prompt,
                'messages':   [{'role': 'user', 'content': input_text}]
            },
            timeout=120
        )
        response_json = response.json()

        if response.status_code == 200:
            answer = response_json['content'][0]['text'] if response_json.get('content') else ''
            answer = answer.strip()
            # Strip markdown code fences if the model added them
            if answer.startswith('```'):
                answer = answer.split('\n', 1)[-1]
            if answer.endswith('```'):
                answer = answer.rsplit('```', 1)[0]
            answer = answer.strip()
            return {'statusCode': 200, 'headers': CORS, 'body': json.dumps({'answer': answer})}

        return {'statusCode': response.status_code, 'headers': CORS,
                'body': json.dumps({'error': f"API Error: {response.text}"})}

    except Exception as e:
        return {'statusCode': 500, 'headers': CORS, 'body': json.dumps({'error': str(e)})}
