# Digimetrics SaaS

Self-serve, individual-user edition of the Digimetrics toolkit. SEO + AI-content +
AI-visibility tools, gated by subscription tier, metered by AI credits, billed via Stripe.
Fully on AWS (no GitHub Pages).

See [`../SAAS_PROPOSAL.md`](../SAAS_PROPOSAL.md) for the product rationale, tiers and pricing.

```
saas/
├── shared/catalog.mjs     Single source of truth: plans, credit costs, tool registry
├── backend/               AWS SAM: HTTP API + JWT authorizer + Lambdas + DynamoDB
│   └── src/
│       ├── authorizer/    JWT Lambda authorizer (gates every authed route)
│       ├── auth/          Google Sign-In → our own JWT + refresh
│       ├── me/            Profile + usage ledger
│       ├── metering/      ⭐ The gateway: tier gate → credit gate → proxy → reconcile
│       └── billing/       Stripe Checkout, Customer Portal, signed webhook
└── frontend/              React + Vite + Tailwind (deploys to AWS Amplify Hosting)
```

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

### 1. Backend (AWS SAM)

```bash
cd saas/backend
npm install
# Stripe Price IDs are read from SSM Parameter Store:
aws ssm put-parameter --name /saas/price/pro/monthly --value price_xxx --type String   # etc.
sam build
sam deploy --guided      # prompts for GoogleClientId, JwtSecret, Stripe keys, etc.
```

`sam deploy` outputs `ApiUrl` — use it as `VITE_API_BASE`.

Point the Stripe webhook (`/billing/webhook`) at the deployed URL and put the signing
secret into the `StripeWebhookSecret` parameter.

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

### 2. Frontend (AWS Amplify Hosting)

1. Amplify Console → **New app → Host web app** → connect this repo.
2. **App root directory:** `saas/frontend` (build spec: `amplify.yml`).
3. Environment variables: `VITE_API_BASE` (the SAM ApiUrl), `VITE_GOOGLE_CLIENT_ID`.
   **Do not** set `VITE_MOCK`.
4. Add your custom domain in Amplify (managed SSL + CloudFront).

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
