# Meta App Review — `ads_read` (Marketing API)

What to submit so **any** customer can connect their own Meta (Facebook/Instagram)
ad account via OAuth, exactly like the Google Ads connector. Until this is
approved, only people with a **role on the Meta app** (admins/developers/testers)
can connect — fine for development, not for paying users.

The connector code is already wired (`backend/src/lib/meta.mjs`); it stays hidden
in the UI until `META_APP_ID` + `META_APP_SECRET` are set.

---

## 0. Prerequisites

| Item | Where | Notes |
|---|---|---|
| Meta Business account | business.facebook.com | Use the Digimetrics business, not a personal one. |
| App (type: **Business**) | developers.facebook.com → My Apps → Create | Add the **Marketing API** + **Facebook Login** products. |
| Business Verification | App → Settings → Business verification | Required before Advanced Access. Needs legal entity name, address, and a verification doc (e.g. ACRA business profile) + a domain/phone match. Allow **3–10 business days**. |

Set the OAuth redirect URI in **Facebook Login → Settings → Valid OAuth Redirect URIs**:

```
https://<your-api-domain>/oauth/callback
```

(Same callback the Google connector uses — the provider is carried in the signed
OAuth `state`, so one callback path serves all connectors.)

---

## 1. Permissions to request (App Review → Permissions and Features)

| Permission | Access level | Why |
|---|---|---|
| `ads_read` | **Advanced** | Read campaign/insights data for the user's ad accounts. This is the one that unblocks non-test users. |
| `business_management` | Advanced (usually) | Enumerate the ad accounts the user can access (`/me/adaccounts`). Request only if Standard isn't enough for your account discovery. |

You do **not** need `ads_management` (that's write access) — we are read-only.

---

## 2. What the reviewer needs

Meta reviews by **watching a screencast** of the exact OAuth + usage flow, plus
test credentials. Provide:

1. **Screencast (the make-or-break item).** Record end-to-end:
   - Log into the SaaS as a normal Pro user.
   - Go to **Integrations → Connect Meta**.
   - Complete the Facebook consent dialog, granting `ads_read`.
   - Land back on Integrations, pick an ad account.
   - Open the **Meta Ads** tool and show live spend/clicks/conversions rendering.
   - Narrate that the data shown is the *user's own* ad-account performance.
2. **Test user / credentials.** A working login to a staging deployment with at
   least one Meta ad account that has recent delivery, so the reviewer sees real
   numbers (not an empty state).
3. **Plain-language justification** for each permission. Template for `ads_read`:

   > Our product is a marketing analytics dashboard. After a user connects their
   > Meta account via Facebook Login, we call the Marketing API (`/act_<id>/insights`)
   > to display *their own* campaign spend, clicks, conversions and CPA inside our
   > dashboard and let them query it with an assistant. We only read insights; we
   > never create, edit, or manage campaigns, and we never share the data.

4. **Privacy Policy URL** and **Data Deletion** instructions URL (required app
   settings). The data-deletion URL can describe how disconnecting under
   Integrations purges stored tokens.

---

## 3. Gotchas

- **Business Verification first.** Advanced Access for `ads_read` is gated on it.
  Start verification on day 1 in parallel with building the screencast.
- **App in Live mode.** Flip the app from Development to **Live** (top toggle)
  before/with submission, or external users can't authorize.
- **Tokens expire — no refresh.** `meta.mjs` swaps the code token for a
  long-lived (~60-day) token. There is no refresh token; when it lapses the user
  re-consents. The Integrations page surfaces a "reconnect" gate automatically.
- **App secret** lives only in env (`META_APP_SECRET`) — never ship it to the
  frontend. Token exchange happens server-side in the OAuth callback.
- **Rate limits** are per-app + per-ad-account; the connector pulls at most 25
  campaign rows + a day-series per tool run, well within limits.

---

## 4. Env to set once approved (or for dev against test accounts)

```
META_APP_ID=...
META_APP_SECRET=...
# optional override; defaults to v21.0
META_API_VERSION=v21.0
```

Setting these makes the **Meta Ads** card appear on the Integrations page.
