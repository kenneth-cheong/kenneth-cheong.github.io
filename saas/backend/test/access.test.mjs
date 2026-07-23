import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// The access gate decides who can use the product at all, so its edges are worth
// pinning: the exact day a trial closes, the grace window a failed payment
// opens, and — the one that costs real money if it's wrong — the fact that a
// lock is derived from timestamps and never implies deletion.
process.env.ADMIN_EMAILS = 'boss@digimetrics.ai';
const { accessState, accessLocked, accessLockedResponse, freeTrialEndsAt, graceEndsAt } =
  await import('../src/lib/access.mjs');
const { ACCESS } = await import('../../shared/catalog.mjs');

const DAY = 86_400_000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
const freeUser = (over = {}) => ({ userId: 'u', email: 'a@b.co', tier: 'free', createdAt: iso(0), ...over });
const paidUser = (over = {}) => ({ userId: 'u', email: 'a@b.co', tier: 'pro', createdAt: iso(-90 * DAY), ...over });

describe('free trial window', () => {
  it('is open on the day of signup', () => {
    const s = accessState(freeUser());
    expect(s.locked).toBe(false);
    expect(s.reason).toBe('free_trial');
    expect(s.daysLeft).toBe(ACCESS.freeTrialDays);
  });

  it('is still open an hour before the deadline, and shut an hour after', () => {
    expect(accessLocked(freeUser({ createdAt: iso(-(7 * DAY - 3600_000)) }))).toBe(false);
    expect(accessLocked(freeUser({ createdAt: iso(-(7 * DAY + 3600_000)) }))).toBe(true);
  });

  it('reports free_trial_expired once the window closes', () => {
    const s = accessState(freeUser({ createdAt: iso(-30 * DAY) }));
    expect(s).toMatchObject({ locked: true, reason: 'free_trial_expired', daysLeft: 0 });
  });

  it('warns only in the final stretch', () => {
    expect(accessState(freeUser({ createdAt: iso(-1 * DAY) })).warn).toBe(false);
    expect(accessState(freeUser({ createdAt: iso(-5 * DAY) })).warn).toBe(true);
  });

  it('lets an explicit deadline override the signup date (admin extension)', () => {
    const u = freeUser({ createdAt: iso(-60 * DAY), freeAccessEndsAt: iso(5 * DAY) });
    expect(accessLocked(u)).toBe(false);
    expect(accessState(u).daysLeft).toBe(5);
    expect(freeTrialEndsAt(u)).toBe(u.freeAccessEndsAt);
  });

  it('treats an unknown tier as free — a bad tier must not become a free pass', () => {
    expect(accessLocked({ ...freeUser({ createdAt: iso(-30 * DAY) }), tier: 'enterprise' })).toBe(true);
  });
});

describe('past-due grace window', () => {
  it('leaves a paid, current account with no clock at all', () => {
    expect(accessState(paidUser())).toMatchObject({ locked: false, reason: null, endsAt: null });
    expect(graceEndsAt(paidUser())).toBe(null);
  });

  it('keeps a failed payer working inside the grace window', () => {
    const s = accessState(paidUser({ pastDue: true, pastDueSince: iso(-2 * DAY) }));
    expect(s).toMatchObject({ locked: false, reason: 'past_due_grace', daysLeft: 5 });
  });

  it('locks once the grace window elapses', () => {
    const s = accessState(paidUser({ pastDue: true, pastDueSince: iso(-8 * DAY) }));
    expect(s).toMatchObject({ locked: true, reason: 'payment_overdue' });
  });

  it('falls back to updatedAt for records flagged before pastDueSince existed', () => {
    expect(accessLocked(paidUser({ pastDue: true, updatedAt: iso(-9 * DAY) }))).toBe(true);
    expect(accessLocked(paidUser({ pastDue: true, updatedAt: iso(-1 * DAY) }))).toBe(false);
  });

  it('measures the paid grace from the failure, NOT from the account age', () => {
    // A three-month-old subscriber whose card just failed gets the full 7 days;
    // reading `createdAt` here would lock them out the instant Stripe reports it.
    expect(accessLocked(paidUser({ createdAt: iso(-365 * DAY), pastDue: true, pastDueSince: iso(-1 * DAY) }))).toBe(false);
  });
});

describe('exemptions and payload', () => {
  it('never puts staff on a billing clock', () => {
    expect(accessLocked({ tier: 'free', email: 'boss@digimetrics.ai', createdAt: iso(-99 * DAY) })).toBe(false);
    expect(accessLocked({ tier: 'free', email: 'x@y.co', role: 'staff', createdAt: iso(-99 * DAY) })).toBe(false);
  });

  it('treats a missing user as unlocked rather than throwing', () => {
    expect(accessState(null).locked).toBe(false);
  });

  it('always says the data is safe, whichever lock it is', () => {
    for (const u of [freeUser({ createdAt: iso(-30 * DAY) }), paidUser({ pastDue: true, pastDueSince: iso(-30 * DAY) })]) {
      const r = accessLockedResponse(u);
      expect(r.error).toBe('access_locked');
      expect(r.message).toMatch(/safe and untouched/);
    }
  });
});
