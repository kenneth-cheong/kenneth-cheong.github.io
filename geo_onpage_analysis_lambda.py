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

        # Extract logical text chunks for side-by-side comparison
        text_chunks = extract_text_chunks(page_data['html'])

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

HEADINGS FOUND ON PAGE (extracted via parser, authoritative):
{json.dumps(page_data['headings'], indent=2)}

ORIGINAL TEXT CHUNKS (split by headings/paragraphs for comparison):
{json.dumps(text_chunks, indent=2)}

PAGE CONTENT EXCERPT (HTML):
---
{page_data['html'][:18000]}
---

Your analysis must focus on how to make this page more visible in AI-generated responses (Perplexity, ChatGPT Search, Gemini, etc.).

Be EXTREMELY SPECIFIC and ACTIONABLE. Provide exact phrases, exact terms, exact URLs, exact anchor text. Do NOT give generic advice. Every recommendation must be something the user can directly copy-paste or implement.

Output your analysis in strictly JSON format:
{{
  "overall_score": integer (0-100),
  "vector_embedding": {{
    "score": integer,
    "semantic_coverage": integer (0-100, how well current content matches target prompts semantically),
    "recommended_terms": ["exact phrase 1 to add to content", "exact phrase 2", ...],
    "topic_clusters": ["specific topic cluster phrase 1", "specific topic cluster phrase 2", ...],
    "missing_elements": [{{"text": "specific missing element or gap", "positive": false}}, ...],
    "strengths": [{{"text": "specific strength found on page", "positive": true}}, ...]
  }},
  "entity_optimization": {{
    "score": integer,
    "entities": [{{"name": "exact entity name found or needed", "type": "Organization|Product|Service|Place|Person|Event|SoftwareApplication", "status": "found|missing"}}, ...],
    "eeat_signals": [{{"signal": "Author credentials", "present": true or false}}, {{"signal": "Publication dates", "present": true or false}}, {{"signal": "Source citations", "present": true or false}}, {{"signal": "Expert quotes", "present": true or false}}, {{"signal": "Trust badges or awards", "present": true or false}}],
    "insights": [{{"text": "specific actionable recommendation", "positive": true or false}}, ...]
  }},
  "content_structure": {{
    "score": integer,
    "heading_hierarchy": "Use the HEADINGS FOUND ON PAGE list above as your source of truth. Include ALL of them with status 'found'. Then add any recommended new headings with status 'recommended'. Format: [{{"level": "H1", "text": "exact heading text", "status": "found"}}, ...]",
    "faq_suggestions": [{{"question": "exact FAQ question to add", "answer_preview": "brief answer summary"}}, ...],
    "insights": [{{"text": "specific structural recommendation", "positive": true or false}}, ...]
  }},
  "internal_linking": {{
    "score": integer,
    "linking_table": [{{"anchor_text": "exact anchor text to use", "target_url": "suggested target URL path", "context": "brief reason"}}, ...],
    "insights": [{{"text": "specific linking recommendation", "positive": true or false}}, ...]
  }},
  "citation_worthiness": {{
    "score": integer,
    "quotable_statements": [{{"statement": "exact quotable sentence to add to the page that AI would cite", "topic": "what topic this covers"}}, ...],
    "insights": [{{"text": "specific citation recommendation", "positive": true or false}}, ...]
  }},
  "optimized_chunks": [
    {{"original": "The exact original text chunk from the ORIGINAL TEXT CHUNKS list above", "optimized": "The AI-rewritten version of that same chunk, optimized for GEO impact. Use the exact brand name, include target prompt keywords, and write in a citation-worthy style."}},
    ...(one entry per chunk from the ORIGINAL TEXT CHUNKS list)
  ],
  "optimized_content": "The full consolidated optimized text combining all optimized chunks above into one continuous piece.",
  "proposed_meta_title": "A concise, keyword-rich meta title (50-60 chars) optimised for AI visibility and CTR.",
  "proposed_meta_description": "A compelling meta description (140-160 chars) that addresses user intent and includes target keywords.",
  "schema_markup": [{{a complete valid JSON-LD schema object for EACH applicable type, e.g. Organization, WebPage, LocalBusiness, FAQPage, BreadcrumbList, Product, Service, etc. Include as many distinct @type schemas as are relevant to this page.}}, ...]
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

        # Attach scraped page metadata so the frontend can populate rows 4-14
        analysis_data['page_metadata'] = {
            'existing_meta_title': page_data.get('meta_title', ''),
            'existing_meta_description': page_data.get('meta_description', ''),
            'existing_canonical_url': page_data.get('canonical_url', '')
        }

        return success_response(analysis_data)

    except Exception as e:
        return error_response(str(e))

def scrape_page(url):
    """Scraper with DataForSEO fallback when requests fails."""
    if not url.startswith('http'):
        url = 'https://' + url

    html = None

    # Attempt 1: Direct requests
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        }
        res = requests.get(url, headers=headers, timeout=10)
        res.raise_for_status()
        html = res.text
    except Exception as e:
        print(f"[scrape_page] requests failed: {e}, trying DataForSEO fallback...")

    # Attempt 2: DataForSEO crawler Lambda fallback
    if not html:
        try:
            dfs_resp = requests.post(
                'https://ak9qsl9wgi.execute-api.ap-southeast-1.amazonaws.com/dataforseoCrawler',
                json={"action": "pull_content", "url": url},
                timeout=30
            )
            dfs_resp.raise_for_status()
            dfs_data = dfs_resp.json()
            body = dfs_data.get('body')
            if isinstance(body, str):
                body = json.loads(body)
            if body and body.get('html'):
                html = body['html']
            else:
                return {"error": "Both requests and DataForSEO fallback returned no content"}
        except Exception as e2:
            return {"error": f"Both scrapers failed. requests error, DataForSEO error: {e2}"}

    # Parse with BeautifulSoup
    soup = BeautifulSoup(html, 'html.parser')

    # Extract existing page metadata BEFORE decomposing elements
    meta_title = ''
    title_tag = soup.find('title')
    if title_tag:
        meta_title = title_tag.get_text(strip=True)
    
    meta_description = ''
    desc_tag = soup.find('meta', attrs={'name': re.compile(r'^description$', re.I)})
    if desc_tag:
        meta_description = desc_tag.get('content', '')
    
    canonical_url = ''
    canonical_tag = soup.find('link', attrs={'rel': 'canonical'})
    if canonical_tag:
        canonical_url = canonical_tag.get('href', '')

    # Extract all headings BEFORE decomposing elements
    headings = []
    for tag in soup.find_all(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']):
        text = tag.get_text(separator=' ', strip=True)
        if text:
            headings.append({
                "level": tag.name.upper(),
                "text": text
            })

    # Remove script and style elements
    for element in soup(["script", "style", "nav", "footer"]):
        element.decompose()

    return {
        "html": str(soup),
        "text": soup.get_text(separator=' ', strip=True),
        "headings": headings,
        "meta_title": meta_title,
        "meta_description": meta_description,
        "canonical_url": canonical_url
    }

def extract_text_chunks(html_str):
    """Split page content into logical text chunks by headings/sections."""
    soup = BeautifulSoup(html_str, 'html.parser')
    
    # Remove script, style, nav, footer for cleaner text
    for el in soup(['script', 'style', 'nav', 'footer']):
        el.decompose()
    
    chunks = []
    current_chunk = []
    
    for element in soup.body.children if soup.body else soup.children:
        if hasattr(element, 'name') and element.name in ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']:
            # Flush current chunk
            text = ' '.join(current_chunk).strip()
            if text and len(text) > 30:
                chunks.append(text)
            current_chunk = [element.get_text(separator=' ', strip=True)]
        elif hasattr(element, 'get_text'):
            t = element.get_text(separator=' ', strip=True)
            if t:
                current_chunk.append(t)
        elif isinstance(element, str) and element.strip():
            current_chunk.append(element.strip())
    
    # Flush last chunk
    text = ' '.join(current_chunk).strip()
    if text and len(text) > 30:
        chunks.append(text)
    
    # Limit to ~8 chunks to avoid exceeding token limits
    if len(chunks) > 8:
        # Merge smallest chunks or just take the first 8
        chunks = chunks[:8]
    
    # If no heading-based chunks were found, split by paragraphs
    if not chunks:
        full_text = soup.get_text(separator='\n', strip=True)
        paragraphs = [p.strip() for p in full_text.split('\n\n') if p.strip() and len(p.strip()) > 30]
        chunks = paragraphs[:8]
    
    return chunks

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
