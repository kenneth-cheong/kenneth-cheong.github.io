# Phase 3 — Validation & Commercial Readiness (Step 12)

**Status: NOT COMPLETE. This phase cannot be signed off by the build.**

Step 12's own rule decides this:

> *A phase should only be treated as completed when relevant users confirm the output is useful enough for real work, not merely a technical demo.*

Steps 9–11 are **built and live**. That makes them *testable*, not *done*. Phase 3 closes only when the sign-off table at the bottom of this document is filled in by real MediaOne staff running real scenarios. Until then the correct status is "built, awaiting validation".

---

## 1. What is live to test

| Step | Feature | Where |
|---|---|---|
| 9 | Tender Mode — discipline-specific proposals | app.digimetrics.ai → **Others → Tender Builder** → new tender → **Proposal Discipline** |
| 10 | Pricing engine + ±% slider | app.digimetrics.ai → **Pricing Quote Generator** |
| 11 | Manager/Consultant dashboards, drill-down, diagnosis | app.digimetrics.ai/campaign-board-crawler.html → **Team Lead** / **Client Success** / **Consultant** |

---

## 2. Scenarios to run

Run each with a **real** client/campaign, not a made-up one. The test is whether you'd actually put the output in front of a client or act on it.

### S1 — Sales / Tender (Step 9)
1. Take a **real RFP you have already responded to** (one whose outcome you know).
2. Create a tender, set **Proposal Discipline** to match it (SEO / Performance Marketing / Social & Content).
3. Generate the deck.

**What good looks like**
- The discipline-specific sections are present and relevant (e.g. PM deck has channel mix, funnel, tracking, budget phasing).
- The strategy would survive a client reading it — no generic filler.
- It is at least as good a starting point as your real response was.

**Kill criteria** — if you would rewrite more than ~50% before sending, it is not commercially useful yet.

### S2 — Pricing (Step 10)
1. Price a **real deal you have quoted before**, at rate card (slider at 0%).
2. Compare the number to what you actually charged.
3. Move the slider to the discount you actually gave.

**What good looks like**
- The rate-card number lands in a defensible range of the real quote.
- At a discount, the **scope assumptions / commercial notes** change in a way you would genuinely stand behind.
- **Manpower** (consultant-days / FTE) is believable against how the job was really staffed.

**Known proxy to challenge** — the blended delivery rate is **SGD 850/consultant-day**, an estimate. If that is wrong, the manpower numbers are wrong. Correct it before this passes.

### S3 — CSM (Step 11)
1. Open **Client Success**. Check the health donut against what you know to be true.
2. Click a segment → drill into the campaigns.
3. Open a campaign's **Summary** → read the drill chain.

**What good looks like**
- The health split matches your intuition about the portfolio. If a campaign you know is in trouble shows green, the model is wrong.
- The **reminder history** shows nudges you have actually sent.

### S4 — Specialist (Step 11)
1. Filter to your **discipline** (SEO / PM / Social / Content).
2. Confirm your campaigns are classified correctly.

**Known limitation to challenge** — discipline is **inferred from folder/board names**. If your folders do not encode discipline, most campaigns default to **SEO**. Note every misclassification; if it is widespread we should read a Monday service-type column instead.

### S5 — Manager + the diagnosis test (Steps 11 & 12) — **the important one**
1. Open **Team Lead** → drill a red/orange campaign → open its **Summary**.
2. Read **Observed** vs **Likely diagnosis**.

Step 12 requires the system to *distinguish surface-level observations from true diagnosis*. So judge them separately:

| Field | The test |
|---|---|
| **Observed** | Is it factually correct? (It is only counting things — it should never be wrong.) |
| **Likely diagnosis** | Does it tell you something you did **not** already know from the observation? Would you act on it? |
| **Basis** | Does the cited evidence actually support the diagnosis? |
| **Confidence** | Does it feel honest? A *low* confidence on a thin signal is a **pass**, not a failure. |
| **Next action** | Is it the thing you would actually do next? |

**Kill criteria** — if the diagnosis only restates the observation in different words, it is a surface reading and fails Step 12.

**Diagnoses currently implemented** (verify each against a campaign where you know the real answer):
- Blocked on client approval rather than delivery capacity
- Capacity bottleneck on a named person
- Stale plan — overdue count may be record-keeping, not slippage
- Outcomes lagging while delivery is clean → strategy, not execution
- Escalation with / without real slippage
- Waiting on client, delivery clean
- *Not enough signal to diagnose* (low confidence — this is a legitimate, honest answer)

---

## 3. Known limitations testers should push on

Judge these deliberately rather than discovering them later.

| # | Limitation | Impact if wrong |
|---|---|---|
| 1 | Blended rate **SGD 850/day** is an estimate | All Step 10 manpower figures |
| 2 | Discipline **inferred from folder/board names** | Misclassified campaigns; SEO over-counted |
| 3 | **Approval aging** uses last-updated time, not true time-in-approval | "Awaiting Nd" reads as stalled-time, not approval-time |
| 4 | **Reminder history** is per-device (localStorage), written only on the Hygiene "Copy nudge" | Nudges sent elsewhere/by others are invisible |
| 5 | Tender **Pricing Schedule** slides are AI-generated, **not** wired to the Step 10 engine | A tender's pricing may not match the pricing tool |
| 6 | Health bands use 4 bands (green/amber/orange/red) | Spec's literal "green/orange/red" is a 3-band read |

---

## 4. Sign-off

Phase 3 is complete **only** when every row below says **Useful for real work**.

| Scenario | Role | Tester | Date | Verdict (Useful / Not yet) | Notes / what to fix |
|---|---|---|---|---|---|
| S1 Tender | Sales | | | | |
| S2 Pricing | Sales / Commercial | | | | |
| S3 CSM dashboard | CSM | | | | |
| S4 Discipline | Specialist | | | | |
| S5 Manager + diagnosis | Manager | | | | |

**Overall Phase 3 status:** ☐ Built, awaiting validation ☐ Validated — complete
