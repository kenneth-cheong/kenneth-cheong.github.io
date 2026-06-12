# Deployment runbook — Digimetrics SaaS on AWS

End-to-end, in order. Region: **ap-southeast-1** (Singapore). Currency: **SGD**.
Everything lives in one AWS account; nothing on GitHub Pages.

Prerequisites: AWS CLI configured, [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html),
Node 20+, a Stripe account, and the existing Google OAuth client.

---

## 1. Google OAuth (reuse the existing client)

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → the
existing OAuth 2.0 Client (`1080212071394-…apps.googleusercontent.com`):

- **Authorized JavaScript origins:** add `http://localhost:5173` and your Amplify/custom domain.
- Note the **Client ID** — it's both `VITE_GOOGLE_CLIENT_ID` (frontend) and `GoogleClientId` (backend).

> Or create a fresh OAuth client dedicated to the SaaS so its consent screen reads "Digimetrics" not the agency app.

---

## 2. Stripe — products, prices, webhook

```bash
cd saas/backend
npm install

# Creates SGD products + monthly/annual prices and writes Price IDs to SSM.
STRIPE_SECRET_KEY=sk_test_xxx AWS_REGION=ap-southeast-1 node scripts/setup-stripe.mjs
```

This populates `/saas/price/{starter,pro,expert}/{monthly,annual}` in SSM Parameter
Store, which `template.yaml` reads at deploy time.

You'll create the **webhook secret** in step 4 (after the API URL exists).

---

## 3. Deploy the backend (SAM)

```bash
cd saas/backend
sam build
sam deploy --guided
```

Answer the prompts (saved to `samconfig.toml` for next time):

| Parameter | Value |
|---|---|
| `AppOrigin` | `http://localhost:5173` for now; change to the Amplify URL after step 5 |
| `GoogleClientId` | from step 1 |
| `JwtSecret` | a long random string (`openssl rand -hex 32`) |
| `StripeSecretKey` | `sk_test_…` |
| `StripeWebhookSecret` | placeholder for now (`whsec_temp`), fixed in step 4 |
| `GatewaySecret` | another random string — the gateway→upstream shared secret (step 6) |
| `AdminEmails` | comma-separated admin emails for the `/admin` portal (e.g. `clarinet.kenneth@gmail.com`) |

Note the **`ApiUrl`** output — used as `VITE_API_BASE` and the webhook target.

---

## 4. Wire the Stripe webhook

Stripe Dashboard → Developers → Webhooks → **Add endpoint**:

- URL: `<ApiUrl>/billing/webhook`
- Events: `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the **Signing secret** (`whsec_…`), then redeploy with it:

```bash
sam deploy --parameter-overrides StripeWebhookSecret=whsec_xxx
```

---

## 5. Deploy the frontend (Amplify Hosting)

1. Amplify Console → **New app → Host web app** → connect this GitHub repo, branch `main`.
2. **App root directory:** `saas/frontend` (Amplify auto-detects `amplify.yml`).
3. **Environment variables:**
   - `VITE_API_BASE` = the SAM `ApiUrl`
   - `VITE_GOOGLE_CLIENT_ID` = from step 1
   - ⚠️ **do NOT set `VITE_MOCK`** (that's local-only)
4. Save & deploy. Amplify gives you `https://main.xxxx.amplifyapp.com` (managed CloudFront + SSL).
5. Add your **custom domain** in Amplify → Domain management.
6. Go back and update the backend `AppOrigin` to the live URL (CORS + Stripe redirects):
   ```bash
   sam deploy --parameter-overrides AppOrigin=https://app.yourdomain.com
   ```
   …and add that origin to the Google OAuth client (step 1).

---

## 6. ⚠️ Lock down the upstream tool Lambdas (REQUIRED before charging)

The gateway proxies to the existing public tool Lambdas (`src/metering/upstreams.mjs`)
and sends header `x-gateway-secret: <GatewaySecret>`. Today those Lambdas accept
**anyone** — so a user could call them directly and skip billing.

Pick one, apply to every upstream:

- **Quickest:** at the top of each upstream Lambda, reject requests whose
  `x-gateway-secret` header ≠ the shared secret (store it in that Lambda's env).
- **Proper:** move them behind a private API Gateway / IAM auth and grant only
  `MeteringFn`'s role `execute-api:Invoke`, then swap the URLs in `upstreams.mjs`.

Until this is done, treat the deployment as **staging only**.

---

## 7. Smoke test

1. Visit the live URL → Google sign-in → lands on the tool grid with 30 credits.
2. Run **Keyword Analysis** (`seo singapore`) → real rows, 1 credit deducted, free-tier cap at 5 rows.
3. Run **Caption Generator** → real AI captions.
4. Click a **Pro** tool → upgrade modal → Stripe Checkout (use test card `4242 4242 4242 4242`).
5. Complete checkout → returns to `/account?checkout=success`, tier = Pro, credits = 2,000,
   locked tools now unlocked. Confirm the `invoice.paid` webhook fired (Stripe Dashboard → webhook logs).
6. Account → **Manage billing** → Stripe Customer Portal opens.
7. Account → **Buy** a top-up pack → one-time Checkout → returns to `/account?topup=success`;
   credits increase and persist across the next renewal (top-ups roll over).
8. Sign in as an `AdminEmails` address → **Admin** appears in the nav → adjust a user's
   tier/credits and confirm the change + a ledger row.

---

## Adding more tools later

1. Append the tool to `shared/catalog.mjs` (`minTier`, `cost`, `upstream`, optional `teaser`).
2. Add its upstream URL to `src/metering/upstreams.mjs`.
3. If its payload/response differs from the generic `{input}` → `{rows|text}`, add an
   adapter in `src/metering/adapters.mjs` (see `keyword-analysis` / `caption`).
4. `sam deploy`. No frontend change needed — the tool grid + runner are catalog-driven.
