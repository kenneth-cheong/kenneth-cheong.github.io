// Stripe billing:
//   POST /billing/checkout   { tier, interval, promoCode? } -> Checkout URL (authed)
//   POST /billing/portal                          -> Customer Portal URL  (authed)
//   POST /billing/payment-method                  -> SETUP Checkout URL   (authed)
//   POST /billing/promo/validate { code, tier?, interval? } -> price preview (authed)
//   POST /billing/subscription/change { tier, interval, promoCode? } -> switch in place
//   POST /billing/subscription/cancel { atPeriodEnd }    -> cancel         (authed)
//   GET  /billing/invoices                        -> invoices + receipts  (authed)
//   POST /billing/webhook                         -> Stripe events        (PUBLIC, signed)
//
// The webhook is the source of truth for tier + credit grants. `invoice.paid`
// is the billing-cycle anchor that resets the monthly allowance — no cron.
import Stripe from 'stripe';
import {
  getUser, getUserByStripeCustomer, grantTopupCredits,
  claimStripeEvent, releaseStripeEvent,
  resetMonthlyAllowance, applyTierChange, applyDowngrade, linkStripeCustomer,
  setPastDue, debitTopupCredits, unlinkStripeCustomer,
} from '../lib/dynamo.mjs';
import { PLANS, topupById } from '../../../shared/catalog.mjs';
import { findPromoByCode, promoProblem, appliesToProduct, normalizePromo, hydrateCoupon } from '../lib/promos.mjs';
import { ok, badRequest, unauthorized, tooManyRequests, json, parseBody, claims } from '../lib/http.mjs';
import { rateLimit } from '../lib/ratelimit.mjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Per-user budget for the Stripe-session-creating routes (checkout/topup/portal)
// so a client can't spam Stripe API calls. Generous — never bothers real users.
const BILLING_LIMITS = [{ n: 15, seconds: 60 }, { n: 80, seconds: 3600 }];
async function billingThrottle(userId) {
  const rl = await rateLimit('billing', userId, BILLING_LIMITS);
  return rl.allowed ? null : tooManyRequests(rl.retryAfter);
}

// A stored customer id Stripe doesn't recognise. Customer ids are per-account,
// so moving to a different Stripe account strands every id we hold: the first
// use returns resource_missing and the route 500s (this took out the billing
// portal after the Apsolute.ai migration). Detect it, drop the dead id, and let
// the caller recover — a checkout simply creates a new customer from the email.
function isMissingCustomer(err) {
  return err?.code === 'resource_missing'
    && (err?.param === 'customer' || /No such customer/i.test(err?.message || ''));
}

// Create a Checkout Session, surviving a stranded customer id. Losing a sale to
// a stale id is the worst outcome here, so on resource_missing we drop the dead
// id and retry keyed on the email — Stripe then creates a fresh customer.
async function createCheckoutSession(user, params) {
  try {
    return await stripe.checkout.sessions.create({
      ...params,
      customer: user.stripeCustomerId || undefined,
      customer_email: user.stripeCustomerId ? undefined : user.email,
    });
  } catch (e) {
    if (!isMissingCustomer(e) || !user.stripeCustomerId) throw e;
    await unlinkStripeCustomer(user.userId, user.stripeCustomerId);
    return stripe.checkout.sessions.create({
      ...params,
      customer: undefined,
      customer_email: user.email,
    });
  }
}

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

// ── Promo codes ──────────────────────────────────────────────────────────────
// Checkout has its own code field (allow_promotion_codes), but two of our three
// paid surfaces don't go through it in a way the user can type into: the
// in-place plan switch never opens Checkout at all, and a code entered on our
// own pricing page should be validated before we bounce anyone to Stripe. Both
// funnel through here.
//
// Resolve a typed code against the price being bought. Returns { pc } on
// success or { error } with a message meant for the buyer's eyes.
async function resolvePromo(code, priceId, user) {
  const pc = await findPromoByCode(code);
  if (!pc) return { error: 'That code isn’t valid.' };

  let price = null;
  try { price = await stripe.prices.retrieve(priceId); } catch { /* fall through unscoped */ }
  const productId = typeof price?.product === 'string' ? price.product : price?.product?.id;
  // hydrateCoupon, not pc.coupon: the coupon nested in a promotion_code lookup
  // omits applies_to entirely, so a scoped code would read as unrestricted and
  // a top-ups-only discount would land on a subscription.
  const coupon = await hydrateCoupon(pc.coupon);
  if (productId && !appliesToProduct(coupon, productId)) {
    return { error: 'That code doesn’t apply to this plan.' };
  }

  // "First-time customer" is the one restriction Stripe can't check for us
  // outside Checkout — anyone with a Stripe customer id has already transacted.
  const problem = promoProblem(pc, {
    isExistingCustomer: !!user?.stripeCustomerId,
    amount: price?.unit_amount ?? null,
  });
  return problem ? { error: problem } : { pc, price };
}

// Price preview for the code box on /pricing — tells the user what they'll
// actually pay before they commit to a redirect or a plan switch.
async function handlePromoValidate(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const throttled = await billingThrottle(c.userId); if (throttled) return throttled;
  const { code, tier, interval = 'monthly' } = parseBody(event);
  const price = tier ? priceId(tier, interval) : null;
  if (tier && !price) return badRequest('Unknown tier/interval');

  const user = await getUser(c.userId);
  const { pc, price: priceObj, error } = await resolvePromo(code, price, user);
  if (error) return ok({ valid: false, error });

  const promo = normalizePromo(pc);
  const base = priceObj?.unit_amount ?? null;
  return ok({
    valid: true,
    code: promo.code,
    percentOff: promo.percentOff,
    amountOff: promo.amountOff,
    duration: promo.duration,
    durationInMonths: promo.durationInMonths,
    // Minor units, matching Stripe. null when we weren't asked about a
    // specific plan (the code box on a page with no selection yet).
    amountDue: base == null ? null : Math.max(0, promo.percentOff != null
      ? Math.round(base * (1 - promo.percentOff / 100))
      : base - (promo.amountOff || 0)),
    baseAmount: base,
  });
}

export const handler = async (event) => {
  const path = event.rawPath || event.requestContext?.http?.path || '';
  if (path.endsWith('/webhook')) return handleWebhook(event);
  if (path.endsWith('/checkout')) return handleCheckout(event);
  if (path.endsWith('/topup')) return handleTopup(event);
  if (path.endsWith('/promo/validate')) return handlePromoValidate(event);
  if (path.endsWith('/portal')) return handlePortal(event);
  if (path.endsWith('/invoices')) return handleInvoices(event);
  if (path.endsWith('/payment-method')) return handlePaymentMethod(event);
  if (path.endsWith('/subscription/change')) return handleSubscriptionChange(event);
  if (path.endsWith('/subscription/cancel')) return handleSubscriptionCancel(event);
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

  let invoices, charges;
  try {
    [invoices, charges] = await Promise.all([
      stripe.invoices.list({ customer, limit: 24 }),
      stripe.charges.list({ customer, limit: 24 }),
    ]);
  } catch (e) {
    if (!isMissingCustomer(e)) throw e;
    await unlinkStripeCustomer(user.userId, customer);
    return ok({ documents: [] });
  }

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
  const throttled = await billingThrottle(c.userId); if (throttled) return throttled;
  const { tier, interval = 'monthly', promoCode } = parseBody(event);
  const price = priceId(tier, interval);
  if (!price) return badRequest('Unknown tier/interval');

  const user = await getUser(c.userId);

  // A code typed on our pricing page is pre-applied so the buyer sees the
  // discounted total on Stripe's page rather than having to retype it there.
  // Stripe rejects `discounts` and `allow_promotion_codes` together, so it's
  // one or the other: pre-applied when they brought a code, the Stripe-hosted
  // field when they didn't.
  let discounts;
  if (promoCode) {
    const { pc, error } = await resolvePromo(promoCode, price, user);
    if (error) return badRequest(error);
    discounts = [{ promotion_code: pc.id }];
  }

  const session = await createCheckoutSession(user, {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.userId,
    subscription_data: { trial_period_days: tier === 'pro' ? 7 : undefined },
    success_url: `${process.env.APP_ORIGIN}/account?checkout=success`,
    cancel_url: `${process.env.APP_ORIGIN}/pricing?checkout=cancelled`,
    ...(discounts ? { discounts } : { allow_promotion_codes: true }),
  });
  return ok({ url: session.url });
}

// One-time credit top-up (overage). mode: 'payment', credits granted on webhook.
async function handleTopup(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const throttled = await billingThrottle(c.userId); if (throttled) return throttled;
  const { packId } = parseBody(event);
  const pack = topupById(packId);
  if (!pack) return badRequest('Unknown top-up pack');
  const price = process.env[`PRICE_TOPUP_${packId.toUpperCase()}`];
  if (!price) return badRequest('Top-up price not configured');

  const user = await getUser(c.userId);
  const session = await createCheckoutSession(user, {
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.userId,
    // Carried into checkout.session.completed so the webhook knows how many to grant.
    metadata: { type: 'topup', userId: user.userId, credits: String(pack.credits), packId },
    success_url: `${process.env.APP_ORIGIN}/account?topup=success`,
    cancel_url: `${process.env.APP_ORIGIN}/account?topup=cancelled`,
    // Credit packs are a purchase like any other — without this there is no code
    // field at all on the top-up checkout, so a codes-and-all promotion silently
    // excludes them. The webhook grants credits off `metadata`, not the amount
    // paid, so a discount never changes how many credits land.
    allow_promotion_codes: true,
  });
  return ok({ url: session.url });
}

async function handlePortal(event) {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const throttled = await billingThrottle(c.userId); if (throttled) return throttled;
  const user = await getUser(c.userId);
  if (!user?.stripeCustomerId) return badRequest('No subscription yet');
  let session;
  try {
    session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.APP_ORIGIN}/account`,
    });
  } catch (e) {
    if (!isMissingCustomer(e)) throw e;
    // The customer is gone on Stripe's side, so there is genuinely nothing to
    // manage. Clear it so the next checkout starts clean.
    await unlinkStripeCustomer(user.userId, user.stripeCustomerId);
    return badRequest('No subscription yet');
  }
  return ok({ url: session.url });
}

// ── Manage-billing routes ────────────────────────────────────────────────────
// The Account page manages a subscription in place rather than bouncing the user
// to Stripe's hosted portal: update card, switch plan, cancel. handlePortal above
// stays as the escape hatch (and is what a card-on-file dispute needs), but these
// three are what the UI actually calls.

// The customer's live subscription, or null. We don't store a subscription id —
// the webhook keys everything off the customer — so we ask Stripe. 'all' minus
// the dead states, because a past_due or trialing subscription is still theirs
// to change or cancel.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid']);
async function activeSubscription(customer) {
  const subs = await stripe.subscriptions.list({ customer, status: 'all', limit: 10 });
  return subs.data.find((s) => LIVE_STATUSES.has(s.status)) || null;
}

// Resolve the caller to a user with a usable Stripe customer, or the error
// response to return. Every route below opens with this.
async function billingCaller(event) {
  const c = claims(event);
  if (!c?.userId) return { err: unauthorized() };
  const throttled = await billingThrottle(c.userId);
  if (throttled) return { err: throttled };
  const user = await getUser(c.userId);
  if (!user?.stripeCustomerId) return { err: badRequest('No subscription yet') };
  return { user };
}

// A stranded customer id means there is nothing left to manage on Stripe's side.
// Drop it (so the next checkout starts clean) and tell the caller plainly.
async function forgetStrandedCustomer(user, e) {
  if (!isMissingCustomer(e)) throw e;
  await unlinkStripeCustomer(user.userId, user.stripeCustomerId);
  return badRequest('No subscription yet');
}

// Update the card on file. Stripe has no "edit payment method" API — the
// supported flow is a SETUP-mode Checkout, which collects a card against the
// existing customer and makes it the default for future invoices.
async function handlePaymentMethod(event) {
  const { user, err } = await billingCaller(event);
  if (err) return err;
  try {
    const sub = await activeSubscription(user.stripeCustomerId);
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: user.stripeCustomerId,
      client_reference_id: user.userId,
      // Setup mode ATTACHES the card to the customer but does not make it the
      // default — without the webhook half below, the subscription would happily
      // keep charging the old card. `subscriptionId` tells that half what to
      // repoint; `type` is what makes it look.
      metadata: { type: 'card', userId: user.userId, subscriptionId: sub?.id || '' },
      success_url: `${process.env.APP_ORIGIN}/account?card=updated`,
      cancel_url: `${process.env.APP_ORIGIN}/account`,
    });
    return ok({ url: session.url });
  } catch (e) {
    return forgetStrandedCustomer(user, e);
  }
}

// Switch an existing subscription to another plan/interval in place. Sending a
// subscriber back through Checkout would open a SECOND subscription and bill
// them twice, which is why Pricing.jsx routes here once hasSubscription is set.
//
// We only move the price. The tier itself is applied by the
// customer.subscription.updated webhook, so the grant path stays single-sourced
// whether the change came from here, the portal, or Stripe's dashboard.
async function handleSubscriptionChange(event) {
  const { user, err } = await billingCaller(event);
  if (err) return err;
  const { tier, interval = 'monthly', promoCode } = parseBody(event);
  // Downgrading to free is a cancellation, not a price swap — there is no free
  // price to move to.
  if (tier === 'free') return badRequest('To move to Free, cancel your subscription.');
  const price = priceId(tier, interval);
  if (!price) return badRequest('Unknown tier/interval');

  // This path never opens Checkout, so a subscriber taking an upgrade offer had
  // no way to redeem a code at all — the people most likely to use one.
  // Validated here rather than trusted to Stripe: attaching over the API skips
  // the restriction checks Checkout would have run.
  let discounts;
  if (promoCode) {
    const { pc, error } = await resolvePromo(promoCode, price, user);
    if (error) return badRequest(error);
    discounts = [{ promotion_code: pc.id }];
  }

  try {
    const sub = await activeSubscription(user.stripeCustomerId);
    if (!sub) return badRequest('No active subscription to change.');
    const item = sub.items?.data?.[0];
    if (!item) return badRequest('No active subscription to change.');
    if (item.price?.id === price && !discounts) return ok({ changed: false, tier });

    await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price }],
      // Bill the difference now rather than silently swallowing it.
      proration_behavior: 'create_prorations',
      // A pending cancellation would otherwise survive the switch and cut them
      // off at period end on a plan they just paid to change to.
      cancel_at_period_end: false,
      // Omitted entirely when there's no code: sending `discounts: []` would
      // strip a discount they already have.
      ...(discounts ? { discounts } : {}),
    });
    return ok({ changed: true, tier, discounted: !!discounts });
  } catch (e) {
    return forgetStrandedCustomer(user, e);
  }
}

// Cancel. Default is at period end — they keep what they already paid for, and
// the downgrade lands via customer.subscription.deleted when the period closes.
async function handleSubscriptionCancel(event) {
  const { user, err } = await billingCaller(event);
  if (err) return err;
  const { atPeriodEnd = true } = parseBody(event);

  try {
    const sub = await activeSubscription(user.stripeCustomerId);
    if (!sub) return badRequest('No active subscription to cancel.');
    if (atPeriodEnd) {
      const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
      return ok({ cancelled: true, atPeriodEnd: true, endsAt: updated.current_period_end });
    }
    await stripe.subscriptions.cancel(sub.id);
    return ok({ cancelled: true, atPeriodEnd: false });
  } catch (e) {
    return forgetStrandedCustomer(user, e);
  }
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
      case 'invoice.payment_failed':
        await onPaymentFailed(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await onSubscriptionUpdated(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await onSubscriptionDeleted(stripeEvent.data.object);
        break;
      case 'charge.refunded':
        await onChargeRefunded(stripeEvent.data.object);
        break;
      case 'charge.dispute.created':
        // Surface for manual review; alarms pick up the error-log line.
        console.error('stripe_dispute_created', stripeEvent.data.object?.id, stripeEvent.data.object?.amount);
        break;
      default:
        break; // ignore everything else
    }
  } catch (err) {
    // Processing failed after claiming — release the claim so Stripe's retry can
    // reprocess, then re-throw so the invocation registers as a Lambda error
    // (BillingFn errors alarm) and API Gateway returns 5xx → Stripe retries.
    await releaseStripeEvent(stripeEvent.id);
    console.error('stripe_webhook_failed', stripeEvent.type, stripeEvent.id, err.message);
    throw err;
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

  // Card update (SETUP mode) → promote the new card to the default, both for
  // future invoices and on the live subscription. Attaching it is all Checkout
  // does; without this the customer sees a new card on file and keeps being
  // charged on the old one.
  if (session.metadata?.type === 'card') {
    await promoteNewCard(session);
    return;
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
  // Only the cycle-anchoring invoices reset the allowance. Proration / one-off
  // invoices (billing_reason 'subscription_update', 'manual', etc.) must NOT
  // wipe a user's mid-cycle balance back to full.
  const reason = invoice.billing_reason;
  if (reason && reason !== 'subscription_create' && reason !== 'subscription_cycle') return;
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

// Make the card just collected in SETUP mode the one we actually charge. The
// subscription carries its own default_payment_method which overrides the
// customer's, so repointing only the customer would leave the live subscription
// on the old card — the exact failure the user came here to fix.
async function promoteNewCard(session) {
  const setupIntentId = session.setup_intent;
  if (!setupIntentId) return;
  const intent = await stripe.setupIntents.retrieve(setupIntentId);
  const pm = intent?.payment_method;
  if (!pm) return;

  await stripe.customers.update(session.customer, {
    invoice_settings: { default_payment_method: pm },
  });

  // Re-read rather than trusting the id we stashed at session-create time: the
  // user may have cancelled or switched in the meantime.
  const sub = await activeSubscription(session.customer);
  if (sub) await stripe.subscriptions.update(sub.id, { default_payment_method: pm });
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

// Failed renewal/charge → flag the account past-due (keeps tier for now so Stripe
// dunning can recover; subscription.deleted handles eventual cancel).
async function onPaymentFailed(invoice) {
  const user = await getUserByStripeCustomer(invoice.customer);
  if (!user) return;
  await setPastDue(user.userId, true);
  console.error('stripe_payment_failed', user.userId, invoice.id);
}

// Refunded charge → claw back any top-up credits that charge granted. We map the
// refunded charge back to its Checkout Session (which carries the credit amount).
async function onChargeRefunded(charge) {
  if (!charge.payment_intent) return;
  let credits = 0, userId = null;
  try {
    const sessions = await stripe.checkout.sessions.list({ payment_intent: charge.payment_intent, limit: 1 });
    const session = sessions.data?.[0];
    if (session?.metadata?.type === 'topup') {
      credits = parseInt(session.metadata.credits, 10) || 0;
      userId = session.client_reference_id || session.metadata.userId || null;
    }
  } catch (e) { console.error('refund_session_lookup', charge.id, e.message); }
  if (userId && credits > 0) {
    await debitTopupCredits({ userId, amount: credits, action: 'topup_refund', meta: { chargeId: charge.id } });
  }
}

// Exported for unit tests only.
export const __test = {
  isMissingCustomer, activeSubscription, promoteNewCard,
  handlePaymentMethod, handleSubscriptionChange, handleSubscriptionCancel,
  handleCheckout, handleTopup, handlePromoValidate, resolvePromo,
};
