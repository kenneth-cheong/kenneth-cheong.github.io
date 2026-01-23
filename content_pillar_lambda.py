import json
import requests
import os

def lambda_handler(event, context):
    # 1. Parse Input
    body = event.get('body', '{}')
    if isinstance(body, str):
        body = json.loads(body)
        
    business_model = body.get('business_model', 'B2B')
    objectives = body.get('objectives', [])
    audience_type = body.get('audience_type', "")
    decision_complexity = body.get('decision_complexity', 'Medium')
    platforms = body.get('platforms', [])
    risk_sensitivity = body.get('risk_sensitivity', 'Medium')
    promotional_tolerance = body.get('promotional_tolerance', 'Medium')
    reference_urls = body.get('reference_urls', {})
    additional_info = body.get('additional_info', '')
    
    # 2. Construct Strategist Persona (Instructions)
    instructions = """
You are a senior social media and content strategist with over 15 years of experience designing commercially accountable, performance-led content systems for B2B and B2C brands.
Your role is to design a non-negotiable content pillar framework that functions as a fixed operating system for a marketing team — not a list of ideas.

Each content pillar must:
- Exist to solve a specific business or decision problem.
- Be clearly tied to revenue impact, trust-building, or decision enablement.
- Serve a defined funnel stage purpose.
- Be adapted to platform psychology and role, not format reuse.

Design Constraints:
- Limit the framework to 3–5 pillars maximum.
- Assign a percentage weighting to each pillar.
- Explicitly state what each pillar is responsible for achieving.
- Define guardrails that prevent overproduction of low-impact or vanity-driven content.
- Prioritise in this order: Revenue impact > Trust and authority building > Decision-stage enablement.
"""
    
    # 3. Construct Specific Input
    input_text = f"""
COMMERCIAL CONTEXT:
- Business Model: {business_model}
- Primary Business Objectives: {', '.join(objectives)}
- Primary Audience Type: {audience_type}
- Decision Complexity: {decision_complexity}
- Brand Risk Sensitivity: {risk_sensitivity}
- Promotional Tolerance: {promotional_tolerance}
- Active Platforms: {', '.join(platforms)}

ADDITIONAL INPUT/CONTEXT:
{additional_info}

REFERENCES:
- Website: {reference_urls.get('website', 'N/A')}
- Brand Guide: {reference_urls.get('brandGuide', 'N/A')}
- Competitors: {reference_urls.get('competitors', 'N/A')}

Generate a defensible, strategy-led content pillar framework. 
Provide TWO distinct parts:
1. ### 1. Strategic Content Pillar Framework (Markdown Table)
Columns: [Content Pillar | Strategic Purpose | Funnel Stage | % of Total Content]

2. ### 2. Platform Role Matrix (Markdown Table)
Mapping each pillar to {', '.join(platforms)}. Use 'High', 'Medium', 'Low', or 'N/A' to indicate relative priority.

Include a final section on 'Execution Guardrails'.
"""

    # 4. Call OpenAI Responses API
    # NOTE: Ensure OPENAI_API_KEY is set in Lambda environment variables.
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
        ], "tools": [{"type": "web_search"}]
    }
    
    response = requests.post(url, headers=headers, json=payload)

    print(response.json()['output'][0]['content'][0])
    
    if response.status_code != 200:
        return {
            'statusCode': response.status_code,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': f"OpenAI API Error: {response.text}"})
        }
    
    return {
        'statusCode': 200,
        'headers': {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        'body': {'answer': response.json()['output'][0]['content'][0]}
    }