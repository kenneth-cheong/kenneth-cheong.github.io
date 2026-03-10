import json
import os
import requests
import re
from bs4 import BeautifulSoup
import urllib.request
import concurrent.futures

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
        competitor_urls = event.get('competitor_urls', [])
        
        if competitor_url and not competitor_urls:
            competitor_urls = [competitor_url]
            
        keyword = event.get('keyword', '')
        
        target_content = event.get('target_content', '')

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
            
        # Concurrently scrape competitors
        competitor_texts_dict = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            future_to_url = {executor.submit(get_content_from_url, url): url for url in competitor_urls}
            for future in concurrent.futures.as_completed(future_to_url):
                url = future_to_url[future]
                try:
                    competitor_texts_dict[url] = future.result()
                except Exception as exc:
                    print(f'{url} generated an exception: {exc}')
                    competitor_texts_dict[url] = "Could not retrieve content."
                    
        competitor_master_text = ""
        for url, text in competitor_texts_dict.items():
            competitor_master_text += f"\n\n--- COMPETITOR: {url} ---\n{text[:6000]}"

        system_msg = """You are a world-class SEO strategist performing an extreme deep-dive gap analysis between a Target Domain and one or more Top Competitors.
You must output a highly structured JSON object that perfectly matches the required tables for a premium SEO audit presentation.
The tone must be authoritative, objective, and brutally honest about the Target Domain's shortcomings compared to the Competitors.

CRITICAL INSTRUCTION: You MUST use exact, verbatim quotes from the provided Target and Competitor content to illustrate your points. When citing a competitor, you MUST explicitly name which competitor URL you are quoting. For example: [Competitor example.com: "quote here"].

For the `target_gap` field, you MUST be highly detailed and specific. Provide at least 2-3 full sentences explaining EXACTLY why the target's approach fails compared to the competitors' approach, referencing the psychological or SEO impact of the gap.

For the `fix` field, do NOT just say "Add X". You MUST provide the actual suggested replacement copy or specific structural implementation. Tell the user *exactly* what to write or do.

YOUR REQUIRED JSON OUTPUT FORMAT:
{
  "priority_action_plan": [
    {"action": "Specific tactic", "expected_outcome": "Why do this?", "effort": "Low/Medium/High", "priority": "1 (Critical) to 5 (Nice-to-have)"}
  ],
  "eeat_trust_signals": [
    {"issue": "Target says '[quote]'", "competitor_approach": "[Competitor X] proves expertise: '[quote]'", "target_gap": "Why target fails...", "fix": "Exact fix"}
  ],
  "topical_authority": [
    {"issue": "Target only covers X '[quote]'", "competitor_approach": "[Competitor X] covers Y and Z: '[quote]'", "target_gap": "What target is missing", "fix": "Exact fix"}
  ],
  "competitive_differentiation": [
    {"issue": "Generic claim: '[quote]'", "competitor_approach": "[Competitor X] Unique angle: '[quote]'", "target_gap": "What target is missing", "fix": "Exact fix"}
  ],
  "technical_schema_seo": [
    {"issue": "Missing FAQ Schema", "competitor_approach": "[Competitor X] uses structured data", "target_gap": "Target status", "fix": "Exact fix"}
  ],
  "audience_targeting": [
    {"issue": "Target intro is weak: '[quote]'", "competitor_approach": "[Competitor X] intro hooks reader: '[quote]'", "target_gap": "Target's generic approach", "fix": "Exact fix"}
  ]
}

Ensure there are 4-6 highly specific rows per table to provide substantial, actionable value. Do NOT use generic advice. Synthesize insights across all provided competitors to highlight the biggest gaps."""

        user_msg = f"""
TARGET DOMAIN/URL: {target_url}
COMPETITOR URLS: {', '.join(competitor_urls)}
FOCUS KEYWORD: {keyword}

--- TARGET CONTENT (Abridged) ---
{target_text[:8000]}

--- COMPETITOR CONTENTS ---
{competitor_master_text}

Based on the content above, generate the required strict JSON output for the Deep Compare Analysis.
"""

        print("Sending request to OpenAI with concurrent scrape payload...")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json={
                "model": "gpt-4o-mini",
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
