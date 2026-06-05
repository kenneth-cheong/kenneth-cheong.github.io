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

        if response.status_code == 200:
            answer = response_json['content'][0]['text'] if response_json.get('content') else ''
            # Strip markdown code fences if present
            answer = answer.strip()
            if answer.startswith('```'):
                answer = answer.split('\n', 1)[-1]
            if answer.endswith('```'):
                answer = answer.rsplit('```', 1)[0]
            answer = answer.strip()
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
