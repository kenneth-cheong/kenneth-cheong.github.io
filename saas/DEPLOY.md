# Deployment runbook — Digimetrics SaaS on AWS

End-to-end, in order. Region: **ap-southeast-1** (Singapore). Currency: **SGD**.
Everything lives in one AWS account; nothing on GitHub Pages.

Prerequisites: AWS CLI configured, **Node 20+** (the build needs Node 20 on PATH —
not an older system Node), a Stripe account, and the existing Google OAuth client.

> **No SAM CLI required.** The `package.json` scripts still mention `sam`, but the
> stack is deployed **without the SAM CLI** (it isn't installed): we bundle with
> `esbuild` via `scripts/build.mjs`, then `aws cloudformation package` +
> change-set. The real commands are in step 3. The live stack is
> **`digimetrics-saas`** in `ap-southeast-1` (ApiUrl host `h07tay1xvi`).

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

## 3. Deploy the backend (esbuild → CloudFormation)

The backend has **12 Lambdas** (`authorizer, auth, me, metering, billing, admin, app,
close, track, metricscron, refill, chatstream`) — the canonical list is the `FUNCTIONS`
array in `scripts/build.mjs`. It bundles each into `.build/<fn>/index.mjs` with
`esbuild` (inlining `shared/catalog.mjs` + npm deps; the AWS SDK is provided by the
nodejs20 runtime). `template.yaml` points each function's `CodeUri` at `.build/<fn>/`.

```bash
cd saas/backend
npm install
node scripts/build.mjs        # esbuild → .build/<fn>/

aws cloudformation package \
  --template-file template.yaml \
  --s3-bucket <your-artifact-bucket> \
  --output-template-file /tmp/pkg.yaml \
  --region ap-southeast-1
```

### First deploy — create the stack

> **Secrets are NOT CloudFormation parameters.** `JwtSecret`, `GatewaySecret`,
> `StripeSecretKey`, `StripeWebhookSecret`, the Google Ads developer token and the
> Anthropic key live in **Secrets Manager** (`digimetrics-saas/jwt-secret`,
> `…/gateway-secret`, `…/stripe-secret-key`, `…/stripe-webhook-secret`,
> `…/google-ads-developer-token`, `…/anthropic-key`) and the template pulls them via
> `{{resolve:secretsmanager:…}}`. Seed those secrets **before** the first deploy:
> ```bash
> aws secretsmanager create-secret --name digimetrics-saas/jwt-secret \
>   --secret-string "$(openssl rand -hex 32)" --region ap-southeast-1
> # …repeat for gateway-secret, stripe-secret-key, stripe-webhook-secret (whsec_temp
> #    for now — set the real one in step 4), google-ads-developer-token, anthropic-key
> ```

The template's CloudFormation **parameters** (the live stack uses exactly these ten):

| Parameter | Value |
|---|---|
| `AppOrigin` | `http://localhost:5173` for now; change to the live URL after step 5 |
| `CorsOrigins` | comma-separated allowed origins (e.g. the Amplify URL + localhost) |
| `GoogleClientId` | from step 1 |
| `GoogleClientSecret` | from step 1 (empty string is allowed — browser-token flow) |
| `GoogleAdsLoginCustomerId` | Ads MCC login customer id (digits, no dashes) |
| `AdminEmails` | comma-separated admin emails for `/admin` (e.g. `clarinet.kenneth@gmail.com`) |
| `SesFrom` | verified SES "from" address |
| `SesSupport` | support inbox address |
| `AutoCloseDays` | days of inactivity before a support ticket auto-closes |
| `AlarmEmail` | email for CloudWatch error/throttle alarms (SNS sends a one-time confirm) |

```bash
aws cloudformation deploy \
  --template-file /tmp/pkg.yaml \
  --stack-name digimetrics-saas \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --region ap-southeast-1 \
  --parameter-overrides \
    AppOrigin=http://localhost:5173 CorsOrigins=http://localhost:5173 \
    GoogleClientId=... GoogleClientSecret=... GoogleAdsLoginCustomerId=... \
    AdminEmails=clarinet.kenneth@gmail.com SesFrom=no-reply@example.com \
    SesSupport=support@example.com AutoCloseDays=7 AlarmEmail=you@example.com
```

Note the **`ApiUrl`** output (`aws cloudformation describe-stacks`) — used as
`VITE_API_BASE` and the Stripe webhook target. There's also a **`RunUrl`** Function
URL output that slow tools route through (the `/run/{toolId}` API path has a 30s cap).

### Subsequent updates — change-set (preserves params)

For an existing stack, deploy via a change-set and pass **`UsePreviousValue=true`** for
every parameter you aren't changing, so you don't clobber the live values. Pass **all
ten** — `create-change-set` rejects `UsePreviousValue` for a key that isn't in the
template, and omitting a key resets it to its default (see the `AlarmEmail` warning
below). Secrets aren't parameters (they're in Secrets Manager), so they're never listed
here:

```bash
CS="deploy-$(git rev-parse --short HEAD)"
aws cloudformation create-change-set --stack-name digimetrics-saas \
  --change-set-name "$CS" --change-set-type UPDATE \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --template-body file:///tmp/pkg.yaml --region ap-southeast-1 \
  --parameters \
    ParameterKey=AppOrigin,UsePreviousValue=true \
    ParameterKey=CorsOrigins,UsePreviousValue=true \
    ParameterKey=GoogleClientId,UsePreviousValue=true \
    ParameterKey=GoogleClientSecret,UsePreviousValue=true \
    ParameterKey=GoogleAdsLoginCustomerId,UsePreviousValue=true \
    ParameterKey=AdminEmails,UsePreviousValue=true \
    ParameterKey=SesFrom,UsePreviousValue=true \
    ParameterKey=SesSupport,UsePreviousValue=true \
    ParameterKey=AutoCloseDays,UsePreviousValue=true \
    ParameterKey=AlarmEmail,UsePreviousValue=true

# Wait for the change-set to finish computing, then ALWAYS review before executing —
# every Lambda shows "Modify" (shared/catalog.mjs is inlined into each bundle); check
# there's no unexpected "Remove" (esp. AlarmTopic) and no Replace on a DynamoDB table:
aws cloudformation wait change-set-create-complete --stack-name digimetrics-saas \
  --change-set-name "$CS" --region ap-southeast-1
aws cloudformation describe-change-set --stack-name digimetrics-saas \
  --change-set-name "$CS" --region ap-southeast-1 \
  --query 'Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Replace:Replacement}' --output table
aws cloudformation execute-change-set --stack-name digimetrics-saas \
  --change-set-name "$CS" --region ap-southeast-1
aws cloudformation wait stack-update-complete --stack-name digimetrics-saas --region ap-southeast-1
```

> ⚠️ **Don't drop `AlarmEmail` from the param list.** It defaults to `''` and gates
> the `AlarmTopic` SNS resource. Omitting it (instead of `UsePreviousValue=true`)
> makes the change-set show `Remove AlarmTopic` and silently kills all alerting.

### Code-only fast path (no `template.yaml`/param change)

When a deploy touches **only Lambda source** (handlers / adapters / `lib` /
`shared/catalog.mjs`) and not the template, skip CloudFormation entirely — far safer,
no param risk:

```bash
node scripts/build.mjs
(cd .build/<fn> && zip -rq ../<fn>.zip .)
aws lambda update-function-code --function-name <physical-name> \
  --zip-file fileb://.build/<fn>.zip --region ap-southeast-1
```

Physical names are `digimetrics-saas-<LogicalId>-<suffix>` (resolve via
`aws cloudformation describe-stack-resources`). **`shared/catalog.mjs` is inlined into
every bundle** (as is `shared/metrics.mjs`), so a catalog/metrics change means
redeploying all 12 functions. (This leaves the stack's S3 artifact pointers stale until
the next full CFN deploy — fine for code.)

### Two SAM-transform gotchas (already handled in `template.yaml`)

The server-side SAM transform that `aws cloudformation` runs is stricter than the SAM
CLI's local translator. The template already works around both — don't reintroduce them:

- **Never set `TimeoutInMillis` on an HttpApi event** — it leaves the route's
  integration unlinked (→ 404). Rely on the 30s default; slow tools use `RunUrl`.
- **Never reference `${Api}` in a Function's env** — it creates a circular dependency.
  The OAuth redirect URI is derived at runtime from `event.requestContext.domainName`.

---

## 4. Wire the Stripe webhook

Stripe Dashboard → Developers → Webhooks → **Add endpoint**:

- URL: `<ApiUrl>/billing/webhook`
- Events: `checkout.session.completed`, `invoice.paid`,
  `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the **Signing secret** (`whsec_…`) and write it to the Secrets Manager secret
  the template resolves (`digimetrics-saas/stripe-webhook-secret`):

```bash
aws secretsmanager put-secret-value \
  --secret-id digimetrics-saas/stripe-webhook-secret \
  --secret-string whsec_xxx --region ap-southeast-1
```

`{{resolve:secretsmanager:…}}` is evaluated at **deploy time**, not runtime, so the new
value only reaches `BillingFn`'s env on the next CloudFormation deploy — run the
standard step-3 change-set (all params `UsePreviousValue=true`) to pick it up. The
code-only `update-function-code` fast path does **not** re-resolve secret env vars, so
don't use it to rotate this.

---

## 5. Deploy the frontend (Amplify Hosting — manual deploy)

The React app is a **manual-deploy** Amplify app (app id `d1q0hza133u0y9`, branch
`main`, `ap-southeast-1`) at `https://main.d1q0hza133u0y9.amplifyapp.com`. It is **not**
wired to auto-build from GitHub — you build locally and upload the `dist/` bundle.

```bash
cd saas/frontend
npm install
# Set the build-time env vars first (deploy.sh / your shell), then:
npm run deploy        # == bash deploy.sh: vite build → zip dist/ →
                      #    aws amplify create-deployment → upload → start-deployment
```

**Build-time env vars** (Vite inlines `VITE_*` at build time):
- `VITE_API_BASE` = the backend `ApiUrl` (step 3)
- `VITE_GOOGLE_CLIENT_ID` = from step 1
- ⚠️ **do NOT set `VITE_MOCK`** (that's local-only; it switches on the mock backend)

> `shared/catalog.mjs` is imported by **both** sides. Any change to tool
> fields/forms/options needs a **frontend** redeploy; gateway/adapter changes need the
> **backend** deploy. A full tool change usually needs both.

Then:
1. Add your **custom domain** in Amplify → Domain management (managed CloudFront + SSL).
2. Update the backend `AppOrigin` to the live URL (CORS + Stripe redirects) via a
   change-set (`ParameterKey=AppOrigin,ParameterValue=https://app.yourdomain.com`, the
   rest `UsePreviousValue=true` — see step 3), and add that origin to the Google OAuth
   client (step 1).

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
4. Deploy. Since `catalog.mjs` is inlined into every bundle and imported by the
   frontend, redeploy **both** sides: backend (code-only fast path, all 12 functions —
   step 3) **and** frontend (`npm run deploy` — step 5). The tool grid + runner are
   catalog-driven, so no other frontend code changes.
