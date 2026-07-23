import { describe, it, expect, vi, beforeEach } from 'vitest';

// Promo codes. Two things are worth locking down here:
//
//  1. The restrictions Stripe enforces at Checkout but NOT when a discount is
//     attached over the API — which is exactly what the in-place plan switch
//     does. A first-time-only code landing on a five-month subscriber is a real
//     revenue leak, not a cosmetic bug.
//  2. Checkout mustn't send `discounts` and `allow_promotion_codes` together
//     (Stripe rejects the session outright, so the buy button just breaks).

const calls = [];
let promotionCodes = [];
let priceProduct = { price_pro_m: 'prod_plan', price_expert_m: 'prod_plan_x', price_topup_s: 'prod_topup' };
let subscriptions = [];
let codeTaken = false;
// Keyed by coupon id — what a direct coupons.retrieve would return.
let couponRestrictions = {};

vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.promotionCodes = {
        list: async (args) => {
          calls.push(['promotionCodes.list', args]);
          return { data: promotionCodes.filter((p) => !args.code || p.code === args.code) };
        },
        create: async (args) => {
          calls.push(['promotionCodes.create', args]);
          if (codeTaken) throw new Error('A promotion code with that code already exists.');
          return { id: 'promo_1', ...args, times_redeemed: 0 };
        },
        update: async (id, args) => { calls.push(['promotionCodes.update', id, args]); return { id, code: 'X', coupon: {}, ...args }; },
      };
      this.coupons = {
        create: async (args) => { calls.push(['coupons.create', args]); return { id: 'coupon_1', ...args }; },
        del: async (id) => { calls.push(['coupons.del', id]); return { id, deleted: true }; },
        // applies_to comes back ONLY when explicitly expanded — that is the
        // whole reason hydrateCoupon exists, so the double enforces it: ask
        // without the expand and you get a coupon that looks unrestricted.
        retrieve: async (id, opts) => {
          calls.push(['coupons.retrieve', id, opts]);
          const expanded = opts?.expand?.includes('applies_to');
          return { id, ...(expanded ? (couponRestrictions[id] || {}) : {}) };
        },
      };
      this.prices = {
        retrieve: async (id) => {
          calls.push(['prices.retrieve', id]);
          return { id, unit_amount: 4900, product: priceProduct[id] || 'prod_other' };
        },
      };
      this.checkout = { sessions: { create: async (args) => { calls.push(['checkout.create', args]); return { url: 'https://stripe.test/s' }; } } };
      this.subscriptions = {
        list: async () => ({ data: subscriptions }),
        update: async (id, args) => { calls.push(['subscriptions.update', id, args]); return { id, ...args }; },
      };
    }
  },
}));

let user = null;
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  getUserByStripeCustomer: async () => user,
  unlinkStripeCustomer: async () => {}, grantTopupCredits: async () => {},
  claimStripeEvent: async () => true, releaseStripeEvent: async () => {},
  resetMonthlyAllowance: async () => {}, applyTierChange: async () => {},
  applyDowngrade: async () => {}, linkStripeCustomer: async () => {},
  setPastDue: async () => {}, debitTopupCredits: async () => {},
  addLifetimePaid: async () => {}, refundDeltaCents: async (_id, c) => c,
}));
vi.mock('../src/lib/ratelimit.mjs', () => ({ rateLimit: async () => ({ allowed: true }) }));

process.env.APP_ORIGIN = 'https://platform.digimetrics.ai';
process.env.PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.PRICE_EXPERT_MONTHLY = 'price_expert_m';
process.env.PRICE_TOPUP_TOPUP_S = 'price_topup_s';

const { __test } = await import('../src/billing/index.mjs');
const { createPromo, promoProblem, appliesToProduct } = await import('../src/lib/promos.mjs');

const ev = (body = {}) => ({
  requestContext: { authorizer: { lambda: { userId: 'u1' } } },
  body: JSON.stringify(body),
});
const bodyOf = (res) => JSON.parse(res.body);
const find = (name) => calls.find((c) => c[0] === name);
const promo = (over = {}) => ({
  id: 'promo_1', code: 'LAUNCH20', active: true, times_redeemed: 0,
  max_redemptions: null, expires_at: null, restrictions: {},
  coupon: { id: 'c_1', percent_off: 20, duration: 'once', valid: true },
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  couponRestrictions = {};
  user = { userId: 'u1', email: 'a@b.co', tier: 'pro', stripeCustomerId: null };
  promotionCodes = [promo()];
  subscriptions = [{ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1', price: { id: 'price_pro_m' } }] } }];
});

describe('promoProblem', () => {
  it('rejects an exhausted code', () => {
    expect(promoProblem(promo({ max_redemptions: 5, times_redeemed: 5 }))).toMatch(/fully redeemed/);
    expect(promoProblem(promo({ max_redemptions: 5, times_redeemed: 4 }))).toBeNull();
  });

  it('rejects an expired one, by either flag', () => {
    expect(promoProblem(promo({ expires_at: 1 }))).toMatch(/expired/);
    expect(promoProblem(promo({ coupon: { valid: false } }))).toMatch(/expired/);
  });

  it('holds first-time-only against anyone who has already paid us', () => {
    const p = promo({ restrictions: { first_time_transaction: true } });
    expect(promoProblem(p, { isExistingCustomer: true })).toMatch(/first-time/);
    expect(promoProblem(p, { isExistingCustomer: false })).toBeNull();
  });

  it('enforces the minimum spend', () => {
    const p = promo({ restrictions: { minimum_amount: 5000 } });
    expect(promoProblem(p, { amount: 4900 })).toMatch(/minimum spend/);
    expect(promoProblem(p, { amount: 5000 })).toBeNull();
  });
});

describe('appliesToProduct', () => {
  it('lets an unscoped coupon through and gates a scoped one', () => {
    expect(appliesToProduct({}, 'prod_plan')).toBe(true);
    expect(appliesToProduct({ applies_to: { products: ['prod_topup'] } }, 'prod_plan')).toBe(false);
    expect(appliesToProduct({ applies_to: { products: ['prod_plan'] } }, 'prod_plan')).toBe(true);
  });
});

describe('POST /billing/checkout with a code', () => {
  it('pre-applies the code and drops the Stripe-hosted field', async () => {
    // Sending both is a hard Stripe error — the buy button would just 500.
    const res = await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'launch20' }));
    expect(res.statusCode).toBe(200);
    const [, args] = find('checkout.create');
    expect(args.discounts).toEqual([{ promotion_code: 'promo_1' }]);
    expect(args.allow_promotion_codes).toBeUndefined();
  });

  it('keeps the hosted field when no code was typed', async () => {
    await __test.handleCheckout(ev({ tier: 'pro' }));
    const [, args] = find('checkout.create');
    expect(args.allow_promotion_codes).toBe(true);
    expect(args.discounts).toBeUndefined();
  });

  it('400s a bad code rather than quietly charging full price', async () => {
    promotionCodes = [];
    const res = await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'NOPE' }));
    expect(res.statusCode).toBe(400);
    expect(find('checkout.create')).toBeUndefined();
  });

  it('refuses a top-ups-only code on a plan', async () => {
    promotionCodes = [promo({ coupon: { id: 'c_1', percent_off: 20, valid: true, applies_to: { products: ['prod_topup'] } } })];
    const res = await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'LAUNCH20' }));
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error).toMatch(/doesn’t apply/);
  });

  it('refuses it even when the lookup hid the restriction', async () => {
    // The real failure: promotionCodes.list returns the coupon WITHOUT
    // applies_to, so the scoped code reads as unrestricted and a top-ups-only
    // discount silently lands on a subscription. Only a direct coupon read
    // knows better.
    // `applies_to: null` — how Stripe actually reports it on a nested coupon,
    // scoped or not. Indistinguishable from "no restriction" without asking.
    promotionCodes = [promo({ coupon: { id: 'c_scoped', percent_off: 20, valid: true, applies_to: null } })];
    couponRestrictions = { c_scoped: { percent_off: 20, valid: true, applies_to: { products: ['prod_topup'] } } };
    const res = await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'LAUNCH20' }));
    expect(find('coupons.retrieve')).toBeDefined();
    expect(res.statusCode).toBe(400);
    expect(bodyOf(res).error).toMatch(/doesn’t apply/);
  });
});

describe('a free trial carried on the code', () => {
  it('is the ONLY way a checkout gets a trial', async () => {
    // Pro used to get a hardcoded 7 days that nothing advertised and nobody
    // could switch off. No code → no trial, whatever the tier.
    for (const tier of ['pro', 'expert']) {
      calls.length = 0;
      await __test.handleCheckout(ev({ tier }));
      expect(find('checkout.create')[1].subscription_data.trial_period_days).toBeUndefined();
    }
  });

  it('passes the code’s trial days to Checkout', async () => {
    promotionCodes = [promo({ metadata: { trialDays: '14' } })];
    await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'LAUNCH20' }));
    const [, args] = find('checkout.create');
    expect(args.subscription_data.trial_period_days).toBe(14);
    // The discount still rides along — a code can carry both.
    expect(args.discounts).toEqual([{ promotion_code: 'promo_1' }]);
  });

  it('ignores junk in the metadata rather than sending it to Stripe', async () => {
    // Metadata is free text and editable in the Stripe dashboard.
    for (const trialDays of ['banana', '0', '-5', '']) {
      calls.length = 0;
      promotionCodes = [promo({ metadata: { trialDays } })];
      await __test.handleCheckout(ev({ tier: 'pro', promoCode: 'LAUNCH20' }));
      expect(find('checkout.create')[1].subscription_data.trial_period_days).toBeUndefined();
    }
  });

  it('never grants one on an in-place plan switch', async () => {
    // An existing subscriber is past the point a trial can start; granting one
    // would zero out a period they already paid for.
    user.stripeCustomerId = 'cus_1';
    promotionCodes = [promo({ metadata: { trialDays: '30' } })];
    const res = await __test.handleSubscriptionChange(ev({ tier: 'expert', promoCode: 'LAUNCH20' }));
    expect(res.statusCode).toBe(200);
    const [, , args] = find('subscriptions.update');
    expect(args.trial_end).toBeUndefined();
    expect(args.trial_period_days).toBeUndefined();
    expect(args.discounts).toEqual([{ promotion_code: 'promo_1' }]);
  });

  it('does not promise a trial to someone who already has a customer record', async () => {
    user.stripeCustomerId = 'cus_1';
    promotionCodes = [promo({ metadata: { trialDays: '14' } })];
    const res = await __test.handlePromoValidate(ev({ code: 'LAUNCH20', tier: 'pro' }));
    expect(bodyOf(res).trialDays).toBeNull();
  });

  it('advertises it to a genuinely new buyer', async () => {
    promotionCodes = [promo({ metadata: { trialDays: '14' } })];
    const res = await __test.handlePromoValidate(ev({ code: 'LAUNCH20', tier: 'pro' }));
    expect(bodyOf(res)).toMatchObject({ valid: true, trialDays: 14 });
  });
});

describe('createPromo with a trial', () => {
  it('stores the days on the promotion code', async () => {
    await createPromo({ code: 'TRY30', percentOff: 20, duration: 'once', scope: 'plans', trialDays: 30 });
    expect(find('promotionCodes.create')[1].metadata.trialDays).toBe('30');
  });

  it('omits the key entirely when there is no trial', async () => {
    await createPromo({ code: 'PLAIN', percentOff: 20, duration: 'once' });
    expect(find('promotionCodes.create')[1].metadata.trialDays).toBeUndefined();
  });

  it('refuses a fractional, zero or absurd number of days', async () => {
    for (const trialDays of [0, -1, 1.5, 400, 'soon']) {
      await expect(createPromo({ code: 'BAD', percentOff: 20, duration: 'once', trialDays }))
        .rejects.toThrow(/whole number of days/);
    }
  });

  it('refuses a trial on a top-ups-only code — there is no subscription', async () => {
    await expect(createPromo({ code: 'TOPUP', percentOff: 20, duration: 'once', scope: 'topups', trialDays: 7 }))
      .rejects.toThrow(/needs a subscription/);
  });
});

describe('POST /billing/topup', () => {
  it('offers a code field — credit packs are a purchase too', async () => {
    const res = await __test.handleTopup(ev({ packId: 'topup_s' }));
    expect(res.statusCode).toBe(200);
    expect(find('checkout.create')[1].allow_promotion_codes).toBe(true);
  });
});

describe('POST /billing/subscription/change with a code', () => {
  beforeEach(() => { user.stripeCustomerId = 'cus_1'; });

  it('attaches the discount alongside the price move', async () => {
    const res = await __test.handleSubscriptionChange(ev({ tier: 'expert', promoCode: 'LAUNCH20' }));
    expect(bodyOf(res)).toMatchObject({ changed: true, discounted: true });
    expect(find('subscriptions.update')[2].discounts).toEqual([{ promotion_code: 'promo_1' }]);
  });

  it('never sends discounts:[] without a code — that would strip an existing one', async () => {
    await __test.handleSubscriptionChange(ev({ tier: 'expert' }));
    expect('discounts' in find('subscriptions.update')[2]).toBe(false);
  });

  it('applies a code to the plan they are already on', async () => {
    // Same price = normally a no-op, but with a code there is real work to do.
    const res = await __test.handleSubscriptionChange(ev({ tier: 'pro', interval: 'monthly', promoCode: 'LAUNCH20' }));
    expect(bodyOf(res)).toMatchObject({ changed: true, discounted: true });
  });

  it('blocks a first-time-only code — a subscriber is by definition not new', async () => {
    promotionCodes = [promo({ restrictions: { first_time_transaction: true } })];
    const res = await __test.handleSubscriptionChange(ev({ tier: 'expert', promoCode: 'LAUNCH20' }));
    expect(res.statusCode).toBe(400);
    expect(find('subscriptions.update')).toBeUndefined();
  });
});

describe('POST /billing/promo/validate', () => {
  it('prices the discount instead of erroring on a bad code', async () => {
    const good = await __test.handlePromoValidate(ev({ code: 'LAUNCH20', tier: 'pro' }));
    expect(bodyOf(good)).toMatchObject({ valid: true, percentOff: 20, baseAmount: 4900, amountDue: 3920 });

    promotionCodes = [];
    const bad = await __test.handlePromoValidate(ev({ code: 'NOPE', tier: 'pro' }));
    expect(bad.statusCode).toBe(200);          // a typo is not an exception
    expect(bodyOf(bad)).toMatchObject({ valid: false });
  });
});

describe('createPromo', () => {
  it('refuses a code that is both a percentage and an amount, or neither', async () => {
    await expect(createPromo({ code: 'A1B', percentOff: 20, amountOff: 500 })).rejects.toThrow(/either/);
    await expect(createPromo({ code: 'A1B' })).rejects.toThrow(/either/);
  });

  it('refuses codes people can’t type back', async () => {
    await expect(createPromo({ code: 'no spaces', percentOff: 10 })).rejects.toThrow(/3–40 characters/);
  });

  it('needs a month count for a repeating discount', async () => {
    await expect(createPromo({ code: 'A1B', percentOff: 10, duration: 'repeating' })).rejects.toThrow(/months/);
  });

  it('cleans up the coupon when the code turns out to be taken', async () => {
    // Otherwise a duplicate-code typo litters the Stripe account with orphan
    // coupons nobody can see or reuse.
    codeTaken = true;
    try {
      await expect(createPromo({ code: 'TAKEN', percentOff: 10 })).rejects.toThrow();
      expect(find('coupons.del')).toEqual(['coupons.del', 'coupon_1']);
    } finally { codeTaken = false; }
  });

  it('scopes a plans-only code to the plan products', async () => {
    const p = await createPromo({ code: 'PLANS10', percentOff: 10, scope: 'plans' });
    // Every plan product, and no top-up product.
    expect(find('coupons.create')[1].applies_to.products.sort()).toEqual(['prod_plan', 'prod_plan_x']);
    expect(p.scope).toBe('plans');
  });
});
