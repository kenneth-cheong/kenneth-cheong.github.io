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
        // Sort key is time-first + disambiguated; `at` is the clean ISO for display.
        ts: `${now}#${Math.abs(delta)}#${tool || action}`,
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
export async function saveRun({ userId, tool, toolName, inputs, result, creditsUsed = 0, projectId = null }) {
  const ts = new Date().toISOString();
  const runId = `${ts}#${Math.random().toString(36).slice(2, 8)}`;
  const preview = result?.text ? result.text.slice(0, 90)
    : Array.isArray(result?.rows) ? `${result.rows.length} rows`
    : result?.html ? 'report' : '';
  await ddb.send(new PutCommand({
    TableName: TABLES.runs,
    Item: { userId, runId, tool, toolName: toolName || tool, inputs: inputs || {}, result: result || {}, preview, creditsUsed, projectId, ts },
  }));
  return { runId, ts };
}

export async function listRuns(userId, limit = 100) {
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.runs,
    KeyConditionExpression: 'userId = :u',
    ExpressionAttributeValues: { ':u': userId },
    // Slim projection for the list — omit the full `result` + `inputs` payloads.
    ProjectionExpression: 'userId, runId, tool, toolName, preview, creditsUsed, projectId, ts',
    ScanIndexForward: false,
    Limit: limit,
  }));
  return Items || [];
}

export async function getRun(userId, runId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.runs, Key: { userId, runId } }));
  return Item || null;
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
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLES.notifications,
    KeyConditionExpression: 'userId = :u',
    FilterExpression: 'read = :f',
    ExpressionAttributeValues: { ':u': userId, ':f': false },
    Limit: 100,
  }));
  await Promise.all((Items || []).map((n) => ddb.send(new UpdateCommand({
    TableName: TABLES.notifications, Key: { userId, notifId: n.notifId },
    UpdateExpression: 'SET read = :t', ExpressionAttributeValues: { ':t': true },
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
/** Append today's rank position (one point per day; last 120 kept). */
export async function appendSnapshot(userId, trackId, position) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLES.tracked, Key: { userId, trackId } }));
  if (!Item) return;
  const date = new Date().toISOString().slice(0, 10);
  const history = (Item.history || []).filter((h) => h.date !== date);
  history.push({ date, position });
  history.sort((a, b) => a.date.localeCompare(b.date));
  await ddb.send(new UpdateCommand({
    TableName: TABLES.tracked, Key: { userId, trackId },
    UpdateExpression: 'SET history = :h, lastPosition = :p, updatedAt = :t',
    ExpressionAttributeValues: { ':h': history.slice(-120), ':p': position, ':t': new Date().toISOString() },
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
