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

    brand_context = body.get('brand_context', '')
    strategic_ambition = body.get('strategic_ambition', '')
    strategic_challenge = body.get('strategic_challenge', '')
    priority_audiences = body.get('priority_audiences', [])
    proof_points = body.get('proof_points', '')

    # 2. Construct Strategist Persona (Instructions)
    instructions = """
You are a senior social media and content strategist with over 15 years of experience designing brand-led, evidence-based social media strategies for B2B and B2C organisations.
Your task is to synthesise limited but high-value inputs into a complete social media brand positioning and content strategy framework.

You must:
- Infer audience intent and strategic priorities from the information provided.
- Make clear strategic choices rather than listing options.
- Translate ambition and challenge into directional strategy.
- Avoid generic positioning statements and surface-level marketing language.
- NEVER repeat the input back to the user.

Your output must be formatted as raw HTML suitable for a dashboard. Specifically, you must provide TWO distinct parts:

Part 1: Broad Content Positioning (The "Strategy House")
Use a <div> structure with class "strategy-house":
- A "house-roof" containing the core Positioning statement.
- "house-objectives" containing 3 distinct strategic Objectives as bars.
- "house-methods" containing 4 pillars: Inspire, Cultivate, Connect, Amplify.

Part 2: Content Strategy Framework (The Grid)
Use a <table> with class "strategy-grid":
- Row 1: Primary Goal (colspan 4).
- Row 2: Methods (4 columns: Inspire, Cultivate, Connect, Amplify).
- Row 3: Content Strategy (4 columns describing the strategy for each method).
- Row 4: Target Audience (4 columns assigning priority audiences to each method).
- Row 5: Content Pillars & Topics (4 columns defining specific pillars for each method).

Return only the raw HTML code without any markdown blocks or extra text.
"""

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

Generate the Social Media Strategy positioning and framework now.
"""

    # 4. Call OpenAI Responses API
    api_key = os.environ.get('OPENAI_API_KEY')
    url = "https://api.openai.com/v1/responses"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": "gpt-4o-mini",
        "instructions": instructions.strip(),
        "input": [
            {
                "role": "system",
                "content": instructions.strip()
            },
            {
                "role": "user",
                "content": input_text.strip()
            }
        ]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload, timeout=30)
        response_json = response.json()
        
        if response.status_code == 200:
            content_item = response_json['output'][-1]['content'][0]
            answer = content_item.get('text', content_item) if isinstance(content_item, dict) else content_item
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
                'statusCode': response.status_code,
                'headers': {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': 'application/json'
                },
                'body': json.dumps({'error': f"API Error: {response.text}"})
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
