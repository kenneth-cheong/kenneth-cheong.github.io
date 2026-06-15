"""
competitorAds — proxy for DataForSEO Labs (a competitor's Google PAID-search ads).

Given a competitor domain, returns the paid keywords it bids on together with the
live ad copy (title / description / URL), CPC and search volume. Backs the
"Their paid keywords" panel in the Performance Marketing Audit (index.html).

Request  (POST, JSON):  { "domain": "oom.com.sg", "source": "sg", "limit": 25 }
Response (JSON):        { "domain": ..., "ads": [ { keyword, cpc, volume, snippet_title, ... }, ... ] }

DataForSEO endpoint: POST https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live
Auth:                Authorization: Basic <DATAFORSEO_AUTH>   (base64 of login:password)
"""
import json
import os
import base64
import urllib.request
import urllib.error

DATAFORSEO_AUTH = os.environ.get('DATAFORSEO_AUTH', '')
DFS_URL = 'https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live'

# Map the country code the frontend sends to a DataForSEO location_name.
LOC = {
    'sg': 'Singapore', 'my': 'Malaysia', 'id': 'Indonesia', 'us': 'United States',
    'au': 'Australia', 'gb': 'United Kingdom', 'uk': 'United Kingdom', 'in': 'India',
    'ph': 'Philippines', 'th': 'Thailand', 'vn': 'Vietnam', 'hk': 'Hong Kong',
    'tw': 'Taiwan', 'jp': 'Japan', 'kr': 'South Korea', 'cn': 'China', 'ca': 'Canada',
    'nz': 'New Zealand', 'ae': 'United Arab Emirates', 'sa': 'Saudi Arabia',
}

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
    return (rc.get('http') or {}).get('method') or event.get('httpMethod') or 'POST'


def _clean_domain(d):
    d = (d or '').strip().lower()
    for p in ('https://', 'http://'):
        if d.startswith(p):
            d = d[len(p):]
    if d.startswith('www.'):
        d = d[4:]
    return d.split('/')[0].split('?')[0].split('#')[0].strip()


def _num(v):
    return v if isinstance(v, (int, float)) else None


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
    location = data.get('location_name') or LOC.get(source, 'Singapore')
    language = data.get('language_name') or 'English'
    try:
        limit = int(data.get('limit') or 25)
    except Exception:
        limit = 25
    limit = max(1, min(limit, 100))

    if not domain:
        return _resp(400, {'error': 'domain is required'})
    if not DATAFORSEO_AUTH:
        return _resp(500, {'error': 'DataForSEO credentials not configured'})

    post = [{
        'target': domain,
        'location_name': location,
        'language_name': language,
        'limit': limit,
        'order_by': ['keyword_data.keyword_info.search_volume,desc'],
        'filters': [['ranked_serp_element.serp_item.type', '=', 'paid']],
    }]
    req = urllib.request.Request(
        DFS_URL,
        data=json.dumps(post).encode('utf-8'),
        headers={'Authorization': 'Basic ' + DATAFORSEO_AUTH, 'Content-Type': 'application/json'},
        method='POST',
    )

    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            payload = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            detail = e.read().decode('utf-8', 'ignore')[:500]
        except Exception:
            pass
        code = e.code if e.code in (401, 402, 403, 404, 429) else 502
        return _resp(code, {'error': 'DataForSEO request failed', 'status': e.code, 'detail': detail})
    except Exception as e:
        return _resp(502, {'error': str(e)})

    # Top-level + task status checks
    if not isinstance(payload, dict) or payload.get('status_code') != 20000:
        return _resp(502, {'error': 'DataForSEO error', 'detail': str(payload.get('status_message') if isinstance(payload, dict) else payload)[:300]})
    tasks = payload.get('tasks') or []
    task = tasks[0] if tasks else {}
    if task.get('status_code') != 20000:
        return _resp(502, {'error': 'DataForSEO task error', 'detail': str(task.get('status_message'))[:300]})

    results = task.get('result') or []
    items = (results[0].get('items') if results and isinstance(results[0], dict) else None) or []

    ads = []
    for it in items:
        kd = it.get('keyword_data') or {}
        ki = kd.get('keyword_info') or {}
        se = (it.get('ranked_serp_element') or {}).get('serp_item') or {}
        if se.get('type') and se.get('type') != 'paid':
            continue
        ads.append({
            'keyword': kd.get('keyword'),
            'cpc': _num(ki.get('cpc')),
            'volume': _num(ki.get('search_volume')),
            'block_position': se.get('rank_absolute') or se.get('rank_group'),
            'snippet_title': se.get('title'),
            'snippet_description': se.get('description'),
            'snippet_display_url': se.get('breadcrumb') or se.get('url'),
            'url': se.get('url'),
        })

    return _resp(200, {'domain': domain, 'location': location, 'ads': ads})
