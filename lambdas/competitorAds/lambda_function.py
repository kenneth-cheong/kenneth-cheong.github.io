"""
competitorAds — proxy for SE Ranking's Domain Analysis API (paid/ads keywords).

Given a competitor domain, returns the Google paid-search keywords it bids on
together with the live ad copy (title / description / display URL), CPC and
search volume. Backs the "Pull ad data" button in the Performance Marketing
Audit (index.html).

Request  (POST, JSON):  { "domain": "oom.com.sg", "source": "sg", "limit": 30 }
Response (JSON):        { "domain": ..., "source": ..., "ads": [ { keyword, cpc, volume, ... }, ... ] }

SE Ranking endpoint:  GET https://api.seranking.com/v1/domain/keywords?type=adv
Auth:                 Authorization: Token <SERANKING_API_KEY>   (~100 credits/request)
"""
import json
import os
import base64
import urllib.request
import urllib.parse
import urllib.error

API_KEY = os.environ.get('SERANKING_API_KEY', '')
BASE = 'https://api.seranking.com/v1/domain/keywords'
COLS = 'keyword,cpc,volume,competition,block_position,snippet_title,snippet_description,snippet_display_url,url'

CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Content-Type': 'application/json',
}


def _resp(code, body):
    return {'statusCode': code, 'headers': CORS, 'body': json.dumps(body)}


def _method(event):
    rc = event.get('requestContext') or {}
    http = rc.get('http') or {}
    return http.get('method') or event.get('httpMethod') or 'POST'


def _clean_domain(d):
    d = (d or '').strip().lower()
    for p in ('https://', 'http://'):
        if d.startswith(p):
            d = d[len(p):]
    if d.startswith('www.'):
        d = d[4:]
    return d.split('/')[0].split('?')[0].split('#')[0].strip()


def lambda_handler(event, context):
    if _method(event) == 'OPTIONS':
        return _resp(200, {'ok': True})

    try:
        raw = event.get('body') or '{}'
        if event.get('isBase64Encoded'):
            raw = base64.b64decode(raw).decode('utf-8')
        data = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        data = {}

    domain = _clean_domain(data.get('domain'))
    source = (data.get('source') or 'sg').strip().lower()
    try:
        limit = int(data.get('limit') or 30)
    except Exception:
        limit = 30
    limit = max(1, min(limit, 100))

    if not domain:
        return _resp(400, {'error': 'domain is required'})
    if not API_KEY:
        return _resp(500, {'error': 'SE Ranking API key not configured'})

    qs = urllib.parse.urlencode({
        'source': source,
        'domain': domain,
        'type': 'adv',
        'limit': limit,
        'cols': COLS,
    })
    req = urllib.request.Request(BASE + '?' + qs, headers={'Authorization': 'Token ' + API_KEY})

    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            payload = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'ignore')[:500]
        except Exception:
            pass
        code = e.code if e.code in (400, 401, 402, 403, 404, 429) else 502
        return _resp(code, {'error': 'SE Ranking request failed', 'status': e.code, 'detail': detail})
    except Exception as e:
        return _resp(502, {'error': str(e)})

    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        rows = payload.get('data') or payload.get('keywords') or []
    else:
        rows = []

    return _resp(200, {'domain': domain, 'source': source, 'ads': rows})
