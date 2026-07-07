import json
import os
import urllib.request
import urllib.parse
import urllib.error
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor

def lambda_handler(event, context):
    CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }

    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS, 'body': ''}

    try:
        body = json.loads(event.get('body') or '{}')
    except Exception:
        return {'statusCode': 400, 'headers': CORS, 'body': json.dumps({'error': 'Invalid JSON body'})}

    endpoint = body.get('endpoint')
    params   = body.get('params', {})

    api_key = os.environ.get('AHREFS_API_KEY', '')
    if not api_key:
        return {'statusCode': 500, 'headers': CORS, 'body': json.dumps({'error': 'AHREFS_API_KEY not configured'})}

    today = date.today().isoformat()

    def ahrefs_get(path, p):
        qs  = urllib.parse.urlencode(p)
        url = f'https://api.ahrefs.com/v3{path}?{qs}'
        req = urllib.request.Request(url, headers={
            'Authorization': f'Bearer {api_key}',
            'Accept': 'application/json'
        })
        with urllib.request.urlopen(req, timeout=18) as resp:
            return json.loads(resp.read().decode('utf-8'))

    def ok(data):
        return {'statusCode': 200,
                'headers': {**CORS, 'Content-Type': 'application/json'},
                'body': json.dumps(data)}

    def upstream_error(e):
        if isinstance(e, urllib.error.HTTPError):
            detail = e.read().decode('utf-8', 'ignore')
            return {'statusCode': 502, 'headers': CORS,
                    'body': json.dumps({'error': f'Ahrefs {e.code}: {detail}'})}
        return {'statusCode': 502, 'headers': CORS, 'body': json.dumps({'error': str(e)})}

    if endpoint == 'overview':
        target = params.get('target', '')
        try:
            with ThreadPoolExecutor(max_workers=3) as ex:
                bl_f = ex.submit(ahrefs_get, '/site-explorer/backlinks-stats',
                                 {'target': target, 'date': today})
                mt_f = ex.submit(ahrefs_get, '/site-explorer/metrics',
                                 {'target': target, 'date': today,
                                  'select': 'org_keywords,org_traffic'})
                dr_f = ex.submit(ahrefs_get, '/site-explorer/domain-rating',
                                 {'target': target, 'date': today})
            bl = bl_f.result().get('metrics', {})
            mt = mt_f.result().get('metrics', {})
            dr = dr_f.result().get('domain_rating', {})
            result = {
                'domain_rating':     dr.get('domain_rating'),
                'backlinks':         bl.get('live'),
                'referring_domains': bl.get('live_refdomains'),
                'org_keywords':      mt.get('org_keywords'),
                'org_traffic':       mt.get('org_traffic')
            }
            return {'statusCode': 200,
                    'headers': {**CORS, 'Content-Type': 'application/json'},
                    'body': json.dumps(result)}
        except Exception as e:
            return {'statusCode': 502, 'headers': CORS, 'body': json.dumps({'error': str(e)})}

    elif endpoint == 'keywords':
        target  = params.get('target', '')
        country = params.get('country', 'us')
        limit   = params.get('limit', '100')
        try:
            data = ahrefs_get('/site-explorer/organic-keywords', {
                'target':   target,
                'date':     today,
                'select':   'keyword,volume,keyword_difficulty,sum_traffic,best_position',
                'limit':    limit,
                'order_by': 'sum_traffic:desc',
                'country':  country
            })
            return {'statusCode': 200,
                    'headers': {**CORS, 'Content-Type': 'application/json'},
                    'body': json.dumps(data)}
        except Exception as e:
            return {'statusCode': 502, 'headers': CORS, 'body': json.dumps({'error': str(e)})}

    elif endpoint == 'backlinks':
        target = params.get('target', '')
        limit  = params.get('limit', '100')
        try:
            data = ahrefs_get('/site-explorer/all-backlinks', {
                'target':      target,
                'mode':        'subdomains',
                'history':     'live',
                'aggregation': '1_per_domain',
                'select':      'url_from,url_to,anchor,domain_rating_source',
                'limit':       limit,
                'order_by':    'domain_rating_source:desc'
            })
            # Derive a clean source domain from url_from so the UI can show it.
            for bl in data.get('backlinks', []):
                uf = bl.get('url_from') or ''
                try:
                    bl['domain_from'] = urllib.parse.urlparse(uf).netloc or uf
                except Exception:
                    bl['domain_from'] = uf
            return {'statusCode': 200,
                    'headers': {**CORS, 'Content-Type': 'application/json'},
                    'body': json.dumps(data)}
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'ignore')
            return {'statusCode': 502, 'headers': CORS,
                    'body': json.dumps({'error': f'Ahrefs {e.code}: {detail}'})}
        except Exception as e:
            return {'statusCode': 502, 'headers': CORS, 'body': json.dumps({'error': str(e)})}

    elif endpoint == 'top_pages':
        # Which URLs earn the organic traffic (the biggest single "where is my
        # traffic coming from" view). Ordered by estimated monthly traffic.
        target  = params.get('target', '')
        country = params.get('country')
        limit   = params.get('limit', '50')
        p = {
            'target':   target,
            'date':     today,
            'select':   'url,sum_traffic,top_keyword,top_keyword_volume,top_keyword_best_position',
            'limit':    limit,
            'order_by': 'sum_traffic:desc',
            'mode':     'subdomains',
            'protocol': 'both',
        }
        if country:
            p['country'] = country
        try:
            return ok(ahrefs_get('/site-explorer/top-pages', p))
        except Exception as e:
            return upstream_error(e)

    elif endpoint == 'traffic_history':
        # Month-by-month organic traffic (and its $ value) for the trailing year,
        # so the UI can chart the trend behind the headline number.
        target  = params.get('target', '')
        country = params.get('country')
        months  = int(params.get('months', 12) or 12)
        date_from = (date.today() - timedelta(days=months * 31)).isoformat()
        p = {
            'target':           target,
            'date_from':        date_from,
            'date_to':          today,
            'history_grouping': 'monthly',
            'select':           'date,org_traffic,org_cost',
            'mode':             'subdomains',
        }
        if country:
            p['country'] = country
        try:
            return ok(ahrefs_get('/site-explorer/metrics-history', p))
        except Exception as e:
            return upstream_error(e)

    elif endpoint == 'traffic_by_country':
        # Organic traffic split by country of the searcher.
        target = params.get('target', '')
        p = {
            'target': target,
            'date':   today,
            'select': 'country,org_traffic,org_keywords',
            'mode':   'subdomains',
        }
        try:
            return ok(ahrefs_get('/site-explorer/metrics-by-country', p))
        except Exception as e:
            return upstream_error(e)

    else:
        return {'statusCode': 400, 'headers': CORS,
                'body': json.dumps({'error': f'Unknown endpoint: {endpoint}. Use "overview", "keywords", "backlinks", "top_pages", "traffic_history", or "traffic_by_country".'})}
