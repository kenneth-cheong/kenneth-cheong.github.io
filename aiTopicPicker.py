import json
import os
import re

import requests


def _extract_topics(response_data):
    """Robustly pull the JSON topic array out of a Claude Messages API response.

    With the web_search tool, Claude emits a *preamble* text block ("I'll search
    for...") BEFORE the tool-use / tool-result blocks, and the actual JSON array
    arrives in a LATER text block. So we must look at the final text block that
    contains an array, not the first text block. We also salvage truncated output
    (max_tokens cut-off) by scraping the quoted strings.
    """
    text_blocks = [
        b.get('text', '')
        for b in response_data.get('content', [])
        if b.get('type') == 'text'
    ]

    # Prefer the last text block that actually contains an array opener; that is
    # the model's final answer. Fall back to all text joined, then last block.
    content = ''
    for t in reversed(text_blocks):
        if '[' in t:
            content = t
            break
    if not content:
        content = '\n'.join(text_blocks)

    content = content.strip()

    # Strip markdown code fences if present.
    if '```json' in content:
        content = content.split('```json')[1].split('```')[0].strip()
    elif '```' in content:
        content = content.split('```')[1].split('```')[0].strip()

    # Narrow to the JSON array region.
    start_idx = content.find('[')
    end_idx = content.rfind(']')
    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
        candidate = content[start_idx:end_idx + 1]
    else:
        candidate = content[start_idx:] if start_idx != -1 else content

    # First try a clean parse.
    try:
        parsed = json.loads(candidate)
        if isinstance(parsed, list):
            topics = [str(t).strip() for t in parsed if str(t).strip()]
            if topics:
                return topics
    except (ValueError, TypeError):
        pass

    # Salvage path: output was truncated (no closing ]) or otherwise malformed.
    # Scrape complete quoted strings; a trailing partial (no closing quote) is
    # naturally dropped, so we keep every topic that fully arrived.
    salvaged = re.findall(r'"((?:[^"\\]|\\.)*)"', candidate)
    topics = [s.strip() for s in salvaged if s.strip()]
    return topics


def lambda_handler(event, context):
    primary_keyword = event.get('primary_keyword', '')
    secondary_keywords = event.get('secondary_keywords', [])
    all_topics = event.get('all_topics', [])
    location = event.get('location', 'Singapore')

    api_key = os.environ.get('CLAUDE_API_KEY')

    cors_headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'OPTIONS,POST'
    }

    if not api_key:
        return {'statusCode': 500, 'headers': cors_headers, 'body': {'error': 'CLAUDE_API_KEY not found', 'selected_topics': []}}

    prompt = f"""You are an SEO expert. I have a list of content topics extracted from the top SERP competitors for the primary keyword: "{primary_keyword}" in {location}.
Secondary keywords (lower priority): {", ".join(secondary_keywords)}

Here are the topics found across competitors, with their frequency of occurrence:
{json.dumps(all_topics)}

Your task:
1. Perform a HOLISTIC analysis of all topics. Do not just pick from the top of the list.
2. Identify and consolidate highly similar or near-identical topics into a single, most representative topic. However, keep distinct sub-topics and nuanced variations as separate entries to ensure comprehensive coverage.
3. Weigh topics by their frequency across the competitive landscape. High-frequency topics are "Must-Haves".
4. Cherry-pick the most important 10-20 topics for a comprehensive content strategy for SEO ranking purposes. Ensure a mix of common "Must-Have" topics and unique "Differentiator" topics found in successful competitors.
5. Use the web_search tool to verify current SEO trends for this keyword to improve your selection and identify missing high-growth topics.
6. After any research, your FINAL message must be ONLY a JSON array of the selected topic strings, with no surrounding prose, explanation, or markdown fences.

Format: ["Consolidated Topic A", "Must-Have Topic B", "Unique Insight C", ...]"""

    try:
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "web-search-2025-03-05",
                "content-type": "application/json"
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 2048,
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
                "messages": [{"role": "user", "content": prompt}]
            },
            timeout=120
        )
        response.raise_for_status()
        response_data = response.json()
        print("Stop reason:", response_data.get('stop_reason'))

        selected_topics = _extract_topics(response_data)
        print("Selected topics:", selected_topics)

        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': {'selected_topics': selected_topics}
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': {'error': str(e), 'selected_topics': []}
        }
