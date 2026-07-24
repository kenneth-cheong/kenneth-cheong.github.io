import { describe, it, expect, vi, beforeEach } from 'vitest';

// The pre-lock warnings are the only notice a user gets before the product stops
// working, so the thing worth testing is the cadence: it must fire at the right
// moments, say each thing exactly once, and reset when the window does.
const sent = vi.hoisted(() => ({ notifications: [], emails: [], stamps: [] }));

vi.mock('../src/lib/dynamo.mjs', () => ({
  scanAllUsers: async () => [],
  refillFreeTier: async () => null,
  addNotification: async (n) => { sent.notifications.push(n); },
  setAccessNotice: async (userId, stage) => { sent.stamps.push({ userId, stage }); },
  setRenewalNotice: async () => {},
  getSettings: async () => ({ renewalReminderDays: [] }),
}));
vi.mock('../src/lib/billing-emails.mjs', () => ({
  sendRenewalEmail: async () => {},
  formatDate: () => '',
  formatMoney: () => '',
}));
vi.mock('../src/lib/email.mjs', () => ({
  sendNotice: async (m) => { sent.emails.push(m); },
}));

const { __test } = await import('../src/refill/index.mjs');
const { noticeFor, warnIfClosing } = __test;

const DAY = 86_400_000;
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const free = (age, over = {}) => ({ userId: 'u', email: 'a@b.co', tier: 'free', createdAt: iso(-age), ...over });

beforeEach(() => { sent.notifications = []; sent.emails = []; sent.stamps = []; });

describe('notice cadence', () => {
  it('says nothing while the trial is comfortably open', async () => {
    expect(await warnIfClosing(free(1 * DAY))).toBe(0);
    expect(sent.emails).toHaveLength(0);
  });

  it('warns 3 days out, and again on the last day', async () => {
    expect(await warnIfClosing(free(4 * DAY))).toBe(1);           // 3 days left
    expect(sent.stamps.at(-1).stage).toBe('free_trial:3');
    expect(await warnIfClosing(free(6 * DAY))).toBe(1);           // 1 day left
    expect(sent.stamps.at(-1).stage).toBe('free_trial:1');
    expect(sent.notifications.at(-1).title).toMatch(/ends in 1 day$/);
  });

  it('stays quiet on the in-between day — this is not a daily countdown', async () => {
    expect(await warnIfClosing(free(5 * DAY))).toBe(0);           // 2 days left
  });

  it('never repeats a stage it has already sent', async () => {
    const u = free(4 * DAY, { accessNoticeStage: 'free_trial:3' });
    expect(await warnIfClosing(u)).toBe(0);
  });

  it('sends the lock notice once the trial has actually ended', async () => {
    expect(await warnIfClosing(free(10 * DAY))).toBe(1);
    expect(sent.stamps.at(-1).stage).toBe('free_trial:0');
    expect(sent.notifications.at(-1).body).toMatch(/still here, untouched/);
  });

  it('clears the stamp when the window resets, so a later one can warn again', async () => {
    // Paid up and current: no clock, but a stale stamp from the trial remains.
    await warnIfClosing({ userId: 'u', email: 'a@b.co', tier: 'pro', createdAt: iso(-99 * DAY), accessNoticeStage: 'free_trial:0' });
    expect(sent.stamps.at(-1)).toEqual({ userId: 'u', stage: null });
    expect(sent.emails).toHaveLength(0);
  });

  it('points a failed payment at billing, and every notice at a way to fix it', async () => {
    const overdue = { userId: 'u', email: 'a@b.co', tier: 'pro', createdAt: iso(-99 * DAY), pastDue: true, pastDueSince: iso(-6 * DAY) };
    expect(await warnIfClosing(overdue)).toBe(1);
    expect(sent.notifications.at(-1).title).toMatch(/Payment failed/);
    expect(sent.notifications.at(-1).link).toBe('/pricing');
  });

  it('reassures about the data in every variant', () => {
    // Whichever way an account lapses, the message has to answer the question the
    // user is actually asking — "have I lost my work?" — not just ask for money.
    for (const reason of ['free_trial', 'free_trial_expired', 'past_due_grace', 'payment_overdue']) {
      const n = noticeFor({ reason, daysLeft: 2 });
      expect(n).toBeTruthy();
      expect(n.body).toMatch(/nothing is deleted|still here|data (stays )?safe|untouched|waits for you/i);
    }
  });
});
