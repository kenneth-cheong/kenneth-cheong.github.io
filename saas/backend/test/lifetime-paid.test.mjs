import { describe, it, expect, vi, beforeEach } from 'vitest';

// Admin → Users shows what each account has actually paid us. Stripe has no
// "sum every invoice for this customer" call, so the figure is a running total
// the webhook keeps on the user record — which makes WHERE it is booked, and
// how many times, the whole correctness story. These lock down the three ways
// it could go wrong: missing a mid-cycle upgrade, double-counting a top-up, and
// over-refunding a partially refunded charge.

let sessions = [];
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.subscriptions = { retrieve: async () => { throw new Error('no sub'); } };
      this.checkout = { sessions: { list: async () => ({ data: sessions }) } };
    }
  },
}));

const paid = [];
let user = null;
let refundSeen = {};
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  getUserByStripeCustomer: async () => user,
  addLifetimePaid: async (args) => { paid.push(args); },
  // Mirrors the real cumulative-to-delta bookkeeping.
  refundDeltaCents: async (chargeId, cumulative) => {
    const delta = cumulative - (refundSeen[chargeId] || 0);
    if (delta <= 0) return 0;
    refundSeen[chargeId] = cumulative;
    return delta;
  },
  unlinkStripeCustomer: async () => {}, grantTopupCredits: async () => {},
  claimStripeEvent: async () => true, releaseStripeEvent: async () => {},
  resetMonthlyAllowance: async () => {}, applyTierChange: async () => {},
  applyDowngrade: async () => {}, linkStripeCustomer: async () => {},
  setPastDue: async () => {}, debitTopupCredits: async () => {},
}));
vi.mock('../src/lib/ratelimit.mjs', () => ({ rateLimit: async () => ({ allowed: true }) }));

process.env.PRICE_PRO_MONTHLY = 'price_pro_m';

const { __test } = await import('../src/billing/index.mjs');

beforeEach(() => {
  paid.length = 0; sessions = []; refundSeen = {};
  user = { userId: 'u1', email: 'a@b.co', tier: 'pro', credits: 2000, stripeCustomerId: 'cus_1' };
});

const invoice = (over = {}) => ({
  id: 'in_1', customer: 'cus_1', currency: 'usd', amount_paid: 9900,
  billing_reason: 'subscription_cycle',
  lines: { data: [{ pricing: { price_details: { price: 'price_pro_m' } }, period: { end: 1785372477 } }] },
  ...over,
});

describe('subscription revenue', () => {
  it('books the amount actually collected on a renewal', async () => {
    await __test.onInvoicePaid(invoice());
    expect(paid).toEqual([{ userId: 'u1', cents: 9900, currency: 'usd' }]);
  });

  it('books a mid-cycle proration even though it must not reset credits', async () => {
    // The trap: the allowance gate returns early for 'subscription_update', so
    // booking revenue below it would silently lose every upgrade proration.
    await __test.onInvoicePaid(invoice({ billing_reason: 'subscription_update', amount_paid: 4200 }));
    expect(paid).toEqual([{ userId: 'u1', cents: 4200, currency: 'usd' }]);
  });

  it('books nothing for a 100%-discounted invoice', async () => {
    await __test.onInvoicePaid(invoice({ amount_paid: 0 }));
    expect(paid).toHaveLength(0);
  });

  it('books nothing when the customer maps to no user', async () => {
    user = null;
    await __test.onInvoicePaid(invoice());
    expect(paid).toHaveLength(0);
  });
});

describe('top-up revenue', () => {
  const session = (over = {}) => ({
    client_reference_id: 'u1', customer: 'cus_1', currency: 'usd',
    amount_total: 2900, metadata: { type: 'topup', credits: '500', packId: 'topup_s' },
    ...over,
  });

  it('books the session total (top-ups have no invoice)', async () => {
    await __test.onCheckoutComplete(session());
    expect(paid).toEqual([{ userId: 'u1', cents: 2900, currency: 'usd' }]);
  });

  it('books nothing for a subscription checkout — invoice.paid owns that', async () => {
    // Both events fire for a new subscription; counting each would double it.
    await __test.onCheckoutComplete(session({ metadata: { type: 'subscription' } }));
    expect(paid).toHaveLength(0);
  });

  it('books nothing for a card-update session', async () => {
    await __test.onCheckoutComplete(session({ metadata: { type: 'card' }, setup_intent: null }));
    expect(paid).toHaveLength(0);
  });
});

describe('refunds', () => {
  const charge = (over = {}) => ({
    id: 'ch_1', customer: 'cus_1', currency: 'usd', amount: 9900, amount_refunded: 9900,
    payment_intent: 'pi_1', status: 'succeeded', paid: true, invoice: 'in_1', ...over,
  });

  it('takes a refunded subscription charge back off the total', async () => {
    await __test.onChargeRefunded(charge());
    expect(paid).toEqual([{ userId: 'u1', cents: -9900, currency: 'usd' }]);
  });

  it('only books the increment when a charge is refunded twice', async () => {
    // Stripe sends the CUMULATIVE amount_refunded on each partial refund, so
    // booking it verbatim would claw back 9900 for a 5900 refund.
    await __test.onChargeRefunded(charge({ amount_refunded: 2000 }));
    await __test.onChargeRefunded(charge({ amount_refunded: 5900 }));
    expect(paid).toEqual([
      { userId: 'u1', cents: -2000, currency: 'usd' },
      { userId: 'u1', cents: -3900, currency: 'usd' },
    ]);
  });

  it('books nothing on a re-delivered event for an already-booked refund', async () => {
    await __test.onChargeRefunded(charge());
    paid.length = 0;
    await __test.onChargeRefunded(charge());
    expect(paid).toHaveLength(0);
  });
});
