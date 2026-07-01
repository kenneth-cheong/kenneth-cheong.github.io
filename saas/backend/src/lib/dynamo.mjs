// Thin DynamoDB document-client helpers shared by all functions.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { encrypt } from './crypto.mjs';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLES = {
  users: process.env.USERS_TABLE,
  ledger: process.env.LEDGER_TABLE,
  runs: process.env.RUNS_TABLE,
  tickets: process.env.TICKETS_TABLE,
  notifications: process.env.NOTIFICATIONS_TABLE,
  projects: process.env.PROJECTS_TABLE,
  cache: process.env.CACHE_TABLE,
  tracked: process.env.TRACKED_TABLE,
  metrics: process.env.METRICS_TABLE,
  conversations: process.env.CONVERSATIONS_TABLE,
  shares: process.env.SHARES_TABLE,
  broadcasts: process.env.BROADCASTS_TABLE,
};

const rid = () => Math.random().toString(36).slice(2, 8);

export async function getUser(userId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId } })
  );
  return Item || null;
}

// Merge a partial patch into the user's `onboarding` map (welcome flow, chosen
// goal, dismissed checklist, seen platform tour). Durable + cross-device so
// first-run state survives a localStorage wipe or a second device. `onboarding`
// is a map, so this is a read-modify-write to avoid clobbering sibling keys.
export async function updateOnboarding(userId, patch = {}) {
  const now = new Date().toISOString();
  const user = await getUser(userId);
  if (!user) return null;
  const onboarding = { ...(user.onboarding || {}), ...patch, updatedAt: now };
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users,
    Key: { userId },
    UpdateExpression: 'SET onboarding = :o, updatedAt = :u',
    ExpressionAttributeValues: { ':o': onboarding, ':u': now },
  }));
  return onboarding;
}

// Merge a partial patch into the user's `profile` map (progressive-profiling
// answers). Same read-modify-write shape as updateOnboarding so sibling keys
// aren't clobbered. The CALLER (POST /me/profile) is responsible for whitelisting
// keys + validating values against PROFILE_FIELDS — this just persists. Returns
// the merged profile map.
export async function updateProfile(userId, patch = {}) {
  const now = new Date().toISOString();
  const user = await getUser(userId);
  if (!user) return null;
  const profile = { ...(user.profile || {}), ...patch, updatedAt: now };
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users,
    Key: { userId },
    UpdateExpression: 'SET profile = :p, updatedAt = :u',
    ExpressionAttributeValues: { ':p': profile, ':u': now },
  }));
  return profile;
}

// One-time "completed your whole profile" reward. The grant must happen AT MOST
// once per account even under concurrent requests, so we first claim the slot
// with a conditional write (stamps profileBonusGrantedAt only if it's absent);
// only if that claim wins do we grant the rollover tokens. Returns true when the
// bonus was granted by THIS call, false if it was already claimed.
export async function claimProfileBonus({ userId, amount }) {
  const now = new Date().toISOString();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId },
      UpdateExpression: 'SET profileBonusGrantedAt = :now, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(profileBonusGrantedAt)',
      ExpressionAttributeValues: { ':now': now },
    }));
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false; // already claimed
    throw err;
  }
  // Claim won → grant the tokens (also writes the credit ledger).
  await grantTopupCredits({ userId, amount, action: 'profile_bonus', meta: { reason: 'profile_completed' } });
  return true;
}

export async function getUserByStripeCustomer(customerId) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLES.users,
      IndexName: 'stripeCustomerIndex',
      KeyConditionExpression: 'stripeCustomerId = :c',
      ExpressionAttributeValues: { ':c': customerId },
      Limit: 1,
    })
  );
  return Items?.[0] || null;
}

export async function putUser(user) {
  const item = { ...user };
  // stripeCustomerId is a GSI hash key — DynamoDB rejects a null value for it.
  // Omit the attribute until the user actually has a Stripe customer.
  if (!item.stripeCustomerId) delete item.stripeCustomerId;
  // Keep the emailIndex GSI key in sync: derive a normalized lowercase email so
  // password sign-in / forgot-password / account-linking can look users up by
  // address. (Provision stubs keep their own email — only set when present.)
  if (item.email) item.emailLower = String(item.email).trim().toLowerCase();
  else delete item.emailLower;
  await ddb.send(new PutCommand({ TableName: TABLES.users, Item: item }));
  return user;
}

// Look up a real user account by email via the emailIndex GSI. Skips `pending:`
// provision stubs (they carry an email but aren't a sign-in-able account) so
// callers get the linkable account, if any. Returns null when none exists.
export async function getUserByEmail(email) {
  const emailLower = String(email || '').trim().toLowerCase();
  if (!emailLower) return null;
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLES.users,
      IndexName: 'emailIndex',
      KeyConditionExpression: 'emailLower = :e',
      ExpressionAttributeValues: { ':e': emailLower },
    })
  );
  const accounts = (Items || []).filter((u) => !String(u.userId || '').startsWith('pending:'));
  return accounts[0] || null;
}

// Credits live in two buckets: `credits` (monthly allowance, reset each cycle)
// and `topupCredits` (purchased overage, rolls over). Spending draws from the
// monthly bucket first, then top-up.
export function totalCredits(user) {
  return (user.credits || 0) + (user.topupCredits || 0);
}

async function writeLedger({ userId, delta, balanceAfter, action, tool, meta = {} }) {
  const now = new Date().toISOString();
  await ddb.send(
    new PutCommand({
      TableName: TABLES.ledger,
      Item: {
        userId,
        // Sort key is time-first + a random suffix so two same-millisecond writes
        // (concurrent spends / fan-out) never overwrite each other; `at` is the
        // clean ISO for display.
        ts: `${now}#${Math.abs(delta)}#${tool || action}#${rid()}`,
        at: now,
        action,
        tool: tool || null,
        delta,
        balanceAfter,
        meta,
      },
    })
  );
}

/**
 * Spend `cost` credits, monthly-first then top-up, atomically. Uses optimistic
 * locking (condition on both bucket values) and retries on contention.
 * Returns { credits, topupCredits, total }.
 */
export async function spendCredits({ userId, cost, action = 'spend', tool, meta = {} }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = await getUser(userId);
    if (!user) throw new Error('User not found');
    const monthly = user.credits || 0;
    const topup = user.topupCredits || 0;
    if (monthly + topup < cost) {
      const err = new Error('insufficient_credits');
      err.code = 'insufficient_credits';
      throw err;
    }
    const fromMonthly = Math.min(monthly, cost);
    const fromTopup = cost - fromMonthly;
    try {
      const res = await ddb.send(
        new UpdateCommand({
          TableName: TABLES.users,
          Key: { userId },
          // Also tick a lifetime "credits used" counter so the admin user list
          // can show total consumption without scanning every run. Seeded by the
          // activity backfill for accounts that spent before this shipped.
          UpdateExpression:
            'SET credits = :nm, topupCredits = :nt, updatedAt = :now, creditsSpentTotal = if_not_exists(creditsSpentTotal, :z) + :cost',
          // Optimistic lock: only commit if neither bucket changed since read.
          ConditionExpression: 'credits = :om AND topupCredits = :ot',
          ExpressionAttributeValues: {
            ':nm': monthly - fromMonthly,
            ':nt': topup - fromTopup,
            ':om': monthly,
            ':ot': topup,
            ':cost': cost,
            ':z': 0,
            ':now': new Date().toISOString(),
          },
          ReturnValues: 'UPDATED_NEW',
        })
      );
      const credits = res.Attributes.credits;
      const topupCredits = res.Attributes.topupCredits;
      await writeLedger({ userId, delta: -cost, balanceAfter: credits + topupCredits, action, tool, meta });
      return { credits, topupCredits, total: credits + topupCredits };
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      // Lost the race — re-read and retry.
    }
  }
  throw new Error('spend_contention');
}

/** Grant rollover top-up credits (from a one-time purchase or admin). */
export async function grantTopupCredits({ userId, amount, action = 'topup', meta = {} }) {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.users,
      Key: { userId },
      UpdateExpression:
        'SET topupCredits = if_not_exists(topupCredits, :z) + :a, updatedAt = :now',
      ExpressionAttributeValues: { ':a': amount, ':z': 0, ':now': new Date().toISOString() },
      ReturnValues: 'UPDATED_NEW',
    })
  );
  const total = (res.Attributes.credits ?? 0) + res.Attributes.topupCredits;
  await writeLedger({ userId, delta: amount, balanceAfter: total, action, meta });
  return res.Attributes.topupCredits;
}

// ── Stripe webhook idempotency ───────────────────────────────────────────────
// Stripe delivers at-least-once and retries on any non-2xx, so the same event id
// can arrive multiple times. We claim each event id once (conditional write into
// the Cache table, 30-day TTL); a duplicate claim signals "already processed".
const STRIPE_EVENT_TTL = 60 * 60 * 24 * 30; // 30 days
/** Returns true if this event id was newly claimed (process it), false if seen. */
export async function claimStripeEvent(eventId) {
  if (!eventId) return true;
  try {
    await ddb.send(new PutCommand({
      TableName: TABLES.cache,
      Item: { key: `stripe_evt:${eventId}`, expireAt: Math.floor(Date.now() / 1000) + STRIPE_EVENT_TTL },
      ConditionExpression: 'attribute_not_exists(#k)',
      ExpressionAttributeNames: { '#k': 'key' },
    }));
    return true;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}
/** Release a claimed event so Stripe's retry can reprocess it (call on failure). */
export async function releaseStripeEvent(eventId) {
  if (!eventId) return;
  try { await ddb.send(new DeleteCommand({ TableName: TABLES.cache, Key: { key: `stripe_evt:${eventId}` } })); }
  catch (e) { console.error('release_stripe_event', eventId, e.message); }
}

// ── Atomic subscription/credit mutations (webhook) ───────────────────────────
// These touch ONLY the specific attributes (tier/credits/periodEnd) via
// UpdateCommand so a concurrent spendCredits — or other fields like topupCredits,
// teasers, integrations — is never clobbered by a whole-item put.

/** Billing-cycle anchor: set tier + hard-reset the monthly allowance, and clear
 * any past-due flag (a paid invoice means the account is current again). */
export async function resetMonthlyAllowance({ userId, tier, monthlyCredits, periodEnd = null, previousCredits = 0 }) {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET #tier = :t, credits = :c, periodEnd = :p, updatedAt = :now REMOVE pastDue',
    ExpressionAttributeNames: { '#tier': 'tier' },
    ExpressionAttributeValues: { ':t': tier, ':c': monthlyCredits, ':p': periodEnd, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
  }));
  const a = res.Attributes;
  await writeLedger({ userId, delta: monthlyCredits - previousCredits, balanceAfter: (a.credits || 0) + (a.topupCredits || 0), action: 'monthly_reset', meta: { tier } });
  return a;
}

/** Flag/clear an account as past-due (failed payment). Atomic, single attribute. */
export async function setPastDue(userId, value) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: value ? 'SET pastDue = :v, updatedAt = :now' : 'REMOVE pastDue SET updatedAt = :now',
    ExpressionAttributeValues: value ? { ':v': true, ':now': new Date().toISOString() } : { ':now': new Date().toISOString() },
  }));
}

/** Claw back top-up credits on a refund/dispute (atomic, floored at 0). */
export async function debitTopupCredits({ userId, amount, action = 'topup_refund', meta = {} }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = await getUser(userId);
    if (!user) return null;
    const topup = user.topupCredits || 0;
    const newTopup = Math.max(0, topup - amount);
    if (newTopup === topup) return user; // nothing to claw back
    try {
      const res = await ddb.send(new UpdateCommand({
        TableName: TABLES.users, Key: { userId },
        UpdateExpression: 'SET topupCredits = :n, updatedAt = :now',
        ConditionExpression: 'topupCredits = :o',
        ExpressionAttributeValues: { ':n': newTopup, ':o': topup, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      const a = res.Attributes;
      await writeLedger({ userId, delta: newTopup - topup, balanceAfter: (a.credits || 0) + (a.topupCredits || 0), action, meta });
      return a;
    } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  }
  throw new Error('debit_contention');
}

/** Full paginated scan of the users table (for the monthly free-tier refill). */
export async function scanAllUsers() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: TABLES.users, ExclusiveStartKey }));
    out.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.filter((u) => !isSingleton(u.userId)); // skip the platform-settings row
}

// ── Platform-wide settings (admin-toggled) ───────────────────────────────────
// Stored as one singleton item in the Users table (no email → never indexed,
// excluded from user scans). Keep the surface small + defaulted so a missing
// row, or a missing key on it, reads as the safe default.
const SETTINGS_ID = 'settings:global';
const DEFAULT_SETTINGS = {
  passwordAuthEnabled: true,
  // Support-ticket lifecycle (admin-tunable). Days; 0 disables that behaviour.
  ticketReminderDays: 3,   // cadence of "please respond" nudges while awaiting the client
  ticketAutoCloseDays: 7,  // inactivity before a ticket auto-closes
};
const isSingleton = (userId) => String(userId || '').startsWith('settings:');

/** Defaulted, typed view of the settings singleton — tolerates a missing row or
 *  missing keys by falling back to DEFAULT_SETTINGS. */
function viewSettings(item) {
  const s = item || {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    passwordAuthEnabled: s.passwordAuthEnabled !== false,
    ticketReminderDays: num(s.ticketReminderDays, DEFAULT_SETTINGS.ticketReminderDays),
    ticketAutoCloseDays: num(s.ticketAutoCloseDays, DEFAULT_SETTINGS.ticketAutoCloseDays),
  };
}

/** Public, defaulted view of the platform settings. */
export async function getSettings() {
  return viewSettings(await getUser(SETTINGS_ID));
}

/** Merge a partial patch onto the settings singleton; returns the new view. */
export async function updateSettings(patch = {}, adminEmail) {
  const current = (await getUser(SETTINGS_ID)) || {};
  const next = {
    ...current,
    ...patch,
    userId: SETTINGS_ID,
    updatedAt: new Date().toISOString(),
    updatedBy: adminEmail || current.updatedBy || null,
  };
  await putUser(next);
  return viewSettings(next);
}

/** Free-tier monthly refill — atomic + idempotent per period via a condition on
 * `freeRefillAt` so overlapping daily runs can't double-refill. Returns the new
 * item, or null if it was already refilled for this period. */
export async function refillFreeTier({ userId, monthlyCredits, nextAt, seenAt }) {
  const now = new Date().toISOString();
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: TABLES.users, Key: { userId },
      UpdateExpression: 'SET credits = :c, freeRefillAt = :next, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(freeRefillAt) OR freeRefillAt = :seen',
      ExpressionAttributeValues: { ':c': monthlyCredits, ':next': nextAt, ':now': now, ':seen': seenAt ?? '∅' },
      ReturnValues: 'ALL_NEW',
    }));
    const a = res.Attributes;
    await writeLedger({ userId, delta: 0, balanceAfter: (a.credits || 0) + (a.topupCredits || 0), action: 'monthly_reset_free', meta: { monthlyCredits } });
    return a;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return null;
    throw e;
  }
}

/** Tier change (upgrade): set tier and top the monthly bucket up to the new
 * allowance, atomically (optimistic lock so a concurrent spend isn't lost). */
export async function applyTierChange({ userId, tier, monthlyCredits }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = await getUser(userId);
    if (!user) return null;
    const prev = user.credits || 0;
    const credits = Math.max(prev, monthlyCredits);
    try {
      const res = await ddb.send(new UpdateCommand({
        TableName: TABLES.users, Key: { userId },
        UpdateExpression: 'SET #tier = :t, credits = :c, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(credits) OR credits = :oc',
        ExpressionAttributeNames: { '#tier': 'tier' },
        ExpressionAttributeValues: { ':t': tier, ':c': credits, ':oc': prev, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      const a = res.Attributes;
      await writeLedger({ userId, delta: credits - prev, balanceAfter: (a.credits || 0) + (a.topupCredits || 0), action: 'tier_change', meta: { tier } });
      return a;
    } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  }
  throw new Error('tier_change_contention');
}

/** Subscription cancelled → drop to free and clamp credits down to the free
 * allowance, atomically (optimistic lock). */
export async function applyDowngrade({ userId, monthlyCredits }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = await getUser(userId);
    if (!user) return null;
    const prev = user.credits || 0;
    const credits = Math.min(prev, monthlyCredits);
    try {
      const res = await ddb.send(new UpdateCommand({
        TableName: TABLES.users, Key: { userId },
        UpdateExpression: 'SET #tier = :t, credits = :c, updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(credits) OR credits = :oc',
        ExpressionAttributeNames: { '#tier': 'tier' },
        ExpressionAttributeValues: { ':t': 'free', ':c': credits, ':oc': prev, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
      }));
      const a = res.Attributes;
      await writeLedger({ userId, delta: credits - prev, balanceAfter: (a.credits || 0) + (a.topupCredits || 0), action: 'subscription_cancelled', meta: { tier: 'free' } });
      return a;
    } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  }
  throw new Error('downgrade_contention');
}

/** Link a Stripe customer id to a user on first purchase (atomic, set-once). */
export async function linkStripeCustomer(userId, customerId) {
  if (!customerId) return;
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLES.users, Key: { userId },
      UpdateExpression: 'SET stripeCustomerId = :c, updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(stripeCustomerId)',
      ExpressionAttributeValues: { ':c': customerId, ':now': new Date().toISOString() },
    }));
  } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; /* already linked */ }
}

/** Admin-only: list every user (Scan — fine at MVP volume). */
export async function listAllUsers(limit = 200) {
  const { Items } = await ddb.send(new ScanCommand({ TableName: TABLES.users, Limit: limit }));
  return (Items || []).filter((u) => !isSingleton(u.userId)); // hide the settings row
}

/** Admin: nudge a user's monthly and/or top-up buckets, with an audit row. */
export async function adminAdjustCredits({ userId, monthlyDelta = 0, topupDelta = 0, adminEmail, reason }) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  const credits = Math.max(0, (user.credits || 0) + monthlyDelta);
  const topupCredits = Math.max(0, (user.topupCredits || 0) + topupDelta);
  await putUser({ ...user, credits, topupCredits, updatedAt: new Date().toISOString() });
  await writeLedger({
    userId,
    delta: monthlyDelta + topupDelta,
    balanceAfter: credits + topupCredits,
    action: 'admin_adjust',
    meta: { adminEmail, reason: reason || null },
  });
  return { credits, topupCredits, total: credits + topupCredits };
}

/** Admin: override a user's tier and reset the monthly allowance to match. */
export async function adminSetTier({ userId, tier, monthlyCredits, adminEmail }) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  await putUser({ ...user, tier, credits: monthlyCredits, updatedAt: new Date().toISOString() });
  await writeLedger({
    userId,
    delta: 0,
    balanceAfter: monthlyCredits + (user.topupCredits || 0),
    action: 'admin_set_tier',
    meta: { adminEmail, tier },
  });
  return getUser(userId);
}

/** Admin: set a user's lifecycle status (active | paused | inactive). */
export async function adminSetStatus({ userId, status, adminEmail }) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  await putUser({ ...user, status, updatedAt: new Date().toISOString() });
  await writeLedger({
    userId,
    delta: 0,
    balanceAfter: totalCredits(user),
    action: 'admin_set_status',
    meta: { adminEmail, status },
  });
  return getUser(userId);
}

// ── Admin-provisioned accounts (invite-by-email) ─────────────────────────────
// Stored in the Users table under a `pending:<email>` key. On the person's first
// Google sign-in with that email, auth links it onto their real google:<sub>
// record (applying role/tier/credits) and deletes the provision.
const provisionId = (email) => `pending:${String(email || '').trim().toLowerCase()}`;

export async function createProvision({ email, name, role = 'client', tier = 'free', credits, invitedBy }) {
  const now = new Date().toISOString();
  const item = {
    userId: provisionId(email),
    provision: true,
    email: String(email).trim(),
    name: name || '',
    role: role === 'staff' ? 'staff' : 'client',
    tier,
    credits: Number.isFinite(credits) ? credits : 0,
    topupCredits: 0,
    status: 'invited',
    invitedBy: invitedBy || null,
    createdAt: now,
  };
  await putUser(item);
  return item;
}

export async function getProvision(email) { return getUser(provisionId(email)); }
export async function deleteProvision(email) {
  await ddb.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId: provisionId(email) } }));
}

export async function listLedger(userId, limit = 100) {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLES.ledger,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return Items || [];
}

// ── Run history ──────────────────────────────────────────────────────────────
// One row per tool run so users can re-open past results. Sort key is time-first
// so a query (ScanIndexForward:false) returns newest first. Results can be large
// (HTML reports), so the list view reads a slim projection.
// Best-effort "what was this run about" — the primary URL/domain/keyword from the
// inputs, normalised to a hostname when it's a URL. Stored so run history can be
// grouped by target webpage/domain without loading every run's full inputs.
function deriveTarget(inputs = {}) {
  const raw = String(inputs.url || inputs.domain || inputs.target || inputs.website || inputs.input || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname.replace(/^www\./, '');
  } catch {
    return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
  }
}

export async function saveRun({ userId, tool, toolName, inputs, result, creditsUsed = 0, projectId = null }) {
  const ts = new Date().toISOString();
  const runId = `${ts}#${Math.random().toString(36).slice(2, 8)}`;
  const preview = result?.text ? result.text.slice(0, 90)
    : Array.isArray(result?.rows) ? `${result.rows.length} rows`
    : result?.html ? 'report' : '';
  await ddb.send(new PutCommand({
    TableName: TABLES.runs,
    Item: { userId, runId, tool, toolName: toolName || tool, inputs: inputs || {}, result: result || {}, preview, target: deriveTarget(inputs), creditsUsed, projectId, ts },
  }));
  // Stamp the user's last tool-use time for the broadcast audience filter. This
  // is the same source the backfill derives from (newest run ts == max here), so
  // the live value and a rebuilt one never diverge. Best-effort — a failed touch
  // must never sink the run the user already paid for.
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLES.users, Key: { userId },
      UpdateExpression: 'SET lastToolUseAt = :t',
      // Only a real user record should carry this — guard against creating a
      // phantom item if userId somehow doesn't resolve to an account.
      ConditionExpression: 'attribute_exists(userId)',
      ExpressionAttributeValues: { ':t': ts },
    }));
  } catch (e) { if (e.name !== 'ConditionalCheckFailedException') console.error('touch_last_tool_use', userId, e.message); }
  return { runId, ts };
}

export async function listRuns(userId, limit = 100) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.runs,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    // Slim projection for the list — omit the full `result` + `inputs` payloads.
    ProjectionExpression: 'userId, runId, tool, toolName, preview, target, creditsUsed, projectId, ts',
    ScanIndexForward: false,
    Limit: limit,
  }));
  return Items || [];
}

export async function getRun(userId, runId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.runs, Key: { userId, runId } }));
  return Item || null;
}

// ── Public share links (opt-in, auto-redacted) ───────────────────────────────
// Maps a public, unguessable shareId → the owning {userId, runId} so the public
// /s/:id page can resolve a saved run without the viewer being signed in. The
// public card render strips the client domain/identifiers (see shareCard.mjs).
// `ttl` (epoch seconds) lets DynamoDB auto-expire stale links.
const SHARE_TTL_DAYS = 365;

/** Create-or-return a stable share for a run (idempotent per {userId, runId}). */
export async function createShare({ userId, runId, shareId }) {
  const ttl = Math.floor(Date.now() / 1000) + SHARE_TTL_DAYS * 86400;
  const Item = { shareId, userId, runId, revoked: false, createdAt: new Date().toISOString(), ttl };
  await ddb.send(new PutCommand({ TableName: TABLES.shares, Item }));
  return Item;
}

export async function getShare(shareId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.shares, Key: { shareId } }));
  return Item || null;
}

/** Remember the run's current public shareId on the run row (idempotent mint). */
export async function setRunShareId(userId, runId, shareId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.runs,
    Key: { userId, runId },
    UpdateExpression: 'SET shareId = :s',
    ExpressionAttributeValues: { ':s': shareId || null },
  }));
}

/** Revoke every share the user minted for a given run (a run has at most one). */
export async function revokeShare(shareId, userId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.shares,
    Key: { shareId },
    // Only the owner can revoke (guards against a guessed shareId revoke).
    ConditionExpression: 'userId = :u',
    UpdateExpression: 'SET revoked = :t',
    ExpressionAttributeValues: { ':u': userId, ':t': true },
  }));
}

// Aggregate per-tool usage COUNTS for a user (operational/billing metadata —
// tool name, run count, credits spent, last used). Paginates the whole runs
// partition with a minimal projection; carries no inputs/results so it's safe
// to expose to staff without a consent grant (counts ≠ content).
export async function toolUsageCounts(userId) {
  const byTool = new Map();
  let total = 0, totalCreditsSpent = 0;
  let ExclusiveStartKey;
  do {
    const { Items, LastEvaluatedKey } = await ddb.send(new QueryCommand({
      TableName: TABLES.runs,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: 'tool, toolName, creditsUsed, ts',
      ExclusiveStartKey,
    }));
    for (const r of Items || []) {
      const key = r.tool || r.toolName || 'unknown';
      const cur = byTool.get(key) || { tool: key, toolName: r.toolName || key, count: 0, credits: 0, lastUsed: null };
      cur.count += 1;
      cur.credits += Number(r.creditsUsed) || 0;
      if (r.ts && (!cur.lastUsed || r.ts > cur.lastUsed)) cur.lastUsed = r.ts;
      if (r.toolName && cur.toolName === key) cur.toolName = r.toolName;
      byTool.set(key, cur);
      total += 1;
      totalCreditsSpent += Number(r.creditsUsed) || 0;
    }
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const tools = [...byTool.values()].sort((a, b) => b.count - a.count);
  return { tools, totalRuns: total, totalCreditsSpent };
}

// ── Assistant chat conversations (persisted thread per user) ─────────────────
const convTitle = (messages) => {
  const first = (messages || []).find((m) => m?.role === 'user' && m.content);
  const t = String(first?.content || 'New conversation').trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 60) + '…' : t;
};

/**
 * Upsert a conversation. New id is minted (timestamp-prefixed → newest-first)
 * when `conversationId` is absent. `messages` is the full thread to store
 * (caller bounds size). Title is derived from the first user turn once and kept.
 */
export async function saveConversation({ userId, conversationId, messages = [], title }) {
  const now = new Date().toISOString();
  let createdAt = now;
  if (conversationId) {
    const existing = await getConversation(userId, conversationId);
    if (existing) { createdAt = existing.createdAt || now; title = title || existing.title; }
  } else {
    conversationId = `${now}#${rid()}`;
  }
  const lastAssistant = [...messages].reverse().find((m) => m?.role === 'assistant');
  const preview = String(lastAssistant?.content || '').slice(0, 120);
  const item = {
    userId, conversationId,
    title: title || convTitle(messages),
    messages, preview, msgCount: messages.length,
    createdAt, updatedAt: now,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.conversations, Item: item }));
  return { conversationId, title: item.title, updatedAt: now };
}

export async function listConversations(userId, limit = 50) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.conversations,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ProjectionExpression: 'userId, conversationId, title, preview, msgCount, createdAt, updatedAt',
    ScanIndexForward: false, // newest first (conversationId is timestamp-prefixed)
    Limit: limit,
  }));
  return Items || [];
}

export async function getConversation(userId, conversationId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.conversations, Key: { userId, conversationId } }));
  return Item || null;
}

export async function deleteConversation(userId, conversationId) {
  await ddb.send(new DeleteCommand({ TableName: TABLES.conversations, Key: { userId, conversationId } }));
}

// ── Support tickets (threaded) ───────────────────────────────────────────────
export async function createTicket({ userId, userEmail, additionalEmails = [], category, subject, message, attachments = [], diagnostics }) {
  const ts = new Date().toISOString();
  const ticketId = `${ts}#${rid()}`;
  const item = {
    userId, ticketId, id: 'TKT-' + rid().toUpperCase(),
    userEmail: userEmail || '', additionalEmails, category: category || 'Other',
    subject, status: 'open', ts, lastActivityAt: ts,
    messages: [{ id: 'm_' + rid(), author: 'user', authorEmail: userEmail || '', body: message, attachments, ts }],
    // Optional structured fault context captured by the Report-a-Fault reporter.
    ...(diagnostics ? { diagnostics } : {}),
  };
  await ddb.send(new PutCommand({ TableName: TABLES.tickets, Item: item }));
  return item;
}

export async function getTicket(userId, ticketId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.tickets, Key: { userId, ticketId } }));
  return Item || null;
}

export async function addTicketMessage({ userId, ticketId, author, authorEmail, body, attachments = [], status }) {
  const t = await getTicket(userId, ticketId);
  if (!t) throw new Error('Ticket not found');
  const msg = { id: 'm_' + rid(), author, authorEmail: authorEmail || '', body, attachments, ts: new Date().toISOString() };
  const messages = [...(t.messages || []), msg];
  const newStatus = status || (author === 'user' ? 'open' : 'answered');
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tickets, Key: { userId, ticketId },
    UpdateExpression: 'SET messages = :m, lastActivityAt = :la, #s = :st',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':m': messages, ':la': msg.ts, ':st': newStatus },
  }));
  return { ticket: { ...t, messages, status: newStatus, lastActivityAt: msg.ts }, message: msg };
}

/** Stamp that we nudged the client, so reminders fire on a cadence rather than
 *  on every scheduler run. Does NOT touch lastActivityAt (a reminder is not
 *  ticket activity — it must not push back the auto-close clock). */
export async function markTicketReminded(userId, ticketId) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tickets, Key: { userId, ticketId },
    UpdateExpression: 'SET lastReminderAt = :r ADD reminderCount :one',
    ExpressionAttributeValues: { ':r': new Date().toISOString(), ':one': 1 },
  }));
}

export async function setTicketStatus(userId, ticketId, status) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tickets, Key: { userId, ticketId },
    UpdateExpression: 'SET #s = :st, lastActivityAt = :la',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':st': status, ':la': new Date().toISOString() },
  }));
}

export async function listTickets(userId, limit = 100) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.tickets,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ProjectionExpression: 'userId, ticketId, id, subject, category, #s, ts, lastActivityAt',
    ExpressionAttributeNames: { '#s': 'status' },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return Items || [];
}

/** Every ticket across all users (scan) — for the admin support console.
 *  Returns summary fields only, newest activity first. */
export async function listAllTickets(limit = 500) {
  const { Items } = await ddb.send(new ScanCommand({
    TableName: TABLES.tickets,
    ProjectionExpression: 'userId, ticketId, id, subject, category, #s, userEmail, ts, lastActivityAt, lastReminderAt',
    ExpressionAttributeNames: { '#s': 'status' },
  }));
  return (Items || [])
    .sort((a, b) => String(b.lastActivityAt || b.ts).localeCompare(String(a.lastActivityAt || a.ts)))
    .slice(0, limit);
}

/** All non-closed tickets (scan) — used by the inactivity auto-close job. */
export async function scanOpenTickets() {
  const { Items } = await ddb.send(new ScanCommand({
    TableName: TABLES.tickets,
    FilterExpression: '#s <> :closed',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':closed': 'closed' },
  }));
  return Items || [];
}

// ── In-platform notifications ────────────────────────────────────────────────
// `link` is an optional in-app path (e.g. "/pricing") the bell navigates to on
// click — used by broadcast notifications that aren't tied to a support ticket.
export async function addNotification({ userId, title, body, ticketId, link }) {
  const ts = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLES.notifications,
    Item: { userId, notifId: `${ts}#${rid()}`, title, body: body || '', ticketId: ticketId || null, link: link || null, read: false, ts },
  }));
}

export async function listNotifications(userId, limit = 50) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.notifications,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return Items || [];
}

export async function markNotificationsRead(userId) {
  // `read` is a DynamoDB reserved word — it MUST be aliased via
  // ExpressionAttributeNames in both the filter and the update, otherwise the
  // service rejects the request with a 400 ValidationException.
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.notifications,
    KeyConditionExpression: 'userId = :u',
    FilterExpression: '#read = :f',
    ExpressionAttributeNames: { '#read': 'read' },
    ExpressionAttributeValues: { ':u': userId, ':f': false },
    Limit: 100,
  }));
  await Promise.all((Items || []).map((n) => ddb.send(new UpdateCommand({
    TableName: TABLES.notifications, Key: { userId, notifId: n.notifId },
    UpdateExpression: 'SET #read = :t',
    ExpressionAttributeNames: { '#read': 'read' },
    ExpressionAttributeValues: { ':t': true },
  }))));
  return (Items || []).length;
}

// ── Integrations connection state (stored on the user record) ────────────────
// In production `connect` completes the Google OAuth handshake and stores the
// refresh token; here we record the connected account id the user supplies.
export async function setIntegration({ userId, provider, account, connected, tokens, clearAccount, email }) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  const integrations = { ...(user.integrations || {}) };
  if (connected === false) {
    delete integrations[provider];
  } else if (clearAccount) {
    // Per-source "disconnect": forget which account this source pulls, but keep
    // the shared family OAuth token so the user can re-pick without re-consenting.
    if (integrations[provider]?.connected) {
      integrations[provider] = { ...integrations[provider], account: '', connectedAt: new Date().toISOString() };
    }
  } else {
    const prev = integrations[provider] || {};
    const enc = { ...(tokens || {}) };
    // Encrypt OAuth tokens before they touch the datastore.
    if (enc.refreshToken) enc.refreshToken = encrypt(enc.refreshToken);
    if (enc.accessToken) enc.accessToken = encrypt(enc.accessToken);
    integrations[provider] = {
      ...prev,
      connected: true,
      account: account != null && account !== '' ? account : (prev.account || ''),
      email: email != null && email !== '' ? email : (prev.email || ''),
      connectedAt: new Date().toISOString(),
      ...enc,
    };
  }
  await putUser({ ...user, integrations, updatedAt: new Date().toISOString() });
  // Never leak OAuth tokens back to the client.
  return redactIntegrations(integrations);
}

/** Strip OAuth tokens before returning integration state to the frontend. */
export function redactIntegrations(integrations = {}) {
  const out = {};
  for (const [k, v] of Object.entries(integrations)) {
    out[k] = { connected: !!v.connected, account: v.account || '', email: v.email || '', connectedAt: v.connectedAt };
  }
  return out;
}

// ── Projects (group runs / keywords / integrations by site) ──────────────────
export async function createProject({ userId, name, domain }) {
  const ts = new Date().toISOString();
  const projectId = `${ts}#${rid()}`;
  const item = { userId, projectId, id: 'PRJ-' + rid().toUpperCase(), name: name || domain || 'Untitled', domain: domain || '', createdAt: ts };
  await ddb.send(new PutCommand({ TableName: TABLES.projects, Item: item }));
  return item;
}
export async function listProjects(userId, limit = 100) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.projects, KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId }, ScanIndexForward: true, Limit: limit,
  }));
  return Items || [];
}
export async function deleteProject(userId, projectId) {
  await ddb.send(new DeleteCommand({ TableName: TABLES.projects, Key: { userId, projectId } }));
}

// ── Tracked keywords (rank position over time, per project) ──────────────────
export async function addTracked({ userId, projectId, keyword, domain, location }) {
  const trackId = `${projectId || 'none'}#${keyword}`;
  const item = { userId, trackId, projectId: projectId || '', keyword, domain: domain || '', location: location || 'Singapore', history: [], addedAt: new Date().toISOString() };
  try {
    await ddb.send(new PutCommand({ TableName: TABLES.tracked, Item: item, ConditionExpression: 'attribute_not_exists(trackId)' }));
  } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
  return item;
}
export async function listTracked(userId, projectId) {
  const { Items } = await ddb.send(new QueryCommand({ TableName: TABLES.tracked, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId } }));
  let items = Items || [];
  if (projectId) items = items.filter((i) => i.projectId === projectId);
  return items;
}
export async function countTracked(userId) { return (await listTracked(userId)).length; }
export async function removeTracked(userId, trackId) {
  await ddb.send(new DeleteCommand({ TableName: TABLES.tracked, Key: { userId, trackId } }));
}
export async function scanTracked() { const { Items } = await ddb.send(new ScanCommand({ TableName: TABLES.tracked })); return Items || []; }
/** Append today's rank position + ranking URL (one point per day; last 120 kept). */
export async function appendSnapshot(userId, trackId, position, url = null) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.tracked, Key: { userId, trackId } }));
  if (!Item) return;
  const date = new Date().toISOString().slice(0, 10);
  const history = (Item.history || []).filter((h) => h.date !== date);
  const point = { date, position };
  if (url) point.url = url;
  history.push(point);
  history.sort((a, b) => a.date.localeCompare(b.date));
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tracked, Key: { userId, trackId },
    UpdateExpression: 'SET history = :h, lastPosition = :p, lastUrl = :u, updatedAt = :t',
    ExpressionAttributeValues: { ':h': history.slice(-120), ':p': position, ':u': url || '', ':t': new Date().toISOString() },
  }));
}

/**
 * Merge backfilled historical points (dated, possibly older than today) into a
 * keyword's history without clobbering existing live points. lastPosition/lastUrl
 * track the most-recent date overall after the merge.
 */
export async function mergeSnapshots(userId, trackId, points) {
  if (!points || !points.length) return;
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.tracked, Key: { userId, trackId } }));
  if (!Item) return;
  const map = new Map();
  for (const h of (Item.history || [])) map.set(h.date, h);
  // Backfill only fills gaps — never overwrite a date we already checked live.
  for (const p of points) {
    if (!p.date || map.has(p.date)) continue;
    const pt = { date: p.date, position: p.position };
    if (p.url) pt.url = p.url;
    map.set(p.date, pt);
  }
  const history = [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-120);
  const last = history[history.length - 1] || {};
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tracked, Key: { userId, trackId },
    UpdateExpression: 'SET history = :h, lastPosition = :p, lastUrl = :u, updatedAt = :t',
    ExpressionAttributeValues: { ':h': history, ':p': last.position ?? 0, ':u': last.url || '', ':t': new Date().toISOString() },
  }));
}

// ── Tool performance metrics (headline scalar over time, per project) ─────────
// One row per (project, tool, metric) — same shape as tracked keywords, so the
// frontend can chart `history` directly. `inputs` is the public run input (the
// integration property + range) the daily cron replays to keep the series live.

/**
 * Append today's value for each extracted metric of a run (one point per metric
 * per day; last 120 kept). `metrics` is the array from extractMetrics(); a run
 * with no metrics is a no-op. Best-effort per metric — one bad write never sinks
 * the others. `inputs` lets the cron re-pull integration metrics later.
 */
export async function appendMetricSnapshots(userId, ctx, metrics) {
  if (!metrics || !metrics.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await Promise.all(metrics.map(async (m) => {
    const metricId = `${ctx.projectId || 'none'}#${ctx.tool}#${m.key}`;
    try {
      const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.metrics, Key: { userId, metricId } }));
      const history = (Item?.history || []).filter((h) => h.date !== date);
      history.push({ date, value: m.value });
      history.sort((a, b) => a.date.localeCompare(b.date));
      await ddb.send(new PutCommand({
        TableName: TABLES.metrics,
        Item: {
          userId, metricId,
          projectId: ctx.projectId || '',
          tool: ctx.tool,
          toolName: ctx.toolName || ctx.tool,
          metricKey: m.key,
          label: m.label,
          unit: m.unit || '',
          dir: m.dir || 'up',
          target: ctx.target || '',
          inputs: ctx.inputs || {},
          history: history.slice(-120),
          lastValue: m.value,
          updatedAt: now,
          addedAt: Item?.addedAt || now,
        },
      }));
    } catch (e) { console.error('metric_snapshot_failed', metricId, e.message); }
  }));
}

export async function listMetrics(userId, projectId) {
  const { Items } = await ddb.send(new QueryCommand({ TableName: TABLES.metrics, KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId } }));
  let items = Items || [];
  if (projectId) items = items.filter((i) => i.projectId === projectId);
  return items;
}

export async function scanMetrics() { const { Items } = await ddb.send(new ScanCommand({ TableName: TABLES.metrics })); return Items || []; }

// ── Upstream result cache (cuts cost + latency on repeat queries) ─────────────
// Keyed by a hash of tool + inputs; rows self-expire via DynamoDB TTL.
export async function getCache(key) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.cache, Key: { key } }));
  if (!Item) return null;
  if (Item.expireAt && Item.expireAt * 1000 < Date.now()) return null; // TTL not yet swept
  return Item.value ?? null;
}
export async function putCache(key, value, ttlSeconds) {
  await ddb.send(new PutCommand({
    TableName: TABLES.cache,
    Item: { key, value, expireAt: Math.floor(Date.now() / 1000) + ttlSeconds },
  }));
}

/** Invalidate all of a user's refresh tokens ("sign out everywhere") by bumping
 * their token version + clearing the session registry. Returns the new version. */
export async function bumpTokenVersion(userId) {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'ADD tokenVersion :one SET updatedAt = :now REMOVE sessions',
    ExpressionAttributeValues: { ':one': 1, ':now': new Date().toISOString() },
    ReturnValues: 'UPDATED_NEW',
  }));
  return res.Attributes?.tokenVersion ?? 0;
}

// ── Concurrent-session cap (anti account-sharing) ────────────────────────────
// Active sessions are tracked on the user record (tiny list, capped). All writes
// touch ONLY the `sessions` attribute so they never clobber credits etc.
export const MAX_SESSIONS = 3;

/** Register a new login session, evicting the oldest beyond MAX_SESSIONS. */
export async function addSession({ userId, sid, device, ip }) {
  const user = await getUser(userId);
  if (!user) return [];
  const now = new Date().toISOString();
  const list = (user.sessions || []).filter((s) => s.sid !== sid);
  list.push({ sid, device: device || 'Unknown device', ip: ip || '', createdAt: now, lastSeenAt: now });
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); // newest first
  const sessions = list.slice(0, MAX_SESSIONS); // keep the newest N → oldest evicted
  // `lastLoginAt` is bumped here (the single per-login choke point — issueSession
  // calls addSession once for Google/password/verify/reset) so the audience
  // filter can target dormant users. Forward-only: there's no login history to
  // recover, but the activity backfill seeds it from the newest session.
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET sessions = :s, updatedAt = :now, lastLoginAt = :now',
    ExpressionAttributeValues: { ':s': sessions, ':now': now },
  }));
  return sessions;
}

/** True if sid is still an active session; bumps its lastSeenAt (best-effort). */
export async function validateSession(userId, sid) {
  const user = await getUser(userId);
  if (!user) return false;
  const sessions = user.sessions || [];
  const idx = sessions.findIndex((s) => s.sid === sid);
  if (idx === -1) return false;
  sessions[idx] = { ...sessions[idx], lastSeenAt: new Date().toISOString() };
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLES.users, Key: { userId },
      UpdateExpression: 'SET sessions = :s',
      ExpressionAttributeValues: { ':s': sessions },
    }));
  } catch { /* touch is best-effort */ }
  return true;
}

/** Revoke a single session (sign out one device). */
export async function revokeSession(userId, sid) {
  const user = await getUser(userId);
  if (!user) return;
  const sessions = (user.sessions || []).filter((s) => s.sid !== sid);
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET sessions = :s, updatedAt = :now',
    ExpressionAttributeValues: { ':s': sessions, ':now': new Date().toISOString() },
  }));
}

// ── Consent-gated admin access ───────────────────────────────────────────────
// Staff can only view a user's tool usage / conversations AFTER the user grants
// access. Grants live on the user record (touched atomically). A granted request
// is time-boxed and the user can revoke it any time.
const ACCESS_TTL_DAYS = 7;

/** Staff requests access to a user's activity → a pending grant + notify them. */
export async function requestAccess({ userId, requestedBy, reason }) {
  const user = await getUser(userId);
  if (!user) return null;
  const grant = { id: rid(), status: 'pending', requestedBy: requestedBy || 'staff', reason: String(reason || '').slice(0, 300), requestedAt: new Date().toISOString() };
  const grants = [grant, ...(user.accessGrants || [])].slice(0, 15);
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET accessGrants = :g, updatedAt = :now',
    ExpressionAttributeValues: { ':g': grants, ':now': new Date().toISOString() },
  }));
  return grant;
}

/** User responds to a request: grant (time-boxed), deny, or revoke. */
export async function respondAccess({ userId, id, action, days = ACCESS_TTL_DAYS }) {
  const user = await getUser(userId);
  if (!user) return null;
  const now = new Date().toISOString();
  const status = action === 'grant' ? 'granted' : action === 'deny' ? 'denied' : 'revoked';
  const grants = (user.accessGrants || []).map((g) => (g.id === id
    ? { ...g, status, decidedAt: now, expiresAt: status === 'granted' ? new Date(Date.now() + days * 86400000).toISOString() : null }
    : g));
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET accessGrants = :g, updatedAt = :now',
    ExpressionAttributeValues: { ':g': grants, ':now': now },
  }));
  return grants.find((g) => g.id === id) || null;
}

/** The active (granted, non-expired) access grant on a user, or null. */
export function activeAccess(user) {
  const now = new Date().toISOString();
  return (user?.accessGrants || []).find((g) => g.status === 'granted' && (!g.expiresAt || g.expiresAt > now)) || null;
}

export async function listAccessGrants(userId) {
  return (await getUser(userId))?.accessGrants || [];
}

// ── Account data export + erasure (GDPR portability / right to be forgotten) ──

/** Gather everything we hold about a user into one JSON-able object. OAuth
 * tokens are redacted (they're encrypted secrets, not user-portable data). */
export async function exportAllUserData(userId) {
  const user = await getUser(userId);
  const [ledger, runs, tickets, notifications, projects, tracked, conversations] = await Promise.all([
    listLedger(userId, 1000), listRuns(userId, 1000), listTickets(userId, 1000),
    listNotifications(userId, 1000), listProjects(userId, 1000), listTracked(userId),
    listConversations(userId, 1000),
  ]);
  const { integrations, ...profile } = user || {}; // drop OAuth tokens
  return { exportedAt: new Date().toISOString(), profile, ledger, runs, tickets, notifications, projects, tracked, conversations };
}

/** Hard-delete every row we hold for a user across all tables, then the user
 * record itself. Caller handles S3 attachments + Stripe separately. */
export async function deleteAllUserData(userId) {
  const tables = [
    [TABLES.ledger, 'ts'],
    [TABLES.runs, 'runId'],
    [TABLES.tickets, 'ticketId'],
    [TABLES.notifications, 'notifId'],
    [TABLES.projects, 'projectId'],
    [TABLES.tracked, 'trackId'],
    [TABLES.conversations, 'conversationId'],
  ];
  for (const [TableName, rk] of tables) {
    let ExclusiveStartKey;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName,
        KeyConditionExpression: '#u = :u',
        ProjectionExpression: '#u, #rk',
        ExpressionAttributeNames: { '#u': 'userId', '#rk': rk },
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey,
      }));
      const items = res.Items || [];
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25).map((it) => ({ DeleteRequest: { Key: { userId, [rk]: it[rk] } } }));
        if (batch.length) await ddb.send(new BatchWriteCommand({ RequestItems: { [TableName]: batch } }));
      }
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  await ddb.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId } }));
}

// ── Broadcast notifications (admin → filtered audience) ──────────────────────
// Real, sign-in-able accounts only — drops the settings singleton AND unlinked
// `pending:` invites (no session/inbox of their own yet). This is the pool the
// audience filter runs over; at MVP volume a full scan is fine (same call the
// monthly refill already makes).
export async function audienceCandidates() {
  return (await scanAllUsers()).filter((u) => !u.provision && !String(u.userId || '').startsWith('pending:'));
}

/** Set/clear a user's product-email opt-out (atomic, single attribute). Used by
 *  the one-click unsubscribe link and the Account email-preference toggle. */
export async function setEmailOptOut(userId, value) {
  await ddb.send(new UpdateCommand({
    TableName: TABLES.users, Key: { userId },
    UpdateExpression: 'SET notifyEmailOptOut = :v, updatedAt = :now',
    ConditionExpression: 'attribute_exists(userId)',
    ExpressionAttributeValues: { ':v': !!value, ':now': new Date().toISOString() },
  })).catch((e) => { if (e.name !== 'ConditionalCheckFailedException') throw e; });
}

/** Newest run timestamp for a user (or null) — the source the activity backfill
 *  uses to seed lastToolUseAt on accounts that ran tools before tracking began. */
export async function latestRunTs(userId) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.runs,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    ProjectionExpression: 'ts',
    ScanIndexForward: false, // newest first (runId is timestamp-prefixed)
    Limit: 1,
  }));
  return Items?.[0]?.ts || null;
}

/** One-time backfill: derive lastLoginAt (from the newest session),
 *  lastToolUseAt (from the newest run) and creditsSpentTotal (summed over run
 *  history) for every account that lacks them, so the audience filters and the
 *  admin "credits used" column are useful from day one rather than only going
 *  forward. Only fills gaps — never overwrites a live value. Returns a summary. */
export async function backfillActivity() {
  const users = await audienceCandidates();
  let loginFilled = 0, toolFilled = 0, creditsFilled = 0;
  for (const u of users) {
    const patch = {};
    if (!u.lastLoginAt) {
      // Newest session's last-seen (fallback created) time, if any.
      const newest = (u.sessions || []).map((s) => s.lastSeenAt || s.createdAt).filter(Boolean).sort().pop();
      if (newest) patch.lastLoginAt = newest;
    }
    if (!u.lastToolUseAt) {
      const ts = await latestRunTs(u.userId);
      if (ts) patch.lastToolUseAt = ts;
    }
    if (u.creditsSpentTotal == null) {
      // Sum lifetime spend from the run ledger (one-time scan; cheap at MVP
      // volume). Seeded to 0 even with no runs so future spends increment from a
      // known base rather than re-triggering this branch.
      const { totalCreditsSpent } = await toolUsageCounts(u.userId);
      patch.creditsSpentTotal = totalCreditsSpent || 0;
    }
    if (!Object.keys(patch).length) continue;
    const names = Object.keys(patch);
    await ddb.send(new UpdateCommand({
      TableName: TABLES.users, Key: { userId: u.userId },
      UpdateExpression: 'SET ' + names.map((k, i) => `${k} = :v${i}`).join(', '),
      ExpressionAttributeValues: Object.fromEntries(names.map((k, i) => [`:v${i}`, patch[k]])),
    }));
    if (patch.lastLoginAt) loginFilled++;
    if (patch.lastToolUseAt) toolFilled++;
    if (patch.creditsSpentTotal) creditsFilled++;
  }
  return { scanned: users.length, loginFilled, toolFilled, creditsFilled };
}

/** Append a broadcast audit row (who sent what, to whom, on which channels).
 *  Constant partition key so the whole log is one ordered query, newest first. */
export async function recordBroadcast(entry) {
  const ts = new Date().toISOString();
  const item = { pk: 'broadcast', broadcastId: `${ts}#${rid()}`, ts, ...entry };
  await ddb.send(new PutCommand({ TableName: TABLES.broadcasts, Item: item }));
  return item;
}

export async function listBroadcasts(limit = 50) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.broadcasts,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'broadcast' },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return Items || [];
}

export { ddb };
