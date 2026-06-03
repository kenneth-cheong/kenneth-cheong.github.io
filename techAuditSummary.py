import json
import requests
import os

def lambda_handler(event, context):
    crawl = event.get('crawl', {})
    gtmetrix = event.get('gtmetrix', {})
    webpage_audit = event.get('webpage_audit', {})

    # 2. Construct Strategist Persona and Prompt
    instructions = (
        "You are a Senior Technical SEO Auditor. Your goal is to synthesize data into a clear technical report. "
        "\n\nFORMATTING RULES:\n"
        "1. Output exactly THREE HTML tables using a flexbox container: "
        "<div style='display: flex; gap: 20px; flex-wrap: wrap; margin-top: 20px;'>\n"
        "2. Each table MUST have class='summary-table'.\n"
        "3. ASSESSMENT COLORS: Use <span> tags with font-weight: bold; and color: #2e7d32 (Good), #ed6c02 (Moderate), or #d32f2f (Bad).\n"
        "4. ASSESSMENT LOGIC:\n"
        "   - 'Googlebot blocked': Specifically check if 'User-agent: Googlebot' is followed by 'Disallow: /' in robots_txt. If BOTH exist in that order, output 'Yes' (color: #d32f2f;). Otherwise, output 'No' (color: #2e7d32;).\n"
        "   - 'Google-safe site': If 'None Detected', 'Yes', or 'Clean' (case-insensitive) is found, output 'Good'. Otherwise assessment is 'Bad'.\n"
        "5. Table 1 (Site Overview & Security): Metric and Assessment. "
        "Include: CLS, LCP, TBT, PageSpeed, Googlebot blocked, Google-safe site, Sitemap.\n"
        "6. Table 2 (On-Page & Accessibility): Metric and Status/Count. "
        "Include: Duplicate Titles, Duplicate Descriptions, Missing H1 Tags, Missing Image Alt Text, Broken Links (4xx).\n"
        "7. Table 3 (Structure & Visibility): Metric and Assessment. "
        "Include: Schema Markup (Micromarkup), OG/Social Tags, SEO Friendly URLs, Mobile Friendly layout.\n"
        "8. STRICT COUNTS: Use the 'total_pages' provided to express counts as '0 out of {total_pages}'. DO NOT use 'X'.\n"
        "9. Output ONLY the raw HTML div and tables. No markdown formatting."
    )

    total_pages = event.get('total_pages', '10') # Default to 10 if missing

    prompt = (
        f"Analyze this data and provide 3 summary tables.\n\n"
        f"GTmetrix Performance: {json.dumps(gtmetrix)}\n\n"
        f"Webpage Audit Security: {json.dumps(webpage_audit)}\n\n"
        f"Website Crawl Data: {json.dumps(crawl)}\n\n"
        f"Total Pages Crawled: {total_pages}\n\n"
        f"CRITICAL: For every metric in Table 2 and Table 3 that requires a count, you MUST use the format 'N out of {total_pages}' where '{total_pages}' is exactly the value provided above. Do NOT use 0 unless there are truly 0 issues. If you see data in the 'Website Crawl Data', use it to calculate N."
    )

    # 3. Call Anthropic Messages API
    api_key = os.environ.get('ANTHROPIC_API_KEY')

    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json"
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 4096,
                "system": instructions,
                "messages": [{"role": "user", "content": prompt}]
            }
        )
        response.raise_for_status()
        response_data = response.json()
        html_output = response_data['content'][0]['text']
        
        # Clean up any potential markdown headers if they slipped through
        html_output = html_output.replace('```html', '').replace('```', '')

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': html_output
        }

    except Exception as e:
        print(f"Error calling Anthropic API: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }