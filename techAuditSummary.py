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
        "1. Output exactly TWO HTML tables side-by-side using a flexbox container: "
        "<div style='display: flex; gap: 30px; flex-wrap: wrap; margin-top: 20px;'>\n"
        "2. Each table MUST have class='summary-table'.\n"
        "3. ASSESSMENT COLORS: Use <span> tags with inline styles for assessment values: "
        "Good = color: #2e7d32; font-weight: bold; Moderate = color: #ed6c02; font-weight: bold; Bad = color: #d32f2f; font-weight: bold;\n"
        "4. ASSESSMENT LOGIC:\n"
        "   - 'Googlebot blocked': If robots_txt contains 'Disallow: /' (full site block), it is 'Bad'. Otherwise, it is 'Good'. Partial disallows (e.g. /admin/) are 'Good'.\n"
        "   - 'Google-safe site': 'None Detected', 'Yes', or 'Clean' means 'Good'. Any mention of malware or 'No' means 'Bad'.\n"
        "   - 'PageSpeed': >90 is 'Good', 50-90 is 'Moderate', <50 is 'Bad'.\n"
        "5. Table 1 (Homepage Performance & Security): 'Metric' and 'Assessment' columns. "
        "Assess: CLS, LCP, TBT, PageSpeed, Googlebot blocked, Google-safe site, Sitemap.\n"
        "6. Table 2 (Crawler Analysis): 'Metric' and 'Status/Percentage' columns. "
        "Summarize: Duplicates (Titles/Desc/H1/H2), 4xx/5xx errors, UI/UX.\n"
        "7. Output ONLY the raw HTML div and tables. No markdown, no intro text."
    )

    prompt = (
        f"Analyze the following technical data and provide the two summary tables.\n\n"
        f"GTmetrix Performance: {json.dumps(gtmetrix)}\n\n"
        f"Webpage Audit Security: {json.dumps(webpage_audit)}\n\n"
        f"Website Crawl Data: {json.dumps(crawl)}\n\n"
        f"Adhere to the audit guidelines: assess metrics as 'Bad', 'Moderate', or 'Good' in the first table. "
        f"Calculate percentages based on the number of items in the crawl data for the second table."
    )

    # 3. Call OpenAI Responses API
    gpt_key = os.environ.get('GPT_KEY')
    url = "https://api.openai.com/v1/responses"
    headers = {
        "Authorization": 'Bearer ' + gpt_key,
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": "gpt-4o-mini",
        "instructions": instructions,
        "input": [
            {
                "role": "system",
                "content": instructions
            },
            {
                "role": "user",
                "content": prompt
            }
        ]
    }
    
    try:
        response = requests.post(url, headers=headers, json=payload)
        response.raise_for_status()
        response_data = response.json()
        
        # Extract the content from the 'responses' endpoint structure
        # output is a list, usually the last item is the assistant response
        output_content = response_data['output'][-1]['content'][0]
        html_output = output_content.get('text', '')
        
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
        print(f"Error calling OpenAI API: {e}")
        return {
            'statusCode': 500,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            'body': json.dumps({'error': str(e)})
        }