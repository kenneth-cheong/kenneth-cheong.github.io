import json
import requests
import os

def lambda_handler(event, context):
    apikey = os.environ.get("GOOGLE_API_KEY")
    url = event.get('url')
    if not url:
        return {'statusCode': 400, 'body': {'error': 'url is required'}}
    if not url.endswith('/'):
        url += '/'

    data = {}

    # malware
    headers = {"Content-Type": "application/json"}
    body = {
        "client": {
            "clientId": "mediaone",
            "clientVersion": "1"
        },
        "threatInfo": {
            "threatTypes": [
                "MALWARE",
                "THREAT_TYPE_UNSPECIFIED",
                "SOCIAL_ENGINEERING",
                "POTENTIALLY_HARMFUL_APPLICATION",
                "UNWANTED_SOFTWARE"
            ],
            "platformTypes": ["ALL_PLATFORMS"],
            "threatEntryTypes": ["URL"],
            "threatEntries": [{"url": url}]
        }
    }

    try:
        response = requests.post(
            f'https://safebrowsing.googleapis.com/v4/threatMatches:find?key={apikey}',
            headers=headers,
            json=body,
            timeout=30
        )
        safe_json = response.json()
        data['malware'] = "Present" if safe_json.get('matches') else "None Detected"
    except Exception as e:
        print(f"Safe Browsing check failed: {e}")
        data['malware'] = "N/A"

    # robots.txt
    api_url = "https://1pfsx12au9.execute-api.ap-southeast-1.amazonaws.com/url_lib_lite"
    payload = {'url': url + 'robots.txt'}

    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=30)
        page_text = response.json()['body']['visible_text']
        sitemap = "Not found"

        for line in page_text.split('\n'):
            if "Sitemap" in line:
                sitemap = line.replace('Sitemap: ', '').replace('\r', '')

        data['sitemap'] = sitemap
        data['robots'] = page_text.replace('\r', '').replace('\n', '<br>')
    except Exception as e:
        data['robots'] = f"Unable to access robots.txt: {str(e)}"
        data['sitemap'] = "Unable to access robots.txt"

    # pagespeed mobile — NB: do not print api_url (it contains the API key).
    api_url = f'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url={url}&strategy=mobile&key={apikey}'
    try:
        response = requests.get(api_url, headers=headers, timeout=60)
        ps_json = response.json()
        if response.status_code != 200:
            data['pagespeed'] = f"PageSpeed API error: {ps_json.get('error', {}).get('message', 'Unknown error')}"
        elif 'lighthouseResult' not in ps_json:
            data['pagespeed'] = "PageSpeed result missing lighthouseResult"
        else:
            score = ps_json['lighthouseResult']['categories']['performance']['score']
            data['pagespeed'] = f"{int(score * 100)}/100"
    except Exception as e:
        print(f"PageSpeed check failed: {e}")
        data['pagespeed'] = "N/A"

    return {
        'statusCode': 200,
        'body': data
    }
