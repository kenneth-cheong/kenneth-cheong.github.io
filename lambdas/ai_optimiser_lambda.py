import json
import os
import requests

def lambda_handler(event, context):
    try:
        action = event.get('action', 'optimize')
        content = event.get('content', '')
        prompt_override = event.get('prompt', '')
        settings = event.get('settings', {})
        primary_keyword = event.get('primary_keyword', '')
        secondary_keywords = event.get('secondary_keywords', '')
        
        api_key = os.environ.get('OPENAI_API_KEY')
        if not api_key:
            return {'statusCode': 500, 'body': json.dumps({'error': 'API key not configured'})}

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # Construct keyword context
        keyword_context = ""
        if primary_keyword:
            keyword_context += f"\n- PRIMARY FOCUS KEYWORD: '{primary_keyword}' (Prioritize this for targeting and density)."
        if secondary_keywords:
            keyword_context += f"\n- SECONDARY KEYWORDS: {secondary_keywords} (Include these only if they fit naturally without diluting the primary focus)."

        # Construct settings context
        settings_context = ""
        if settings:
            settings_context = f"\nTARGET AUDIENCE: {settings.get('audience', 'General')}\nTONE: {settings.get('brandTone', 'Professional')}"

        # External Linking Strategy
        linking_guidelines = ""
        # improved logic: include guidelines if setting is on OR if action is explicitly to add links
        if settings.get('suggestExternalLinks', False) or action == "add_links":
            target_locale = settings.get('locale', 'Global')
            target_industry = settings.get('industry', 'General')
            
            linking_guidelines = f"""
EXTERNAL LINKING STRATEGY:
1. CITATIONS: Proactively suggest links to credible external sources to back up claims, statistics, or statements.
   - PREFERRED SOURCES: Government (.gov), Educational (.edu), Major News Outlets, and established Industry Authorities.
2. COMPETITOR AVOIDANCE:
   - Target Market: {target_locale}
   - Industry: {target_industry}
   - RULE: Do NOT link to commercial entities that are direct competitors in the {target_industry} space within {target_locale}.
   - ACCEPTABLE: You MAY link to commercial sources if they are useful and clearly NOT direct competitors in the target market (e.g. tools, complementary services, or global brands if targeting local).
"""

        # Core SEO Guidelines based on EEAT and User Satisfaction
        seo_guidelines = """
CRITICAL CONTENT GUIDELINES:
1. EXPERIENCE (E): Write with a first-person perspective or direct experience. Include reviews or anecdotal evidence where possible.
2. EXPERTISE (E): Provide deep, focused subject matter coverage specifically confined to the intent of the keyword.
3. AUTHORITATIVENESS (A): Reference credible sources and cite references directly using absolute HTML hyperlinks (<a href="URL">text</a>). Do NOT use bracketed placeholders like [Source: Name].
4. READABILITY: Write for a grade-school student. Use simple language, avoid jargon, and keep sentences/paragraphs short.
5. USEFULNESS: 
    - Include Definitions and "How/Where/Why/What" treatments.
    - Include a "Frequently Asked Questions" (FAQ) section.
    - Include media placeholders in square brackets: [IMAGE: Description], [INFOGRAPHIC: Complex data map], [VIDEO: Process illustration].
6. UNIQUENESS: 
    - Provide a unique point of view (POV) to satisfy Google's Diversity/Uniqueness requirement (source from trends, news, or 1st party perspectives).
    - Ensure content passes both human and AI plagiarism checks.
7. FORMATTING: 
    - Use clear Header hierarchy (H2, H3).
    - Use bulleted lists for neat lists and ordered lists for listicles.
    - Use Markdown tables for comparisons.
    - SPACING: Use concise vertical spacing. Avoid multiple empty lines between sections.
8. TOPIC DEPTH: Synthesize information commonly found in Top 10-20 search results while adding original insights.
"""

        system_msg = f"You are an expert SEO & content editor trained on the latest Search Quality Rater Guidelines (EEAT). Your goal is to create high-quality, targeted content that is both useful to readers and optimized for search engines. IMPORTANT: DO NOT wrap your entire response in markdown code blocks like ```markdown or ```. Return raw text/markdown content only.{seo_guidelines}{keyword_context}{settings_context}{linking_guidelines}"
        
        user_msg = ""
        if action == "generate":
            user_msg = f"Generate comprehensive, structured SEO content following all the guidelines above based on this prompt: {prompt_override}"
        elif action == "rewrite":
            user_msg = f"Rewrite this content to strictly follow the EEAT and formatting guidelines above: {content}"
        elif action == "expand":
            user_msg = f"Expand this content with more depth, media placeholders, and FAQs as per the guidelines: {content}"
        elif action == "shorten":
            user_msg = f"Shorten this content while maintaining all EEAT principles and grade-school readability: {content}"
        elif action == "simplify":
            user_msg = f"Simplify the language of this content for a grade-school level: {content}"
        elif action == "continue":
            user_msg = f"Continue writing this content, ensuring the next sections follow all formatting and EEAT rules: {content}"
        elif action == "add_links":
            user_msg = f"""Review the following content (provided in HTML format). 
1. PRESERVE STRUCTURE: You MUST keep all existing HTML tags (like <h2>, <p>, <strong>, <ul>, etc.) exactly as they are. Do NOT change the wording unless necessary for a link.
2. INSERT CITATIONS: Proactively find and insert at least 3-10 REAL, credible external links to back up key claims. 
   - FORMAT: Use `<a href="https://example.com/source" title="https://example.com/source">relevant anchor text</a>`. 
   - DO NOT append bracketed sources. Embed the link directly into the sentence structure.
3. RULES: Strictly follow the EXTERNAL LINKING STRATEGY and COMPETITOR AVOIDANCE rules. 
4. OUTPUT: Return the full content with links inserted as a valid HTML fragment. Content: {content}"""
        else:
            return {'statusCode': 400, 'body': json.dumps({'error': 'Invalid action'})}

        print(f"Sending request to OpenAI with action: {action}")
        response = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers=headers,
            json={
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg}
                ]
            }
        )

        resp_json = response.json()
        result_text = resp_json['choices'][0]['message']['content'] if 'choices' in resp_json else ""

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'OPTIONS,POST'
            },
            'body': json.dumps({'result': result_text})
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        }
