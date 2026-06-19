"""
socialMediaAudit — async Social Media Audit backend.

Pulls REAL organic-social data from Apify (Instagram, TikTok, Facebook,
LinkedIn, YouTube), computes a deterministic indicator scorecard, snapshots
follower counts to DynamoDB (so follower-growth works on repeat runs), layers
in DataForSEO-style brand-health signals, and asks Haiku for the narrative
(executive summary, strengths/gaps, action plan).

Because Apify actor runs take 30s–several minutes (residential proxies for
IG/TikTok), this CANNOT run inside the 30s HTTP-API timeout. So it exposes an
async START / POLL contract:

  POST {action:"start", ...inputs}  -> {jobId, platforms:[...]}   (returns fast)
  POST {action:"poll",  jobId:"..."} -> {status:"running"|"done"|"error", ...}

Env vars required:
  APIFY_TOKEN        — Apify API token (Settings → Integrations)
  ANTHROPIC_API_KEY  — Claude key (shared with the other lambdas)

DynamoDB tables (region ap-southeast-1):
  sma_jobs       PK: jobId (S)            — in-flight run bookkeeping, TTL ~6h
  sma_snapshots  PK: brand_platform (S), SK: ts (N)  — follower history for growth

See DEPLOY.md in this folder for the create-infra commands.
"""

import json
import os
import re
import time
import uuid
import base64
import statistics
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests
import boto3
from boto3.dynamodb.conditions import Key

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────
APIFY_BASE   = 'https://api.apify.com/v2'
APIFY_TOKEN  = os.environ.get('APIFY_TOKEN', '')
REGION       = os.environ.get('AWS_REGION', 'ap-southeast-1')
JOBS_TABLE   = os.environ.get('SMA_JOBS_TABLE', 'sma_jobs')
SNAP_TABLE   = os.environ.get('SMA_SNAP_TABLE', 'sma_snapshots')
CACHE_TABLE  = os.environ.get('SMA_CACHE_TABLE', 'sma_apify_cache')
HAIKU_MODEL  = 'claude-haiku-4-5-20251001'
# Vision-capable model for the content/creative audit (visual style + theme).
# Sonnet reasons over imagery noticeably better than Haiku; it runs once per
# audit so the extra cost is bounded.
VISION_MODEL = os.environ.get('SMA_VISION_MODEL', 'claude-sonnet-4-6')
MAX_CREATIVE_IMAGES   = 21    # images fetched + sent to the vision model
MAX_CREATIVE_CAPTIONS = 21    # captions sent as text context
JOB_TTL_SECS   = 6 * 3600
CACHE_TTL_SECS = 30 * 86400        # 30-day Apify cache to cut scrape cost
# Bump whenever the metrics shape changes so stale-shape cache entries are
# treated as misses (forces a re-scrape) instead of serving wrong/partial data.
METRICS_SCHEMA = 2                  # v2: TikTok authorMeta fix + captions/image_urls

CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'OPTIONS,POST',
}

# Apify actor IDs per platform (use the "user~actor" slug form). Swap any of
# these for a different actor without touching the rest of the code — only the
# input builders + extractors below assume the documented output shape.
ACTORS = {
    'instagram': 'apify~instagram-profile-scraper',
    'tiktok':    'clockworks~tiktok-profile-scraper',
    'facebook':  'apify~facebook-pages-scraper',
    'youtube':   'streamers~youtube-scraper',
    # LinkedIn org scraping is the fragile one — confirm this actor is the one
    # you've subscribed to on apify.com and adjust the input builder if needed.
    'linkedin':  'apimaestro~linkedin-company-detail',
}

# Apify run statuses that mean "stop polling".
TERMINAL = {'SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'}


# ──────────────────────────────────────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────────────────────────────────────
def lambda_handler(event, context):
    if (event or {}).get('httpMethod') == 'OPTIONS':
        return _resp(200, {'ok': True})

    body = _parse_body(event)
    action = (body.get('action') or 'start').lower()

    try:
        if action == 'start':
            return _resp(200, handle_start(body))
        if action == 'poll':
            return _resp(200, handle_poll(body))
        if action == 'finalize':
            return _resp(200, handle_finalize(body))
        if action == 'discover':
            return _resp(200, handle_discover(body))
        if action == 'discover_competitors':
            return _resp(200, handle_discover_competitors(body))
        if action == 'suggest_context':
            return _resp(200, handle_suggest_context(body))
        return _resp(400, {'error': f'Unknown action: {action}'})
    except Exception as e:
        return _resp(500, {'error': str(e)})


# ──────────────────────────────────────────────────────────────────────────────
# START — kick off one Apify actor run per selected platform
# ──────────────────────────────────────────────────────────────────────────────
def handle_start(body):
    if not APIFY_TOKEN:
        raise RuntimeError('APIFY_TOKEN env var is not set on the lambda.')

    handles    = body.get('handles') or {}          # {instagram:"@x", tiktok:"...", ...}
    platforms  = body.get('platforms') or list(handles.keys())
    competitors = body.get('competitors') or []     # list of {platform, handle}
    brand      = (body.get('brand_name') or body.get('domain') or 'brand').strip()

    cached_n = 0
    runs = {}
    for p in platforms:
        handle = (handles.get(p) or '').strip()
        if not handle:
            continue
        actor = ACTORS.get(p)
        if not actor:
            continue
        if _cache_get(p, handle) is not None:          # fresh (<30d) → skip the scrape
            runs[p] = {'handle': handle, 'cached': True, 'role': 'client'}
            cached_n += 1
            continue
        run = _apify_start(actor, _build_input(p, handle))
        if run:
            runs[p] = {'handle': handle, 'run_id': run['id'],
                       'dataset_id': run.get('defaultDatasetId'), 'role': 'client'}

    # Competitors run the same actors (capped to keep cost predictable).
    comp_runs = []
    for c in competitors[:3]:
        p = (c.get('platform') or '').strip()
        handle = (c.get('handle') or '').strip()
        actor = ACTORS.get(p)
        if not (p and handle and actor):
            continue
        name = c.get('name') or handle
        if _cache_get(p, handle) is not None:
            comp_runs.append({'platform': p, 'handle': handle, 'name': name, 'cached': True})
            cached_n += 1
            continue
        run = _apify_start(actor, _build_input(p, handle))
        if run:
            comp_runs.append({'platform': p, 'handle': handle, 'name': name,
                              'run_id': run['id'], 'dataset_id': run.get('defaultDatasetId')})

    if not runs and not comp_runs:
        raise RuntimeError('No valid platform handles were provided.')

    job_id = uuid.uuid4().hex
    _jobs().put_item(Item={
        'jobId': job_id,
        'brand': brand,
        'domain': body.get('domain') or '',
        'location': body.get('location') or 'Singapore',
        'extra_context': (body.get('extra_context') or '')[:40000],
        'runs': _ddb_clean(runs),
        'comp_runs': _ddb_clean(comp_runs),
        'created': _now_iso(),
        'ttl': int(time.time()) + JOB_TTL_SECS,
    })

    return {'jobId': job_id, 'platforms': list(runs.keys()),
            'competitors': len(comp_runs), 'cached': cached_n}


# ──────────────────────────────────────────────────────────────────────────────
# DISCOVER — find a brand's social handles so the user can just give a URL/name.
# Synchronous + fast: scrape the homepage's social links first (free, reliable),
# then for any platform still missing, a concurrent DataForSEO SERP lookup by
# brand name. Returns CANDIDATES for the user to confirm — never auto-audits.
# ──────────────────────────────────────────────────────────────────────────────
SOCIAL_RE = {
    'instagram': r'(?:www\.)?instagram\.com/(?!p/|reel/|reels/|explore/|stories/|accounts/)([A-Za-z0-9_.]{2,30})',
    'tiktok':    r'(?:www\.)?tiktok\.com/@([A-Za-z0-9_.]{2,30})',
    'facebook':  r'(?:www\.)?facebook\.com/(?!sharer|plugins|tr\?|dialog|profile\.php)([A-Za-z0-9_.\-]{2,40})',
    'linkedin':  r'(?:www\.)?linkedin\.com/(company/[A-Za-z0-9_\-%.]{2,60}|in/[A-Za-z0-9_\-%.]{2,60})',
    'youtube':   r'(?:www\.)?youtube\.com/(@[A-Za-z0-9_.\-]{2,40}|channel/[A-Za-z0-9_\-]{6,40}|c/[A-Za-z0-9_\-]{2,40}|user/[A-Za-z0-9_\-]{2,40})',
}

def handle_discover(body):
    brand     = (body.get('brand_name') or '').strip()
    domain    = (body.get('domain') or '').strip()
    platforms = body.get('platforms') or list(ACTORS.keys())
    location  = body.get('location') or 'Singapore'

    found = {}
    if domain:
        for p, hit in _scrape_social_links(domain).items():
            if p in platforms:
                found[p] = {**hit, 'source': 'website'}

    missing = [p for p in platforms if p not in found]
    if missing and brand and os.environ.get('DATAFORSEO_AUTH'):
        with ThreadPoolExecutor(max_workers=5) as ex:
            for p, hit in zip(missing, ex.map(lambda p: _serp_find_profile(brand, p, location), missing)):
                if hit:
                    found[p] = {**hit, 'source': 'search'}

    return {'handles': found,
            'note': 'Candidate profiles — confirm they are correct before auditing.'}


# ──────────────────────────────────────────────────────────────────────────────
# DISCOVER_COMPETITORS — use AI to name direct competitors, look up each brand's
# domain via SERP, then scrape social handles. Falls back to SERP domain scan
# if AI is unavailable. Returns up to 3 candidates for user review.
# ──────────────────────────────────────────────────────────────────────────────
def _ai_suggest_competitor_brands(brand, domain, industry, audience, site_text, location):
    """Ask Claude to name the most direct competitor brands. Returns a list of brand name strings."""
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return []
    prompt = (
        "You are a senior market analyst. Identify the 5 most direct competitor brands "
        "for the company below — real brands that compete for the same customers in the same space. "
        "Return ONLY a JSON array of brand name strings, e.g. [\"BrandA\",\"BrandB\",...]. "
        "No explanation, no URLs, no extra text.\n\n"
        f"BRAND: {brand or '(unknown)'}\n"
        f"DOMAIN: {domain or '(none)'}\n"
        f"INDUSTRY: {industry or '(infer from brand/site)'}\n"
        f"TARGET AUDIENCE: {audience or '(infer)'}\n"
        f"PRIMARY MARKET: {location}\n"
        + (f"\nHOMEPAGE TEXT (excerpt):\n{site_text[:3000]}" if site_text else "")
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': HAIKU_MODEL, 'max_tokens': 300,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=30)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        brands = json.loads(txt)
        if isinstance(brands, list):
            return [str(b).strip() for b in brands if str(b).strip()][:5]
    except Exception:
        pass
    return []


def handle_discover_competitors(body):
    brand     = (body.get('brand_name') or '').strip()
    domain    = (body.get('domain') or '').strip()
    industry  = (body.get('industry') or '').strip()
    audience  = (body.get('target_audience') or '').strip()
    location  = body.get('location') or 'Singapore'
    platforms = body.get('platforms') or list(ACTORS.keys())

    if not brand and not domain:
        return {'competitors': [], 'note': 'Provide brand_name or domain.'}

    site_text = _fetch_page_text(domain) if domain else ''

    # AI-first: get named competitor brands, then find their domains + handles
    ai_brands = _ai_suggest_competitor_brands(brand, domain, industry, audience, site_text, location)

    if ai_brands:
        def _process_brand(comp_brand):
            comp_domain = _find_brand_domain(comp_brand)
            if not comp_domain:
                return None
            handles = _scrape_social_links(comp_domain)
            filtered = {p: h for p, h in handles.items() if p in platforms}
            if not filtered:
                return None
            return {'name': comp_brand, 'website': comp_domain, 'handles': filtered}

        results = []
        with ThreadPoolExecutor(max_workers=5) as ex:
            for r in ex.map(_process_brand, ai_brands):
                if r:
                    results.append(r)
                    if len(results) >= 3:
                        break
        if results:
            return {'competitors': results,
                    'note': 'Candidate competitors — confirm each is correct before auditing.'}

    # Fallback: SERP domain scan (original approach)
    comp_domains = _serp_find_competitor_domains(brand or domain, domain, location)
    if not comp_domains:
        return {'competitors': [], 'note': 'No competitor domains found via SERP.'}

    def _process_domain(comp_domain):
        raw_name = comp_domain.replace('www.', '').split('.')[0].replace('-', ' ').title()
        handles = _scrape_social_links(comp_domain)
        filtered = {p: h for p, h in handles.items() if p in platforms}
        if not filtered:
            return None
        return {'name': raw_name, 'website': comp_domain, 'handles': filtered}

    results = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        for r in ex.map(_process_domain, comp_domains):
            if r:
                results.append(r)
                if len(results) >= 3:
                    break

    return {'competitors': results,
            'note': 'Candidate competitors — confirm each is correct before auditing.'}


# ──────────────────────────────────────────────────────────────────────────────
# SUGGEST_CONTEXT — infer the campaign context (industry / audience / goals) from
# just a brand name (+ optional website) so the user only has to type one field.
# Grounds the guess in the homepage text when a URL is given. Returns CANDIDATES
# for the user to review/edit — never auto-runs.
# ──────────────────────────────────────────────────────────────────────────────
def _find_brand_domain(brand):
    """Use DataForSEO SERP to find the brand's own website URL."""
    auth = os.environ.get('DATAFORSEO_AUTH')
    if not auth or not brand:
        return ''
    skip = {'wikipedia.org', 'linkedin.com', 'facebook.com', 'instagram.com',
            'twitter.com', 'youtube.com', 'tiktok.com', 'crunchbase.com',
            'bloomberg.com', 'forbes.com', 'glassdoor.com', 'trustpilot.com'}
    try:
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers={'Authorization': auth, 'Content-Type': 'application/json'},
                          timeout=22,
                          json=[{'keyword': brand, 'location_name': 'Singapore',
                                 'language_name': 'English', 'depth': 10}])
        items = (((r.json().get('tasks') or [{}])[0].get('result') or [{}])[0].get('items')) or []
        for it in items:
            url = it.get('url') or ''
            host = url.replace('https://', '').replace('http://', '').replace('www.', '').split('/')[0].lower()
            root = '.'.join(host.rsplit('.', 2)[-2:]) if host else ''
            if root and root not in skip:
                return 'https://' + host
    except Exception:
        pass
    return ''


def handle_suggest_context(body):
    brand  = (body.get('brand_name') or '').strip()
    domain = (body.get('domain') or '').strip()
    if not brand and not domain:
        return {'error': 'Provide brand_name or domain.'}

    # If no domain provided, try to discover it via SERP
    discovered_domain = ''
    if not domain and brand:
        discovered_domain = _find_brand_domain(brand)
        domain = discovered_domain

    site_text = _fetch_page_text(domain) if domain else ''
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    fallback = {'industry': '', 'target_audience': '', 'campaign_goals': '',
                'website': discovered_domain,
                'note': 'Could not auto-suggest — please fill these in.'}
    if not api_key:
        return fallback

    prompt = (
        "You are a senior social media strategist. From the brand below, infer the "
        "most likely campaign context for a social media audit. Respond with STRICT "
        "JSON only, no prose, matching:\n"
        '{"industry":"short phrase, e.g. B2B SaaS or Dental clinic",'
        '"target_audience":"1-2 sentences: who the customers are — segment, '
        'location, B2B/B2C, intent",'
        '"campaign_goals":"comma-separated goals, e.g. Build awareness, generate leads"}\n'
        "Be specific and realistic for THIS brand. If a website excerpt is given, "
        "base it on that.\n\n"
        f"BRAND NAME: {brand or '(unknown)'}\n"
        f"WEBSITE: {domain or '(none)'}\n"
        + (f"\nHOMEPAGE TEXT (excerpt):\n{site_text[:6000]}" if site_text else "")
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': HAIKU_MODEL, 'max_tokens': 600,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=40)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        return {
            'industry': (out.get('industry') or '').strip(),
            'target_audience': (out.get('target_audience') or '').strip(),
            'campaign_goals': (out.get('campaign_goals') or '').strip(),
            'website': discovered_domain,
            'note': 'AI-suggested from the brand — review and edit before auditing.',
        }
    except Exception as e:
        return {**fallback, 'note': f'Auto-suggest failed: {e}'}


def _fetch_page_text(domain):
    """Fetch a homepage and return its visible text (tags/scripts stripped)."""
    url = domain if domain.startswith('http') else 'https://' + domain
    try:
        r = requests.get(url, timeout=12, allow_redirects=True,
                         headers={'User-Agent': 'Mozilla/5.0 (compatible; DigimetricsAudit/1.0)'})
        html = r.text[:600000]
    except requests.exceptions.RequestException:
        return ''
    html = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', html)
    text = re.sub(r'(?s)<[^>]+>', ' ', html)
    text = re.sub(r'&[a-z]+;', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


# Domains we skip when scanning SERP results for competitor candidates.
_SKIP_ROOTS = {
    'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
    'twitter.com', 'x.com', 'reddit.com', 'quora.com', 'wikipedia.org',
    'trustpilot.com', 'glassdoor.com', 'yelp.com', 'clutch.co',
    'g2.com', 'capterra.com', 'bloomberg.com', 'forbes.com', 'techcrunch.com',
    'goodfirms.co', 'crunchbase.com', 'semrush.com', 'similarweb.com',
}

def _serp_find_competitor_domains(brand_or_domain, own_domain, location='Singapore'):
    """Query DataForSEO SERP for '{brand} competitors', return up to 5 competitor domains."""
    auth = os.environ.get('DATAFORSEO_AUTH')
    if not auth:
        return []
    own = (own_domain or '').replace('https://', '').replace('http://', '').replace('www.', '').split('/')[0].lower()
    try:
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers={'Authorization': auth, 'Content-Type': 'application/json'},
                          timeout=22,
                          json=[{'keyword': f'{brand_or_domain} competitors',
                                 'location_name': location, 'language_name': 'English', 'depth': 20}])
        items = (((r.json().get('tasks') or [{}])[0].get('result') or [{}])[0].get('items')) or []
        seen, domains = set(), []
        for it in items:
            url = it.get('url') or ''
            host = url.replace('https://', '').replace('http://', '').replace('www.', '').split('/')[0].lower()
            if not host:
                continue
            parts = host.rsplit('.', 2)
            root = '.'.join(parts[-2:]) if len(parts) >= 2 else host
            if root in seen or root in _SKIP_ROOTS or (own and root == own):
                continue
            seen.add(root)
            domains.append(host)
            if len(domains) >= 5:
                break
        return domains
    except Exception:
        return []


def _scrape_social_links(domain):
    url = domain if domain.startswith('http') else 'https://' + domain
    try:
        r = requests.get(url, timeout=12, allow_redirects=True,
                         headers={'User-Agent': 'Mozilla/5.0 (compatible; DigimetricsAudit/1.0)'})
        html = r.text[:600000]
    except requests.exceptions.RequestException:
        return {}
    out = {}
    for p, pat in SOCIAL_RE.items():
        m = re.search(pat, html, re.IGNORECASE)
        if m:
            handle, profile_url = _normalize_profile(p, m.group(1))
            if handle:
                out[p] = {'handle': handle, 'profile_url': profile_url}
    return out


def _serp_find_profile(brand, platform, location='Singapore'):
    auth = os.environ.get('DATAFORSEO_AUTH')
    domain_kw = {'instagram': 'instagram.com', 'tiktok': 'tiktok.com',
                 'facebook': 'facebook.com', 'linkedin': 'linkedin.com',
                 'youtube': 'youtube.com'}[platform]
    try:
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers={'Authorization': auth, 'Content-Type': 'application/json'},
                          timeout=22,
                          json=[{'keyword': f'{brand} {platform}', 'location_name': location,
                                 'language_name': 'English', 'depth': 10}])
        items = (((r.json().get('tasks') or [{}])[0].get('result') or [{}])[0].get('items')) or []
        for it in items:
            u = it.get('url') or ''
            if domain_kw in u:
                m = re.search(SOCIAL_RE[platform], u, re.IGNORECASE)
                if m:
                    handle, profile_url = _normalize_profile(platform, m.group(1))
                    if handle:
                        return {'handle': handle, 'profile_url': profile_url}
    except Exception:
        pass
    return None


def _normalize_profile(platform, captured):
    """Return (handle_for_audit, display_url). handle_for_audit is what the actor
    input builder expects; for YouTube channel/c/user paths we keep a full URL."""
    captured = captured.strip().strip('/').rstrip('.')
    if platform in ('instagram', 'tiktok', 'facebook'):
        h = captured.lstrip('@')
        url = {'instagram': f'https://www.instagram.com/{h}',
               'tiktok':    f'https://www.tiktok.com/@{h}',
               'facebook':  f'https://www.facebook.com/{h}'}[platform]
        return h, url
    if platform == 'linkedin':                       # captured = "company/slug" or "in/slug"
        slug = captured.split('/', 1)[1] if '/' in captured else captured
        return slug, f'https://www.linkedin.com/{captured}'
    if platform == 'youtube':                        # captured = "@x" | "channel/.." | "c/.." | "user/.."
        if captured.startswith('@'):
            return captured.lstrip('@'), f'https://www.youtube.com/{captured}'
        return f'https://www.youtube.com/{captured}', f'https://www.youtube.com/{captured}'
    return captured, ''


# ──────────────────────────────────────────────────────────────────────────────
# POLL — lightweight. Checks Apify run statuses; when all terminal, kicks off the
# heavy finalize ONCE via async self-invoke (which has the full 180s budget, free
# of the ~29s API-GW limit) and reports 'finalizing' until the scorecard is cached.
# ──────────────────────────────────────────────────────────────────────────────
def handle_poll(body):
    job_id = body.get('jobId')
    if not job_id:
        raise RuntimeError('Missing jobId.')
    item = _jobs().get_item(Key={'jobId': job_id}).get('Item')
    if not item:
        raise RuntimeError('Unknown or expired jobId.')

    # Already finalized → return cached scorecard.
    if item.get('scorecard'):
        return {'status': 'done', 'scorecard': json.loads(item['scorecard'])}
    if item.get('finalize_error'):
        raise RuntimeError(item['finalize_error'])

    runs      = item.get('runs') or {}
    comp_runs = item.get('comp_runs') or []
    # Only live (non-cached) runs have a run_id and need polling.
    live_ids = [r['run_id'] for r in runs.values() if r.get('run_id')] + \
               [c['run_id'] for c in comp_runs if c.get('run_id')]
    statuses = {rid: _apify_status(rid) for rid in live_ids}
    done = sum(1 for s in statuses.values() if s in TERMINAL)
    total = len(live_ids)

    if total and done < total:
        return {'status': 'running', 'progress': {'done': done, 'total': total}}

    # All runs terminal → start the async finalize exactly once.
    if not item.get('finalize_started'):
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET finalize_started = :t',
                            ExpressionAttributeValues={':t': int(time.time())})
        _self_invoke({'action': 'finalize', 'jobId': job_id})
    return {'status': 'finalizing', 'progress': {'done': done, 'total': total}}


# ──────────────────────────────────────────────────────────────────────────────
# FINALIZE — heavy step (Apify datasets + DataForSEO + Haiku). Async-invoked; the
# computed scorecard is cached on the job so subsequent polls return it instantly.
# ──────────────────────────────────────────────────────────────────────────────
def handle_finalize(body):
    job_id = body.get('jobId')
    item = _jobs().get_item(Key={'jobId': job_id}).get('Item')
    if not item or item.get('scorecard'):
        return {'ok': True}
    try:
        runs      = item.get('runs') or {}
        comp_runs = item.get('comp_runs') or []
        brand     = item.get('brand') or 'brand'
        live_ids = [r['run_id'] for r in runs.values() if r.get('run_id')] + \
                   [c['run_id'] for c in comp_runs if c.get('run_id')]
        statuses = {rid: _apify_status(rid) for rid in live_ids}

        def _metrics_for(platform, r):
            """Cache hit → reuse stored metrics; else fetch the dataset, extract,
            and write to the 30-day cache so the next audit skips the scrape."""
            if r.get('cached'):
                return _cache_get(platform, r.get('handle')) or _empty_metrics(), 'cache'
            ok = statuses.get(r.get('run_id')) == 'SUCCEEDED'
            items = _apify_items(r.get('dataset_id')) if ok else []
            m = _extract(platform, items)
            if items:
                _cache_put(platform, r.get('handle'), m)
            return m, ('apify' if items else 'empty')

        client_metrics = {}
        for p, r in runs.items():
            m, src = _metrics_for(p, r)
            m['handle'] = r.get('handle')
            m['found']  = src != 'empty'
            m = _add_growth(brand, p, m)
            client_metrics[p] = m

        competitor_metrics = []
        for c in comp_runs:
            m, src = _metrics_for(c['platform'], c)
            competitor_metrics.append({
                'name': c.get('name'), 'platform': c['platform'], 'found': src != 'empty',
                'followers': m.get('followers'), 'engagement_rate': m.get('engagement_rate'),
                'posts_per_week': m.get('posts_per_week'),
                'days_since_last_post': m.get('days_since_last_post'),
                'avg_likes': m.get('avg_likes'), 'avg_comments': m.get('avg_comments'),
                'avg_video_views': m.get('avg_video_views'),
                'content_mix': m.get('content_mix'), 'top_hashtags': m.get('top_hashtags'),
                'top_posts': m.get('top_posts'),
            })

        brand_health = fetch_brand_health(item.get('domain'), brand, item.get('location') or 'Singapore')
        indicators   = _flatten_indicators(client_metrics, brand_health)
        creative     = _analyze_creative(brand, client_metrics, item.get('extra_context') or '')
        scorecard    = _narrate(brand, client_metrics, competitor_metrics, brand_health,
                                indicators, item.get('extra_context') or '', creative=creative)
        scorecard.update({
            'platforms': [_platform_card(p, m) for p, m in client_metrics.items()],
            'indicators': indicators,
            'brand_health': brand_health,
            'creative': creative,
            'competitors': [c for c in competitor_metrics if c.get('followers') is not None],
        })
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET scorecard = :s',
                            ExpressionAttributeValues={':s': json.dumps(scorecard, default=str)})
    except Exception as e:
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET finalize_error = :e',
                            ExpressionAttributeValues={':e': str(e)[:300]})
    return {'ok': True}


def _self_invoke(payload):
    try:
        boto3.client('lambda', region_name=REGION).invoke(
            FunctionName=os.environ.get('AWS_LAMBDA_FUNCTION_NAME', 'socialMediaAudit'),
            InvocationType='Event',
            Payload=json.dumps(payload).encode())
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────────────
# Apify helpers
# ──────────────────────────────────────────────────────────────────────────────
def _apify_start(actor, run_input):
    """Start an actor run (async). Returns {id, defaultDatasetId, status} or None."""
    try:
        r = requests.post(f'{APIFY_BASE}/acts/{actor}/runs',
                          params={'token': APIFY_TOKEN},
                          json=run_input, timeout=25)
        if r.status_code >= 300:
            return None
        return (r.json() or {}).get('data')
    except requests.exceptions.RequestException:
        return None


def _apify_status(run_id):
    try:
        r = requests.get(f'{APIFY_BASE}/actor-runs/{run_id}',
                         params={'token': APIFY_TOKEN}, timeout=20)
        return ((r.json() or {}).get('data') or {}).get('status', 'RUNNING')
    except requests.exceptions.RequestException:
        return 'RUNNING'


def _apify_items(dataset_id):
    if not dataset_id:
        return []
    try:
        r = requests.get(f'{APIFY_BASE}/datasets/{dataset_id}/items',
                         params={'token': APIFY_TOKEN, 'clean': 'true'}, timeout=30)
        data = r.json()
        return data if isinstance(data, list) else []
    except (requests.exceptions.RequestException, ValueError):
        return []


def _build_input(platform, handle):
    """Per-platform actor input. Handles are normalised to a bare username/URL."""
    user = handle.lstrip('@').strip()
    if platform == 'instagram':
        return {'usernames': [user], 'resultsLimit': 24}
    if platform == 'tiktok':
        return {'profiles': [user], 'resultsPerPage': 24, 'shouldDownloadVideos': False}
    if platform == 'facebook':
        url = user if user.startswith('http') else f'https://www.facebook.com/{user}'
        return {'startUrls': [{'url': url}], 'resultsLimit': 24}
    if platform == 'youtube':
        url = user if user.startswith('http') else f'https://www.youtube.com/@{user}'
        return {'startUrls': [{'url': url}], 'maxResults': 24}
    if platform == 'linkedin':
        url = user if user.startswith('http') else f'https://www.linkedin.com/company/{user}'
        return {'identifier': user, 'url': url}
    return {'usernames': [user]}


# ──────────────────────────────────────────────────────────────────────────────
# Extraction & indicator math — defensive against varying actor field names
# ──────────────────────────────────────────────────────────────────────────────
def _g(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ''):
            return d.get(k)
    return default


def _extract(platform, items):
    """Normalise actor output to a common metrics dict.

    Some actors (notably the clockworks TikTok scraper) return ONE item per
    post/video with the profile nested under `authorMeta`, rather than a
    profile object as items[0]. Prefer authorMeta for the profile fields when
    present so followers/verified/bio/avatar resolve correctly."""
    if not items:
        return _empty_metrics()
    head = items[0] if isinstance(items[0], dict) else {}
    prof = head.get('authorMeta') if isinstance(head.get('authorMeta'), dict) else head

    followers = _num(_g(prof, 'followersCount', 'followers', 'fans', 'fanCount',
                        'subscriberCount', 'followerCount', 'edge_followed_by'))
    following = _num(_g(prof, 'followsCount', 'following', 'followingCount'))
    verified  = bool(_g(prof, 'verified', 'isVerified', 'is_verified', default=False))
    bio       = _g(prof, 'biography', 'bio', 'description', 'about', 'signature', default='')
    link      = _g(prof, 'externalUrl', 'website', 'link', 'externalUrls', 'bioLink', default='')
    category  = _g(prof, 'businessCategoryName', 'category', 'categoryName', default='')
    pfp       = _g(prof, 'profilePicUrl', 'avatar', 'profileImage', 'thumbnailUrl',
                   'originalAvatarUrl', default='')

    posts = _collect_posts(platform, items, head)
    return _metrics_from(followers, following, verified, bio, link, category, pfp, posts)


_PROFILE_HEAD_KEYS = ('followersCount', 'followers', 'subscriberCount', 'fans',
                      'edge_followed_by', 'followerCount')


def _collect_posts(platform, items, head):
    """Return a list of normalised posts: {ts, likes, comments, views, type, hashtags}.

    Three actor shapes: (a) head carries a nested post list (Instagram), (b) head
    is itself a post and items[1:] are more posts (TikTok — items[0] is a video
    with authorMeta), (c) head is a profile and items[1:] are posts."""
    nested = _g(head, 'latestPosts', 'posts', 'videos', 'topPosts', default=None)
    if nested:
        raw = nested
    else:
        head_is_profile = ('authorMeta' not in head
                           and any(k in head for k in _PROFILE_HEAD_KEYS))
        src = items[1:] if head_is_profile else items
        raw = [it for it in src if isinstance(it, dict)]
    out = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        text = _g(p, 'caption', 'text', 'title', 'description', default='') or ''
        out.append({
            'ts':       _g(p, 'timestamp', 'createTime', 'publishedAt', 'date', 'taken_at'),
            'likes':    _num(_g(p, 'likesCount', 'likes', 'diggCount', 'reactionsCount', 'likeCount')),
            'comments': _num(_g(p, 'commentsCount', 'comments', 'commentCount')),
            'views':    _num(_g(p, 'videoViewCount', 'playCount', 'views', 'viewCount')),
            'type':     _post_type(p),
            'hashtags': re.findall(r'#(\w+)', text),
            'text':     ' '.join(text.split())[:160],
            'caption':  ' '.join(text.split())[:400],   # longer text for theme/tone analysis
            'image':    _post_image(p),
            'url':      _g(p, 'url', 'webVideoUrl', 'postUrl', 'link', 'videoUrl', default=''),
        })
    return out


def _post_image(p):
    """Best-effort post thumbnail / display image URL across actor shapes."""
    img = _g(p, 'displayUrl', 'imageUrl', 'thumbnailUrl', 'thumbnailSrc', 'thumbnail',
             'cover', 'coverUrl', 'image', 'previewImageUrl', 'displayImageUrl', default='')
    if not img:
        for nest in ('videoMeta', 'video', 'media'):
            sub = p.get(nest)
            if isinstance(sub, dict):
                img = _g(sub, 'coverUrl', 'originalCoverUrl', 'cover', 'thumbnail', default='')
                if img:
                    break
    if not img:
        for key in ('images', 'covers', 'thumbnails'):
            seq = p.get(key)
            if isinstance(seq, list) and seq:
                first = seq[0]
                img = first if isinstance(first, str) else _g(first, 'url', 'src', default='')
                if img:
                    break
    return img if isinstance(img, str) else ''


def _post_type(p):
    t = str(_g(p, 'type', 'productType', 'mediaType', default='')).lower()
    if 'video' in t or 'reel' in t or 'clip' in t:
        return 'video'
    if 'carousel' in t or 'sidecar' in t or 'album' in t:
        return 'carousel'
    if _g(p, 'videoViewCount', 'playCount', 'videoUrl'):
        return 'video'
    return 'image'


def _metrics_from(followers, following, verified, bio, link, category, pfp, posts):
    likes    = [p['likes'] for p in posts if p['likes'] is not None]
    comments = [p['comments'] for p in posts if p['comments'] is not None]
    views    = [p['views'] for p in posts if p['views'] is not None]
    avg_likes    = round(statistics.mean(likes), 1) if likes else None
    avg_comments = round(statistics.mean(comments), 1) if comments else None
    eng = None
    if followers and (avg_likes is not None or avg_comments is not None):
        eng = round(((avg_likes or 0) + (avg_comments or 0)) / followers * 100, 2)

    # cadence
    ts = sorted([_to_epoch(p['ts']) for p in posts if _to_epoch(p['ts'])], reverse=True)
    posts_per_week = days_since_last = None
    if len(ts) >= 2:
        span_weeks = max((ts[0] - ts[-1]) / 604800.0, 1e-6)
        posts_per_week = round(len(ts) / span_weeks, 1)
    if ts:
        days_since_last = int((time.time() - ts[0]) / 86400)

    mix = {'video': 0, 'image': 0, 'carousel': 0}
    for p in posts:
        mix[p['type']] = mix.get(p['type'], 0) + 1

    eng_vals = [(l or 0) + (c or 0) for l, c in zip(likes or [], comments or [])]
    top_vs_median = None
    if len(eng_vals) >= 3:
        med = statistics.median(eng_vals) or 1
        top_vs_median = round(max(eng_vals) / med, 1)

    top_posts = [
        {'text': p.get('text', ''), 'type': p['type'], 'likes': p['likes'],
         'comments': p['comments'], 'views': p['views'], 'url': p.get('url', '')}
        for p in sorted(posts, key=lambda p: (p['likes'] or 0) + (p['comments'] or 0), reverse=True)[:3]
    ]

    hashtags = [h for p in posts for h in p['hashtags']]
    completeness = {
        'bio': bool(bio), 'link': bool(link), 'verified': verified,
        'pfp': bool(pfp), 'category': bool(category),
    }
    comp_score = round(sum(completeness.values()) / 5 * 100)

    return {
        'followers': followers, 'following': following,
        'follower_ratio': round(followers / following, 1) if (followers and following) else None,
        'verified': verified, 'bio': bio[:280] if bio else '',
        'avg_likes': avg_likes, 'avg_comments': avg_comments,
        'engagement_rate': eng, 'avg_video_views': round(statistics.mean(views), 0) if views else None,
        'posts_per_week': posts_per_week, 'days_since_last_post': days_since_last,
        'content_mix': mix, 'top_vs_median': top_vs_median,
        'hashtag_count': len(set(hashtags)), 'top_hashtags': _top(hashtags, 8),
        'profile_completeness': {'score': comp_score, **completeness},
        'post_sample': len(posts), 'top_posts': top_posts,
        # raw content for the creative/style audit (not surfaced in platform cards)
        'captions':   [p['caption'] for p in posts if p.get('caption')][:MAX_CREATIVE_CAPTIONS],
        'image_urls': [p['image'] for p in posts if p.get('image')][:21],
        '_schema': METRICS_SCHEMA,
    }


def _empty_metrics():
    return {'followers': None, 'following': None, 'follower_ratio': None,
            'verified': False, 'bio': '', 'avg_likes': None, 'avg_comments': None,
            'engagement_rate': None, 'avg_video_views': None, 'posts_per_week': None,
            'days_since_last_post': None, 'content_mix': {'video': 0, 'image': 0, 'carousel': 0},
            'top_vs_median': None, 'hashtag_count': 0, 'top_hashtags': [],
            'profile_completeness': {'score': 0, 'bio': False, 'link': False,
                                     'verified': False, 'pfp': False, 'category': False},
            'post_sample': 0, 'top_posts': [], 'captions': [], 'image_urls': [],
            '_schema': METRICS_SCHEMA}


# ──────────────────────────────────────────────────────────────────────────────
# Follower-growth snapshots (DynamoDB)
# ──────────────────────────────────────────────────────────────────────────────
def _add_growth(brand, platform, m):
    followers = m.get('followers')
    key = f'{brand.lower()}#{platform}'
    try:
        tbl = _snaps()
        # read most recent prior snapshot (within ~90d)
        resp = tbl.query(KeyConditionExpression=Key('brand_platform').eq(key),
                         ScanIndexForward=False, Limit=10)
        prev = None
        for it in resp.get('Items', []):
            if it.get('followers') is not None:
                prev = it
                break
        if prev and followers:
            delta = followers - int(prev['followers'])
            age_days = max((time.time() - float(prev['ts'])) / 86400.0, 1)
            m['followers_growth_30d'] = round(delta / age_days * 30)
        else:
            m['followers_growth_30d'] = None
        if followers:
            tbl.put_item(Item={'brand_platform': key, 'ts': int(time.time()),
                               'followers': followers})
    except Exception:
        m['followers_growth_30d'] = None
    return m


# ──────────────────────────────────────────────────────────────────────────────
# Brand-health layer — DataForSEO. Auth header value (e.g. "Basic <b64>") lives in
# env DATAFORSEO_AUTH. Every call is best-effort: any failure leaves the field None
# so the scorecard still renders. Location defaults to Singapore (agency's market).
# ──────────────────────────────────────────────────────────────────────────────
DFS_BASE = 'https://api.dataforseo.com/v3'

def fetch_brand_health(domain, brand, location='Singapore', language='English'):
    out = {'branded_search_volume': None, 'web_mentions': None,
           'gbp_rating': None, 'gbp_reviews': None}
    auth = os.environ.get('DATAFORSEO_AUTH')
    if not auth or not brand:
        out['note'] = 'Set DATAFORSEO_AUTH env var to populate brand-health.'
        return out
    headers = {'Authorization': auth, 'Content-Type': 'application/json'}

    # Branded search volume (Google Ads).
    try:
        r = requests.post(f'{DFS_BASE}/keywords_data/google_ads/search_volume/live',
                          headers=headers, timeout=20,
                          json=[{'keywords': [brand], 'location_name': location,
                                 'language_name': language}])
        items = (((r.json().get('tasks') or [{}])[0].get('result')) or [])
        vols = [i.get('search_volume') for i in items if i.get('search_volume') is not None]
        if vols:
            out['branded_search_volume'] = max(vols)
    except Exception:
        pass

    # Google Business rating + review count.
    try:
        r = requests.post(f'{DFS_BASE}/business_data/google/my_business_info/live',
                          headers=headers, timeout=30,
                          json=[{'keyword': brand, 'location_name': location,
                                 'language_name': language}])
        res = (((r.json().get('tasks') or [{}])[0].get('result')) or [{}])[0]
        biz = ((res.get('items') or [{}])[0]) if res else {}
        rating = biz.get('rating') or {}
        if rating.get('value') is not None:
            out['gbp_rating'] = rating.get('value')
            out['gbp_reviews'] = rating.get('votes_count')
    except Exception:
        pass

    return out


# ──────────────────────────────────────────────────────────────────────────────
# Scorecard assembly
# ──────────────────────────────────────────────────────────────────────────────
def _platform_card(platform, m):
    return {
        'platform': platform, 'handle': m.get('handle'), 'found': m.get('found', False),
        'followers': m.get('followers'), 'following': m.get('following'),
        'follower_ratio': m.get('follower_ratio'),
        'followers_growth_30d': m.get('followers_growth_30d'),
        'posts_per_week': m.get('posts_per_week'),
        'days_since_last_post': m.get('days_since_last_post'),
        'content_mix': m.get('content_mix'),
        'avg_likes': m.get('avg_likes'), 'avg_comments': m.get('avg_comments'),
        'engagement_rate': m.get('engagement_rate'),
        'avg_video_views': m.get('avg_video_views'),
        'top_vs_median': m.get('top_vs_median'),
        'hashtag_count': m.get('hashtag_count'), 'top_hashtags': m.get('top_hashtags'),
        'profile_completeness': m.get('profile_completeness'),
    }


def _flatten_indicators(client_metrics, brand_health):
    """Build the flat scorecard rows with status colours + source tags."""
    rows = []
    for p, m in client_metrics.items():
        cap = p.capitalize()
        er = m.get('engagement_rate')
        rows.append(_ind(f'{cap} engagement rate', f'{er}%' if er is not None else '—',
                         'Apify', _er_status(er)))
        ppw = m.get('posts_per_week')
        rows.append(_ind(f'{cap} posting cadence',
                         f'{ppw}/wk' if ppw is not None else '—',
                         'Apify', _cadence_status(ppw)))
        dsl = m.get('days_since_last_post')
        rows.append(_ind(f'{cap} days since last post', dsl if dsl is not None else '—',
                         'Apify', 'bad' if (dsl or 0) > 14 else 'warn' if (dsl or 0) > 7 else 'good'))
        comp = (m.get('profile_completeness') or {}).get('score')
        rows.append(_ind(f'{cap} profile completeness',
                         f'{comp}%' if comp is not None else '—', 'Apify',
                         'good' if (comp or 0) >= 80 else 'warn' if (comp or 0) >= 50 else 'bad'))
        gr = m.get('followers_growth_30d')
        rows.append(_ind(f'{cap} follower growth (30d est.)',
                         f'{"+" if (gr or 0) >= 0 else ""}{gr}' if gr is not None else 'baseline set',
                         'Apify + snapshots',
                         'good' if (gr or 0) > 0 else 'warn'))
    bh = brand_health or {}
    if bh.get('branded_search_volume') is not None:
        rows.append(_ind('Branded search volume', bh['branded_search_volume'], 'DataForSEO', 'good'))
    if bh.get('gbp_rating') is not None:
        rows.append(_ind('Google Business rating',
                         f"{bh['gbp_rating']} ({bh.get('gbp_reviews','?')} reviews)",
                         'DataForSEO', 'good' if bh['gbp_rating'] >= 4 else 'warn'))
    return rows


def _ind(label, value, source, status):
    return {'label': label, 'value': value, 'source': source, 'status': status}


def _er_status(er):
    if er is None: return 'warn'
    if er >= 2:    return 'good'
    if er >= 1:    return 'warn'
    return 'bad'


def _cadence_status(ppw):
    if ppw is None: return 'warn'
    if ppw >= 3:    return 'good'
    if ppw >= 1:    return 'warn'
    return 'bad'


# ──────────────────────────────────────────────────────────────────────────────
# Content & creative audit (vision) — analyses the actual posts: recurring
# themes, tone of voice, visual style and on-brand consistency.
# ──────────────────────────────────────────────────────────────────────────────
_VISION_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif'}


def _fetch_image_b64(url, max_bytes=4_500_000):
    """Download a post image and return (media_type, base64) or None.
    Skips non-images, oversized files, and anything that errors."""
    try:
        r = requests.get(url, timeout=12,
                         headers={'User-Agent': 'Mozilla/5.0 (compatible; SMAudit/1.0)'})
        if r.status_code >= 300:
            return None
        ctype = (r.headers.get('content-type') or '').split(';')[0].strip().lower()
        if ctype not in _VISION_TYPES:
            # infer from extension when the CDN omits/garbles the header
            ext = re.search(r'\.(jpe?g|png|webp|gif)(?:\?|$)', url, re.I)
            ctype = {'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                     'webp': 'image/webp', 'gif': 'image/gif'}.get(
                        (ext.group(1).lower() if ext else ''), '')
        data = r.content
        if ctype not in _VISION_TYPES or not data or len(data) > max_bytes:
            return None
        return ctype, base64.b64encode(data).decode()
    except requests.exceptions.RequestException:
        return None


def _analyze_creative(brand, client_metrics, extra_context=''):
    """Vision audit of the brand's actual posts. Returns a structured creative
    verdict, or None when there's no key / no usable content."""
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return None

    captions, image_urls = [], []
    for p, m in client_metrics.items():
        if not m.get('found'):
            continue
        for cap in (m.get('captions') or []):
            if cap:
                captions.append((p, cap))
        for url in (m.get('image_urls') or []):
            if url:
                image_urls.append((p, url))
    if not captions and not image_urls:
        return None

    # Fetch a bounded set of images concurrently (URLs expire / hotlink-protect,
    # so failures are expected and simply skipped).
    img_blocks, used_platforms = [], []
    if image_urls:
        with ThreadPoolExecutor(max_workers=8) as ex:
            fetched = list(ex.map(lambda pu: (pu[0], _fetch_image_b64(pu[1])),
                                  image_urls[:MAX_CREATIVE_IMAGES]))
        for plat, got in fetched:
            if got:
                ctype, b64 = got
                img_blocks.append({'type': 'image',
                                   'source': {'type': 'base64', 'media_type': ctype, 'data': b64}})
                used_platforms.append(plat)

    caption_text = '\n'.join(f'[{p}] {c}' for p, c in captions[:MAX_CREATIVE_CAPTIONS])
    img_note = (f'{len(img_blocks)} post images are attached (platforms: '
                f'{", ".join(sorted(set(used_platforms)))}).'
                if img_blocks else
                'No post images could be retrieved — base the visual read on the '
                'captions and note that imagery was unavailable.')

    prompt = (
        f"You are a senior brand & creative director auditing {brand}'s organic "
        "social posts. " + img_note + " Below are recent post captions, each tagged "
        "with its platform. Evaluate the actual creative output across every dimension "
        "a design or content lead would care about.\n\n"
        "EVALUATE:\n"
        "1. CONTENT — recurring topics/themes, content pillars, what's missing\n"
        "2. TONE & COPY — voice, language register, CTA quality, caption length\n"
        "3. DESIGN — layout, use of text-on-image, graphic vs photo ratio, "
        "   template consistency, whitespace, typography feel\n"
        "4. COLOUR SCHEME — dominant colours, palette coherence across posts, "
        "   brand colour usage vs off-brand choices\n"
        "5. STYLE — overall aesthetic (e.g. minimalist, vibrant, corporate, lifestyle), "
        "   photography style, editing consistency, reel/video style\n"
        "6. BRAND CONSISTENCY — how cohesive the look, voice and themes are across "
        "   posts and platforms; score 0-100\n"
        "7. STANDOUT & GAPS — what works well, what looks weak or inconsistent\n"
        "8. RECOMMENDATIONS — specific, actionable creative improvements\n\n"
        "Respond with STRICT JSON only, no prose, matching EXACTLY:\n"
        '{"content_themes":["3-5 recurring topics, <=10 words each"],'
        '"content_pillars":["3-5 strategic pillars inferred from posts, <=10 words each"],'
        '"tone_of_voice":"2-3 sentences on copy style, register, CTA quality",'
        '"visual_style":"2-3 sentences on overall aesthetic, photography vs graphic, editing",'
        '"colour_palette":{"dominant":["list 2-4 dominant colours by name or hex approx"],'
        '"coherence":"consistent | mostly consistent | inconsistent",'
        '"notes":"1-2 sentences on how colour is used and whether it feels on-brand"},'
        '"design_quality":{"score":0-100,'
        '"layout":"1-2 sentences on layout, whitespace, text-on-image",'
        '"template_use":"consistent templates | mixed | no templates",'
        '"typography":"1 sentence on font feel and consistency"},'
        '"brand_consistency":{"score":0-100,"notes":"1-2 sentences"},'
        '"standout_observations":["3-5 specific things that stand out — good or bad, <=15 words each"],'
        '"recommendations":["4-6 specific, actionable creative improvements, <=15 words each"]}\n\n'
        "Ground EVERY claim in the actual images/captions — no generic advice. "
        "If imagery was unavailable, note it in visual_style, colour_palette and design_quality and infer from captions only.\n\n"
        "POST CAPTIONS:\n"
        + (caption_text or '(no captions captured)')
        + (("\n\nADDITIONAL BRAND CONTEXT (user-supplied briefs/docs):\n" + extra_context[:4000])
           if extra_context else "")
    )

    content = img_blocks + [{'type': 'text', 'text': prompt}]
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': VISION_MODEL, 'max_tokens': 2000,
                                'messages': [{'role': 'user', 'content': content}]},
                          timeout=70)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        out['images_analyzed'] = len(img_blocks)
        out['posts_analyzed']  = len(captions)
        return out
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Haiku narrative
# ──────────────────────────────────────────────────────────────────────────────
def _narrate(brand, client_metrics, competitor_metrics, brand_health, indicators,
             extra_context='', creative=None):
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    facts = {
        'brand': brand,
        'platforms': {p: _platform_card(p, m) for p, m in client_metrics.items()},
        'competitors': competitor_metrics,
        'brand_health': brand_health,
        'indicators': indicators,
        'creative_audit': creative,
    }
    fallback = {
        'overall_health': 'Developing',
        'overall_score': None,
        'executive_summary': 'Audit data collected. Connect the Anthropic key for a written analysis.',
        'strengths': [], 'gaps': [], 'action_plan': [], 'competitor_insights': {},
    }
    if not api_key:
        return fallback

    prompt = (
        "You are a senior social media strategist. Given this AUDIT DATA (real "
        "metrics scraped from the brand's social profiles), write a concise audit "
        "verdict. Respond with STRICT JSON only, no prose, matching:\n"
        '{"overall_health":"Underperforming|Developing|Strong",'
        '"overall_score":0-100,'
        '"executive_summary":"2-3 sentences",'
        '"strengths":["..."],"gaps":["..."],'
        '"action_plan":[{"priority":"high|medium|low","action":"...","expected_impact":"..."}],'
        '"competitor_insights":{"doing_better":["..."],"content_gaps":["..."],"tactics_to_copy":["..."]}}\n'
        "Base every claim on the numbers. Keep arrays to 3-5 items. Only fill "
        "competitor_insights if the competitors array is non-empty (compare their "
        "engagement, cadence, content mix, hashtags and top posts to the brand's); "
        "otherwise return it as empty arrays. A creative_audit object (content "
        "themes, tone of voice, visual style, brand consistency) may be present — "
        "factor its findings into the summary, strengths/gaps and action plan.\n\nAUDIT DATA:\n"
        + json.dumps(facts, default=str)[:16000]
        + (("\n\nADDITIONAL CONTEXT the user uploaded (briefs, analytics, brand docs) "
            "— use it to sharpen the verdict, goals and action plan:\n" + extra_context[:8000])
           if extra_context else "")
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': HAIKU_MODEL, 'max_tokens': 2000,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=60)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        return {**fallback, **out}
    except Exception:
        return fallback


# ──────────────────────────────────────────────────────────────────────────────
# Small utils
# ──────────────────────────────────────────────────────────────────────────────
def _jobs():  return boto3.resource('dynamodb', region_name=REGION).Table(JOBS_TABLE)
def _snaps(): return boto3.resource('dynamodb', region_name=REGION).Table(SNAP_TABLE)
def _cache(): return boto3.resource('dynamodb', region_name=REGION).Table(CACHE_TABLE)


# 30-day Apify cache, keyed by platform#handle and shared across client +
# competitor lookups so repeat audits skip (and don't pay for) the scrape.
def _cache_key(platform, handle):
    return f'{platform}#{(handle or "").strip().lstrip("@").rstrip("/").lower()}'


def _cache_get(platform, handle):
    try:
        item = _cache().get_item(Key={'ckey': _cache_key(platform, handle)}).get('Item')
        if item and item.get('metrics') and int(item.get('ttl', 0)) > int(time.time()):
            m = json.loads(item['metrics'])
            # Ignore entries written under an older metrics shape (e.g. the
            # pre-fix TikTok scrape) so they re-scrape instead of serving bad data.
            if m.get('_schema') == METRICS_SCHEMA:
                return m
    except Exception:
        pass
    return None


def _cache_put(platform, handle, metrics):
    try:
        _cache().put_item(Item={
            'ckey': _cache_key(platform, handle),
            'metrics': json.dumps(metrics, default=str),
            'cached_at': int(time.time()),
            'ttl': int(time.time()) + CACHE_TTL_SECS,
        })
    except Exception:
        pass


def _num(v):
    if v is None: return None
    if isinstance(v, (int, float)): return v
    s = str(v).strip().lower().replace(',', '')
    mult = 1
    if s.endswith('k'): mult, s = 1_000, s[:-1]
    elif s.endswith('m'): mult, s = 1_000_000, s[:-1]
    elif s.endswith('b'): mult, s = 1_000_000_000, s[:-1]
    try:
        return int(float(s) * mult)
    except ValueError:
        return None


def _to_epoch(ts):
    if ts is None: return None
    if isinstance(ts, (int, float)):
        return ts / 1000 if ts > 1e11 else ts
    try:
        return datetime.fromisoformat(str(ts).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return None


def _top(items, n):
    counts = {}
    for x in items:
        counts[x] = counts.get(x, 0) + 1
    return [k for k, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:n]]


def _ddb_clean(obj):
    """DynamoDB rejects empty strings inside nested maps from some SDK paths;
    keep it simple by round-tripping through JSON (numbers stay numbers)."""
    return json.loads(json.dumps(obj, default=str))


def _now_iso(): return datetime.now(timezone.utc).isoformat()


def _parse_body(event):
    b = (event or {}).get('body', event)
    if isinstance(b, str):
        try: return json.loads(b)
        except ValueError: return {}
    return b or {}


def _resp(code, payload):
    return {'statusCode': code, 'headers': {**CORS, 'Content-Type': 'application/json'},
            'body': json.dumps(payload, default=str)}
