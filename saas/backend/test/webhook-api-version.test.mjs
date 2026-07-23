import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stripe renders webhook payloads at the ACCOUNT's default API version, not the
// version the SDK pins for its own calls. Moving billing to the freshly created
// (and therefore 2025-versioned) Apsolute.ai account reshaped every incoming
// event while our own API reads kept the old shape — so nothing threw, fields
// just went undefined, and a paid Pro upgrade wrote the buyer back as Free with
// the Free allowance and a shiny new period end. These lock down both shapes.

const calls = [];
let subscriptions = {};

vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.subscriptions = {
        retrieve: async (id) => {
          calls.push(['subscriptions.retrieve', id]);
          if (!subscriptions[id]) throw new Error(`No such subscription: ${id}`);
          return subscriptions[id];
        },
      };
    }
  },
}));

const resets = [];
const tierChanges = [];
let user = null;
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  getUserByStripeCustomer: async () => user,
  resetMonthlyAllowance: async (args) => { resets.push(args); },
  applyTierChange: async (args) => { tierChanges.push(args); },
  unlinkStripeCustomer: async () => {}, grantTopupCredits: async () => {},
  claimStripeEvent: async () => true, releaseStripeEvent: async () => {},
  applyDowngrade: async () => {}, linkStripeCustomer: async () => {},
  setPastDue: async () => {}, debitTopupCredits: async () => {},
  addLifetimePaid: async () => {}, refundDeltaCents: async (_id, c) => c,
}));
vi.mock('../src/lib/ratelimit.mjs', () => ({ rateLimit: async () => ({ allowed: true }) }));

process.env.PRICE_PRO_MONTHLY = 'price_pro_m';
process.env.PRICE_EXPERT_MONTHLY = 'price_expert_m';

const { __test } = await import('../src/billing/index.mjs');

// The trial-start invoice exactly as the live account sent it: no `price` on the
// line, no `subscription` on the invoice, both moved one level down.
const newShapeInvoice = (over = {}) => ({
  id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_create',
  parent: { subscription_details: { subscription: 'sub_1' } },
  lines: {
    data: [{
      period: { start: 1784767677, end: 1785372477 },
      pricing: { price_details: { price: 'price_pro_m', product: 'prod_x' }, type: 'price_details' },
      parent: { subscription_item_details: { subscription: 'sub_1' } },
    }],
  },
  ...over,
});

// The same invoice on a pre-2025 version, which some endpoints may still send.
const oldShapeInvoice = (over = {}) => ({
  id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_create',
  subscription: 'sub_1',
  lines: { data: [{ price: { id: 'price_pro_m' }, period: { end: 1785372477 } }] },
  ...over,
});

beforeEach(() => {
  calls.length = 0; resets.length = 0; tierChanges.length = 0;
  user = { userId: 'u1', email: 'a@b.co', tier: 'free', credits: 30, stripeCustomerId: 'cus_1' };
  subscriptions = {
    sub_1: { id: 'sub_1', status: 'trialing', items: { data: [{ id: 'si_1', price: { id: 'price_pro_m' }, current_period_end: 1785372477 }] } },
  };
});

describe('invoice.paid on the account API version', () => {
  it('upgrades the tier when the price is under pricing.price_details', async () => {
    // THE bug: `lines.data[0].price` is gone, so the tier resolved to nothing,
    // fell back to the buyer's current tier, and Pro silently stayed Free.
    await __test.onInvoicePaid(newShapeInvoice());
    expect(resets).toHaveLength(1);
    expect(resets[0].tier).toBe('pro');
    expect(resets[0].monthlyCredits).toBe(2000);
    expect(resets[0].periodEnd).toBe(new Date(1785372477 * 1000).toISOString());
    // Read straight off the line — no need to go ask Stripe.
    expect(calls).toHaveLength(0);
  });

  it('still reads the legacy line shape', async () => {
    await __test.onInvoicePaid(oldShapeInvoice());
    expect(resets[0].tier).toBe('pro');
    expect(resets[0].monthlyCredits).toBe(2000);
  });

  it('falls back to the subscription when the line carries no price at all', async () => {
    // A shape we haven't seen yet must not silently downgrade a paying customer:
    // ask Stripe what they're actually subscribed to.
    const invoice = newShapeInvoice();
    delete invoice.lines.data[0].pricing;
    await __test.onInvoicePaid(invoice);
    expect(calls).toContainEqual(['subscriptions.retrieve', 'sub_1']);
    expect(resets[0].tier).toBe('pro');
  });

  it('finds the subscription id under either shape', () => {
    expect(__test.subscriptionIdFromInvoice(newShapeInvoice())).toBe('sub_1');
    expect(__test.subscriptionIdFromInvoice(oldShapeInvoice())).toBe('sub_1');
    expect(__test.subscriptionIdFromInvoice({ subscription: { id: 'sub_9' } })).toBe('sub_9');
    expect(__test.subscriptionIdFromInvoice({})).toBeNull();
  });

  it('keeps the current tier, loudly, when nothing resolves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const invoice = newShapeInvoice({ parent: null });
    delete invoice.lines.data[0].pricing;
    delete invoice.lines.data[0].parent;
    user.tier = 'expert';
    await __test.onInvoicePaid(invoice);
    expect(resets[0].tier).toBe('expert');
    expect(err).toHaveBeenCalledWith('invoice_tier_unresolved', 'in_1', 'subscription_create', null);
    err.mockRestore();
  });

  it('leaves proration and one-off invoices alone', async () => {
    // These must never reset a mid-cycle balance back to full.
    await __test.onInvoicePaid(newShapeInvoice({ billing_reason: 'subscription_update' }));
    expect(resets).toHaveLength(0);
  });
});

describe('customer.subscription.created as a second path to the tier', () => {
  it('grants the tier off the subscription itself', async () => {
    // The backstop: even if the invoice tells us nothing, the subscription
    // object carries the price in its own right.
    await __test.onSubscriptionUpdated(subscriptions.sub_1);
    expect(tierChanges).toEqual([{ userId: 'u1', tier: 'pro', monthlyCredits: 2000 }]);
  });

  it('does nothing when the tier already matches', async () => {
    user.tier = 'pro';
    await __test.onSubscriptionUpdated(subscriptions.sub_1);
    expect(tierChanges).toHaveLength(0);
  });
});

describe('period end', () => {
  it('reads it off the item now that the subscription no longer carries it', () => {
    expect(__test.periodEndOfSubscription(subscriptions.sub_1)).toBe(1785372477);
    expect(__test.periodEndOfSubscription({ current_period_end: 123 })).toBe(123);
    expect(__test.periodEndOfSubscription({})).toBeNull();
  });
});
