```python
import json
import requests
import os

def lambda_handler(event, context):
    data = event.get('data', [])
    manual = event.get('manual', "")
    existing_personas = event.get('existing_personas', []) # List of names/roles already generated
    
    gpt_url = "https://api.openai.com/v1/responses"
    gpt_key = os.environ['GPT_KEY']

    # Convert existing personas to a string for the prompt
    history_str = ", ".join(existing_personas) if existing_personas else "None"

    prompt = f"""You are a digital marketing expert. Your task is to create 10 COMPLETELY DISTINCT and highly diverse customer personas (with names). 

AESTHETIC & STRATEGIC REQUIREMENT:
- You MUST research the company/product info provided below.
- Use your web search tool to find the specific products, services, and unique selling points of the company if URLs are provided. 
- Ensure the personas correspond to real potential customers in Singapore (unless otherwise stated).
- AVOID REPEATING or overlapping with these already generated personas: {history_str}.
- Each of the 10 personas must represent a different market segment, life stage, or psychographic profile.

Format each persona as a single HTML block:
<div class="persona-card">
    <div class="persona-header">
        <h3>[Persona Name]</h3>
        <p class="persona-age">Age: [Age]</p>
    </div>
    <div class="persona-body">
        <div class="persona-section"><strong>Bio:</strong><p>[Bio Content - 25+ words]</p></div>
        <div class="persona-section"><strong>Frustrations:</strong><ul><li>[Point 1]</li><li>[Point 2]</li></ul></div>
        <div class="persona-section"><strong>Goals / Interests:</strong><ul><li>[Point 1]</li><li>[Point 2]</li></ul></div>
        <div class="persona-section"><strong>Influences:</strong><ul><li>[Point 1]</li><li>[Point 2]</li></ul></div>
        <div class="persona-section"><strong>Channels:</strong><ul><li>[Point 1]</li><li>[Point 2]</li></ul></div>
        <div class="persona-section"><strong>Behavior:</strong><ul><li>[Point 1]</li><li>[Point 2]</li></ul></div>
    </div>
    <div class="persona-rationale">
        <strong>Rationale:</strong>
        <p>[2-3 sentences explaining why this persona is recommended based on found product data.]</p>
    </div>
</div>

Company/Product Info: {json.dumps(data)}
Additional Instructions: {manual}

Output ONLY the HTML for the 10 cards. No markdown fences.
"""

    payload = {
        "model": "gpt-4o-mini",
        "input": [
            {"role": "system", "content": "You are a helpful assistant that generates marketing personas in HTML format."},
            {"role": "user", "content": prompt}
        ],
        "tools": [{"type": "web_search"}]
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": gpt_key
    }
    
    try:
        response = requests.post(gpt_url, headers=headers, json=payload)
        response.raise_for_status()
        resp_data = response.json()
        
        # Extraction logic for /v1/responses
        last_output = resp_data.get('output', [])[-1]
        html_content = ""
        if 'content' in last_output:
            for part in last_output['content']:
                if 'text' in part:
                    html_content += part['text']
        
        # Clean up any leftover markdown markers or newlines
        html_content = html_content.replace('```html', '').replace('```', '').replace('\n', '')
        
        return {
            'statusCode': 200,
            'body': html_content
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': f"Error: {str(e)}"
        }
```