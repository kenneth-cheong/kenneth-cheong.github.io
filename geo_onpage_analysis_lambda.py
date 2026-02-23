import json
import requests
import os
import re
from bs4 import BeautifulSoup

def lambda_handler(event, context):
    try:
        body = event.get('body', event)
        if isinstance(body, str):
            body = json.loads(body)
            
        url = body.get('url')
        target_prompts = body.get('prompts', '')
        brand = body.get('brand', 'The Brand')
        industry = body.get('industry', 'N/A')
        audience = body.get('audience', 'General')
        market = body.get('market', 'Singapore')

        if not url:
            return error_response("Missing URL")

        # 1. Scrape the page
        page_data = scrape_page(url)
        if "error" in page_data:
            return error_response(f"Scraping failed: {page_data['error']}")

        # 2. Prepare AI Analysis
        openai_key = os.environ.get('OPENAI_API_KEY')
        if not openai_key:
            return error_response("OpenAI API key not configured")

        analysis_prompt = f"""
Perform a comprehensive GEO (Generative Engine Optimisation) On-Page Analysis for the following landing page.

URL: {url}
BRAND: {brand}
INDUSTRY: {industry}
TARGET AUDIENCE: {audience}
TARGET MARKET: {market}
TARGET PROMPTS (How users might ask an AI about this):
{target_prompts}

PAGE CONTENT EXCERPT (HTML):
---
{page_data['html'][:20000]}
---

Your analysis must focus on how to make this page more visible in AI-generated responses (Perplexity, ChatGPT Search, Gemini, etc.).

Output your analysis in strictly JSON format:
{{
  "overall_score": integer (0-100),
  "vector_embedding": {{
    "score": integer,
    "insights": ["List of 3-5 specific semantic coverage gaps or wins"]
  }},
  "entity_optimization": {{
    "score": integer,
    "insights": ["List of 3-5 specific entities to bridge or optimize"]
  }},
  "content_structure": {{
    "score": integer,
    "insights": ["List of 3-5 structural hits/misses (Headings, FAQ, listicles)"]
  }},
  "internal_linking": {{
    "score": integer,
    "insights": ["List of 3-5 internal linking suggestions for authority"]
  }},
  "citation_worthiness": {{
    "score": integer,
    "insights": ["List of 3-5 points on how to become a cited source"]
  }},
  "optimized_content": "A rewrite of a key section (e.g., Intro or Product section) to maximize GEO impact using high-intent triggers.",
  "schema_markup": {{
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "Target Keyword Optimized Title",
    "comment": "Provide a complete, valid JSON-LD schema (e.g. FAQ, Organization, Product) that helps AI engines."
  }}
}}
"""

        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {openai_key}",
                "Content-Type": "application/json"
            },
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": "You are a specialized GEO (Generative Engine Optimisation) analyst. You help websites rank in AI-generated search results through semantic, entity, and structural optimization. Return ONLY valid JSON."},
                    {"role": "user", "content": analysis_prompt}
                ],
                "response_format": { "type": "json_object" },
                "temperature": 0.4
            }
        )
        response.raise_for_status()
        result = response.json()
        analysis_data = json.loads(result['choices'][0]['message']['content'])

        return success_response(analysis_data)

    except Exception as e:
        return error_response(str(e))

def scrape_page(url):
    """Simple scraper using requests & BeautifulSoup."""
    try:
        if not url.startswith('http'):
            url = 'https://' + url
            
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        }
        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        
        soup = BeautifulSoup(res.text, 'html.parser')
        
        # Remove script and style elements
        for element in soup(["script", "style", "nav", "footer"]):
            element.decompose()
            
        return {
            "html": str(soup),
            "text": soup.get_text(separator=' ', strip=True)
        }
    except Exception as e:
        return {"error": str(e)}

def success_response(data):
    return {
        "statusCode": 200,
        "headers": { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        "body": json.dumps(data)
    }

def error_response(msg):
    return {
        "statusCode": 400,
        "headers": { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        "body": json.dumps({"error": msg})
    }
