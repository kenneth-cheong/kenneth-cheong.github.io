import json
import requests
import os
import time

CLAUDE_URL = "https://api.anthropic.com/v1/messages"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_MODEL = "deepseek-chat"


def _call_deepseek(api_key, system, user_prompt, max_tokens=8192):
    """Call DeepSeek (OpenAI-compatible shape). No web search: only safe for the
    'generate' action, which works purely from the context passed in."""
    response = requests.post(
        DEEPSEEK_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        json={
            "model": DEEPSEEK_MODEL,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user_prompt},
            ],
        },
        timeout=120,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"DeepSeek API error -> {response.status_code}: {response.text[:500]}"
        )
    data = response.json()
    choices = data.get("choices") or []
    return choices[0]["message"]["content"] if choices else ""


def _call_claude(api_key, system, user_prompt, max_tokens=8192, use_web_search=True):
    """Call the Anthropic Messages API with retry/backoff on rate limits and
    overload. Falls back to a tool-less request if web search is rejected.
    Returns the concatenated text of all text blocks."""
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01"
    }

    def build_payload(with_tools):
        payload = {
            "model": CLAUDE_MODEL,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user_prompt}]
        }
        if with_tools:
            payload["tools"] = [{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5
            }]
        return payload

    with_tools = use_web_search
    last_error = ""
    for attempt in range(4):
        response = requests.post(
            CLAUDE_URL, headers=headers, json=build_payload(with_tools), timeout=120
        )
        if response.status_code == 200:
            data = response.json()
            text = "".join(
                block.get("text", "")
                for block in data.get("content", [])
                if block.get("type") == "text"
            )
            return text
        last_error = f"{response.status_code}: {response.text[:500]}"
        # If web search isn't accepted for this model/account, retry without it
        if with_tools and response.status_code == 400 and "web_search" in response.text:
            with_tools = False
            continue
        # Back off on rate limit / overload, otherwise stop
        if response.status_code in (429, 500, 502, 503, 529):
            time.sleep(2 ** attempt)
            continue
        break
    raise RuntimeError(f"Claude API error after retries -> {last_error}")


def lambda_handler(event, context):
    action = event.get('action', 'generate')  # Default to generate
    data = event.get('data', [])
    manual = event.get('manual', "")
    existing_personas = event.get('existing_personas', [])
    provider = (event.get('provider') or '').lower()

    claude_key = os.environ['CLAUDE_API_KEY']

    if action == 'research':
        system = "You are a marketing research assistant."
        prompt = f"""Use your web search tool to research the following company/product info.
Summarize the key products, services, and unique selling points found.
Keep the summary concise but comprehensive enough to build marketing personas from.

Company/Product Info: {json.dumps(data)}
Additional Instructions: {manual}

Output ONLY the text summary. Do not use markup formatting.
"""
        use_web_search = True
    else:
        # Generate Personas logic
        history_str = ", ".join(existing_personas) if existing_personas else "None"
        system = "You are an award-winning brand strategist and ethnographer who is famous for inventing vivid, surprising, true-to-life customer personas that marketing teams instantly recognise. You output clean HTML."
        prompt = f"""Create 10 customer personas for the company/product below. They must be CREATIVE, memorable, and COMPLETELY DISTINCT from one another — no two should feel like variations of the same person.

DISTINCTNESS — plan before you write:
- First, silently assign each of the 10 personas a UNIQUE combination across these axes; no two personas may share the same value on MORE THAN ONE axis:
  (a) generation / age band (Gen Z ~18-26, younger Millennial, older Millennial, Gen X, Boomer, senior),
  (b) life stage (student, fresh grad, single professional, new couple, young family, established family, empty-nester, retiree),
  (c) income tier (budget-conscious, middle-income, affluent, high-net-worth),
  (d) core psychographic / values (e.g. status-seeker, pragmatist, eco-idealist, nostalgic traditionalist, early-adopter, community-minded, time-poor optimiser),
  (e) primary motivation for this product, and
  (f) dominant channel mix.
- No two personas may share a first name, and ages must span a wide range (do not cluster).

CREATIVITY & REALISM:
- Use specific, believable Singapore details: a real-feeling multicultural name (mix Chinese, Malay, Indian, Eurasian, and expat backgrounds across the set), a concrete neighbourhood, a specific job/employer type, real brands/apps they use, and one unexpected-but-telling habit or quirk. Avoid clichés and generic stock archetypes — make each person feel like a real individual, not a demographic label.
- Tie every persona's goals, frustrations, and behaviour back to the actual product/service offered.

OTHER REQUIREMENTS:
- You MUST base the personas on the company/product info provided below.
- Keep them as real potential customers in Singapore (unless otherwise stated).
- AVOID REPEATING or overlapping with these already generated personas: {history_str}.

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
        use_web_search = False

    # 'research' exists purely to web-search the company, and DeepSeek has no web
    # access — routing it there would invent product offerings rather than find
    # them, so it stays on Claude regardless of the requested provider. 'generate'
    # runs with use_web_search=False and works only from the context passed in,
    # so it is safe to route. Anything other than 'deepseek' keeps Claude.
    use_deepseek = provider == 'deepseek' and not use_web_search

    try:
        if use_deepseek:
            deepseek_key = os.environ.get('DEEPSEEK_API_KEY')
            if not deepseek_key:
                raise RuntimeError('Missing DEEPSEEK_API_KEY env var.')
            content = _call_deepseek(deepseek_key, system, prompt, max_tokens=8192)
        else:
            content = _call_claude(
                claude_key, system, prompt,
                max_tokens=8192, use_web_search=use_web_search
            )

        if action == 'generate':
            content = content.replace('```html', '').replace('```', '').replace('\n', '')

        return {
            'statusCode': 200,
            'body': content
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': f"Error: {str(e)}"
        }
