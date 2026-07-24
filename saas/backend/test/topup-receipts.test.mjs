import { describe, it, expect, vi, beforeEach } from 'vitest';

// A promo code can discount a credit top-up all the way to $0. Stripe then
// completes Checkout with NO charge, so it issues no receipt and the purchase
// appears nowhere in charges.list — the exact gap a customer hit ("bought
// credits with a discount code, saw no receipt"). Two guarantees lock the fix:
//   1. the top-up webhook stores the amount on the ledger and sends a branded
//      confirmation email (the only proof of purchase when the charge is $0);
//   2. the invoices endpoint surfaces those free top-ups from the ledger, while
//      still deduping paid ones that already show as their Stripe charge.

let invoicesList = [];
let chargesList = [];
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.invoices = { list: async () => ({ data: invoicesList }) };
      this.charges = { list: async () => ({ data: chargesList }) };
    }
  },
}));

const grants = [];
const paid = [];
let user = null;
let topupRows = [];
vi.mock('../src/lib/dynamo.mjs', () => ({
  getUser: async () => user,
  getUserByStripeCustomer: async () => user,
  grantTopupCredits: async (args) => { grants.push(args); },
  addLifetimePaid: async (args) => { paid.push(args); },
  listTopupPurchases: async () => topupRows,
  unlinkStripeCustomer: async () => {},
  claimStripeEvent: async () => true, releaseStripeEvent: async () => {},
  resetMonthlyAllowance: async () => {}, applyTierChange: async () => {},
  applyDowngrade: async () => {}, linkStripeCustomer: async () => {},
  setPastDue: async () => {}, debitTopupCredits: async () => {},
  setCancelAtPeriodEnd: async () => {}, refundDeltaCents: async () => 0,
}));
vi.mock('../src/lib/ratelimit.mjs', () => ({ rateLimit: async () => ({ allowed: true }) }));

// Keep real formatMoney/templates; only spy on the sender so no SES import runs.
const topupMail = [];
vi.mock('../src/lib/billing-emails.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  sendTopupEmail: async (u, opts) => { topupMail.push(opts); return true; },
}));

const { __test } = await import('../src/billing/index.mjs');

const authed = { requestContext: { authorizer: { lambda: { userId: 'u1' } } } };

beforeEach(() => {
  grants.length = 0; paid.length = 0; topupMail.length = 0;
  invoicesList = []; chargesList = []; topupRows = [];
  user = { userId: 'u1', email: 'a@b.co', tier: 'free', stripeCustomerId: 'cus_1' };
});

const session = (over = {}) => ({
  client_reference_id: 'u1', customer: 'cus_1', currency: 'usd',
  amount_total: 2900, metadata: { type: 'topup', credits: '500', packId: 'topup_m' },
  ...over,
});

describe('top-up webhook', () => {
  it('stores the amount on the ledger and emails a receipt for a paid top-up', async () => {
    await __test.onCheckoutComplete(session());
    expect(grants).toEqual([{ userId: 'u1', amount: 500, action: 'topup_purchase',
      meta: { packId: 'topup_m', cents: 2900, currency: 'usd' } }]);
    expect(topupMail).toHaveLength(1);
    expect(topupMail[0]).toMatchObject({ credits: 500, amountText: '$29.00 USD' });
  });

  it('grants, books no revenue, and emails a "Free" receipt for a $0 promo top-up', async () => {
    await __test.onCheckoutComplete(session({ amount_total: 0 }));
    expect(grants[0].meta.cents).toBe(0);        // ledger is the only record → must carry the $0
    expect(paid).toHaveLength(0);                // no money changed hands
    expect(topupMail[0].amountText).toBe('Free (promo code)');
  });
});

describe('invoices endpoint surfaces free top-ups', () => {
  it('shows a promo-zeroed top-up that has no Stripe charge', async () => {
    topupRows = [{ ts: 'L#1', at: '2026-07-20T10:00:00.000Z', delta: 1000,
      action: 'topup_purchase', meta: { packId: 'topup_m', cents: 0, currency: 'usd' } }];
    const res = JSON.parse((await __test.handleInvoices(authed)).body);
    const free = res.documents.filter((d) => d.status === 'free');
    expect(free).toHaveLength(1);
    expect(free[0]).toMatchObject({ type: 'receipt', amount: 0, url: null });
    expect(free[0].description).toContain('1,000 credits');
  });

  it('does NOT double-list a paid top-up already shown as its Stripe charge', async () => {
    // Same purchase seen twice: the Stripe charge (with receipt URL) and the
    // ledger row carrying cents > 0. Only the charge should surface.
    chargesList = [{ id: 'ch_1', created: 1784800000, amount: 2900, currency: 'usd',
      status: 'succeeded', refunded: false, receipt_url: 'https://r', invoice: null }];
    topupRows = [{ ts: 'L#2', at: '2026-07-20T10:00:00.000Z', delta: 500,
      action: 'topup_purchase', meta: { packId: 'topup_m', cents: 2900, currency: 'usd' } }];
    const res = JSON.parse((await __test.handleInvoices(authed)).body);
    expect(res.documents.filter((d) => d.type === 'receipt')).toHaveLength(1);
    expect(res.documents[0].url).toBe('https://r');
  });

  it('dedupes an OLD free-looking ledger row against a nearby charge (no stored amount)', async () => {
    // Pre-fix rows carry no cents. A paid one must still be recognised by the
    // charge sitting next to it in time, so it is not duplicated.
    const atSec = Math.floor(Date.parse('2026-07-20T10:00:00.000Z') / 1000);
    chargesList = [{ id: 'ch_9', created: atSec + 5, amount: 4500, currency: 'usd',
      status: 'succeeded', refunded: false, receipt_url: 'https://r9', invoice: null }];
    topupRows = [{ ts: 'L#3', at: '2026-07-20T10:00:00.000Z', delta: 1000,
      action: 'topup_purchase', meta: { packId: 'topup_m' } }];  // no cents
    const res = JSON.parse((await __test.handleInvoices(authed)).body);
    expect(res.documents.filter((d) => d.type === 'receipt')).toHaveLength(1);
    expect(res.documents.some((d) => d.status === 'free')).toBe(false);
  });
});
