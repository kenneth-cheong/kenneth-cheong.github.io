import { describe, it, expect, vi, beforeEach } from 'vitest';

// A renewal reminder is a transactional heads-up before a card is charged (or
// before a cancelled plan lapses), so what matters is the cadence: fire at each
// configured "days before" value, exactly once, only for paid+current accounts,
// and re-arm on the next billing cycle.
const sent = vi.hoisted(() => ({ notifications: [], emails: [], stamps: [] }));

vi.mock('../src/lib/dynamo.mjs', () => ({
  scanAllUsers: async () => [],
  refillFreeTier: async () => null,
  addNotification: async (n) => { sent.notifications.push(n); },
  setAccessNotice: async () => {},
  setRenewalNotice: async (userId, stage) => { sent.stamps.push({ userId, stage }); },
  getSettings: async () => ({ renewalReminderDays: [30, 10, 5] }),
}));
vi.mock('../src/lib/email.mjs', () => ({ sendNotice: async () => {} }));
vi.mock('../src/lib/billing-emails.mjs', () => ({
  sendRenewalEmail: async (u, opts) => { sent.emails.push({ to: u.email, ...opts }); },
  formatDate: (v) => String(v || ''),
  formatMoney: (m) => `$${(Number(m) / 100).toFixed(2)} USD`,
}));

const { __test } = await import('../src/refill/index.mjs');
const { remindRenewal } = __test;

const DAY = 86_400_000;
const NOW = 1_800_000_000_000; // fixed clock so daysLeft is exact
const endsIn = (days) => new Date(NOW + days * DAY).toISOString();
const DAYS = [30, 10, 5];
const pro = (over = {}) => ({ userId: 'u', email: 'a@b.co', tier: 'pro', periodEnd: endsIn(10), ...over });

beforeEach(() => { sent.notifications = []; sent.emails = []; sent.stamps = []; });

describe('renewal reminder cadence', () => {
  it('does nothing when the reminder list is empty (feature off)', async () => {
    expect(await remindRenewal(pro(), [], NOW)).toBe(0);
    expect(sent.emails).toHaveLength(0);
  });

  it('fires at each configured day, and is quiet in between', async () => {
    expect(await remindRenewal(pro({ periodEnd: endsIn(30) }), DAYS, NOW)).toBe(1);
    expect(await remindRenewal(pro({ periodEnd: endsIn(10) }), DAYS, NOW)).toBe(1);
    expect(await remindRenewal(pro({ periodEnd: endsIn(5) }), DAYS, NOW)).toBe(1);
    expect(await remindRenewal(pro({ periodEnd: endsIn(9) }), DAYS, NOW)).toBe(0); // not a configured day
  });

  it('stamps the reminder with the current periodEnd so the next cycle re-arms', async () => {
    const end = endsIn(10);
    expect(await remindRenewal(pro({ periodEnd: end }), DAYS, NOW)).toBe(1);
    expect(sent.stamps.at(-1).stage).toBe(`${end}:10`);
    // Same stamp already on the record → never repeats.
    expect(await remindRenewal(pro({ periodEnd: end, renewalNoticeStage: `${end}:10` }), DAYS, NOW)).toBe(0);
    // New cycle (new periodEnd) → old stamp no longer matches, fires again.
    const next = endsIn(40);
    expect(await remindRenewal({ userId: 'u', email: 'a@b.co', tier: 'pro', periodEnd: next, renewalNoticeStage: `${end}:10` }, [40], NOW)).toBe(1);
  });

  it('renewing account: charges wording + amount, links to account', async () => {
    await remindRenewal(pro({ periodEnd: endsIn(5) }), DAYS, NOW);
    expect(sent.notifications.at(-1).title).toMatch(/renews in 5 days/);
    expect(sent.notifications.at(-1).link).toBe('/account');
    expect(sent.emails.at(-1).ending).toBe(false);
    expect(sent.emails.at(-1).amountText).toMatch(/USD/);
  });

  it('cancelled account: "ends" wording, no charge amount', async () => {
    await remindRenewal(pro({ periodEnd: endsIn(5), cancelAtPeriodEnd: true }), DAYS, NOW);
    expect(sent.notifications.at(-1).title).toMatch(/ends in 5 days/);
    expect(sent.emails.at(-1).ending).toBe(true);
    expect(sent.emails.at(-1).amountText).toBe('');
  });

  it('skips accounts that should not get a renewal reminder', async () => {
    expect(await remindRenewal({ ...pro(), tier: 'free' }, DAYS, NOW)).toBe(0);        // free doesn't renew
    expect(await remindRenewal({ ...pro(), role: 'staff' }, DAYS, NOW)).toBe(0);       // staff not billed
    expect(await remindRenewal({ ...pro(), pastDue: true }, DAYS, NOW)).toBe(0);       // gets past-due warnings instead
    expect(await remindRenewal({ ...pro(), periodEnd: null }, DAYS, NOW)).toBe(0);     // no renewal anchor
    expect(await remindRenewal(pro({ periodEnd: endsIn(-1) }), DAYS, NOW)).toBe(0);    // already past
    expect(sent.emails).toHaveLength(0);
  });
});
