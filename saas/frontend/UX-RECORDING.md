# Recording users for UX testing (plain-English guide)

We use **Microsoft Clarity** to record how people use the platform — their mouse,
clicks, scrolling and which pages they visit — so we can watch where they get
stuck. It's **free and unlimited**, and it **hides anything typed into boxes**
(passwords, API keys, client data) so you only ever see blurred placeholders
there, never the real text.

Recording is **OFF by default.** It only starts once you paste in a Project ID
and re-publish. Nothing about the live site changes until you do that.

---

## Part A — Turn recording ON (one-time, ~10 minutes)

1. Go to **https://clarity.microsoft.com** and click **Sign up** (use your
   Google or Microsoft account — it's free, no credit card).
2. Click **+ New project**.
   - Name: `Digimetrics`
   - Website URL: `platform.digimetrics.ai`
3. It shows you a **Project ID** — a short code like `abcd1234ef`. Copy it.
   (If it shows a block of `<script>` code instead, ignore the code; the ID is
   the part in the URL `.../tag/**abcd1234ef**`.)
4. Open the file `saas/frontend/.env.production` and put the ID after the equals
   sign on this line:
   ```
   VITE_CLARITY_ID=abcd1234ef
   ```
5. Publish the site the usual way (`npm run deploy` in `saas/frontend`).
6. Done. Within a few minutes, sessions start appearing in the Clarity
   dashboard. (First recordings can take up to ~2 hours to show.)

**To turn it OFF again:** blank the line back to `VITE_CLARITY_ID=` and redeploy.

---

## Part B — Recommended privacy setting (do this once, in Clarity)

In the Clarity dashboard → **Settings → Masking**, choose **Mask** (the default).
This blurs everything users type. Leave it on — it keeps us on the right side of
Singapore's PDPA and protects any client data testers enter.

---

## Part C — Watch a specific tester's session

Every logged-in session is tagged with the person's email automatically, so you
don't have to guess which recording is whose.

1. Open the Clarity dashboard → **Recordings**.
2. Click **Filters** → **Custom tags** → **email**, and pick the tester's email
   (e.g. `jane@company.com`). You'll now only see that person's sessions.
3. Click a session to play it back like a video. Use **Heatmaps** (left menu) to
   see, across everyone, where people click most and where they rage-click.

Tip: filter by **tier** the same way to compare Starter vs Pro users.

---

## Part D — Before you record anyone (consent — important)

Under Singapore's PDPA you must tell people they're being recorded and get their
OK first. Keep it simple — send this line before a session and get a "yes" in
writing (email/WhatsApp is fine):

> "For this test we'll record your screen and mouse movements inside the app to
> improve the design. We won't capture anything you type, and the recording is
> only used internally by our team. Are you OK to proceed?"

---

## Part E — Task sheet to give each tester

Send participants something like this. Keep tasks outcome-based ("find X"),
**don't** tell them *how* — the whole point is to see if they can figure it out.

> **Thanks for helping us test! There are no wrong answers — if you get stuck,
> that's exactly what we want to learn. Please "think out loud" as you go.**
>
> 1. Sign in and get to your main dashboard.
> 2. Start a **Keyword Analysis** for the website `example.com`.
> 3. Find where your remaining **credits** are shown.
> 4. Run any one tool and **save the result to a project**.
> 5. Open the **assistant (Monty)** and ask it one question about your result.
> 6. Find how you'd **contact support** if something went wrong.
>
> When you're done, tell us: what was confusing, and what felt easy?

---

## What we can and can't see

- ✅ Mouse movement, clicks, scrolling, which pages/tools they used, how long
  each step took, rage-clicks and dead-clicks (signs of frustration).
- ❌ Anything typed into input fields (masked), their password, or their Google
  login screen (that happens on Google's own site, off our page).
