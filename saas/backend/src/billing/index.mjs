// Stripe billing:
//   POST /billing/checkout   { tier, interval }  -> hosted Checkout URL  (authed)
//   POST /billing/portal                          -> Customer Portal URL  (authed)
//   POST /billing/webhook                         -> Stripe events        (PUBLIC, signed)
//
// The webhook is the source of truth for tier + credit grants. `invoice.paid`
// is the billing-cycle anchor that resets the monthly allowance — no cron.
import Stripe from 'stripe';
import {
  getUser, getUserByStripeCustomer, grantTopupCredits,
  claimStripeEvent, releaseStripeEvent,
  resetMonthlyAllowance, applyTierChange, applyDowngrade, linkStripeCustomer,
} from '../lib/dynamo.mjs';
import { PLANS, topupById } from '../../../shared/catalog.mjs';
import { ok, badRequest, unauthorized, json, parseBody, claims } from '../lib/http.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe Price IDs live in env so the same code works in test + live mode.
// Format: PRICE_<TIER>_<INTERVAL>, plus PRICE_TOPUP.
function priceId(tier, interval) {
  return process.env[`PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`];
}
function tierForPrice(id) {
  for (const tier of Object.keys(PLANS)) {
    for (const interval of ['MONTHLY', 'ANNUAL']) {
      if (process.env[`PRICE_${tier.toUpperCase()}_${interval}`] === id) return tier;
    }
  }
  return null;
}

export const handler = async (event) => {
  const path = event.rawPath || event.requestContext?.http?.path || '';
  if (path.endsWith('/webhook')) return handleWebhook(event);
  if (path.endsWith('/checkout')) return handleCheckout(event);
  if (path.endsWith('/topup')) return handleTopup(event);
  if (path.endsWith('/portal')) return handlePortal(event);
  if (path.endsWith('/invoices')) return handleInvoices(event);
  return badRequest('Unknown billing route');
};

// List the customer's billing documents: subscription invoices (with PDF +
// hosted page) and standalone top-up charges (with a receipt URL).
async function handleInvoices(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const user = await getUser(c.userId);
  if (!user?.stripeCustomerId) return ok({ documents: [] });
  const customer = user.stripeCustomerId;

  const [invoices, charges] = await Promise.all([
    stripe.invoices.list({ customer, limit: 24 }),
    stripe.charges.list({ customer, limit: 24 }),
  ]);

  const documents = [];
  for (const i of invoices.data) {
    documents.push({
      id: i.id, type: 'invoice', number: i.number,
      created: i.created, amount: i.amount_paid ?? i.total, currency: i.currency,
      status: i.status, pdf: i.invoice_pdf, url: i.hosted_invoice_url,
      description: i.lines?.data?.[0]?.description || 'Subscription',
    });
  }
  for (const ch of charges.data) {
    if (ch.invoice || ch.status !== 'succeeded') continue; // subscription charges already show as their invoice
    documents.push({
      id: ch.id, type: 'receipt',
      created: ch.created, amount: ch.amount, currency: ch.currency,
      status: ch.refunded ? 'refunded' : 'paid', url: ch.receipt_url,
      description: ch.description || 'Credit top-up',
    });
  }
  documents.sort((a, b) => b.created - a.created);
  return ok({ documents });
}

async function handleCheckout(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const { tier, interval = 'monthly' } = parseBody(event);
  const price = priceId(tier, interval);
  if (!price) return badRequest('Unknown tier/interval');

  const user = await getUser(c.userId);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    customer: user.stripeCustomerId || undefined,
    customer_email: user.stripeCustomerId ? undefined : user.email,
    client_reference_id: user.userId,
    subscription_data: { trial_period_days: tier === 'pro' ? 7 : undefined },
    success_url: `${process.env.APP_ORIGIN}/account?checkout=success`,
    cancel_url: `${process.env.APP_ORIGIN}/pricing?checkout=cancelled`,
    allow_promotion_codes: true,
  });
  return ok({ url: session.url });
}

// One-time credit top-up (overage). mode: 'payment', credits granted on webhook.
async function handleTopup(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const { packId } = parseBody(event);
  const pack = topupById(packId);
  if (!pack) return badRequest('Unknown top-up pack');
  const price = process.env[`PRICE_TOPUP_${packId.toUpperCase()}`];
  if (!price) return badRequest('Top-up price not configured');

  const user = await getUser(c.userId);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    customer: user.stripeCustomerId || undefined,
    customer_email: user.stripeCustomerId ? undefined : user.email,
    client_reference_id: user.userId,
    // Carried into checkout.session.completed so the webhook knows how many to grant.
    metadata: { type: 'topup', userId: user.userId, credits: String(pack.credits), packId },
    success_url: `${process.env.APP_ORIGIN}/account?topup=success`,
    cancel_url: `${process.env.APP_ORIGIN}/account?topup=cancelled`,
  });
  return ok({ url: session.url });
}

async function handlePortal(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const user = await getUser(c.userId);
  if (!user?.stripeCustomerId) return badRequest('No subscription yet');
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${process.env.APP_ORIGIN}/account`,
  });
  return ok({ url: session.url });
}

async function handleWebhook(event) {
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  let stripeEvent;
  try {
    // API Gateway may base64-encode the raw body; Stripe needs it verbatim.
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return json(400, { error: `Webhook signature failed: ${err.message}` });
  }

  // Idempotency: claim the event id once. A duplicate delivery (Stripe retries /
  // at-least-once) short-circuits so we never double-grant credits or re-reset.
  if (!(await claimStripeEvent(stripeEvent.id))) {
    return ok({ received: true, duplicate: true });
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await onCheckoutComplete(stripeEvent.data.object);
        break;
      case 'invoice.paid':
        await onInvoicePaid(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await onSubscriptionUpdated(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(stripeEvent.data.object);
        break;
      default:
        break; // ignore everything else
    }
  } catch (err) {
    // Processing failed after claiming — release the claim so Stripe's retry can
    // reprocess, and return 500 so Stripe knows to retry.
    await releaseStripeEvent(stripeEvent.id);
    console.error('stripe_webhook_failed', stripeEvent.type, stripeEvent.id, err.message);
    return json(500, { error: 'processing_failed' });
  }
  return ok({ received: true });
}

async function onCheckoutComplete(session) {
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) return;
  const user = await getUser(userId);
  if (!user) return;

  // Link the Stripe customer on first purchase (sub or top-up) — atomic set-once.
  if (!user.stripeCustomerId && session.customer) {
    await linkStripeCustomer(userId, session.customer);
  }

  // One-time top-up → grant rollover credits (event-level idempotency above
  // prevents a retried delivery from double-granting).
  if (session.metadata?.type === 'topup') {
    const amount = parseInt(session.metadata.credits, 10) || 0;
    if (amount > 0) {
      await grantTopupCredits({ userId, amount, action: 'topup_purchase', meta: { packId: session.metadata.packId } });
    }
  }
}

// Billing-cycle anchor: set tier + RESET the monthly credit allowance.
async function onInvoicePaid(invoice) {
  const user = await getUserByStripeCustomer(invoice.customer);
  if (!user) return;
  const price = invoice.lines?.data?.[0]?.price?.id;
  const tier = tierForPrice(price) || user.tier;
  const plan = PLANS[tier];
  const periodEnd = invoice.lines?.data?.[0]?.period?.end
    ? new Date(invoice.lines.data[0].period.end * 1000).toISOString()
    : null;
  // Atomic: touches only tier/credits/periodEnd — topupCredits and other fields
  // are preserved even if a tool run spends concurrently.
  await resetMonthlyAllowance({ userId: user.userId, tier, monthlyCredits: plan.monthlyCredits, periodEnd, previousCredits: user.credits || 0 });
}

async function onSubscriptionUpdated(sub) {
  const user = await getUserByStripeCustomer(sub.customer);
  if (!user) return;
  const price = sub.items?.data?.[0]?.price?.id;
  const tier = tierForPrice(price);
  if (tier && tier !== user.tier) {
    // Immediate tier change (proration handled by Stripe). On upgrade, top the
    // balance up to the new plan's allowance — atomic so a concurrent spend isn't
    // clobbered.
    await applyTierChange({ userId: user.userId, tier, monthlyCredits: PLANS[tier].monthlyCredits });
  }
}

async function onSubscriptionDeleted(sub) {
  const user = await getUserByStripeCustomer(sub.customer);
  if (!user) return;
  await applyDowngrade({ userId: user.userId, monthlyCredits: PLANS.free.monthlyCredits });
}
