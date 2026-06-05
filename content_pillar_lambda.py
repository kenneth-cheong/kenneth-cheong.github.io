import json
import requests
import os

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
""".strip()

    # 4. Call Anthropic Claude Haiku
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return {
            'statusCode': 500,
            'headers': {'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'Missing ANTHROPIC_API_KEY env var.'})
        }

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
            timeout=60
        )
        response_json = response.json()

        if response.status_code != 200:
            return {
                'statusCode': response.status_code,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'error': f"API Error: {response.text}"})
            }

        answer = response_json['content'][0]['text'] if response_json.get('content') else ''

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
