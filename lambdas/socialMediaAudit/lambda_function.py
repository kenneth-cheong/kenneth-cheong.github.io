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
from decimal import Decimal
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
# Monthly Social Reports — persistent client tracking (shared across all staff).
#   social_report_projects  PK: projectId (S)            — one client; settings,
#                            competitor list, tagged posts, lightweight month index.
#   social_report_months    PK: projectId (S), SK: month (S "YYYY-MM")
#                            — one captured month; full scorecard + AI recs + KPIs.
REPORT_PROJECTS_TABLE = os.environ.get('REPORT_PROJECTS_TABLE', 'social_report_projects')
REPORT_MONTHS_TABLE   = os.environ.get('REPORT_MONTHS_TABLE', 'social_report_months')
HAIKU_MODEL  = 'claude-haiku-4-5-20251001'
# Vision-capable model for the content/creative audit (visual style + theme).
# Sonnet reasons over imagery noticeably better than Haiku; it runs once per
# audit so the extra cost is bounded.
VISION_MODEL = os.environ.get('SMA_VISION_MODEL', 'claude-sonnet-4-6')
MAX_CREATIVE_IMAGES   = 21    # images fetched + sent to the vision model (brand)
MAX_CREATIVE_IMAGES_COMP = 12 # fewer per competitor — keeps the concurrent calls fast
MAX_CREATIVE_CAPTIONS = 21    # captions sent as text context
JOB_TTL_SECS   = 6 * 3600
CACHE_TTL_SECS = 30 * 86400        # 30-day Apify cache to cut scrape cost
# Bump whenever the metrics shape changes so stale-shape cache entries are
# treated as misses (forces a re-scrape) instead of serving wrong/partial data.
METRICS_SCHEMA = 6                  # v6: YouTube channel fields (numberOfSubscribers etc.)
MAX_GRID_POSTS = 21                 # posts surfaced for the visual grid (brand + competitors)

# ── Daily auto-capture (cron) ────────────────────────────────────────────────
# A scheduled EventBridge rule fires `cron_capture_all`, which fans out one
# async `cron_capture_one` self-invoke per project. Each captures THIS month
# (overwriting it daily so the in-progress month stays live) using the same
# Apify pipeline as the UI, plus the Meta Graph API for private IG/FB insights.
META_API          = 'https://graph.facebook.com/v23.0'
# A long-lived Business Manager SYSTEM USER token (non-expiring) with
# pages_show_list, pages_read_engagement, read_insights, instagram_basic,
# instagram_manage_insights + business_management, and the client Pages assigned.
META_ACCESS_TOKEN = os.environ.get('META_ACCESS_TOKEN', '')

# ── OAuth "Connect with …" (Monthly Social Reports) ──────────────────────────
# Lets a non-technical user authorise a client's Meta/LinkedIn/TikTok/YouTube
# account with one click instead of pasting a raw access token. The browser runs
# the consent dialog and hands us an authorization CODE; we exchange it here for
# an access token using the app SECRET (which must never reach the frontend).
#   • Client IDs are public — the frontend needs them to build the auth URL, so
#     oauth_config exposes them. Secrets stay server-side only.
#   • Each platform's app must be registered by the agency, the redirect URI
#     below whitelisted, and (Meta/LinkedIn) pass the platform's App Review for
#     the insights scopes. See DEPLOY.md → "OAuth setup".
#   • YouTube/Google is handled fully in-browser via Google Identity Services
#     (no secret, no server exchange) so only its client_id is read here.
OAUTH_REDIRECT_URI   = os.environ.get('OAUTH_REDIRECT_URI', 'https://app.digimetrics.ai/oauth-callback.html')
META_OAUTH_CLIENT_ID     = os.environ.get('META_OAUTH_CLIENT_ID', '')
META_OAUTH_CLIENT_SECRET = os.environ.get('META_OAUTH_CLIENT_SECRET', '')
META_OAUTH_SCOPES        = os.environ.get('META_OAUTH_SCOPES',
    'pages_show_list,pages_read_engagement,read_insights,instagram_basic,instagram_manage_insights,business_management')
LINKEDIN_OAUTH_CLIENT_ID     = os.environ.get('LINKEDIN_OAUTH_CLIENT_ID', '')
LINKEDIN_OAUTH_CLIENT_SECRET = os.environ.get('LINKEDIN_OAUTH_CLIENT_SECRET', '')
LINKEDIN_OAUTH_SCOPES        = os.environ.get('LINKEDIN_OAUTH_SCOPES',
    'r_organization_social r_organization_admin')
TIKTOK_OAUTH_CLIENT_ID     = os.environ.get('TIKTOK_OAUTH_CLIENT_ID', '')        # TikTok "client key"
TIKTOK_OAUTH_CLIENT_SECRET = os.environ.get('TIKTOK_OAUTH_CLIENT_SECRET', '')
TIKTOK_OAUTH_SCOPES        = os.environ.get('TIKTOK_OAUTH_SCOPES',
    'user.info.basic,user.info.profile,user.info.stats,video.list')
GOOGLE_OAUTH_CLIENT_ID     = os.environ.get('GOOGLE_OAUTH_CLIENT_ID', '')        # YouTube — frontend GIS only
# How long a single cron_capture_one waits for its Apify runs before finalizing
# with whatever finished. Keep below the Lambda timeout (set to 900s for cron).
CRON_MAX_WAIT_SECS = int(os.environ.get('CRON_MAX_WAIT_SECS', '660'))
# Metric → roll-up aggregation, mirroring the frontend METRICS catalog so the
# cron computes KPIs identically to kpisFromScorecard() in index.html.
METRIC_AGG = {
    'followers':'sum','net_new_followers':'sum','followers_increase':'sum',
    'followers_decrease':'sum','page_likes':'sum','impressions':'sum',
    'organic_impressions':'sum','paid_impressions':'sum','reach':'sum',
    'page_reach':'sum','daily_reach':'sum','paid_reach':'sum','frequency':'avg',
    'engagements':'sum','engagement_rate':'avg','engaged_users_daily':'sum',
    'engaged_users_rate':'avg','reactions':'sum','likes':'sum','comments':'sum',
    'shares':'sum','saves':'sum','interactions':'sum','interaction_rate':'avg',
    'clicks':'sum','ctr':'avg','profile_views':'sum','profile_cta_clicks':'sum',
    'video_views':'sum','avg_video_views':'avg','avg_watch_time':'avg',
    'video_frequency':'avg','full_video_watch_rate':'avg','posts_per_week':'sum',
    'avg_likes':'avg',
}

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
    # LinkedIn: harvestapi's cookie-less company-posts actor returns the posts
    # AND the company profile (follower count + name + avatar live on each post's
    # `author`), so one actor covers both — the old company-detail actor only
    # returned the profile and its input schema since broke (identifier->array).
    'linkedin':  'harvestapi~linkedin-company-posts',
}

# Facebook needs two actors: pages-scraper returns the profile (followers, etc.)
# but NO posts; posts-scraper returns the posts but NO follower count. We run both
# and merge — profile from pages, posts (engagement/cadence/grid) from posts.
FB_POSTS_ACTOR = 'apify~facebook-posts-scraper'

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
        # ── Monthly Social Reports: persistent project tracking ──────────────
        if action == 'report_list_projects':
            return _resp(200, report_list_projects(body))
        if action == 'report_get_project':
            return _resp(200, report_get_project(body))
        if action == 'report_save_project':
            return _resp(200, report_save_project(body))
        if action == 'report_delete_project':
            return _resp(200, report_delete_project(body))
        if action == 'report_save_month':
            return _resp(200, report_save_month(body))
        if action == 'report_get_month':
            return _resp(200, report_get_month(body))
        if action == 'report_delete_month':
            return _resp(200, report_delete_month(body))
        if action == 'report_save_tags':
            return _resp(200, report_save_tags(body))
        if action == 'report_recommend':
            return _resp(200, report_recommend(body))
        if action == 'report_extract_pdf':
            return _resp(200, report_extract_pdf(body))
        # ── OAuth "Connect with …" for per-client platform connections ───────
        if action == 'oauth_config':
            return _resp(200, oauth_config(body))
        if action == 'oauth_exchange':
            return _resp(200, oauth_exchange(body))
        # ── Daily auto-capture (scheduled, no user trigger) ──────────────────
        if action == 'cron_capture_all':
            return _resp(200, cron_capture_all(body))
        if action == 'cron_capture_one':
            return _resp(200, cron_capture_one(body))
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
    # The daily cron sets _no_cache so every run re-scrapes (the 30-day cache
    # would otherwise serve stale data and defeat true-daily capture).
    no_cache   = bool(body.get('_no_cache'))

    cached_n = 0
    runs = {}
    for p in platforms:
        handle = (handles.get(p) or '').strip()
        if not handle:
            continue
        actor = ACTORS.get(p)
        if not actor:
            continue
        if not no_cache and _cache_get(p, handle) is not None:   # fresh (<30d) → skip the scrape
            runs[p] = {'handle': handle, 'cached': True, 'role': 'client'}
            cached_n += 1
            continue
        entry = _start_platform(p, handle)
        if entry:
            runs[p] = {'handle': handle, 'role': 'client', **entry}

    # Competitors run the same actors (capped to keep cost predictable).
    comp_runs = []
    for c in competitors[:3]:
        p = (c.get('platform') or '').strip()
        handle = (c.get('handle') or '').strip()
        actor = ACTORS.get(p)
        if not (p and handle and actor):
            continue
        name = c.get('name') or handle
        if not no_cache and _cache_get(p, handle) is not None:
            comp_runs.append({'platform': p, 'handle': handle, 'name': name, 'cached': True})
            cached_n += 1
            continue
        entry = _start_platform(p, handle)
        if entry:
            comp_runs.append({'platform': p, 'handle': handle, 'name': name, **entry})

    if not runs and not comp_runs:
        raise RuntimeError('No valid platform handles were provided.')

    job_id = uuid.uuid4().hex
    _jobs().put_item(Item={
        'jobId': job_id,
        'brand': brand,
        'domain': body.get('domain') or '',
        'location': body.get('location') or 'Singapore',
        'extra_context': (body.get('extra_context') or '')[:40000],
        'listening': _ddb_clean(body.get('social_listening') or {}),
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
    live_ids = _all_live_ids(runs, comp_runs)
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
def _serialize_scorecard(scorecard):
    """JSON-encode the scorecard, progressively trimming the post grids if the
    payload would blow past DynamoDB's 400KB item limit (URLs can be very long)."""
    MAX_BYTES = 380_000
    s = json.dumps(scorecard, default=str)
    if len(s.encode('utf-8')) <= MAX_BYTES:
        return s
    for cap in (12, 8, 4, 0):
        for card in scorecard.get('platforms', []):
            if isinstance(card.get('posts'), list):
                card['posts'] = card['posts'][:cap]
        for comp in scorecard.get('competitors', []):
            if isinstance(comp.get('posts'), list):
                comp['posts'] = comp['posts'][:cap]
        s = json.dumps(scorecard, default=str)
        if len(s.encode('utf-8')) <= MAX_BYTES:
            return s
    return s


def handle_finalize(body):
    job_id = body.get('jobId')
    item = _jobs().get_item(Key={'jobId': job_id}).get('Item')
    if not item or item.get('scorecard'):
        return {'ok': True}
    try:
        runs      = item.get('runs') or {}
        comp_runs = item.get('comp_runs') or []
        brand     = item.get('brand') or 'brand'
        live_ids = _all_live_ids(runs, comp_runs)
        statuses = {rid: _apify_status(rid) for rid in live_ids}

        def _metrics_for(platform, r):
            """Cache hit → reuse stored metrics; else fetch the dataset, extract,
            and write to the 30-day cache so the next audit skips the scrape."""
            if r.get('cached'):
                return _cache_get(platform, r.get('handle')) or _empty_metrics(), 'cache'
            ok = statuses.get(r.get('run_id')) == 'SUCCEEDED'
            items = _apify_items(r.get('dataset_id')) if ok else []
            # Facebook posts come from a second actor (posts-scraper).
            post_items = []
            if r.get('posts_dataset_id') and statuses.get(r.get('posts_run_id')) == 'SUCCEEDED':
                post_items = _apify_items(r.get('posts_dataset_id'))
            m = _extract(platform, items, post_items)
            if items or post_items:
                _cache_put(platform, r.get('handle'), m)
            return m, ('apify' if (items or post_items) else 'empty')

        client_metrics = {}
        for p, r in runs.items():
            m, src = _metrics_for(p, r)
            m['handle'] = r.get('handle')
            m['found']  = src != 'empty'
            m = _add_growth(brand, p, m)
            client_metrics[p] = m

        competitor_metrics = []
        comp_creative_jobs = []   # (entry, name, platform, full_metrics) for creative eval
        for c in comp_runs:
            m, src = _metrics_for(c['platform'], c)
            entry = {
                'name': c.get('name'), 'platform': c['platform'], 'found': src != 'empty',
                'followers': m.get('followers'), 'engagement_rate': m.get('engagement_rate'),
                'posts_per_week': m.get('posts_per_week'),
                'days_since_last_post': m.get('days_since_last_post'),
                'avg_likes': m.get('avg_likes'), 'avg_comments': m.get('avg_comments'),
                'avg_video_views': m.get('avg_video_views'),
                'content_mix': m.get('content_mix'), 'top_hashtags': m.get('top_hashtags'),
                'top_posts': m.get('top_posts'),
                'handle': c.get('handle'),
                'posts': m.get('posts') or [],
            }
            competitor_metrics.append(entry)
            if src != 'empty' and (m.get('captions') or m.get('image_urls')):
                m['found'] = True   # _analyze_creative skips entries without it
                comp_creative_jobs.append((entry, c.get('name') or c.get('handle'), c['platform'], m))

        # Brand-health + social-listening both hit DataForSEO; fetch concurrently.
        # Listening is opt-in (frontend sets enabled) so daily cron captures skip it.
        _loc        = item.get('location') or 'Singapore'
        _listen_cfg = item.get('listening') or {}
        with ThreadPoolExecutor(max_workers=2) as _bx:
            _bh_fut = _bx.submit(fetch_brand_health, item.get('domain'), brand, _loc)
            _sl_fut = (_bx.submit(fetch_social_listening, brand, item.get('domain'), _loc, 'English', _listen_cfg)
                       if _listen_cfg.get('enabled') else None)
            brand_health     = _bh_fut.result()
            social_listening = _sl_fut.result() if _sl_fut else None
        indicators   = _flatten_indicators(client_metrics, brand_health)

        # Creative/design/colour eval for the brand AND each competitor — run
        # concurrently so the extra vision calls don't blow the 180s budget.
        extra_ctx = item.get('extra_context') or ''
        with ThreadPoolExecutor(max_workers=5) as ex:
            brand_fut = ex.submit(_analyze_creative, brand, client_metrics, extra_ctx)
            comp_futs = [(entry, ex.submit(_analyze_creative, name, {plat: cm}, '',
                                           MAX_CREATIVE_IMAGES_COMP))
                         for (entry, name, plat, cm) in comp_creative_jobs]
            creative = brand_fut.result()
            for entry, fut in comp_futs:
                try:
                    entry['creative'] = fut.result()
                except Exception:
                    entry['creative'] = None

        scorecard    = _narrate(brand, client_metrics, competitor_metrics, brand_health,
                                indicators, extra_ctx, creative=creative)
        scorecard.update({
            'platforms': [_platform_card(p, m) for p, m in client_metrics.items()],
            'indicators': indicators,
            'brand_health': brand_health,
            'social_listening': social_listening,
            'creative': creative,
            'competitors': [c for c in competitor_metrics if c.get('followers') is not None],
        })
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET scorecard = :s',
                            ExpressionAttributeValues={':s': _serialize_scorecard(scorecard)})
    except Exception as e:
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET finalize_error = :e',
                            ExpressionAttributeValues={':e': str(e)[:300]})
    return {'ok': True}


def _all_live_ids(runs, comp_runs):
    """All Apify run ids that need polling — primary plus Facebook's posts run."""
    ids = []
    for r in list(runs.values()) + list(comp_runs):
        if r.get('run_id'):
            ids.append(r['run_id'])
        if r.get('posts_run_id'):
            ids.append(r['posts_run_id'])
    return ids


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


def _start_platform(platform, handle):
    """Start the actor run(s) for one platform and return a run-entry dict
    ({run_id, dataset_id[, posts_run_id, posts_dataset_id]}) or None on failure.

    Facebook is special: it needs two actors — pages-scraper for the profile
    (followers) and posts-scraper for the actual posts."""
    actor = ACTORS.get(platform)
    if not actor:
        return None
    run = _apify_start(actor, _build_input(platform, handle))
    if not run:
        return None
    entry = {'run_id': run['id'], 'dataset_id': run.get('defaultDatasetId')}
    if platform == 'facebook':
        prun = _apify_start(FB_POSTS_ACTOR, _build_fb_posts_input(handle))
        if prun:
            entry['posts_run_id'] = prun['id']
            entry['posts_dataset_id'] = prun.get('defaultDatasetId')
    return entry


def _build_fb_posts_input(handle):
    user = handle.lstrip('@').strip()
    url = user if user.startswith('http') else f'https://www.facebook.com/{user}'
    return {'startUrls': [{'url': url}], 'resultsLimit': 24}




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
        # counts come from each post's `engagement` block, so skip the slower,
        # costlier per-reaction / per-comment scrapes — we only need the totals.
        return {'targetUrls': [url], 'maxPosts': 20,
                'scrapeReactions': False, 'scrapeComments': False}
    return {'usernames': [user]}


# ──────────────────────────────────────────────────────────────────────────────
# Extraction & indicator math — defensive against varying actor field names
# ──────────────────────────────────────────────────────────────────────────────
def _g(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ''):
            return d.get(k)
    return default


def _extract(platform, items, post_items=None):
    """Normalise actor output to a common metrics dict.

    Some actors (notably the clockworks TikTok scraper) return ONE item per
    post/video with the profile nested under `authorMeta`, rather than a
    profile object as items[0]. Prefer authorMeta for the profile fields when
    present so followers/verified/bio/avatar resolve correctly.

    `post_items` is an optional SECOND dataset holding the posts (Facebook: the
    pages-scraper `items` carry the profile, the posts-scraper `post_items`
    carry the posts). When given, posts are read from it instead of `items`."""
    if not items and not post_items:
        return _empty_metrics()
    head = items[0] if (items and isinstance(items[0], dict)) else {}

    # LinkedIn: the company-posts actor returns one item PER POST; the company
    # profile (follower count, name, avatar) lives on each post's `author`.
    if platform == 'linkedin':
        author = head.get('author') if isinstance(head.get('author'), dict) else {}
        followers = _parse_followers(author.get('info') or author.get('followers'))
        pfp = (author.get('avatar') or {}).get('url', '') if isinstance(author.get('avatar'), dict) else ''
        posts = _collect_posts('linkedin', items, head)
        return _metrics_from(followers, None, False, '', '', '', pfp, posts)

    prof = head.get('authorMeta') if isinstance(head.get('authorMeta'), dict) else head

    # YouTube (streamers~youtube-scraper) returns one item PER VIDEO with the
    # channel fields flat on each item (numberOfSubscribers/isChannelVerified/
    # channelDescription/channelAvatarUrl) — include those names so the channel
    # profile resolves. channelAvatarUrl is listed before the video thumbnailUrl
    # so the avatar wins over a video still for the profile picture.
    followers = _num(_g(prof, 'followersCount', 'followers', 'fans', 'fanCount',
                        'subscriberCount', 'followerCount', 'edge_followed_by',
                        'numberOfSubscribers', 'channelTotalSubscribers', 'subscribers'))
    following = _num(_g(prof, 'followsCount', 'following', 'followingCount'))
    verified  = bool(_g(prof, 'verified', 'isVerified', 'is_verified', 'isChannelVerified', default=False))
    bio       = _g(prof, 'biography', 'bio', 'channelDescription', 'description', 'about', 'signature', default='')
    link      = _g(prof, 'externalUrl', 'website', 'link', 'externalUrls', 'bioLink', default='')
    category  = _g(prof, 'businessCategoryName', 'category', 'categoryName', default='')
    pfp       = _g(prof, 'profilePicUrl', 'channelAvatarUrl', 'avatar', 'profileImage',
                   'originalAvatarUrl', 'thumbnailUrl', default='')

    if post_items:
        post_head = post_items[0] if isinstance(post_items[0], dict) else {}
        posts = _collect_posts(platform, post_items, post_head)
    else:
        posts = _collect_posts(platform, items, head)
    return _metrics_from(followers, following, verified, bio, link, category, pfp, posts)


_PROFILE_HEAD_KEYS = ('followersCount', 'followers', 'subscriberCount', 'fans',
                      'edge_followed_by', 'followerCount')


def _collect_posts(platform, items, head):
    """Return a list of normalised posts: {ts, likes, comments, views, type, hashtags}.

    Three actor shapes: (a) head carries a nested post list (Instagram), (b) head
    is itself a post and items[1:] are more posts (TikTok — items[0] is a video
    with authorMeta), (c) head is a profile and items[1:] are posts."""
    # LinkedIn posts come from harvestapi's company-posts actor — a distinct,
    # nested shape (engagement.*, postedAt.*, postImages/postVideo). Normalise it
    # directly rather than via the generic field-name guessing below.
    if platform == 'linkedin':
        out = []
        for p in items:
            if not isinstance(p, dict):
                continue
            eng  = p.get('engagement') or {}
            text = p.get('content') or ''
            pa   = p.get('postedAt') or {}
            pv   = p.get('postVideo') or {}
            imgs = p.get('postImages') or []
            is_video = bool(isinstance(pv, dict) and pv.get('thumbnailUrl'))
            image = (pv.get('thumbnailUrl') if is_video
                     else (imgs[0].get('url') if (imgs and isinstance(imgs[0], dict)) else ''))
            out.append({
                'ts':       pa.get('timestamp') or pa.get('date'),
                'likes':    _num(eng.get('likes')),
                'comments': _num(eng.get('comments')),
                'shares':   _num(eng.get('shares')),
                'views':    None,
                'type':     'video' if is_video else 'image',
                'hashtags': re.findall(r'#(\w+)', text),
                'text':     ' '.join(text.split())[:160],
                'caption':  ' '.join(text.split())[:400],
                'image':    image or '',
                'url':      p.get('linkedinUrl') or p.get('shareLinkedinUrl') or '',
            })
        return out
    nested = _g(head, 'latestPosts', 'posts', 'videos', 'topPosts', default=None)
    if nested:
        raw = nested
    else:
        head_is_profile = ('authorMeta' not in head
                           and any(k in head for k in _PROFILE_HEAD_KEYS))
        src = items[1:] if head_is_profile else items
        raw = [it for it in src if isinstance(it, dict)]
    is_youtube = (platform == 'youtube')
    out = []
    for p in raw:
        if not isinstance(p, dict):
            continue
        text = _g(p, 'caption', 'text', 'title', 'description', default='') or ''
        # Facebook posts report likes as a like-only count (often 0 for reels)
        # alongside topReactionsCount/reactionsCount — take the larger as "likes".
        likes = _num(_g(p, 'likesCount', 'likes', 'diggCount', 'reactionsCount',
                        'topReactionsCount', 'likeCount'))
        reactions = _num(_g(p, 'topReactionsCount', 'reactionsCount'))
        if reactions is not None and (likes is None or reactions > likes):
            likes = reactions
        out.append({
            'ts':       _g(p, 'timestamp', 'createTime', 'publishedAt', 'date', 'taken_at', 'time'),
            'likes':    likes,
            'comments': _num(_g(p, 'commentsCount', 'comments', 'commentCount')),
            'shares':   _num(_g(p, 'sharesCount', 'shares', 'shareCount', 'reshareCount', 'repostCount')),
            'views':    _num(_g(p, 'videoViewCount', 'playCount', 'views', 'viewCount', 'viewsCount')),
            'type':     _post_type(p),
            'hashtags': re.findall(r'#(\w+)', text),
            'text':     ' '.join(text.split())[:160],
            'caption':  ' '.join(text.split())[:400],   # longer text for theme/tone analysis
            'image':    (_youtube_thumb(p) if is_youtube else '') or _post_image(p),
            'url':      _g(p, 'url', 'webVideoUrl', 'postUrl', 'link', 'videoUrl', default=''),
        })
    return out


_YT_ID_RE = re.compile(r'(?:v=|/shorts/|youtu\.be/|/embed/|/v/)([A-Za-z0-9_-]{11})')

def _youtube_thumb(p):
    """Durable YouTube thumbnail from the video id. i.ytimg.com covers never
    expire and aren't hotlink-blocked, unlike the signed CDN urls the scraper
    returns — so prefer them for YouTube videos/Shorts."""
    vid = _g(p, 'id', 'videoId', default='')
    if not (isinstance(vid, str) and re.fullmatch(r'[A-Za-z0-9_-]{11}', vid or '')):
        vid = ''
    if not vid:
        for f in ('url', 'videoUrl', 'webVideoUrl', 'link'):
            u = p.get(f)
            if isinstance(u, str):
                m = _YT_ID_RE.search(u)
                if m:
                    vid = m.group(1)
                    break
    return f'https://i.ytimg.com/vi/{vid}/hqdefault.jpg' if vid else ''


def _img_from_media_item(m):
    """Pull a real image URL from one media item. Skips the bare `url` field —
    on Facebook media items that's a post permalink, not an image. Prefers the
    nested image/photo_image uri, then a thumbnail."""
    if isinstance(m, str):
        return m
    if not isinstance(m, dict):
        return ''
    for nest in ('image', 'photo_image', 'thumbnailImage', 'preferred_thumbnail',
                 'large_share_image', 'flexible_height_share_image', 'clip_fallback_cover'):
        sub = m.get(nest)
        if isinstance(sub, dict):
            u = _g(sub, 'uri', 'url', 'src', default='')
            if u:
                return u
        elif isinstance(sub, str) and sub:
            return sub
    return _g(m, 'thumbnail', 'thumbnailUrl', 'thumbnailSrc', 'src', 'imageUrl',
              'photoImage', 'coverUrl', 'cover', default='')


def _post_image(p):
    """Best-effort post thumbnail / display image URL across actor shapes.

    For albums (media is a list whose FIRST item can be a non-image wrapper —
    e.g. Facebook's mediaset token), scan every item and return the first that
    yields a real image, so multi-image posts still show their first photo."""
    img = _g(p, 'displayUrl', 'imageUrl', 'thumbnailUrl', 'thumbnailSrc', 'thumbnail',
             'cover', 'coverUrl', 'image', 'previewImageUrl', 'displayImageUrl', default='')
    if isinstance(img, dict):
        img = _g(img, 'uri', 'url', 'src', default='')
    if not img:
        for nest in ('videoMeta', 'video', 'media'):
            sub = p.get(nest)
            if isinstance(sub, dict):
                img = _g(sub, 'coverUrl', 'originalCoverUrl', 'cover', 'thumbnail',
                         'image', 'photoImage', default='')
                if isinstance(img, dict):
                    img = _g(img, 'uri', 'url', 'src', default='')
                if img:
                    break
    if not img:
        # Facebook/IG carry media as a LIST; the first item may be a wrapper, so
        # walk all items and take the first that resolves to a real image.
        for key in ('media', 'images', 'covers', 'thumbnails'):
            seq = p.get(key)
            if isinstance(seq, list):
                for item in seq:
                    cand = _img_from_media_item(item)
                    if cand:
                        img = cand
                        break
            if img:
                break
    return img if isinstance(img, str) else ''


def _post_type(p):
    if p.get('isVideo') is True:          # Facebook posts-scraper flag
        return 'video'
    t = str(_g(p, 'type', 'productType', 'mediaType', default='')).lower()
    if 'video' in t or 'reel' in t or 'clip' in t:
        return 'video'
    if 'carousel' in t or 'sidecar' in t or 'album' in t:
        return 'carousel'
    url = str(_g(p, 'url', 'topLevelUrl', default='')).lower()
    if '/reel/' in url or '/videos/' in url or '/watch' in url:
        return 'video'
    if _g(p, 'videoViewCount', 'playCount', 'videoUrl', 'viewsCount'):
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
        # full post list for the visual grid — most-recent first, bounded for payload size
        'posts': [
            {'image': p.get('image', ''), 'url': p.get('url', ''),
             'text': p.get('text', ''), 'type': p['type'],
             'likes': p['likes'], 'comments': p['comments'], 'views': p['views'],
             'ts': p.get('ts')}
            for p in sorted(posts, key=lambda p: _to_epoch(p.get('ts')) or 0, reverse=True)[:MAX_GRID_POSTS]
        ],
        # raw content for the creative/style audit (not surfaced in platform cards)
        'captions':   [p['caption'] for p in posts if p.get('caption')][:MAX_CREATIVE_CAPTIONS],
        'image_urls': [p['image'] for p in posts if p.get('image')][:MAX_GRID_POSTS],
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
            'post_sample': 0, 'top_posts': [], 'posts': [], 'captions': [], 'image_urls': [],
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
# Social listening — brand mentions + sentiment across the open web (DataForSEO
# Content Analysis: blogs, forums/message-boards, news, e-commerce, with native
# sentiment) PLUS Google site: searches for Reddit, Twitter/X and SG forums that
# Content Analysis doesn't cover natively. All best-effort: any failure leaves the
# field empty so the audit still renders. Opt-in via cfg.enabled (set by frontend).
# ──────────────────────────────────────────────────────────────────────────────
# Content Analysis page types we treat as "social/web mentions".
CA_PAGE_TYPES = ['ecommerce', 'news', 'blogs', 'message-boards', 'organization']

# Source key → (Google site: expression, human label) for the SERP layer. The
# expression is parenthesised so it groups correctly when AND-ed with the term
# group, e.g.  (site:twitter.com OR site:x.com) ("Brand" OR "Alias")  — verified
# that without the parens Google mis-scopes the X query to all of twitter.com.
LISTEN_SITES = {
    'reddit':  ('site:reddit.com',                  'Reddit'),
    'twitter': ('(site:twitter.com OR site:x.com)', 'Twitter / X'),
    'forums':  ('site:forums.hardwarezone.com.sg',  'HardwareZone & SG forums'),
}


def _ca_lang_code(language):
    """Map a DataForSEO language_name to the 2-letter code its filters expect."""
    return {'english': 'en'}.get((language or '').strip().lower(), 'en')


def _ca_dominant_sentiment(content_info):
    """Pick the strongest of positive/negative/neutral for one mention."""
    ct = (content_info or {}).get('connotation_types') or {}
    best, score = None, 0
    for k in ('positive', 'negative', 'neutral'):
        v = ct.get(k)
        if isinstance(v, (int, float)) and v > score:
            best, score = k, v
    return best


def _mostly_non_latin(text):
    """True if a title is predominantly non-Latin script — DataForSEO's language
    tag mislabels some Thai/CJK/Arabic/Cyrillic pages as 'en', so the request-side
    language filter lets them through; this drops them from the feed. Accented
    Latin (Spanish/French) stays since most of its letters are still ASCII."""
    letters = [c for c in (text or '') if c.isalpha()]
    if not letters:
        return False
    latin = sum(1 for c in letters if c.isascii())
    return latin / len(letters) < 0.5


# Coupon/voucher aggregators dominate brand keyword results but aren't real
# "mentions". spam_score / content_quality_score don't flag them (a coupon page
# scored quality=100), so filter on the tell-tale domain names + listing titles.
_PROMO_DOMAIN_RE = re.compile(r'(voucher|coupon|promo|discount|cashback|giftcard|couponcode)', re.I)
_PROMO_TITLE_RE  = re.compile(r'(free shipping|promo code|coupon code|discount code|\d+%\s*(off|discount)|save up to \d|cashback)', re.I)


def _is_promo_noise(domain, title):
    return bool(_PROMO_DOMAIN_RE.search(domain or '')) or bool(_PROMO_TITLE_RE.search(title or ''))


def _serp_site_mentions(terms, site_expr, location, language, headers, limit=8):
    """One Google site: search covering every term via a grouped OR query — used
    for Reddit/X/forum coverage that Content Analysis doesn't index natively.
    Boolean OR works natively in Google SERP (unlike Content Analysis)."""
    out = []
    try:
        phrase = '(' + ' OR '.join(f'"{t}"' for t in terms) + ')'
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers=headers, timeout=25,
                          json=[{'keyword': f'{site_expr} {phrase}',
                                 'location_name': location, 'language_name': language,
                                 'depth': max(10, limit)}])
        res = (((r.json().get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
        for it in (res.get('items') or []):
            if it.get('type') != 'organic' or not it.get('url'):
                continue
            out.append({'url': it.get('url'),
                        'title': (it.get('title') or '')[:160],
                        'snippet': (it.get('description') or '')[:200],
                        'date': it.get('timestamp')})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


def fetch_social_listening(brand, domain, location='Singapore', language='English', cfg=None):
    cfg = cfg or {}
    out = {'enabled': True, 'summary': None, 'mentions': [],
           'platforms': {}, 'terms': [], 'note': None}
    auth = os.environ.get('DATAFORSEO_AUTH')
    if not auth or not brand:
        out['note'] = 'Set DATAFORSEO_AUTH to populate social listening.'
        return out
    headers = {'Authorization': auth, 'Content-Type': 'application/json'}
    sources = cfg.get('sources') or ['web', 'reddit', 'twitter', 'forums']
    lang_code = _ca_lang_code(language)

    # Search terms = brand + the user's "extra terms to track", deduped case-
    # insensitively and capped. Content Analysis has no boolean OR (verified:
    # "Nike OR Adidas" returns fewer hits than either term), so each term costs
    # its own call — the cap bounds that. Google SERP DOES support OR, so the
    # platform layer folds all terms into one query per platform.
    MAX_TERMS = 5
    terms, seen = [], set()
    for t in [brand] + list(cfg.get('keywords') or []):
        t = (t or '').strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            terms.append(t)
        if len(terms) >= MAX_TERMS:
            break
    out['terms'] = terms

    # ---- Content Analysis: one call per term, then merge ----
    def _summary_one(term):
        try:
            r = requests.post(f'{DFS_BASE}/content_analysis/summary/live',
                              headers=headers, timeout=30,
                              json=[{'keyword': term, 'page_type': CA_PAGE_TYPES,
                                     'positive_connotation_threshold': 0.4,
                                     'sentiments_connotation_threshold': 0.4}])
            return (((r.json().get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
        except Exception:
            return {}

    def _mentions_one(term):
        try:
            # language filter cuts the foreign-language noise the bare keyword
            # otherwise pulls in (verified the filter works on this endpoint).
            r = requests.post(f'{DFS_BASE}/content_analysis/search/live',
                              headers=headers, timeout=30,
                              json=[{'keyword': term, 'page_type': CA_PAGE_TYPES,
                                     'search_mode': 'one_per_domain', 'limit': 20,
                                     'order_by': ['content_info.date_published,desc'],
                                     'filters': [['language', '=', lang_code]]}])
            res = (((r.json().get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
            return res.get('items') or []
        except Exception:
            return []

    def _merge_summaries(results):
        total, have_total = 0, False
        sent, have_sent = {'positive': 0, 'negative': 0, 'neutral': 0}, False
        dom = {}
        for res in results:
            tc = res.get('total_count')
            tc = res.get('count') if tc is None else tc
            if isinstance(tc, (int, float)):
                total += tc; have_total = True
            ct = res.get('connotation_types') or {}
            for k in sent:
                v = ct.get(k)
                if isinstance(v, (int, float)):
                    sent[k] += v; have_sent = True
            for d in (res.get('top_domains') or []):
                if isinstance(d, dict) and d.get('domain'):
                    dom[d['domain']] = dom.get(d['domain'], 0) + (d.get('count') or 0)
        return {
            'total_mentions': total if have_total else None,
            'sentiment': sent if have_sent else
                         {'positive': None, 'negative': None, 'neutral': None},
            'top_domains': [k for k, _ in sorted(dom.items(),
                                                 key=lambda kv: kv[1], reverse=True)[:8]],
        }

    def _merge_mentions(items_lists):
        # Interleave terms (round-robin) so one busy term doesn't fill the feed,
        # dedupe by URL, cap at 20.
        from itertools import zip_longest
        merged, seen_urls = [], set()
        for row in zip_longest(*items_lists) if items_lists else []:
            for it in row:
                if not it:
                    continue
                url = it.get('url')
                if not url or url in seen_urls:
                    continue
                ci = it.get('content_info') or {}
                title = ci.get('title') or ci.get('main_title') or ''
                if _mostly_non_latin(title):              # mislabeled-foreign page → skip
                    continue
                if _is_promo_noise(it.get('domain'), title):  # coupon/voucher spam → skip
                    continue
                seen_urls.add(url)
                pt = it.get('page_types')
                merged.append({
                    'url': url,
                    'domain': it.get('domain'),
                    'title': (title or url or '')[:160],
                    'snippet': (ci.get('snippet') or ci.get('highlighted_text') or '')[:240],
                    'date': ci.get('date_published'),
                    'sentiment': _ca_dominant_sentiment(ci),
                    'page_type': (pt[0] if isinstance(pt, list) and pt else it.get('page_type')),
                })
                if len(merged) >= 20:
                    return merged
        return merged

    with ThreadPoolExecutor(max_workers=8) as ex:
        sum_futs = ment_futs = []
        if 'web' in sources:
            sum_futs  = [ex.submit(_summary_one, t) for t in terms]
            ment_futs = [ex.submit(_mentions_one, t) for t in terms]
        plat_futs = {}
        for key, (site_expr, label) in LISTEN_SITES.items():
            if key in sources:
                plat_futs[key] = (label, ex.submit(_serp_site_mentions, terms, site_expr,
                                                   location, language, headers))
        if 'web' in sources:
            out['summary']  = _merge_summaries([f.result() for f in sum_futs])
            out['mentions'] = _merge_mentions([f.result() for f in ment_futs])
        for key, (label, fut) in plat_futs.items():
            out['platforms'][key] = {'label': label, 'results': fut.result()}

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
        'posts': m.get('posts') or [],
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


def _analyze_creative(brand, client_metrics, extra_context='', max_images=None):
    """Vision audit of the brand's (or a competitor's) actual posts. Returns a
    structured creative verdict, or None when there's no key / no usable content.
    `max_images` caps how many images are sent (defaults to MAX_CREATIVE_IMAGES)."""
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return None
    if max_images is None:
        max_images = MAX_CREATIVE_IMAGES

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
                                  image_urls[:max_images]))
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
# Monthly Social Reports — persistent, cross-user client tracking
# ──────────────────────────────────────────────────────────────────────────────
# A "project" is one client we report on monthly. Settings (handles, competitor
# accounts, tagged posts) live on the project item; each captured month's full
# scorecard + AI recommendations live in the months table (kept separate so a
# single project never blows past DynamoDB's 400KB item cap). All staff share the
# same store — no per-user filtering — mirroring the recruitment database model.

def _rprojects(): return boto3.resource('dynamodb', region_name=REGION).Table(REPORT_PROJECTS_TABLE)
def _rmonths():   return boto3.resource('dynamodb', region_name=REGION).Table(REPORT_MONTHS_TABLE)

def _enc(obj):
    """Encode for DynamoDB writes — JSON round-trip turns floats into Decimal
    (boto3's resource client rejects raw floats) and drops empty strings is not
    needed here since we keep them as-is."""
    return json.loads(json.dumps(obj, default=str), parse_float=Decimal)

def _dec(obj):
    """Decode DynamoDB reads back to plain JSON — Decimal → int/float — so the
    HTTP response never leaks Decimals (which _resp would stringify)."""
    if isinstance(obj, list):
        return [_dec(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _dec(v) for k, v in obj.items()}
    if isinstance(obj, Decimal):
        return int(obj) if obj == obj.to_integral_value() else float(obj)
    return obj

def _who(body):
    u = body.get('currentUser') or {}
    if isinstance(u, dict):
        return (u.get('email') or u.get('name') or body.get('userEmail') or 'unknown')
    return str(u or body.get('userEmail') or 'unknown')

def report_list_projects(body):
    """All projects, lightweight (no full scorecards) — for the projects grid."""
    items = []
    resp = _rprojects().scan()
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = _rprojects().scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    items.sort(key=lambda p: str(p.get('updated') or p.get('created') or ''), reverse=True)
    return {'projects': _dec(items)}

def report_get_project(body):
    """Full project settings + the month index (summaries only, no heavy scorecards)."""
    pid = (body.get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    # Month summaries (drop the bulky scorecard/recommendations payloads here).
    resp = _rmonths().query(KeyConditionExpression=Key('projectId').eq(pid),
                            ProjectionExpression='#m, kpis, savedAt, savedBy',
                            ExpressionAttributeNames={'#m': 'month'},
                            ScanIndexForward=True)
    months = resp.get('Items', [])
    return {'project': _dec(proj), 'months': _dec(months)}

def report_save_project(body):
    """Create or update a project's settings (name, brand, handles, competitors)."""
    data = body.get('data') or body
    pid = (data.get('projectId') or '').strip() or uuid.uuid4().hex
    existing = _rprojects().get_item(Key={'projectId': pid}).get('Item') or {}
    now = _now_iso(); who = _who(body)
    item = {
        'projectId':   pid,
        'name':        (data.get('name') or existing.get('name') or 'Untitled client').strip(),
        'brand':       (data.get('brand') or existing.get('brand') or '').strip(),
        'domain':      (data.get('domain') or existing.get('domain') or '').strip(),
        'industry':    (data.get('industry') or existing.get('industry') or '').strip(),
        'location':    (data.get('location') or existing.get('location') or 'Singapore').strip(),
        'handles':     data.get('handles')     if data.get('handles')     is not None else existing.get('handles', {}),
        'platforms':   data.get('platforms')   if data.get('platforms')   is not None else existing.get('platforms', []),
        'competitors': data.get('competitors') if data.get('competitors') is not None else existing.get('competitors', []),
        # Per-client OAuth/token connections {meta:{token,name}, linkedin:{...}, …}.
        # Holds platform access tokens, so it must survive reload (was previously
        # accepted from the client but never persisted) and is encrypted at rest.
        'connections': data.get('connections') if data.get('connections') is not None else existing.get('connections', {}),
        'tagged_posts':data.get('tagged_posts')if data.get('tagged_posts')is not None else existing.get('tagged_posts', []),
        'months':      existing.get('months', []),
        'created':     existing.get('created') or now,
        'created_by':  existing.get('created_by') or who,
        'updated':     now,
        'updated_by':  who,
    }
    stored = _enc(item)
    _rprojects().put_item(Item=stored)
    return {'ok': True, 'project': _dec(stored)}

def report_delete_project(body):
    pid = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    # Delete all captured months first, then the project.
    resp = _rmonths().query(KeyConditionExpression=Key('projectId').eq(pid),
                            ProjectionExpression='#m', ExpressionAttributeNames={'#m': 'month'})
    with _rmonths().batch_writer() as bw:
        for mit in resp.get('Items', []):
            bw.delete_item(Key={'projectId': pid, 'month': mit['month']})
    _rprojects().delete_item(Key={'projectId': pid})
    return {'ok': True}

def report_save_month(body):
    """Persist one captured month: full scorecard + KPI summary + AI recs. Also
    refreshes the project's lightweight month index + latest-KPI snapshot."""
    data  = body.get('data') or body
    pid   = (data.get('projectId') or '').strip()
    month = (data.get('month') or '').strip()         # "YYYY-MM"
    if not pid or not month:
        raise RuntimeError('Missing projectId or month.')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    now = _now_iso(); who = _who(body)
    scorecard = data.get('scorecard') or {}
    kpis      = data.get('kpis') or {}
    recs      = data.get('recommendations')

    _rmonths().put_item(Item=_enc({
        'projectId': pid, 'month': month,
        'scorecard': _serialize_scorecard(scorecard) if isinstance(scorecard, dict) else (scorecard or ''),
        'kpis': kpis,
        'recommendations': recs,
        'savedAt': now, 'savedBy': who,
    }))

    # Maintain the month index on the project (dedupe by month, keep sorted).
    idx = [m for m in (_dec(proj.get('months')) or []) if m.get('month') != month]
    idx.append({'month': month, 'savedAt': now, 'savedBy': who, 'kpis': kpis})
    idx.sort(key=lambda m: str(m.get('month')))
    _rprojects().update_item(
        Key={'projectId': pid},
        UpdateExpression='SET months = :m, updated = :u, updated_by = :w',
        ExpressionAttributeValues={':m': _enc(idx), ':u': now, ':w': who})
    return {'ok': True, 'month': month, 'months': _dec(_enc(idx))}

def report_get_month(body):
    """One month's full payload (scorecard rehydrated, recommendations, kpis)."""
    pid   = (body.get('projectId') or '').strip()
    month = (body.get('month') or '').strip()
    if not pid or not month:
        raise RuntimeError('Missing projectId or month.')
    it = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    if not it:
        raise RuntimeError('No data captured for that month.')
    sc = it.get('scorecard')
    if isinstance(sc, str):
        try: sc = json.loads(sc)
        except ValueError: sc = {}
    return {'month': month, 'scorecard': sc,
            'kpis': _dec(it.get('kpis') or {}),
            'recommendations': _dec(it.get('recommendations')),
            'savedAt': it.get('savedAt'), 'savedBy': it.get('savedBy')}

def report_delete_month(body):
    data  = body.get('data') or body
    pid   = (data.get('projectId') or '').strip()
    month = (data.get('month') or '').strip()
    if not pid or not month:
        raise RuntimeError('Missing projectId or month.')
    _rmonths().delete_item(Key={'projectId': pid, 'month': month})
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item') or {}
    idx = [m for m in (_dec(proj.get('months')) or []) if m.get('month') != month]
    _rprojects().update_item(
        Key={'projectId': pid},
        UpdateExpression='SET months = :m, updated = :u',
        ExpressionAttributeValues={':m': _enc(idx), ':u': _now_iso()})
    return {'ok': True, 'months': _dec(_enc(idx))}

def report_save_tags(body):
    """Replace the project's tagged-posts list (posts the user flags to track)."""
    data = body.get('data') or body
    pid  = (data.get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    tagged = data.get('tagged_posts')
    if tagged is None:
        tagged = []
    _rprojects().update_item(
        Key={'projectId': pid},
        UpdateExpression='SET tagged_posts = :t, updated = :u, updated_by = :w',
        ExpressionAttributeValues={':t': _enc(tagged), ':u': _now_iso(), ':w': _who(body)})
    return {'ok': True, 'tagged_posts': _dec(_enc(tagged))}

def report_recommend(body):
    """Client-ready monthly recommendations from this month's KPIs vs last month,
    the per-platform metrics, tagged-post performance and competitor benchmark.
    Strict-JSON Haiku call (fast, single round-trip, well under the gateway timeout)."""
    data = body.get('data') or body
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    facts = {
        'brand':        data.get('brand') or data.get('name') or 'the brand',
        'month':        data.get('month'),
        'previous_month': data.get('previous_month'),
        'kpis_this_month':     data.get('kpis') or {},
        'kpis_previous_month': data.get('prev_kpis') or {},
        'platforms':    data.get('platforms') or [],
        'competitors':  data.get('competitors') or [],
        'tagged_posts': data.get('tagged_posts') or [],
        'goals':        data.get('goals') or '',
    }
    fallback = {
        'headline': 'Monthly performance captured.',
        'wins': [], 'concerns': [], 'recommendations': [], 'next_month_focus': [],
    }
    if not api_key:
        return {'recommendations_block': fallback, 'ai': False}
    prompt = (
        "You are a senior social media account manager writing the recommendations "
        "section of a MONTHLY client report. Given the data (real metrics, this "
        "month vs last month, the client's own tagged priority posts and competitor "
        "benchmarks), write a concise, client-facing analysis. Respond with STRICT "
        "JSON only, no prose, matching:\n"
        '{"headline":"one punchy sentence on the month",'
        '"wins":["2-4 concrete wins, cite the numbers/deltas"],'
        '"concerns":["1-3 honest concerns or declines"],'
        '"recommendations":[{"title":"...","detail":"1-2 sentences, specific & actionable","priority":"high|medium|low"}],'
        '"next_month_focus":["2-3 priorities for next month"]}\n'
        "Ground every point in the numbers. Reference platforms by name. If tagged "
        "posts are present, comment on what made them work and how to repeat it. "
        "Keep it plain-English for a non-marketer client.\n\nDATA:\n"
        + json.dumps(facts, default=str)[:16000]
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': HAIKU_MODEL, 'max_tokens': 1800,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=60)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        return {'recommendations_block': {**fallback, **out}, 'ai': True}
    except Exception as e:
        return {'recommendations_block': fallback, 'ai': False, 'error': str(e)[:200]}


def report_extract_pdf(body):
    """Read a brand's monthly platform export (rasterised to page images by the
    browser) and pull the headline KPIs per platform so the user can backfill a
    past month. Vision model; returns a DRAFT the user confirms/edits before save."""
    data = body.get('data') or body
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    images = data.get('images') or []          # list of base64 JPEG/PNG (data-url or raw)
    if not api_key:
        return {'extracted': None, 'ai': False, 'error': 'AI key not configured.'}
    if not images:
        return {'extracted': None, 'ai': False, 'error': 'No pages supplied.'}

    blocks = []
    for img in images[:12]:                    # cap pages to keep the call bounded
        s = img if isinstance(img, str) else ''
        ctype = 'image/jpeg'
        if s.startswith('data:'):
            try:
                head, s = s.split(',', 1)
                ctype = head.split(':', 1)[1].split(';', 1)[0] or 'image/jpeg'
            except Exception:
                pass
        if not s:
            continue
        blocks.append({'type': 'image', 'source': {'type': 'base64', 'media_type': ctype, 'data': s}})
    if not blocks:
        return {'extracted': None, 'ai': False, 'error': 'No readable pages.'}

    prompt = (
        "These page images are a monthly SOCIAL MEDIA performance export for one "
        "brand (e.g. from Meltwater, Sprout, Meta Business Suite or a platform "
        "report). Read EVERY metric shown. If a reporting period / month is shown, "
        "capture it. For EACH platform present (instagram, tiktok, facebook, "
        "linkedin, youtube, xiaohongshu), read the figures — expand abbreviated "
        "numbers (1.4K -> 1400, 26.38K -> 26380, 1.2M -> 1200000). Use null for any "
        "metric NOT shown for that platform; never guess. Respond with STRICT JSON "
        "only, no prose, matching this shape (every key per platform object):\n"
        '{"month":"YYYY-MM or null",'
        '"period_label":"the date range text shown, or null",'
        '"platforms":[{'
        '"platform":"instagram|tiktok|facebook|linkedin|youtube|xiaohongshu",'
        '"followers":number|null,"net_new_followers":number|null,'
        '"followers_increase":number|null,"followers_decrease":number|null,'
        '"page_likes":number|null,"impressions":number|null,'
        '"organic_impressions":number|null,"paid_impressions":number|null,'
        '"reach":number|null,"page_reach":number|null,"daily_reach":number|null,'
        '"paid_reach":number|null,"frequency":number|null,"engagements":number|null,'
        '"engagement_rate":number|null,"engaged_users_daily":number|null,'
        '"engaged_users_rate":number|null,"reactions":number|null,"likes":number|null,'
        '"comments":number|null,"shares":number|null,"saves":number|null,'
        '"interactions":number|null,"interaction_rate":number|null,"clicks":number|null,'
        '"ctr":number|null,"profile_views":number|null,"profile_cta_clicks":number|null,'
        '"video_views":number|null,"avg_video_views":number|null,'
        '"avg_watch_time":number|null,"video_frequency":number|null,'
        '"full_video_watch_rate":number|null,"posts_per_week":number|null,'
        '"avg_likes":number|null}],'
        '"notes":"one line on anything ambiguous, or empty"}\n'
        "Field meaning: reach=Reach (daily); page_reach=total Page Reach; "
        "engagement_rate / engagement_rate (reach) is a percent number (0.61 means "
        "0.61); frequency is a multiplier (e.g. 0.99); profile_views=Channel profile "
        "views; engaged_users_daily=Engaged users (daily); video metrics are TikTok/"
        "YouTube. If only a monthly POST COUNT is shown, divide by ~4.3 for "
        "posts_per_week. Omit a platform entirely if it has no figures at all."
    )
    content = blocks + [{'type': 'text', 'text': prompt}]
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': VISION_MODEL, 'max_tokens': 3000,
                                'messages': [{'role': 'user', 'content': content}]},
                          timeout=150)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        return {'extracted': out, 'ai': True}
    except Exception as e:
        return {'extracted': None, 'ai': False, 'error': str(e)[:200]}


# ──────────────────────────────────────────────────────────────────────────────
# OAuth "Connect with …" — turn a one-click consent into a stored access token
#
# The browser runs the platform's consent dialog and gets back an authorization
# CODE (never a secret). It posts that code here; we swap it for an access token
# using the app secret and return {token, name} shaped exactly like the old
# paste-a-token path, so the frontend stores it through the same channel.
# YouTube/Google is the exception — its token is obtained fully in-browser via
# Google Identity Services, so only its client_id is surfaced (no exchange here).
# ──────────────────────────────────────────────────────────────────────────────
def oauth_config(body):
    """Public OAuth config the frontend needs to build consent URLs. Exposes
    client IDs + scopes + redirect URI ONLY — never secrets. `configured` tells
    the UI whether to offer the one-click button or fall back to Advanced paste."""
    return {
        'redirect_uri': OAUTH_REDIRECT_URI,
        'platforms': {
            'meta': {
                'configured': bool(META_OAUTH_CLIENT_ID and META_OAUTH_CLIENT_SECRET),
                'client_id': META_OAUTH_CLIENT_ID, 'scopes': META_OAUTH_SCOPES,
                'flow': 'code', 'authorize': 'https://www.facebook.com/v23.0/dialog/oauth'},
            'linkedin': {
                'configured': bool(LINKEDIN_OAUTH_CLIENT_ID and LINKEDIN_OAUTH_CLIENT_SECRET),
                'client_id': LINKEDIN_OAUTH_CLIENT_ID, 'scopes': LINKEDIN_OAUTH_SCOPES,
                'flow': 'code', 'authorize': 'https://www.linkedin.com/oauth/v2/authorization'},
            'tiktok': {
                'configured': bool(TIKTOK_OAUTH_CLIENT_ID and TIKTOK_OAUTH_CLIENT_SECRET),
                'client_id': TIKTOK_OAUTH_CLIENT_ID, 'scopes': TIKTOK_OAUTH_SCOPES,
                'flow': 'code', 'authorize': 'https://www.tiktok.com/v2/auth/authorize/'},
            'youtube': {
                'configured': bool(GOOGLE_OAUTH_CLIENT_ID),
                'client_id': GOOGLE_OAUTH_CLIENT_ID,
                'scopes': 'https://www.googleapis.com/auth/youtube.readonly',
                'flow': 'gis'},
        },
    }


def oauth_exchange(body):
    """Exchange an authorization code (meta/linkedin/tiktok) for an access token.
    Returns {token, name, expires_in?} identical in shape to the paste path so the
    frontend persists it the same way. YouTube tokens are obtained in-browser."""
    platform = (body.get('platform') or '').strip().lower()
    code     = (body.get('code') or '').strip()
    # The redirect URI in the exchange MUST byte-match the one used at consent.
    # The frontend echoes it back; fall back to our configured default.
    redirect = (body.get('redirect_uri') or OAUTH_REDIRECT_URI).strip()
    if not code:
        raise RuntimeError('Missing authorization code.')
    if platform == 'meta':
        return _oauth_meta(code, redirect)
    if platform == 'linkedin':
        return _oauth_linkedin(code, redirect)
    if platform == 'tiktok':
        return _oauth_tiktok(code, redirect)
    raise RuntimeError(f'OAuth exchange not supported for platform: {platform or "(none)"}')


def _oauth_meta(code, redirect):
    if not (META_OAUTH_CLIENT_ID and META_OAUTH_CLIENT_SECRET):
        raise RuntimeError('Meta sign-in is not set up on the server (META_OAUTH_CLIENT_ID/SECRET).')
    # 1) code → short-lived user token
    d = requests.get(f'{META_API}/oauth/access_token', timeout=20, params={
        'client_id': META_OAUTH_CLIENT_ID, 'client_secret': META_OAUTH_CLIENT_SECRET,
        'redirect_uri': redirect, 'code': code}).json()
    if d.get('error'):
        raise RuntimeError('Meta: ' + (d['error'].get('message') or 'token exchange failed'))
    short = d.get('access_token')
    if not short:
        raise RuntimeError('Meta returned no access token.')
    # 2) short → long-lived (≈60 days) so monthly pulls keep working unattended
    token, expires = short, d.get('expires_in')
    try:
        d2 = requests.get(f'{META_API}/oauth/access_token', timeout=20, params={
            'grant_type': 'fb_exchange_token', 'client_id': META_OAUTH_CLIENT_ID,
            'client_secret': META_OAUTH_CLIENT_SECRET, 'fb_exchange_token': short}).json()
        if d2.get('access_token'):
            token = d2['access_token']; expires = d2.get('expires_in', expires)
    except Exception:
        pass   # keep the short-lived token rather than fail the whole connect
    name = 'Meta account'
    try:
        name = requests.get(f'{META_API}/me', timeout=15,
                            params={'access_token': token, 'fields': 'name'}).json().get('name') or name
    except Exception:
        pass
    out = {'token': token, 'name': name}
    if expires:
        out['expires_in'] = expires
    return out


def _oauth_linkedin(code, redirect):
    if not (LINKEDIN_OAUTH_CLIENT_ID and LINKEDIN_OAUTH_CLIENT_SECRET):
        raise RuntimeError('LinkedIn sign-in is not set up on the server (LINKEDIN_OAUTH_CLIENT_ID/SECRET).')
    d = requests.post('https://www.linkedin.com/oauth/v2/accessToken', timeout=20,
                      headers={'Content-Type': 'application/x-www-form-urlencoded'},
                      data={'grant_type': 'authorization_code', 'code': code,
                            'redirect_uri': redirect, 'client_id': LINKEDIN_OAUTH_CLIENT_ID,
                            'client_secret': LINKEDIN_OAUTH_CLIENT_SECRET}).json()
    token = d.get('access_token')
    if not token:
        raise RuntimeError('LinkedIn: ' + (d.get('error_description') or d.get('error') or 'token exchange failed'))
    name = 'LinkedIn account'
    try:
        name = requests.get('https://api.linkedin.com/v2/userinfo', timeout=15,
                            headers={'Authorization': 'Bearer ' + token}).json().get('name') or name
    except Exception:
        pass
    out = {'token': token, 'name': name}
    if d.get('expires_in'):
        out['expires_in'] = d['expires_in']
    return out


def _oauth_tiktok(code, redirect):
    if not (TIKTOK_OAUTH_CLIENT_ID and TIKTOK_OAUTH_CLIENT_SECRET):
        raise RuntimeError('TikTok sign-in is not set up on the server (TIKTOK_OAUTH_CLIENT_ID/SECRET).')
    d = requests.post('https://open.tiktokapis.com/v2/oauth/token/', timeout=20,
                      headers={'Content-Type': 'application/x-www-form-urlencoded'},
                      data={'client_key': TIKTOK_OAUTH_CLIENT_ID,
                            'client_secret': TIKTOK_OAUTH_CLIENT_SECRET, 'code': code,
                            'grant_type': 'authorization_code', 'redirect_uri': redirect}).json()
    token = d.get('access_token')
    if not token:
        raise RuntimeError('TikTok: ' + (d.get('error_description') or d.get('error') or 'token exchange failed'))
    name = 'TikTok account'
    try:
        ui = requests.get('https://open.tiktokapis.com/v2/user/info/', timeout=15,
                          headers={'Authorization': 'Bearer ' + token},
                          params={'fields': 'display_name'}).json()
        name = (((ui.get('data') or {}).get('user') or {}).get('display_name')) or name
    except Exception:
        pass
    out = {'token': token, 'name': name}
    if d.get('expires_in'):
        out['expires_in'] = d['expires_in']
    if d.get('open_id'):
        out['open_id'] = d['open_id']
    return out


# ──────────────────────────────────────────────────────────────────────────────
# DAILY AUTO-CAPTURE (cron) — no user trigger
#
# `cron_capture_all` (fired by an EventBridge schedule) scans every project and
# async self-invokes `cron_capture_one` per project, so each gets its own full
# Lambda budget. `cron_capture_one` re-captures the CURRENT month (overwriting it
# each day so the in-progress month stays live) via the same Apify pipeline used
# by the UI, then overlays Meta's private IG/FB insights, and saves.
# ──────────────────────────────────────────────────────────────────────────────
def _current_month():
    d = datetime.now(timezone.utc)
    return f'{d.year:04d}-{d.month:02d}'


def cron_capture_all(body):
    month = (body.get('month') or '').strip() or _current_month()
    items = []
    resp = _rprojects().scan(ProjectionExpression='projectId')
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = _rprojects().scan(ProjectionExpression='projectId',
                                 ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    fired = 0
    for it in items:
        pid = it.get('projectId')
        if not pid:
            continue
        _self_invoke({'action': 'cron_capture_one', 'projectId': pid, 'month': month})
        fired += 1
    return {'ok': True, 'projects': fired, 'month': month}


def cron_capture_one(body):
    pid   = (body.get('projectId') or '').strip()
    month = (body.get('month') or '').strip() or _current_month()
    if not pid:
        raise RuntimeError('Missing projectId.')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)

    # 1. Apify scrape (organic, public) — same pipeline as the UI's "Capture".
    sc = _cron_apify_scorecard(proj, month)

    # 2. Meta Graph overlay (private owner-only IG/FB insights).
    try:
        meta_platforms = _cron_meta_platforms(proj, month)
        sc = _merge_meta_platforms(sc, meta_platforms)
    except Exception as e:
        sc = sc or {}
        sc['_meta_error'] = str(e)[:200]

    # 3. Preserve any platforms from the existing month NOT re-captured here
    #    (e.g. manual-only Xiaohongshu rows) plus user-written recommendations.
    existing = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    prev_sc, prev_recs = {}, None
    if existing:
        prev_recs = _dec(existing.get('recommendations'))
        if isinstance(existing.get('scorecard'), str):
            try: prev_sc = json.loads(existing['scorecard'])
            except ValueError: prev_sc = {}
    have = {c.get('platform') for c in (sc.get('platforms') or [])}
    for p in (prev_sc.get('platforms') or []):
        if p.get('platform') and p['platform'] not in have:
            sc.setdefault('platforms', []).append(p)

    if not (sc.get('platforms') or []):
        return {'ok': False, 'projectId': pid, 'month': month,
                'reason': 'no data captured', 'meta_error': sc.get('_meta_error')}

    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs},
                       'currentUser': {'email': 'daily-cron@auto'}})
    return {'ok': True, 'projectId': pid, 'month': month,
            'platforms': [c.get('platform') for c in (sc.get('platforms') or [])],
            'meta_error': sc.get('_meta_error')}


def _cron_apify_scorecard(proj, month):
    """Run the Apify pipeline synchronously (start → wait → finalize) and return
    the computed scorecard, or {} when the project has no live (scrapable)
    platforms or the scrape yields nothing."""
    handles = proj.get('handles') or {}
    live = [p for p in (proj.get('platforms') or [])
            if p in ACTORS and (handles.get(p) or '').strip()]
    if not live or not APIFY_TOKEN:
        return {}
    try:
        started = handle_start({
            'brand_name':  proj.get('brand') or proj.get('name') or 'brand',
            'domain':      proj.get('domain') or '',
            'location':    proj.get('location') or 'Singapore',
            'platforms':   live,
            'handles':     handles,
            'competitors': proj.get('competitors') or [],
            '_no_cache':   True,
        })
    except Exception:
        return {}
    job_id = started.get('jobId')
    if not job_id:
        return {}
    item = _jobs().get_item(Key={'jobId': job_id}).get('Item') or {}
    live_ids = _all_live_ids(item.get('runs') or {}, item.get('comp_runs') or [])
    deadline = time.time() + CRON_MAX_WAIT_SECS
    while live_ids and time.time() < deadline:
        statuses = {rid: _apify_status(rid) for rid in live_ids}
        if all(s in TERMINAL for s in statuses.values()):
            break
        time.sleep(15)
    # Build the scorecard inline (cron has the full Lambda budget — no need for
    # the async self-invoke the UI poll path uses).
    handle_finalize({'jobId': job_id})
    job = _jobs().get_item(Key={'jobId': job_id}).get('Item') or {}
    if job.get('scorecard'):
        try: return json.loads(job['scorecard'])
        except ValueError: return {}
    return {}


def _merge_meta_platforms(sc, meta_platforms):
    """Overlay Meta's private metrics onto the scorecard. For a platform already
    present (Apify-scraped IG/FB), the private fields are merged in at the field
    level so the post grid + public counts from Apify are preserved."""
    sc = sc or {}
    if not meta_platforms:
        return sc
    cards = sc.setdefault('platforms', [])
    by = {c.get('platform'): c for c in cards}
    for mp in meta_platforms:
        plat = mp.get('platform')
        if not plat:
            continue
        if plat in by:
            for k, v in mp.items():
                if k in ('platform', 'posts') or v is None:
                    continue
                by[plat][k] = v
        else:
            cards.append(mp)
    return sc


# ── KPI roll-up (mirrors kpisFromScorecard in index.html) ───────────────────
def _is_num(v):
    if v is None or v == '':
        return False
    try:
        float(v); return True
    except (TypeError, ValueError):
        return False


def _kpis_from_scorecard(sc):
    plats = [p for p in (sc.get('platforms') or []) if p and p.get('found') is not False]
    def _vals(f):
        return [float(p[f]) for p in plats if _is_num(p.get(f))]
    def _sum(f):  return sum(_vals(f))
    def _avg(f):
        v = _vals(f)
        return round(sum(v) / len(v), 2) if v else None
    out = {
        'platforms': len(plats),
        'per_platform': {p.get('platform'): {
            'followers': int(float(p['followers'])) if _is_num(p.get('followers')) else 0,
            'engagement_rate': p.get('engagement_rate')} for p in plats},
    }
    for k, agg in METRIC_AGG.items():
        if not any(_is_num(p.get(k)) for p in plats):
            out[k] = None
            continue
        v = _avg(k) if agg == 'avg' else _sum(k)
        if k == 'posts_per_week' and v is not None: v = round(float(v), 1)
        if k == 'avg_likes' and v is not None:      v = round(v)
        out[k] = v
    out['followers_growth_30d'] = _sum('followers_growth_30d') or None
    return out


# ── Meta (Instagram + Facebook) Graph insights — server-side mirror of the
#    browser connector in index.html (srResolveMeta / srIg/FbInsights). ───────
def _meta_get(path, params=None):
    params = dict(params or {})
    params.setdefault('access_token', META_ACCESS_TOKEN)
    r = requests.get(META_API + path, params=params, timeout=25)
    j = r.json()
    if isinstance(j, dict) and j.get('error'):
        raise RuntimeError((j['error'] or {}).get('message', 'Graph API error'))
    return j


def _meta_norm(h):
    s = str(h or '').strip().lower().lstrip('@')
    s = re.sub(r'^https?://(www\.)?(facebook|instagram)\.com/', '', s)
    return re.sub(r'/.*$', '', s)


def _meta_month_range(month):
    y, m = (int(x) for x in month.split('-'))
    since = int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp())
    nm    = datetime(y + (m == 12), (m % 12) + 1, 1, tzinfo=timezone.utc)
    until = min(int(nm.timestamp()), int(time.time()))
    if until <= since:                 # very first moment of the month
        until = since + 86400
    return since, until


def _meta_pages(token):
    pages, seen = [], set()
    def add(ps):
        for p in (ps or []):
            if p and p.get('id') and p['id'] not in seen:
                seen.add(p['id']); pages.append(p)
    F = 'id,name,username,access_token,instagram_business_account{id,username}'
    try: add(_meta_get('/me/accounts', {'fields': F, 'limit': 200, 'access_token': token}).get('data'))
    except Exception: pass
    if not pages:    # agency model: client pages live under Business Manager
        bizes = []
        try: bizes = _meta_get('/me/businesses', {'fields': 'id,name', 'limit': 50, 'access_token': token}).get('data') or []
        except Exception: pass
        for biz in bizes:
            for edge in ('owned_pages', 'client_pages'):
                try: add(_meta_get('/' + biz['id'] + '/' + edge, {'fields': F, 'limit': 200, 'access_token': token}).get('data'))
                except Exception: pass
    return pages


def _meta_resolve(proj, token):
    pages = _meta_pages(token)
    if not pages:
        raise RuntimeError('No Pages visible to the Meta token (needs pages_show_list + '
                           'read_insights + instagram_manage_insights and the client Pages assigned).')
    handles = proj.get('handles') or {}
    fb, ig = _meta_norm(handles.get('facebook')), _meta_norm(handles.get('instagram'))
    page = None
    if fb:
        page = next((p for p in pages if _meta_norm(p.get('username')) == fb
                     or _meta_norm(p.get('name')) == fb), None)
    if not page and ig:
        page = next((p for p in pages if _meta_norm((p.get('instagram_business_account') or {}).get('username')) == ig), None)
    if not page and len(pages) == 1:
        page = pages[0]
    if not page:
        return None
    iba = page.get('instagram_business_account') or {}
    return {'pageId': page['id'], 'pageToken': page.get('access_token') or token,
            'pageName': page.get('name'), 'igId': iba.get('id'), 'igName': iba.get('username')}


def _meta_sum_metric(node_id, metric, token, since, until, opts=None):
    try:
        params = {'metric': metric, 'period': 'day', 'since': since, 'until': until, 'access_token': token}
        if opts: params.update(opts)
        rows = (_meta_get('/' + node_id + '/insights', params).get('data') or [])
        if not rows:
            return None
        row = rows[0]
        if row.get('total_value'):
            return _num((row['total_value'] or {}).get('value'))
        vals = row.get('values') or []
        if not vals:
            return None
        return sum(_num(v.get('value')) or 0 for v in vals)
    except Exception:
        return None


def _meta_fb_insights(page_id, token, since, until):
    out = {}
    def s(k, v):
        if v is not None: out[k] = v
    s('impressions',   _meta_sum_metric(page_id, 'page_impressions', token, since, until))
    reach = _meta_sum_metric(page_id, 'page_impressions_unique', token, since, until)
    s('reach', reach); s('page_reach', reach); s('daily_reach', reach)
    s('engagements',   _meta_sum_metric(page_id, 'page_post_engagements', token, since, until))
    s('profile_views', _meta_sum_metric(page_id, 'page_views_total', token, since, until))
    s('reactions',     _meta_sum_metric(page_id, 'page_actions_post_reactions_total', token, since, until))
    adds = _meta_sum_metric(page_id, 'page_fan_adds', token, since, until)
    rem  = _meta_sum_metric(page_id, 'page_fan_removes', token, since, until)
    s('followers_increase', adds); s('followers_decrease', rem)
    if adds is not None or rem is not None:
        s('net_new_followers', (adds or 0) - (rem or 0))
    try:
        p = _meta_get('/' + page_id, {'fields': 'followers_count,fan_count', 'access_token': token})
        s('followers', p.get('followers_count') if p.get('followers_count') is not None else p.get('fan_count'))
        s('page_likes', p.get('fan_count'))
    except Exception:
        pass
    return out


def _meta_ig_insights(ig_id, token, since, until):
    out = {}
    def s(k, v):
        if v is not None: out[k] = v
    tv = {'metric_type': 'total_value'}
    s('reach',                _meta_sum_metric(ig_id, 'reach', token, since, until))
    s('profile_views',        _meta_sum_metric(ig_id, 'profile_views', token, since, until))
    s('impressions',          _meta_sum_metric(ig_id, 'views', token, since, until, tv))
    s('engaged_users_daily',  _meta_sum_metric(ig_id, 'accounts_engaged', token, since, until, tv))
    s('engagements',          _meta_sum_metric(ig_id, 'total_interactions', token, since, until, tv))
    s('likes',                _meta_sum_metric(ig_id, 'likes', token, since, until, tv))
    s('comments',             _meta_sum_metric(ig_id, 'comments', token, since, until, tv))
    s('shares',               _meta_sum_metric(ig_id, 'shares', token, since, until, tv))
    s('saves',                _meta_sum_metric(ig_id, 'saves', token, since, until, tv))
    s('profile_cta_clicks',   _meta_sum_metric(ig_id, 'profile_links_taps', token, since, until, tv))
    try:
        p = _meta_get('/' + ig_id, {'fields': 'followers_count', 'access_token': token})
        s('followers', p.get('followers_count'))
    except Exception:
        pass
    return out


def _cron_meta_platforms(proj, month):
    """Pull this project's private IG/FB insights for the month, gated to the
    platforms the project actually tracks. Returns [] when no Meta token is set,
    no FB/IG handle exists, or the page can't be resolved."""
    if not META_ACCESS_TOKEN:
        return []
    handles = proj.get('handles') or {}
    plats   = set(proj.get('platforms') or [])
    want_fb = ('facebook'  in plats) or bool(handles.get('facebook'))
    want_ig = ('instagram' in plats) or bool(handles.get('instagram'))
    if not (want_fb or want_ig):
        return []
    meta = _meta_resolve(proj, META_ACCESS_TOKEN)
    if not meta:
        return []
    since, until = _meta_month_range(month)
    out = []
    if want_ig and meta.get('igId'):
        ig = _meta_ig_insights(meta['igId'], meta['pageToken'], since, until)
        if ig:
            out.append(dict(platform='instagram', found=True, **ig))
    if want_fb and meta.get('pageId'):
        fb = _meta_fb_insights(meta['pageId'], meta['pageToken'], since, until)
        if fb:
            out.append(dict(platform='facebook', found=True, **fb))
    return out


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


def _parse_followers(v):
    """LinkedIn's company-posts actor reports followers as a string on the
    author, e.g. '509 followers' or '1.2K followers'. Pull the leading count."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v)
    m = re.search(r'([\d.,]+\s*[KMB]?)\s*follower', str(v), re.I)
    return _num(m.group(1).replace(' ', '')) if m else _num(v)


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
