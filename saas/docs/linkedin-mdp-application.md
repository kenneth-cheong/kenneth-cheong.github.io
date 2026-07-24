# LinkedIn Marketing Developer Platform (MDP) — Application

What to submit so customers can connect their own LinkedIn Ads account via OAuth
like the Google Ads connector. The ad scopes (`r_ads`, `r_ads_reporting`) are
**not self-serve** — they're gated behind LinkedIn's MDP review. This is the
**slower of the two approvals** (often weeks, and LinkedIn can decline), so start
it first.

The connector code is already wired (`backend/src/lib/linkedin.mjs`); it stays
hidden in the UI until `LINKEDIN_CLIENT_ID` + `LINKEDIN_CLIENT_SECRET` are set.

---

## 0. Prerequisites

| Item | Where | Notes |
|---|---|---|
| LinkedIn Company Page | linkedin.com/company | MDP apps must be linked to a real Company Page (Digimetrics's). Create/claim it first. |
| Developer app | developer.linkedin.com → Create app | Associate it with the Company Page above and verify the page (the "Verify" button generates a link a Page admin clicks). |
| Default products | App → Products | Add **Sign In with LinkedIn using OpenID Connect** (for basic auth) — available instantly. |

Set the OAuth redirect URL in **App → Auth → Authorized redirect URLs**:

```
https://<your-api-domain>/oauth/callback
```

(Same callback the other connectors use; the provider is carried in the signed
OAuth `state`.)

---

## 1. The product to request

Apply for the **Marketing Developer Platform** product (App → Products → request
access). This grants the ad scopes:

| Scope | Why |
|---|---|
| `r_ads` | Read ad accounts, campaigns, creatives (account discovery via `/rest/adAccounts`). |
| `r_ads_reporting` | Read analytics (`/rest/adAnalytics`) — spend, clicks, impressions, conversions. |

We request **read-only** scopes; we do not need `rw_ads`.

---

## 2. The application form — what they ask & how to answer

LinkedIn's MDP request is a questionnaire about your company and use case. Have
these ready:

1. **Company details** — legal name, website, LinkedIn Page, company size,
   primary country (Singapore).
2. **Use-case description.** Template:

   > We operate a marketing analytics SaaS for SMEs. After a customer authorizes
   > our app with `r_ads` + `r_ads_reporting`, we read *their own* LinkedIn Ads
   > performance (spend, clicks, impressions, conversions) via the Marketing API
   > and present it in a unified dashboard alongside their Google and Meta ad
   > data, with an AI assistant to query it. We are read-only — we never create
   > or modify campaigns — and we do not resell or share the data.

3. **Which APIs** — Reporting (Ad Analytics) + Ad Accounts. Volume estimate: low
   (a handful of analytics calls per user per dashboard view).
4. **Are you an agency / building for clients?** Yes — clarify it's self-serve:
   each customer connects their *own* ad account; we are not a managed-service
   reseller.
5. **Screenshots / mockups** of where the data appears (the Integrations page +
   the LinkedIn Ads tool result with stat cards and the spend/clicks chart).

LinkedIn may follow up by email asking for a demo or clarification — respond
promptly; silence stalls the review.

---

## 3. Gotchas specific to LinkedIn

- **Data goes through the agency monday Lambda, not the LinkedIn REST API
  directly.** `linkedin.mjs` calls the existing `linkedin_get_ad_accounts` /
  `linkedin_get_analytics` actions (the same proxy the index.html app uses) with
  the OAuth token we obtained — see `UPSTREAMS.mondayBridge`. That Lambda already
  handles LinkedIn's versioned headers, Rest.li query encoding, and campaign-name
  resolution, so we don't re-implement any of it. **If LinkedIn's reporting
  schema changes, the fix is in that agency Lambda, not the SaaS.**
- **No daily trend chart yet.** The `linkedin_get_analytics` action returns
  campaign-aggregated rows (no per-day breakdown), so the LinkedIn tool shows
  stat cards + the breakdown table but omits the spend/clicks trend chart. Adding
  it needs a time-based pivot on the agency Lambda.
- **Token lifecycle.** Access token ~60 days, refresh token ~12 months. Refresh
  only works after MDP access is granted; `linkedin.mjs` refreshes silently and
  falls back to a reconnect gate when the refresh token lapses.
- **Two-step verification of the app** (Company Page admin must click the verify
  link) is required before you can request MDP — don't skip it.

---

## 4. Env to set once approved (or for dev once you have a sandbox app)

```
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
```

Setting these makes the **LinkedIn Ads** card appear on the Integrations page.
(No API-version var is needed — the agency monday Lambda owns the LinkedIn API
version.)
