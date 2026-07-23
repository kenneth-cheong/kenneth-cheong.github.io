// Promo codes — Stripe is the source of truth, not a table of ours.
//
// A "promo code" here is really a PAIR of Stripe objects: a `coupon` (the
// discount itself — 20% off, for 3 months, on these products) and a
// `promotion_code` (the customer-facing string, plus its redemption limits).
// The admin UI presents them as one row; this module is the seam that keeps
// that fiction honest.
//
// Why Stripe rather than our own discount table: the discount then lands on the
// invoice, so Admin → Finances and every revenue figure downstream stay true
// for free. A homegrown ledger would have to reconcile against Stripe forever,
// and would drift the first time someone redeemed a code in the dashboard.
//
// The one wart to know: coupons are IMMUTABLE. You can rename one, you cannot
// turn 20% into 30%. `updatePromo` therefore only touches what Stripe actually
// lets us touch (active, code metadata); changing the money means archiving and
// creating a new one, and the UI says so.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Stripe accepts a wider character set, but a code people have to type off a
// newsletter or a slide should be unambiguous and case-flattened.
export const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;

export const DURATIONS = ['once', 'repeating', 'forever'];
export const SCOPES = ['all', 'plans', 'topups'];

// ── Product scoping ──────────────────────────────────────────────────────────
// Prices live in env (PRICE_<TIER>_<INTERVAL>, PRICE_TOPUP_<PACK>); coupons scope
// by PRODUCT. Resolve one from the other, and cache — the set only changes on a
// redeploy, and a warm Lambda would otherwise re-ask Stripe on every list call.
let productCache = null;

async function productIds() {
  if (productCache) return productCache;
  const plans = [], topups = [];
  const entries = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('PRICE_') && v);
  const resolved = await Promise.all(entries.map(async ([k, v]) => {
    try {
      const price = await stripe.prices.retrieve(v);
      return [k, typeof price.product === 'string' ? price.product : price.product?.id];
    } catch {
      // A stale env price id must not take the whole promo screen down.
      return [k, null];
    }
  }));
  for (const [k, product] of resolved) {
    if (!product) continue;
    const bucket = k.startsWith('PRICE_TOPUP') ? topups : plans;
    if (!bucket.includes(product)) bucket.push(product);
  }
  productCache = { plans, topups };
  return productCache;
}

async function productsForScope(scope) {
  if (scope === 'all') return null;              // no applies_to → everything
  const { plans, topups } = await productIds();
  const products = scope === 'topups' ? topups : plans;
  if (!products.length) throw new Error(`No ${scope} products configured — check the PRICE_* env vars.`);
  return products;
}

// The inverse, for display: which bucket does this coupon's applies_to match?
async function scopeOf(coupon) {
  const applies = coupon?.applies_to?.products;
  if (!applies?.length) return 'all';
  const { plans, topups } = await productIds();
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  if (same(applies, plans)) return 'plans';
  if (same(applies, topups)) return 'topups';
  return 'custom';                               // hand-made in the dashboard
}

// Does this promo apply to the thing being bought? Checkout enforces applies_to
// itself, but the in-place plan switch attaches the discount over the API, where
// nothing would stop a top-ups-only code landing on a subscription.
export function appliesToProduct(coupon, productId) {
  const applies = coupon?.applies_to?.products;
  return !applies?.length || applies.includes(productId);
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function normalizePromo(pc, scope = 'all') {
  const c = pc.coupon || {};
  return {
    id: pc.id,
    couponId: c.id,
    code: pc.code,
    active: pc.active,
    name: c.name || '',
    percentOff: c.percent_off ?? null,
    amountOff: c.amount_off ?? null,          // minor units
    currency: (c.currency || '').toUpperCase() || null,
    duration: c.duration,
    durationInMonths: c.duration_in_months ?? null,
    scope,
    maxRedemptions: pc.max_redemptions ?? null,
    timesRedeemed: pc.times_redeemed ?? 0,
    expiresAt: pc.expires_at ?? null,
    firstTimeOnly: !!pc.restrictions?.first_time_transaction,
    minimumAmount: pc.restrictions?.minimum_amount ?? null,
    created: pc.created,
  };
}

export async function listPromos({ limit = 100 } = {}) {
  const res = await stripe.promotionCodes.list({ limit });
  // scopeOf hits the (cached) product map; resolve it once up front so the map
  // is warm and the per-row calls are pure.
  await productIds();
  return Promise.all(res.data.map(async (pc) => normalizePromo(pc, await scopeOf(pc.coupon))));
}

// Look up a customer-typed code. Stripe's `code` filter is exact and
// case-sensitive, hence the upcase — our create path only ever writes uppercase.
export async function findPromoByCode(code) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const res = await stripe.promotionCodes.list({ code: wanted, active: true, limit: 1 });
  return res.data[0] || null;
}

// Everything Stripe would enforce at Checkout, enforced here too, because the
// plan-switch path never goes near Checkout. Returns null when fine, else a
// human-readable reason.
export function promoProblem(pc, { isExistingCustomer = false, amount = null } = {}) {
  if (!pc || !pc.active) return 'That code isn’t valid.';
  if (!pc.coupon?.valid) return 'That code has expired.';
  if (pc.expires_at && pc.expires_at * 1000 < Date.now()) return 'That code has expired.';
  if (pc.max_redemptions != null && pc.times_redeemed >= pc.max_redemptions) {
    return 'That code has been fully redeemed.';
  }
  if (pc.restrictions?.first_time_transaction && isExistingCustomer) {
    return 'That code is for first-time customers only.';
  }
  const min = pc.restrictions?.minimum_amount;
  if (min != null && amount != null && amount < min) {
    return 'Your order is below this code’s minimum spend.';
  }
  return null;
}

// ── Write ────────────────────────────────────────────────────────────────────

export async function createPromo(input) {
  const code = String(input.code || '').trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    throw new Error('Code must be 3–40 characters: A–Z, 0–9, hyphen or underscore.');
  }
  const percentOff = input.percentOff == null || input.percentOff === '' ? null : Number(input.percentOff);
  const amountOff = input.amountOff == null || input.amountOff === '' ? null : Math.round(Number(input.amountOff));
  if ((percentOff == null) === (amountOff == null)) {
    throw new Error('Set either a percentage or a fixed amount off, not both.');
  }
  if (percentOff != null && !(percentOff > 0 && percentOff <= 100)) {
    throw new Error('Percentage off must be between 1 and 100.');
  }
  if (amountOff != null && !(amountOff > 0)) throw new Error('Amount off must be greater than zero.');

  const duration = DURATIONS.includes(input.duration) ? input.duration : 'once';
  const durationInMonths = duration === 'repeating' ? Number(input.durationInMonths) : null;
  if (duration === 'repeating' && !(durationInMonths >= 1)) {
    throw new Error('A repeating code needs a number of months.');
  }
  const scope = SCOPES.includes(input.scope) ? input.scope : 'all';

  const currency = (input.currency || process.env.BILLING_CURRENCY || 'usd').toLowerCase();
  const products = await productsForScope(scope);

  const coupon = await stripe.coupons.create({
    ...(percentOff != null ? { percent_off: percentOff } : { amount_off: amountOff, currency }),
    duration,
    ...(durationInMonths ? { duration_in_months: durationInMonths } : {}),
    name: (input.name || code).slice(0, 40),
    ...(products ? { applies_to: { products } } : {}),
    metadata: { createdBy: input.createdBy || '', scope },
  });

  const restrictions = {};
  if (input.firstTimeOnly) restrictions.first_time_transaction = true;
  if (input.minimumAmount) {
    restrictions.minimum_amount = Math.round(Number(input.minimumAmount));
    restrictions.minimum_amount_currency = currency;
  }

  let pc;
  try {
    pc = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code,
      active: input.active !== false,
      ...(input.maxRedemptions ? { max_redemptions: Math.round(Number(input.maxRedemptions)) } : {}),
      ...(input.expiresAt ? { expires_at: Math.round(Number(input.expiresAt)) } : {}),
      ...(Object.keys(restrictions).length ? { restrictions } : {}),
      metadata: { createdBy: input.createdBy || '' },
    });
  } catch (e) {
    // The coupon is already live at this point. Leaving it behind on a duplicate
    // code would silently litter the account with orphans nobody can see.
    await stripe.coupons.del(coupon.id).catch(() => {});
    throw e;
  }
  return normalizePromo({ ...pc, coupon }, scope);
}

// Stripe only lets a promotion code's `active` flag and metadata change after
// creation — the discount, limits and restrictions are frozen. Anything else is
// an archive-and-recreate, which the UI drives explicitly.
export async function updatePromo(id, { active }) {
  const pc = await stripe.promotionCodes.update(id, { active: !!active });
  return normalizePromo(pc, await scopeOf(pc.coupon));
}

// Archive, never delete. Deleting the coupon would strip the discount from every
// subscription currently riding on it — retroactively raising the price of
// people who already bought. Deactivating just stops NEW redemptions.
export async function archivePromo(id) {
  return updatePromo(id, { active: false });
}

export const __test = { productIds, scopeOf };
