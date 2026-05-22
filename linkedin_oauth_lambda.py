import json
import os
import urllib.request
import urllib.parse

# Set in AWS Lambda environment variables:
#   LINKEDIN_CLIENT_ID     – from your LinkedIn Developer App
#   LINKEDIN_CLIENT_SECRET – from your LinkedIn Developer App
LINKEDIN_CLIENT_ID = os.environ.get('LINKEDIN_CLIENT_ID', '')
LINKEDIN_CLIENT_SECRET = os.environ.get('LINKEDIN_CLIENT_SECRET', '')

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

    with urllib.request.urlopen(token_req) as resp:
        token_data = json.loads(resp.read())

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
