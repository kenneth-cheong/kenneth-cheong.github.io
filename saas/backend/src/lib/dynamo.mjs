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
  conversations: process.env.CONVERSATIONS_TABLE,
};

const rid = () => Math.random().toString(36).slice(2, 8);

export async function getUser(userId) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId } })
  );
  return Item || null;
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
  await ddb.send(new PutCommand({ TableName: TABLES.users, Item: item }));
  return user;
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
          UpdateExpression:
            'SET credits = :nm, topupCredits = :nt, updatedAt = :now',
          // Optimistic lock: only commit if neither bucket changed since read.
          ConditionExpression: 'credits = :om AND topupCredits = :ot',
          ExpressionAttributeValues: {
            ':nm': monthly - fromMonthly,
            ':nt': topup - fromTopup,
            ':om': monthly,
            ':ot': topup,
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
  return out;
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
  return Items || [];
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
export async function createTicket({ userId, userEmail, additionalEmails = [], category, subject, message, attachments = [] }) {
  const ts = new Date().toISOString();
  const ticketId = `${ts}#${rid()}`;
  const item = {
    userId, ticketId, id: 'TKT-' + rid().toUpperCase(),
    userEmail: userEmail || '', additionalEmails, category: category || 'Other',
    subject, status: 'open', ts, lastActivityAt: ts,
    messages: [{ id: 'm_' + rid(), author: 'user', authorEmail: userEmail || '', body: message, attachments, ts }],
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
    ProjectionExpression: 'userId, ticketId, id, subject, category, #s, userEmail, ts, lastActivityAt',
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
export async function addNotification({ userId, title, body, ticketId }) {
  const ts = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLES.notifications,
    Item: { userId, notifId: `${ts}#${rid()}`, title, body: body || '', ticketId: ticketId || null, read: false, ts },
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
export async function setIntegration({ userId, provider, account, connected, tokens }) {
  const user = await getUser(userId);
  if (!user) throw new Error('User not found');
  const integrations = { ...(user.integrations || {}) };
  if (connected === false) {
    delete integrations[provider];
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
    out[k] = { connected: !!v.connected, account: v.account || '', connectedAt: v.connectedAt };
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

export { ddb };
