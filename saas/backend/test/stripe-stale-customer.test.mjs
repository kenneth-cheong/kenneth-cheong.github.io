import { describe, it, expect, vi } from 'vitest';

// Stripe is imported at module load; stub it so the module can be imported
// without a live key. We only exercise the pure predicate here.
vi.mock('stripe', () => ({ default: class { constructor() {} } }));

const { __test } = await import('../src/billing/index.mjs');
const { isMissingCustomer } = __test;

// Customer ids are per-Stripe-account. Migrating accounts strands every stored
// id, and the first use 404s — which 500'd the billing routes until this landed.
describe('isMissingCustomer', () => {
  it('detects the real Stripe error that broke the portal', () => {
    expect(isMissingCustomer({
      code: 'resource_missing',
      param: 'customer',
      message: "No such customer: 'cus_UgpNT6dYMRje1U'",
      type: 'StripeInvalidRequestError',
    })).toBe(true);
  });

  it('detects it from the message when param is absent', () => {
    expect(isMissingCustomer({ code: 'resource_missing', message: 'No such customer: cus_x' })).toBe(true);
  });

  it('ignores resource_missing on a DIFFERENT param', () => {
    // A missing price must still surface as a real error, not be swallowed as a
    // stale customer and silently retried.
    expect(isMissingCustomer({ code: 'resource_missing', param: 'price', message: 'No such price' })).toBe(false);
  });

  it('ignores unrelated Stripe failures', () => {
    expect(isMissingCustomer({ code: 'card_declined', message: 'Your card was declined' })).toBe(false);
    expect(isMissingCustomer({ code: 'rate_limit' })).toBe(false);
  });

  it('is safe on null/undefined', () => {
    expect(isMissingCustomer(null)).toBeFalsy();
    expect(isMissingCustomer(undefined)).toBeFalsy();
    expect(isMissingCustomer({})).toBeFalsy();
  });
});
