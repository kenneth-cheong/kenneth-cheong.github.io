# socialMediaAudit — deploy

Async Social Media Audit backend. Region: `ap-southeast-1`, account `167633412846`.

## DEPLOYED (2026-06-15) — live resources
- **Lambda:** `socialMediaAudit` (python3.13, timeout **900** [was 180; bumped for the cron poll loop], mem 256), role `socialMediaAudit-role` (AWSLambdaBasicExecutionRole + inline `sma-dynamodb`). Env: `APIFY_TOKEN`, `CLAUDE_API_KEY`, `DATAFORSEO_AUTH`, `META_ACCESS_TOKEN`, `CRON_MAX_WAIT_SECS`.
- **DynamoDB:** `sma_jobs` (PK jobId, TTL on `ttl`), `sma_snapshots` (PK brand_platform, SK ts).

## Daily auto-capture (cron) — added 2026-06-22
Monthly Social Reports refresh themselves daily, no user trigger.
- **EventBridge rule** `socialMediaAudit-daily-capture` → `cron(0 22 * * ? *)` (22:00 UTC = 06:00 SGT), target = this Lambda, Input `{"action":"cron_capture_all"}`. Resource policy sid `eventbridge-daily-capture` lets `events.amazonaws.com` invoke.
- **Flow:** `cron_capture_all` scans `social_report_projects` and async self-invokes `cron_capture_one` per project (each gets its own ≤900s budget). `cron_capture_one` re-captures the CURRENT month (overwrites daily so the in-progress month stays live): runs the Apify pipeline with `_no_cache:true` (bypasses the 30-day scrape cache for fresh data), overlays Meta Graph private IG/FB insights, preserves manual-only platforms (Xiaohongshu) + any user-written recommendations, then `report_save_month` as `daily-cron@auto`.
- **`META_ACCESS_TOKEN`** must be a long-lived **Business Manager System User token** (non-expiring) with `pages_show_list, pages_read_engagement, read_insights, instagram_basic, instagram_manage_insights, business_management` and the client Pages assigned. Empty ⇒ cron runs Apify-only (Meta silently skipped). User access tokens expire (≤60 days) and will break the cron — use a System User token.
- **Cost note:** `_no_cache` means every project re-scrapes all platforms + competitors every day (true-daily was the explicit requirement). Lower frequency by editing the rule's schedule expression.
- **Manual test:** `aws lambda invoke --function-name socialMediaAudit --cli-binary-format raw-in-base64-out --payload '{"action":"cron_capture_all"}' out.json` (or target one project with `{"action":"cron_capture_one","projectId":"<pid>"}`).
- **Endpoint:** REST API `vceg7jm8w0`, stage `socialMediaAudit`, root resource POST+OPTIONS → AWS_PROXY →
  `https://vceg7jm8w0.execute-api.ap-southeast-1.amazonaws.com/socialMediaAudit`
- **NOTE:** Lambda Function URLs are blocked at the account level (returned `Forbidden` even with a correct
  resource policy + AuthType NONE) — that's why this uses a REST API, matching the rest of the project.
- Verified end-to-end with `{handles:{instagram:"nike"}}` → real 292M-follower scorecard.

Re-deploy code: `update-function-code --function-name socialMediaAudit --zip-file fileb://socialMediaAudit.zip --region ap-southeast-1`

## Social Listening Report (standalone module) — added 2026-07-03
Separate offering/billing from Monthly Social Reports (own top-level nav item,
not a tab), but shares this Lambda + the `fetch_social_listening()` engine.
- **DynamoDB:** `sl_clients` (PK clientId), `sl_topics` (PK clientId, SK topicId),
  `sl_snapshots` (PK topicId, SK date "YYYY-MM-DD", TTL on `ttl` — ~13 months).
  All `PAY_PER_REQUEST`. IAM: same `sma-dynamodb` inline policy on
  `socialMediaAudit-role`, extended with a third statement for these 3 tables.
- **Data model:** a client has one or more named "topics" (own keyword query,
  e.g. "Payment/Payout"). Every ACTIVE topic gets one live pull/day, stored as
  a snapshot row. A date-range report aggregates snapshot rows on demand
  (`sl_get_topic_report`): mentions deduped by URL, sentiment summed, one trend
  point per captured day, top-sites computed from the deduped mentions. No
  historical backfill is possible — DataForSEO Content Analysis has no
  date-range query (live search only), so trend data only exists from whenever
  a topic starts being tracked.
- **Actions:** `sl_list_clients`, `sl_save_client`, `sl_delete_client`,
  `sl_list_topics`, `sl_save_topic`, `sl_delete_topic`, `sl_pull_topic`
  (manual on-demand snapshot), `sl_get_topic_report`, `sl_cron_snapshot_all` /
  `sl_cron_snapshot_one` (daily cron, same self-invoke fan-out shape as
  `cron_capture_all`/`cron_capture_one` above).
- **EventBridge rule** `socialMediaAudit-daily-listening-snapshot` →
  `cron(10 22 * * ? *)` (22:10 UTC = 06:10 SGT — 10 min after the Monthly
  Reports cron so both don't cold-start at once), target = this Lambda, Input
  `{"action":"sl_cron_snapshot_all"}`. Resource policy sid
  `eventbridge-daily-listening-snapshot` lets `events.amazonaws.com` invoke.
- **Cost note:** the cron fires once per TOPIC, not once per client — e.g. 20
  clients × 4 topics = 80 self-invokes/day, each doing up to 5 DataForSEO
  term-calls × 2 endpoints + up to 3 platform SERP calls. That's a real cost
  multiplier vs. the per-project Monthly Reports cron. No hard cap enforced;
  watch DataForSEO spend as topic count grows.
- **Reach/impressions/heatmap/country/language breakdowns:** intentionally
  omitted from the whole feature — DataForSEO can't produce real numbers for
  any of these (confirmed against the API), and this tool never fabricates
  metrics. The KPI is labelled "Mentions captured" (not "Total mentions") since
  `content_analysis/search/live` caps at 20 items/term — it's a floor on real
  volume, not a true corpus count.
- **Manual test:** `aws lambda invoke --function-name socialMediaAudit --payload '{"action":"sl_save_client","data":{"name":"Test Client"}}' out.json` (chain through `sl_save_topic` → `sl_pull_topic` → `sl_get_topic_report` with the returned `clientId`/`topicId`), or `{"action":"sl_cron_snapshot_all"}` to fire the full daily sweep on demand.

## OAuth "Connect with …" for per-client connections — added 2026-06-23
Lets a non-technical user authorise a client's Meta / LinkedIn / TikTok / YouTube
account with **one click** (Settings tab → Platform connections → *Connect with X*)
instead of pasting a raw access token. The old paste-a-token UI is preserved as
the collapsible **Advanced** fallback, so nothing breaks while apps await review.

- **How it flows:** the browser runs the platform consent dialog. Meta/LinkedIn/
  TikTok redirect to `OAUTH_REDIRECT_URI` (`oauth-callback.html` at the repo root),
  which `postMessage`s the auth code back to the app; the app calls
  `action:"oauth_exchange"` and we swap the code for a (long-lived) token using the
  app **secret** server-side. YouTube/Google uses Google Identity Services fully
  in-browser (no secret, no callback page) — only its `client_id` is needed.
- **`connections` is now persisted** in `social_report_projects` (was accepted but
  dropped before) — encrypted at rest like the rest of the item. Tokens survive reload.
- **Frontend gating:** `action:"oauth_config"` returns the **public** client IDs +
  scopes + redirect URI (never secrets) + a `configured` flag per platform. If a
  platform isn't configured, its one-click button is hidden and only Advanced shows.

### Env vars (secrets server-side only; client IDs are public)
```bash
aws lambda update-function-configuration --region ap-southeast-1 \
  --function-name socialMediaAudit --environment "Variables={...existing...,\
OAUTH_REDIRECT_URI=https://app.digimetrics.ai/oauth-callback.html,\
META_OAUTH_CLIENT_ID=xxx,META_OAUTH_CLIENT_SECRET=xxx,\
LINKEDIN_OAUTH_CLIENT_ID=xxx,LINKEDIN_OAUTH_CLIENT_SECRET=xxx,\
TIKTOK_OAUTH_CLIENT_ID=xxx,TIKTOK_OAUTH_CLIENT_SECRET=xxx,\
GOOGLE_OAUTH_CLIENT_ID=xxx.apps.googleusercontent.com}"
```
Optional scope overrides: `META_OAUTH_SCOPES`, `LINKEDIN_OAUTH_SCOPES`, `TIKTOK_OAUTH_SCOPES`.

### Per-platform app registration (the manual one-time setup)
Register each app under the agency's developer account and whitelist the **exact**
redirect URI `https://app.digimetrics.ai/oauth-callback.html`:
- **Meta** — developers.facebook.com → create app → add *Facebook Login* → Valid
  OAuth Redirect URIs. Scopes `pages_show_list, pages_read_engagement, read_insights,
  instagram_basic, instagram_manage_insights, business_management` require **App
  Review + Business Verification** before they work for non-admin accounts.
- **LinkedIn** — linkedin.com/developers → app → Auth → Authorized redirect URLs.
  `r_organization_social/admin` require the **Community Management API** product
  approval. (Token exchange must be server-side; LinkedIn has no implicit flow.)
- **TikTok** — TikTok for Developers (Login Kit / Business) → set redirect URI +
  scopes. Uses `client_key` (not `client_id`); exchanged at `open.tiktokapis.com`.
- **YouTube/Google** — Google Cloud Console → OAuth client (Web), authorised
  JavaScript origin `https://app.digimetrics.ai`. Enable *YouTube Data API v3*; the
  `youtube.readonly` scope is *sensitive* → OAuth-consent verification (works for
  test users immediately). No client secret needed (GIS token flow).

> Until an app is registered + (Meta/LinkedIn) review-approved, leave its
> `*_OAUTH_CLIENT_ID` empty — the UI auto-falls back to Advanced paste-a-token,
> which still works via the existing System User / personal tokens.

## Native first-party pulls for ALL owned platforms — added 2026-07-04 (DEPLOYED)
Native/first-party API pulls now cover **YouTube + TikTok** (were Meta+LinkedIn
only), for both the "Pull private insights" backfill and the daily cron.
- **Actions:** `report_backfill_youtube`, `report_backfill_tiktok`, and
  `report_native_preview` (READ-ONLY discrepancy audit — pulls native cards for a
  month without saving, returns native vs stored + field-level diff + the Apify
  skip-plan; safe to run against live projects).
- **YouTube** = server-side **offline** code flow (refresh token) → unattended
  cron + walk-back backfill, full channel history. Needs `GOOGLE_OAUTH_CLIENT_SECRET`
  (set) + `yt-analytics.readonly` scope + the `oauth-callback.html` redirect URI on
  the "Digimetrics 2" web client (done). App is In production w/ unverified sensitive
  scopes → connectors see the "unverified app" click-through (100-user cap).
- **TikTok** = Display API, CURRENT month only (no historical/reach/impressions).
- **Cron cost optimization:** `cron_capture_one` is native-first — it skips the
  paid Apify scrape for any platform a native token already covers, and now still
  scrapes competitors even when ALL owned platforms are native-covered (previously
  an all-native project dropped its competitors). Verified: a fully-native project
  (e.g. Hyundai) runs the daily cron with **zero** Apify calls.

### ⚠️ TEAM ACTION — native pull needs a connected token per campaign
A campaign only gets native YouTube/TikTok data once it has connected that
platform (Settings → Platform connections → Connect). As of 2026-07-04:
- **YouTube:** only *Kenneth Cheong* tracks YouTube, and its token is a stale
  pre-2026-07 GIS token — it must **Reconnect** (the connect button now uses the
  new offline flow). No other campaign tracks YouTube.
- **TikTok:** *Mandai – Toy Doctor* and *CONNOR* track TikTok but have **no TikTok
  token connected** — connect one to enable native pulls.
- Until then those platforms fall back to Apify public scraping (unchanged).

### Facebook metric deprecation — FIXED 2026-07-04
A `report_native_preview` audit found FB reach/impressions/follower-growth coming
back None. Probed the Graph API live: Meta has **deprecated** `page_impressions`,
`page_impressions_unique` (page reach), `page_fan_adds`/`page_fan_removes`,
`page_posts_impressions`, and ALL `post_impressions*` (post reach) — they return
"(#100) not a valid insights metric". `_meta_fb_insights` now uses the survivors:
- **impressions** ← `page_posts_impressions_organic`
- **follower growth** ← `page_daily_follows_unique` / `page_daily_unfollows_unique`
  (verified: Anderco net +18 matches the previously-stored value)
- **engagements/profile_views** ← `page_post_engagements` / `page_views_total` (unchanged)
- **reach** — intentionally NOT reported: unique reach is no longer exposed at page
  OR post level. FB engagement-rate now uses impressions as the denominator (IG
  still uses reach, its official ER definition — that's why IG ER differs from the
  old scraped value, which is expected, not a bug).

## Expanded metrics + "Audience & Insights" tab — added 2026-07-04 (DEPLOYED)
New scalar metrics + demographic/discovery **breakdowns**, shown in a new
"Audience & insights" tab in the report UI (index.html `SR`).
- **New scalars (auto-render in the report tables/trends):** YouTube real
  thumbnail `impressions` + `ctr` + `avg_view_pct` (+ `views`/`minutes_watched`/
  `avg_view_duration`); LinkedIn `page_views` + `unique_visitors`; Instagram
  `website_clicks`; TikTok `following` + `total_likes`.
- **Breakdowns action `report_refresh_audience`** (on-demand, NOT on the capture
  hot path): pulls per-platform breakdowns and merges them onto the current
  month's scorecard cards under `card['breakdowns'] = {key:[{name,value}]}` +
  `card['breakdowns_asof']`. Builders dispatched from `_audience_breakdowns_for`.
  The frontend "Refresh audience insights" button calls it; charts render via a
  `BREAKDOWNS` registry + `drawBreakdown()` Chart.js helper (donut/hbar).
- **What each platform yields (probed live, not from docs):**
  - **YouTube** (`_yt_breakdowns`, date-range per report month): traffic sources,
    viewer age, viewer gender, top countries.
  - **LinkedIn** (`_li_breakdowns`, current snapshot): followers by seniority /
    job function / company size (local enum label maps `_LI_SENIORITY/_FUNCTION/
    _STAFF` — no reference-API lookups) + page views by section. Needs an admin
    company org to resolve.
  - **Instagram** (`_ig_breakdowns`, current snapshot): followers by age / gender
    / country / city via `follower_demographics` (period=lifetime, metric_type=
    total_value, breakdown=…). CONFIRMED working in v23.0.
  - **Facebook:** NO audience demographics — `page_fans_gender_age/country/city`
    are all deprecated (`(#100) not a valid insights metric`), same wave as the
    reach/impressions deprecation. Do not re-add without re-probing.
  - **TikTok:** none (Display API has no demographics — Business API territory).
- Demographics are **current-state snapshots** (labelled "as of <date>"); only
  YouTube breakdowns are true per-report-period. Source badge relabelled
  "Meta" → "Native" since owner-only metrics now span 4 platforms.
- Deploy = same single-file zip; frontend = push index.html to main.

## Process/UI improvements batch — added 2026-07-04 (DEPLOYED)
- **Connection health** — `report_connections_health` (one project) + `report_connections_audit`
  (all projects) LIVE-validate each stored token (resolve page/org/channel) and
  classify: ok / expiring / reconnect / no_org / no_match / error / not_connected.
  Frontend shows a health banner on the client detail + connected/stale/scrape
  status dots on roster platform icons.
- **Token alerts** — `report_connections_audit` pushes a digest of stale/failing
  connections to a Google Chat webhook. **Set env `SR_ALERT_WEBHOOK`** (incoming
  webhook URL) to enable; unset = it still runs + returns the digest, just no push.
  EventBridge rule `socialMediaAudit-weekly-connection-audit` → `cron(0 23 ? * SUN *)`
  (Mon 07:00 SGT), input `{"action":"report_connections_audit"}`.
- **Weekly audience refresh** — `cron_refresh_audience_all`/`_one` fan-out keeps
  demographics fresh. EventBridge rule `socialMediaAudit-weekly-audience-refresh`
  → `cron(30 22 ? * SUN *)` (Mon 06:30 SGT), input `{"action":"cron_refresh_audience_all"}`.
- **Competitor cadence** — project field `competitor_cadence` = daily|weekly|off
  gates the paid competitor scrape (`_competitors_due`); Settings has the selector.
- **Keep-last-non-empty** — the daily cron no longer lets a transient failed pull
  blank a good scalar on the in-progress month (past months never re-captured).
- **AI narrative** — `report_recommend` now feeds `audience_breakdowns` into the
  prompt (WHO the audience is + HOW they discover). `aggregateRange` carries the
  latest breakdown snapshot onto platform rows so genRecs + the export see it.
- **Export** — the printable/PDF report (`reportHTML`/`printReport`) gained an
  "Audience & insights" section (bar tables). **Audience shift** period-compare
  annotates each breakdown vs the prior stored snapshot.
- Both new EventBridge rules have `events.amazonaws.com` invoke permission
  (statement-ids `eventbridge-weekly-audience-refresh` / `-connection-audit`).

---
The generic steps below are kept for reference / rebuilding from scratch.

## 0. Prereqs
- An **Apify** account + API token (apify.com → Settings → Integrations → Personal API tokens).
- On Apify, make sure you've "tried"/subscribed to the actors referenced in `ACTORS`
  (lambda_function.py top). Swap any slug there for one you prefer.

## 1. DynamoDB tables
```bash
aws dynamodb create-table --region ap-southeast-1 \
  --table-name sma_jobs \
  --attribute-definitions AttributeName=jobId,AttributeType=S \
  --key-schema AttributeName=jobId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
aws dynamodb update-time-to-live --region ap-southeast-1 \
  --table-name sma_jobs --time-to-live-specification "Enabled=true,AttributeName=ttl"

aws dynamodb create-table --region ap-southeast-1 \
  --table-name sma_snapshots \
  --attribute-definitions AttributeName=brand_platform,AttributeType=S AttributeName=ts,AttributeType=N \
  --key-schema AttributeName=brand_platform,KeyType=HASH AttributeName=ts,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

## 2. Package + create the function
`requests` isn't in the Lambda runtime — bundle it.
```bash
cd lambdas/socialMediaAudit
pip install requests -t package
cp lambda_function.py package/
(cd package && zip -r ../socialMediaAudit.zip .)

aws lambda create-function --region ap-southeast-1 \
  --function-name socialMediaAudit \
  --runtime python3.12 --handler lambda_function.lambda_handler \
  --timeout 60 --memory-size 256 \
  --role arn:aws:iam::167633412846:role/<your-lambda-exec-role> \
  --zip-file fileb://socialMediaAudit.zip
```
Re-deploy after edits: `aws lambda update-function-code --function-name socialMediaAudit --zip-file fileb://socialMediaAudit.zip --region ap-southeast-1`

## 3. Env vars
```bash
aws lambda update-function-configuration --region ap-southeast-1 \
  --function-name socialMediaAudit \
  --environment "Variables={APIFY_TOKEN=apify_api_xxx,ANTHROPIC_API_KEY=sk-ant-xxx}"
```

## 4. IAM
The exec role needs `dynamodb:PutItem/GetItem/Query` on `sma_jobs` + `sma_snapshots`
(plus the usual CloudWatch Logs perms).

## 5. HTTP API route
Add a `POST /socialMediaAudit` route on an HTTP API (reuse an existing one, e.g.
`8domnt5y2f`), integrate to this function, enable CORS, then
`aws lambda add-permission` for `apigateway.amazonaws.com` to invoke it.
Set the resulting URL as `SMA_ENDPOINT` in index.html.

## Contract
- `POST {action:"start", brand_name, domain, handles:{instagram,tiktok,facebook,linkedin,youtube},
   platforms:[...], competitors:[{platform,handle,name}]}` → `{jobId, platforms}`
- `POST {action:"poll", jobId}` → `{status:"running", progress}` or `{status:"done", scorecard}`

The frontend polls every ~6s until `done`.
