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

import html as html_lib
import json
import os
import re
import time
import uuid
import base64
import hashlib
import statistics
from decimal import Decimal
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from urllib.parse import quote, urlencode

import requests

# ── LLM usage metering (CloudWatch EMF) — Digimetrics/LLM ─────────────────────
# Meters every Claude/DeepSeek/OpenAI call by transparently wrapping
# requests.post ONCE — all call sites report RAW token buckets (input, output,
# cache read/write, web-search requests) into Digimetrics/LLM (dims Provider,
# Provider+Model). Cost is derived at READ time from one central table, so no
# rates live here (nothing to go stale). Mirrors saas/backend/src/lib/
# llm-metric.mjs. Logs only; safe by construction — the real call runs first and
# is returned regardless of metering.
import json as _mllm_json
import time as _mllm_time
_LLM_FN = 'socialMediaAudit'
_LLM_SOURCE = 'unknown'
_LLM_TOOL = ''


def _set_llm_source(event):
    """Tag this invocation with the front-end that triggered it (saas | index).
    Read from the request body's `_source` (a body field, NOT a header — a custom
    header would force a CORS preflight on every agency Lambda). Lambda handles
    one event at a time per container, so a module global is safe here."""
    global _LLM_SOURCE, _LLM_TOOL
    src = ''
    tool = ''
    try:
        if isinstance(event, dict):
            body = event.get('body')
            if isinstance(body, str):
                try:
                    body = _mllm_json.loads(body or '{}')
                except Exception:
                    body = {}
            if not isinstance(body, dict):
                body = {}
            src = body.get('_source') or event.get('_source') or ''
            tool = body.get('_tool') or event.get('_tool') or ''
        src = str(src).strip().lower()
        tool = str(tool).strip()[:64]
    except Exception:
        src = ''
        tool = ''
    # Anything unrecognised stays 'unknown' so unattributed spend stays visible.
    _LLM_SOURCE = src if src in ('saas', 'index') else 'unknown'
    _LLM_TOOL = tool


def _llm_provider(model, url=''):
    m = (model or '').lower()
    u = url or ''
    if 'deepseek' in m or 'deepseek' in u:
        return 'deepseek'
    if 'openai' in u or m.startswith('gpt') or m.startswith('o1') or m.startswith('o3'):
        return 'openai'
    if 'claude' in m or 'anthropic' in u:
        return 'claude'
    return 'other'


def _llm_buckets(body, url=''):
    """(provider, model, {in,out,cr,cw,ws}) from an Anthropic/OpenAI/DeepSeek body."""
    u = (body.get('usage') or {}) if isinstance(body, dict) else {}
    model = body.get('model') if isinstance(body, dict) else None
    prov = _llm_provider(model, url)
    if 'input_tokens' in u or 'output_tokens' in u:            # Anthropic shape
        stu = u.get('server_tool_use') or {}
        return prov, model, {'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
                             'cr': u.get('cache_read_input_tokens', 0),
                             'cw': u.get('cache_creation_input_tokens', 0),
                             'ws': stu.get('web_search_requests', 0)}
    out = u.get('completion_tokens', 0)                        # OpenAI / DeepSeek
    if 'prompt_cache_hit_tokens' in u or 'prompt_cache_miss_tokens' in u:   # DeepSeek
        cr = u.get('prompt_cache_hit_tokens', 0)
        inp = u.get('prompt_cache_miss_tokens', (u.get('prompt_tokens', 0) - cr))
    else:                                                      # OpenAI
        cr = (u.get('prompt_tokens_details') or {}).get('cached_tokens', 0)
        inp = u.get('prompt_tokens', 0) - cr
    return prov, model, {'in': max(0, inp), 'out': out, 'cr': cr, 'cw': 0, 'ws': 0}


def _emit_llm_metric(provider, model, b, fn=None):
    try:
        print(_mllm_json.dumps({'_aws': {'Timestamp': int(_mllm_time.time() * 1000), 'CloudWatchMetrics': [{'Namespace': 'Digimetrics/LLM', 'Dimensions': [['Provider'], ['Provider', 'Model'], ['Source'], ['Source', 'Provider']], 'Metrics': [{'Name': 'Calls', 'Unit': 'Count'}, {'Name': 'InputTokens', 'Unit': 'Count'}, {'Name': 'OutputTokens', 'Unit': 'Count'}, {'Name': 'CacheReadTokens', 'Unit': 'Count'}, {'Name': 'CacheWriteTokens', 'Unit': 'Count'}, {'Name': 'WebSearchRequests', 'Unit': 'Count'}]}]}, 'Provider': provider, 'Model': model or 'unknown', 'Source': _LLM_SOURCE, 'fn': fn or _LLM_FN, 'tool': _LLM_TOOL, 'Calls': 1, 'InputTokens': int(b.get('in', 0) or 0), 'OutputTokens': int(b.get('out', 0) or 0), 'CacheReadTokens': int(b.get('cr', 0) or 0), 'CacheWriteTokens': int(b.get('cw', 0) or 0), 'WebSearchRequests': int(b.get('ws', 0) or 0)}))
    except Exception:
        pass


def _emit_llm_from_body(provider, body):
    try:
        if not isinstance(body, dict):
            return
        prov, model, b = _llm_buckets(body)
        if any(b.values()):
            _emit_llm_metric(provider or prov, model, b)
    except Exception:
        pass


_LLM_HOSTS = ('api.anthropic.com', 'api.deepseek.com', 'api.openai.com')
try:
    _orig_requests_post = requests.post

    def _metered_requests_post(*a, **kw):
        resp = _orig_requests_post(*a, **kw)
        try:
            url = a[0] if a else kw.get('url', '')
            if isinstance(url, str) and any(h in url for h in _LLM_HOSTS) and not kw.get('stream'):
                try:
                    _body = resp.json()
                except Exception:
                    _body = None
                if isinstance(_body, dict):
                    _prov, _model, _b = _llm_buckets(_body, url)
                    if any(_b.values()):
                        _emit_llm_metric(_prov, _model, _b)
        except Exception:
            pass
        return resp

    requests.post = _metered_requests_post
except Exception:
    pass
# ── end LLM usage metering ────────────────────────────────────────────────────

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
REPORT_DAYS_TABLE     = os.environ.get('REPORT_DAYS_TABLE', 'social_report_days')
# Social Listening Report — standalone module, separate billing/offering from
# Monthly Social Reports though it shares this Lambda + fetch_social_listening().
#   sl_clients    PK: clientId (S)                      — one listening client.
#   sl_topics     PK: clientId (S), SK: topicId (S)      — a tracked keyword query.
#   sl_snapshots  PK: topicId (S),  SK: date (S "YYYY-MM-DD") — one daily pull.
SL_CLIENTS_TABLE   = os.environ.get('SL_CLIENTS_TABLE', 'sl_clients')
SL_TOPICS_TABLE    = os.environ.get('SL_TOPICS_TABLE', 'sl_topics')
SL_SNAPSHOTS_TABLE = os.environ.get('SL_SNAPSHOTS_TABLE', 'sl_snapshots')
# Post thumbnails — every platform hands out SIGNED, EXPIRING CDN URLs
# (scontent-*.cdninstagram.com / *.fbcdn.net carry an `oe` expiry ~30 days out;
# TikTok cover_image_url the same). Storing them verbatim means the whole post
# grid goes blank a few weeks after capture — verified on Homi 2026-07-20:
# 90/90 stored thumbnails returned 403. So mirror the bytes into S3 once at save
# time and persist THAT url instead. Public-read, prefix-scoped; the images are
# already public on the source platform.
THUMB_BUCKET = os.environ.get('SR_THUMB_BUCKET', 'digimetricsfileupload')
THUMB_PREFIX = os.environ.get('SR_THUMB_PREFIX', 'social-thumbs/')
# Post permalinks are served the share-preview markup only to something that
# looks like a browser; a bare library UA gets a login wall instead.
_BROWSER_UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
               '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
# Competitor scrapes are billed per Apify run, so they're capped — but PER
# PLATFORM, not in total (each platform is benchmarked separately, so a flat
# total cap starves every platform after the first).
COMPETITORS_PER_PLATFORM = int(os.environ.get('SR_COMPETITORS_PER_PLATFORM', '4'))
HAIKU_MODEL  = 'claude-haiku-4-5-20251001'
# Vision-capable model for the content/creative audit (visual style + theme).
# Sonnet reasons over imagery noticeably better than Haiku; it runs once per
# audit so the extra cost is bounded.
VISION_MODEL = os.environ.get('SMA_VISION_MODEL', 'claude-sonnet-4-6')
MAX_CREATIVE_IMAGES   = 21    # images fetched + sent to the vision model (brand)
MAX_CREATIVE_IMAGES_COMP = 12 # fewer per competitor — keeps the concurrent calls fast
MAX_CREATIVE_CAPTIONS = 21    # captions sent as text context
# Qualitative competitor profiles (who they are + what they talk about). One
# call per competitor BRAND, not per platform, so the cap counts brands.
MAX_COMPETITOR_PROFILES = int(os.environ.get('SR_COMPETITOR_PROFILES', '6'))
MAX_PROFILE_CAPTIONS    = 12  # captions per platform fed into the profile call
JOB_TTL_SECS   = 6 * 3600
# Don't let one slow/stuck scraper gate the whole audit: once we've waited this
# long and at least one source is ready, finalize with whatever completed (the
# missing sources contribute empty cards, exactly as a FAILED run would).
SOURCE_DEADLINE_SECS = 100
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
# Business-type apps use "Facebook Login for Business": the consent dialog takes a
# config_id (permissions live in the dashboard configuration) instead of scope=.
META_OAUTH_CONFIG_ID     = os.environ.get('META_OAUTH_CONFIG_ID', '')
LINKEDIN_OAUTH_CLIENT_ID     = os.environ.get('LINKEDIN_OAUTH_CLIENT_ID', '')
LINKEDIN_OAUTH_CLIENT_SECRET = os.environ.get('LINKEDIN_OAUTH_CLIENT_SECRET', '')
LINKEDIN_OAUTH_SCOPES        = os.environ.get('LINKEDIN_OAUTH_SCOPES',
    # Community Management API: rw_organization_admin → page/follower/share
    # reporting; r_organization_social → read org posts (for the post grid).
    'rw_organization_admin r_organization_social')
LINKEDIN_API         = 'https://api.linkedin.com/rest'
# LinkedIn versions the REST API monthly (YYYYMM) and sunsets versions after ~12
# months — bump LINKEDIN_API_VERSION via env when the current default expires.
LINKEDIN_API_VERSION = os.environ.get('LINKEDIN_API_VERSION', '202606')
TIKTOK_OAUTH_CLIENT_ID     = os.environ.get('TIKTOK_OAUTH_CLIENT_ID', '')        # TikTok "client key"
TIKTOK_OAUTH_CLIENT_SECRET = os.environ.get('TIKTOK_OAUTH_CLIENT_SECRET', '')
TIKTOK_OAUTH_SCOPES        = os.environ.get('TIKTOK_OAUTH_SCOPES',
    'user.info.basic,user.info.profile,user.info.stats,video.list')
TIKTOK_API           = 'https://open.tiktokapis.com/v2'
GOOGLE_OAUTH_CLIENT_ID     = os.environ.get('GOOGLE_OAUTH_CLIENT_ID', '')        # YouTube "web" client id
# YouTube moved from in-browser GIS (1-hour token, no refresh) to a server-side
# offline code flow so the daily cron + walk-back backfill can pull unattended,
# exactly like Meta/LinkedIn. The exchange needs the app SECRET (server-only) and
# access_type=offline to get a refresh_token; the analytics scope unlocks the
# time-windowed YouTube Analytics API (plain youtube.readonly can't do history).
GOOGLE_OAUTH_CLIENT_SECRET = os.environ.get('GOOGLE_OAUTH_CLIENT_SECRET', '')
GOOGLE_OAUTH_SCOPES        = os.environ.get('GOOGLE_OAUTH_SCOPES',
    'https://www.googleapis.com/auth/youtube.readonly '
    'https://www.googleapis.com/auth/yt-analytics.readonly')
YOUTUBE_DATA_API     = 'https://www.googleapis.com/youtube/v3'
YOUTUBE_ANALYTICS_API = 'https://youtubeanalytics.googleapis.com/v2/reports'
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
    # Organic / paid splits — the same roll-up kind as the metric they split.
    'organic_page_views':'sum','paid_page_views':'sum',
    'organic_engagement_rate':'avg','paid_engagement_rate':'avg',
    'view_through_rate':'avg','organic_view_through_rate':'avg','paid_view_through_rate':'avg',
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
    # X/Twitter intentionally left out: apidojo~tweet-scraper is pay-per-result and
    # returns data only on a PAID Apify plan (free plan → {"noResults":true} rows).
    # The extraction plumbing (_build_input/_extract `author` profile/_to_epoch
    # Twitter-date parsing) is kept inert; to re-enable, uncomment the line below
    # AND restore the 'twitter' entry in PLATS in index.html.
    # 'twitter':   'apidojo~tweet-scraper',
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
        if action == 'report_fix_thumbs':
            return _resp(200, report_fix_thumbs(body))
        if action == 'report_backfill_splits':
            return _resp(200, report_backfill_splits(body))
        if action == 'report_save_recs':
            return _resp(200, report_save_recs(body))
        if action == 'report_backfill_platform_kpis':
            return _resp(200, report_backfill_platform_kpis(body))
        if action == 'report_daily_series':
            return _resp(200, report_daily_series(body))
        if action == 'report_backfill_meta':
            return _resp(200, report_backfill_meta(body))
        if action == 'report_backfill_linkedin':
            return _resp(200, report_backfill_linkedin(body))
        if action == 'report_backfill_youtube':
            return _resp(200, report_backfill_youtube(body))
        if action == 'report_backfill_tiktok':
            return _resp(200, report_backfill_tiktok(body))
        if action == 'report_native_preview':
            return _resp(200, report_native_preview(body))
        if action == 'report_refresh_audience':
            return _resp(200, report_refresh_audience(body))
        if action == 'report_connections_health':
            return _resp(200, report_connections_health(body))
        if action == 'report_connections_audit':
            return _resp(200, report_connections_audit(body))
        if action == 'cron_refresh_audience_all':
            return _resp(200, cron_refresh_audience_all(body))
        if action == 'cron_refresh_audience_one':
            return _resp(200, cron_refresh_audience_one(body))
        if action == 'meta_pages':
            return _resp(200, meta_pages(body))
        if action == 'report_delete_month':
            return _resp(200, report_delete_month(body))
        if action == 'report_save_tags':
            return _resp(200, report_save_tags(body))
        if action == 'report_recommend':
            return _resp(200, report_recommend(body))
        if action == 'report_extract_pdf':
            return _resp(200, report_extract_pdf(body))
        # ── Social Listening Report: standalone clients/topics/snapshots ─────
        if action == 'sl_countries':
            return _resp(200, sl_countries(body))
        if action == 'sl_list_clients':
            return _resp(200, sl_list_clients(body))
        if action == 'sl_save_client':
            return _resp(200, sl_save_client(body))
        if action == 'sl_delete_client':
            return _resp(200, sl_delete_client(body))
        if action == 'sl_list_topics':
            return _resp(200, sl_list_topics(body))
        if action == 'sl_save_topic':
            return _resp(200, sl_save_topic(body))
        if action == 'sl_delete_topic':
            return _resp(200, sl_delete_topic(body))
        if action == 'sl_pull_topic':
            return _resp(200, sl_pull_topic(body))
        if action == 'sl_pull_status':
            return _resp(200, sl_pull_status(body))
        if action == 'sl_get_topic_report':
            return _resp(200, sl_get_topic_report(body))
        if action == 'sl_cron_snapshot_all':
            return _resp(200, sl_cron_snapshot_all(body))
        if action == 'sl_cron_snapshot_one':
            return _resp(200, sl_cron_snapshot_one(body))
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
    # Split cached (instant) from to-scrape, then launch every non-cached client
    # scrape concurrently — each _start_platform is a network POST to Apify, so
    # serial launches added seconds of dead time before polling could even begin.
    to_start = []
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
        to_start.append((p, handle))
    if to_start:
        with ThreadPoolExecutor(max_workers=min(8, len(to_start))) as ex:
            launched = list(ex.map(lambda ph: (ph[0], ph[1], _start_platform(ph[0], ph[1])), to_start))
        for p, handle, entry in launched:
            if entry:
                runs[p] = {'handle': handle, 'role': 'client', **entry}

    # Competitors run the same actors (capped to keep cost predictable) — launched
    # concurrently for the same reason. The cap is PER PLATFORM, matching the
    # frontend's competitor form: a flat [:3] slice silently dropped every
    # competitor after the third overall, so a client tracking 3 competitors on
    # Facebook never got their Instagram or LinkedIn set captured at all.
    comp_runs = []
    comp_to_start = []
    _comp_seen = {}
    for c in competitors:
        _cp = (c.get('platform') or '').strip()
        _comp_seen[_cp] = _comp_seen.get(_cp, 0) + 1
        if _comp_seen[_cp] > COMPETITORS_PER_PLATFORM:
            continue
        p = _cp
        handle = (c.get('handle') or '').strip()
        actor = ACTORS.get(p)
        if not (p and handle and actor):
            continue
        name = c.get('name') or handle
        if not no_cache and _cache_get(p, handle) is not None:
            comp_runs.append({'platform': p, 'handle': handle, 'name': name, 'cached': True})
            cached_n += 1
            continue
        comp_to_start.append((p, handle, name))
    if comp_to_start:
        with ThreadPoolExecutor(max_workers=min(8, len(comp_to_start))) as ex:
            launched = list(ex.map(lambda x: (x[0], x[1], x[2], _start_platform(x[0], x[1])), comp_to_start))
        for p, handle, name, entry in launched:
            if entry:
                comp_runs.append({'platform': p, 'handle': handle, 'name': name, **entry})

    # Optional: tie this audit to a connected Monthly-Social-Reports client so
    # finalize can overlay that client's first-party API metrics (reach,
    # impressions, engagements, follower growth, audience demographics). When a
    # connected client is supplied the job is valid even with no scraped handles.
    native_pid   = (body.get('projectId') or '').strip()
    native_month = (body.get('native_month') or '').strip()

    if not runs and not comp_runs and not native_pid:
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
        'native_project': native_pid,
        'native_month': native_month,
        'created': _now_iso(),
        'created_ts': int(time.time()),   # numeric — drives the source deadline in poll
        'ttl': int(time.time()) + JOB_TTL_SECS,
    })

    return {'jobId': job_id, 'platforms': list(runs.keys()),
            'competitors': len(comp_runs), 'cached': cached_n,
            'native_project': native_pid}


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
    statuses = _statuses(live_ids)          # concurrent — was serial per run id
    done = sum(1 for s in statuses.values() if s in TERMINAL)
    total = len(live_ids)

    # Progressive preview: extract a lightweight card for each client platform as
    # soon as its scrape lands, so the UI can render real numbers before the
    # (cross-source) AI synthesis in finalize completes.
    partials, ready, changed = _collect_partials(item, runs, statuses)
    if changed:
        # Stored as a JSON string (like the scorecard) — the cards carry floats
        # (engagement_rate, posts_per_week) and DynamoDB maps reject raw floats.
        _jobs().update_item(
            Key={'jobId': job_id},
            UpdateExpression='SET partials = :p, partials_ready = :r',
            ExpressionAttributeValues={':p': json.dumps(partials, default=str), ':r': list(ready)})
    partial_list = list(partials.values())

    # Source deadline — don't wait on the slowest scraper forever.
    created_ts = int(item.get('created_ts') or 0)
    past_deadline = (created_ts
                     and (int(time.time()) - created_ts) > SOURCE_DEADLINE_SECS
                     and done >= 1)

    if total and done < total and not past_deadline:
        return {'status': 'running', 'progress': {'done': done, 'total': total},
                'partials': partial_list}

    # All runs terminal (or past the deadline) → start the async finalize once.
    if not item.get('finalize_started'):
        _jobs().update_item(Key={'jobId': job_id},
                            UpdateExpression='SET finalize_started = :t',
                            ExpressionAttributeValues={':t': int(time.time())})
        _self_invoke({'action': 'finalize', 'jobId': job_id})
    return {'status': 'finalizing', 'progress': {'done': done, 'total': total},
            'partials': partial_list}


def _statuses(run_ids):
    """Fetch many Apify run statuses concurrently. Serial GETs made both poll and
    finalize scale linearly with the number of sources."""
    ids = list(run_ids)
    if not ids:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(ids))) as ex:
        res = list(ex.map(_apify_status, ids))
    return dict(zip(ids, res))


def _lite_card(platform, m):
    """A _platform_card with the heavy per-post array stripped — small enough to
    store on the job item and stream back in every poll response."""
    card = _platform_card(platform, m)
    card.pop('posts', None)
    return card


def _collect_partials(item, runs, statuses):
    """Build/extend the per-platform preview cards for client runs whose scrape
    has finished. Each platform is processed once (tracked in partials_ready).
    Returns (partials_dict, ready_ids_set, changed)."""
    _raw = item.get('partials')
    partials = (json.loads(_raw) if isinstance(_raw, str) else dict(_raw or {}))
    ready    = set(item.get('partials_ready') or [])
    changed  = False
    for p, r in runs.items():
        if p in partials:
            continue
        if r.get('cached'):                       # fresh cache → ready immediately
            m = dict(_cache_get(p, r.get('handle')) or {})
            m['handle'] = r.get('handle'); m['found'] = bool(m)
            partials[p] = _lite_card(p, m); changed = True
            continue
        rid = r.get('run_id')
        if not rid or statuses.get(rid) not in TERMINAL:
            continue                              # primary run not done yet
        ok = statuses.get(rid) == 'SUCCEEDED'
        items = _apify_items(r.get('dataset_id')) if ok else []
        post_items = []
        if r.get('posts_dataset_id') and statuses.get(r.get('posts_run_id')) == 'SUCCEEDED':
            post_items = _apify_items(r.get('posts_dataset_id'))
        m = _extract(p, items, post_items)
        m['handle'] = r.get('handle'); m['found'] = bool(items or post_items)
        partials[p] = _lite_card(p, m)
        ready.add(rid); changed = True
    return partials, ready, changed


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
        statuses = _statuses(live_ids)          # concurrent — was serial per run id

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

        # ── First-party enrichment ───────────────────────────────────────────
        # If this audit was tied to a connected Monthly-Social-Reports client,
        # overlay that client's private API metrics onto the scraped cards.
        # Platforms without a live connection keep their public Apify data; a
        # platform connected but never scraped gets a card built from native data.
        native_sources, native_errors, native_month = [], {}, ''
        native_pid = item.get('native_project') or ''
        if native_pid:
            try:
                proj = _rprojects().get_item(Key={'projectId': native_pid}).get('Item')
                if proj:
                    proj = _dec(proj)
                    native_month = (item.get('native_month') or '').strip() or _current_month()
                    native_cards, native_errors = _native_cards_for_month(proj, native_month)
                    for nc in native_cards:
                        np = nc.get('platform')
                        if not np:
                            continue
                        had_apify = bool((client_metrics.get(np) or {}).get('found'))
                        base = client_metrics.get(np) or {'handle': (proj.get('handles') or {}).get(np)}
                        _overlay_native(base, nc, had_apify)
                        base['found'] = True
                        base['data_source'] = 'connected'
                        client_metrics[np] = base
                        native_sources.append(np)
            except Exception as e:
                native_errors['_'] = str(e)[:200]

        competitor_metrics = []
        comp_creative_jobs = []   # (entry, name, platform, full_metrics) for creative eval
        comp_profile_src   = {}   # brand name -> [(platform, full_metrics)] for the profile
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
            if src != 'empty' and (m.get('captions') or m.get('bio')):
                comp_profile_src.setdefault(
                    c.get('name') or c.get('handle') or 'Competitor', []).append((c['platform'], m))

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
            sent_fut  = ex.submit(_content_sentiment, brand, client_metrics)
            comp_futs = [(entry, ex.submit(_analyze_creative, name, {plat: cm}, '',
                                           MAX_CREATIVE_IMAGES_COMP))
                         for (entry, name, plat, cm) in comp_creative_jobs]
            prof_futs = [ex.submit(_analyze_competitor_profile, nm, srcs, _loc)
                         for nm, srcs in list(comp_profile_src.items())[:MAX_COMPETITOR_PROFILES]]
            creative = brand_fut.result()
            for entry, fut in comp_futs:
                try:
                    entry['creative'] = fut.result()
                except Exception:
                    entry['creative'] = None
            competitor_profiles = []
            for fut in prof_futs:
                try:
                    prof = fut.result()
                except Exception:
                    prof = None
                if prof:
                    competitor_profiles.append(prof)
            content_sentiment = sent_fut.result()

        # Benchmark block (Share of Voice / format mix / word cloud / sentiment).
        benchmark = _compute_benchmark(brand, client_metrics, competitor_metrics)
        if content_sentiment:
            benchmark['content_sentiment'] = content_sentiment

        scorecard    = _narrate(brand, client_metrics, competitor_metrics, brand_health,
                                indicators, extra_ctx, creative=creative,
                                competitor_profiles=competitor_profiles)
        scorecard.update({
            'platforms': [_platform_card(p, m) for p, m in client_metrics.items()],
            'indicators': indicators,
            'brand_health': brand_health,
            'social_listening': social_listening,
            'creative': creative,
            'benchmark': benchmark,
            'competitors': [c for c in competitor_metrics if c.get('followers') is not None],
            'competitor_profiles': competitor_profiles,
            'native_sources': native_sources,
            'native_month': native_month if native_pid else '',
        })
        if native_errors:
            scorecard['native_errors'] = native_errors
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
        if not isinstance(data, list):
            return []
        # Some actors emit control/marker rows instead of data — notably apidojo's
        # tweet-scraper returns `{"noResults": true}` placeholder rows (e.g. when
        # the Apify account is on the free plan and the paid actor is gated).
        # Drop them so an empty scrape reads as "no data" (found=False) rather than
        # a card full of blank posts.
        return [it for it in data
                if not (isinstance(it, dict) and (it.get('noResults') or it.get('noResult')))]
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
    if platform == 'twitter':
        # accept a bare @handle, a handle, or a full profile URL → bare handle.
        if user.startswith('http'):
            user = user.rstrip('/').split('/')[-1]
        return {'twitterHandles': [user], 'maxItems': 24, 'sort': 'Latest'}
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

    # TikTok nests the profile under `authorMeta`; X/Twitter under `author`.
    prof = (head.get('authorMeta') if isinstance(head.get('authorMeta'), dict)
            else head.get('author') if isinstance(head.get('author'), dict) else head)

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
    pfp       = _g(prof, 'profilePicUrl', 'channelAvatarUrl', 'profilePicture', 'avatar',
                   'profileImage', 'originalAvatarUrl', 'thumbnailUrl', default='')

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
            # Image priority: video thumb → inline post image → document/carousel
            # cover page. Text-only & link posts carry none → '' (grid placeholder).
            image = ''
            if is_video:
                image = pv.get('thumbnailUrl') or ''
            if not image and imgs and isinstance(imgs[0], dict):
                image = imgs[0].get('url') or ''
            if not image:
                cover = (((p.get('document') or {}).get('coverPages') or [{}])[0]).get('imageUrls') or []
                image = (cover[0] if cover else '') or ''
            typ = 'video' if is_video else ('carousel' if (p.get('document') or imgs and len(imgs) > 1) else 'image')
            out.append({
                'ts':       pa.get('timestamp') or pa.get('date'),
                'likes':    _num(eng.get('likes')),
                'comments': _num(eng.get('comments')),
                'shares':   _num(eng.get('shares')),
                'views':    None,
                'type':     typ,
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
            'ts':       _g(p, 'timestamp', 'createTime', 'publishedAt', 'date', 'taken_at', 'time', 'createdAt'),
            'likes':    likes,
            'comments': _num(_g(p, 'commentsCount', 'comments', 'commentCount', 'replyCount')),
            'shares':   _num(_g(p, 'sharesCount', 'shares', 'shareCount', 'reshareCount', 'repostCount', 'retweetCount', 'quoteCount')),
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


# Per-post metric fields carried through to the grid when a source provides them
# (owner-only insights like reach/interactions). Public scrapes omit these, so
# they stay optional rather than emitting null noise.
_GRID_POST_EXTRA = ('reach', 'impressions', 'interactions', 'reactions',
                    'reactions_by_type', 'shares', 'saves', 'interaction_rate',
                    'engagement_rate',
                    # Carries the platform's immutable post id through to the grid so
                    # tags/overrides key off it rather than a rotating permalink.
                    'post_id')


def _grid_post(p, followers=None):
    """Compact post for the visual grid: base display fields plus any per-post
    metric fields actually present on the source post.

    When no reach-based rate (interaction_rate) is available for a post — the
    common case, since public scrapes carry no reach and Meta's per-post reach
    is owner-only + short-lived — derive a follower-based engagement_rate from
    the public interaction counts so EVERY post shows a comparable %. Marked
    engagement_rate_basis='followers' so the client can label it accurately
    (vs. the reach-based interaction_rate, which always wins when present)."""
    out = {'image': p.get('image', ''), 'url': p.get('url', ''),
           'text': p.get('text', ''), 'type': p['type'],
           'likes': p['likes'], 'comments': p['comments'], 'views': p['views'],
           'ts': p.get('ts')}
    for k in _GRID_POST_EXTRA:
        v = p.get(k)
        if v is not None:
            out[k] = v
    if (followers and out.get('interaction_rate') is None
            and out.get('engagement_rate') is None):
        signals = [p.get(k) for k in ('likes', 'comments', 'shares', 'saves')]
        if any(v is not None for v in signals):
            eng = sum(v for v in signals if v is not None)
            rate = eng / followers * 100
            # A large page divides modest engagement by a huge follower base, so 2dp
            # collapses every post to 0.00%. Keep more places once the rate goes small.
            out['engagement_rate'] = round(rate, 2 if rate >= 1 else 4)
            out['engagement_rate_basis'] = 'followers'
    return out


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
            _grid_post(p, followers)
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
    'forums':  ('(site:forums.hardwarezone.com.sg OR site:sgtalk.org '
                'OR site:reddit.com/r/singapore)', 'Forums'),
    # Platforms Content Analysis doesn't index natively. Each expression is
    # parenthesised so it groups correctly when AND-ed with the term group —
    # without the parens Google mis-scopes the query to the first site only.
    'linkedin':  ('site:linkedin.com',              'LinkedIn'),
    'tumblr':    ('site:tumblr.com',                'Tumblr'),
    'youtube':   ('site:youtube.com',               'YouTube'),
    'facebook':  ('site:facebook.com',              'Facebook'),
    'instagram': ('site:instagram.com',             'Instagram'),
    'tiktok':    ('site:tiktok.com',                'TikTok'),
    'qq':        ('(site:qq.com OR site:zhihu.com OR site:weibo.com)',
                                                    'QQ & Chinese social'),
    'reviews':   ('(site:trustpilot.com OR site:g2.com OR site:yelp.com '
                  'OR site:tripadvisor.com OR site:glassdoor.com)',
                                                    'Review sites'),
    'news':      ('(site:straitstimes.com OR site:channelnewsasia.com '
                  'OR site:businesstimes.com.sg OR site:todayonline.com)',
                                                    'News'),
}

# ──────────────────────────────────────────────────────────────────────────────
# Social Listening Report — country scoping
# ──────────────────────────────────────────────────────────────────────────────
# The markets the Listening Report can be filtered to. `code` is the ISO country
# the DataForSEO `country` field carries on each item; `location` is the
# DataForSEO location_name the Google SERP layer needs (different vocabulary —
# SERP wants a location name, Content Analysis wants an ISO code).
SL_COUNTRIES = [
    ('SG', 'Singapore',   'Singapore'),
    ('ID', 'Indonesia',   'Indonesia'),
    ('MY', 'Malaysia',    'Malaysia'),
    ('AU', 'Australia',   'Australia'),
    ('TH', 'Thailand',    'Thailand'),
    ('VN', 'Vietnam',     'Vietnam'),
    ('PH', 'Philippines', 'Philippines'),
    ('BN', 'Brunei',      'Brunei'),
    ('KH', 'Cambodia',    'Cambodia'),
    ('MM', 'Myanmar',     'Myanmar'),
    ('NZ', 'New Zealand', 'New Zealand'),
    ('HK', 'Hong Kong',   'Hong Kong'),
    ('TW', 'Taiwan',      'Taiwan'),
    ('JP', 'Japan',       'Japan'),
    ('KR', 'South Korea', 'South Korea'),
    ('IN', 'India',       'India'),
]
SL_COUNTRY_NAME = {c: n for c, n, _ in SL_COUNTRIES}
SL_COUNTRY_LOC  = {c: l for c, _, l in SL_COUNTRIES}


def sl_countries(body=None):
    """Surfaced to the frontend so the country picker and the backend can never
    drift out of sync (the same mistake the tool-finder's five-place sync made)."""
    return {'countries': [{'code': c, 'name': n} for c, n, _ in SL_COUNTRIES]}


# ──────────────────────────────────────────────────────────────────────────────
# DataForSEO Content Analysis — the corpus layer
#
# TRAP, verified live against the API on 2026-07-21: content_analysis/summary/live
# and content_analysis/phrase_trends/live BOTH accept a `filters` array, return
# "Ok.", and then SILENTLY IGNORE IT — a country=SG filter returns byte-identical
# totals to no filter at all. Only content_analysis/search/live actually filters.
# So every country-scoped number below is derived from search/live, and the
# summary/trends endpoints are only ever used for GLOBAL (all-country) figures.
# Do not "simplify" this by passing filters to summary/trends; it fails silently.
# ──────────────────────────────────────────────────────────────────────────────
_SL_EMOTIONS = ('anger', 'happiness', 'love', 'sadness', 'share', 'fun')


def _sl_dfs_headers():
    auth = os.environ.get('DATAFORSEO_AUTH')
    return {'Authorization': auth, 'Content-Type': 'application/json'} if auth else None


def _sl_post(path, payload, timeout=45):
    headers = _sl_dfs_headers()
    if not headers:
        return {}
    try:
        r = requests.post(f'{DFS_BASE}/{path}', headers=headers, timeout=timeout,
                          json=payload)
        return r.json() or {}
    except (requests.exceptions.RequestException, ValueError):
        return {}


def _sl_term_group(terms):
    """Content Analysis has no boolean OR (verified: "Nike OR Adidas" returns
    fewer hits than either alone), so callers issue one request per term and we
    sum. This just normalises/caps the term list."""
    out, seen = [], set()
    for t in terms or []:
        t = (t or '').strip()
        if t and t.lower() not in seen:
            seen.add(t.lower())
            out.append(t)
    return out[:5]


def _sl_country_volume(terms, countries, page_types):
    """TRUE mention volume per country for `terms`, via the only endpoint that
    honours filters. One call per (term, country); returns the summed corpus
    total_count per country — NOT a count of the items we fetched."""
    out = {}
    if not countries:
        return out

    def _one(term, cc):
        d = _sl_post('content_analysis/search/live',
                     [{'keyword': term, 'page_type': page_types,
                       'search_mode': 'one_per_domain', 'limit': 1,
                       'filters': [['country', '=', cc]]}])
        res = (((d.get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
        return cc, (res.get('total_count') or 0)

    jobs = [(t, cc) for t in terms for cc in countries]
    if not jobs:
        return out
    with ThreadPoolExecutor(max_workers=8) as ex:
        for cc, n in ex.map(lambda a: _one(*a), jobs):
            out[cc] = out.get(cc, 0) + n
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Relevance guard + match labelling
#
# content_analysis/search/live matches its `keyword` LOOSELY (no phrase/boolean),
# so a short or common term drags in documents that aren't about the brand — the
# "false positives" the feed is full of. These two helpers turn a topic's
# structured conditions into (a) a post-fetch guard that drops items whose
# title+snippet don't actually satisfy the conditions, and (b) the list of terms
# that DID match, surfaced next to each mention so a human can see WHY it's there
# (and which term to tighten when it shouldn't be).
# ──────────────────────────────────────────────────────────────────────────────
def _sl_condition_groups(conditions, fallback_terms):
    """Normalise a topic's conditions into (groups, enforce).

    groups is [{op:'and'|'not', terms:[...]}]. enforce says whether to actually
    DROP items that fail: only True when the topic carries an explicit query
    built in the UI. A legacy topic (flat keyword list, no conditions) gets a
    synthesised group over its terms for LABELLING only — so it gains "matched"
    chips without its capture volume silently shrinking on the next pull."""
    groups, enforce = [], False
    for c in (conditions or []):
        if not isinstance(c, dict):
            continue
        op = 'not' if c.get('op') == 'not' else 'and'
        terms = [str(t).strip() for t in (c.get('terms') or []) if str(t).strip()]
        if terms:
            groups.append({'op': op, 'terms': terms})
            enforce = True
    if not any(g['op'] == 'and' for g in groups):
        pos = [str(t).strip() for t in (fallback_terms or []) if str(t).strip()]
        if pos:
            groups.insert(0, {'op': 'and', 'terms': pos})
    return groups, enforce


def _sl_relevance(groups, haystack):
    """Score one item's title+snippet against the condition groups. Returns
    (passes, matched_terms). A positive ('and') group passes when at least one of
    its terms appears; a 'not' group must have none present. matched_terms are the
    positive terms found — the 'why it's here' — and are always gathered, even
    when the item fails, so a label-only (non-enforcing) caller can still show
    them. An empty haystack can't be judged, so it passes with no labels."""
    hay = (haystack or '').lower()
    if not hay:
        return True, []
    matched, seen, passes = [], set(), True
    for g in groups:
        terms = g.get('terms') or []
        present = [t for t in terms if t.lower() in hay]
        if g.get('op') == 'not':
            if present:
                passes = False
        else:
            if terms and not present:
                passes = False
            for t in present:
                if t.lower() not in seen:
                    seen.add(t.lower())
                    matched.append(t)
    return passes, matched


def _sl_feed(terms, countries, page_types, lang_code, limit=25, conditions=None):
    """The mention feed. When countries are selected we fetch per country so the
    feed honours the filter; otherwise one unfiltered pass. Each item keeps its
    own sentiment + emotion scores, country, language and author, which is what
    makes the per-country sentiment/emotion/author breakdowns possible at all
    (summary/live can't be filtered, so those must be computed from items).

    `conditions` (the topic's structured query) drives a relevance guard: an item
    whose title+snippet doesn't satisfy them is dropped as a false positive, and
    the terms that DID match are attached as `matched` for display."""
    scopes = countries or [None]
    groups, enforce = _sl_condition_groups(conditions, terms)

    def _one(term, cc):
        req = {'keyword': term, 'page_type': page_types,
               'search_mode': 'one_per_domain', 'limit': limit,
               'order_by': ['content_info.date_published,desc'],
               'filters': [['language', '=', lang_code]]}
        if cc:
            # DataForSEO rejects a bare list-of-lists as an implicit AND, so the
            # two conditions must be joined with an explicit 'and' token.
            req['filters'] = [['language', '=', lang_code], 'and', ['country', '=', cc]]
        d = _sl_post('content_analysis/search/live', [req])
        res = (((d.get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
        return res.get('items') or []

    jobs = [(t, cc) for t in terms for cc in scopes]
    raw = []
    if jobs:
        with ThreadPoolExecutor(max_workers=8) as ex:
            for items in ex.map(lambda a: _one(*a), jobs):
                raw.extend(items)

    feed, seen = [], set()
    for it in raw:
        url = it.get('url')
        if not url or url in seen:
            continue
        ci = it.get('content_info') or {}
        title = ci.get('title') or ci.get('main_title') or ''
        if _mostly_non_latin(title) or _is_promo_noise(it.get('domain'), title):
            continue
        snippet = (ci.get('snippet') or ci.get('highlighted_text') or '')[:400]
        passes, matched = _sl_relevance(groups, title + ' ' + snippet)
        if enforce and not passes:          # explicit query not satisfied → drop
            continue
        seen.add(url)
        pt = it.get('page_types')
        emo = ci.get('sentiment_connotations') or {}
        feed.append({
            'url': url,
            'domain': it.get('domain'),
            'title': (title or url or '')[:160],
            'snippet': snippet,
            'matched': matched,
            'date': ci.get('date_published'),
            'sentiment': _ca_dominant_sentiment(ci),
            'emotions': {k: emo.get(k) for k in _SL_EMOTIONS if emo.get(k) is not None},
            'country': it.get('country'),
            'language': it.get('language') or ci.get('language'),
            'author': ci.get('author'),
            'domain_rank': it.get('domain_rank'),
            'categories': ci.get('text_category') or it.get('page_category') or [],
            'page_type': (pt[0] if isinstance(pt, list) and pt else it.get('page_type')),
            'source': 'web',
        })
    feed.sort(key=lambda m: str(m.get('date') or ''), reverse=True)
    return feed


def _sl_corpus_summary(terms, page_types):
    """GLOBAL (un-filterable) corpus figures: total volume, sentiment, emotions,
    country map, language map, page-type map, category map. Summed across terms."""
    def _one(term):
        d = _sl_post('content_analysis/summary/live',
                     [{'keyword': term, 'page_type': page_types,
                       'positive_connotation_threshold': 0.4,
                       'sentiments_connotation_threshold': 0.4}])
        return (((d.get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}

    results = []
    if terms:
        with ThreadPoolExecutor(max_workers=5) as ex:
            results = list(ex.map(_one, terms))

    total = 0
    sent = {'positive': 0, 'negative': 0, 'neutral': 0}
    emo = {k: 0 for k in _SL_EMOTIONS}
    by_country, by_lang, by_type, cats, domains = {}, {}, {}, {}, {}
    for res in results:
        total += res.get('total_count') or 0
        for k, v in (res.get('connotation_types') or {}).items():
            if k in sent and isinstance(v, (int, float)):
                sent[k] += v
        for k, v in (res.get('sentiment_connotations') or {}).items():
            if k in emo and isinstance(v, (int, float)):
                emo[k] += v
        for k, v in (res.get('countries') or {}).items():
            by_country[k] = by_country.get(k, 0) + (v or 0)
        for k, v in (res.get('languages') or {}).items():
            by_lang[k] = by_lang.get(k, 0) + (v or 0)
        for k, v in (res.get('page_types') or {}).items():
            by_type[k] = by_type.get(k, 0) + (v or 0)
        for d in (res.get('top_domains') or []):
            if isinstance(d, dict) and d.get('domain'):
                domains[d['domain']] = domains.get(d['domain'], 0) + (d.get('count') or 0)
        for c in (res.get('text_categories') or []):
            ids = c.get('category')
            if isinstance(ids, list):
                for cid in ids:
                    cats[cid] = cats.get(cid, 0) + (c.get('count') or 0)
    return {
        'total_mentions': total,
        'sentiment': sent,
        'emotions': emo,
        'by_country': by_country,
        'by_language': by_lang,
        'by_page_type': by_type,
        'categories': sorted(cats.items(), key=lambda kv: kv[1], reverse=True)[:15],
        'top_domains': sorted(domains.items(), key=lambda kv: kv[1], reverse=True)[:10],
    }


def _sl_search_volume(terms, countries, language='English'):
    """Google search volume for the tracked terms — the "Search volume" metric,
    which is demand-side and completely separate from mention volume. Scoped to
    the first selected market (Google Ads reports volume per location, and
    summing locations would double-count anyone searching from both)."""
    if not terms:
        return {}
    loc = SL_COUNTRY_LOC.get((countries or ['SG'])[0], 'Singapore')
    d = _sl_post('keywords_data/google_ads/search_volume/live',
                 [{'keywords': terms[:20], 'location_name': loc,
                   'language_name': language}], timeout=30)
    items = ((d.get('tasks') or [{}])[0].get('result')) or []
    rows, total = [], 0
    for it in items:
        v = it.get('search_volume')
        if v is None:
            continue
        total += v
        rows.append({'keyword': it.get('keyword'), 'volume': v,
                     'cpc': it.get('cpc'), 'competition': it.get('competition'),
                     'monthly': it.get('monthly_searches') or []})
    rows.sort(key=lambda r: r['volume'], reverse=True)
    return {'location': loc, 'total': total, 'keywords': rows}


def _sl_trends(terms, page_types, date_from, date_to, group='day'):
    """True per-day corpus series (volume, sentiment, emotions) from
    phrase_trends/live. Global only — see the filters trap above. This is what
    backfills history for a topic that was only just created; our own daily
    snapshots carry the country-scoped series."""
    def _one(term):
        d = _sl_post('content_analysis/phrase_trends/live',
                     [{'keyword': term, 'page_type': page_types,
                       'date_from': date_from, 'date_to': date_to,
                       'date_group': group}], timeout=60)
        return (d.get('tasks') or [{}])[0].get('result') or []

    merged = {}
    rows = []
    if terms:
        with ThreadPoolExecutor(max_workers=5) as ex:
            for res in ex.map(_one, terms):
                rows.extend(res)
    for r in rows:
        day = r.get('date')
        if not day:
            continue
        slot = merged.setdefault(day, {
            'date': day, 'total_mentions': 0,
            'sentiment': {'positive': 0, 'negative': 0, 'neutral': 0},
            'emotions': {k: 0 for k in _SL_EMOTIONS}})
        slot['total_mentions'] += r.get('total_count') or 0
        for k, v in (r.get('connotation_types') or {}).items():
            if k in slot['sentiment'] and isinstance(v, (int, float)):
                slot['sentiment'][k] += v
        for k, v in (r.get('sentiment_connotations') or {}).items():
            if k in slot['emotions'] and isinstance(v, (int, float)):
                slot['emotions'][k] += v
    return [merged[d] for d in sorted(merged)]


# ──────────────────────────────────────────────────────────────────────────────
# Social Listening — the Apify social layer (reach / impressions / authors)
#
# DataForSEO's corpus has no audience data at all: `social_metrics` is null on
# every item and there are no follower counts, so reach, impressions, author
# reach and author mention share are simply not derivable from it. Apify's
# keyword-search actors DO carry them (verified live 2026-07-21: apidojo's
# tweet-scraper returns viewCount per tweet and author.followers per author).
#
# COST is the constraint, not capability. Bronze per-result prices:
#   X $0.0004  ·  Instagram $0.0023  ·  TikTok $0.0030  ·  Reddit $0.0038
# At 100 results/topic/day across 4 platforms that is ~$142/mo — ~5x the $29
# plan. So X (by far the cheapest and the richest for reach) runs DAILY and the
# other three run WEEKLY, which lands at ~$25/mo. Anything that changes these
# caps or cadences changes the monthly bill roughly linearly — check the plan
# before raising them.
# ──────────────────────────────────────────────────────────────────────────────
SL_APIFY_CAP = int(os.environ.get('SL_APIFY_CAP', '100'))   # results/topic/platform/pull
SL_WEEKLY_DOW = 0                                           # Monday, in SGT

SL_SOCIAL_ACTORS = {
    'x':         ('apidojo~tweet-scraper',           'X (Twitter)', 'daily'),
    'instagram': ('apify~instagram-hashtag-scraper', 'Instagram',   'weekly'),
    'tiktok':    ('clockworks~tiktok-scraper',       'TikTok',      'weekly'),
    'reddit':    ('trudax~reddit-scraper-lite',      'Reddit',      'weekly'),
}


def _sl_social_input(platform, terms, cap):
    """Keyword-SEARCH input per actor (not the profile-scrape inputs _build_input
    builds — listening searches a term, it doesn't crawl a known handle)."""
    if platform == 'x':
        return {'searchTerms': terms, 'maxItems': cap, 'sort': 'Latest'}
    if platform == 'instagram':
        # hashtag scraper wants bare tags, so strip spaces/# from each term
        tags = [re.sub(r'[^0-9A-Za-z]', '', t) for t in terms]
        return {'hashtags': [t for t in tags if t], 'resultsLimit': cap}
    if platform == 'tiktok':
        return {'searchQueries': terms, 'resultsPerPage': cap,
                'shouldDownloadVideos': False, 'shouldDownloadCovers': False}
    if platform == 'reddit':
        return {'searches': terms, 'maxItems': cap, 'sort': 'new',
                'skipComments': True, 'skipUserPosts': True}
    return {}


def _sl_norm_social(platform, it):
    """Normalise one actor row into the shared mention shape. Actors disagree on
    field names, so every read goes through _g with the known aliases."""
    if not isinstance(it, dict):
        return None
    a = it.get('author') or it.get('authorMeta') or it.get('owner') or {}
    if not isinstance(a, dict):
        a = {}
    followers = _g(a, 'followers', 'followersCount', 'fans', 'followerCount',
                   default=None) or _g(it, 'followers', 'followersCount', default=None)
    url = _g(it, 'url', 'twitterUrl', 'postPage', 'webVideoUrl', 'link', default=None)
    text = _g(it, 'fullText', 'text', 'caption', 'title', 'body', default='') or ''
    hashtags = []
    ents = it.get('entities') or {}
    for h in (ents.get('hashtags') or it.get('hashtags') or []):
        tag = h.get('text') if isinstance(h, dict) else h
        if tag:
            hashtags.append(str(tag).lstrip('#').lower())
    links = []
    for u in (ents.get('urls') or []):
        eu = u.get('expanded_url') or u.get('url') if isinstance(u, dict) else u
        if eu:
            links.append(eu)
    if not hashtags:
        hashtags = [w.lstrip('#').lower() for w in re.findall(r'#\w+', text)]
    return {
        'platform': platform,
        'url': url,
        'title': (text or '')[:160],
        'snippet': (text or '')[:400],
        'author': _g(a, 'userName', 'name', 'nickName', 'username', default=None)
                  or _g(it, 'username', 'authorName', default=None),
        'author_url': _g(a, 'twitterUrl', 'url', 'profileUrl', default=None),
        'followers': followers,
        # X reports true impressions; the others don't expose any impression
        # metric, so `views` stays None there rather than being faked from plays.
        'views': _g(it, 'viewCount', 'playCount', 'videoViewCount', default=None),
        'likes': _g(it, 'likeCount', 'diggCount', 'likes', 'score', default=None),
        'shares': _g(it, 'retweetCount', 'shareCount', 'shares', default=None),
        'comments': _g(it, 'replyCount', 'commentCount', 'comments',
                       'numberOfComments', default=None),
        'date': _g(it, 'createdAt', 'created_at', 'createTimeISO', 'date',
                   'postedAt', default=None),
        'language': _g(it, 'lang', 'language', default=None),
        'hashtags': hashtags[:12],
        'links': links[:8],
        'source': platform,
    }


def _sl_social_pull(terms, platforms, cap=None):
    """Run the selected actors concurrently and collect normalised mentions.
    Best-effort per platform: one actor failing leaves its slot empty rather
    than sinking the whole snapshot."""
    cap = cap or SL_APIFY_CAP
    out = {}
    if not APIFY_TOKEN or not terms:
        return out
    started = {}
    for p in platforms:
        spec = SL_SOCIAL_ACTORS.get(p)
        if not spec:
            continue
        run = _apify_start(spec[0], _sl_social_input(p, terms, cap))
        if run:
            started[p] = {'run_id': run['id'], 'dataset_id': run.get('defaultDatasetId'),
                          'label': spec[1]}
    if not started:
        return out

    deadline = time.time() + min(CRON_MAX_WAIT_SECS, 420)
    pending = set(started)
    while pending and time.time() < deadline:
        for p in list(pending):
            st = _apify_status(started[p]['run_id'])
            if st in ('SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'):
                pending.discard(p)
        if pending:
            time.sleep(10)

    for p, ent in started.items():
        items = _apify_items(ent['dataset_id'])
        posts, seen = [], set()
        for it in items:
            m = _sl_norm_social(p, it)
            if not m or not m.get('url') or m['url'] in seen:
                continue
            seen.add(m['url'])
            posts.append(m)
            if len(posts) >= cap:
                break
        out[p] = {'label': ent['label'], 'posts': posts,
                  'timed_out': p in pending, 'pulled': _now_iso()}
    return out


def _sl_due_platforms(topic, today=None):
    """Which Apify platforms to pull today. X every day; the expensive three only
    on SL_WEEKLY_DOW, so the weekly cadence is deterministic rather than drifting
    with whenever the cron happened to fire."""
    wanted = topic.get('social') or list(SL_SOCIAL_ACTORS)
    day = today or _sgt_date()
    try:
        dow = datetime.strptime(day, '%Y-%m-%d').weekday()
    except Exception:
        dow = SL_WEEKLY_DOW
    due = []
    for p in wanted:
        spec = SL_SOCIAL_ACTORS.get(p)
        if not spec:
            continue
        if spec[2] == 'daily' or dow == SL_WEEKLY_DOW:
            due.append(p)
    return due


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


# ── Boolean listening via Google SERP ────────────────────────────────────────
# Content Analysis can't do boolean (verified above), but Google SERP honours
# AND/OR/NOT, quoted phrases and parentheses natively — so a client's Brandwatch-
# style query, e.g.  ("Anderco") AND ("container" OR "storage"),  runs here as a
# general web search + the enabled site layers, with Haiku labelling sentiment.
def _serp_web_mentions(query, location, language, headers, limit=15):
    """One boolean query as a general Google web search → organic mentions
    (url/domain/title/snippet/date). Best-effort."""
    out = []
    if not (query or '').strip():
        return out
    try:
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers=headers, timeout=25,
                          json=[{'keyword': query, 'location_name': location,
                                 'language_name': language, 'depth': max(10, limit)}])
        res = (((r.json().get('tasks') or [{}])[0].get('result')) or [{}])[0] or {}
        for it in (res.get('items') or []):
            if it.get('type') != 'organic' or not it.get('url'):
                continue
            out.append({'url': it.get('url'), 'domain': it.get('domain') or '',
                        'title': (it.get('title') or '')[:160],
                        'snippet': (it.get('description') or '')[:240],
                        'date': it.get('timestamp'), 'page_type': 'web'})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out


def _serp_site_mentions_q(query, site_expr, location, language, headers, limit=8):
    """Like _serp_site_mentions but scopes a raw boolean query (not a term list)
    to one site group (Reddit / X / forums)."""
    out = []
    if not (query or '').strip():
        return out
    try:
        r = requests.post(f'{DFS_BASE}/serp/google/organic/live/advanced',
                          headers=headers, timeout=25,
                          json=[{'keyword': f'{site_expr} {query}',
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


def _classify_sentiment(mentions):
    """Label each mention positive/negative/neutral toward the brand from its
    title+snippet, in one batched Haiku call. Mutates `mentions`; best-effort."""
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    items = [m for m in mentions if (m.get('title') or m.get('snippet'))][:40]
    if not api_key or not items:
        return
    numbered = '\n'.join(
        f'{i + 1}. {((m.get("title") or "") + " — " + (m.get("snippet") or "")).strip()[:280]}'
        for i, m in enumerate(items))
    prompt = ('Label the sentiment TOWARD the brand for each numbered mention as exactly one of '
              '"positive", "negative" or "neutral". Return ONLY a JSON array of that many strings, '
              'in order.\n\n' + numbered)
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'}, timeout=40,
                          json={'model': HAIKU_MODEL, 'max_tokens': 700,
                                'messages': [{'role': 'user', 'content': prompt}]})
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        arr = json.loads(txt[txt.find('['):txt.rfind(']') + 1])
        for m, s in zip(items, arr):
            s = str(s).strip().lower()
            if s in ('positive', 'negative', 'neutral'):
                m['sentiment'] = s
    except Exception:
        pass


def _listen_boolean(queries, sources, location, language, headers):
    """Boolean listening: each named query → general web SERP + enabled site
    layers, deduped, noise-filtered, Haiku sentiment. Returns the SAME shape as
    fetch_social_listening's Content-Analysis path so the report renders the same."""
    out = {'enabled': True, 'summary': None, 'mentions': [], 'platforms': {},
           'terms': [(q.get('label') or q.get('q') or '') for q in queries],
           'note': None, 'queries': [], 'mode': 'boolean'}
    web_all, plat_acc, total = [], {}, 0
    with ThreadPoolExecutor(max_workers=8) as ex:
        web_futs, site_futs = {}, {}
        for i, q in enumerate(queries):
            qs = q.get('q') or ''
            if 'web' in sources:
                web_futs[i] = ex.submit(_serp_web_mentions, qs, location, language, headers, 15)
            for key, (site_expr, label) in LISTEN_SITES.items():
                if key in sources:
                    site_futs[(i, key)] = (label, ex.submit(
                        _serp_site_mentions_q, qs, site_expr, location, language, headers, 8))
        for i, q in enumerate(queries):
            items = web_futs[i].result() if i in web_futs else []
            # The boolean query IS the match criterion here, so label each item
            # with the named query that surfaced it — the feed's "matched" chip.
            lbl = q.get('label') or q.get('q') or ''
            for it in items:
                it.setdefault('matched', [lbl] if lbl else [])
            total += len(items)
            web_all.extend(items)
            out['queries'].append({'label': q.get('label') or '',
                                   'q': q.get('q') or '', 'count': len(items)})
        for (i, key), (label, fut) in site_futs.items():
            slot = plat_acc.setdefault(key, {'label': label, '_seen': set(), 'results': []})
            for r in (fut.result() or []):
                u = r.get('url')
                if u and u not in slot['_seen']:
                    slot['_seen'].add(u)
                    slot['results'].append(r)
    seen, web = set(), []
    for it in web_all:
        u = it.get('url')
        if not u or u in seen:
            continue
        if _mostly_non_latin(it.get('title')) or _is_promo_noise(it.get('domain'), it.get('title')):
            continue
        seen.add(u)
        web.append(it)
    web = web[:30]
    _classify_sentiment(web)
    sent, dom = {'positive': 0, 'negative': 0, 'neutral': 0}, {}
    for m in web:
        s = m.get('sentiment')
        if s in sent:
            sent[s] += 1
        d = m.get('domain')
        if d:
            dom[d] = dom.get(d, 0) + 1
    for slot in plat_acc.values():
        slot.pop('_seen', None)
    out['mentions'] = web
    out['summary'] = {
        'total_mentions': total or None,
        'sentiment': sent if web else {'positive': None, 'negative': None, 'neutral': None},
        'top_domains': [k for k, _ in sorted(dom.items(), key=lambda kv: kv[1], reverse=True)[:8]],
    }
    out['platforms'] = plat_acc
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

    # Boolean-query mode — when the client configured named boolean queries, route
    # them through Google SERP (honours AND/OR/quotes/parentheses, which Content
    # Analysis cannot) instead of the comma-term path below. Capped so a runaway
    # topic list can't blow DataForSEO spend.
    _queries = [q for q in (cfg.get('queries') or [])
                if isinstance(q, dict) and (q.get('q') or '').strip()][:12]
    if _queries:
        return _listen_boolean(_queries, sources, location, language, headers)

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

    guard_groups, guard_enforce = _sl_condition_groups(cfg.get('conditions'), terms)

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
                snippet = (ci.get('snippet') or ci.get('highlighted_text') or '')[:240]
                passes, matched = _sl_relevance(guard_groups, title + ' ' + snippet)
                if guard_enforce and not passes:          # explicit query not met → skip
                    continue
                seen_urls.add(url)
                pt = it.get('page_types')
                merged.append({
                    'url': url,
                    'domain': it.get('domain'),
                    'title': (title or url or '')[:160],
                    'snippet': snippet,
                    'matched': matched,
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
# First-party (connected-account) metrics Apify scraping can't produce. When an
# audit is tied to a Monthly-Social-Reports client, _overlay_native copies these
# onto the scraped metrics dict and _platform_card passes them through.
_NATIVE_AUTH_KEYS = (   # native-only truth — always wins over the (absent) scraped value
    'followers', 'reach', 'impressions', 'engagements', 'engagement_rate_impr',
    'likes', 'comments', 'shares', 'saves', 'net_new_followers',
    'reactions_by_type', 'breakdowns', 'breakdowns_asof',
)
_NATIVE_FILL_KEYS = (   # post-derived — only fill in when the public scrape came up empty
    'engagement_rate', 'avg_likes', 'avg_comments', 'avg_video_views',
    'posts_per_week', 'days_since_last_post', 'content_mix', 'top_hashtags',
    'hashtag_count', 'top_posts', 'top_vs_median', 'posts', 'captions', 'image_urls',
)


def _overlay_native(m, nc, had_apify):
    """Overlay a first-party (native API) card onto a scraped metrics dict `m`.
    Authoritative first-party metrics always win; the post-derived fields are
    only borrowed when the public scrape found nothing for this platform, so a
    good Apify scrape keeps its richer post grid / creative samples."""
    for k in _NATIVE_AUTH_KEYS:
        v = nc.get(k)
        if v is not None:
            m[k] = v
    if not had_apify:
        for k in _NATIVE_FILL_KEYS:
            v = nc.get(k)
            if v is not None:
                m[k] = v


def _platform_card(platform, m):
    card = {
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
    # First-party metrics — only present when the audit was enriched from a
    # connected client, so public-only audits keep their exact card shape.
    for k in ('reach', 'impressions', 'engagements', 'engagement_rate_impr',
              'saves', 'shares', 'net_new_followers', 'reactions_by_type',
              'breakdowns', 'breakdowns_asof', 'data_source'):
        if m.get(k) is not None:
            card[k] = m[k]
    return card


# ──────────────────────────────────────────────────────────────────────────────
# Benchmark block — Share of Voice, format mix, word cloud, content sentiment.
# Everything but sentiment is deterministic, computed straight off the Apify
# scrape (own brand + competitors). Mirrors Brandwatch's Content-Analysis widgets.
# ──────────────────────────────────────────────────────────────────────────────
_POSTS_PER_MONTH = 4.345    # weeks → month, for monthly-volume estimates

_WC_STOP = set('''a an the and or but if then else for to of in on at by with from
into onto over under up down out off as is are was were be been being am do does did
have has had having will would shall should can could may might must not no nor yes
this that these those it its we our us you your they their them he she his her i me
my mine ours so than too very just also about more most many much get got new now
one two three all any each both few how what when where which who whom why youre were
im dont cant wont lets via per amp rt http https www com co than then there here out
up out new more best top good great love like make made making your you'''.split())


def _entity_totals(name, is_brand, parts):
    """Aggregate one entity's metrics across its tracked platform(s)."""
    followers = sum((p.get('followers') or 0) for p in parts)
    posts = sum(((p.get('posts_per_week') or 0) * _POSTS_PER_MONTH) for p in parts)
    eng = 0.0
    for p in parts:
        ppm = (p.get('posts_per_week') or 0) * _POSTS_PER_MONTH
        eng += ppm * ((p.get('avg_likes') or 0) + (p.get('avg_comments') or 0))
    return {'name': name, 'is_brand': is_brand,
            'followers': round(followers), 'posts': round(posts, 1),
            'engagement': round(eng)}


def _sov(entities, field):
    total = sum(e[field] for e in entities) or 0
    out = [{'name': e['name'], 'is_brand': e['is_brand'], 'value': e[field],
            'pct': round(e[field] / total * 100, 1) if total else 0} for e in entities]
    return sorted(out, key=lambda x: -x['value'])


def _mix_pct(mix):
    mix = mix or {}
    v, i, c = mix.get('video', 0) or 0, mix.get('image', 0) or 0, mix.get('carousel', 0) or 0
    tot = v + i + c
    if not tot:
        return None
    return {'video': round(v / tot * 100), 'image': round(i / tot * 100),
            'carousel': round(c / tot * 100)}


def _agg_mix(dicts):
    out = {'video': 0, 'image': 0, 'carousel': 0}
    for m in dicts:
        for kk in out:
            out[kk] += (m or {}).get(kk, 0) or 0
    return out


def _word_cloud(captions, brand, limit=40):
    brand_toks = set(re.findall(r'[a-z0-9]+', (brand or '').lower()))
    counts = {}
    for cap in captions:
        for tok in re.findall(r"[A-Za-z][A-Za-z'’]+", cap or ''):
            w = tok.lower().replace('’', "'").strip("'")
            if len(w) < 3 or w in _WC_STOP or w in brand_toks:
                continue
            counts[w] = counts.get(w, 0) + 1
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:limit]
    multi = [{'word': w, 'count': n} for w, n in top if n > 1]
    return multi or [{'word': w, 'count': n} for w, n in top]


def _compute_benchmark(brand, client_metrics, competitor_metrics):
    """Deterministic benchmark block (no AI): share of voice, format mix, word cloud."""
    brand_parts = [m for m in client_metrics.values() if m.get('found')]
    entities = []
    if brand_parts:
        entities.append(_entity_totals(brand, True, brand_parts))
    by_name = {}    # a competitor name may span >1 platform
    for c in competitor_metrics:
        if c.get('followers') is None:
            continue
        by_name.setdefault(c.get('name') or c.get('handle') or 'Competitor', []).append(c)
    for name, parts in by_name.items():
        entities.append(_entity_totals(name, False, parts))

    sov = {}
    if len(entities) >= 2:
        sov = {'audience':   _sov(entities, 'followers'),
               'activity':   _sov(entities, 'posts'),
               'engagement': _sov(entities, 'engagement')}

    fmt = []
    if brand_parts:
        bm = _mix_pct(_agg_mix([p.get('content_mix') for p in brand_parts]))
        if bm:
            fmt.append({'name': brand, 'is_brand': True, **bm})
    for name, parts in by_name.items():
        cm = _mix_pct(_agg_mix([p.get('content_mix') for p in parts]))
        if cm:
            fmt.append({'name': name, 'is_brand': False, **cm})

    captions = [cap for m in brand_parts for cap in (m.get('captions') or [])]
    out = {'share_of_voice': sov, 'format_mix': fmt,
           'word_cloud': _word_cloud(captions, brand),
           'tracked_set': [e['name'] for e in entities]}
    bp = _benchmark_by_platform(brand, client_metrics, competitor_metrics)
    if bp:
        out['by_platform'] = bp
    return out


def _benchmark_by_platform(brand, client_metrics, competitor_metrics):
    """The same share-of-voice / format mix, computed WITHIN each platform.

    The block above ranks every tracked account in one list, which silently
    compares a Facebook Page against an Instagram profile — so an Instagram-only
    report was reading a ranking led by a Facebook rival. That top-level block
    stays (it is the correct all-platforms view); this adds the per-platform
    split so a reader of the stored scorecard is not left to redo it."""
    plats = set()
    for p, m in (client_metrics or {}).items():
        if m.get('found'):
            plats.add(p)
    for c in (competitor_metrics or []):
        if c.get('platform') and c.get('followers') is not None:
            plats.add(c.get('platform'))
    out = {}
    for plat in sorted(plats):
        bm = (client_metrics or {}).get(plat)
        ents = []
        if bm and bm.get('found'):
            ents.append(_entity_totals(brand, True, [bm]))
        cs = [c for c in (competitor_metrics or [])
              if c.get('platform') == plat and c.get('followers') is not None]
        for c in cs:
            ents.append(_entity_totals(c.get('name') or c.get('handle') or 'Competitor', False, [c]))
        if len(ents) < 2:
            continue          # nothing to compare against on this platform
        fmt = []
        if bm and bm.get('found'):
            m = _mix_pct(_agg_mix([bm.get('content_mix')]))
            if m:
                fmt.append({'name': brand, 'is_brand': True, **m})
        for c in cs:
            m = _mix_pct(_agg_mix([c.get('content_mix')]))
            if m:
                fmt.append({'name': c.get('name') or c.get('handle') or '', 'is_brand': False, **m})
        out[plat] = {
            'share_of_voice': {'audience':   _sov(ents, 'followers'),
                               'activity':   _sov(ents, 'posts'),
                               'engagement': _sov(ents, 'engagement')},
            'format_mix': fmt,
            'tracked_set': [e['name'] for e in ents],
        }
    return out


def _content_sentiment(brand, client_metrics):
    """Classify the tone of the brand's own recent post captions, via DeepSeek if
    configured (DEEPSEEK_API_KEY), else falling back to Claude Haiku.
    Returns {positive, neutral, negative, total, summary} or None."""
    caps = [cap for m in client_metrics.values() if m.get('found')
            for cap in (m.get('captions') or []) if cap and len(cap.strip()) > 4][:40]
    if len(caps) < 3:
        return None
    numbered = '\n'.join(f'{i + 1}. {c[:280]}' for i, c in enumerate(caps))
    prompt = (
        f"Classify the sentiment/tone of each of {brand}'s social post captions below "
        "as positive, neutral, or negative — judged by the audience's likely emotional "
        "read of the message. Then give a one-line summary of the overall content tone.\n\n"
        "Respond with STRICT JSON only, no prose:\n"
        '{"positive":<int>,"neutral":<int>,"negative":<int>,'
        '"summary":"<=20 words on the overall tone of the content"}\n'
        "The three counts must sum to the number of captions below.\n\nCAPTIONS:\n" + numbered)

    deepseek_key = os.environ.get('DEEPSEEK_API_KEY')
    try:
        if deepseek_key:
            r = requests.post('https://api.deepseek.com/chat/completions',
                              headers={'Authorization': f'Bearer {deepseek_key}',
                                       'content-type': 'application/json'},
                              json={'model': 'deepseek-chat', 'max_tokens': 300,
                                    'messages': [{'role': 'user', 'content': prompt}]},
                              timeout=40)
            choice = (r.json().get('choices') or [{}])[0]
            txt = choice.get('message', {}).get('content', '')
        else:
            api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
            if not api_key:
                return None
            r = requests.post('https://api.anthropic.com/v1/messages',
                              headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                       'content-type': 'application/json'},
                              json={'model': HAIKU_MODEL, 'max_tokens': 300,
                                    'messages': [{'role': 'user', 'content': prompt}]},
                              timeout=40)
            txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                          if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        out['total'] = len(caps)
        return out
    except Exception:
        return None


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
# Competitor profile — the qualitative half of a competitor analysis
# ──────────────────────────────────────────────────────────────────────────────
# The scrape answers how a competitor PERFORMS. A consultant's competitor
# analysis also has to answer who they ARE (what they do, what they sell, who
# they target, how they position) and what they TALK ABOUT (topics they own,
# content pillars, messaging/tone, how they engage their audience).
#
# One call per competitor BRAND rather than per platform: the overview is
# platform-agnostic, so per-platform calls would double the cost and risk two
# contradicting descriptions of the same company.
def _analyze_competitor_profile(name, sources, location=''):
    """`sources` is a list of (platform, full metrics dict) for ONE competitor
    brand. Returns a profile dict, or None when there's no key / nothing to read."""
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    if not api_key:
        return None

    platforms, bios, caption_lines, hashtags, stats = [], [], [], [], []
    for plat, m in sources:
        platforms.append(plat)
        if m.get('bio'):
            bios.append(f'[{plat}] {m["bio"]}')
        for cap in (m.get('captions') or [])[:MAX_PROFILE_CAPTIONS]:
            caption_lines.append(f'[{plat}] {cap}')
        hashtags += (m.get('top_hashtags') or [])
        stats.append({'platform': plat, 'followers': m.get('followers'),
                      'engagement_rate': m.get('engagement_rate'),
                      'posts_per_week': m.get('posts_per_week'),
                      'avg_likes': m.get('avg_likes'),
                      'avg_comments': m.get('avg_comments'),
                      'content_mix': m.get('content_mix')})
    if not caption_lines and not bios:
        return None

    prompt = (
        f"You are a senior competitive strategist profiling the competitor brand "
        f"\"{name}\"" + (f" (market: {location})" if location else "") + ". You have their social "
        "profile bios, recent post captions, top hashtags and account metrics. "
        "Infer a competitor profile covering BOTH who the brand is and what it "
        "talks about.\n\n"
        "COVER EXACTLY:\n"
        "A. BRAND OVERVIEW — what the brand does; the products/services it offers; "
        "   who it targets; its positioning and key differentiators\n"
        "B. CONTENT & CONVERSATION — the conversations/topics it consistently owns; "
        "   its key content pillars/themes; its brand messaging and tone of voice; "
        "   how it engages its audience (formats, cadence, CTAs, community tactics)\n\n"
        "Respond with STRICT JSON only, no prose, matching EXACTLY:\n"
        '{"what_they_do":"1-2 sentences on what the business actually does",'
        '"products_services":["3-5 concrete products or services, <=8 words each"],'
        '"target_audience":"1-2 sentences on who they speak to (segments, life stage, buyer role)",'
        '"positioning":"1-2 sentences on how they position themselves in the market",'
        '"differentiators":["2-4 claimed or evident differentiators, <=12 words each"],'
        '"topics_owned":["2-4 conversations/topics they consistently own, <=8 words each"],'
        '"content_pillars":["3-5 recurring content pillars/themes, <=8 words each"],'
        '"messaging_tone":"2-3 sentences on brand messaging and tone of voice",'
        '"audience_engagement":"2-3 sentences on how they engage their audience — '
        'formats, posting rhythm, CTAs, comment/community behaviour",'
        '"confidence":"high|medium|low"}\n\n'
        "Ground every claim in the bios, captions, hashtags and metrics below — no "
        "generic category filler. Where the evidence is thin, say so plainly in the "
        "field and set confidence accordingly (never invent products or audiences).\n\n"
        "PROFILE BIOS:\n" + ('\n'.join(bios) or '(none captured)') +
        "\n\nACCOUNT METRICS:\n" + json.dumps(stats, default=str)[:1500] +
        "\n\nTOP HASHTAGS:\n" + (', '.join(_top(hashtags, 15)) or '(none)') +
        "\n\nRECENT POST CAPTIONS:\n" + ('\n'.join(caption_lines[:36]) or '(none captured)')
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          json={'model': HAIKU_MODEL, 'max_tokens': 1500,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=60)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        out['name'] = name
        out['platforms'] = sorted(set(platforms))
        out['posts_analyzed'] = len(caption_lines)
        return out
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Haiku narrative
# ──────────────────────────────────────────────────────────────────────────────
def _narrate(brand, client_metrics, competitor_metrics, brand_health, indicators,
             extra_context='', creative=None, competitor_profiles=None):
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')
    facts = {
        'brand': brand,
        'platforms': {p: _platform_card(p, m) for p, m in client_metrics.items()},
        'competitors': competitor_metrics,
        'competitor_profiles': competitor_profiles or [],
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
        "factor its findings into the summary, strengths/gaps and action plan. A "
        "competitor_profiles array (what each competitor does, who they target, "
        "how they position, the topics they own) may also be present — use it so "
        "the competitor comparison is about positioning and content, not just "
        "numbers.\n\nAUDIT DATA:\n"
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
def _rdays():     return boto3.resource('dynamodb', region_name=REGION).Table(REPORT_DAYS_TABLE)

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

_EMAIL_RE = re.compile(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}')

def _clean_who(val):
    """Normalise a user identifier to a short, plain string that is always safe to
    store as created_by / updated_by.

    index.html has historically shipped `currentUser.email` re-JSON-stringified on
    every round-trip, so it arrives wrapped in compounding quote/backslash escaping
    (e.g. '"\\"kenneth@mediaone.co\\""') and can balloon to ~2MB. Written verbatim
    into a project item it single-handedly exceeds DynamoDB's 400KB item limit
    (PutItem -> ValidationException "Item size has exceeded the maximum allowed
    size"), which is what blocked new settings attributes like reportHiddenSegments
    from ever persisting — the item's own history was never the problem. Pull out the
    real email if there is one, otherwise strip escaping, and hard-cap the length so
    no identifier can bloat an item regardless of what the client sends."""
    if not isinstance(val, str):
        val = str(val or '')
    # Peel accidental JSON re-stringification: '"\"a@b\""' -> '"a@b"' -> 'a@b'.
    for _ in range(8):
        s = val.strip()
        if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
            try:
                nxt = json.loads(s)
            except ValueError:
                break
            if isinstance(nxt, str) and nxt != val:
                val = nxt
                continue
        break
    m = _EMAIL_RE.search(val)
    if m:
        return m.group(0)[:320]
    return val.strip().strip('"\\ ')[:320] or 'unknown'

def _who(body):
    u = body.get('currentUser') or {}
    if isinstance(u, dict):
        raw = (u.get('email') or u.get('name') or body.get('userEmail') or 'unknown')
    else:
        raw = (u or body.get('userEmail') or 'unknown')
    return _clean_who(raw)

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
        # Social-listening config — extra terms to track + the on/off flag the
        # monthly capture (runMonth) reads. Brand name is always tracked server-side.
        'listenKeywords': data.get('listenKeywords') if data.get('listenKeywords') is not None else existing.get('listenKeywords', []),
        # Boolean listening queries [{label, q}] — Brandwatch-style AND/OR/quoted
        # queries run via Google SERP (see _listen_boolean). Preferred over the
        # comma-term listenKeywords when present.
        'listenQueries':  data.get('listenQueries')  if data.get('listenQueries')  is not None else existing.get('listenQueries', []),
        'listenEnabled':  data.get('listenEnabled')  if data.get('listenEnabled')  is not None else existing.get('listenEnabled', True),
        # Competitor scrape cadence: 'daily' (default) | 'weekly' | 'off' — the main
        # Apify cost lever now that owned platforms pull natively for free.
        'competitor_cadence': data.get('competitor_cadence') if data.get('competitor_cadence') is not None else existing.get('competitor_cadence', 'daily'),
        # Report-only hide-list: tag segments the user chose to omit from the monthly
        # report (see index.html setReportHiddenSegments / reportHTML). Stored as a
        # HIDE-list so any new segment shows by default.
        'reportHiddenSegments': data.get('reportHiddenSegments') if data.get('reportHiddenSegments') is not None else existing.get('reportHiddenSegments', []),
        'months':      existing.get('months', []),
        'created':     existing.get('created') or now,
        # Clean any legacy escaped/oversized identifier already on the record.
        'created_by':  _clean_who(existing.get('created_by')) if existing.get('created_by') else who,
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

def _strip_fb_reach_er(sc):
    """FB reach is deprecated, so a reach-based engagement_rate is never valid on a
    Facebook card — engagement_rate_impr replaces it. Purge any stale value so old
    captures + the keep-last-non-empty carry-forward can't resurface a 255%-style
    figure. Returns sc (mutated in place)."""
    for c in ((sc or {}).get('platforms') or []):
        if c.get('platform') == 'facebook':
            c.pop('engagement_rate', None)
    return sc


_THUMB_TYPES = {'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1}


def _mirror_image(url):
    """Copy one expiring CDN image into S3 and return the durable public URL.

    Keyed by the source path WITHOUT its query string, so the signature rotating
    on every pull still resolves to the same object — a re-capture costs one HEAD,
    not a re-upload. Returns the original url unchanged on ANY failure: mirroring
    is an enhancement and must never be a reason to lose a thumbnail."""
    u = str(url or '').strip()
    if not u.startswith('http'):
        return url
    if (THUMB_BUCKET + '.s3.') in u:
        return u                                   # already mirrored
    try:
        key = THUMB_PREFIX + hashlib.sha1(u.split('?', 1)[0].encode('utf-8')).hexdigest()
        public = 'https://%s.s3.%s.amazonaws.com/%s' % (THUMB_BUCKET, REGION, key)
        s3 = boto3.client('s3', region_name=REGION)
        try:
            s3.head_object(Bucket=THUMB_BUCKET, Key=key)
            return public                          # mirrored by an earlier capture
        except Exception:
            pass
        r = requests.get(u, timeout=20, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; DigiMetrics/1.0)'})
        if r.status_code != 200:
            return url
        ctype = (r.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        body = r.content
        if ctype not in _THUMB_TYPES or not body or len(body) > 8_000_000:
            return url
        # No extension in the key — the stored Content-Type is what browsers read,
        # and it keeps the key a pure function of the source path.
        s3.put_object(Bucket=THUMB_BUCKET, Key=key, Body=body, ContentType=ctype,
                      CacheControl='public, max-age=31536000, immutable')
        return public
    except Exception as e:
        print('thumb mirror failed: %s' % str(e)[:160])
        return url


_OG_IMAGE_RE = re.compile(
    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', re.I)
_OG_IMAGE_RE2 = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', re.I)


def _og_image(page_url):
    """The og:image a public post permalink advertises, or ''.

    LinkedIn's own share preview points at a media.licdn.com URL signed with
    e=2147483647 — i.e. never expires — and the page renders for a logged-out
    fetch. That makes it the only way back to a thumbnail once the API's signed
    URL has died, and it works for posts far outside the API's ~50-post window.
    LinkedIn's generic brand logo (static.licdn.com/aero-…) is what it serves
    when a post has no media of its own, so treat that as no image."""
    u = str(page_url or '')
    if not u.startswith('http'):
        return ''
    try:
        r = requests.get(u, timeout=20, headers={'User-Agent': _BROWSER_UA})
        if r.status_code != 200 or not r.text:
            return ''
        m = _OG_IMAGE_RE.search(r.text) or _OG_IMAGE_RE2.search(r.text)
        img = html_lib.unescape(m.group(1)).strip() if m else ''
        if not img.startswith('http') or 'static.licdn.com' in img:
            return ''
        return img
    except Exception:
        return ''


def _rescue_dead_thumbs(sc):
    """Last-resort thumbnail repair, run AFTER _mirror_scorecard_images.

    Anything the mirror left on a third-party CDN could not be fetched — an
    expired signature — and will render as a broken tile forever; a post with no
    image at all renders as a type placeholder. Both are recoverable from the
    post's public permalink via og:image, so re-derive those and mirror the
    result. Scoped to LinkedIn: its post pages are readable logged-out, while
    Meta/TikTok permalinks are not. Bounded work — only broken posts are
    fetched — and every failure simply leaves the post as it was."""
    if not isinstance(sc, dict):
        return 0
    targets = []
    for c in (sc.get('platforms') or []):
        if not isinstance(c, dict) or c.get('platform') != 'linkedin':
            continue
        for lst in ('posts', 'top_posts'):
            for p in (c.get(lst) or []):
                if not isinstance(p, dict) or not p.get('url'):
                    continue
                if not p.get('image') or _is_expiring_thumb(p.get('image')):
                    targets.append(p)
    if not targets:
        return 0
    fixed = 0
    try:
        with ThreadPoolExecutor(max_workers=min(4, len(targets))) as ex:
            found = list(ex.map(lambda p: _og_image(p.get('url')), targets))
        for p, img in zip(targets, found):
            if not img:
                continue
            mirrored = _mirror_image(img)
            # Only worth taking if it's durable, or if there was nothing before.
            if not _is_expiring_thumb(mirrored) or not p.get('image'):
                p['image'] = mirrored
                fixed += 1
    except Exception as e:
        print('thumb rescue failed: %s' % str(e)[:160])
    return fixed


def _mirror_scorecard_images(sc):
    """Swap every expiring CDN thumbnail in a scorecard for a durable S3 copy.
    Covers posts[], top_posts[] and card-level image_urls[] on both platform and
    competitor cards, so EVERY capture path (Apify scrape, native Meta/LinkedIn/
    YouTube/TikTok pull, backfill, daily cron) is fixed at the one choke point
    they all funnel through. Unique URLs are fetched once, concurrently."""
    if not isinstance(sc, dict):
        return
    cards = [c for c in (sc.get('platforms') or []) if isinstance(c, dict)]
    cards += [c for c in (sc.get('competitors') or []) if isinstance(c, dict)]
    seen = set()
    for c in cards:
        for lst in ('posts', 'top_posts'):
            for p in (c.get(lst) or []):
                if isinstance(p, dict) and p.get('image'):
                    seen.add(p['image'])
        for u in (c.get('image_urls') or []):
            if u:
                seen.add(u)
    urls = [u for u in seen if str(u).startswith('http')]
    if not urls:
        return
    mapped = {}
    try:
        with ThreadPoolExecutor(max_workers=min(8, len(urls))) as ex:
            for u, new in zip(urls, ex.map(_mirror_image, urls)):
                if new and new != u:
                    mapped[u] = new
    except Exception as e:
        print('thumb mirror batch failed: %s' % str(e)[:160])
        return
    if not mapped:
        return
    for c in cards:
        for lst in ('posts', 'top_posts'):
            for p in (c.get(lst) or []):
                if isinstance(p, dict) and mapped.get(p.get('image')):
                    p['image'] = mapped[p['image']]
        if c.get('image_urls'):
            c['image_urls'] = [mapped.get(u, u) for u in c['image_urls']]


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
    if isinstance(scorecard, dict):
        _strip_fb_reach_er(scorecard)      # invariant: FB has no reach-based ER
        # Every write funnels through here — cron capture, the manual "Capture
        # this month", each native backfill — so it's the one place that can keep
        # the LinkedIn grid honest no matter which path produced it.
        _trim_linkedin_posts_to_month(scorecard, month)
        _mirror_scorecard_images(scorecard)   # thumbnails must outlive the CDN signature
        _rescue_dead_thumbs(scorecard)        # …and whatever the mirror couldn't fetch
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

    # Daily time-series — a LIVE scrape reflects today's numbers (whatever month
    # bucket it's filed under), so stamp a daily KPI snapshot dated today. Manual
    # past-month entries (typed/PDF) aren't live, so they don't write a daily point.
    if data.get('live') and (kpis or {}):
        try:
            _rdays().put_item(Item=_enc({
                'projectId': pid, 'date': _sgt_date(),
                'kpis': kpis, 'month': month, 'savedAt': now, 'savedBy': who,
            }))
        except Exception:
            pass
    return {'ok': True, 'month': month, 'months': _dec(_enc(idx))}


def _sgt_date():
    """SGT (UTC+8) calendar date — the agency's market and the day a 06:00-SGT
    cron run represents."""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime('%Y-%m-%d')


def report_daily_series(body):
    """Daily KPI time-series for a project's Overview charts. Returns up to the
    most recent `days` daily snapshots (default 90, max 400), oldest-first.

    Full daily KPI rows live in social_report_days (forward-accruing). To give the
    followers chart immediate history, we ALSO backfill a followers-by-day series
    from the long-standing sma_snapshots table and merge it underneath — real day
    rows always win; backfilled dates carry followers only."""
    data = body.get('data') or {}
    pid  = (body.get('projectId') or data.get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    days = int(body.get('days') or data.get('days') or 90)
    days = max(1, min(days, 400))

    resp = _rdays().query(KeyConditionExpression=Key('projectId').eq(pid),
                          ScanIndexForward=False, Limit=days)
    by_date = {r['date']: r for r in (_dec(it) for it in resp.get('Items', [])) if r.get('date')}

    try:
        proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
        if proj:
            proj = _dec(proj)
            brand = (proj.get('brand') or proj.get('name') or '').strip().lower()
            for date, fol in _followers_by_date(brand, proj.get('platforms') or [], days).items():
                if date not in by_date:
                    by_date[date] = {'projectId': pid, 'date': date,
                                     'kpis': {'followers': fol}, 'backfilled': True}
                elif (by_date[date].get('kpis') or {}).get('followers') is None:
                    by_date[date].setdefault('kpis', {})['followers'] = fol
    except Exception:
        pass   # backfill is best-effort; never break the real series

    series = sorted(by_date.values(), key=lambda r: str(r.get('date')))[-days:]
    return {'series': series}


def _followers_by_date(brand, platforms, days):
    """Daily total followers from sma_snapshots: per platform, take the last value
    of each SGT day, forward-fill across the window, then sum — so the total line
    stays smooth even when a platform misses a day."""
    if not brand or not platforms:
        return {}
    cutoff = int(time.time() - (days + 2) * 86400)
    plat_series, all_dates = {}, set()
    for p in platforms:
        try:
            resp = _snaps().query(
                KeyConditionExpression=Key('brand_platform').eq(f'{brand}#{p}') & Key('ts').gte(cutoff),
                ScanIndexForward=True)
        except Exception:
            continue
        dmap = {}
        for it in resp.get('Items', []):
            fol = it.get('followers')
            if fol is None:
                continue
            d = (datetime.fromtimestamp(float(it['ts']), timezone.utc) + timedelta(hours=8)).strftime('%Y-%m-%d')
            dmap[d] = int(fol)   # later ts in the same day overwrites
        if dmap:
            plat_series[p] = dmap
            all_dates.update(dmap.keys())
    if not all_dates:
        return {}
    dates = sorted(all_dates)
    out = {}
    for dmap in plat_series.values():
        last = None
        for d in dates:
            if d in dmap:
                last = dmap[d]
            if last is not None:
                out[d] = out.get(d, 0) + last
    return out

def meta_pages(body):
    """List the pages the agency's Meta system-user token can actually read
    (assigned + accessible), so the UI can show which clients are 'Meta-ready'
    (free private insights) and let the user match handles to them."""
    if not META_ACCESS_TOKEN:
        return {'configured': False, 'pages': [], 'count': 0}
    pages = _meta_pages(META_ACCESS_TOKEN)
    out = []
    for p in pages:
        iba = p.get('instagram_business_account') or {}
        out.append({'id': p.get('id'), 'name': p.get('name'),
                    'username': p.get('username'),
                    'ig_username': iba.get('username'), 'has_ig': bool(iba.get('id'))})
    out.sort(key=lambda x: (x.get('name') or '').lower())
    return {'configured': True, 'count': len(out), 'pages': out}


def report_backfill_meta(body):
    """Backfill ONE past month using Meta only (free, historical). Pulls the
    private IG/FB insights + post grid for `month` and merges them into that
    month — leaving any non-Meta platforms (LinkedIn/TikTok/etc.) untouched,
    since scraping those can't reconstruct a past month and would cost Apify.
    Returns has_data so a caller can walk backwards until Meta runs dry."""
    pid   = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    month = (body.get('month') or (body.get('data') or {}).get('month') or '').strip()
    if not pid or not re.match(r'^\d{4}-\d{2}$', month):
        raise RuntimeError('Need projectId + month (YYYY-MM).')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    try:
        meta_platforms = _cron_meta_platforms(proj, month)
    except Exception as e:
        return {'ok': False, 'month': month, 'has_data': False, 'meta_error': str(e)[:200]}
    # "Has data" = anything period-specific came back (followers alone is the
    # current value, so it doesn't count as historical evidence).
    def _has(c):
        return bool(c.get('posts')) or any(c.get(k) is not None for k in
                   ('reach', 'impressions', 'engagements', 'profile_views', 'saves'))
    has_data = any(_has(c) for c in meta_platforms)
    if not has_data:
        return {'ok': True, 'month': month, 'has_data': False,
                'platforms': [c.get('platform') for c in meta_platforms]}
    # Merge into the existing month so a prior capture's other platforms survive.
    existing = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    prev_sc, prev_recs = {}, None
    if existing:
        prev_recs = _dec(existing.get('recommendations'))
        if isinstance(existing.get('scorecard'), str):
            try: prev_sc = json.loads(existing['scorecard'])
            except ValueError: prev_sc = {}
    sc = _merge_meta_platforms(prev_sc or {}, meta_platforms)
    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs},
                       'currentUser': {'email': 'meta-backfill@auto'}})
    return {'ok': True, 'month': month, 'has_data': True,
            'platforms': [c.get('platform') for c in meta_platforms]}


def report_backfill_linkedin(body):
    """Backfill ONE past month of LinkedIn org analytics using the per-client
    connected token (free). LinkedIn keeps a rolling ~12-month window of share &
    follower stats, so a caller can walk backwards until it runs dry. Merges into
    the month, leaving other platforms untouched. Returns has_data."""
    pid   = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    month = (body.get('month') or (body.get('data') or {}).get('month') or '').strip()
    if not pid or not re.match(r'^\d{4}-\d{2}$', month):
        raise RuntimeError('Need projectId + month (YYYY-MM).')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    try:
        li_platforms = _cron_linkedin_platforms(proj, month)
    except Exception as e:
        return {'ok': False, 'month': month, 'has_data': False, 'li_error': str(e)[:200]}
    # Period-specific evidence (followers alone is the CURRENT value, not history).
    def _has(c):
        return bool(c.get('posts')) or any(c.get(k) is not None for k in
                   ('impressions', 'reach', 'engagements', 'clicks', 'followers_increase'))
    if not any(_has(c) for c in li_platforms):
        return {'ok': True, 'month': month, 'has_data': False,
                'platforms': [c.get('platform') for c in li_platforms]}
    existing = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    prev_sc, prev_recs = {}, None
    if existing:
        prev_recs = _dec(existing.get('recommendations'))
        if isinstance(existing.get('scorecard'), str):
            try: prev_sc = json.loads(existing['scorecard'])
            except ValueError: prev_sc = {}
    sc = _merge_meta_platforms(prev_sc or {}, li_platforms)
    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs},
                       'currentUser': {'email': 'linkedin-backfill@auto'}})
    return {'ok': True, 'month': month, 'has_data': True,
            'platforms': [c.get('platform') for c in li_platforms]}


def _report_backfill_native(body, builder, who, has_keys, err_key):
    """Shared backfill: pull ONE past month for a single platform family via a
    native `builder(proj, month)` and merge it into that month, leaving other
    platforms untouched. `has_keys` are the period-specific metric fields that
    count as historical evidence (followers alone is the CURRENT value, so it's
    excluded) — used to compute has_data so a caller can walk backwards until the
    platform runs dry. Mirrors report_backfill_meta/linkedin exactly."""
    pid   = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    month = (body.get('month') or (body.get('data') or {}).get('month') or '').strip()
    if not pid or not re.match(r'^\d{4}-\d{2}$', month):
        raise RuntimeError('Need projectId + month (YYYY-MM).')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    try:
        cards = builder(proj, month)
    except Exception as e:
        return {'ok': False, 'month': month, 'has_data': False, err_key: str(e)[:200]}
    def _has(c):
        return bool(c.get('posts')) or any(c.get(k) is not None for k in has_keys)
    if not any(_has(c) for c in cards):
        return {'ok': True, 'month': month, 'has_data': False,
                'platforms': [c.get('platform') for c in cards]}
    existing = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    prev_sc, prev_recs = {}, None
    if existing:
        prev_recs = _dec(existing.get('recommendations'))
        if isinstance(existing.get('scorecard'), str):
            try: prev_sc = json.loads(existing['scorecard'])
            except ValueError: prev_sc = {}
    sc = _merge_meta_platforms(prev_sc or {}, cards)
    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs},
                       'currentUser': {'email': who}})
    return {'ok': True, 'month': month, 'has_data': True,
            'platforms': [c.get('platform') for c in cards]}


def report_backfill_youtube(body):
    """Backfill ONE past month of native YouTube channel analytics + uploads via
    the per-client offline token. YouTube keeps full history, so a caller can walk
    back years until it runs dry. Merges into the month, other platforms intact."""
    return _report_backfill_native(
        body, _cron_youtube_platforms, 'youtube-backfill@auto',
        ('impressions', 'views', 'reach', 'engagements', 'net_new_followers'), 'yt_error')


def report_backfill_tiktok(body):
    """Backfill TikTok via the per-client token. TikTok's Display API has no
    historical analytics, so only the CURRENT month returns data; past months
    report has_data:false and the walk-back stops immediately."""
    return _report_backfill_native(
        body, _cron_tiktok_platforms, 'tiktok-backfill@auto',
        ('views', 'engagements', 'likes', 'comments', 'shares'), 'tt_error')


def _native_cards_for_month(proj, month):
    """Pull the native (first-party API) cards for every owned platform this
    project tracks, for one month. Each builder self-gates (returns [] when the
    platform isn't tracked or no token is connected). Returns (cards, errors)."""
    cards, errors = [], {}
    for label, builder in (('meta',     _cron_meta_platforms),
                           ('linkedin', _cron_linkedin_platforms),
                           ('youtube',  _cron_youtube_platforms),
                           ('tiktok',   _cron_tiktok_platforms)):
        try:
            cards += builder(proj, month)
        except Exception as e:
            errors[label] = str(e)[:200]
    return cards, errors


def report_native_preview(body):
    """READ-ONLY discrepancy audit. Pulls the native cards for a month WITHOUT
    saving, alongside what's already stored for that month, and returns a
    field-level diff plus the Apify skip-plan the daily cron would use. Never
    writes — safe to run against live client projects to spot native-vs-stored
    discrepancies before committing to a backfill."""
    pid   = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    month = (body.get('month') or (body.get('data') or {}).get('month') or '').strip() or _current_month()
    if not pid or not re.match(r'^\d{4}-\d{2}$', month):
        raise RuntimeError('Need projectId + month (YYYY-MM).')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    native, errors = _native_cards_for_month(proj, month)
    native_by = {c.get('platform'): c for c in native}
    # Stored month scorecard (may not exist yet).
    stored_cards = []
    it = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    if it:
        sc = it.get('scorecard')
        if isinstance(sc, str):
            try: sc = json.loads(sc)
            except ValueError: sc = {}
        stored_cards = (sc or {}).get('platforms') or []
    stored_by = {c.get('platform'): c for c in stored_cards}
    CMP = ['followers', 'reach', 'impressions', 'engagements', 'engagement_rate',
           'likes', 'comments', 'shares', 'saves', 'net_new_followers']
    diffs = []
    for plat, nc in native_by.items():
        sc = stored_by.get(plat) or {}
        row = {'platform': plat, 'in_stored': plat in stored_by,
               'native_posts': len(nc.get('posts') or []),
               'stored_posts': len(sc.get('posts') or []), 'fields': {}}
        for f in CMP:
            nv, sv = nc.get(f), sc.get(f)
            if nv is None and sv is None:
                continue
            row['fields'][f] = {'native': nv, 'stored': sv, 'match': nv == sv}
        diffs.append(row)
    # Apify skip-plan for THIS month: what the daily cron would still scrape.
    handles = proj.get('handles') or {}
    owned_live = [p for p in (proj.get('platforms') or [])
                  if p in ACTORS and (handles.get(p) or '').strip()]
    covered = set(native_by.keys())
    apify_plan = {'covered_natively': sorted(covered & set(owned_live)),
                  'would_scrape_owned': [p for p in owned_live if p not in covered],
                  'competitors': len(proj.get('competitors') or [])}
    return {'month': month, 'native': native, 'stored': stored_cards,
            'diffs': diffs, 'native_errors': errors, 'apify_plan': apify_plan}


def _audience_breakdowns_for(proj, month):
    """Fetch on-demand audience/breakdown data (demographics, traffic sources,
    follower makeup) for every connected platform. Returns
    {platform: {breakdowns:{key:[{name,value}]}, asof:str}} plus an optional
    '_errors' dict. Extended per phase — YouTube (date-range), then LinkedIn +
    Meta (current-state snapshots)."""
    out, errors = {}, {}
    plats   = set(proj.get('platforms') or [])
    handles = proj.get('handles') or {}
    conns   = proj.get('connections') or {}
    # YouTube — true per-report-period breakdowns via the Analytics API.
    try:
        if ('youtube' in plats) or handles.get('youtube'):
            token = _yt_access_token(conns.get('youtube') or {})
            if token:
                ch = _yt_resolve_channel(token)
                if ch and ch.get('id'):
                    bd = _yt_breakdowns(ch['id'], token, month)
                    if bd:
                        out['youtube'] = {'breakdowns': bd, 'asof': 'for ' + month}
    except Exception as e:
        errors['youtube'] = str(e)[:160]
    # LinkedIn — current-audience follower demographics + page-section views.
    try:
        if ('linkedin' in plats) or handles.get('linkedin'):
            token = (conns.get('linkedin') or {}).get('token')
            if token:
                org = _li_resolve_org(proj, token)
                if org and org.get('id'):
                    bd = _li_breakdowns(org['id'], token)
                    if bd:
                        out['linkedin'] = {'breakdowns': bd,
                                           'asof': 'as of ' + datetime.now(timezone.utc).strftime('%d %b %Y')}
    except Exception as e:
        errors['linkedin'] = str(e)[:160]
    # Instagram — current follower demographics (age/gender/country/city).
    try:
        if ('instagram' in plats) or handles.get('instagram'):
            token = (conns.get('meta') or {}).get('token') or META_ACCESS_TOKEN
            if token:
                meta = _meta_resolve(proj, token)
                if meta and meta.get('igId'):
                    bd = _ig_breakdowns(meta['igId'], meta.get('pageToken') or token)
                    if bd:
                        out['instagram'] = {'breakdowns': bd,
                                            'asof': 'as of ' + datetime.now(timezone.utc).strftime('%d %b %Y')}
    except Exception as e:
        errors['instagram'] = str(e)[:160]
    # Facebook — page-level fan demographics, for whichever of the page_fans_*
    # metrics the Page still serves. Nothing back = the audience tab keeps showing
    # its content-performance proxies instead.
    try:
        if ('facebook' in plats) or handles.get('facebook'):
            token = (conns.get('meta') or {}).get('token') or META_ACCESS_TOKEN
            if token:
                meta = _meta_resolve(proj, token)
                if meta and meta.get('pageId'):
                    why = {}
                    bd = _fb_breakdowns(meta['pageId'], meta.get('pageToken') or token, why)
                    if bd:
                        out['facebook'] = {'breakdowns': bd,
                                           'asof': 'as of ' + datetime.now(timezone.utc).strftime('%d %b %Y')}
                    elif why:
                        # Not an outage — record WHY each metric came back empty so the
                        # "Facebook has no demographics" claim stays evidence-backed.
                        errors['facebook'] = '; '.join(
                            '%s: %s' % (k, v) for k, v in sorted(why.items()))[:600]
    except Exception as e:
        errors['facebook'] = str(e)[:160]
    if errors:
        out['_errors'] = errors
    return out


def report_refresh_audience(body):
    """On-demand: pull audience/breakdown data for every connected platform and
    merge it onto the CURRENT month's scorecard cards under card['breakdowns']
    (+ 'breakdowns_asof'). Kept off the hot capture path because these are
    current-state snapshots / extra API calls the user triggers explicitly."""
    pid = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    month = (body.get('month') or '').strip() or _current_month()
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    aud = _audience_breakdowns_for(proj, month)
    errors = aud.pop('_errors', {})
    if not aud:
        return {'ok': True, 'month': month, 'platforms': [], 'errors': errors,
                'note': 'No connected platform returned audience data.'}
    it = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    prev_recs, sc = None, {}
    if it:
        prev_recs = _dec(it.get('recommendations'))
        if isinstance(it.get('scorecard'), str):
            try: sc = json.loads(it['scorecard'])
            except ValueError: sc = {}
        elif isinstance(it.get('scorecard'), dict):
            sc = it['scorecard']
    cards = sc.setdefault('platforms', [])
    by = {c.get('platform'): c for c in cards}
    for plat, payload in aud.items():
        card = by.get(plat)
        if not card:
            card = {'platform': plat, 'found': True}
            cards.append(card); by[plat] = card
        card['breakdowns'] = payload['breakdowns']
        card['breakdowns_asof'] = payload.get('asof')
    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs},
                       'currentUser': {'email': 'audience-refresh@auto'}})
    return {'ok': True, 'month': month, 'platforms': list(aud.keys()),
            'breakdown_keys': {p: list(v['breakdowns'].keys()) for p, v in aud.items()},
            'errors': errors}


def _notify_alert(text):
    """Best-effort push to a Google Chat incoming webhook (SR_ALERT_WEBHOOK). No-op
    if the webhook isn't configured, so alerts degrade to the returned payload."""
    hook = os.environ.get('SR_ALERT_WEBHOOK', '')
    if not hook:
        return False
    try:
        requests.post(hook, json={'text': text}, timeout=10)
        return True
    except Exception:
        return False


def _conn_days_left(c):
    """Days until a stored token expires, from connect-time `at` (epoch ms) +
    `expires_in` (s). None when the token is non-expiring / unknown."""
    at, exp = c.get('at'), c.get('expires_in')
    if not (at and exp):
        return None
    try:
        return int((int(at) / 1000 + int(exp) - time.time()) / 86400)
    except (ValueError, TypeError):
        return None


def _connection_status(proj):
    """Per-platform connection health for one project. Actually validates each
    stored token against the platform (resolves the page/org/channel), so it
    catches stale/revoked tokens + unresolvable handles — the silent failure
    modes that quietly degrade the daily pull to Apify or nothing.
    status ∈ ok | expiring | reconnect | no_match | no_org | error | not_connected."""
    conns = proj.get('connections') or {}
    plats = set(proj.get('platforms') or [])
    handles = proj.get('handles') or {}
    def tracked(p): return (p in plats) or bool(handles.get(p))
    out = []

    def base(platform, label, c):
        st = {'platform': platform, 'label': label, 'connected': False,
              'name': c.get('name'), 'connected_at': c.get('at')}
        dl = _conn_days_left(c)
        if dl is not None:
            st['days_left'] = dl
        return st

    if tracked('instagram') or tracked('facebook'):
        c = conns.get('meta') or {}; token = c.get('token')
        st = base('meta', 'Meta (Instagram / Facebook)', c); st['connected'] = bool(token)
        if not token:
            st['status'] = 'not_connected'; st['detail'] = 'Not connected — public scrape only (no reach/impressions/demographics).'
        else:
            try:
                meta = _meta_resolve(proj, token)
                if meta and (meta.get('pageId') or meta.get('igId')):
                    st['status'] = 'ok'; st['resolved'] = meta.get('pageName') or meta.get('igName')
                    st['detail'] = 'Connected: ' + (st['resolved'] or 'page resolved')
                else:
                    st['status'] = 'no_match'; st['detail'] = 'Token works but no Page/IG matched this handle — check the handle in Settings.'
            except Exception as e:
                st['status'] = 'error'; st['detail'] = 'Token error — reconnect. ' + str(e)[:100]
            if st.get('status') == 'ok' and st.get('days_left') is not None and st['days_left'] <= 7:
                st['status'] = 'expiring'; st['detail'] = f"Token expires in ~{st['days_left']}d — reconnect soon."
        out.append(st)

    if tracked('linkedin'):
        c = conns.get('linkedin') or {}; token = c.get('token')
        st = base('linkedin', 'LinkedIn', c); st['connected'] = bool(token)
        if not token:
            st['status'] = 'not_connected'; st['detail'] = 'Not connected — public scrape only.'
        else:
            try:
                org = _li_resolve_org(proj, token)
                if org and org.get('id'):
                    st['status'] = 'ok'; st['resolved'] = org.get('name'); st['detail'] = 'Admin of ' + (org.get('name') or 'company page')
                else:
                    st['status'] = 'no_org'; st['detail'] = 'Connected but no ADMIN company page matched — analytics & demographics unavailable.'
            except Exception as e:
                st['status'] = 'error'; st['detail'] = 'Token error — reconnect. ' + str(e)[:100]
            if st.get('status') == 'ok' and st.get('days_left') is not None and st['days_left'] <= 7:
                st['status'] = 'expiring'; st['detail'] = f"Token expires in ~{st['days_left']}d — reconnect soon."
        out.append(st)

    if tracked('youtube'):
        c = conns.get('youtube') or {}
        has = bool(c.get('token') or c.get('refresh_token'))
        st = base('youtube', 'YouTube', c); st['connected'] = has
        if not has:
            st['status'] = 'not_connected'; st['detail'] = 'Not connected — public scrape only.'
        elif not c.get('refresh_token'):
            st['status'] = 'reconnect'; st['detail'] = 'Legacy sign-in (no refresh token) — reconnect for unattended pulls + analytics/demographics.'
        else:
            try:
                token = _yt_access_token(c)
                ch = _yt_resolve_channel(token) if token else None
                if ch and ch.get('id'):
                    st['status'] = 'ok'; st['resolved'] = ch.get('title'); st['detail'] = 'Channel: ' + (ch.get('title') or 'resolved')
                else:
                    st['status'] = 'error'; st['detail'] = 'Token no longer valid — reconnect.'
            except Exception as e:
                st['status'] = 'error'; st['detail'] = 'Token error — reconnect. ' + str(e)[:100]
        out.append(st)

    if tracked('tiktok'):
        c = conns.get('tiktok') or {}
        has = bool(c.get('token') or c.get('refresh_token'))
        st = base('tiktok', 'TikTok', c); st['connected'] = has
        if not has:
            st['status'] = 'not_connected'; st['detail'] = 'Not connected — public scrape only.'
        elif not c.get('refresh_token'):
            st['status'] = 'reconnect'; st['detail'] = 'Legacy sign-in (no refresh token) — reconnect once for unattended monthly pulls.'
        else:
            try:
                token = _tt_access_token(c)
                info = (_tt_call('GET', '/user/info/', token, {'fields': 'display_name'}).get('user')) if token else None
                if info is not None:
                    st['status'] = 'ok'; st['resolved'] = info.get('display_name'); st['detail'] = 'Connected: ' + (info.get('display_name') or c.get('name') or 'account')
                else:
                    st['status'] = 'error'; st['detail'] = 'Token no longer valid — reconnect.'
            except Exception as e:
                st['status'] = 'error'; st['detail'] = 'Token error — reconnect. ' + str(e)[:100]
        out.append(st)

    return out


def report_connections_health(body):
    """On-demand connection health for ONE project (Settings panel + roster badges)."""
    pid = (body.get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)
    conns = _connection_status(proj)
    bad = [c for c in conns if c.get('status') in ('error', 'reconnect', 'expiring', 'no_org', 'no_match')]
    return {'projectId': pid, 'name': proj.get('name'), 'connections': conns,
            'needs_attention': len(bad)}


# Statuses that warrant a heads-up in the token audit (not the benign
# not-connected / ok ones).
_CONN_ALERT = {'error', 'reconnect', 'expiring', 'no_org', 'no_match'}


def report_connections_audit(body):
    """Scan every project, validate all connected tokens, and push a digest of
    stale/expiring/failing connections to SR_ALERT_WEBHOOK. Fired by EventBridge
    (weekly). Runs inline — token checks are light and this isn't time-critical."""
    resp = _rprojects().scan()
    items = resp.get('Items', [])
    while resp.get('LastEvaluatedKey'):
        resp = _rprojects().scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    problems = []
    for it in items:
        proj = _dec(it)
        try:
            for st in _connection_status(proj):
                if st.get('status') in _CONN_ALERT:
                    problems.append({'client': proj.get('name') or proj.get('projectId'),
                                     'platform': st['label'], 'status': st['status'],
                                     'detail': st.get('detail')})
        except Exception:
            continue
    if problems:
        lines = ['⚠️ *Social Reports — connection health* (%d issue%s)' % (len(problems), '' if len(problems) == 1 else 's'), '']
        for p in problems[:40]:
            lines.append(f"• *{p['client']}* — {p['platform']}: {p['status']} — {p['detail']}")
        _notify_alert('\n'.join(lines))
    return {'ok': True, 'scanned': len(items), 'problems': problems}


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
            'recs_block': _dec(it.get('recs_block')),
            'savedAt': it.get('savedAt'), 'savedBy': it.get('savedBy')}

def report_fix_thumbs(body):
    """Repair the stored thumbnails of ONE month, in place.

    Months captured before the S3 mirror existed still point at signed CDN URLs
    that have since expired, so their post grids render as broken tiles. This
    re-runs the mirror (rescuing anything still fetchable) and then the og:image
    rescue (for the rest), and writes the scorecard back — touching nothing else
    on the item, so KPIs, recommendations and tags are untouched. Idempotent: a
    month whose thumbnails are already on S3 does no network work at all."""
    pid   = (body.get('projectId') or (body.get('data') or {}).get('projectId') or '').strip()
    month = (body.get('month') or (body.get('data') or {}).get('month') or '').strip()
    if not pid or not re.match(r'^\d{4}-\d{2}$', month):
        raise RuntimeError('Need projectId + month (YYYY-MM).')
    it = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
    if not it:
        raise RuntimeError('No data captured for that month.')
    sc = it.get('scorecard')
    if isinstance(sc, str):
        try: sc = json.loads(sc)
        except ValueError: sc = {}
    if not isinstance(sc, dict):
        return {'ok': False, 'month': month, 'error': 'unreadable scorecard'}

    def _thumb_state(scorecard):
        durable = broken = 0
        for c in (scorecard.get('platforms') or []):
            for p in (c.get('posts') or []) if isinstance(c, dict) else []:
                img = p.get('image') if isinstance(p, dict) else None
                if img and not _is_expiring_thumb(img):
                    durable += 1
                elif not img or _is_expiring_thumb(img):
                    broken += 1
        return durable, broken

    before = _thumb_state(sc)
    _mirror_scorecard_images(sc)
    _rescue_dead_thumbs(sc)
    after = _thumb_state(sc)
    if after[0] > before[0]:
        _rmonths().update_item(
            Key={'projectId': pid, 'month': month},
            UpdateExpression='SET scorecard = :s',
            ExpressionAttributeValues={':s': _serialize_scorecard(sc)})
    return {'ok': True, 'month': month,
            'durable_before': before[0], 'durable_after': after[0],
            'still_missing': after[1]}


_SPLIT_KEYS = ('organic_impressions', 'paid_impressions',
               'organic_engagement_rate', 'paid_engagement_rate')


def _backfill_month_splits(proj, month, token, meta, force=False):
    """Add the organic/paid split to ONE already-saved month, in place.

    Writes ONLY the four split keys onto the Meta platform cards of the stored
    scorecard. Every other field — impressions, reach, posts, thumbnails, tags,
    kpis, recommendations — is left exactly as captured, so a backfill can never
    rewrite history with today's numbers. Idempotent: a card that already has the
    split does no network work unless `force`.

    The month's `kpis` blob is deliberately NOT recomputed. The split is only ever
    read off the scorecard (aggregateRange rebuilds its rows client-side), so
    touching kpis would be risk without benefit.

    Returns a short status string for the run log."""
    it = _rmonths().get_item(Key={'projectId': proj['projectId'], 'month': month}).get('Item')
    if not it:
        return 'no month row'
    sc = it.get('scorecard')
    if isinstance(sc, str):
        try: sc = json.loads(sc)
        except ValueError: sc = None
    if not isinstance(sc, dict):
        return 'unreadable scorecard'
    cards = {c.get('platform'): c for c in (sc.get('platforms') or []) if isinstance(c, dict)}
    todo = [p for p in ('instagram', 'facebook')
            if cards.get(p) and (force or not any(k in cards[p] for k in _SPLIT_KEYS))]
    if not todo:
        return 'already split'

    since, until = _meta_month_range(month)
    tv = {'metric_type': 'total_value'}
    wrote = []

    if 'facebook' in todo and meta.get('pageId'):
        d = _meta_split_metric(meta['pageId'], 'page_media_view', meta['pageToken'],
                               since, until, 'is_from_ads')
        if d:
            card = cards['facebook']
            # '0'/'1' are organic/paid. A bucket Meta omits is genuinely zero, and
            # the two sum to the card's existing impressions total.
            card['organic_impressions'] = int(d.get('0') or 0)
            card['paid_impressions']    = int(d.get('1') or 0)
            wrote.append('fb')

    if 'instagram' in todo and meta.get('igId'):
        def _split(metric):
            d = _meta_split_metric(meta['igId'], metric, meta['pageToken'],
                                   since, until, 'media_product_type', tv)
            if not d:
                return None, None
            paid = _num(d.get('AD')) or 0
            return sum(v for k, v in d.items() if k != 'AD'), paid
        card = cards['instagram']
        oi, pi = _split('views')
        if oi is not None:
            card['organic_impressions'] = int(oi)
            card['paid_impressions']    = int(pi)
        oint, pint = _split('total_interactions')
        orch, prch = _split('reach')
        # Per bucket, never by subtraction: the reach buckets each count uniques
        # within themselves, so organic ≠ total − paid.
        if orch:
            card['organic_engagement_rate'] = round((oint or 0) / orch * 100, 2)
        if prch:
            card['paid_engagement_rate'] = round((pint or 0) / prch * 100, 2)
        if oi is not None or orch:
            wrote.append('ig')

    if not wrote:
        return 'no data returned'
    _rmonths().update_item(
        Key={'projectId': proj['projectId'], 'month': month},
        UpdateExpression='SET scorecard = :s',
        ExpressionAttributeValues={':s': _serialize_scorecard(sc)})
    return 'wrote ' + '+'.join(wrote)


_POST_METRIC_KEYS = ('reach', 'interactions', 'interaction_rate',
                     'reactions_by_type', 'views')


def _backfill_month_posts(proj, month, token, meta, force=False):
    """Recover per-post Facebook metrics for ONE already-saved month, in place.

    Months captured before the 2026-07-17 fb413a25 fix stored their posts BARE:
    the dead `post_impressions_unique` sat in the same comma-separated metric
    list as the live ones, and Graph rejects the whole call if any single metric
    in that list is invalid, so every per-post figure came back empty. Measured
    2026-07-21 across 14 FB clients: only 31% of stored posts carry reach (82%
    for 2026-07 against ~20-30% for every earlier month). Without this, the
    Audience tab's Facebook card and the report's Post Format table are thin for
    all of history. Meta still serves insights for months-old posts — proved live
    on Marina One 2026-06, where all 14 posts went 0 → 14 with reach.

    Same additive contract as _backfill_month_splits: writes ONLY the per-post
    metric keys, and only onto posts already stored. Card-level figures, kpis,
    captions, timestamps, thumbnails and tags are left exactly as captured, so a
    month already sent to a client keeps the numbers it was sent with.

    Deliberately NOT via _merge_posts: that picks whichever post set carries more
    thumbnails as its base, which would swap the S3-mirrored images back to
    fbcdn URLs that expire in ~2 weeks. Field-level donation avoids that.

    Facebook only — the bug was in _meta_fb_post_metrics; Instagram posts stored
    their metrics fine throughout.

    Idempotent: a month whose stored posts all carry reach does no network work
    unless `force`. Returns a short status string for the run log."""
    it = _rmonths().get_item(Key={'projectId': proj['projectId'], 'month': month}).get('Item')
    if not it:
        return 'no month row'
    sc = it.get('scorecard')
    if isinstance(sc, str):
        try: sc = json.loads(sc)
        except ValueError: sc = None
    if not isinstance(sc, dict):
        return 'unreadable scorecard'
    card = next((c for c in (sc.get('platforms') or [])
                 if isinstance(c, dict) and c.get('platform') == 'facebook'), None)
    if not card or not isinstance(card.get('posts'), list) or not card['posts']:
        return 'no fb posts stored'
    stored = card['posts']
    missing = [p for p in stored if isinstance(p, dict) and p.get('reach') is None]
    if not missing and not force:
        return 'already has post metrics'
    if not meta or not meta.get('pageId'):
        return 'no fb page resolved'
    targets = stored if force else missing

    since, until = _meta_month_range(month)
    # A scorecard routinely holds posts published OUTSIDE its month: a public
    # Apify capture sweeps in whatever the page had recently, so Singapore Pools'
    # July card carries ten May/June posts — and those are exactly the ones still
    # missing metrics, because the native pull that would have filled them only
    # ever covered July. Widen the window to span what we are actually trying to
    # fill, or they can never match. Capped at 400 days so one stray timestamp
    # can't turn a month into a year-long pull; the posts edge is limit=50, so an
    # over-wide window would push the oldest posts out of reach anyway.
    stamps = [t for t in (_to_epoch(p.get('ts')) for p in targets if isinstance(p, dict)) if t]
    if stamps:
        since = max(min(since, int(min(stamps)) - 86400), until - 400 * 86400)
        until = min(max(until, int(max(stamps)) + 86400), int(time.time()))
    fresh = _meta_fb_posts(meta['pageId'], meta.get('pageToken') or token, since, until)
    if not fresh:
        return 'no data returned'
    by_url, by_text = {}, {}
    for f in fresh:
        u = f.get('url')
        if u:
            by_url.setdefault(u, f)
        k = _post_text_key(f)
        if k:
            by_text.setdefault(k, f)

    filled = 0
    for p in targets:
        if not isinstance(p, dict):
            continue
        f = by_url.get(p.get('url')) or by_text.get(_post_text_key(p))
        if not f:
            continue
        got = False
        for k in _POST_METRIC_KEYS:
            v = f.get(k)
            if v is None or (p.get(k) is not None and not force):
                continue
            p[k] = v
            got = True
        if got:
            filled += 1
    if not filled:
        return 'no match for %d post(s) among %d fetched' % (len(targets), len(fresh))
    _rmonths().update_item(
        Key={'projectId': proj['projectId'], 'month': month},
        UpdateExpression='SET scorecard = :s',
        ExpressionAttributeValues={':s': _serialize_scorecard(sc)})
    return 'wrote posts x' + str(filled)


def report_backfill_splits(body):
    """Backfill the organic/paid split across saved months.

    Months captured before 2026-07-21 have no split, so their reports show dashes
    in the Organic/Paid columns. Meta serves both breakdowns for historical windows
    (probed: Facebook returns them ~23 months back), so this re-fetches JUST the
    split and merges it in — see _backfill_month_splits for the additive contract.

    Only Instagram and Facebook are touched. LinkedIn's figures are already
    organic-only by definition, and TikTok/YouTube/Xiaohongshu have no split to
    fetch — those stay dashes until someone types them in.

    `what` selects which filler(s) run over each month — both share this sweep
    because both are the same job: re-fetch one narrow slice of a saved month and
    merge it in without disturbing anything else.
      'splits' (default) — organic/paid, _backfill_month_splits
      'posts'            — per-post FB metrics, _backfill_month_posts
      'both'             — splits then posts

    data: {projectId?, sinceMonth?='YYYY-MM' floor, force?, maxSeconds?, what?}
    Omit projectId to sweep every project. Time-boxed so a big sweep returns a
    resumable report instead of dying on the Lambda timeout — re-invoke to
    continue, since months already done are skipped for free.
    Intended to be called directly via `lambda invoke`, not through the API —
    the HTTP API gives up at 30s while the Lambda keeps running and still writes,
    so an API caller cannot tell a finished month from a dropped one."""
    data  = body.get('data') or body
    only  = (data.get('projectId') or '').strip()
    floor = (data.get('sinceMonth') or '').strip()
    force = bool(data.get('force'))
    budget = float(data.get('maxSeconds') or 600)
    what  = (data.get('what') or 'splits').strip().lower()
    if what not in ('splits', 'posts', 'both'):
        raise RuntimeError("what must be 'splits', 'posts' or 'both'.")
    fillers = ([] if what == 'posts' else [_backfill_month_splits]) + \
              ([] if what == 'splits' else [_backfill_month_posts])
    t0 = time.time()

    if only:
        it = _rprojects().get_item(Key={'projectId': only}).get('Item')
        projs = [it] if it else []
    else:
        projs, resp = [], _rprojects().scan()
        projs.extend(resp.get('Items') or [])
        while resp.get('LastEvaluatedKey'):
            resp = _rprojects().scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
            projs.extend(resp.get('Items') or [])

    out, done, skipped, failed, timed_out = [], 0, 0, 0, False
    for raw in projs:
        proj = _dec(raw)
        pid  = proj.get('projectId')
        months = sorted({m.get('month') for m in (proj.get('months') or [])
                         if isinstance(m, dict) and m.get('month')})
        if floor:
            months = [m for m in months if m >= floor]
        if not pid or not months:
            continue
        token = ((proj.get('connections') or {}).get('meta') or {}).get('token') or META_ACCESS_TOKEN
        meta  = _meta_resolve(proj, token) if token else None
        if not meta:
            out.append({'project': proj.get('name') or pid, 'months': len(months),
                        'result': 'no Meta connection — skipped'})
            skipped += len(months)
            continue
        rows = []
        for m in months:
            if time.time() - t0 > budget:
                timed_out = True
                break
            parts = []
            for fill in fillers:
                try:
                    r = fill(proj, m, token, meta, force)
                except Exception as e:
                    r = 'error: ' + str(e)[:120]
                    failed += 1
                if r.startswith('wrote'):
                    done += 1
                elif r in ('already split', 'already has post metrics'):
                    skipped += 1
                parts.append(r)
            rows.append({'month': m, 'result': ' | '.join(parts)})
        out.append({'project': proj.get('name') or pid, 'rows': rows})
        if timed_out:
            break
    return {'ok': True, 'written': done, 'skipped': skipped, 'failed': failed,
            'timed_out': timed_out, 'elapsed': round(time.time() - t0, 1),
            'projects': out}


def report_save_recs(body):
    """Persist the AI 'Channel recommendations' block for a month WITHOUT touching
    the scorecard/kpis/month-index — used when the user generates or inline-edits the
    monthly report's recommendations, so they survive reloads. Stored on its own
    attribute (recs_block) separate from the minimal scorecard `recommendations`."""
    data  = body.get('data') or body
    pid   = (data.get('projectId') or '').strip()
    month = (data.get('month') or '').strip()
    if not pid or not month:
        raise RuntimeError('Missing projectId or month.')
    block = data.get('recs_block')
    now = _now_iso(); who = _who(body)
    if block is None:
        _rmonths().update_item(
            Key={'projectId': pid, 'month': month},
            UpdateExpression='REMOVE recs_block SET recs_savedAt = :t, recs_savedBy = :w',
            ExpressionAttributeValues={':t': now, ':w': who})
    else:
        _rmonths().update_item(
            Key={'projectId': pid, 'month': month},
            UpdateExpression='SET recs_block = :b, recs_savedAt = :t, recs_savedBy = :w',
            ExpressionAttributeValues={':b': _enc(block), ':t': now, ':w': who})
    return {'ok': True}

def report_backfill_platform_kpis(body):
    """One-time backfill: enrich each stored month's per-platform KPI slice for
    historical months so per-platform trend charts have data for EVERY metric (the
    a27de09 `_plat_metrics` slice), not just followers + engagement_rate.

    Recomputes ONLY from each month's already-saved scorecard — no re-scraping, so
    historical figures are never overwritten with today's numbers. Non-destructive:
    keeps the existing kpis blob intact and replaces ONLY its `per_platform` key
    (skips a month if it has no real scorecard or the recompute yields nothing).
    Updates both the month row and the project's month-index entry.

    Pass data.projectId to scope to one project; omit to sweep all projects.
    Intended to be called directly via `lambda invoke`, not through the API."""
    data = body.get('data') or body
    only_pid = (data.get('projectId') or '').strip()
    now = _now_iso()
    if only_pid:
        it = _rprojects().get_item(Key={'projectId': only_pid}).get('Item')
        projs = [it] if it else []
    else:
        projs, resp = [], _rprojects().scan()
        projs.extend(resp.get('Items', []))
        while resp.get('LastEvaluatedKey'):
            resp = _rprojects().scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
            projs.extend(resp.get('Items', []))
    report = []
    for proj in projs:
        proj = _dec(proj); pid = proj.get('projectId')
        idx = _dec(proj.get('months')) or []
        changed = 0
        for entry in idx:
            month = entry.get('month')
            if not month:
                continue
            row = _rmonths().get_item(Key={'projectId': pid, 'month': month}).get('Item')
            if not row:
                continue
            sc = row.get('scorecard')
            if isinstance(sc, str):
                try: sc = json.loads(sc)
                except ValueError: sc = None
            if not isinstance(sc, dict) or not sc.get('platforms'):
                continue                          # manual/typed month with no real scorecard
            _strip_fb_reach_er(sc)                # match capture-time invariant
            pp = (_kpis_from_scorecard(sc) or {}).get('per_platform') or {}
            if not pp:
                continue
            existing = _dec(row.get('kpis')) or {}
            merged = dict(existing); merged['per_platform'] = pp
            _rmonths().update_item(
                Key={'projectId': pid, 'month': month},
                UpdateExpression='SET kpis = :k, kpis_backfilled_at = :t',
                ExpressionAttributeValues={':k': _enc(merged), ':t': now})
            entry['kpis'] = merged
            changed += 1
        if changed:
            _rprojects().update_item(
                Key={'projectId': pid},
                UpdateExpression='SET months = :m',
                ExpressionAttributeValues={':m': _enc(idx)})
        report.append({'projectId': pid, 'name': proj.get('name'), 'months_recomputed': changed})
    total = sum(r['months_recomputed'] for r in report)
    return {'ok': True, 'projects_scanned': len(projs), 'months_recomputed': total, 'detail': report}

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

# Names a point might use for a platform other than the one it sits under. A
# competitor account name can legitimately contain a platform word ("OCBC
# Facebook"), so the guard below only fires on the platform as a subject.
_PLAT_ALIASES = {
    'facebook':  ('facebook', ' fb ', 'meta page'),
    'instagram': ('instagram', ' ig ', 'reels'),
    'linkedin':  ('linkedin',),
    'tiktok':    ('tiktok', 'tik tok'),
    'youtube':   ('youtube', 'yt shorts'),
    'xiaohongshu': ('xiaohongshu', 'red note', 'rednote', 'xhs'),
}


def _mentions_other_platform(text, own_key, plat_keys):
    """True when a point written under `own_key` is really about a different
    tracked platform — 'Pause Instagram & TikTok, consolidate to LinkedIn' has no
    business sitting in the TikTok section of a per-platform report."""
    t = ' ' + str(text or '').lower() + ' '
    for k in plat_keys:
        if k == own_key:
            continue
        if any(a in t for a in _PLAT_ALIASES.get(k, (k,))):
            return True
    return False


def _rec_platform_blocks(blocks, plat_keys):
    """Pin the model's per-platform recommendation blocks back onto the platform
    keys the report actually has. The model is asked to echo the key verbatim but
    still returns 'Facebook' or 'Meta / Facebook' now and then, so match loosely,
    drop anything that matches nothing (never invent a platform the report can't
    render) and keep the report's own platform order rather than the model's."""
    if not isinstance(blocks, list):
        return []
    by_key = {}
    for b in blocks:
        if not isinstance(b, dict):
            continue
        raw = str(b.get('platform') or '').strip().lower()
        key = next((k for k in plat_keys
                    if k.lower() == raw or (raw and (k.lower() in raw or raw in k.lower()))), None)
        if not key or key in by_key:        # unknown, or a duplicate second block
            continue
        keep = lambda x: x and not _mentions_other_platform(x, key, plat_keys)
        by_key[key] = {
            'platform': key,
            'wins': [str(x) for x in (b.get('wins') or []) if keep(x)],
            'concerns': [str(x) for x in (b.get('concerns') or []) if keep(x)],
            'recommendations': [
                {'title': str(r.get('title') or ''), 'detail': str(r.get('detail') or ''),
                 'priority': str(r.get('priority') or 'medium').lower()}
                for r in (b.get('recommendations') or []) if isinstance(r, dict)
                and keep('%s %s' % (r.get('title') or '', r.get('detail') or ''))],
            'next_month_focus': [str(x) for x in (b.get('next_month_focus') or []) if keep(x)],
        }
    return [by_key[k] for k in plat_keys if k in by_key]


def report_recommend(body):
    """Client-ready monthly recommendations from this month's KPIs vs last month,
    the per-platform metrics, tagged-post performance and competitor benchmark.
    Strict-JSON Haiku call (fast, single round-trip, well under the gateway timeout)."""
    data = body.get('data') or body
    api_key = os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('CLAUDE_API_KEY')

    # Competitors arrive with every scraped post attached — captions, hashtags and
    # image URLs. On a client tracking 4 competitors per platform that block alone
    # measured ~117KB against the ~168KB payload, so the character budget below cut
    # the prompt off INSIDE `platforms` and the model received zero competitor data
    # (and malformed JSON). Roll each competitor up into the same period totals the
    # report's "Brand vs competitors" table shows, so the narrative compares
    # like-for-like at a fraction of the size.
    def _comp_row(c):
        posts = c.get('posts') or c.get('top_posts') or []
        def _tot(*keys):
            t = 0
            for p in posts:
                if not isinstance(p, dict):
                    continue
                for k in keys:                      # first key present wins
                    if p.get(k) is not None:
                        t += _num(p.get(k)) or 0
                        break
            return t or None
        reactions, comments = _tot('reactions', 'likes'), _tot('comments')
        shares = _tot('shares', 'saves')
        eng = (reactions or 0) + (comments or 0) + (shares or 0)
        er, followers = c.get('engagement_rate'), _num(c.get('followers'))
        if er is None and followers and posts:
            er = round(eng / len(posts) / followers * 100, 2)
        return {
            'name': c.get('name') or c.get('handle'), 'platform': c.get('platform'),
            'followers': c.get('followers'), 'posts': len(posts) or None,
            'reactions': reactions, 'comments': comments, 'shares': shares,
            'total_engagement': eng or None, 'engagement_rate': er,
            'posts_per_week': c.get('posts_per_week'),
            'top_hashtags': (c.get('top_hashtags') or [])[:8],
        }
    competitors = [_comp_row(c) for c in (data.get('competitors') or [])
                   if isinstance(c, dict)]

    # `platforms` carries the same per-post ballast. Keep the scalar metrics the
    # narrative actually cites; `breakdowns` is summarised into audience_breakdowns
    # just below, so it is dropped here rather than sent twice.
    def _plat_row(p):
        return {k: v for k, v in p.items()
                if k != 'breakdowns' and not isinstance(v, (list, dict))}
    platforms = [_plat_row(p) for p in (data.get('platforms') or [])
                 if isinstance(p, dict)]

    # Competitor context sits ahead of the bulkier optional keys so that if the
    # budget is ever hit again, it is the tail that goes — not the comparison.
    facts = {
        'brand':        data.get('brand') or data.get('name') or 'the brand',
        'month':        data.get('month'),
        'previous_month': data.get('previous_month'),
        'kpis_this_month':     data.get('kpis') or {},
        'kpis_previous_month': data.get('prev_kpis') or {},
        'goals':        data.get('goals') or '',
        'competitors':  competitors,
        'benchmark_share_of_voice': (data.get('benchmark') or {}).get('share_of_voice') or {},
        'platforms':    platforms,
        'tagged_posts': data.get('tagged_posts') or [],
    }
    # Compact audience/demographic + discovery summary from any breakdowns the
    # platform cards carry, so the narrative can speak to WHO the audience is and
    # HOW they discover the content (not just the headline KPIs).
    audience = {}
    for p in (data.get('platforms') or []):
        bd = p.get('breakdowns') or {}
        if not bd:
            continue
        audience[p.get('platform')] = {
            k: [[r.get('name'), r.get('value')] for r in (v or [])[:5]]
            for k, v in bd.items() if v}
    if audience:
        facts['audience_breakdowns'] = audience
    # Platform keys exactly as the report knows them ('facebook', 'instagram', …).
    # The model is told to echo these verbatim so the frontend can match each
    # returned block back to a platform row (and to its icon/colour/label).
    plat_keys = [str(p.get('platform')) for p in platforms if p.get('platform')]
    # The block is split per platform: one shared headline, then a full
    # wins/concerns/actions/focus set for each platform. `wins` and friends are
    # kept at the top level too — empty here, but they are what pre-split saved
    # blocks carry, and the report still renders those as a single combined set.
    fallback = {
        'headline': 'Monthly performance captured.', 'platforms': [],
        'wins': [], 'concerns': [], 'recommendations': [], 'next_month_focus': [],
    }
    if not api_key:
        return {'recommendations_block': fallback, 'ai': False}
    prompt = (
        "You are a senior social media account manager writing the recommendations "
        "section of a MONTHLY client report. Given the data (real metrics, this "
        "month vs last month, the client's own tagged priority posts and competitor "
        "benchmarks), write a concise, client-facing analysis, SPLIT PER PLATFORM. "
        "Respond with STRICT JSON only, no prose, matching:\n"
        '{"headline":"one punchy sentence on the month overall, across all platforms",'
        '"platforms":[{"platform":"<platform key copied verbatim from the data>",'
        '"wins":["2-3 concrete wins on THIS platform, cite the numbers/deltas"],'
        '"concerns":["1-2 honest concerns or declines on THIS platform"],'
        '"recommendations":[{"title":"...","detail":"1-2 sentences, specific & actionable","priority":"high|medium|low"}],'
        '"next_month_focus":["1-3 priorities for THIS platform next month"]}]}\n'
        "Emit exactly one `platforms` entry for EACH of these platforms, in this "
        "order, copying the key verbatim: " + (', '.join(plat_keys) or '(none)') + ". "
        "Never merge two platforms into one entry and never invent a platform that "
        "is not in that list. Everything inside an entry must be about that "
        "platform only — no cross-platform points, and no repeating the same "
        "generic advice under every platform. Only the headline speaks to the "
        "account as a whole.\n"
        "HARD RULE: inside a platform's entry, do NOT name any OTHER platform — not "
        "in a win, a concern, an action title/detail, or a focus point. No "
        "'consolidate to LinkedIn', no 'repurpose this to Facebook', no 'pause "
        "Instagram'. A reader on the TikTok tab must see TikTok advice and nothing "
        "else; budget-shifting advice across channels belongs in the headline or "
        "nowhere. Any point naming another platform will be discarded, so write the "
        "same advice in terms of THIS platform instead.\n"
        "Ground every point in the numbers. If tagged "
        "posts are present, comment on what made them work and how to repeat it. "
        "If `audience_breakdowns` is present, work in WHO the audience is (age, "
        "gender, location, seniority) and HOW they discover the content (traffic "
        "sources) — e.g. tailor content/timing to the dominant segment. "
        "If `competitors` is present, explicitly compare the brand against them: "
        "posting volume, reactions, comments, shares, total engagement and "
        "engagement rate, plus share of voice where given. Only ever cite a "
        "competitor under its OWN platform (an Instagram account and a Facebook "
        "Page are not comparable), name who leads on what, and say what the brand "
        "should copy or counter. Competitor reach and impressions are not obtainable for accounts "
        "we don't own, so never claim or estimate them. "
        "Keep it plain-English for a non-marketer client.\n\nDATA:\n"
        + json.dumps(facts, default=str)[:24000]
    )
    try:
        r = requests.post('https://api.anthropic.com/v1/messages',
                          headers={'x-api-key': api_key, 'anthropic-version': '2023-06-01',
                                   'content-type': 'application/json'},
                          # Four platforms' worth of wins/concerns/actions/focus is
                          # roughly four times the old single block — at 1800 the
                          # JSON was cut mid-object and every run fell back.
                          json={'model': HAIKU_MODEL, 'max_tokens': 5000,
                                'messages': [{'role': 'user', 'content': prompt}]},
                          timeout=60)
        txt = ''.join(b.get('text', '') for b in (r.json().get('content') or [])
                      if b.get('type') == 'text')
        txt = re.sub(r'^```[a-z]*\n?|```$', '', txt.strip()).strip()
        out = json.loads(txt)
        out['platforms'] = _rec_platform_blocks(out.get('platforms'), plat_keys)
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
        '"avg_likes":number|null,"page_views":number|null,'
        '"organic_page_views":number|null,"paid_page_views":number|null,'
        '"organic_engagement_rate":number|null,"paid_engagement_rate":number|null,'
        '"view_through_rate":number|null,"organic_view_through_rate":number|null,'
        '"paid_view_through_rate":number|null}],'
        '"notes":"one line on anything ambiguous, or empty"}\n'
        "Organic vs paid: many exports show a Total / Organic / Paid (or "
        "Sponsored / Promoted / Boosted) split for impressions, page views, "
        "engagement rate and view-through rate — capture all three when they are "
        "shown, and leave the organic/paid keys null when the export only gives a "
        "single blended number. view_through_rate = video views over impressions, "
        "a percent number. "
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
# Social Listening Report — standalone module (separate offering/billing from
# Monthly Social Reports, though it shares this Lambda). A "client" holds one or
# more named "topics" (e.g. "Payment/Payout"), each with its own tracked keyword
# query. Every active topic gets snapshotted once a day (cron, below) via the
# same fetch_social_listening() the Monthly Reports Listening tab uses — one row
# per (topic, date) in sl_snapshots. A date-range report aggregates those daily
# rows: mentions are deduped by URL, sentiment counts are summed, and one trend
# point is emitted per day that actually has a snapshot — DataForSEO has no
# date-range query (live search only), so there is no historical backfill; trend
# data only exists from whenever a topic starts being tracked.
# ──────────────────────────────────────────────────────────────────────────────
SL_SNAPSHOT_TTL_SECS = 400 * 86400   # ~13 months — old snapshots self-clean via DynamoDB TTL

def _slclients():   return boto3.resource('dynamodb', region_name=REGION).Table(SL_CLIENTS_TABLE)
def _sltopics():    return boto3.resource('dynamodb', region_name=REGION).Table(SL_TOPICS_TABLE)
def _slsnapshots(): return boto3.resource('dynamodb', region_name=REGION).Table(SL_SNAPSHOTS_TABLE)


def sl_list_clients(body):
    items = []
    resp = _slclients().scan()
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = _slclients().scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    items.sort(key=lambda c: str(c.get('updated') or c.get('created') or ''), reverse=True)
    return {'clients': _dec(items)}


def sl_save_client(body):
    data = body.get('data') or body
    cid = (data.get('clientId') or '').strip() or uuid.uuid4().hex
    existing = _slclients().get_item(Key={'clientId': cid}).get('Item') or {}
    now = _now_iso(); who = _who(body)
    item = {
        'clientId':   cid,
        'name':       (data.get('name') or existing.get('name') or 'Untitled client').strip(),
        'domain':     (data.get('domain') or existing.get('domain') or '').strip(),
        'industry':   (data.get('industry') or existing.get('industry') or '').strip(),
        'location':   (data.get('location') or existing.get('location') or 'Singapore').strip(),
        'topics':     existing.get('topics', []),   # lightweight index only — full rows live in sl_topics
        'created':    existing.get('created') or now,
        'created_by': existing.get('created_by') or who,
        'updated':    now,
        'updated_by': who,
    }
    stored = _enc(item)
    _slclients().put_item(Item=stored)
    return {'ok': True, 'client': _dec(stored)}


def sl_delete_client(body):
    cid = (body.get('clientId') or (body.get('data') or {}).get('clientId') or '').strip()
    if not cid:
        raise RuntimeError('Missing clientId.')
    resp = _sltopics().query(KeyConditionExpression=Key('clientId').eq(cid),
                             ProjectionExpression='topicId')
    with _sltopics().batch_writer() as bw:
        for t in resp.get('Items', []):
            bw.delete_item(Key={'clientId': cid, 'topicId': t['topicId']})
    _slclients().delete_item(Key={'clientId': cid})
    # Snapshot rows for deleted topics are left to expire via DynamoDB TTL rather
    # than a cascade query per topic — cheap to leave, simpler than chasing them.
    return {'ok': True}


def sl_list_topics(body):
    cid = (body.get('clientId') or '').strip()
    if not cid:
        raise RuntimeError('Missing clientId.')
    resp = _sltopics().query(KeyConditionExpression=Key('clientId').eq(cid))
    items = resp.get('Items', [])
    items.sort(key=lambda t: str(t.get('name') or ''))
    return {'topics': _dec(items)}


def sl_save_topic(body):
    data = body.get('data') or body
    cid = (data.get('clientId') or '').strip()
    if not cid:
        raise RuntimeError('Missing clientId.')
    client = _slclients().get_item(Key={'clientId': cid}).get('Item')
    if not client:
        raise RuntimeError('Unknown client.')
    tid = (data.get('topicId') or '').strip() or uuid.uuid4().hex
    existing = _sltopics().get_item(Key={'clientId': cid, 'topicId': tid}).get('Item') or {}
    now = _now_iso(); who = _who(body)
    item = {
        'clientId': cid, 'topicId': tid,
        'name':     (data.get('name') or existing.get('name') or 'Untitled topic').strip(),
        'keywords': data.get('keywords') if data.get('keywords') is not None else existing.get('keywords', []),
        'queries':  data.get('queries')  if data.get('queries')  is not None else existing.get('queries', []),
        # Structured query built field-by-field in the UI: [{op:'and'|'not',
        # terms:[...]}]. Drives the relevance guard + match labels in _sl_feed.
        'conditions': data.get('conditions') if data.get('conditions') is not None else existing.get('conditions', []),
        'location': (data.get('location') or existing.get('location') or client.get('location') or 'Singapore').strip(),
        'language': (data.get('language') or existing.get('language') or 'English').strip(),
        'sources':  data.get('sources') if data.get('sources') is not None else existing.get('sources', ['web', 'reddit', 'twitter', 'forums']),
        # Markets to scope the report to. Empty = worldwide (no country filter),
        # which is also what every pre-schema-2 topic implicitly was.
        'countries': [c for c in (data.get('countries')
                                  if data.get('countries') is not None
                                  else existing.get('countries', []))
                      if c in SL_COUNTRY_NAME],
        # Apify platforms to pull. Defaults to all four; X is daily, the rest weekly.
        'social':   data.get('social') if data.get('social') is not None else existing.get('social', list(SL_SOCIAL_ACTORS)),
        'active':   bool(data.get('active')) if data.get('active') is not None else bool(existing.get('active', True)),
        'created':    existing.get('created') or now,
        'created_by': existing.get('created_by') or who,
        'updated':    now,
        'updated_by': who,
    }
    stored = _enc(item)
    _sltopics().put_item(Item=stored)

    # Keep the client's lightweight topic index in sync (same pattern as Monthly
    # Social Reports mirroring its month index onto the project item).
    idx = [t for t in (_dec(client.get('topics')) or []) if t.get('topicId') != tid]
    idx.append({'topicId': tid, 'name': item['name'], 'active': item['active'], 'updated': now})
    idx.sort(key=lambda t: str(t.get('name') or ''))
    _slclients().update_item(
        Key={'clientId': cid},
        UpdateExpression='SET topics = :t, updated = :u, updated_by = :w',
        ExpressionAttributeValues={':t': _enc(idx), ':u': now, ':w': who})
    return {'ok': True, 'topic': _dec(stored)}


def sl_delete_topic(body):
    cid = (body.get('clientId') or (body.get('data') or {}).get('clientId') or '').strip()
    tid = (body.get('topicId') or (body.get('data') or {}).get('topicId') or '').strip()
    if not cid or not tid:
        raise RuntimeError('Missing clientId or topicId.')
    _sltopics().delete_item(Key={'clientId': cid, 'topicId': tid})
    client = _slclients().get_item(Key={'clientId': cid}).get('Item')
    if client:
        idx = [t for t in (_dec(client.get('topics')) or []) if t.get('topicId') != tid]
        _slclients().update_item(
            Key={'clientId': cid},
            UpdateExpression='SET topics = :t, updated = :u',
            ExpressionAttributeValues={':t': _enc(idx), ':u': _now_iso()})
    return {'ok': True}


def _sl_snapshot_topic(cid, tid, who):
    """One live pull for one topic via the shared listening engine (the exact
    fetch_social_listening() the Monthly Reports Listening tab uses), stored as
    today's snapshot row. Overwrites today's row if already pulled today, so a
    manual "Pull now" and the nightly cron never conflict — last write wins."""
    client = _slclients().get_item(Key={'clientId': cid}).get('Item')
    topic  = _sltopics().get_item(Key={'clientId': cid, 'topicId': tid}).get('Item')
    if not client or not topic:
        raise RuntimeError('Unknown client or topic.')
    client, topic = _dec(client), _dec(topic)
    cfg = {'sources': topic.get('sources') or ['web', 'reddit', 'twitter', 'forums'],
           'keywords': topic.get('keywords') or [],
           'queries': topic.get('queries') or [],
           'conditions': topic.get('conditions') or []}
    # brand must be the CLIENT's name (e.g. "Singapore Pools"), not the topic
    # name (e.g. "Payment/Payout") — fetch_social_listening searches
    # [brand] + keywords, so an unqualified topic name as the anchor term
    # pulls generic unrelated web noise instead of client-scoped mentions.
    brand = client.get('name') or topic.get('name') or ''
    result = fetch_social_listening(brand, client.get('domain', ''),
                                    location=topic.get('location') or 'Singapore',
                                    language=topic.get('language') or 'English', cfg=cfg)

    # ---- schema-2 enrichment: country scoping + audience metrics ----------
    # Everything below is best-effort and additive: if DataForSEO or Apify is
    # down, the v1 fields above still populate and the report still renders.
    terms = _sl_term_group([brand] + list(topic.get('keywords') or []))
    countries = [c for c in (topic.get('countries') or []) if c in SL_COUNTRY_NAME]
    lang_code = _ca_lang_code(topic.get('language') or 'English')
    today = _sgt_date()

    corpus, country_volume, feed, social = {}, {}, [], {}
    try:
        corpus = _sl_corpus_summary(terms, CA_PAGE_TYPES)
    except Exception:
        pass
    try:
        country_volume = _sl_country_volume(terms, countries, CA_PAGE_TYPES)
    except Exception:
        pass
    try:
        feed = _sl_feed(terms, countries, CA_PAGE_TYPES, lang_code,
                        conditions=topic.get('conditions') or [])[:120]
    except Exception:
        pass
    try:
        due = _sl_due_platforms(topic, today)
        social = _sl_social_pull(terms, due) if due else {}
    except Exception:
        social = {}

    # Trim before writing: a topic with 4 platforms x 100 posts plus a 120-item
    # web feed can exceed DynamoDB's 400KB item ceiling, which fails the whole
    # put_item — the same ceiling that silently broke Monthly Social Reports
    # when a corrupted email bloated the row. Cap posts per platform and keep
    # snippets short; the report only ever renders a top-N of these anyway.
    for slot in social.values():
        slot['posts'] = (slot.get('posts') or [])[:60]
        for p in slot['posts']:
            p['snippet'] = (p.get('snippet') or '')[:240]

    now = _now_iso()
    item = {
        'topicId': tid, 'date': today, 'clientId': cid, 'schema': 2,
        'total_mentions': (result.get('summary') or {}).get('total_mentions'),
        'sentiment': (result.get('summary') or {}).get('sentiment') or {},
        'mentions': result.get('mentions') or [],
        'platforms': result.get('platforms') or {},
        'note': result.get('note'),
        # schema 2
        'countries': countries,
        'corpus': corpus,
        # TRUE per-country corpus volume for THIS day. phrase_trends can't be
        # filtered by country, so stitching these daily rows together is the
        # only way to get a country-scoped volume-over-time series at all.
        'country_volume': country_volume,
        'feed': feed,
        'social': social,
        'savedAt': now, 'savedBy': who,
        'ttl': int(time.time()) + SL_SNAPSHOT_TTL_SECS,
    }
    try:
        _slsnapshots().put_item(Item=_enc(item))
    except Exception:
        # Last-resort shrink: drop the bulky raw feeds but keep every aggregate,
        # so an oversized day still contributes to trends instead of vanishing.
        item['feed'] = item['feed'][:20]
        for slot in (item.get('social') or {}).values():
            slot['posts'] = (slot.get('posts') or [])[:10]
        item['oversized'] = True
        _slsnapshots().put_item(Item=_enc(item))
    return item


SL_PULL_STALE_SECS = 20 * 60   # a "running" marker older than this = the run died


def sl_pull_topic(body):
    """Manual "Pull now" — queues the same work the nightly cron does.

    ASYNC BY NECESSITY: this used to run the pull inline and return the snapshot,
    which worked while the pull was a handful of DataForSEO calls. Waiting on
    Apify actor runs pushed it past API Gateway's HARD 30-SECOND integration
    timeout (verified: the endpoint returns {"message":"Endpoint request timed
    out"} while the Lambda keeps running to completion behind it). The Lambda's
    own timeout is 900s, so the work is fine — only the synchronous HTTP reply
    is not. So: drop a "running" marker, self-invoke, return immediately, and
    let the frontend poll sl_pull_status."""
    data = body.get('data') or body
    cid = (data.get('clientId') or '').strip()
    tid = (data.get('topicId') or '').strip()
    if not cid or not tid:
        raise RuntimeError('Missing clientId or topicId.')
    who = _who(body)
    today = _sgt_date()
    existing = _slsnapshots().get_item(Key={'topicId': tid, 'date': today}).get('Item')
    started = int(time.time())
    if existing and (existing.get('pull_status') == 'running') and \
       (started - int(existing.get('pull_started') or 0)) < SL_PULL_STALE_SECS:
        return {'ok': True, 'queued': False, 'already_running': True}
    # Marker only — merged into the existing row so a re-pull never destroys the
    # day's already-captured data while the new run is in flight.
    _slsnapshots().update_item(
        Key={'topicId': tid, 'date': today},
        UpdateExpression=('SET pull_status = :s, pull_started = :t, clientId = :c, '
                          '#ttl = if_not_exists(#ttl, :x)'),
        ExpressionAttributeNames={'#ttl': 'ttl'},
        ExpressionAttributeValues={':s': 'running', ':t': started, ':c': cid,
                                   ':x': started + SL_SNAPSHOT_TTL_SECS})
    _self_invoke({'action': 'sl_cron_snapshot_one', 'clientId': cid,
                  'topicId': tid, 'who': who})
    return {'ok': True, 'queued': True, 'date': today}


def sl_pull_status(body):
    """Polled by the frontend after sl_pull_topic. Reports whether today's pull
    is still running, finished, or died mid-flight (a stale marker)."""
    data = body.get('data') or body
    tid = (data.get('topicId') or '').strip()
    if not tid:
        raise RuntimeError('Missing topicId.')
    row = _dec(_slsnapshots().get_item(
        Key={'topicId': tid, 'date': _sgt_date()}).get('Item') or {})
    if not row:
        return {'status': 'none'}
    st = row.get('pull_status')
    age = int(time.time()) - int(row.get('pull_started') or 0)
    if st == 'running':
        return {'status': 'stalled' if age > SL_PULL_STALE_SECS else 'running',
                'seconds': age}
    return {
        'status': 'done',
        'savedAt': row.get('savedAt'),
        'mentions': len(row.get('feed') or row.get('mentions') or []),
        'social': {k: len(v.get('posts') or [])
                   for k, v in (row.get('social') or {}).items()},
        'total_mentions': (row.get('corpus') or {}).get('total_mentions')
                          or row.get('total_mentions'),
    }


def sl_get_topic_report(body):
    """Aggregate one topic's daily snapshots over [start, end] (both "YYYY-MM-DD",
    inclusive) into a report: deduped mentions feed, summed sentiment, a
    per-day trend series, and a top-sites table."""
    data = body.get('data') or body
    tid   = (data.get('topicId') or '').strip()
    start = (data.get('start') or '').strip()
    end   = (data.get('end') or '').strip()
    if not tid or not start or not end:
        raise RuntimeError('Missing topicId, start or end.')
    resp = _slsnapshots().query(
        KeyConditionExpression=Key('topicId').eq(tid) & Key('date').between(start, end))
    rows = sorted(_dec(resp.get('Items', [])), key=lambda r: str(r.get('date') or ''))

    # Mentions: flatten across days, dedupe by URL — first-seen date wins (a
    # mention published on day N can still surface in day N+2's live pull if
    # DataForSEO's crawl lagged, so "first captured" is the more honest date).
    seen_urls, mentions = set(), []
    for row in rows:
        for m in row.get('mentions') or []:
            url = m.get('url')
            if url and url not in seen_urls:
                seen_urls.add(url)
                mentions.append(m)
    mentions.sort(key=lambda m: str(m.get('date') or ''), reverse=True)

    # Same dedupe applied independently per platform (Reddit/X/forums).
    platforms = {}
    for row in rows:
        for key, obj in (row.get('platforms') or {}).items():
            slot = platforms.setdefault(key, {'label': (obj or {}).get('label') or key, '_seen': set(), 'results': []})
            for r in (obj or {}).get('results') or []:
                u = r.get('url')
                if u and u not in slot['_seen']:
                    slot['_seen'].add(u)
                    slot['results'].append(r)
    for slot in platforms.values():
        slot.pop('_seen', None)

    # Sentiment counts are additive across days (they're per-day counts, not
    # percentages — see _merge_summaries), so summing across the range is valid.
    sentiment = {'positive': 0, 'negative': 0, 'neutral': 0}
    trend = []
    for row in rows:
        s = row.get('sentiment') or {}
        day_sent = {k: (s.get(k) or 0) for k in ('positive', 'negative', 'neutral')}
        for k in sentiment:
            sentiment[k] += day_sent[k]
        trend.append({'date': row.get('date'), 'total_mentions': row.get('total_mentions'),
                      'sentiment': day_sent})

    # Top sites computed from the deduped mentions list (a distinct-article
    # count), not from each day's raw top-8 snapshot — avoids double-counting a
    # domain that happened to rank in the daily top-8 on multiple days.
    site_counts = {}
    for m in mentions:
        d = m.get('domain')
        if d:
            site_counts[d] = site_counts.get(d, 0) + 1
    top_sites = [{'domain': d, 'count': c} for d, c in
                 sorted(site_counts.items(), key=lambda kv: kv[1], reverse=True)[:8]]

    out = {
        'topicId': tid, 'start': start, 'end': end,
        # "Mentions captured", not "Total mentions" — content_analysis/search/live
        # caps at 20 items/term, so this is a floor on real volume, not the true
        # corpus count Brandwatch's own number would represent.
        'kpis': {'mentions_captured': len(mentions), 'sentiment': sentiment},
        'trend': trend,
        'top_sites': top_sites,
        'mentions': mentions,
        'platforms': platforms,
        'days_captured': len(rows),
    }

    # ---- schema 2: the full metric set + previous-period comparison --------
    span = (_sl_d(end) - _sl_d(start)).days + 1
    p_end   = _sl_s(_sl_d(start) - timedelta(days=1))
    p_start = _sl_s(_sl_d(start) - timedelta(days=span))
    presp = _slsnapshots().query(
        KeyConditionExpression=Key('topicId').eq(tid) & Key('date').between(p_start, p_end))
    prows = sorted(_dec(presp.get('Items', [])), key=lambda r: str(r.get('date') or ''))

    # TRUE per-day volume comes from phrase_trends, NOT from the stored daily
    # snapshots. CRITICAL, and easy to get wrong: content_analysis/summary/live
    # and search/live both return total_count = the size of the WHOLE matching
    # corpus, not that day's new mentions. Summing seven daily snapshots of it
    # reports seven times the corpus (observed: 11,063,231 for a topic whose
    # corpus is ~2.7M). phrase_trends is the only endpoint whose total_count is
    # genuinely per-day, so period volume and every over-time series derive from
    # it. It also backfills history for days we never snapshotted.
    terms = _sl_report_terms(tid, rows or prows)
    cur_trend  = _sl_trends(terms, CA_PAGE_TYPES, start, end) if terms else []
    prev_trend = _sl_trends(terms, CA_PAGE_TYPES, p_start, p_end) if terms else []

    cur  = _sl_aggregate(rows, cur_trend)
    prev = _sl_aggregate(prows, prev_trend)

    out['metrics'] = cur
    out['previous'] = prev
    out['previous_range'] = {'start': p_start, 'end': p_end}
    out['change'] = {k: _sl_pct_change(cur['kpis'].get(k), prev['kpis'].get(k))
                     for k in cur['kpis']}
    # Per-platform benchmark vs the previous period, which the platform table
    # renders as an up/down column rather than a bare current-period count.
    out['platform_change'] = {
        k: _sl_pct_change(v, (prev.get('by_platform') or {}).get(k))
        for k, v in (cur.get('by_platform') or {}).items()}
    out['countries_available'] = [{'code': c, 'name': n} for c, n, _ in SL_COUNTRIES]
    out['days_captured_previous'] = len(prows)
    # Demand-side, not mention-derived: how many people SEARCH these terms, as
    # opposed to how many talk about them. Live rather than snapshotted because
    # Google Ads reports a rolling monthly average, not a daily figure — storing
    # it per day and summing would be the same corpus-multiplying mistake.
    try:
        topic_countries = next((r.get('countries') for r in (rows or prows)
                                if r.get('countries')), [])
        out['search_volume'] = _sl_search_volume(terms, topic_countries)
    except Exception:
        out['search_volume'] = {}
    return out


# ──────────────────────────────────────────────────────────────────────────────
# Social Listening — report aggregation
# ──────────────────────────────────────────────────────────────────────────────
def _sl_d(s):
    return datetime.strptime(s, '%Y-%m-%d')


def _sl_s(d):
    return d.strftime('%Y-%m-%d')


def _sl_pct_change(cur, prev):
    """None (not 0) when there's no comparable base, so the UI can show "—"
    instead of a meaningless +100% on a topic's first period."""
    try:
        cur = float(cur or 0); prev = float(prev or 0)
    except (TypeError, ValueError):
        return None
    if not prev:
        return None
    return round((cur - prev) / prev * 100, 1)


_SL_DT_FORMATS = ('%Y-%m-%d %H:%M:%S %z', '%Y-%m-%dT%H:%M:%S%z',
                  '%a %b %d %H:%M:%S %z %Y', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d')


def _sl_parse_dt(s):
    """Tolerant timestamp parse — DataForSEO emits "2026-02-03 21:19:39 +00:00"
    while X emits "Mon Jul 20 23:38:31 +0000 2026". Returns an SGT-shifted naive
    datetime, or None. DataForSEO occasionally emits absurd years (a real "6827"
    was observed), so anything implausible is discarded rather than plotted."""
    if not s:
        return None
    txt = str(s).strip().replace('+00:00', '+0000')
    for fmt in _SL_DT_FORMATS:
        try:
            dt = datetime.strptime(txt, fmt)
        except ValueError:
            continue
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        dt = dt + timedelta(hours=8)
        return dt if 2000 <= dt.year <= 2100 else None
    return None


def _sl_report_terms(tid, rows):
    """Recover a topic's search terms for the report-time trends call. The
    snapshot rows carry clientId, which with topicId is the topics-table key."""
    cid = next((r.get('clientId') for r in rows if r.get('clientId')), None)
    if not cid:
        return []
    topic = _dec(_sltopics().get_item(Key={'clientId': cid, 'topicId': tid}).get('Item') or {})
    client = _dec(_slclients().get_item(Key={'clientId': cid}).get('Item') or {})
    if not topic:
        return []
    brand = client.get('name') or topic.get('name') or ''
    return _sl_term_group([brand] + list(topic.get('keywords') or []))


def _sl_shares(counts):
    """Normalise a cumulative distribution to fractions summing to 1."""
    tot = sum(v or 0 for v in counts.values())
    return {k: (v or 0) / tot for k, v in counts.items()} if tot else {}


def _sl_aggregate(rows, trend_rows=None):
    """Fold a set of daily snapshots into one period's metrics. Handles both
    schema 1 (pre-country-filter) and schema 2 rows, so a range that straddles
    the upgrade still aggregates instead of erroring.

    `trend_rows` is the phrase_trends per-day series and is the ONLY valid
    source of period volume — see the note in sl_get_topic_report. The stored
    snapshots contribute the things trends cannot: the mention feed, authors,
    reach, impressions, hashtags and the country/language/platform SHAPE."""
    trend_rows = trend_rows or []
    kpis = {'total_mentions': 0, 'mentions_captured': 0, 'reach': 0,
            'impressions': 0, 'unique_authors': 0, 'engagements': 0,
            'positive': 0, 'negative': 0, 'neutral': 0, 'net_sentiment': None}
    trend, emo_trend = [], []
    by_country, by_language, by_platform, by_category = {}, {}, {}, {}
    by_social = {}
    emotions = {k: 0 for k in _SL_EMOTIONS}
    authors, hashtags, links, domains = {}, {}, {}, {}
    heat = {}
    seen, feed = set(), []
    words = {}

    # ---- period volume + every over-time series, from phrase_trends ----
    for r in trend_rows:
        day_sent = {k: (r.get('sentiment') or {}).get(k) or 0
                    for k in ('positive', 'negative', 'neutral')}
        day_emo = {k: (r.get('emotions') or {}).get(k) or 0 for k in _SL_EMOTIONS}
        kpis['total_mentions'] += r.get('total_mentions') or 0
        for k, v in day_sent.items():
            kpis[k] += v
        for k, v in day_emo.items():
            emotions[k] += v
        trend.append({'date': r.get('date'), 'total_mentions': r.get('total_mentions') or 0,
                      'sentiment': day_sent, 'net_sentiment': _sl_net(day_sent)})
        emo_trend.append({'date': r.get('date'), 'emotions': day_emo})

    # ---- distribution SHAPE, from the most recent snapshot ----
    # These corpus maps are cumulative, so the newest one is used as-is for its
    # proportions and then scaled to the period's true volume. Summing them
    # across days would multiply the corpus by the number of days.
    latest = rows[-1] if rows else {}
    lcorpus = latest.get('corpus') or {}
    cvol = latest.get('country_volume') or {}
    total = kpis['total_mentions']
    cshare = _sl_shares(cvol or (lcorpus.get('by_country') or {}))
    by_country = {k: int(round(v * total)) for k, v in cshare.items() if v}
    for k, v in _sl_shares(lcorpus.get('by_language') or {}).items():
        if v:
            by_language[k] = int(round(v * total))
    for k, v in _sl_shares(lcorpus.get('by_page_type') or {}).items():
        if v:
            by_platform[k] = int(round(v * total))
    for cid, v in _sl_shares(dict(lcorpus.get('categories') or [])).items():
        if v:
            by_category[cid] = int(round(v * total))
    # Top sites stay on the corpus scale (a true ranking of where mentions
    # appear). The feed loop below deliberately does NOT add to these — mixing
    # a corpus count with a +1-per-captured-item tally would compare two
    # different scales in one table.
    for dom, n in (lcorpus.get('top_domains') or []):
        domains[dom] = n
    corpus_domains = set(domains)

    for row in rows:
        # Web feed + social posts share one deduped mention list, so "unique
        # authors" and the heatmap span both sources rather than just one.
        rowfeed = list(row.get('feed') or row.get('mentions') or [])
        for slot in (row.get('social') or {}).values():
            rowfeed.extend(slot.get('posts') or [])
        for m in rowfeed:
            url = m.get('url')
            if not url or url in seen:
                continue
            seen.add(url)
            feed.append(m)

    for m in feed:
        src = m.get('source') or 'web'
        if src != 'web':
            # Social platforms are a COUNT OF CAPTURED POSTS, capped by
            # SL_APIFY_CAP — not a corpus estimate like the web page types. They
            # therefore live in their own map so no chart ever puts "1.6M
            # ecommerce pages" and "60 tweets" on the same axis.
            by_social[src] = by_social.get(src, 0) + 1
        a = (m.get('author') or '').strip()
        if a:
            slot = authors.setdefault(a, {'author': a, 'mentions': 0, 'followers': 0,
                                          'url': m.get('author_url'),
                                          'platform': src})
            slot['mentions'] += 1
            slot['followers'] = max(slot['followers'], int(m.get('followers') or 0))
        for h in (m.get('hashtags') or []):
            hashtags[h] = hashtags.get(h, 0) + 1
        for u in (m.get('links') or []):
            links[u] = links.get(u, 0) + 1
        dom = m.get('domain')
        if dom and not corpus_domains:
            domains[dom] = domains.get(dom, 0) + 1
        v = m.get('views')
        if isinstance(v, (int, float)):
            kpis['impressions'] += int(v)
        for f in ('likes', 'shares', 'comments'):
            n = m.get(f)
            if isinstance(n, (int, float)):
                kpis['engagements'] += int(n)
        lang = m.get('language')
        if lang and not by_language:
            by_language[lang] = by_language.get(lang, 0) + 1
        dt = _sl_parse_dt(m.get('date'))
        if dt:
            heat['%d-%d' % (dt.weekday(), dt.hour)] = heat.get('%d-%d' % (dt.weekday(), dt.hour), 0) + 1
        for w in _sl_words(m.get('title'), m.get('snippet')):
            words[w] = words.get(w, 0) + 1

    # Reach = distinct authors' follower counts, summed once per author. Summing
    # per POST would multiply-count the same audience for a prolific author,
    # which is how listening tools overstate reach.
    kpis['reach'] = sum(a['followers'] for a in authors.values())
    kpis['unique_authors'] = len(authors)
    kpis['mentions_captured'] = len(feed)
    kpis['net_sentiment'] = _sl_net({k: kpis[k] for k in ('positive', 'negative', 'neutral')})

    top = lambda d, n: [{'key': k, 'count': v} for k, v in
                        sorted(d.items(), key=lambda kv: kv[1], reverse=True)[:n]]
    author_rows = sorted(authors.values(), key=lambda a: (-a['mentions'], -a['followers']))[:25]
    tot_auth_mentions = sum(a['mentions'] for a in authors.values()) or 1
    for a in author_rows:
        a['share'] = round(a['mentions'] / tot_auth_mentions * 100, 1)

    return {
        'kpis': kpis,
        'trend': trend,
        'emotion_trend': emo_trend,
        'emotions': emotions,
        'by_country': by_country,
        'by_language': by_language,
        'by_platform': by_platform,
        'by_social': by_social,
        'categories': _sl_category_names(by_category),
        'top_domains': top(domains, 12),
        'top_authors': author_rows,
        'top_hashtags': top(hashtags, 20),
        'top_urls': top(links, 15),
        'word_cloud': top(words, 60),
        'heatmap': heat,
        'feed': feed[:250],
    }


def _sl_net(sent):
    """Net sentiment = (positive - negative) / total, as a percentage."""
    tot = sum((sent.get(k) or 0) for k in ('positive', 'negative', 'neutral'))
    if not tot:
        return None
    return round(((sent.get('positive') or 0) - (sent.get('negative') or 0)) / tot * 100, 1)


_SL_STOPWORDS = set('''a an and are as at be but by for from has have he her his how i if in
is it its of on or our she that the their them they this to was we were what when where which
who will with you your about after all also any been can could do does did had more most no
not now one out over said say says so some such than then there these those too up use very
via want way well were will would just like get got new news via amp http https com www rt'''.split())


def _sl_words(*texts):
    """Word-cloud tokens. Stopword-filtered and length-bounded; hashtags keep
    their tag form so #brandname doesn't fragment into a bare word."""
    out = []
    for t in texts:
        if not t:
            continue
        for w in re.findall(r'#?[A-Za-z][A-Za-z0-9\'-]{2,}', str(t).lower()):
            if w.lstrip('#') in _SL_STOPWORDS or len(w) > 24:
                continue
            out.append(w)
    return out


_SL_CAT_CACHE = {}


def _sl_category_names(counts):
    """Turn DataForSEO numeric category ids into names for the topic wheel.
    The id->name list is ~3,200 rows and static, so it's fetched once per warm
    container; if the lookup fails the wheel still renders with bare ids."""
    if not counts:
        return []
    if not _SL_CAT_CACHE:
        try:
            headers = _sl_dfs_headers()
            if headers:
                r = requests.get(f'{DFS_BASE}/content_analysis/categories',
                                 headers=headers, timeout=25)
                for c in ((r.json().get('tasks') or [{}])[0].get('result') or []):
                    if c.get('category_code'):
                        _SL_CAT_CACHE[int(c['category_code'])] = c.get('category_name')
        except (requests.exceptions.RequestException, ValueError, KeyError):
            pass
    # Some ids DataForSEO returns in text_category are absent from every
    # published taxonomy (verified 2026-07-21: 10137 and 12014 resolve in
    # neither content_analysis/categories nor dataforseo_labs/categories, and
    # they're often the single largest bucket). Showing a client "Category
    # 10137" is noise, but dropping them would silently understate the wheel —
    # so they collapse into one honest "Unclassified" slice.
    rows, unknown = [], 0
    for cid, n in sorted(counts.items(), key=lambda kv: kv[1], reverse=True):
        try:
            name = _SL_CAT_CACHE.get(int(cid))
        except (TypeError, ValueError):
            name = None
        if name:
            rows.append({'id': cid, 'name': name, 'count': n})
        else:
            unknown += n
    rows = rows[:20]
    if unknown:
        rows.append({'id': None, 'name': 'Unclassified', 'count': unknown})
    return rows


def sl_cron_snapshot_all(body):
    """Fired by an EventBridge schedule. Scans every active topic and async
    self-invokes sl_cron_snapshot_one per topic (own Lambda budget each) — same
    fan-out shape as cron_capture_all for Monthly Social Reports, below."""
    items = []
    resp = _sltopics().scan(FilterExpression='active = :a', ExpressionAttributeValues={':a': True})
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = _sltopics().scan(FilterExpression='active = :a', ExpressionAttributeValues={':a': True},
                                ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    fired = 0
    for it in items:
        cid, tid = it.get('clientId'), it.get('topicId')
        if not cid or not tid:
            continue
        _self_invoke({'action': 'sl_cron_snapshot_one', 'clientId': cid, 'topicId': tid})
        fired += 1
    return {'ok': True, 'topics': fired}


def sl_cron_snapshot_one(body):
    cid = (body.get('clientId') or '').strip()
    tid = (body.get('topicId') or '').strip()
    if not cid or not tid:
        raise RuntimeError('Missing clientId or topicId.')
    # `who` is set when a user pressed "Pull now" (sl_pull_topic self-invokes
    # this); absent when the EventBridge schedule fired it.
    item = _sl_snapshot_topic(cid, tid, body.get('who') or 'daily-cron@auto')
    return {'ok': True, 'snapshot': item}


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
                'config_id': META_OAUTH_CONFIG_ID,
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
                # Server-side offline code flow (like Meta/LinkedIn) so the token
                # refreshes for unattended monthly pulls. Falls back to in-browser
                # GIS only if the app secret isn't configured on the server yet.
                'configured': bool(GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET),
                'client_id': GOOGLE_OAUTH_CLIENT_ID, 'scopes': GOOGLE_OAUTH_SCOPES,
                'flow': 'code' if (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET) else 'gis',
                'authorize': 'https://accounts.google.com/o/oauth2/v2/auth',
                'auth_params': {'access_type': 'offline', 'prompt': 'consent',
                                'include_granted_scopes': 'true'}},
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
    if platform in ('youtube', 'google'):
        return _oauth_youtube(code, redirect)
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
    # TikTok access tokens live only ~24h; persist the refresh_token (~365d) so
    # _tt_access_token() can mint fresh access tokens for unattended monthly pulls
    # (mirrors the YouTube handler below).
    if d.get('refresh_token'):
        out['refresh_token'] = d['refresh_token']
    if d.get('expires_in'):
        out['expires_in'] = d['expires_in']
        out['token_expiry'] = int(time.time()) + int(d['expires_in']) - 60
    if d.get('refresh_expires_in'):
        out['refresh_expires_in'] = d['refresh_expires_in']
    if d.get('open_id'):
        out['open_id'] = d['open_id']
    return out


def _tt_access_token(conn):
    """A currently-valid TikTok access token for a stored connection dict.
    Reuses the saved access token while it's fresh; otherwise refreshes it from the
    stored refresh_token (TikTok access tokens live only ~24h). Returns None when
    the connection can't yield a usable token (caller falls back to Apify/public).
    Does NOT persist the refreshed token — connections are shared/mutated elsewhere
    and a fresh access token is cheap to mint."""
    conn = conn or {}
    tok, exp = conn.get('token'), conn.get('token_expiry')
    if tok and (not exp or int(exp) > int(time.time())):
        return tok
    refresh = conn.get('refresh_token')
    if not refresh or not (TIKTOK_OAUTH_CLIENT_ID and TIKTOK_OAUTH_CLIENT_SECRET):
        return tok or None   # no refresh available — try the (maybe stale) token
    try:
        d = requests.post('https://open.tiktokapis.com/v2/oauth/token/', timeout=20,
                          headers={'Content-Type': 'application/x-www-form-urlencoded'},
                          data={'client_key': TIKTOK_OAUTH_CLIENT_ID,
                                'client_secret': TIKTOK_OAUTH_CLIENT_SECRET,
                                'grant_type': 'refresh_token', 'refresh_token': refresh}).json()
        return d.get('access_token') or tok or None
    except Exception:
        return tok or None


def _oauth_youtube(code, redirect):
    """Exchange a Google authorization code for an OFFLINE token set. Unlike
    Meta/LinkedIn (long-lived tokens), Google access tokens live only ~1h, so we
    also persist the refresh_token and let _yt_access_token() mint fresh access
    tokens for each unattended monthly pull. Returns the same {token, name, …}
    shape the frontend already persists, plus refresh_token/token_expiry."""
    if not (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET):
        raise RuntimeError('YouTube sign-in is not set up on the server (GOOGLE_OAUTH_CLIENT_ID/SECRET).')
    d = requests.post('https://oauth2.googleapis.com/token', timeout=20,
                      data={'code': code, 'client_id': GOOGLE_OAUTH_CLIENT_ID,
                            'client_secret': GOOGLE_OAUTH_CLIENT_SECRET,
                            'redirect_uri': redirect,
                            'grant_type': 'authorization_code'}).json()
    token = d.get('access_token')
    if not token:
        raise RuntimeError('YouTube: ' + (d.get('error_description') or d.get('error') or 'token exchange failed'))
    name = 'YouTube channel'
    try:
        chans = requests.get(YOUTUBE_DATA_API + '/channels', timeout=15,
                             params={'part': 'snippet', 'mine': 'true'},
                             headers={'Authorization': 'Bearer ' + token}).json().get('items') or []
        if chans:
            name = ((chans[0].get('snippet') or {}).get('title')) or name
    except Exception:
        pass
    out = {'token': token, 'name': name}
    if d.get('refresh_token'):
        out['refresh_token'] = d['refresh_token']
    if d.get('expires_in'):
        out['expires_in'] = d['expires_in']
        out['token_expiry'] = int(time.time()) + int(d['expires_in']) - 60
    return out


def _yt_access_token(conn):
    """A currently-valid YouTube access token for a stored connection dict.
    Reuses the saved access token while it's fresh; otherwise refreshes it from
    refresh_token. Returns None when the connection can't yield a usable token
    (so the caller falls back to Apify). Does NOT persist the refreshed token —
    it's cheap to mint and connections are shared/mutated elsewhere."""
    conn = conn or {}
    tok, exp = conn.get('token'), conn.get('token_expiry')
    if tok and (not exp or int(exp) > int(time.time())):
        return tok
    refresh = conn.get('refresh_token')
    if not refresh or not (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET):
        return tok or None   # no refresh available — try the (maybe stale) token
    try:
        d = requests.post('https://oauth2.googleapis.com/token', timeout=20,
                          data={'refresh_token': refresh, 'client_id': GOOGLE_OAUTH_CLIENT_ID,
                                'client_secret': GOOGLE_OAUTH_CLIENT_SECRET,
                                'grant_type': 'refresh_token'}).json()
        return d.get('access_token') or tok or None
    except Exception:
        return tok or None


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


def cron_refresh_audience_all(body):
    """Weekly fan-out: refresh audience breakdowns (demographics / traffic) for
    every project so they stay current without a manual click. Same self-invoke
    shape as cron_capture_all. Only projects with a connected platform actually
    do any work (report_refresh_audience no-ops otherwise)."""
    resp = _rprojects().scan(ProjectionExpression='projectId')
    items = resp.get('Items', [])
    while resp.get('LastEvaluatedKey'):
        resp = _rprojects().scan(ProjectionExpression='projectId',
                                 ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    fired = 0
    for it in items:
        pid = it.get('projectId')
        if pid:
            _self_invoke({'action': 'cron_refresh_audience_one', 'projectId': pid})
            fired += 1
    return {'ok': True, 'projects': fired}


def cron_refresh_audience_one(body):
    pid = (body.get('projectId') or '').strip()
    if not pid:
        raise RuntimeError('Missing projectId.')
    try:
        return report_refresh_audience({'projectId': pid})
    except Exception as e:
        return {'ok': False, 'projectId': pid, 'error': str(e)[:200]}


def cron_capture_one(body):
    pid   = (body.get('projectId') or '').strip()
    month = (body.get('month') or '').strip() or _current_month()
    if not pid:
        raise RuntimeError('Missing projectId.')
    proj = _rprojects().get_item(Key={'projectId': pid}).get('Item')
    if not proj:
        raise RuntimeError('Unknown project.')
    proj = _dec(proj)

    # 1. Meta Graph insights FIRST — private/owner-only AND free. Pulling these
    #    before the paid Apify scrape lets us skip Apify entirely for any platform
    #    Meta already covers, so we only pay for what's NOT available privately
    #    (e.g. TikTok / YouTube / LinkedIn / Xiaohongshu).
    meta_platforms, meta_error = [], None
    try:
        meta_platforms = _cron_meta_platforms(proj, month)
    except Exception as e:
        meta_error = str(e)[:200]
    meta_covered = {p.get('platform') for p in meta_platforms if p.get('platform')}

    # 1b. Other native/owner-only pulls via the per-client connected tokens —
    #     LinkedIn org analytics, YouTube channel analytics, TikTok current stats.
    #     All free & first-party, so pull before Apify and skip its paid scrape for
    #     any platform a native token already covers (native-first, Apify fallback).
    native_platforms = []
    for label, builder in (('LinkedIn', _cron_linkedin_platforms),
                           ('YouTube',  _cron_youtube_platforms),
                           ('TikTok',   _cron_tiktok_platforms)):
        try:
            native_platforms += builder(proj, month)
        except Exception as e:
            meta_error = ((meta_error + ' | ') if meta_error else '') + label + ': ' + str(e)[:160]
    covered = meta_covered | {p.get('platform') for p in native_platforms if p.get('platform')}

    # 2. Apify scrape (paid, public) — only for platforms not covered privately,
    #    and competitors only when their cadence says so (cost control).
    sc = _cron_apify_scorecard(proj, month, skip=covered,
                               include_competitors=_competitors_due(proj))

    # 3. Overlay the free private metrics (adds cards when Apify was skipped for
    #    them; merges field-level when both ran).
    sc = _merge_meta_platforms(sc, meta_platforms)
    sc = _merge_meta_platforms(sc, native_platforms)
    if meta_error:
        sc = sc or {}
        sc['_meta_error'] = meta_error

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
    # Reconcile each re-captured card against what was saved earlier THIS month:
    #  (a) carry forward audience breakdowns (the daily capture doesn't re-pull
    #      them, so the overwrite would otherwise wipe them); and
    #  (b) keep-last-non-empty — a transient pull failure must not blank a scalar
    #      we already had for the in-progress month (self-heals, never regresses).
    # Only applies to the CURRENT churny month; past months are never re-captured.
    _CARRY_SKIP = {'platform', 'found', 'posts', 'post_sample', 'top_posts', 'captions',
                   'image_urls', 'content_mix', 'top_hashtags', 'breakdowns'}
    prev_by = {c.get('platform'): c for c in (prev_sc.get('platforms') or [])}
    for c in (sc.get('platforms') or []):
        pc = prev_by.get(c.get('platform'))
        if not pc:
            continue
        if pc.get('breakdowns') and not c.get('breakdowns'):
            c['breakdowns'] = pc['breakdowns']
            c['breakdowns_asof'] = pc.get('breakdowns_asof')
        for k, v in pc.items():
            if k in _CARRY_SKIP or isinstance(v, (dict, list)):
                continue
            if c.get(k) in (None, '') and v not in (None, ''):
                c[k] = v

    if not (sc.get('platforms') or []):
        return {'ok': False, 'projectId': pid, 'month': month,
                'reason': 'no data captured', 'meta_error': sc.get('_meta_error')}

    _strip_fb_reach_er(sc)                 # before KPIs so the blend isn't skewed
    kpis = _kpis_from_scorecard(sc)
    recs = prev_recs or {'executive_summary': sc.get('executive_summary', ''),
                         'overall_health': sc.get('overall_health')}
    report_save_month({'data': {'projectId': pid, 'month': month, 'scorecard': sc,
                                'kpis': kpis, 'recommendations': recs, 'live': True},
                       'currentUser': {'email': 'daily-cron@auto'}})
    return {'ok': True, 'projectId': pid, 'month': month,
            'platforms': [c.get('platform') for c in (sc.get('platforms') or [])],
            'meta_error': sc.get('_meta_error')}


def _competitors_due(proj):
    """Whether to (paid-)scrape competitors on this run, per the project's
    `competitor_cadence`: 'daily' (default), 'weekly' (Mondays SGT only), or
    'off'. Competitors have no first-party source, so this is the main remaining
    Apify cost lever now that owned platforms pull natively for free."""
    cad = (proj.get('competitor_cadence') or 'daily').lower()
    if cad == 'off':
        return False
    if cad == 'weekly':
        return (datetime.now(timezone.utc) + timedelta(hours=8)).weekday() == 0  # Mon SGT
    return True


def _cron_apify_scorecard(proj, month, skip=None, include_competitors=True):
    """Run the Apify pipeline synchronously (start → wait → finalize) and return
    the computed scorecard, or {} when the project has no live (scrapable)
    platforms or the scrape yields nothing. `skip` lists platforms already
    covered for free by Meta — they're excluded so we don't pay Apify for them.
    `include_competitors` gates the (paid) competitor scrape for cost control."""
    skip = skip or set()
    handles = proj.get('handles') or {}
    live = [p for p in (proj.get('platforms') or [])
            if p in ACTORS and (handles.get(p) or '').strip() and p not in skip]
    comps = (proj.get('competitors') or []) if include_competitors else []
    # Run Apify when there's ANY paid work to do — owned platforms not covered
    # natively, OR competitors (which have no first-party source and would
    # otherwise be dropped once all owned platforms are covered by native pulls).
    if (not live and not comps) or not APIFY_TOKEN:
        return {}
    try:
        started = handle_start({
            'brand_name':  proj.get('brand') or proj.get('name') or 'brand',
            'domain':      proj.get('domain') or '',
            'location':    proj.get('location') or 'Singapore',
            'platforms':   live,
            'handles':     handles,
            'competitors': comps,
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


_POST_FILL_KEYS = ('image', 'reach', 'impressions', 'interactions', 'reactions',
                   'reactions_by_type', 'shares', 'comments', 'likes', 'views',
                   'saves', 'interaction_rate', 'engagement_rate', 'engagement_rate_basis')


def _is_expiring_thumb(u):
    """True for any third-party CDN thumbnail — those carry a signature that dies
    within weeks. Our own S3 mirror is the only durable form."""
    s = str(u or '')
    return s.startswith('http') and (THUMB_BUCKET + '.s3.') not in s


def _post_text_key(p):
    r"""A stable identity for the same post across two captures: the opening run
    of its caption, stripped to letters and digits. Timestamps and permalinks
    both fail as keys between a public scrape and a native pull — LinkedIn dates
    a post by createdAt while the scrape reads the published date (weeks apart on
    a scheduled post), and the scrape's /posts/…-activity-123… permalink carries
    a different URN from the API's urn:li:ugcPost:456. The caption is the same
    text in both — but only once LinkedIn's own markup is decoded back to the
    plain text a scraper sees: hashtags arrive as {hashtag|\#|Name} and @-mentions
    as @[Display Name](urn:li:organization:123). Leaving the mention markup in
    place buried a URN inside the first 60 characters, so every post that tags
    another page failed to match its scraped twin and silently lost its private
    metrics. '' when the post is too short to identify safely."""
    t = str(p.get('caption') or p.get('text') or '')
    t = re.sub(r'\{hashtag\|\\?#\|([^}]*)\}', r'#\1', t)     # LinkedIn's escaped hashtags
    t = re.sub(r'@\[([^\]]*)\]\((?:urn:)[^)]*\)', r'\1', t)  # …and its @-mention markup
    t = re.sub(r'[^a-z0-9]+', ' ', t.lower()).strip()
    return t[:60] if len(t) >= 25 else ''


def _merge_posts(existing, incoming):
    """Merge a private-insights post list into an existing grid, keeping the best
    of both. Whichever set has MORE thumbnails becomes the base (so a pre-image
    legacy/private capture is upgraded to the imaged one, while a richer public
    Apify grid is preserved); the other set then donates any per-post metric the
    base is missing (e.g. reach, which the imaged pull may not return for an old
    month). Posts are matched by URL, then timestamp, then CAPTION — permalink
    formats and post dates BOTH differ between captures (see _post_text_key), so
    the caption is usually the only key that actually connects the two sets."""
    existing = existing or []
    incoming = incoming or []
    if not incoming:
        return existing
    if not existing:
        return incoming
    ex_imgs = sum(1 for p in existing if p.get('image'))
    in_imgs = sum(1 for p in incoming if p.get('image'))
    base, donor = (incoming, existing) if in_imgs > ex_imgs else (existing, incoming)
    donor_is_fresh = donor is incoming        # `incoming` is always the newer pull
    d_by_ts, d_by_url, d_by_text = {}, {}, {}
    for p in donor:
        k = _to_epoch(p.get('ts'))
        if k is not None:
            d_by_ts.setdefault(k, p)
        u = p.get('url')
        if u:
            d_by_url.setdefault(u, p)
        tk = _post_text_key(p)
        if tk:
            d_by_text.setdefault(tk, p)
    for p in base:
        src = (d_by_url.get(p.get('url')) or d_by_ts.get(_to_epoch(p.get('ts')))
               or d_by_text.get(_post_text_key(p)))
        if not src:
            continue
        for k in _POST_FILL_KEYS:
            cur = p.get(k)
            if (cur is None or cur == '') and src.get(k) not in (None, ''):
                p[k] = src[k]
        # A stored thumbnail whose CDN signature has expired is worse than no
        # thumbnail — it renders as a broken tile forever. The fill loop above
        # can't help: the dead URL is non-empty, so it always "wins". When the
        # equal-thumbnail tie leaves the STALE side as base, take the fresh
        # pull's URL instead; _mirror_scorecard_images then makes it permanent.
        if donor_is_fresh and src.get('image') and _is_expiring_thumb(p.get('image')):
            p['image'] = src['image']
    return base


def _trim_linkedin_posts_to_month(sc, month):
    """Drop LinkedIn grid posts that were published OUTSIDE the month they're
    filed under, and report how many went.

    The public Apify company-posts actor returns the page's last ~20 posts
    regardless of the period being captured, so a mid-July capture files April,
    May and June posts under July. Those posts can never gain private metrics —
    the native pull for July only ever asks LinkedIn about July — so they sit in
    the grid forever showing "Impressions —" and they skew the month's post-level
    averages. Facebook keeps its strays and backfills them instead (see
    _backfill_month_posts); LinkedIn can't, because the /posts finder is the only
    way back to them and it's already month-scoped.

    Only the displayed grid is trimmed. Card-level scalars (impressions, reach,
    engagements…) come from LinkedIn's own period-scoped share statistics, not
    from this list, so no stored KPI moves. Posts with no usable timestamp are
    always kept — an unknown date is not evidence of a wrong one."""
    if not isinstance(sc, dict) or not re.match(r'^\d{4}-\d{2}$', str(month or '')):
        return 0
    since, until = _meta_month_range(month)
    dropped = 0
    for c in (sc.get('platforms') or []):
        if not isinstance(c, dict) or c.get('platform') != 'linkedin':
            continue
        posts = c.get('posts')
        if not isinstance(posts, list):
            continue
        keep = []
        for p in posts:
            e = _to_epoch(p.get('ts')) if isinstance(p, dict) else None
            if e is not None and not (since <= e < until):
                dropped += 1
                continue
            keep.append(p)
        c['posts'] = keep
    return dropped


def _merge_meta_platforms(sc, meta_platforms):
    """Overlay Meta's private metrics onto the scorecard. For a platform already
    present (Apify-scraped IG/FB), the private fields are merged in at the field
    level; post grids are merged so private thumbnails/metrics backfill an
    existing grid without discarding Apify's public counts."""
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
                if k == 'platform' or v is None:
                    continue
                if k == 'posts':
                    by[plat]['posts'] = _merge_posts(by[plat].get('posts'), v)
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
    def _plat_metrics(p):
        # Full per-platform metric slice (mirrors the combined loop below) so the
        # Overview's per-platform filter can trend EVERY metric, not just followers
        # + engagement_rate. Stored on both the month index and each daily snapshot.
        o = {}
        for k, agg in METRIC_AGG.items():
            v = p.get(k)
            if not _is_num(v):
                continue
            v = float(v)
            if agg == 'avg':          o[k] = round(v, 2)
            elif k == 'posts_per_week': o[k] = round(v, 1)
            else:                     o[k] = int(round(v))
        if o.get('net_new_followers') is None:
            inc, dec = p.get('followers_increase'), p.get('followers_decrease')
            if _is_num(inc) or _is_num(dec):
                o['net_new_followers'] = (int(float(inc)) if _is_num(inc) else 0) - (int(float(dec)) if _is_num(dec) else 0)
        return o
    out = {
        'platforms': len(plats),
        'per_platform': {p.get('platform'): _plat_metrics(p) for p in plats},
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


# Graph rejects any since→until wider than 30 days on Instagram insights:
#   "(#100) There cannot be more than 30 days (2592000 s) between since and until"
# _meta_month_range spans a whole calendar month, so every 31-DAY MONTH blew this
# cap and _meta_sum_metric's bare `except` turned it into None — silently blanking
# reach/impressions/engagements/saves/likes/comments/shares for Jan, Mar, May, Jul,
# Aug, Oct and Dec. (Verified live on Homi 2026-07-20: Feb/Apr/Jun/Jul had figures,
# Jan/Mar/May were empty; the current month only survived because `until` is clamped
# to now.) FB Page insights has no such cap, which is why FB looked fine throughout.
_INSIGHTS_MAX_WINDOW = 30 * 86400


def _window_chunks(since, until, span):
    """Tile [since, until) into contiguous chunks no wider than `span`."""
    out, a = [], int(since)
    until = int(until)
    while a < until:
        b = min(a + span, until)
        out.append((a, b))
        a = b
    return out or [(int(since), int(until))]


def _meta_metric_window(node_id, metric, token, since, until, opts=None):
    """One insights call over a window Graph will actually accept."""
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
    except Exception as e:
        # An invalid-metric #100 is indistinguishable from "no data" to the caller,
        # which is exactly how the FB rename (2026-07-17) and this 30-day cap both
        # went unnoticed for months. Leave the None contract alone, but log it.
        print('meta insight failed: %s %s %s-%s: %s' % (node_id, metric, since, until, str(e)[:160]))
        return None


def _meta_sum_metric(node_id, metric, token, since, until, opts=None):
    """Sum one insight metric over [since, until), splitting the request into
    ≤30-day chunks so a 31-day month doesn't trip Graph's window cap. Chunks tile
    the range contiguously and their results are summed, which is identical to the
    single-call semantics (this always summed the daily rows). Partial success is
    kept — one dead chunk no longer blanks the whole month."""
    chunks = _window_chunks(since, until, _INSIGHTS_MAX_WINDOW)
    if len(chunks) == 1:
        return _meta_metric_window(node_id, metric, token, since, until, opts)
    total, got = 0, False
    for a, b in chunks:
        v = _meta_metric_window(node_id, metric, token, a, b, opts)
        if v is not None:
            total += v
            got = True
    return total if got else None


def _meta_split_metric(node_id, metric, token, since, until, breakdown, opts=None):
    """One insight metric split by a breakdown → {bucket: total}, summed over the
    daily rows and over the ≤30-day chunks _meta_sum_metric uses. None when the
    call fails or the breakdown came back empty.

    Two response shapes, because Facebook and Instagram disagree:
      • FB Page insights repeats each day's row once per bucket and tags it with
        the breakdown name as a top-level key (values:[{value, is_from_ads:'1'}]).
      • IG returns total_value.breakdowns[].results[].dimension_values.
    A bucket with nothing in it is simply absent from the response — Meta only
    returns non-zero breakdown rows — so a missing key means zero, not an error.

    PROBED LIVE 2026-07-21 (Catch Of The Day SG, June 2026), because the docs and
    a previous pass here disagreed. Facebook CAN split impressions after all:
    page_media_view + breakdown=is_from_ads → organic 3,594 / paid 114,666. What
    it cannot split is engagement or reach — page_post_engagements and
    page_total_media_view_unique silently IGNORE the breakdown and hand back
    untagged rows, which is why only impressions is split on the FB card."""
    out, got = {}, False
    o = dict(opts or {}); o['breakdown'] = breakdown
    for a, b in _window_chunks(since, until, _INSIGHTS_MAX_WINDOW):
        try:
            params = {'metric': metric, 'period': 'day', 'since': a, 'until': b, 'access_token': token}
            params.update(o)
            rows = (_meta_get('/' + node_id + '/insights', params).get('data') or [])
        except Exception as e:
            print('meta split failed: %s %s/%s: %s' % (node_id, metric, breakdown, str(e)[:160]))
            continue
        if not rows:
            continue
        row = rows[0]
        for res in ((row.get('total_value') or {}).get('breakdowns') or []):
            for r in (res.get('results') or []):
                vals = r.get('dimension_values') or []
                if vals:
                    out[str(vals[0])] = out.get(str(vals[0]), 0) + (_num(r.get('value')) or 0); got = True
        for v in (row.get('values') or []):
            if breakdown in v:
                k = str(v[breakdown])
                out[k] = out.get(k, 0) + (_num(v.get('value')) or 0); got = True
    return out if got else None


def _meta_fb_insights(page_id, token, since, until):
    """Facebook Page insights for the month.

    Meta deprecated a swathe of Page metrics in current Graph API versions — they
    now return "(#100) not a valid insights metric". Confirmed dead (2026-07):
    page_impressions, page_impressions_unique, page_fan_adds/removes,
    page_posts_impressions, all post_impressions*.

    CORRECTION 2026-07-17: an earlier pass here concluded from those #100s that FB
    reach had been DELETED. Wrong — Meta RENAMED it. Probed live against v23.0:
    page_impressions_unique → page_total_media_view_unique (page reach) and
    post_impressions_unique → post_total_media_view_unique (post reach) both
    return real data. Never infer deletion from #100 without probing the new name.

    Surviving/renamed equivalents in use: page_total_media_view_unique (reach),
    page_media_view (impressions), page_daily_follows_unique /
    page_daily_unfollows_unique (follower growth).

    Impressions was page_posts_impressions_organic until 2026-07-17. That is a
    much NARROWER universe (organic page posts only) than page-level all-media
    reach, so pairing the two produced reach >> impressions (Homi June 2026:
    851,817 reach vs 632 impressions) and engagements that EXCEEDED impressions
    on every page probed — which tripped the guard below and suppressed FB
    engagement rate entirely. page_media_view is Meta's stated replacement for
    page_impressions and shares reach's page-level all-media universe, so the
    two are comparable (Homi: 5,810,708 / 851,817 = frequency 6.8). NOTE: this
    makes FB impressions jump by orders of magnitude vs months saved before
    2026-07-17 — that seam is expected, not a regression.

    Reach is summed over daily rows, so it OVER-counts anyone who saw content on
    more than one day (metric_type=total_value is silently ignored for this
    metric). Same approximation IG has always used. period=days_28's last row is
    the honest trailing-28-day unique if a true monthly figure is ever needed."""
    out = {}
    def s(k, v):
        if v is not None: out[k] = v
    impressions = _meta_sum_metric(page_id, 'page_media_view', token, since, until)
    s('impressions', impressions)
    # Organic vs paid impressions — the one split Facebook still gives us. '1' is
    # ad-driven, '0' is organic; the two add up to the untagged total, so this is a
    # genuine decomposition (unlike reach, where a person reached by both an ad and
    # a post would be counted twice).
    fb_split = _meta_split_metric(page_id, 'page_media_view', token, since, until, 'is_from_ads')
    if fb_split:
        s('organic_impressions', fb_split.get('0'))
        s('paid_impressions',    fb_split.get('1'))
    s('reach', _meta_sum_metric(page_id, 'page_total_media_view_unique', token, since, until))
    # page_post_engagements = reactions + comments + shares + clicks on Page posts,
    # matching the Brandwatch FB interaction-rate formula's numerator directly.
    engagements = _meta_sum_metric(page_id, 'page_post_engagements', token, since, until)
    s('engagements', engagements)
    # Express FB engagement rate over impressions and label it as such
    # (engagement_rate_impr) — engagements are post-level while reach is page-level
    # all-media, so reach is the wrong denominator here (IG keeps reach, its own
    # official ER definition). Only when internally consistent (engagements ≤
    # impressions); otherwise suppress rather than surface a bogus rate.
    if impressions and engagements is not None and 0 < engagements <= impressions:
        s('engagement_rate_impr', round(engagements / impressions * 100, 2))
    s('profile_views', _meta_sum_metric(page_id, 'page_views_total', token, since, until))
    adds = _meta_sum_metric(page_id, 'page_daily_follows_unique', token, since, until)
    rem  = _meta_sum_metric(page_id, 'page_daily_unfollows_unique', token, since, until)
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
    reach = _meta_sum_metric(ig_id, 'reach', token, since, until)
    s('reach', reach)
    # profile_views is one of the metrics Meta moved to total_value-only; without
    # `tv` Graph answers "(#100) The following metrics (profile_views) should be
    # specified with parameter metric_type=total_value" and IG profile views were
    # silently blank on every capture. Surfaced the moment _meta_metric_window
    # started logging its failures instead of swallowing them.
    s('profile_views',        _meta_sum_metric(ig_id, 'profile_views', token, since, until, tv))
    s('impressions',          _meta_sum_metric(ig_id, 'views', token, since, until, tv))
    s('engaged_users_daily',  _meta_sum_metric(ig_id, 'accounts_engaged', token, since, until, tv))
    # total_interactions = likes + comments + saves + shares, matching IG's own
    # ERR = Total Engagements / Reach definition.
    engagements = _meta_sum_metric(ig_id, 'total_interactions', token, since, until, tv)
    s('engagements', engagements)
    if reach and engagements is not None:
        s('engagement_rate', round(engagements / reach * 100, 2))
    # ── Organic vs paid ──────────────────────────────────────────────────────
    # Instagram has no organic/paid flag; media_product_type is the de facto
    # split — AD is promoted, POST/REEL/CAROUSEL_CONTAINER/STORY are organic.
    # Probed live 2026-07-21: works on views, total_interactions and reach.
    # Impressions decompose additively. Engagement rate does NOT — it is computed
    # per bucket (bucket interactions / bucket reach), because the reach buckets
    # each count uniques within themselves; someone reached by both an ad and a
    # post is in both, so they don't sum to the account's unique reach and
    # organic ≠ total − paid here.
    def _split(metric):
        d = _meta_split_metric(ig_id, metric, token, since, until, 'media_product_type', tv)
        if not d:
            return None, None
        paid = _num(d.get('AD')) or 0
        return sum(v for k, v in d.items() if k != 'AD'), paid
    org_impr, paid_impr = _split('views')
    s('organic_impressions', org_impr); s('paid_impressions', paid_impr)
    org_int, paid_int = _split('total_interactions')
    org_reach, paid_reach = _split('reach')
    if org_reach:
        s('organic_engagement_rate', round((org_int or 0) / org_reach * 100, 2))
    if paid_reach:
        s('paid_engagement_rate', round((paid_int or 0) / paid_reach * 100, 2))
    s('likes',                _meta_sum_metric(ig_id, 'likes', token, since, until, tv))
    s('comments',             _meta_sum_metric(ig_id, 'comments', token, since, until, tv))
    s('shares',               _meta_sum_metric(ig_id, 'shares', token, since, until, tv))
    s('saves',                _meta_sum_metric(ig_id, 'saves', token, since, until, tv))
    s('profile_cta_clicks',   _meta_sum_metric(ig_id, 'profile_links_taps', token, since, until, tv))
    s('website_clicks',       _meta_sum_metric(ig_id, 'website_clicks', token, since, until, tv))
    try:
        p = _meta_get('/' + ig_id, {'fields': 'followers_count', 'access_token': token})
        s('followers', p.get('followers_count'))
    except Exception:
        pass
    return out


# Instagram audience demographics (current followers) — follower_demographics with
# a breakdown returns real data in v23.0 (unlike FB's fully-deprecated page_fans_*).
_IG_GENDER = {'F': 'Female', 'M': 'Male', 'U': 'Unknown'}
_IG_AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+']


def _ig_demographic(ig_id, token, breakdown):
    """One follower_demographics breakdown → sorted [{name,value}]."""
    try:
        j = _meta_get('/' + ig_id + '/insights', {
            'metric': 'follower_demographics', 'period': 'lifetime',
            'metric_type': 'total_value', 'breakdown': breakdown, 'access_token': token})
    except Exception:
        return []
    rows = j.get('data') or []
    if not rows:
        return []
    bds = ((rows[0].get('total_value') or {}).get('breakdowns') or [])
    if not bds:
        return []
    out = []
    for r in ((bds[0] or {}).get('results') or []):
        dims = r.get('dimension_values') or []
        name = dims[0] if dims else ''
        v = _num(r.get('value')) or 0
        if name and v:
            out.append({'name': name, 'value': v})
    return sorted(out, key=lambda x: -x['value'])


def _ig_breakdowns(ig_id, token):
    """Current-follower demographics: age, gender, top countries, top cities."""
    out = {}
    age = _ig_demographic(ig_id, token, 'age')
    if age:
        age.sort(key=lambda r: _IG_AGE_ORDER.index(r['name']) if r['name'] in _IG_AGE_ORDER else 99)
        out['ig_age'] = age
    gen = _ig_demographic(ig_id, token, 'gender')
    if gen:
        for r in gen:
            r['name'] = _IG_GENDER.get(r['name'], r['name'])
        out['ig_gender'] = gen
    ctry = _ig_demographic(ig_id, token, 'country')
    if ctry:
        out['ig_country'] = ctry[:10]
    city = _ig_demographic(ig_id, token, 'city')
    if city:
        out['ig_city'] = city[:10]
    return out


# Page-level fan demographics. Meta has retired these piecemeal rather than all
# at once, and which ones a Page still serves varies by API version and by the
# Page itself — so ASK for each and keep whatever comes back, instead of assuming
# the whole family is gone. A rejected metric raises and is skipped; the audience
# tab falls back to its "not available" note only when nothing at all returns.
_FB_FAN_METRICS = (
    ('fb_country',    'page_fans_country'),
    ('fb_city',       'page_fans_city'),
    ('fb_gender_age', 'page_fans_gender_age'),
    ('fb_locale',     'page_fans_locale'),
)
_FB_GENDER = {'M': 'Men', 'F': 'Women', 'U': 'Unknown'}


def _fb_fan_metric(page_id, token, metric, why=None):
    """One lifetime page_fans_* metric → sorted [{name,value}]. Returns [] when the
    Page or the API version no longer serves it, recording the reason in `why` so a
    retired metric stays distinguishable from a permission or token problem —
    otherwise every cause looks identical from the outside."""
    try:
        j = _meta_get('/' + page_id + '/insights', {
            'metric': metric, 'period': 'lifetime', 'access_token': token})
    except Exception as e:
        if why is not None:
            why[metric] = str(e)[:200]
        return []
    rows = j.get('data') or []
    if not rows:
        return []
    vals = rows[0].get('values') or []
    if not vals:
        return []
    val = (vals[-1] or {}).get('value') or {}
    if not isinstance(val, dict):
        return []
    out = []
    for name, v in val.items():
        n = _num(v) or 0
        if name and n:
            # 'M.25-34' → 'Men 25-34'
            if '.' in name and name.split('.')[0] in _FB_GENDER:
                g, _, band = name.partition('.')
                name = _FB_GENDER[g] + ' ' + band
            out.append({'name': name, 'value': n})
    return sorted(out, key=lambda x: -x['value'])


def _fb_breakdowns(page_id, token, why=None):
    """Whatever page-level fan demographics this Page still serves."""
    out = {}
    for key, metric in _FB_FAN_METRICS:
        rows = _fb_fan_metric(page_id, token, metric, why)
        if rows:
            out[key] = rows[:10]
        elif why is not None and metric not in why:
            why[metric] = 'returned no data (accepted, but empty)'
    return out


def _meta_in_window(rows, since, until):
    """Keep only posts whose timestamp falls in the month window (defensive — some
    edges don't honour since/until server-side)."""
    out = []
    for r in rows:
        e = _to_epoch(r.get('ts'))
        if e is None or (since <= e < until):
            out.append(r)
    return out


def _meta_ig_post_metrics(media_id, token):
    """Per-post reach + saves (+ shares, total interactions) for one IG media,
    via a single insights call. All optional enrichments — any failure just
    leaves them blank. Metrics are requested most-complete-first, falling back
    so an unsupported metric on a given media type (e.g. shares on a static
    image) can't blank the whole call. Mirrors _meta_fb_post_metrics for FB."""
    if not media_id:
        return {}
    out = {}
    # `views` (post-Jul-2024 replacement for the deprecated per-media impressions)
    # is requested in the leading tiers; the tail tiers drop it so a media type
    # that rejects `views` still yields reach/saves rather than blanking the call.
    for metrics in ('reach,saved,shares,total_interactions,views',
                    'reach,saved,total_interactions,views',
                    'reach,saved,views', 'reach,views',
                    'reach,saved,shares,total_interactions',
                    'reach,saved,total_interactions',
                    'reach,saved', 'reach'):
        try:
            rows = (_meta_get('/' + media_id + '/insights',
                              {'metric': metrics, 'access_token': token}).get('data') or [])
        except Exception:
            continue
        for r in rows:
            vals = r.get('values') or []
            val = vals[0].get('value') if vals else (r.get('total_value') or {}).get('value')
            n = _num(val)
            if n is None:
                continue
            name = r.get('name')
            if name == 'reach':
                out['reach'] = n
            elif name == 'saved':
                out['saves'] = n
            elif name == 'shares':
                out['shares'] = n
            elif name == 'total_interactions':
                out['interactions'] = n
            elif name == 'views':
                out['views'] = n
        if out:
            break
    return out


def _meta_ig_posts(ig_id, token, since, until):
    """This month's Instagram posts in the internal post shape (for the grid +
    post-derived metrics). Needs instagram_basic; per-post reach/saves/shares
    need instagram_manage_insights."""
    try:
        rows = _meta_get('/' + ig_id + '/media', {
            'fields': 'id,caption,media_type,media_product_type,media_url,thumbnail_url,'
                      'permalink,like_count,comments_count,timestamp',
            'since': since, 'until': until, 'limit': 50, 'access_token': token}).get('data') or []
    except Exception:
        return []
    # Per-post reach + saves each need one insights call; fetch them concurrently
    # so a full month of posts doesn't serialise into a slow pull (mirrors FB).
    ids = [m.get('id') for m in rows if m.get('id')]
    met_by_id = {}
    if ids:
        try:
            with ThreadPoolExecutor(max_workers=min(8, len(ids))) as ex:
                for mid, res in zip(ids, ex.map(lambda i: _meta_ig_post_metrics(i, token), ids)):
                    met_by_id[mid] = res or {}
        except Exception:
            met_by_id = {}
    out = []
    for m in rows:
        mt = (m.get('media_type') or '').upper()
        pt = (m.get('media_product_type') or '').upper()
        typ = 'video' if (mt == 'VIDEO' or pt == 'REELS') else ('carousel' if mt == 'CAROUSEL_ALBUM' else 'image')
        text = m.get('caption') or ''
        met = met_by_id.get(m.get('id')) or {}
        reach = met.get('reach')
        interactions = met.get('interactions')
        rec = {
            'ts': m.get('timestamp'), 'likes': _num(m.get('like_count')),
            'comments': _num(m.get('comments_count')),
            'shares': met.get('shares'), 'views': met.get('views'),
            'reach': reach, 'saves': met.get('saves'), 'interactions': interactions,
            'type': typ, 'hashtags': re.findall(r'#(\w+)', text),
            'text': ' '.join(text.split())[:160], 'caption': ' '.join(text.split())[:400],
            'image': m.get('thumbnail_url') or m.get('media_url') or '',
            'url': m.get('permalink') or '',
            'post_id': m.get('id') or ''}      # stable key for tags/overrides
        if reach and interactions is not None:
            rec['interaction_rate'] = round(interactions / reach * 100, 2)
        out.append(rec)
    return _meta_in_window(out, since, until)


# Meta names two reactions oddly vs. the rest of the product ("sorry" = Sad,
# "anger" = Angry) — normalise to the labels the report/frontend expect.
_FB_REACTION_ALIAS = {'sorry': 'sad', 'anger': 'angry'}


def _meta_fb_post_metrics(post_id, token):
    """Per-post unique reach + reaction-type breakdown + video views for one Page
    post. Returns a dict {reach, reactions_by_type, views} — all optional
    enrichments, so any failure just leaves them blank. post_video_views is
    requested first; if that metric is rejected (e.g. a non-video post) the call
    is retried without it so reach + reactions still come back.

    FIXED 2026-07-17 — this returned {} for EVERY post since Meta's deprecation.
    post_impressions_unique is dead (#100) and appeared in BOTH metric strings;
    Graph rejects the whole call if any one metric in the comma list is invalid,
    so reactions_by_type and views were collateral damage, not just reach. Post
    reach was RENAMED, not removed: post_impressions_unique →
    post_total_media_view_unique (probed live, returns real values)."""
    if not post_id:
        return {}
    out = {}
    for metric in ('post_total_media_view_unique,post_reactions_by_type_total,post_video_views',
                   'post_total_media_view_unique,post_reactions_by_type_total'):
        try:
            rows = (_meta_get('/' + post_id + '/insights',
                              {'metric': metric, 'access_token': token}).get('data') or [])
        except Exception:
            continue
        for r in rows:
            # The renamed metrics return a lifetime row AND trailing per-day rows
            # (the old post_impressions_unique only ever returned lifetime). The
            # day rows are near-always 0 and land LAST, so without this guard they
            # overwrite the real lifetime figure with zero.
            if r.get('period') != 'lifetime':
                continue
            name = r.get('name')
            vals = r.get('values') or []
            if not vals:
                continue
            val = vals[0].get('value')
            if name == 'post_total_media_view_unique':
                out['reach'] = _num(val)
            elif name == 'post_video_views':
                n = _num(val)
                if n:
                    out['views'] = n
            elif name == 'post_reactions_by_type_total' and isinstance(val, dict):
                clean = {}
                for k, v in val.items():
                    n = _num(v)
                    if n:
                        key = _FB_REACTION_ALIAS.get(str(k).lower(), str(k).lower())
                        clean[key] = clean.get(key, 0) + n
                if clean:
                    out['reactions_by_type'] = clean
        if out:
            break
    return out


def _meta_fb_posts(page_id, token, since, until):
    """This month's Facebook Page posts in the internal post shape. Needs
    pages_read_engagement + pages_read_user_content. Carries the post thumbnail
    (full_picture, falling back to the first attachment image) plus per-post
    reach / interactions so the grid matches the report's FB metric set."""
    try:
        rows = _meta_get('/' + page_id + '/posts', {
            'fields': 'id,message,created_time,permalink_url,full_picture,status_type,'
                      'attachments{media_type,media{image{src}}},likes.summary(true).limit(0),'
                      'comments.summary(true).limit(0),shares',
            'since': since, 'until': until, 'limit': 50, 'access_token': token}).get('data') or []
    except Exception:
        return []
    # Per-post reach + reaction breakdown need one insights call each; fetch them
    # concurrently so a full month of posts doesn't serialise into a slow pull.
    ids = [p.get('id') for p in rows if p.get('id')]
    met_by_id = {}
    if ids:
        try:
            with ThreadPoolExecutor(max_workers=min(8, len(ids))) as ex:
                for pid, res in zip(ids, ex.map(lambda i: _meta_fb_post_metrics(i, token), ids)):
                    met_by_id[pid] = res or {}
        except Exception:
            met_by_id = {}
    out = []
    for p in rows:
        att = (((p.get('attachments') or {}).get('data') or [{}]) or [{}])[0]
        mt = (att.get('media_type') or p.get('status_type') or '').lower()
        typ = 'video' if 'video' in mt else ('carousel' if ('album' in mt or 'carousel' in mt) else 'image')
        text = p.get('message') or ''
        # full_picture covers most posts; fall back to the first attachment's image
        # (e.g. some video/link posts) so the grid thumbnail isn't left blank.
        image = p.get('full_picture') or (((att.get('media') or {}).get('image') or {}).get('src')) or ''
        likes = _num((((p.get('likes') or {}).get('summary') or {}).get('total_count')))
        comments = _num((((p.get('comments') or {}).get('summary') or {}).get('total_count')))
        shares = _num((p.get('shares') or {}).get('count'))
        parts = [x for x in (likes, comments, shares) if x is not None]
        interactions = sum(parts) if parts else None
        met = met_by_id.get(p.get('id')) or {}
        reach = met.get('reach')
        rec = {
            'ts': p.get('created_time'),
            'likes': likes, 'reactions': likes,
            'comments': comments, 'shares': shares, 'views': met.get('views'),
            'reach': reach, 'interactions': interactions,
            'type': typ, 'hashtags': re.findall(r'#(\w+)', text),
            'text': ' '.join(text.split())[:160], 'caption': ' '.join(text.split())[:400],
            'image': image, 'url': p.get('permalink_url') or '',
            # Graph's own post id is immutable; the permalink is not (Facebook hands
            # back rotating `pfbid…` links), and the report keys a post's tags and
            # format overrides off whatever identifies it here.
            'post_id': p.get('id') or ''}
        rbt = met.get('reactions_by_type')
        if rbt:
            rec['reactions_by_type'] = rbt
        if reach and interactions is not None:
            rec['interaction_rate'] = round(interactions / reach * 100, 2)
        out.append(rec)
    return _meta_in_window(out, since, until)


def _meta_card(platform, posts, insights):
    """Build a scorecard platform card from Meta data: post-derived analytics
    (grid, cadence, content mix, avg likes, engagement rate) computed via the
    shared _metrics_from, with the private insight metrics layered on top
    (authoritative for followers/reach/impressions/saves/etc.)."""
    card = {'platform': platform, 'found': True}
    if posts:
        d = _metrics_from(insights.get('followers'), None, False, '', '', '', '', posts)
        for k in ('avg_likes', 'avg_comments', 'engagement_rate', 'avg_video_views',
                  'posts_per_week', 'days_since_last_post', 'content_mix', 'top_vs_median',
                  'hashtag_count', 'top_hashtags', 'post_sample', 'top_posts', 'posts',
                  'captions', 'image_urls'):
            v = d.get(k)
            if v is not None:
                card[k] = v
        # Sum any per-post reaction-type breakdowns into a card-level total so the
        # report's Reactions chart can render (FB only — IG posts don't carry this).
        agg = {}
        for p in posts:
            rbt = p.get('reactions_by_type')
            if isinstance(rbt, dict):
                for k, v in rbt.items():
                    n = _num(v)
                    if n:
                        agg[k] = agg.get(k, 0) + n
        if agg:
            card['reactions_by_type'] = agg
    card.update(insights)
    # Card-level Reactions: no Meta insight metric reports it, so the only honest
    # source is the per-post figures. Without this the report showed "Reactions 0"
    # for Facebook while the reaction-type breakdown underneath said otherwise —
    # a stale 0 carried in from an older Apify card by _merge_meta_platforms.
    if card.get('reactions') in (None, 0):
        tot = sum(n for n in (_num(p.get('reactions')) for p in (posts or [])) if n)
        if not tot:
            tot = sum((_num(v) or 0) for v in (card.get('reactions_by_type') or {}).values())
        if tot:
            card['reactions'] = tot
    return card


def _cron_meta_platforms(proj, month):
    """Pull this project's private IG/FB insights for the month, gated to the
    platforms the project actually tracks. Returns [] when no Meta token is
    available, no FB/IG handle exists, or the page can't be resolved.

    Token preference: the per-client connected Meta token (covers pages the
    client connected via their OWN login) first, falling back to the global
    agency system-user token. This makes the server path strictly more capable
    than the old browser-only 'Add private insights' flow."""
    token = ((proj.get('connections') or {}).get('meta') or {}).get('token') or META_ACCESS_TOKEN
    if not token:
        return []
    handles = proj.get('handles') or {}
    plats   = set(proj.get('platforms') or [])
    want_fb = ('facebook'  in plats) or bool(handles.get('facebook'))
    want_ig = ('instagram' in plats) or bool(handles.get('instagram'))
    if not (want_fb or want_ig):
        return []
    meta = _meta_resolve(proj, token)
    if not meta:
        return []
    since, until = _meta_month_range(month)
    out = []
    if want_ig and meta.get('igId'):
        ig    = _meta_ig_insights(meta['igId'], meta['pageToken'], since, until)
        posts = _meta_ig_posts(meta['igId'], meta['pageToken'], since, until)
        if ig or posts:
            out.append(_meta_card('instagram', posts, ig))
    if want_fb and meta.get('pageId'):
        fb    = _meta_fb_insights(meta['pageId'], meta['pageToken'], since, until)
        posts = _meta_fb_posts(meta['pageId'], meta['pageToken'], since, until)
        if fb or posts:
            card = _meta_card('facebook', posts, fb)
            # FB has no reach-based engagement rate — drop the post-derived one so we
            # don't show a "(reach)" figure; engagement_rate_impr is the honest metric.
            card.pop('engagement_rate', None)
            out.append(card)
    return out


# ──────────────────────────────────────────────────────────────────────────────
# LinkedIn (Community Management API) — private org analytics via the per-client
# connected member token (must hold ADMINISTRATOR on the company page). Unlike
# Meta (one global system token), LinkedIn org stats need a member token, so we
# read it from proj['connections']['linkedin']. Cards match _meta_card's shape.
# ──────────────────────────────────────────────────────────────────────────────
def _li_get(path, token, params=None, raw=None):
    params = dict(params or {})
    # LinkedIn's Rest.li 2.0 parser needs the `timeIntervals` value's parens/colons
    # LITERAL. requests would percent-encode them, which the API rejects as a syntax
    # error (PARAM_INVALID) — so append it raw and let requests encode the rest.
    # `raw` carries the same treatment for other Rest.li facets whose value is a
    # List(...)/tuple the caller has already encoded (e.g. shares/ugcPosts facets).
    ti = params.pop('timeIntervals', None)
    url = LINKEDIN_API + path
    if params:
        url += '?' + urlencode(params)
    if ti is not None:
        url += ('&' if '?' in url else '?') + 'timeIntervals=' + ti
    for _rk, _rv in (raw or {}).items():
        url += ('&' if '?' in url else '?') + _rk + '=' + _rv
    r = requests.get(url, timeout=25, headers={
        'Authorization': 'Bearer ' + token,
        'LinkedIn-Version': LINKEDIN_API_VERSION,
        'X-Restli-Protocol-Version': '2.0.0'})
    j = r.json() if r.content else {}
    # Only a NUMERIC status ≥ 400 signals an error. Some payloads (e.g. the Images
    # API) carry a non-numeric `status` like "AVAILABLE"; int()-ing that would throw
    # and be mistaken for a failed call, blanking resolved thumbnails.
    if isinstance(j, dict):
        code = j.get('status')
        http_err = isinstance(code, int) and code >= 400
        if not http_err and isinstance(code, str) and code.isdigit():
            http_err = int(code) >= 400
        if j.get('serviceErrorCode') or http_err:
            raise RuntimeError(j.get('message') or j.get('error_description') or f'LinkedIn API {r.status_code}')
    return j


def _li_norm_slug(h):
    """The tracked LinkedIn handle → a company vanityName slug. Personal profiles
    (/in/…) return '' since org analytics don't apply to them."""
    s = str(h or '').strip().lower()
    s = re.sub(r'^https?://(www\.)?linkedin\.com/', '', s)
    m = re.search(r'company/([a-z0-9_\-%.]+)', s)
    if m:
        return m.group(1).strip('/')
    s = s.lstrip('@').strip('/')
    if s.startswith('in/') or '/' in s:
        return ''
    return s


def _li_resolve_org(proj, token):
    """Resolve {id,name} for the org this client tracks. Prefer a direct
    vanityName lookup from the handle; else fall back to the single org the
    token administers."""
    slug = _li_norm_slug((proj.get('handles') or {}).get('linkedin'))
    if slug:
        try:
            els = _li_get('/organizations', token, {'q': 'vanityName', 'vanityName': slug}).get('elements') or []
            if els:
                o = els[0]
                return {'id': str(o.get('id')), 'name': o.get('localizedName') or slug}
        except Exception:
            pass
    try:
        els = _li_get('/organizationAcls', token,
                      {'q': 'roleAssignee', 'role': 'ADMINISTRATOR', 'state': 'APPROVED'}).get('elements') or []
        urns = [e.get('organization') or e.get('organizationTarget') for e in els]
        ids  = sorted({u.rsplit(':', 1)[-1] for u in urns if u})
        if len(ids) == 1:
            oid, name = ids[0], (slug or 'LinkedIn')
            try:
                o = _li_get('/organizations/' + oid, token, {'fields': 'id,localizedName,vanityName'})
                name = o.get('localizedName') or name
            except Exception:
                pass
            return {'id': oid, 'name': name}
    except Exception:
        pass
    return None


def _li_network_size(oid, token):
    try:
        d = _li_get('/networkSizes/urn:li:organization:' + oid, token, {'edgeType': 'CompanyFollowedByMember'})
        return _num(d.get('firstDegreeSize'))
    except Exception:
        return None


def _li_time_intervals(since_ms, until_ms):
    return f'(timeRange:(start:{since_ms},end:{until_ms}),timeGranularityType:DAY)'


def _li_share_stats(oid, token, since_ms, until_ms):
    """Sum this month's daily organic share statistics → impressions, reach,
    interactions, engagement rate. Raises on access errors so the caller can
    surface a 'reconnect / missing scope' note."""
    els = _li_get('/organizationalEntityShareStatistics', token, {
        'q': 'organizationalEntity',
        'organizationalEntity': 'urn:li:organization:' + oid,
        'timeIntervals': _li_time_intervals(since_ms, until_ms)}).get('elements') or []
    agg = {'impressionCount': 0, 'uniqueImpressionsCount': 0, 'clickCount': 0,
           'likeCount': 0, 'commentCount': 0, 'shareCount': 0}
    got = False
    for e in els:
        t = e.get('totalShareStatistics') or {}
        for k in agg:
            agg[k] += _num(t.get(k)) or 0
        got = True
    if not got:
        return {}
    out = {}
    def s(k, v):
        if v:
            out[k] = v
    impressions = agg['impressionCount'] or None
    s('impressions', impressions)
    reach = agg['uniqueImpressionsCount'] or None
    s('reach', reach); s('page_reach', reach)
    s('clicks', agg['clickCount']); s('likes', agg['likeCount'])
    s('comments', agg['commentCount']); s('shares', agg['shareCount'])
    interactions = agg['likeCount'] + agg['commentCount'] + agg['shareCount'] + agg['clickCount']
    s('engagements', interactions)
    # LinkedIn's own engagement rate is engagements / IMPRESSIONS — clicks count as
    # engagements and the denominator is impressions, not unique reach (LinkedIn
    # prioritises impressions, and that's what its native analytics reports). This
    # used to divide reactions+comments+shares by reach, which read far lower than
    # the client's own LinkedIn dashboard. Emitted as engagement_rate_impr (like
    # Facebook) so the label says which denominator it used; Instagram keeps
    # engagement_rate over reach, which is Instagram's own definition.
    if impressions and 0 < interactions <= impressions:
        out['engagement_rate_impr'] = round(interactions / impressions * 100, 2)
    return out


def _li_follower_gains(oid, token, since_ms, until_ms):
    try:
        els = _li_get('/organizationalEntityFollowerStatistics', token, {
            'q': 'organizationalEntity',
            'organizationalEntity': 'urn:li:organization:' + oid,
            'timeIntervals': _li_time_intervals(since_ms, until_ms)}).get('elements') or []
    except Exception:
        return {}
    total, got = 0, False
    for e in els:
        g = e.get('followerGains') or {}
        total += (_num(g.get('organicFollowerGain')) or 0) + (_num(g.get('paidFollowerGain')) or 0)
        got = True
    if not got:
        return {}
    return {'followers_increase': total, 'net_new_followers': total, 'followers_growth_30d': total}


def _li_video_thumb(urn, token, _cache):
    """Resolve a urn:li:video:… to its cover still. The Videos API hands back a
    ready-to-use media.licdn.com `thumbnail` URL — LinkedIn generates one even
    when the poster never uploaded a custom cover — so video posts get a real
    thumbnail instead of the type placeholder. '' on any failure."""
    if not urn or not isinstance(urn, str) or ':video:' not in urn:
        return ''
    if urn in _cache:
        return _cache[urn]
    url = ''
    try:
        d = _li_get('/videos/' + quote(urn, safe=''), token) or {}
        url = d.get('thumbnail') or ''
    except Exception:
        url = ''
    _cache[urn] = url
    return url


def _li_image_url(urn, token, _cache):
    """Resolve a urn:li:image:… to a displayable media.licdn.com download URL
    (cached per pull to avoid re-fetching a repeated asset). '' on any failure
    or for non-image URNs (e.g. video) — see _li_video_thumb for those."""
    if not urn or not isinstance(urn, str) or ':image:' not in urn:
        return ''
    if urn in _cache:
        return _cache[urn]
    url = ''
    try:
        d = _li_get('/images/' + quote(urn, safe=''), token) or {}
        url = d.get('downloadUrl') or ''
    except Exception:
        url = ''
    _cache[urn] = url
    return url


def _li_content_media(content, token, _cache):
    """(image_url, type) from a Posts API `content` object across its shapes:
    single media (image/video), multiImage carousel, and shared article."""
    if not isinstance(content, dict):
        return '', 'image'
    media = content.get('media')
    if isinstance(media, dict):
        mid = media.get('id') or ''
        typ = 'video' if isinstance(mid, str) and ':video:' in mid else 'image'
        if typ == 'video':
            # `id` is the video URN, so the old `id or thumbnail` never reached
            # the thumbnail and every video came back coverless. Try the post's
            # own thumbnail URN first (free — already in this payload), then pay
            # for a Videos API lookup on the video URN.
            return (_li_image_url(media.get('thumbnail'), token, _cache)
                    or _li_video_thumb(mid, token, _cache)), typ
        return _li_image_url(mid or media.get('thumbnail'), token, _cache), typ
    multi = content.get('multiImage')
    if isinstance(multi, dict):
        for im in (multi.get('images') or []):
            u = _li_image_url((im or {}).get('id'), token, _cache)
            if u:
                return u, 'carousel'
        return '', 'carousel'
    art = content.get('article')
    if isinstance(art, dict):
        return _li_image_url(art.get('thumbnail'), token, _cache), 'image'
    return '', 'image'


def _li_post_stats(oid, token, post_ids):
    """Best-effort PER-POST LinkedIn statistics (impressions, reach, reactions,
    comments, shares, interaction rate) via organizationalEntityShareStatistics
    with a shares/ugcPosts facet — the one platform where per-post impressions
    are cleanly available. Returns {post_urn: {...}}. Needs org-admin scope
    (rw_organization_admin); per-share stats are LIFETIME (LinkedIn rejects a
    timeIntervals filter alongside a specific-share facet). Any failure / missing
    scope → {} so posts keep their existing (blank) values. Batched ≤20/URN type.

    NOTE: per-share facet encoding needs live verification against a real org-admin
    token; it's fully wrapped so a wrong shape simply yields no enrichment."""
    if not post_ids:
        return {}
    oe = 'urn:li:organization:' + oid
    buckets = {'shares': [], 'ugcPosts': []}
    for pid in post_ids:
        if not isinstance(pid, str):
            continue
        if ':share:' in pid:
            buckets['shares'].append(pid)
        elif ':ugcPost:' in pid:
            buckets['ugcPosts'].append(pid)
    out = {}
    for facet, urns in buckets.items():
        for i in range(0, len(urns), 20):
            chunk = urns[i:i + 20]
            raw = {facet: 'List(' + ','.join(quote(u, safe='') for u in chunk) + ')'}
            try:
                els = _li_get('/organizationalEntityShareStatistics', token,
                              {'q': 'organizationalEntity', 'organizationalEntity': oe},
                              raw=raw).get('elements') or []
            except Exception:
                continue
            for e in els:
                urn = e.get('share') or e.get('ugcPost')
                t = e.get('totalShareStatistics') or {}
                if not urn or not t:
                    continue
                impr = _num(t.get('impressionCount'))
                uniq = _num(t.get('uniqueImpressionsCount'))
                likes = _num(t.get('likeCount')) or 0
                comments = _num(t.get('commentCount')) or 0
                shares = _num(t.get('shareCount')) or 0
                rec = {'likes': likes, 'reactions': likes,
                       'comments': comments, 'shares': shares}
                if impr:
                    rec['impressions'] = impr
                if uniq:
                    rec['reach'] = uniq
                inter = likes + comments + shares
                rec['interactions'] = inter
                denom = impr or uniq           # LinkedIn rate ÷ impressions (else reach)
                if denom:
                    rec['interaction_rate'] = round(inter / denom * 100, 2)
                out[urn] = rec
    return out


def _li_posts(oid, token, since, until):
    """Post grid for a month. The /posts finder returns newest-first, so past
    months lie beyond the first page — paginate (offset) until we've passed the
    window's start (or hit a page cap), then keep only posts in [since,until).
    Per-post engagement (impressions/reach/reactions/rate) is enriched from
    _li_post_stats where the org-admin scope allows; aggregate engagement still
    comes from share statistics. Thumbnails are resolved from each in-window
    post's media URN. Degrades to [] if r_organization_social isn't granted."""
    au = 'urn:li:organization:' + oid
    def _created(p):
        # PUBLISHED time, not createdAt: a post drafted or scheduled ahead of time
        # carries a createdAt weeks before it went live, which both files it under
        # the wrong month and disagrees with the date the public scrape recorded.
        return (p.get('publishedAt') or p.get('firstPublishedAt')
                or p.get('createdAt'))
    els, seen, start, PAGE, MAX = [], set(), 0, 50, 250
    try:
        while start < MAX:
            j = _li_get('/posts', token, {'q': 'author', 'author': au,
                                          'count': PAGE, 'start': start})
            page = j.get('elements') or []
            if not page:
                break
            for p in page:
                pid = p.get('id')
                if pid and pid in seen:
                    continue
                if pid:
                    seen.add(pid)
                els.append(p)
            epochs = [_to_epoch(_created(p)) or 0 for p in page]
            total = (j.get('paging') or {}).get('total')
            start += PAGE
            # newest-first: once a page's oldest post predates the window, stop.
            if (epochs and min(epochs) < since) or (total is not None and start >= total):
                break
    except Exception:
        if not els:
            return []
    # Keep in-window posts, then enrich them with per-post statistics in one
    # batched call (best-effort — leaves values blank if the scope is missing).
    inwin = []
    for p in els:
        e = _to_epoch(_created(p))
        if e is None or (since <= e < until):
            inwin.append(p)
    try:
        stats = _li_post_stats(oid, token, [p.get('id') for p in inwin if p.get('id')])
    except Exception:
        stats = {}
    out, img_cache = [], {}
    for p in inwin:
        text = p.get('commentary') if isinstance(p.get('commentary'), str) else ''
        text = text or ''
        image, typ = _li_content_media(p.get('content'), token, img_cache)
        pid = p.get('id') or ''
        url = ('https://www.linkedin.com/feed/update/' + pid) if pid else ''
        st = stats.get(pid) or {}
        rec = {
            'ts': _created(p),
            'likes': st.get('likes'), 'comments': st.get('comments'),
            'shares': st.get('shares'), 'views': None,
            'type': typ, 'hashtags': re.findall(r'#(\w+)', text),
            'text': ' '.join(text.split())[:160], 'caption': ' '.join(text.split())[:400],
            'image': image, 'url': url,
            # The URN is immutable. The public-scrape URL for the same post has a
            # different shape (/posts/<slug>-activity-<id>) whose slug embeds the
            # post's own text, so editing the post would move the key.
            'post_id': pid}
        for k in ('impressions', 'reach', 'reactions', 'interactions', 'interaction_rate'):
            if st.get(k) is not None:
                rec[k] = st[k]
        out.append(rec)
    return out


def _li_insights(oid, token, month):
    since, until = _meta_month_range(month)
    since_ms, until_ms = since * 1000, until * 1000
    out = _li_share_stats(oid, token, since_ms, until_ms)   # core (may raise on access error)
    fol = _li_network_size(oid, token)
    if fol is not None:
        out['followers'] = fol
    out.update(_li_follower_gains(oid, token, since_ms, until_ms))
    try:
        scalars, _sec = _li_page_stats(oid, token, since_ms, until_ms)
        out.update(scalars)
    except Exception:
        pass
    return out


# LinkedIn reference enums — stable, so we label them locally instead of paying a
# reference-API lookup per URN. Seniority + function are fixed lists; staff-count
# is an enum string already.
_LI_SENIORITY = {1: 'Unpaid', 2: 'Training', 3: 'Entry', 4: 'Senior', 5: 'Manager',
                 6: 'Director', 7: 'VP', 8: 'CXO', 9: 'Partner', 10: 'Owner'}
_LI_FUNCTION = {1: 'Accounting', 2: 'Administrative', 3: 'Arts & Design', 4: 'Business Development',
                5: 'Community & Social Services', 6: 'Consulting', 7: 'Education', 8: 'Engineering',
                9: 'Entrepreneurship', 10: 'Finance', 11: 'Healthcare Services', 12: 'Human Resources',
                13: 'Information Technology', 14: 'Legal', 15: 'Marketing', 16: 'Media & Communications',
                17: 'Military & Protective Services', 18: 'Operations', 19: 'Product Management',
                20: 'Program & Project Mgmt', 21: 'Purchasing', 22: 'Quality Assurance',
                23: 'Real Estate', 24: 'Research', 25: 'Sales', 26: 'Support'}
_LI_STAFF = {'SIZE_1': '1', 'SIZE_2_TO_10': '2–10', 'SIZE_11_TO_50': '11–50',
             'SIZE_51_TO_200': '51–200', 'SIZE_201_TO_500': '201–500', 'SIZE_501_TO_1000': '501–1K',
             'SIZE_1001_TO_5000': '1K–5K', 'SIZE_5001_TO_10000': '5K–10K', 'SIZE_10001_OR_MORE': '10K+'}
_LI_SECTION = {'overviewPageViews': 'Overview', 'aboutPageViews': 'About', 'peoplePageViews': 'People',
               'jobsPageViews': 'Jobs', 'careersPageViews': 'Careers', 'lifeAtPageViews': 'Life',
               'productsPageViews': 'Products', 'insightsPageViews': 'Insights'}


def _li_urn_int(urn):
    try:
        return int(str(urn).rsplit(':', 1)[-1])
    except (ValueError, TypeError):
        return None


def _li_page_stats(oid, token, since_ms, until_ms):
    """Page views + unique visitors for the window, and views by page section.
    Returns ({page_views, unique_visitors}, [{name,value}] sections)."""
    try:
        els = _li_get('/organizationPageStatistics', token, {
            'q': 'organization', 'organization': 'urn:li:organization:' + oid,
            'timeIntervals': _li_time_intervals(since_ms, until_ms)}).get('elements') or []
    except Exception:
        return {}, []
    total_pv = total_uv = 0
    sections, got = {}, False
    for e in els:
        views = ((e.get('totalPageStatistics') or {}).get('views') or {})
        allv = views.get('allPageViews') or {}
        total_pv += _num(allv.get('pageViews')) or 0
        total_uv += _num(allv.get('uniquePageViews')) or 0
        for sec, label in _LI_SECTION.items():
            v = _num((views.get(sec) or {}).get('pageViews')) or 0
            if v:
                sections[label] = sections.get(label, 0) + v; got = True
        if allv:
            got = True
    scalars = {}
    if total_pv: scalars['page_views'] = total_pv
    if total_uv: scalars['unique_visitors'] = total_uv
    rows = sorted(({'name': k, 'value': v} for k, v in sections.items()),
                  key=lambda r: -r['value'])[:8]
    return (scalars if got else {}), rows


def _li_follower_breakdowns(oid, token):
    """Lifetime (current-audience) follower demographics: seniority, function,
    company size. Queried WITHOUT timeIntervals so LinkedIn returns the
    breakdown arrays. Shape: {key: [{name,value}]}."""
    try:
        els = _li_get('/organizationalEntityFollowerStatistics', token, {
            'q': 'organizationalEntity',
            'organizationalEntity': 'urn:li:organization:' + oid}).get('elements') or []
    except Exception:
        return {}
    if not els:
        return {}
    e = els[0]
    def cnt(it):
        fc = it.get('followerCounts') or {}
        return (_num(fc.get('organicFollowerCount')) or 0) + (_num(fc.get('paidFollowerCount')) or 0)
    def build(field, subkey, labeler):
        rows = []
        for it in (e.get(field) or []):
            lab = labeler(it.get(subkey))
            v = cnt(it)
            if lab and v:
                rows.append({'name': lab, 'value': v})
        return sorted(rows, key=lambda r: -r['value'])[:10]
    out = {}
    sen = build('followerCountsBySeniority', 'seniority',
                lambda u: _LI_SENIORITY.get(_li_urn_int(u)))
    fun = build('followerCountsByFunction', 'function',
                lambda u: _LI_FUNCTION.get(_li_urn_int(u)))
    siz = build('followerCountsByStaffCountRange', 'staffCountRange',
                lambda u: _LI_STAFF.get(u))
    if sen: out['li_seniority'] = sen
    if fun: out['li_function'] = fun
    if siz: out['li_company_size'] = siz
    return out


def _li_breakdowns(oid, token):
    """All LinkedIn audience breakdowns for the Audience tab (current snapshot)."""
    out = _li_follower_breakdowns(oid, token)
    try:
        now = int(time.time())
        _sc, sec = _li_page_stats(oid, token, (now - 30 * 86400) * 1000, now * 1000)
        if sec:
            out['li_page_sections'] = sec
    except Exception:
        pass
    return out


def _cron_linkedin_platforms(proj, month):
    """Pull this project's private LinkedIn org analytics for the month using the
    per-client connected token. Returns [] (→ Apify public scrape falls back)
    when LinkedIn isn't tracked or no token is connected. Raises on a resolved
    org we can't read (surfaced to the caller as a reconnect/scope hint)."""
    plats   = set(proj.get('platforms') or [])
    handles = proj.get('handles') or {}
    if not (('linkedin' in plats) or handles.get('linkedin')):
        return []
    token = ((proj.get('connections') or {}).get('linkedin') or {}).get('token')
    if not token:
        return []
    org = _li_resolve_org(proj, token)
    if not org:
        raise RuntimeError('LinkedIn connected but no admin company page matched this handle.')
    since, until = _meta_month_range(month)
    # Share/follower/page statistics only cover ~the last 12 months; older months
    # make LinkedIn reject the timeIntervals ("Invalid param"). Don't let that sink
    # the whole pull — the /posts finder has full history, so we can still backfill
    # the post grid (thumbnails) even when the period's stats are unavailable.
    try:
        insights = _li_insights(org['id'], token, month)
    except Exception:
        insights = {}
    posts = _li_posts(org['id'], token, since, until)
    if not insights and not posts:
        return []
    card = _meta_card('linkedin', posts, insights)
    if org.get('name'):
        card['account_name'] = org['name']
    return [card]


# ──────────────────────────────────────────────────────────────────────────────
# YouTube (Data API v3 + Analytics API v2) — native channel analytics + uploads
# via the per-client OFFLINE OAuth token. Mirrors the LinkedIn path: returns []
# (→ Apify public scrape falls back) when YouTube isn't tracked or no usable
# token is connected. Cards match _meta_card's shape. Unlike TikTok, YouTube's
# Analytics API keeps full channel history, so backfill can walk back years.
# ──────────────────────────────────────────────────────────────────────────────
def _yt_get(base, path, token, params=None):
    r = requests.get(base + path, params=params or {}, timeout=25,
                     headers={'Authorization': 'Bearer ' + token})
    j = r.json() if r.content else {}
    if isinstance(j, dict) and j.get('error'):
        err = j['error']
        msg = err.get('message') if isinstance(err, dict) else str(err)
        raise RuntimeError('YouTube API: ' + (msg or f'HTTP {r.status_code}'))
    return j


def _yt_month_dates(month):
    """(startDate, endDate) as YYYY-MM-DD for the Analytics API — endDate capped
    at today so an in-progress month doesn't request future days."""
    since, until = _meta_month_range(month)
    start = datetime.fromtimestamp(since, tz=timezone.utc)
    end   = datetime.fromtimestamp(max(until - 1, since), tz=timezone.utc)
    return start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')


def _yt_resolve_channel(token):
    """The authorised user's OWN channel {id,title,subs,…}. The offline token is
    the client's channel token, so channels?mine=true is authoritative; the
    tracked handle is only a display fallback."""
    items = _yt_get(YOUTUBE_DATA_API, '/channels', token,
                    {'part': 'snippet,statistics', 'mine': 'true'}).get('items') or []
    if not items:
        return None
    c = items[0]
    st = c.get('statistics') or {}
    return {'id': c.get('id'), 'title': (c.get('snippet') or {}).get('title'),
            'subs': _num(st.get('subscriberCount')),
            'views_total': _num(st.get('viewCount')),
            'video_count': _num(st.get('videoCount'))}


def _yt_analytics(channel_id, token, month):
    """Month-windowed channel analytics. Maps YouTube's metric names onto the
    internal scorecard keys (views→impressions, subscriber deltas→follower
    gains). Returns {} on any access error so the card still forms from the
    Data-API statistics + posts."""
    start, end = _yt_month_dates(month)
    try:
        rows = _yt_get(YOUTUBE_ANALYTICS_API, '', token, {
            'ids': 'channel==' + channel_id, 'startDate': start, 'endDate': end,
            'metrics': ('views,estimatedMinutesWatched,likes,comments,shares,'
                        'subscribersGained,subscribersLost,averageViewDuration')})
    except Exception:
        return {}
    hdrs = [h.get('name') for h in (rows.get('columnHeaders') or [])]
    data = rows.get('rows') or []
    if not hdrs or not data or not data[0]:
        return {}
    vals = dict(zip(hdrs, data[0]))
    out = {}
    def s(k, v):
        if v is not None:
            out[k] = v
    views = _num(vals.get('views'))
    s('views', views)
    likes    = _num(vals.get('likes'))
    comments = _num(vals.get('comments'))
    shares   = _num(vals.get('shares'))
    s('likes', likes); s('comments', comments); s('shares', shares)
    if likes is not None or comments is not None or shares is not None:
        eng = (likes or 0) + (comments or 0) + (shares or 0)
        s('engagements', eng)
        if views:
            s('engagement_rate', round(eng / views * 100, 2))
    gained = _num(vals.get('subscribersGained'))
    lost   = _num(vals.get('subscribersLost'))
    if gained is not None or lost is not None:
        net = (gained or 0) - (lost or 0)
        s('followers_increase', gained); s('followers_decrease', lost)
        s('net_new_followers', net); s('followers_growth_30d', net)
    s('avg_view_duration', _num(vals.get('averageViewDuration')))
    s('minutes_watched',   _num(vals.get('estimatedMinutesWatched')))
    # Discovery funnel (thumbnail impressions + CTR + avg % watched) in a SEPARATE
    # query — these metrics 400 if the channel/date has none, so isolate them so a
    # failure never drops the core metrics above.
    try:
        r2 = _yt_get(YOUTUBE_ANALYTICS_API, '', token, {
            'ids': 'channel==' + channel_id, 'startDate': start, 'endDate': end,
            'metrics': 'impressions,impressionsClickThroughRate,averageViewPercentage'})
        h2 = [h.get('name') for h in (r2.get('columnHeaders') or [])]
        d2 = r2.get('rows') or []
        if h2 and d2 and d2[0]:
            v2 = dict(zip(h2, d2[0]))
            s('impressions', _num(v2.get('impressions')))
            ctr = v2.get('impressionsClickThroughRate')
            s('ctr', round(_num(ctr), 2) if ctr is not None else None)
            avp = v2.get('averageViewPercentage')
            s('avg_view_pct', round(_num(avp), 1) if avp is not None else None)
    except Exception:
        pass
    return out


def _yt_posts(channel_id, token, since, until):
    """This month's uploads in the internal post shape, with per-video stats."""
    start = datetime.fromtimestamp(since, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    end   = datetime.fromtimestamp(until, tz=timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    try:
        found = _yt_get(YOUTUBE_DATA_API, '/search', token, {
            'part': 'id', 'channelId': channel_id, 'type': 'video', 'order': 'date',
            'publishedAfter': start, 'publishedBefore': end, 'maxResults': 50}).get('items') or []
    except Exception:
        return []
    ids = [((it.get('id') or {}).get('videoId')) for it in found]
    ids = [v for v in ids if v]
    if not ids:
        return []
    try:
        vids = _yt_get(YOUTUBE_DATA_API, '/videos', token, {
            'part': 'snippet,statistics', 'id': ','.join(ids[:50])}).get('items') or []
    except Exception:
        return []
    out = []
    for v in vids:
        sn = v.get('snippet') or {}
        st = v.get('statistics') or {}
        text = sn.get('title') or ''
        desc = sn.get('description') or ''
        out.append({
            'ts': sn.get('publishedAt'),
            'likes': _num(st.get('likeCount')), 'comments': _num(st.get('commentCount')),
            'shares': None, 'views': _num(st.get('viewCount')),
            'type': 'video', 'hashtags': re.findall(r'#(\w+)', text + ' ' + desc),
            'text': ' '.join(text.split())[:160], 'caption': ' '.join(text.split())[:400],
            'image': _youtube_thumb({'id': v.get('id')}),
            'url': 'https://www.youtube.com/watch?v=' + (v.get('id') or '')})
    return _meta_in_window(out, since, until)


def _cron_youtube_platforms(proj, month):
    """Native YouTube channel analytics + uploads for the month via the per-client
    offline token. Returns [] (→ Apify falls back) when YouTube isn't tracked or
    no usable token is connected. Raises on a connected-but-unresolvable channel
    so the caller can surface a reconnect hint."""
    plats   = set(proj.get('platforms') or [])
    handles = proj.get('handles') or {}
    if not (('youtube' in plats) or handles.get('youtube')):
        return []
    conn  = (proj.get('connections') or {}).get('youtube') or {}
    token = _yt_access_token(conn)
    if not token:
        return []
    ch = _yt_resolve_channel(token)
    if not ch or not ch.get('id'):
        raise RuntimeError('YouTube connected but no channel resolved — reconnect.')
    since, until = _meta_month_range(month)
    insights = _yt_analytics(ch['id'], token, month)
    if ch.get('subs') is not None:
        insights.setdefault('followers', ch['subs'])
    posts = _yt_posts(ch['id'], token, since, until)
    if not (insights or posts):
        return []
    card = _meta_card('youtube', posts, insights)
    if ch.get('title'):
        card['account_name'] = ch['title']
    return [card]


def _yt_report(channel_id, token, start, end, dims, metrics, sort=None, max_results=None):
    """One YouTube Analytics dimensioned report → list of {dim1,…: metric} rows."""
    params = {'ids': 'channel==' + channel_id, 'startDate': start, 'endDate': end,
              'metrics': metrics, 'dimensions': dims}
    if sort: params['sort'] = sort
    if max_results: params['maxResults'] = max_results
    r = _yt_get(YOUTUBE_ANALYTICS_API, '', token, params)
    hdrs = [h.get('name') for h in (r.get('columnHeaders') or [])]
    return [dict(zip(hdrs, row)) for row in (r.get('rows') or [])]


# Human labels for YouTube's traffic-source enum + age buckets.
_YT_TRAFFIC_LABELS = {
    'ADVERTISING': 'Advertising', 'ANNOTATION': 'Annotations', 'CAMPAIGN_CARD': 'Cards',
    'END_SCREEN': 'End screens', 'EXT_URL': 'External', 'NO_LINK_EMBEDDED': 'Embedded',
    'NO_LINK_OTHER': 'Direct/unknown', 'NOTIFICATION': 'Notifications',
    'PLAYLIST': 'Playlists', 'PROMOTED': 'Promoted', 'RELATED_VIDEO': 'Suggested videos',
    'SHORTS': 'Shorts feed', 'SUBSCRIBER': 'Channel/subs', 'YT_CHANNEL': 'Channel pages',
    'YT_OTHER_PAGE': 'Other YouTube', 'YT_SEARCH': 'YouTube search',
    'HASHTAGS': 'Hashtags', 'SOUND_PAGE': 'Sound page'}


def _yt_breakdowns(channel_id, token, month):
    """Audience/discovery breakdowns for the month: traffic sources, viewer age &
    gender, top countries. Each is best-effort — a failing report is skipped so
    the others still return. Shape: {key: [{name, value}]}."""
    start, end = _yt_month_dates(month)
    out = {}
    # Traffic sources (share of views by how viewers arrived).
    try:
        rows = _yt_report(channel_id, token, start, end, 'insightTrafficSourceType',
                          'views', sort='-views')
        data = [{'name': _YT_TRAFFIC_LABELS.get(r.get('insightTrafficSourceType'),
                                                r.get('insightTrafficSourceType')),
                 'value': _num(r.get('views')) or 0} for r in rows if _num(r.get('views'))]
        if data: out['yt_traffic_source'] = data[:8]
    except Exception:
        pass
    # Viewer demographics — viewerPercentage by age bucket and by gender.
    try:
        rows = _yt_report(channel_id, token, start, end, 'ageGroup', 'viewerPercentage',
                          sort='ageGroup')
        data = [{'name': (r.get('ageGroup') or '').replace('age', ''),
                 'value': round(_num(r.get('viewerPercentage')) or 0, 1)} for r in rows]
        if any(d['value'] for d in data): out['yt_age'] = data
    except Exception:
        pass
    try:
        rows = _yt_report(channel_id, token, start, end, 'gender', 'viewerPercentage')
        data = [{'name': (r.get('gender') or '').title(),
                 'value': round(_num(r.get('viewerPercentage')) or 0, 1)} for r in rows]
        if any(d['value'] for d in data): out['yt_gender'] = data
    except Exception:
        pass
    # Top countries by views.
    try:
        rows = _yt_report(channel_id, token, start, end, 'country', 'views',
                          sort='-views', max_results=10)
        data = [{'name': r.get('country'), 'value': _num(r.get('views')) or 0}
                for r in rows if _num(r.get('views'))]
        if data: out['yt_country'] = data
    except Exception:
        pass
    return out


# ──────────────────────────────────────────────────────────────────────────────
# TikTok (Display API) — native CURRENT stats + this-month videos via the
# per-client token. The Display API has NO historical/period analytics (no
# reach/impressions), so this only yields data for the CURRENT month going
# forward; past months return [] (→ backfill walk stops immediately). Cards
# match _meta_card's shape.
# ──────────────────────────────────────────────────────────────────────────────
def _tt_call(method, path, token, params=None, body=None):
    r = requests.request(method, TIKTOK_API + path, params=params or {}, timeout=25,
                         headers={'Authorization': 'Bearer ' + token,
                                  'Content-Type': 'application/json'},
                         json=body if body is not None else None)
    j = r.json() if r.content else {}
    err = j.get('error') or {}
    if err and err.get('code') not in (None, 'ok'):
        raise RuntimeError('TikTok API: ' + (err.get('message') or err.get('code')))
    return j.get('data') or {}


def _tt_posts(token, since, until):
    fields = ('id,title,video_description,create_time,like_count,comment_count,'
              'share_count,view_count,cover_image_url,share_url')
    try:
        data = _tt_call('POST', '/video/list/', token, {'fields': fields}, {'max_count': 20})
    except Exception:
        return []
    out = []
    for v in (data.get('videos') or []):
        text = v.get('title') or v.get('video_description') or ''
        out.append({
            'ts': v.get('create_time'),
            'likes': _num(v.get('like_count')), 'comments': _num(v.get('comment_count')),
            'shares': _num(v.get('share_count')), 'views': _num(v.get('view_count')),
            'type': 'video', 'hashtags': re.findall(r'#(\w+)', text),
            'text': ' '.join(text.split())[:160], 'caption': ' '.join(text.split())[:400],
            'image': v.get('cover_image_url') or '', 'url': v.get('share_url') or '',
            'post_id': str(v.get('id') or '')})     # stable key for tags/overrides
    return _meta_in_window(out, since, until)


def _cron_tiktok_platforms(proj, month):
    """Native TikTok CURRENT follower/like counts + this-month videos via the
    per-client token. Only the CURRENT month can be captured (no history in the
    Display API) — past months return []. Returns [] when not tracked / no token."""
    plats   = set(proj.get('platforms') or [])
    handles = proj.get('handles') or {}
    if not (('tiktok' in plats) or handles.get('tiktok')):
        return []
    token = _tt_access_token(((proj.get('connections') or {}).get('tiktok')) or {})
    if not token:
        return []
    if month != _current_month():        # no historical reconstruction possible
        return []
    since, until = _meta_month_range(month)
    try:
        info = (_tt_call('GET', '/user/info/', token,
                {'fields': 'display_name,follower_count,following_count,likes_count,video_count'}).get('user')) or {}
    except Exception:
        info = {}
    insights = {}
    if info.get('follower_count') is not None:
        insights['followers'] = _num(info.get('follower_count'))
    if info.get('following_count') is not None:
        insights['following'] = _num(info.get('following_count'))
    if info.get('likes_count') is not None:
        insights['total_likes'] = _num(info.get('likes_count'))
    posts = _tt_posts(token, since, until)
    if not (insights or posts):
        return []
    card = _meta_card('tiktok', posts, insights)
    if info.get('display_name'):
        card['account_name'] = info['display_name']
    return [card]


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
        pass
    # X/Twitter `createdAt`, e.g. "Wed Jun 25 12:00:00 +0000 2026" — not ISO.
    try:
        return datetime.strptime(str(ts), '%a %b %d %H:%M:%S %z %Y').timestamp()
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


# ── LLM source attribution ────────────────────────────────────────────────────
# Wrap the handler ONCE so every model call made during this invocation is tagged
# with the front-end that triggered it. Appended at module end because
# lambda_handler must already be defined. Pairs with the metering block above.
try:
    _llm_orig_handler = lambda_handler

    def lambda_handler(event, context=None):
        _set_llm_source(event)
        return _llm_orig_handler(event, context)
except NameError:
    pass
