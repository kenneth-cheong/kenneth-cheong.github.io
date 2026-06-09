"""
clientSatisfaction Lambda
Returns aggregated client satisfaction data from:
  1. Google Maps reviews (DataForSEO Business Data API, results cached in MongoDB 24h)
  2. Support ticket ratings (client portal /api/v1/ratings/internal-stats)

GET  ?action=maps    → Maps rating + recent reviews
GET  ?action=ratings → Portal CSAT ratings
GET  (default)       → both combined
POST { action, force_refresh: true } → bypass cache for Maps
"""

import json
import os
import time
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient
from pymongo.errors import PyMongoError

DATAFORSEO_KEY    = os.environ.get('DATAFORSEO_API_KEY', '')
PORTAL_RATINGS_URL = os.environ.get('PORTAL_RATINGS_URL', '')
PORTAL_RATINGS_KEY = os.environ.get('PORTAL_RATINGS_KEY', '')
MONGODB_URI       = os.environ.get('MONGODB_URI', '')

MAPS_BUSINESS_NAME  = 'MediaOne Digital Marketing Agency'
MAPS_LOCATION       = 'Singapore'
MAPS_CACHE_HOURS    = 24
TASK_POLL_INTERVAL  = 5
TASK_MAX_POLLS      = 36

_mongo_client = None


def cors_headers():
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key',
        'Access-Control-Allow-Methods': 'OPTIONS,GET,POST',
    }


def ok(data):
    return {'statusCode': 200, 'headers': cors_headers(), 'body': json.dumps(data, default=str)}


def err(msg, code=500):
    return {'statusCode': code, 'headers': cors_headers(), 'body': json.dumps({'error': msg})}


# ── MongoDB helpers ───────────────────────────────────────────────────────────

def get_db():
    global _mongo_client
    if _mongo_client is None and MONGODB_URI:
        _mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    return _mongo_client['digimetrics'] if _mongo_client else None


def cache_get(key):
    db = get_db()
    if db is None:
        return None
    try:
        doc = db['satisfaction_cache'].find_one({'_id': key})
        if not doc:
            return None
        expires = doc.get('expires_at')
        if expires:
            if expires.tzinfo is not None:
                expires = expires.replace(tzinfo=None)
            if datetime.utcnow() > expires:
                return None
        return doc.get('data')
    except Exception:
        return None


def cache_set(key, data, hours=MAPS_CACHE_HOURS):
    db = get_db()
    if db is None:
        return
    try:
        db['satisfaction_cache'].replace_one(
            {'_id': key},
            {
                '_id': key,
                'data': data,
                'cached_at': datetime.now(timezone.utc),
                'expires_at': datetime.now(timezone.utc) + timedelta(hours=hours),
            },
            upsert=True,
        )
    except PyMongoError:
        pass


# ── Google Maps via DataForSEO ────────────────────────────────────────────────

def _dfs_headers():
    return {'Authorization': DATAFORSEO_KEY, 'Content-Type': 'application/json'}


def _post_reviews_task():
    payload = [{
        'keyword': MAPS_BUSINESS_NAME,
        'location_name': MAPS_LOCATION,
        'language_name': 'English',
        'depth': 20,
        'sort_by': 'newest',
    }]
    r = requests.post(
        'https://api.dataforseo.com/v3/business_data/google/reviews/task_post',
        headers=_dfs_headers(), json=payload, timeout=20,
    )
    r.raise_for_status()
    tasks = r.json().get('tasks', [])
    if not tasks:
        raise ValueError('DataForSEO: no tasks returned')
    task = tasks[0]
    if task.get('status_code') not in (20000, 20100):
        raise ValueError(f"DataForSEO task error: {task.get('status_code')} {task.get('status_message')}")
    return task['id']


def _poll_reviews_task(task_id):
    url = f'https://api.dataforseo.com/v3/business_data/google/reviews/task_get/{task_id}'
    for _ in range(TASK_MAX_POLLS):
        time.sleep(TASK_POLL_INTERVAL)
        r = requests.get(url, headers=_dfs_headers(), timeout=20)
        r.raise_for_status()
        task = r.json().get('tasks', [{}])[0]
        code = task.get('status_code')
        if code == 20000:
            return (task.get('result') or [{}])[0]
        if code not in (20100, 40602):
            raise ValueError(f"DataForSEO poll error: {code} {task.get('status_message')}")
    raise TimeoutError('DataForSEO task timed out after 180s')


def _fetch_maps_from_dataforseo():
    task_id = _post_reviews_task()
    result = _poll_reviews_task(task_id)

    overall = result.get('rating', {})
    reviews = []
    for item in result.get('items', []):
        if item.get('type') != 'google_reviews_search':
            continue
        rating_info = item.get('rating', {})
        reviews.append({
            'author': item.get('profile_name'),
            'rating': rating_info.get('value'),
            'text': item.get('review_text', ''),
            'date': item.get('timestamp'),
            'helpful_votes': item.get('helpful_votes', 0),
        })

    return {
        'rating': overall.get('value'),
        'total_reviews': overall.get('votes_count'),
        'recent_reviews': reviews[:20],
        'source': 'dataforseo',
        'fetched_at': datetime.now(timezone.utc).isoformat(),
    }


def get_maps_data(force_refresh=False):
    cache_key = 'maps_mediaone'
    if not force_refresh:
        cached = cache_get(cache_key)
        if cached:
            cached['from_cache'] = True
            return cached

    data = _fetch_maps_from_dataforseo()
    cache_set(cache_key, data, hours=MAPS_CACHE_HOURS)
    data['from_cache'] = False
    return data


# ── Portal CSAT ratings ───────────────────────────────────────────────────────

def get_portal_ratings():
    if not PORTAL_RATINGS_URL:
        return {'status': 'not_configured', 'message': 'Set PORTAL_RATINGS_URL and PORTAL_RATINGS_KEY env vars'}

    try:
        r = requests.get(
            PORTAL_RATINGS_URL,
            headers={'x-api-key': PORTAL_RATINGS_KEY, 'Content-Type': 'application/json'},
            timeout=10,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {'status': 'error', 'message': str(e)}


# ── Handler ───────────────────────────────────────────────────────────────────

def lambda_handler(event, context):
    print('Event:', json.dumps(event))

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': cors_headers(), 'body': ''}

    body = {}
    qs = event.get('queryStringParameters') or {}
    if 'body' in event and isinstance(event.get('body'), str):
        try:
            body = json.loads(event['body'])
        except Exception:
            pass
    elif isinstance(event, dict):
        body = event

    action = body.get('action') or qs.get('action') or 'all'
    force_refresh = body.get('force_refresh', False)

    try:
        if action == 'maps':
            return ok({'google_maps': get_maps_data(force_refresh)})

        if action == 'ratings':
            return ok({'support_ratings': get_portal_ratings()})

        # action == 'all'
        maps_data = get_maps_data(force_refresh)
        ratings_data = get_portal_ratings()

        return ok({
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'google_maps': maps_data,
            'support_ratings': ratings_data,
        })

    except Exception as e:
        print(f'Error: {e}')
        import traceback
        traceback.print_exc()
        return err(str(e))
