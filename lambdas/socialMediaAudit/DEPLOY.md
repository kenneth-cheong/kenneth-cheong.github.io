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
