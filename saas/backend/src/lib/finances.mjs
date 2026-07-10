// Admin → Finances balance sheet: revenue vs cost, reconciled into ONE currency.
//
//   • Revenue  — authoritative, from Stripe. Paid invoices = subscription
//                revenue; succeeded non-invoice charges = one-time top-ups.
//                Balance transactions supply Stripe processing fees + refunds.
//                Stripe settles in SGD (our billing currency) so revenue is
//                already in the reporting currency — no conversion.
//   • AWS      — authoritative, from Cost Explorer (ALL services, not just
//                Amplify). USD, converted to SGD at USD_SGD_RATE.
//   • AI/data  — an ESTIMATE, not a billed figure: credits consumed in the
//     COGS      window × COGS_USD_PER_CREDIT (what one credit of Claude / DeepSeek
//                / DataForSEO / Apify work costs us). Converted USD→SGD.
//
// Gross profit = net revenue − (AWS + estimated COGS). The COGS line is flagged
// `estimated: true` end-to-end so the UI can label it honestly.
//
// The AWS SDK cost-explorer client is `@aws-sdk/client-*` (kept external by the
// build, provided by the nodejs20 runtime), so it's imported dynamically here.

import Stripe from 'stripe';
import { PLANS } from '../../../shared/catalog.mjs';

const DAY = 86400000;
const REPORT_CCY = 'SGD';
// USD→SGD for the AWS + COGS cost side. Env-overridable so the rate can track
// reality without a code change; sensible default otherwise.
const USD_SGD = Number(process.env.USD_SGD_RATE) || 1.35;
// What one consumed credit actually costs us in vendor spend (USD). The catalog
// targets 1 credit ≈ US$0.01–0.015 underlying; midpoint default.
const COGS_USD_PER_CREDIT = Number(process.env.COGS_USD_PER_CREDIT) || 0.012;

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

  // Cost side, everything normalised to SGD.
  const awsSgd = aws.error ? 0 : round2(aws.usd * USD_SGD);
  const cogsUsd = round2((consumed.credits || 0) * COGS_USD_PER_CREDIT);
  const cogsSgd = round2(cogsUsd * USD_SGD);
  const totalCostSgd = round2(awsSgd + cogsSgd);

  const netRevenue = revenue.error ? 0 : revenue.net;
  const grossProfit = round2(netRevenue - totalCostSgd);
  const marginPct = netRevenue > 0 ? grossProfit / netRevenue : null;

  return {
    currency: REPORT_CCY,
    range: { from: from.toISOString(), to: to.toISOString() },
    fx: { usdSgd: USD_SGD, source: process.env.USD_SGD_RATE ? 'configured' : 'default' },
    revenue,
    mrr: monthlyRunRate(users),
    cost: {
      aws: aws.error
        ? { error: aws.error, sgd: 0 }
        : { usd: aws.usd, sgd: awsSgd, granularity: aws.granularity, byService: aws.byService, estimated: aws.estimated },
      cogs: {
        credits: consumed.credits || 0,
        usdPerCredit: COGS_USD_PER_CREDIT,
        usd: cogsUsd,
        sgd: cogsSgd,
        byTool: consumed.byTool || [],
        truncated: !!consumed.truncated,
        estimated: true,
      },
      totalSgd: totalCostSgd,
    },
    profit: { grossProfitSgd: grossProfit, marginPct },
  };
}

// ── Revenue (Stripe) ─────────────────────────────────────────────────────────
async function stripeRevenue(from, to) {
  if (!stripe) throw new Error('Stripe not configured (STRIPE_SECRET_KEY unset).');
  const gte = Math.floor(from.getTime() / 1000);
  const lte = Math.ceil(to.getTime() / 1000);

  // Subscriptions: paid invoices in the window (amount actually collected).
  let subsCents = 0, ccy = 'sgd', i = 0;
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
    currency: (ccy || 'sgd').toUpperCase(),
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

// ── AWS cost (Cost Explorer, all services) ───────────────────────────────────
async function awsCost(from, to) {
  const { CostExplorerClient, GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');
  const ce = new CostExplorerClient({ region: 'us-east-1' }); // CE is global, pinned to us-east-1
  const span = to - from;
  const granularity = span <= 40 * DAY ? 'DAILY' : 'MONTHLY';
  const res = await ce.send(new GetCostAndUsageCommand({
    // End date is EXCLUSIVE, so bump `to` a day to include it.
    TimePeriod: { Start: ymd(from), End: ymd(new Date(to.getTime() + DAY)) },
    Granularity: granularity,
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
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
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ymd = (d) => d.toISOString().slice(0, 10);
