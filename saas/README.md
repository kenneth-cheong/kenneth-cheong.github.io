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

#### Google integrations (GSC / GA4 / Ads) — optional but enables real data

The Integrations tools fall back to seeded demo data until OAuth is configured.
To go live:

1. In Google Cloud Console, create an **OAuth 2.0 Client (Web)** and enable the
   Search Console API, Analytics Data API, and (optionally) Google Ads API.
2. Add the redirect URI `https://<ApiUrl>/oauth/callback`.
3. Pass `GoogleClientId` + `GoogleClientSecret` to `sam deploy`
   (and `GoogleAdsDeveloperToken` if you want live Ads — otherwise Ads stays on
   demo data). The template wires `GOOGLE_OAUTH_REDIRECT` automatically.

Without these, Connect still works in the UI but tools return seeded data.

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
`backend/src/metering/upstreams.mjs`). Today those URLs are open to the world, so a
user could call them directly and bypass billing entirely. Before charging anyone:

- Lock each upstream to require the `x-gateway-secret` header (set `GatewaySecret`), **or**
- Move them behind a private API / IAM auth so only this gateway can invoke them.

Until then, treat this as a staging build only.

## What's included vs. the agency app

**Included:** SEO Toolkit, AI Content Studio, AI Visibility (GEO), Ads & Strategy —
~20 tools wired through the metering gateway (more can be added by appending to
`shared/catalog.mjs` + `upstreams.mjs`).

**Excluded (agency-internal):** Tender Builder, Cockpit/Campaign Intelligence,
Admin Console, all monday.com integrations, SEO Pricing Quote, client NPS.
