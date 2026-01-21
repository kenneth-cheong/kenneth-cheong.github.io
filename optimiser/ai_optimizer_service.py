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

        # Core SEO Guidelines based on EEAT and User Satisfaction
        seo_guidelines = """
CRITICAL CONTENT GUIDELINES:
1. EXPERIENCE (E): Write with a first-person perspective or direct experience. Include reviews or anecdotal evidence where possible.
2. EXPERTISE (E): Provide deep, focused subject matter coverage specifically confined to the intent of the keyword.
3. AUTHORITATIVENESS (A): Reference credible sources, quotes, and cite references (use placeholders like [Source: Name] for links).
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

        system_msg = f"You are an expert SEO & content editor trained on the latest Search Quality Rater Guidelines (EEAT). Your goal is to create high-quality, targeted content that is both useful to readers and optimized for search engines.{seo_guidelines}{keyword_context}{settings_context}"
        
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
                ],
                "temperature": 0.7
            },
            timeout=25
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
