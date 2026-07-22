// Admin → Finances balance sheet: revenue vs cost, reconciled into ONE currency.
//
//   • Revenue  — authoritative, from Stripe. Paid invoices = subscription
//                revenue; succeeded non-invoice charges = one-time top-ups.
//                Balance transactions supply Stripe processing fees + refunds.
//                Stripe settles in USD (our billing currency) so revenue is
//                already in the reporting currency — no conversion.
//   • AWS      — authoritative, from Cost Explorer, SCOPED TO THE SAAS PRODUCT
//                by the `product=saas` cost-allocation tag (all services, but
//                only SaaS-tagged resources — the ~160 internal tool Lambdas
//                behind index.html/chatbot.html share this account and region
//                and must not be charged to the SaaS P&L). Natively USD.
//   • AI/data  — an ESTIMATE, not a billed figure: credits consumed in the
//     COGS      window × COGS_USD_PER_CREDIT (what one credit of Claude / DeepSeek
//                / DataForSEO / Apify work costs us), scoped to `source='saas'`
//                ledger rows. Natively USD.
//
// Every leg is USD, so nothing is FX-converted — the whole sheet is one currency.
//
// Gross profit = net revenue − (AWS + estimated COGS). The COGS line is flagged
// `estimated: true` end-to-end so the UI can label it honestly.
//
// The AWS SDK cost-explorer client is `@aws-sdk/client-*` (kept external by the
// build, provided by the nodejs20 runtime), so it's imported dynamically here.

import Stripe from 'stripe';
import { CURRENCY, PLANS } from '../../../shared/catalog.mjs';

const DAY = 86400000;
const REPORT_CCY = CURRENCY.code;
// What one consumed credit actually costs us in vendor spend (USD). The catalog
// targets 1 credit ≈ US$0.01–0.015 underlying; midpoint default.
const COGS_USD_PER_CREDIT = Number(process.env.COGS_USD_PER_CREDIT) || 0.012;

// Cost-allocation tag that marks a resource as SaaS. Applied to the whole
// `digimetrics-saas` CloudFormation stack plus the Amplify app that serves the
// front end; everything else in the account (the internal tool Lambdas, Lightsail,
// the NAS box, …) is deliberately untagged and therefore excluded.
// NOTE: AWS only records a tag against cost data from the day it is ACTIVATED in
// Billing → Cost allocation tags, and never backfills. Windows that start before
// activation have no tagged data at all, so `awsCost` detects that case and falls
// back to the whole-account figure rather than silently reporting US$0.
const COST_TAG_KEY = process.env.COST_TAG_KEY || 'product';
const COST_TAG_VALUE = process.env.COST_TAG_VALUE || 'saas';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Build the balance-sheet payload for a window.
 * @param {Date}   from
 * @param {Date}   to
 * @param {object[]} users     raw user items (for run-rate MRR)
 * @param {object} consumed    { credits, byTool } from dynamo.creditsConsumed
 */
export async function financeReport({ from, to, users = [], consumed = { credits: 0, byTool: [] } }) {
  const [revenue, aws] = await Promise.all([
    stripeRevenue(from, to).catch((e) => ({ error: e.message })),
    awsCost(from, to).catch((e) => ({ error: e.message })),
  ]);

  // Cost side — AWS and COGS are already USD, the reporting currency.
  const awsCostUsd = aws.error ? 0 : round2(aws.usd);
  const cogsUsd = round2((consumed.credits || 0) * COGS_USD_PER_CREDIT);
  const totalCost = round2(awsCostUsd + cogsUsd);

  const netRevenue = revenue.error ? 0 : revenue.net;
  const grossProfit = round2(netRevenue - totalCost);
  const marginPct = netRevenue > 0 ? grossProfit / netRevenue : null;

  return {
    currency: REPORT_CCY,
    range: { from: from.toISOString(), to: to.toISOString() },
    revenue,
    mrr: monthlyRunRate(users),
    cost: {
      aws: aws.error
        ? { error: aws.error, usd: 0 }
        : {
            usd: aws.usd,
            granularity: aws.granularity,
            byService: aws.byService,
            estimated: aws.estimated,
            scope: aws.scope,
            tag: aws.tag,
            ...(aws.note ? { note: aws.note } : {}),
          },
      cogs: {
        credits: consumed.credits || 0,
        usdPerCredit: COGS_USD_PER_CREDIT,
        usd: cogsUsd,
        byTool: consumed.byTool || [],
        truncated: !!consumed.truncated,
        estimated: true,
        source: consumed.source || 'saas',
        // Credits spent by SaaS accounts but driven from the internal cockpit —
        // reported for transparency, NOT added to the SaaS cost base.
        excluded: consumed.excluded || {},
      },
      total: totalCost,
    },
    profit: { grossProfit, marginPct },
  };
}

// ── Revenue (Stripe) ─────────────────────────────────────────────────────────
async function stripeRevenue(from, to) {
  if (!stripe) throw new Error('Stripe not configured (STRIPE_SECRET_KEY unset).');
  const gte = Math.floor(from.getTime() / 1000);
  const lte = Math.ceil(to.getTime() / 1000);

  // Subscriptions: paid invoices in the window (amount actually collected).
  let subsCents = 0, ccy = REPORT_CCY.toLowerCase(), i = 0;
  for await (const inv of stripe.invoices.list({ created: { gte, lte }, status: 'paid', limit: 100 })) {
    subsCents += inv.amount_paid || 0;
    ccy = inv.currency || ccy;
    if (++i > 5000) break;
  }

  // Top-ups: succeeded one-time charges (no invoice → not a subscription charge).
  let topupCents = 0, j = 0;
  for await (const ch of stripe.charges.list({ created: { gte, lte }, limit: 100 })) {
    if (ch.status === 'succeeded' && ch.paid && !ch.invoice) topupCents += ch.amount || 0;
    ccy = ch.currency || ccy;
    if (++j > 5000) break;
  }

  // Processing fees + refunds from balance transactions (settlement currency).
  let feeCents = 0, refundCents = 0, k = 0;
  for await (const tx of stripe.balanceTransactions.list({ created: { gte, lte }, limit: 100 })) {
    if (['charge', 'payment'].includes(tx.type)) feeCents += tx.fee || 0;
    else if (['refund', 'payment_refund'].includes(tx.type)) refundCents += Math.abs(tx.amount || 0);
    if (++k > 5000) break;
  }

  const d = (cents) => round2(cents / 100);
  const gross = d(subsCents + topupCents);
  const fees = d(feeCents);
  const refunds = d(refundCents);
  return {
    currency: (ccy || REPORT_CCY).toUpperCase(),
    subscriptions: d(subsCents),
    topups: d(topupCents),
    gross,
    fees,
    refunds,
    net: round2(gross - fees - refunds),
  };
}

// Current run-rate MRR from active, Stripe-linked subscribers × their plan price.
// A snapshot (not windowed) — the standard way MRR is read.
function monthlyRunRate(users = []) {
  const byPlan = {};
  let total = 0;
  for (const u of users) {
    if (!u.stripeCustomerId) continue;                 // only paying accounts
    if (u.status && u.status !== 'active') continue;    // skip paused/cancelled
    const plan = PLANS[u.tier];
    if (!plan || !plan.priceMonthly) continue;          // free / unknown tier
    total += plan.priceMonthly;
    const b = (byPlan[u.tier] ||= { tier: u.tier, name: plan.name, price: plan.priceMonthly, count: 0, mrr: 0 });
    b.count++;
    b.mrr += plan.priceMonthly;
  }
  return { total: round2(total), byPlan: Object.values(byPlan).sort((a, b) => b.mrr - a.mrr) };
}

// ── AWS cost (Cost Explorer, SaaS-tagged resources) ──────────────────────────
// Runs the tag-filtered query first. A zero result is ambiguous — it means either
// "the SaaS stack genuinely cost nothing" or "this window predates tag activation"
// — so it's disambiguated with one unfiltered probe: if the account also billed
// zero, the zero is real; if the account billed something, the tag simply wasn't
// recording yet and we report the whole-account figure flagged `scope:'account'`
// so the UI can say so instead of quietly showing a US$0 cost base.
async function awsCost(from, to) {
  const { CostExplorerClient, GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');
  const ce = new CostExplorerClient({ region: 'us-east-1' }); // CE is global, pinned to us-east-1
  const span = to - from;
  const granularity = span <= 40 * DAY ? 'DAILY' : 'MONTHLY';
  const query = async (Filter) => {
    const res = await ce.send(new GetCostAndUsageCommand({
      // End date is EXCLUSIVE, so bump `to` a day to include it.
      TimePeriod: { Start: ymd(from), End: ymd(new Date(to.getTime() + DAY)) },
      Granularity: granularity,
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      ...(Filter ? { Filter } : {}),
    }));
    const byService = {};
    let usd = 0;
    for (const bucket of res.ResultsByTime || []) {
      for (const g of bucket.Groups || []) {
        const svc = g.Keys?.[0] || 'Other';
        const cost = Number(g.Metrics?.UnblendedCost?.Amount || 0);
        byService[svc] = (byService[svc] || 0) + cost;
        usd += cost;
      }
    }
    return {
      usd: round2(usd),
      granularity,
      byService: Object.entries(byService)
        .map(([service, c]) => ({ service, usd: round2(c) }))
        .filter((r) => r.usd > 0)
        .sort((a, b) => b.usd - a.usd),
      estimated: (res.ResultsByTime || []).some((b) => b.Estimated),
    };
  };

  const tagged = await query({
    Tags: { Key: COST_TAG_KEY, Values: [COST_TAG_VALUE], MatchOptions: ['EQUALS'] },
  });
  if (tagged.usd > 0) return { ...tagged, scope: 'saas', tag: `${COST_TAG_KEY}=${COST_TAG_VALUE}` };

  const account = await query(null);
  if (account.usd <= 0) return { ...tagged, scope: 'saas', tag: `${COST_TAG_KEY}=${COST_TAG_VALUE}` };
  return {
    ...account,
    scope: 'account',
    tag: `${COST_TAG_KEY}=${COST_TAG_VALUE}`,
    // The UI must label this: it includes the internal index.html/chatbot.html
    // fleet, so gross profit for this window understates SaaS margin.
    note: `No ${COST_TAG_KEY}=${COST_TAG_VALUE} tagged cost in this window — AWS only tags cost data from the day the tag is activated. Showing whole-account spend, which includes the internal tool fleet.`,
  };
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d) => d.toISOString().slice(0, 10);
