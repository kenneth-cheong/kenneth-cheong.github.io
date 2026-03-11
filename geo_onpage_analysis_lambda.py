import json
import requests
import os
import re
from bs4 import BeautifulSoup
from urllib.parse import urlparse

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

PAGE METADATA:
{json.dumps(page_data.get('metadata', {}), indent=2)}

PAGE IMAGES:
{json.dumps(page_data.get('images', []), indent=2)}

PAGE CONTENT EXCERPT (HTML):
---
{page_data['html'][:18000]}
---

Your analysis must focus on how to make this page more visible in AI-generated responses (Perplexity, ChatGPT Search, Gemini, etc.).

Be EXTREMELY SPECIFIC and ACTIONABLE. Provide exact phrases, exact terms, exact URLs, exact anchor text. Do NOT give generic advice. Every recommendation must be something the user can directly copy-paste or implement.

CRITICAL: For internal linking suggestions, strictly PRIORITIZE using existing URLs found on the website. Only suggest new URLs if absolutely necessary for the user's goals.

Output your analysis in strictly JSON format:
{{
  "page_metadata": {{
    "existing_canonical_url": "URL from PAGE METADATA",
    "existing_meta_title": "Title from PAGE METADATA",
    "existing_meta_description": "Description from PAGE METADATA"
  }},
  "proposed_meta_title": "An SEO-optimized title (max 60 chars)",
  "proposed_meta_description": "An SEO-optimized description including target keywords (max 160 chars)",
  "image_optimization": [
    {{"src": "exact src from PAGE IMAGES", "existing_alt": "exact alt from PAGE IMAGES", "suggested_alt": "Optimized alt text incorporating keywords"}}
  ],
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
    "linking_table": [{{"anchor_text": "exact anchor text to use", "target_url": "suggested target URL path (PRIORITIZE EXISTING)", "context": "brief reason"}}, ...],
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

        # Verify internal linking URLs
        if 'internal_linking' in analysis_data and 'linking_table' in analysis_data['internal_linking']:
            for link in analysis_data['internal_linking']['linking_table']:
                target_url = link.get('target_url')
                if not target_url:
                    continue
                try:
                    # Make it an absolute URL if it is a relative path
                    if target_url.startswith('/'):
                        parsed_base = urlparse(url)
                        test_url = f"{parsed_base.scheme}://{parsed_base.netloc}{target_url}"
                    else:
                        test_url = target_url

                    # Check HTTP status code
                    res = requests.head(test_url, timeout=3, allow_redirects=True, headers={'User-Agent': 'Mozilla/5.0'})
                    if res.status_code >= 400 and res.status_code != 405:
                        res = requests.get(test_url, timeout=3, allow_redirects=True, headers={'User-Agent': 'Mozilla/5.0'})
                    
                    if res.status_code < 400:
                        link['url_status'] = 'exists'
                    else:
                        link['url_status'] = 'missing'
                except Exception as e:
                    link['url_status'] = 'missing'

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

    # Extract page metadata
    metadata = {
        "existing_meta_title": "",
        "existing_meta_description": "",
        "existing_canonical_url": ""
    }
    if soup.title and soup.title.string:
        metadata["existing_meta_title"] = soup.title.string.strip()
        
    desc_tag = soup.find("meta", attrs={"name": "description"})
    if desc_tag:
        metadata["existing_meta_description"] = desc_tag.get("content", "").strip()
        
    can_tag = soup.find("link", rel="canonical")
    if can_tag:
        metadata["existing_canonical_url"] = can_tag.get("href", "").strip()

    # Extract images (cap to 15 to save tokens)
    images = []
    for img in soup.find_all('img'):
        src = img.get('src')
        if src and not src.startswith('data:'):
            images.append({
                "src": src,
                "alt": img.get('alt', '')
            })
            if len(images) >= 15:
                break

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
        "metadata": metadata,
        "images": images
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
