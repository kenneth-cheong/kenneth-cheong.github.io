import json
import os
import requests
import re
from bs4 import BeautifulSoup
import urllib.request

def strip_html(content):
    soup = BeautifulSoup(content, "html.parser")
    # Remove script and style elements
    for script in soup(["script", "style"]):
        script.extract()
    return soup.get_text(separator=' ', strip=True)

def lambda_handler(event, context):
    try:
        api_key = os.environ.get('OPENAI_API_KEY')
        if not api_key:
            return {'statusCode': 500, 'body': json.dumps({'error': 'API key not configured'})}

        target_url = event.get('target_url')
        competitor_url = event.get('competitor_url')
        keyword = event.get('keyword', '')
        
        target_content = event.get('target_content', '')
        competitor_content = event.get('competitor_content', '')

        # Function to scrape url if content is not provided
        def get_content_from_url(url):
            try:
                # Add headers to avoid basic blocks
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                html = urllib.request.urlopen(req, timeout=10).read()
                return strip_html(html)
            except Exception as e:
                print(f"Scrape error for {url}: {e}")
                return "Could not retrieve content."

        # Process or scrape target
        if target_content:
            target_text = strip_html(target_content)
        elif target_url:
            target_text = get_content_from_url(target_url)
        else:
            target_text = "Content not provided."
            
        # Process or scrape competitor
        if competitor_content:
            competitor_text = strip_html(competitor_content)
        elif competitor_url:
            competitor_text = get_content_from_url(competitor_url)
        else:
            competitor_text = "Content not provided."

        system_msg = """You are a world-class SEO strategist performing an extreme deep-dive gap analysis between a Target Domain and a Top Competitor.
You must output a highly structured JSON object that perfectly matches the required tables for a premium SEO audit presentation.
The tone must be authoritative, objective, and brutally honest about the Target Domain's shortcomings compared to the Competitor.

CRITICAL INSTRUCTION: You MUST use exact, verbatim quotes from the provided Target and Competitor content to illustrate your points. Do not use generic explanations like 'Article exists in isolation' or 'No author byline' if you can extract an actual quote that proves your point. For example, if evaluating Tone, quote a specific bland sentence from the Target and contrast it with a compelling sentence mapped from the Competitor.

For the `target_gap` field, you MUST be highly detailed and specific. Provide at least 2-3 full sentences explaining EXACTLY why the target's approach fails compared to the competitor's approach, referencing the psychological or SEO impact of the gap.

For the `fix` field, do NOT just say "Add X". You MUST provide the actual suggested replacement copy or specific structural implementation. Tell the user *exactly* what to write or do.

YOUR REQUIRED JSON OUTPUT FORMAT:
{
  "priority_action_plan": [
    {"action": "Specific tactic", "expected_outcome": "Why do this?", "effort": "Low/Medium/High", "priority": "1 (Critical) to 5 (Nice-to-have)"}
  ],
  "eeat_trust_signals": [
    {"issue": "e.g., Target says '[quote]', missing expertise...", "competitor_approach": "Competitor proves expertise: '[quote]'", "target_gap": "What target is missing", "fix": "Exact recommended fix"}
  ],
  "topical_authority": [
    {"issue": "e.g., Target only covers X '[quote]'", "competitor_approach": "Competitor covers Y and Z: '[quote]'", "target_gap": "What target is missing", "fix": "Exact recommended fix"}
  ],
  "competitive_differentiation": [
    {"issue": "e.g., Generic claim: '[quote]'", "competitor_approach": "Unique angle: '[quote]'", "target_gap": "What target is missing", "fix": "Exact recommended fix"}
  ],
  "technical_schema_seo": [
    {"issue": "e.g., Missing FAQ Schema", "competitor_approach": "Competitor uses structured data for X", "target_gap": "Target status", "fix": "Exact recommended fix"}
  ],
  "audience_targeting": [
    {"issue": "e.g., Target intro is weak: '[quote]'", "competitor_approach": "Competitor intro hooks reader: '[quote]'", "target_gap": "Target's generic approach", "fix": "Exact recommended fix"}
  ]
}

Ensure there are 4-6 highly specific rows per table to provide substantial, actionable value. Do NOT use generic advice. You MUST use specific, verbatim quotes from the provided text to justify your analysis wherever possible."""

        user_msg = f"""
TARGET DOMAIN/URL: {target_url}
COMPETITOR URL: {competitor_url}
FOCUS KEYWORD: {keyword}

--- TARGET CONTENT (Abridged) ---
{target_text[:8000]}

--- COMPETITOR CONTENT (Abridged) ---
{competitor_text[:8000]}

Based on the content above, generate the required strict JSON output for the Deep Compare Analysis.
"""

        print("Sending request to OpenAI...")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json={
                "model": "gpt-4o-mini", # Using 4o for superior instruction following and reasoning
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg}
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2
            },
            timeout=45
        )

        resp_json = response.json()
        if response.status_code != 200:
            raise Exception(f"OpenAI API Error: {resp_json}")

        result_text = resp_json['choices'][0]['message']['content']
        result_data = json.loads(result_text)

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps(result_data)
        }

    except Exception as e:
        print(f"Deep Compare Lambda Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*'
            },
            'body': json.dumps({'error': str(e)})
        }
