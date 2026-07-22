import { describe, it, expect, vi, beforeEach } from 'vitest';

// The three "manage my billing" routes the Account and Pricing pages call.
// These shipped in the frontend ahead of the backend, so every subscriber's
// card update / plan switch / cancel 404'd. Locked down here.

// ── Stripe double ────────────────────────────────────────────────────────────
// Records calls so we can assert on what we asked Stripe to do — the whole point
// of these routes is the side effect, not the response body.
const calls = [];
let subscriptions = [];
let missingCustomer = false;

const MISSING = Object.assign(new Error("No such customer: 'cus_dead'"), {
  code: 'resource_missing', param: 'customer',
});

vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.subscriptions = {
        list: async (args) => {
          calls.push(['subscriptions.list', args]);
          if (missingCustomer) throw MISSING;
          return { data: subscriptions };
        },
        update: async (id, args) => { calls.push(['subscriptions.update', id, args]); return { ...args, id, current_period_end: 1800000000 }; },
        cancel: async (id) => { calls.push(['subscriptions.cancel', id]); return { id, status: 'canceled' }; },
      };
      this.checkout = { sessions: { create: async (args) => { calls.push(['checkout.create', args]); if (missingCustomer) throw MISSING; return { url: 'https://stripe.test/session' }; } } };
      this.customers = { update: async (id, args) => { calls.push(['customers.update', id, args]); return { id }; } };
      this.setupIntents = { retrieve: async (id) => { calls.push(['setupIntents.retrieve', id]); return { id, payment_method: 'pm_new' }; } };
    }
  },
}));

// ── Data layer double ────────────────────────────────────────────────────────
let user = null;
const unlinked = [];
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  getUserByStripeCustomer: async () => user,
  unlinkStripeCustomer: async (userId, cus) => { unlinked.push([userId, cus]); },
  grantTopupCredits: async () => {}, claimStripeEvent: async () => true,
  releaseStripeEvent: async () => {}, resetMonthlyAllowance: async () => {},
  applyTierChange: async () => {}, applyDowngrade: async () => {},
  linkStripeCustomer: async () => {}, setPastDue: async () => {},
  debitTopupCredits: async () => {},
}));

// Rate limiting is orthogonal — always allow.
vi.mock('../src/lib/ratelimit.mjs', () => ({ rateLimit: async () => ({ allowed: true }) }));

process.env.APP_ORIGIN = 'https://platform.digimetrics.ai';
process.env.PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.PRICE_PRO_ANNUAL = 'price_pro_a';
process.env.PRICE_EXPERT_MONTHLY = 'price_expert_m';

const { __test } = await import('../src/billing/index.mjs');

const ev = (body = {}) => ({
  requestContext: { authorizer: { lambda: { userId: 'u1' } } },
  body: JSON.stringify(body),
});
const bodyOf = (res) => JSON.parse(res.body);
const find = (name) => calls.find((c) => c[0] === name);

beforeEach(() => {
  calls.length = 0; unlinked.length = 0;
  missingCustomer = false;
  user = { userId: 'u1', email: 'a@b.co', tier: 'pro', stripeCustomerId: 'cus_1' };
  subscriptions = [{ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1', price: { id: 'price_pro_m' } }] } }];
});

describe('activeSubscription', () => {
  it('picks up past_due and trialing, not just active', async () => {
    // A past_due subscription is still the user's to cancel or fix — treating it
    // as absent would strand exactly the people trying to update a failed card.
    for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
      subscriptions = [{ id: 'sub_x', status, items: { data: [{ id: 'si', price: { id: 'p' } }] } }];
      expect((await __test.activeSubscription('cus_1'))?.id).toBe('sub_x');
    }
  });

  it('ignores dead subscriptions', async () => {
    for (const status of ['canceled', 'incomplete_expired']) {
      subscriptions = [{ id: 'sub_x', status, items: { data: [] } }];
      expect(await __test.activeSubscription('cus_1')).toBeNull();
    }
  });
});

describe('POST /billing/payment-method', () => {
  it('opens a SETUP checkout carrying the identity the webhook needs', async () => {
    const res = await __test.handlePaymentMethod(ev());
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res).url).toBe('https://stripe.test/session');

    const [, args] = find('checkout.create');
    expect(args.mode).toBe('setup');
    expect(args.customer).toBe('cus_1');
    // onCheckoutComplete bails without one of these, so the card would be
    // attached and never promoted.
    expect(args.client_reference_id).toBe('u1');
    expect(args.metadata).toMatchObject({ type: 'card', userId: 'u1', subscriptionId: 'sub_1' });
    expect(args.success_url).toContain('card=updated');
  });

  it('401s an anonymous caller and 400s a customerless one', async () => {
    expect((await __test.handlePaymentMethod({ requestContext: {} })).statusCode).toBe(401);
    user = { userId: 'u1', tier: 'free' };
    expect((await __test.handlePaymentMethod(ev())).statusCode).toBe(400);
  });

  it('drops a stranded customer id rather than 500ing', async () => {
    missingCustomer = true;
    const res = await __test.handlePaymentMethod(ev());
    expect(res.statusCode).toBe(400);
    expect(unlinked).toEqual([['u1', 'cus_1']]);
  });
});

describe('POST /billing/subscription/change', () => {
  it('moves the existing item to the new price, prorated', async () => {
    const res = await __test.handleSubscriptionChange(ev({ tier: 'expert', interval: 'monthly' }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({ changed: true, tier: 'expert' });

    const [, id, args] = find('subscriptions.update');
    expect(id).toBe('sub_1');
    // Item id must ride along — omitting it ADDS a second line rather than
    // replacing the plan, and bills for both.
    expect(args.items).toEqual([{ id: 'si_1', price: 'price_expert_m' }]);
    expect(args.proration_behavior).toBe('create_prorations');
  });

  it('clears a pending cancellation on the way through', async () => {
    // Otherwise they pay to switch and still get cut off at period end.
    subscriptions[0].cancel_at_period_end = true;
    await __test.handleSubscriptionChange(ev({ tier: 'expert' }));
    expect(find('subscriptions.update')[2].cancel_at_period_end).toBe(false);
  });

  it('is a no-op when already on that price — no Stripe write', async () => {
    const res = await __test.handleSubscriptionChange(ev({ tier: 'pro', interval: 'monthly' }));
    expect(bodyOf(res)).toMatchObject({ changed: false });
    expect(find('subscriptions.update')).toBeUndefined();
  });

  it('refuses free (that is a cancellation) and unknown tiers', async () => {
    expect((await __test.handleSubscriptionChange(ev({ tier: 'free' }))).statusCode).toBe(400);
    expect((await __test.handleSubscriptionChange(ev({ tier: 'nope' }))).statusCode).toBe(400);
    expect(find('subscriptions.update')).toBeUndefined();
  });

  it('400s when there is no live subscription to move', async () => {
    subscriptions = [];
    const res = await __test.handleSubscriptionChange(ev({ tier: 'expert' }));
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /billing/subscription/cancel', () => {
  it('defaults to end-of-period so they keep what they paid for', async () => {
    const res = await __test.handleSubscriptionCancel(ev({}));
    expect(bodyOf(res)).toMatchObject({ cancelled: true, atPeriodEnd: true });
    expect(find('subscriptions.update')[2]).toEqual({ cancel_at_period_end: true });
    expect(find('subscriptions.cancel')).toBeUndefined();
  });

  it('cancels immediately only when explicitly asked', async () => {
    const res = await __test.handleSubscriptionCancel(ev({ atPeriodEnd: false }));
    expect(bodyOf(res)).toMatchObject({ atPeriodEnd: false });
    expect(find('subscriptions.cancel')[1]).toBe('sub_1');
  });

  it('400s with nothing to cancel', async () => {
    subscriptions = [];
    expect((await __test.handleSubscriptionCancel(ev({}))).statusCode).toBe(400);
  });
});

describe('promoteNewCard (webhook half of the card update)', () => {
  it('repoints BOTH the customer and the live subscription', async () => {
    await __test.promoteNewCard({ customer: 'cus_1', setup_intent: 'seti_1' });

    // The subscription's own default overrides the customer's, so setting only
    // the customer would leave the live plan charging the old card — the exact
    // thing the user came here to fix.
    expect(find('customers.update')[2]).toEqual({ invoice_settings: { default_payment_method: 'pm_new' } });
    expect(find('subscriptions.update')[2]).toEqual({ default_payment_method: 'pm_new' });
  });

  it('does nothing without a setup intent or payment method', async () => {
    await __test.promoteNewCard({ customer: 'cus_1' });
    expect(find('customers.update')).toBeUndefined();
  });

  it('survives a customer with no subscription (card saved for next time)', async () => {
    subscriptions = [];
    await __test.promoteNewCard({ customer: 'cus_1', setup_intent: 'seti_1' });
    expect(find('customers.update')).toBeDefined();
    expect(find('subscriptions.update')).toBeUndefined();
  });
});
