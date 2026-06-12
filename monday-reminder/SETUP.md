# Monday Reminders — Item View app setup

The hybrid reminder system has two ways in:

- **Text path** (already live): post `remind me to … tomorrow 3pm` on any item. Also `stop reminder`, `list reminders`.
- **UI path** (this app): a **Reminders** tab on the item card to list / create / edit cadence / cancel with a form.

The UI path is a monday **app** with an **Item View** feature pointing at this page. The backend (`monday-reminder-api` Lambda + `/reminders` routes) is already deployed and verified; the only remaining work is registering the app and giving it the Client Secret.

---

## 1. Publish the frontend
Merge the `monday-reminder-app` PR to `main`. GitHub Pages then serves the app at:

```
https://digimetrics.ai/monday-reminder/
```

(That is the URL the Item View feature points to.)

## 2. Create / configure the monday app
Developer Center → **Developers** → **My apps** → *Build app* (or open the existing reminder app).

1. **Features → add _Item View_.**
   - Set the **URL** (a.k.a. "Custom URL" / build URL) to `https://digimetrics.ai/monday-reminder/`.
2. *(Optional)* **Features → add _Item Menu_ action** ("Set reminder…") that opens the same URL as a modal — the page already works both inline and in `openAppFeatureModal`.
3. **OAuth & Permissions → Scopes:** add `users:read` (powers the "remind someone else" dropdown). `me:read` is enough for self-reminders.
4. **Build a version → Promote / Install** on your workspace.
5. Open an item → add the **Reminders** view → it should load the form.

## 3. Give the API the Client Secret (one-time)
The backend verifies the monday **session token** with your app's **Client Secret** (Developer Center → your app → **Basic Information / OAuth**, the `Client Secret`).

Until this is set, the API returns `401 unauthorized` (it currently holds a placeholder).

Either hand the secret to Claude to set it, or run (replacing `SECRET`, and keeping the other env vars intact):

```bash
aws lambda update-function-configuration \
  --function-name monday-reminder-api --region ap-southeast-1 \
  --environment 'Variables={TABLE=monday-reminders,TZ_OFFSET=8,CLIENT_SECRET=SECRET,MONDAY_API_TOKEN=<existing token>}'
```

> ⚠️ `update-function-configuration` **replaces** the whole `Variables` map — include every existing var, not just `CLIENT_SECRET`.

## 4. Done
Open an item's **Reminders** tab and set one. It writes to the same `monday-reminders` DynamoDB table the text path uses, so the every-minute scheduler fires UI- and text-created reminders identically.

---

## Architecture
```
TEXT PATH                          UI PATH (this app)
 update "remind me…"                Item View tab → monday-sdk-js
   POST /webhook ─┐                   context(itemId) + sessionToken (JWT)
                  │                       │ Authorization: <JWT>
        monday-reminder-webhook    GET/POST/PATCH/DELETE /reminders
        (chrono parse + commands)        │
                  └────► DynamoDB ◄─ monday-reminder-api (verifies JWT
                         monday-reminders   with CLIENT_SECRET)
                  ┌────►          ◄──┘
        monday-reminder-scheduler (EventBridge, every minute — unchanged)
```

- Region `ap-southeast-1`, account `167633412846`.
- API: `https://xfug3j9w58.execute-api.ap-southeast-1.amazonaws.com/prod`
- CORS allows `https://digimetrics.ai` and `https://kenneth-cheong.github.io`.
- Reminder row shape is shared across all three Lambdas: `id, itemId, userId, targetId, fireAt, fireAtEpoch, message, originalText, recur, status`.
- Recurrence rule format: `''` once · `wd` weekdays · `w0–6` weekly on a weekday · `N` every N days.
