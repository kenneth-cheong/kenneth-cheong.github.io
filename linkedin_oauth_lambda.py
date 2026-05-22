import json
import os
import re
import urllib.request
import urllib.parse

# Set in AWS Lambda environment variables:
#   LINKEDIN_CLIENT_ID     – from your LinkedIn Developer App
#   LINKEDIN_CLIENT_SECRET – from your LinkedIn Developer App
LINKEDIN_CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '')
LINKEDIN_CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '')
CLAUDE_API_KEY = os.environ.get('CLAUDE_API_KEY', '')

LINKEDIN_VERSION = '202501'  # Update monthly as needed


def lambda_handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': headers, 'body': ''}

    try:
        raw = event.get('body', '{}')
        body = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        body = {}

    action = body.get('action')

    try:
        if action == 'exchange':
            result = exchange_code(body)
        elif action == 'post':
            result = create_post(body)
        elif action == 'ai_extract':
            result = ai_extract(body)
        elif action == 'ai_generate':
            result = ai_generate(body)
        else:
            result = {'success': False, 'error': f'Unknown action: {action}'}
    except Exception as e:
        result = {'success': False, 'error': str(e)}

    return {
        'statusCode': 200,
        'headers': headers,
        'body': json.dumps(result),
    }


# ── Action: exchange code for access token + profile ──────────────────────────

def exchange_code(body):
    code = body.get('code', '').strip()
    redirect_uri = body.get('redirect_uri', '').strip()

    if not code:
        return {'success': False, 'error': 'Authorization code is missing.'}
    if not LINKEDIN_CLIENT_ID or not LINKEDIN_CLIENT_SECRET:
        return {'success': False, 'error': 'LinkedIn credentials are not configured on the server.'}

    # 1. Exchange code → access token
    token_params = urllib.parse.urlencode({
        'grant_type': 'authorization_code',
        'code': code,
        'client_id': LINKEDIN_CLIENT_ID,
        'client_secret': LINKEDIN_CLIENT_SECRET,
        'redirect_uri': redirect_uri,
    }).encode()

    token_req = urllib.request.Request(
        'https://www.linkedin.com/oauth/v2/accessToken',
        data=token_params,
        headers={'Content-Type': 'application/x-www-form-urlencoded'},
        method='POST',
    )

    try:
        with urllib.request.urlopen(token_req) as resp:
            token_data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        try:
            err_json = json.loads(error_body)
            detail = err_json.get('error_description') or err_json.get('message') or error_body
        except Exception:
            detail = error_body
        return {'success': False, 'error': f'LinkedIn token exchange {e.code}: {detail}'}

    if 'access_token' not in token_data:
        return {'success': False, 'error': f'Token exchange failed: {token_data.get("error_description", token_data)}'}

    access_token = token_data['access_token']

    # 2. Fetch OIDC userinfo (name, picture, email)
    profile_req = urllib.request.Request(
        'https://api.linkedin.com/v2/userinfo',
        headers={'Authorization': f'Bearer {access_token}'},
        method='GET',
    )

    with urllib.request.urlopen(profile_req) as resp:
        profile = json.loads(resp.read())

    # 'sub' is the person's unique LinkedIn ID used when posting
    person_id = profile.get('sub', '')

    return {
        'success': True,
        'access_token': access_token,
        'person_id': person_id,
        'name': profile.get('name', ''),
        'first_name': profile.get('given_name', ''),
        'last_name': profile.get('family_name', ''),
        'picture': profile.get('picture', ''),
        'email': profile.get('email', ''),
    }


# ── Action: publish post on behalf of member ──────────────────────────────────

def create_post(body):
    access_token = body.get('access_token', '').strip()
    person_id = body.get('person_id', '').strip()
    text = body.get('text', '').strip()

    if not access_token:
        return {'success': False, 'error': 'Access token is missing.'}
    if not person_id:
        return {'success': False, 'error': 'Person ID is missing.'}
    if not text:
        return {'success': False, 'error': 'Post text cannot be empty.'}
    if len(text) > 3000:
        return {'success': False, 'error': 'Post text exceeds LinkedIn\'s 3000-character limit.'}

    post_payload = json.dumps({
        'author': f'urn:li:person:{person_id}',
        'commentary': text,
        'visibility': 'PUBLIC',
        'distribution': {
            'feedDistribution': 'MAIN_FEED',
            'targetEntities': [],
            'thirdPartyDistributionChannels': [],
        },
        'lifecycleState': 'PUBLISHED',
        'isReshareDisabledByAuthor': False,
    }).encode()

    post_req = urllib.request.Request(
        'https://api.linkedin.com/rest/posts',
        data=post_payload,
        headers={
            'Authorization': f'Bearer {access_token}',
            'Content-Type': 'application/json',
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': LINKEDIN_VERSION,
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(post_req) as resp:
            post_id = resp.getheader('x-restli-id', '')
            return {'success': True, 'post_id': post_id}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return {'success': False, 'error': f'LinkedIn API {e.code}: {error_body}'}


# ── Action: extract event details from a URL ─────────────────────────────────

def ai_extract(body):
    if not CLAUDE_API_KEY:
        return {'success': False, 'error': 'AI is not configured on the server.'}

    url = body.get('url', '').strip()
    if not url:
        return {'success': False, 'error': 'URL is required.'}

    # Try to fetch the page; gracefully handle auth walls / errors
    page_text = ''
    try:
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (compatible; EventBot/1.0)'},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read().decode('utf-8', errors='ignore')
        # Strip HTML tags and collapse whitespace
        page_text = re.sub(r'<[^>]+>', ' ', raw)
        page_text = re.sub(r'\s+', ' ', page_text).strip()[:4000]
    except Exception:
        pass  # Claude will infer from URL alone

    prompt = f"""Extract structured event details from the URL and any page content provided.

URL: {url}
Page content (may be partial or empty if behind a login wall):
{page_text or "(page could not be fetched — infer from URL only)"}

Return ONLY a JSON object with these keys:
{{
  "event": "Full event name",
  "date": "Human-readable date, e.g. May 28, 2026",
  "format": "Event format, e.g. Virtual Webinar, In-Person Conference, Fireside Chat",
  "tags": "Comma-separated hashtag words without #, e.g. AISearch, Google, Marketing"
}}

Rules:
- Use empty string "" for any field you cannot determine
- For tags: derive from the event topic/industry, 5-8 tags
- Do not add any explanation — JSON only"""

    payload = json.dumps({
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 300,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()

    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=payload,
        headers={
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            raw_text = result['content'][0]['text'].strip()
            # Strip markdown fences if present
            raw_text = re.sub(r'^```[a-z]*\n?', '', raw_text)
            raw_text = re.sub(r'\n?```$', '', raw_text).strip()
            extracted = json.loads(raw_text)
            return {'success': True, **extracted}
    except urllib.error.HTTPError as e:
        return {'success': False, 'error': f'AI API {e.code}'}
    except Exception as e:
        return {'success': False, 'error': f'Extraction failed: {e}'}


# ── Action: generate post text with Claude ────────────────────────────────────

def ai_generate(body):
    if not CLAUDE_API_KEY:
        return {'success': False, 'error': 'AI generation is not configured on the server.'}

    event   = body.get('event', '').strip()
    date    = body.get('date', '').strip()
    fmt     = body.get('format', '').strip()
    url     = body.get('url', '').strip()
    tags    = body.get('tags', '').strip()

    if not event:
        return {'success': False, 'error': 'Event name is required for AI generation.'}

    tag_str = ' '.join(
        f"#{t.strip().lstrip('#')}"
        for t in tags.split(',') if t.strip()
    )
    link_line = f'Secure your spot here: {url}' if url else ''
    date_line = f'📅 {date} | {fmt} (Free)' if date else ''

    prompt = f"""Write a short, warm, first-person LinkedIn post for someone attending this event.

Event: {event}
Date: {date}
Format: {fmt}
{f"Registration link: {url}" if url else ""}

Rules:
- Open EXACTLY with: "I am delighted to be part of {event}! 🎉"
- 2–3 sentences of genuine excitement — what they are looking forward to learning or experiencing
- Then on its own line: "{date_line}"
{f'- Then on its own line: "{link_line}"' if link_line else ""}
- End with the hashtags on their own line: {tag_str}
- Total: 80–160 words
- No extra hashtags, no preamble, no sign-off — only the post text"""

    payload = json.dumps({
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 400,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()

    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=payload,
        headers={
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            text = result['content'][0]['text'].strip()
            return {'success': True, 'text': text}
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return {'success': False, 'error': f'AI API {e.code}: {error_body}'}
