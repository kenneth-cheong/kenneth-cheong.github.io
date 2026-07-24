import json
import requests
import os

# Google PageSpeed Insights hands back ~47 Lighthouse audits plus real-user
# Chrome UX Report data. This Lambda used to keep exactly one number out of all
# of it -- the performance score -- and drop the rest on the floor, which meant
# the tools on top of it could only ever say "you scored 96" and never "here is
# what real visitors experience, and here is what to fix".
#
# The extra keys below (field / lab / opportunities) are additive. `pagespeed`,
# `robots`, `sitemap` and `malware` keep their exact previous shapes because
# eight index.html call sites and the SaaS forensic audit read them directly.

CRUX_METRICS = {
    'LARGEST_CONTENTFUL_PAINT_MS':     ('lcp',  'Largest Contentful Paint',  'ms'),
    'INTERACTION_TO_NEXT_PAINT':       ('inp',  'Interaction to Next Paint', 'ms'),
    'CUMULATIVE_LAYOUT_SHIFT_SCORE':   ('cls',  'Cumulative Layout Shift',   'score'),
    'FIRST_CONTENTFUL_PAINT_MS':       ('fcp',  'First Contentful Paint',    'ms'),
    'EXPERIMENTAL_TIME_TO_FIRST_BYTE': ('ttfb', 'Time to First Byte',        'ms'),
}

# Google's own wording for the three CrUX buckets, so we don't invent a scale.
RATING = {'FAST': 'good', 'AVERAGE': 'needs work', 'SLOW': 'poor'}

LAB_METRICS = [
    ('largest-contentful-paint', 'lcp'),
    ('cumulative-layout-shift',  'cls'),
    ('total-blocking-time',      'tbt'),
    ('first-contentful-paint',   'fcp'),
    ('speed-index',              'speedIndex'),
    ('interactive',              'tti'),
]


def _field_block(experience):
    """Normalise a CrUX loadingExperience block.

    CrUX reports CLS multiplied by 100 (a percentile of 100 means a CLS of
    1.00). Dividing here means every consumer sees the same number Google
    shows in its own report, instead of each one having to know the quirk.
    """
    if not experience or not experience.get('metrics'):
        return None
    out = {
        'overall': experience.get('overall_category'),
        'overallRating': RATING.get(experience.get('overall_category')),
        # True when the page itself has too little traffic and Google fell back
        # to whole-origin data. Callers must not present that as page-level.
        'originFallback': bool(experience.get('origin_fallback')),
        'metrics': {},
    }
    for raw_key, payload in experience.get('metrics', {}).items():
        mapped = CRUX_METRICS.get(raw_key)
        if not mapped:
            continue
        key, label, unit = mapped
        value = payload.get('percentile')
        if unit == 'score' and isinstance(value, (int, float)):
            value = round(value / 100, 3)
        out['metrics'][key] = {
            'label': label,
            'value': value,
            'unit': unit,
            'category': payload.get('category'),
            'rating': RATING.get(payload.get('category')),
        }
    return out


def lambda_handler(event, context):
    apikey = os.environ.get("GOOGLE_API_KEY")
    url = event.get('url')
    if not url:
        return {'statusCode': 400, 'body': {'error': 'url is required'}}

    # Strategy used to be ignored entirely: the PSI call hardcoded
    # strategy=mobile, so a caller asking for desktop got a second mobile run
    # back and the small run-to-run variance read as a real mobile/desktop gap.
    strategy = str(event.get('strategy') or 'mobile').lower()
    if strategy not in ('mobile', 'desktop'):
        strategy = 'mobile'

    # Callers that only want the speed numbers can skip the malware and
    # robots.txt round-trips. Defaults to everything, so existing callers that
    # send no `checks` are unaffected.
    checks = event.get('checks') or ['malware', 'robots', 'pagespeed']

    # robots.txt lives at the origin root, so that lookup needs the trailing
    # slash. PageSpeed gets the URL as given -- appending a slash to a deep page
    # URL can redirect or 404, which would score a different page than asked for.
    page_url = url
    root_url = url if url.endswith('/') else url + '/'

    data = {}
    headers = {"Content-Type": "application/json"}

    # malware
    if 'malware' in checks:
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
                "threatEntries": [{"url": root_url}]
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
    if 'robots' in checks:
        api_url = "https://1pfsx12au9.execute-api.ap-southeast-1.amazonaws.com/url_lib_lite"
        payload = {'url': root_url + 'robots.txt'}

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

    # pagespeed — NB: do not print api_url (it contains the API key).
    if 'pagespeed' in checks:
        api_url = (
            'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
            f'?url={page_url}&strategy={strategy}&key={apikey}'
        )
        data['strategy'] = strategy
        try:
            response = requests.get(api_url, headers=headers, timeout=60)
            ps_json = response.json()
            if response.status_code != 200:
                data['pagespeed'] = f"PageSpeed API error: {ps_json.get('error', {}).get('message', 'Unknown error')}"
            elif 'lighthouseResult' not in ps_json:
                data['pagespeed'] = "PageSpeed result missing lighthouseResult"
            else:
                lighthouse = ps_json['lighthouseResult']
                score = lighthouse['categories']['performance']['score']
                data['pagespeed'] = f"{int(score * 100)}/100"

                # Real-user data, and the reason a page can score 97 in the lab
                # while actual visitors have a poor experience. Explicitly null
                # when Google has too little traffic to report, so a caller can
                # say "not enough visitors yet" rather than showing a zero.
                data['field'] = _field_block(ps_json.get('loadingExperience'))
                data['fieldOrigin'] = _field_block(ps_json.get('originLoadingExperience'))

                audits = lighthouse.get('audits', {})

                lab = {}
                for audit_id, key in LAB_METRICS:
                    audit = audits.get(audit_id) or {}
                    if audit.get('numericValue') is None:
                        continue
                    lab[key] = {
                        'label': audit.get('title'),
                        'display': audit.get('displayValue'),
                        'value': audit.get('numericValue'),
                        'score': audit.get('score'),
                    }
                data['lab'] = lab

                # Anything Lighthouse costed in saved milliseconds or bytes,
                # worst first -- the actionable half of the report.
                opportunities = []
                for audit in audits.values():
                    details = audit.get('details') or {}
                    saved_ms = details.get('overallSavingsMs') or 0
                    saved_bytes = details.get('overallSavingsBytes') or 0
                    score = audit.get('score')
                    if (saved_ms or saved_bytes) and score is not None and score < 1:
                        opportunities.append({
                            'title': audit.get('title'),
                            'display': audit.get('displayValue'),
                            'description': audit.get('description'),
                            'savingsMs': saved_ms,
                            'savingsBytes': saved_bytes,
                        })
                opportunities.sort(key=lambda o: (o['savingsMs'], o['savingsBytes']), reverse=True)
                data['opportunities'] = opportunities
        except Exception as e:
            print(f"PageSpeed check failed: {e}")
            data['pagespeed'] = "N/A"

    return {
        'statusCode': 200,
        'body': data
    }
