import json
import requests
import time
import os
import re

# DataForSEO Instant Pages endpoint — used by both the default (full HTML) path
# and the lightweight status-check path below.
DATAFORSEO_INSTANT_PAGES_URL = "https://api.dataforseo.com/v3/on_page/instant_pages"


def _dataforseo_headers():
    return {
        'Authorization': ('Basic ' + os.environ.get('DATAFORSEO_AUTH', '')),
        'Content-Type': 'application/json'
    }


def _status_check(target_url):
    """Lightweight, rock-solid URL status check.

    Runs ONLY the Instant Pages crawl (no raw_html round-trip, no resource
    loading, no micromarkup) and returns the REAL upstream HTTP status code that
    DataForSEO observed — including the final status after following redirects
    (e.g. mediaone.co -> mediaonemarketing.com.sg). Used by the SEO Diagnostics
    sitemap validator to flag dead / redirecting URLs listed in an XML sitemap.

    Always returns HTTP 200 with a JSON body; a crawl/parse failure yields
    status_code: null so the caller can treat "unknown" as "not broken" rather
    than raising a false positive.
    """
    payload = [{
        "url": target_url,
        # Keep browser rendering ON (Cloudflare-fronted sites block bare fetches,
        # which would surface as false 403s), but skip everything the status check
        # does not need so it is ~2x cheaper/faster than the full-HTML path.
        "enable_javascript": True,
        "enable_browser_rendering": True,
        "load_resources": False,
        "validate_micromarkup": False,
        "store_raw_html": False,
    }]
    try:
        resp = requests.post(DATAFORSEO_INSTANT_PAGES_URL, headers=_dataforseo_headers(), json=payload, timeout=55)
        resp.raise_for_status()
        item = resp.json()['tasks'][0]['result'][0]['items'][0]
        checks = item.get('checks') or {}
        return {
            'statusCode': 200,
            'body': json.dumps({
                'url': target_url,
                'final_url': item.get('url'),
                'status_code': item.get('status_code'),
                'location': item.get('location'),
                'resource_type': item.get('resource_type'),
                'is_redirect': checks.get('is_redirect'),
                'is_4xx_code': checks.get('is_4xx_code'),
                'is_5xx_code': checks.get('is_5xx_code'),
                'is_broken': checks.get('is_broken'),
            })
        }
    except Exception as e:
        print(f"Status check error for {target_url}: {e}")
        return {
            'statusCode': 200,
            'body': json.dumps({'url': target_url, 'status_code': None, 'error': str(e)})
        }


def lambda_handler(event, context):
    target_url = event['url']

    # Lightweight status-only mode (SEO Diagnostics sitemap validation). Additive:
    # the default full-HTML behaviour below is unchanged when mode != 'status'.
    if event.get('mode') == 'status':
        return _status_check(target_url)

    dataforseo_headers = _dataforseo_headers()

    # --- DataForSEO: Instant Pages API ---
    dataforseo_instant_pages_url = DATAFORSEO_INSTANT_PAGES_URL
    dataforseo_instant_pages_payload = [{"url": target_url,
                                          "enable_javascript": True,
                                          "validate_micromarkup": True,
                                          "enable_browser_rendering": True,
                                          "store_raw_html": True}]

    try:
        dataforseo_instant_pages_response = requests.post(dataforseo_instant_pages_url, headers=dataforseo_headers, json=dataforseo_instant_pages_payload, timeout=55)
        dataforseo_instant_pages_response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        dataforseo_instant_pages_data = dataforseo_instant_pages_response.json()
        task_id = dataforseo_instant_pages_data['tasks'][0]['id']

        print(dataforseo_instant_pages_data)
    except requests.exceptions.RequestException as e:
        print(f"DataForSEO Instant Pages API Error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'DataForSEO Instant Pages API Error: {e}'})
        }
    except (KeyError, IndexError) as e:
        print(f"DataForSEO Instant Pages API Response Parsing Error: {e}, Response: {dataforseo_instant_pages_data}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'DataForSEO Instant Pages API Response Parsing Error: {e}, Response: {dataforseo_instant_pages_data}'})
        }

    # --- DataForSEO: Raw HTML API ---
    dataforseo_raw_html_url = "https://api.dataforseo.com/v3/on_page/raw_html"
    dataforseo_raw_html_payload = [{"url": target_url,
                                     "id": task_id}]

    try:
        dataforseo_raw_html_response = requests.post(dataforseo_raw_html_url, headers=dataforseo_headers, json=dataforseo_raw_html_payload, timeout=55)
        dataforseo_raw_html_response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        dataforseo_raw_html_data = dataforseo_raw_html_response.json()
        page_html = dataforseo_raw_html_data['tasks'][0]['result'][0]['items']['html']
    except requests.exceptions.RequestException as e:
        print(f"DataForSEO Raw HTML API Error: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'DataForSEO Raw HTML API Error: {e}'})
        }
    except (KeyError, IndexError) as e:
        print(f"DataForSEO Raw HTML API Response Parsing Error: {e}, Response: {dataforseo_raw_html_data}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': f'DataForSEO Raw HTML API Response Parsing Error: {e}, Response: {dataforseo_raw_html_data}'})
        }

    return {
        'statusCode': 200,
        'body': page_html
    }
