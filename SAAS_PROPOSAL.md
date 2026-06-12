# Digimetrics SaaS — Proposal (Individual-User Edition)

**Date:** 2026-06-12
**Source app:** `index.html` (agency tool suite, ~50 tools, ~60 Lambda backends)
**Target:** A self-serve SaaS for individual users — freelancers, solo marketers, small-business owners — with Stripe subscriptions, AI-credit metering, tiered plans, and upgrade teasers.

---

## 1. Scope: what carries over, what gets cut

### ✂️ Excluded (agency-internal)
| Feature | Reason |
|---|---|
| Tender Builder / Proposal Generator | MediaOne RFQ workflow |
| Cockpit / Campaign Intelligence | Built around monday.com + WorkDuo + client NPS |
| Admin Console (monday board manager, Google Chat broadcaster, Synology NAS browser, team usage logs) | Internal ops |
| monday.com integration everywhere | Agency PM tool |
| SEO Pricing Quote Generator | Agency sales tool |
| Client Satisfaction / NPS tracking | Agency-client relationship tool |
| Shared Mangools quota admin | Replaced by per-user credits |

### ✅ Included (general-purpose), grouped into 4 product areas

**SEO Toolkit**
- Keyword Analysis (volume/difficulty/intent)
- Keyword Discovery from Site + Similar Keywords
- Rank Checker + position history
- Page Technical & Domain Analysis
- Technical SEO Crawler (multi-page audit)
- On-Page Optimisation (benchmark vs top SERP results)
- Competitors Identifier
- Keyword Mapping (incl. cannibalisation detection)
- Backlinks Explorer
- Schema Generator
- Internal Anchor Text Cleaner
- Google Crawler Simulator
- Google Search Console integration

**AI Content Studio**
- AI Content Optimiser / Writer / Checker
- Content Check (readability, keyword density, originality, compliance)
- Caption Generator (IG/LinkedIn/FB/TikTok)
- Content Pillar Framework
- Social Media Strategy House
- Social Media Response Generator
- Alt Text Generator

**AI Visibility (GEO)** — strongest differentiator, few competitors have this
- AI Discovery Audit (brand mentions in ChatGPT/Gemini/Perplexity)
- AI Mentions tracker
- GEO On-Page Optimisation
- llms.txt Generator
- GEO+SEO Forensic Audit (de-coupled from Screaming Frog/agency workflow)

**Ads & Strategy**
- SEM Analysis & Ad Copy Generation (Google/Meta/LinkedIn)
- GA4, Google Ads, Meta Ads read-only integrations (user connects own accounts)
- SEM Benchmark
- Persona Generator
- Media Plan Generator
- Landing Page Audit
- Performance Marketing Audit

---

## 2. Subscription tiers (proposal)

| | **Free** | **Starter — $29/mo** | **Pro — $79/mo** | **Expert — $149/mo** |
|---|---|---|---|---|
| AI credits / month | 30 | 500 | 2,000 | 6,000 |
| Projects (domains) | 1 | 3 | 10 | 25 |
| SEO Toolkit | 3 core tools, capped results | ✅ Full | ✅ Full | ✅ Full |
| AI Content Studio | Caption gen only | ✅ Full | ✅ Full | ✅ Full |
| AI Visibility (GEO) | — (teaser) | llms.txt only | ✅ Full | ✅ Full |
| Ads & Strategy | — (teaser) | Persona + Landing Audit | ✅ Full + integrations | ✅ Full |
| Tracked keywords (scheduled rank checks) | — | 25 | 250 | 1,000 |
| AI model | Haiku | Haiku | Sonnet option | Sonnet default, priority queue |
| Forensic Audit | — | — | 1/mo | 5/mo |
| PDF/CSV export | — | ✅ | ✅ | ✅ + white-label PDF |
| API access | — | — | — | ✅ |
| Credit top-ups | — | $10 / 400 cr | $10 / 500 cr | $10 / 600 cr |

- Annual = 2 months free (10× monthly).
- 7-day free trial of Pro on signup (card required via Stripe Checkout trial).
- Unused monthly credits expire; top-up credits roll over 90 days (simple to message, protects margin).

### Credit pricing (1 credit ≈ $0.01–0.015 underlying cost, target ≥70% margin)
| Action | Credits |
|---|---|
| Short AI generation (caption, reply, pillar, schema, alt text) | 1 |
| Long-form AI (article write/optimise, strategy, persona set, media plan) | 5 |
| Keyword lookup (per 10 keywords w/ volume+difficulty) | 1 |
| Rank check (per keyword × location) | 1 |
| Technical crawl (per 10 pages) | 2 |
| Backlinks report (per domain) | 5 |
| Landing Page / SEM website analysis | 5 |
| AI Discovery / AI Mentions run (multi-LLM fan-out) | 10 |
| Forensic Audit | 50 |
| GSC/GA4/Ads data pulls | 0 (user's own quota, drives stickiness) |

---

## 3. Stripe integration (recurring payments)

**Components**
1. **Stripe Checkout (hosted)** — subscribe/upgrade. No card data ever touches our stack.
2. **Stripe Customer Portal** — self-serve plan change, payment method, cancel, invoices. Zero UI to build.
3. **Stripe Products/Prices** — 3 paid products × monthly/annual prices + one-time top-up prices. Tier stored as `metadata.tier` and mirrored into the user record.
4. **Webhook Lambda** (`/billing/webhook`, signature-verified, idempotent by event id):
   - `checkout.session.completed` → link `stripe_customer_id` to user
   - `invoice.paid` → set tier, **reset monthly credit allowance** (this is the billing-cycle anchor, not a cron)
   - `customer.subscription.updated` → handle up/downgrades (upgrade = immediate + prorated, credits topped to new tier; downgrade = at period end)
   - `customer.subscription.deleted` / `invoice.payment_failed` → grace period (7 days, Stripe Smart Retries), then drop to Free
   - `payment_intent.succeeded` (top-ups) → append credits to ledger
5. **Client** — `subscription` object in the session JWT/profile endpoint; pricing page buttons → `POST /billing/checkout-session` → redirect.

---

## 4. Credits monitoring & enforcement

**The critical architectural fix:** today all ~60 Lambdas are public, unauthenticated URLs — anyone could bypass billing entirely. Metering must be server-side.

**Design: one metering gateway in front of everything.**

```
Browser (app)
   │  Authorization: Bearer <JWT>
   ▼
API Gateway + Lambda Authorizer (JWT verify)
   ▼
Metering middleware (one Lambda layer / proxy)
   1. resolve user → tier, credit balance (DynamoDB)
   2. check tool allowed for tier  → 403 + upsell payload if not
   3. check estimated cost ≤ balance → 402 + top-up payload if not
   4. invoke the existing tool Lambda (unchanged code)
   5. on success: append usage event to credit ledger (actual tokens/pages used)
   6. return result + { credits_used, credits_remaining }
   ▼
Existing tool Lambdas (re-deployed PRIVATE — no public URLs)
```

**Data model (DynamoDB):**
- `users` — id, email, google_sub, stripe_customer_id, tier, period_credits, period_end
- `credit_ledger` — append-only: user_id, ts, tool, action, credits_delta, meta (tokens, pages, keywords). Balance = allowance + Σ deltas; cache current balance on user row.
- `usage_events` — powers the in-app usage dashboard

**For AI calls specifically:** the existing Claude bridge already returns `input_tokens`/`output_tokens` — deduct estimate pre-call, reconcile with actuals post-call.

**UX:**
- Persistent credit meter in the top bar (e.g. `⚡ 1,240 / 2,000`), animates down after each run.
- Every tool result footer: "This run used 12 credits."
- Warnings at 80% (banner) and 100% (blocking modal → top-up or upgrade, with the cheaper option highlighted).
- Usage page: credits by tool, by day, projected run-out date.

---

## 5. Sneak peek at higher tiers (upsell UX)

1. **Locked tool cards stay visible** in the tool grid with a tier pill (`PRO`, `EXPERT`) and lock icon — never hide them. Clicking opens a preview modal with a 15-sec demo GIF + sample output + "Unlock with Pro" CTA.
2. **One teaser run per locked tool per month**: the tool actually executes but returns partial results — e.g. AI Discovery Audit shows 2 of 10 prompts and blurs the rest behind a frosted overlay ("8 more findings — unlock with Pro"). Real data on *their* brand converts far better than a screenshot.
3. **Capped-result blurring on lower tiers**: Free keyword analysis shows top 5 rows, rows 6–50 rendered blurred with the upgrade CTA inline. (Server truncates real data and sends placeholder rows — never ship the full payload to the client.)
4. **Model upsell**: when a Starter user gets a Haiku-generated article, show a side-by-side snippet: "Pro's advanced model also restructured your intro — preview" (one free Sonnet preview/month).
5. **Contextual nudges**: after a rank check, "Pro tracks these 25 keywords weekly automatically." After a crawl, "Forensic Audit would have checked 47 more factors."
6. **Pricing page** with monthly/annual toggle and "most popular" highlight on Pro.

All gating decisions are made **server-side** (the metering layer returns `403 {reason: 'tier', required: 'pro'}`); the client only renders the upsell UI.

---

## 6. App & auth changes

- **New entry point** (`app.<domain>` or separate repo) built from the included tool modules; strip MediaOne/Digimetrics-agency branding, monday.com code paths, admin/cockpit/tender sections. The existing tool UI code is reusable largely as-is.
- **Auth:** keep Google Sign-In, add email magic-link. Backend issues a short-lived JWT + refresh token; every API call authenticated. Kill the pattern of API keys in localStorage (Meta token, monday key) — third-party tokens stored server-side, encrypted, per user.
- **Projects model:** user creates "projects" (domains); tracked keywords, audits, GSC connections hang off projects. This is what tier limits count.
- **New pages:** Pricing, Account (subscription + Stripe portal link), Usage dashboard, Onboarding wizard (connect domain → first audit → first AI content, spending their free credits immediately = activation).

---

## 7. Build plan (phased)

| Phase | Scope | Est. |
|---|---|---|
| **1. Foundation** | Auth (JWT), users DB, metering gateway, privatize Lambdas, credit ledger | 2 wks |
| **2. Billing** | Stripe products, Checkout, Portal, webhook lambda, tier enforcement | 1 wk |
| **3. MVP product** | New shell app: SEO Toolkit + AI Content Studio (the low-dependency, high-value tools), credit meter UX, pricing page | 2–3 wks |
| **4. Upsell layer** | Locked cards, teaser runs, blurred results, model upsell | 1 wk |
| **5. Expansion** | GEO suite, Ads integrations (OAuth apps for Google/Meta need their own review cycles — start applications early), scheduled rank tracking, top-ups, annual plans | 2–3 wks |

**MVP tier simplification option:** launch with Free + Pro ($49) only, split into 4 tiers once pricing data comes in.

## 8. Open questions
1. Brand: new name vs "Digimetrics" (agency uses that name with clients)?
2. Pricing currency/market: SGD or USD-first? (SEM Benchmark data is Singapore-specific — globalize or position as SG-focused?)
3. Third-party API licensing: confirm Mangools/DataForSEO/Ahrefs-proxy terms permit resale to third parties — this can dictate which data providers survive into the SaaS.
4. Keep GitHub Pages + Lambda, or move the app shell to Amplify/Vercel with a proper build?
