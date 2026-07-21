# Digimetrics SaaS

Self-serve, individual-user edition of the Digimetrics toolkit. SEO + AI-content +
AI-visibility tools, gated by subscription tier, metered by AI credits, billed via Stripe.
Fully on AWS (no GitHub Pages).

See [`../SAAS_PROPOSAL.md`](../SAAS_PROPOSAL.md) for the product rationale, tiers and pricing.

```
saas/
├── shared/
│   ├── catalog.mjs        ⭐ Single source of truth: plans, credit costs, tool registry
│   └── connectors.mjs     Integration (GSC/GA4/Ads) connector definitions
├── backend/               CloudFormation (SAM transform): HTTP API + JWT authorizer
│   │                      + 9 Lambdas + 8 DynamoDB tables. See DEPLOY.md.
│   ├── template.yaml      The stack (digimetrics-saas, ap-southeast-1)
│   ├── scripts/
│   │   ├── build.mjs      esbuild bundler → .build/<fn>/ (run before deploy)
│   │   └── setup-stripe.mjs   Creates USD products/prices, writes Price IDs to SSM
│   └── src/               9 Lambdas (one dir each) + lib/ shared helpers — see below
└── frontend/              React + Vite + Tailwind (manual-deploy to Amplify Hosting)
```

### Backend modules (`backend/src/`)

Each dir is one Lambda (`index.mjs` handler); `lib/` is shared helpers bundled in.

| Module | Trigger | Responsibility |
|---|---|---|
| `authorizer/` | API authorizer | JWT Lambda authorizer — gates every authed route |
| `auth/` | `POST /auth/google`, `/auth/refresh` | Google Sign-In → our own JWT + refresh token |
| `me/` | `GET /me`, `/me/usage` | Profile (tier, live credit balance) + usage ledger |
| `metering/` | `POST /run/{toolId}` + `RunUrl` | ⭐ The gateway: tier gate → credit gate → proxy upstream → reconcile credits → cache |
| `billing/` | `/billing/*` | Stripe Checkout, top-ups, Customer Portal, signed webhook |
| `app/` | many authed routes | In-app API: assistant chat, support tickets, run history, notifications, projects, keyword tracking CRUD, Google OAuth connect/callback |
| `admin/` | `/admin/*` (ADMIN_EMAILS only) | Admin portal: list users, adjust credits, override tier |
| `track/` | EventBridge (daily) | Refresh every tracked keyword's rank → append position snapshot |
| `close/` | EventBridge (daily) | Auto-close support tickets idle ≥ `AUTO_CLOSE_DAYS`; notify owner |

`lib/`: `dynamo.mjs` (all table access), `crypto.mjs` (AES-256-GCM token encryption),
`google.mjs` (OAuth + GSC/GA4/Ads calls), `jwt.mjs`, `http.mjs` (response helpers),
`email.mjs` (SES), `rank.mjs` (rank lookups), `ratelimit.mjs`, `admin.mjs`, `s3.mjs`.

DynamoDB tables: `Users, Ledger, Runs, Tickets, Projects, Tracked, Cache, Notifications`.

### Frontend (`frontend/src/`)

React + Vite + Tailwind, deployed manually to Amplify (see DEPLOY.md step 5).

- **`pages/`** — route screens: `Login, Dashboard` (tool grid), `ToolRunner`,
  `Pricing, Account, Usage, History, Projects, Tracking, Integrations, Support, Admin`.
- **`components/`** — `Layout, ToolCard, CreditMeter, UpgradeModal, ChatDrawer,
  ResultSections / SchemaResult` (tool output rendering), `TrendChart / LineChart,
  ProjectSelector, NotificationBell, Toaster, ExplainMenu`.
- **`context/`** — `AuthContext` (session/JWT/tier/credits), `ProjectContext`.
- **`lib/`** — `api.js` (backend client; honours `VITE_MOCK`), `icons.jsx`,
  `tours.js`, `ui.js`. The tool grid + runner are **catalog-driven** from
  `shared/catalog.mjs`, so adding a tool needs no new page/component.

## Run the UI locally (no AWS needed)

The frontend ships a **mock backend** so you can click through the whole product —
auth, credit meter, tier locks, teaser runs, upgrade flow — with zero cloud setup.

```bash
cd saas/frontend
npm install
cp .env.example .env.local      # VITE_MOCK=1 is already set
npm run dev                      # http://localhost:5173
```

Click **Continue (demo mode)**, run tools, watch credits burn down, hit a locked
tool to see the upgrade modal, "upgrade" to Pro (mock-instant) and watch tools unlock.

## Deploy for real

**See [`DEPLOY.md`](DEPLOY.md) for the full, ordered runbook.** Quick orientation below.

### 1. Backend (esbuild → CloudFormation)

> **Not `sam deploy`.** The `package.json` scripts still mention SAM, but the SAM CLI
> isn't installed — we bundle with esbuild and deploy via `aws cloudformation`. The
> live stack is **`digimetrics-saas`** in `ap-southeast-1`.

```bash
cd saas/backend
npm install
# Stripe products/prices/Price-IDs (writes to SSM Parameter Store):
STRIPE_SECRET_KEY=sk_test_xxx AWS_REGION=ap-southeast-1 node scripts/setup-stripe.mjs

node scripts/build.mjs                    # esbuild → .build/<fn>/
aws cloudformation package --template-file template.yaml \
  --s3-bucket <artifact-bucket> --output-template-file /tmp/pkg.yaml --region ap-southeast-1
# first deploy: aws cloudformation deploy ...   (updates: create-change-set → execute)
```

The stack outputs **`ApiUrl`** (use as `VITE_API_BASE`) and **`RunUrl`** (Function URL
for slow tools). Point the Stripe webhook (`/billing/webhook`) at `ApiUrl` and set the
signing secret into the `StripeWebhookSecret` parameter. Full commands, parameter table,
the **change-set + `UsePreviousValue` secret-preservation** rule, the **code-only fast
path** (skip CFN), and the two SAM-transform gotchas are all in [`DEPLOY.md`](DEPLOY.md).

#### Google integrations (GSC / GA4 / Ads) — wired exactly like the agency app

The Integrations work the same way `index.html` does and **reuse the agency's
existing Lambdas**, so you inherit their working credentials:
- GSC → direct Search Console API with the user's token.
- GA4 → agency `gscIntegration` Lambda (`ga4ListProperties` / `ga4RunReport`).
- Ads → agency `gscIntegration` (`adsListCustomers`) + `googleAds` (GAQL).
- Token exchange/refresh → agency `googleAuth` Lambda (it holds the client
  secret), so **no `GoogleClientSecret` is required**.

To go live:
1. Use the agency's OAuth client id as `GoogleClientId` (the default in
   `google.mjs` already matches it).
2. In that Google project, add the redirect URI `https://<ApiUrl>/oauth/callback`
   to the OAuth client's **Authorized redirect URIs**.
3. For live Ads, pass `GoogleAdsDeveloperToken` + `GoogleAdsLoginCustomerId`
   (the agency's MCC values). Without them, Ads stays on demo data.

The tools fall back to seeded data whenever a call fails or OAuth isn't set up,
so Connect always works in the UI. After connecting, the Integrations page lists
the user's accessible **sites / GA4 properties / Ads accounts** to pick from.

#### Support emails (optional)

Ticket reply + auto-close emails go through SES. Verify a sender and pass
`SesFrom` (the "from" address) and `SesSupport` (your support inbox). Left empty,
in-platform notifications still work; email is simply skipped. `AutoCloseDays`
(default 7) controls the daily inactivity auto-close job.

### 2. Frontend (AWS Amplify Hosting — manual deploy)

The app is a **manual-deploy** Amplify app (not auto-built from GitHub). Build locally
and upload the `dist/` bundle:

```bash
cd saas/frontend
npm install
# set VITE_API_BASE (the backend ApiUrl) + VITE_GOOGLE_CLIENT_ID; do NOT set VITE_MOCK
npm run deploy        # bash deploy.sh: vite build → zip → aws amplify create-deployment
```

Add your custom domain in Amplify → Domain management (managed SSL + CloudFront), then
update the backend `AppOrigin` param to the live URL. See [`DEPLOY.md`](DEPLOY.md) step 5.

## ⚠️ Security — the one thing that must not ship broken

The metering gateway proxies to the **existing public tool Lambdas** (see
`backend/src/metering/upstreams.mjs`). Those same Lambdas are called **directly by
`index.html`** (the agency app), so a user who reads `index.html` can find the URLs
and call them directly, bypassing billing.

The gateway already sends an `x-gateway-secret` header on every upstream call (set
`GatewaySecret`). The remaining step is enforcement on the Lambda side — **but
locking the shared Lambdas would break `index.html`**, which sends no secret. So,
to close the bypass *without affecting `index.html`*:

- **Recommended:** give the SaaS **its own private copies** of the tool Lambdas
  (or a private API in front of them) that require the secret, and point
  `upstreams.mjs` at those. `index.html` keeps using the public ones, untouched.
- **Or** migrate `index.html` to also send the secret and lock the shared Lambdas
  (changes the agency app — only if you own both and want a single deployment).

Note: nothing on the SaaS side leaks these URLs — they live server-side in
`upstreams.mjs`, never in the frontend bundle. The exposure is `index.html` itself.

**Hardened in this build:** Google OAuth refresh/access tokens are now **encrypted
at rest** (AES-256-GCM, `backend/src/lib/crypto.mjs`) before hitting DynamoDB, and
the gateway **caches** deterministic data-tool results (`CacheTable`, TTL) to cut
upstream cost + the bypass blast radius.

## What's included vs. the agency app

**Included:** SEO Toolkit, AI Content Studio, AI Visibility (GEO), Ads & Strategy —
~20 tools wired through the metering gateway (more can be added by appending to
`shared/catalog.mjs` + `upstreams.mjs`).

**Excluded (agency-internal):** Tender Builder, Cockpit/Campaign Intelligence,
Admin Console, all monday.com integrations, SEO Pricing Quote, client NPS.
