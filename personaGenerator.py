import json
import requests
import os

def lambda_handler(event, context):
    data = event['data']
    try:
        manual = event['manual']
    except KeyError:
        manual = ""  # Handle the case where 'manual' is not provided

    gpt_url = "https://api.openai.com/v1/chat/completions"
    gpt_key = os.environ['GPT_KEY']

    prompt = """You are a digital marketing expert crafting personas for a marketing campaign. Your task is to create 5 distinct personas tailored to the company's offering.

For each persona, provide the following information, formatted as a single HTML block wrapped in <div class="persona-card">. Use the following internal structure:

<div class="persona-card">
    <div class="persona-header">
        <h3>[Persona Name]</h3>
        <p class="persona-age">Age: [Age]</p>
    </div>
    <div class="persona-body">
        <div class="persona-section">
            <strong>Bio:</strong>
            <p>[Bio Content - at least 25 words]</p>
        </div>
        <div class="persona-section">
            <strong>Frustrations:</strong>
            <ul><li>[Point 1]</li><li>[Point 2]</li>...</ul>
        </div>
        <div class="persona-section">
            <strong>Goals / Interests:</strong>
            <ul><li>[Point 1]</li><li>[Point 2]</li>...</ul>
        </div>
        <div class="persona-section">
            <strong>Influences:</strong>
            <ul><li>[Point 1]</li><li>[Point 2]</li>...</ul>
        </div>
        <div class="persona-section">
            <strong>Channels:</strong>
            <ul><li>[Point 1]</li><li>[Point 2]</li>...</ul>
        </div>
        <div class="persona-section">
            <strong>Behavior:</strong>
            <ul><li>[Point 1]</li><li>[Point 2]</li>...</ul>
        </div>
    </div>
    <div class="persona-rationale">
        <strong>Rationale:</strong>
        <p>[2-3 sentences explaining why this persona is recommended and how targeting them contributes to success.]</p>
    </div>
</div>

Assume that the personas are based in Singapore unless otherwise stated.

Company / Product Information: """ + json.dumps(data) + """

Additional Instructions: """ + manual + """

**Output:** Provide ONLY the HTML for the 5 cards. No intro or outro.
"""
    querystring = {"model":"gpt-4o-mini",
    "messages":[{"role": "user", "content": prompt}]}
    headers = {
        "Content-Type": "application/json",
        'Authorization': gpt_key
        }
    
    response = requests.post(gpt_url, headers=headers, json=querystring)

    return {
        'statusCode': 200,
        'body': response.json()['choices'][0]['message']['content'].replace('```html','').replace('```','').replace('\n', '')
    }