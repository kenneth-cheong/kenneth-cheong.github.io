import json
import os
import requests

def lambda_handler(event, context):
    apikey = os.environ.get("API_KEY")
    url = event['url']
    if url[-1] == "/":
        url = url[:-1]
    result = {}

    # backlinks summary
    headers = {'Authorization': apikey, 'Content-Type': 'application/json'}
    if "http" not in url:
        payload = [{"target": "https://" + url}]
    else:
        payload = [{"target": url.replace('https://','').replace("http://",'').split('/')[0]}]

    try:
        response = requests.post(
            "https://api.dataforseo.com/v3/backlinks/summary/live",
            headers=headers, json=payload, timeout=60
        )
        r = (response.json().get('tasks') or [None])[0]
        res = ((r or {}).get('result') or [{}])[0] or {}
        result['domain_rank']          = res.get('rank', '')
        result['backlinks']            = res.get('backlinks', '')
        result['backlinks_spam_score'] = res.get('backlinks_spam_score', '')
        result['referring_domains']    = res.get('referring_domains', '')
        result['internal_links_count'] = res.get('internal_links_count', '')
        result['external_links_count'] = res.get('external_links_count', '')
    except Exception as e:
        print(f"Error fetching backlinks: {e}")
        result.update({'domain_rank': '', 'backlinks': '', 'backlinks_spam_score': '',
                       'referring_domains': '', 'internal_links_count': '', 'external_links_count': ''})

    # on-page analysis (browser rendering required for JS-heavy sites)
    if 'http' not in url:
        url = "https://" + url

    try:
        dfs_headers = {'Authorization': 'Basic c3ViQG1lZGlhb25lLmNvOjliZGZkNDBjNzRmMmZjNTM=',
                       'Content-Type': 'application/json'}
        response = requests.post(
            "https://api.dataforseo.com/v3/on_page/instant_pages",
            headers=dfs_headers,
            json=[{"url": url,
                   "enable_javascript": True,
                   "validate_micromarkup": True,
                   "enable_browser_rendering": True,
                   "browser_preset": "desktop"}],
            timeout=120
        )
        tasks = response.json().get('tasks') or [None]
        t = tasks[0] or {}
        items = (t.get('result') or [{}])
        item = ((items[0] or {}).get('items') or [{}])[0] if items else {}
        # Use `or {}` pattern (not default arg) because keys may exist with explicit None values
        meta    = (item or {}).get('meta') or {}
        timing  = (item or {}).get('page_timing') or {}
        checks  = (item or {}).get('checks') or {}
        content = meta.get('content') or {}
        htags   = meta.get('htags') or {}

        result['title']       = meta.get('title', '')
        result['description'] = meta.get('description', '')
        result['h1']          = htags.get('h1', '')
        result['h2']          = htags.get('h2', '')
        result['h3']          = htags.get('h3', '')
        result['image']       = meta.get('images_count', '')
        result['alt_text']    = meta.get('alternative_text', '')
        result['cls']         = round(meta.get('cumulative_layout_shift', 0), 2) if meta.get('cumulative_layout_shift') is not None else '-'
        result['lcp']         = round(timing.get('largest_contentful_paint', 0), 2) if timing.get('largest_contentful_paint') is not None else '-'
        result['fid']         = round(timing.get('first_input_delay', 0), 2) if timing.get('first_input_delay') is not None else '-'
        result['schema']      = checks.get('has_micromarkup', '-')
        result['readability'] = round(content.get('flesch_kincaid_readability_index', 0), 2) if content.get('flesch_kincaid_readability_index') is not None else ''
        result['word_count']  = content.get('plain_text_word_count', '')
    except Exception as e:
        print(f"Error fetching on-page data: {e}")
        result.update({'title': '', 'description': '', 'h1': '', 'h2': '', 'h3': '',
                       'image': '', 'alt_text': '', 'cls': '-', 'lcp': '-', 'fid': '-',
                       'schema': '-', 'readability': '', 'word_count': ''})

    return {
        'statusCode': 200,
        'body': result
    }
