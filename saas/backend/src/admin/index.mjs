// Admin portal API (all routes gated to staff — ADMIN_EMAILS allowlist OR a
// per-user role: 'staff' flag):
//   GET  /admin/users                        -> list all users + invited accounts
//   POST /admin/users  { email, name?, role?, tier?, credits?, sendInvite? }
//                                            -> provision a client/staff account
//   POST /admin/credits { userId, monthlyDelta?, topupDelta?, reason }
//   POST /admin/tier    { userId, tier }     -> override tier + reset allowance
//   GET  /admin/promos                       -> discount codes (from Stripe)
//   POST /admin/promos { code, percentOff|amountOff, duration, scope, ... }
//   POST /admin/promos/archive { id, active } -> deactivate / reactivate a code
//   POST /admin/role    { userId, role }     -> promote/demote client <-> staff
//                                            (promoting to staff requires a true
//                                            admin — ADMIN_EMAILS — not just any staff)
import {
  getUser,
  listAllUsers,
  createProvision,
  adminAdjustCredits,
  adminSetTier,
  adminSetStatus,
  adminSetRole,
  totalCredits,
  requestAccess,
  listAccessGrants,
  activeAccess,
  listRuns,
  listConversations,
  getConversation,
  toolUsageCounts,
  addNotification,
  getSettings,
  updateSettings,
  listTicketTemplates,
  saveTicketTemplate,
  deleteTicketTemplate,
  audienceCandidates,
  recordBroadcast,
  listBroadcasts,
  backfillActivity,
  scanAllUsers,
  creditsConsumed,
  setFreeAccessEndsAt,
  setAccessNotice,
} from '../lib/dynamo.mjs';
import { PLANS } from '../../../shared/catalog.mjs';
import { isAdmin, isStaff, ACCOUNT_STATUSES } from '../lib/admin.mjs';
import { accessState } from '../lib/access.mjs';
import { amplifyUsage, amplifyAccessLogs, toolSpendBySource, llmSpendByProvider, anthropicCostReport, anthropicUsageReport, deepseekBalance, toolCostBreakdown } from '../lib/platform-usage.mjs';
import { financeReport } from '../lib/finances.mjs';
import { listPromos, createPromo, updatePromo } from '../lib/promos.mjs';
import { sendEmail } from '../lib/email.mjs';
import { sendInviteEmail } from '../lib/invite-email.mjs';
import { putBroadcastImage } from '../lib/s3.mjs';
import { signUnsubToken } from '../lib/jwt.mjs';
import { ok, badRequest, unauthorized, serverError, json, parseBody, claims, isEmail, clampStr } from '../lib/http.mjs';

const APP_ORIGIN = (process.env.APP_ORIGIN || '').replace(/\/$/, '');

// Hard ceiling on a single broadcast's audience — a backstop against an
// accidental "send to everyone" blowing the Lambda budget / SES quota. Far above
// any realistic list at MVP volume; surfaced to the caller when it bites.
const MAX_AUDIENCE = 5000;
// SES send concurrency — keep well under the account's per-second rate so a big
// broadcast doesn't trip throttling.
const EMAIL_CONCURRENCY = 8;

export const handler = async (event) => {
  try {
  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const me = await getUser(c.userId);
  if (!isStaff(me)) return json(403, { error: 'admin_only' });

  const path = event.rawPath || '';
  const method = event.requestContext?.http?.method || 'GET';
  const q = event.queryStringParameters || {};

  if (method === 'GET' && path.endsWith('/users')) {
    const users = (await listAllUsers()).map(shape);
    return ok({ users });
  }

  // Platform-wide settings (e.g. whether email/password sign-in is allowed).
  if (method === 'GET' && path.endsWith('/admin/settings')) {
    return ok({ settings: await getSettings() });
  }

  // ── Support-ticket reply templates (canned messages) ───────────────────────
  // Shared across staff: any staff member (already gated above) can list, create,
  // edit, and delete them, then insert one into a ticket reply. Hosted on AdminFn
  // rather than AppFn because AppFn's Lambda resource policy is at the 20KB route
  // ceiling and can't take more routes.
  if (method === 'GET' && path.endsWith('/admin/ticket-templates')) {
    return ok({ templates: await listTicketTemplates() });
  }
  if (method === 'POST' && path.endsWith('/admin/ticket-templates/delete')) {
    // `body` (the shared parse) isn't declared until further down — parse locally.
    const tb = parseBody(event);
    const id = clampStr(tb.id, 60).trim();
    if (!id) return badRequest('Template id is required.');
    return ok(await deleteTicketTemplate({ id, editorEmail: c.email }));
  }
  if (method === 'POST' && path.endsWith('/admin/ticket-templates')) {
    const tb = parseBody(event);
    const title = clampStr((tb.title || '').trim(), 120);
    const text = clampStr((tb.body || '').trim(), 10000);
    if (!title || !text) return badRequest('Template title and message are required.');
    const id = tb.id ? clampStr(tb.id, 60).trim() : undefined;
    try {
      return ok(await saveTicketTemplate({ id, title, body: text, editorEmail: c.email }));
    } catch (e) { return badRequest(e.message || 'Could not save the template.'); }
  }

  // ── Promo codes ────────────────────────────────────────────────────────────
  // Create/list/deactivate discount codes without anyone needing a Stripe
  // dashboard login. Stripe holds the objects; see lib/promos.mjs for why.
  if (method === 'GET' && path.endsWith('/admin/promos')) {
    try {
      return ok({ promos: await listPromos() });
    } catch (e) {
      console.error('promos_list', e.message);
      return badRequest(e.message || 'Could not load promo codes.');
    }
  }
  if (method === 'POST' && path.endsWith('/admin/promos/archive')) {
    const pb = parseBody(event);
    const id = clampStr(pb.id, 80).trim();
    if (!id) return badRequest('Promo id is required.');
    try {
      // `active` is the only field Stripe lets us flip, so this doubles as the
      // reactivate route.
      return ok({ promo: await updatePromo(id, { active: !!pb.active }) });
    } catch (e) { return badRequest(e.message || 'Could not update the promo code.'); }
  }
  if (method === 'POST' && path.endsWith('/admin/promos')) {
    const pb = parseBody(event);
    try {
      return ok({ promo: await createPromo({ ...pb, code: clampStr(pb.code, 40), createdBy: c.email }) });
    } catch (e) { return badRequest(e.message || 'Could not create the promo code.'); }
  }

  // ── Broadcast notifications ────────────────────────────────────────────────
  // Past broadcasts (audit log) for the Notifications tab history.
  if (method === 'GET' && path.endsWith('/admin/notifications/history')) {
    return ok({ broadcasts: await listBroadcasts(50) });
  }

  // Per-tool usage COUNTS for a user — operational/billing metadata, not
  // content, so it's available without a consent grant (like credit totals).
  if (method === 'GET' && path.endsWith('/admin/usage')) {
    if (!q.userId) return badRequest('userId required');
    return ok(await toolUsageCounts(q.userId));
  }

  // ── Platform (Amplify Hosting) usage ───────────────────────────────────────
  // Infrastructure-level operational metrics (traffic, cost, builds) for the
  // hosting app itself — not any user's content — so it's staff-visible like the
  // usage counts above. The date range is caller-controlled (from/to or days).
  if (method === 'GET' && path.endsWith('/admin/platform/usage')) {
    let range;
    try { range = parseRange(q); } catch (e) { return badRequest(e.message); }
    try {
      return ok(await amplifyUsage(range));
    } catch (e) {
      console.error('platform_usage_error', e);
      return serverError(e.message || 'Could not load Amplify usage.');
    }
  }
  // Per-front-end tool runs + estimated vendor spend (SaaS dashboard vs the
  // legacy index.html tools) over the window, from the shared Digimetrics/Usage
  // metric. A single CloudWatch GetMetricData read — no Cost Explorer, so free.
  if (method === 'GET' && path.endsWith('/admin/platform/tool-spend')) {
    let range;
    try { range = parseRange(q); } catch (e) { return badRequest(e.message); }
    try {
      return ok(await toolSpendBySource(range));
    } catch (e) {
      console.error('tool_spend_error', e);
      return serverError(e.message || 'Could not load per-product tool spend.');
    }
  }
  // Per-provider LLM usage (Claude vs DeepSeek token + estimated $) over the
  // window, from the fleet-wide Digimetrics/LLM metric. One CloudWatch read.
  if (method === 'GET' && path.endsWith('/admin/platform/llm-usage')) {
    let range;
    try { range = parseRange(q); } catch (e) { return badRequest(e.message); }
    try {
      // Our token-based estimate + (if an admin key is configured) Anthropic's
      // authoritative cost for the same window. The reconciliation never blocks
      // the estimate — a failure there just omits the `authoritative` field.
      const [usage, authoritative, anthropicUsage, deepseek] = await Promise.all([
        llmSpendByProvider(range),
        anthropicCostReport(range).catch((e) => ({ configured: false, error: e.message })),
        // Authoritative per-MODEL token counts (the cost report can't group by
        // model) + DeepSeek's real remaining credit. Both optional.
        anthropicUsageReport(range).catch((e) => ({ configured: false, error: e.message })),
        deepseekBalance().catch((e) => ({ configured: false, error: e.message })),
      ]);
      return ok({ ...usage, authoritative, anthropicUsage, deepseek });
    } catch (e) {
      console.error('llm_usage_error', e);
      return serverError(e.message || 'Could not load LLM usage.');
    }
  }
  // Per-tool LLM cost, split by platform. Logs Insights rather than a metric
  // dimension — see toolCostBreakdown for why (dimension cost > spend measured).
  // Seconds-long scan, so it's on-demand like the access-log route below.
  if (method === 'GET' && path.endsWith('/admin/platform/tool-cost')) {
    let range;
    try { range = parseRange(q, { maxDays: 31 }); } catch (e) { return badRequest(e.message); }
    try {
      return ok(await toolCostBreakdown({ ...range, chatStreamLogGroup: process.env.CHATSTREAM_LOG_GROUP || '' }));
    } catch (e) {
      console.error('tool_cost_error', e);
      return serverError(e.message || 'Could not load per-tool cost.');
    }
  }
  // Per-request access-log breakdowns (top pages, referrers, devices, edge geo,
  // cache-hit ratio). Heavier — an on-demand log export + parse — so it's its own
  // route the UI only hits when the operator opens the panel. Window is capped.
  if (method === 'GET' && path.endsWith('/admin/platform/access-logs')) {
    let range;
    try { range = parseRange(q, { maxDays: 31 }); } catch (e) { return badRequest(e.message); }
    try {
      return ok(await amplifyAccessLogs(range));
    } catch (e) {
      console.error('platform_access_logs_error', e);
      return serverError(e.message || 'Could not load access logs.');
    }
  }

  // ── Finances (balance sheet: cost vs revenue) ──────────────────────────────
  // Company-level P&L for the window: Stripe revenue vs AWS spend + an estimated
  // AI/data COGS line, all in USD. Like the platform + usage routes,
  // this is operational/business metadata (no user's private content), so it's
  // staff-visible. Each load runs one Cost Explorer query (~US$0.01) + a few
  // Stripe list calls.
  if (method === 'GET' && path.endsWith('/admin/finances')) {
    let range;
    try { range = parseRange(q); } catch (e) { return badRequest(e.message); }
    try {
      const [users, consumed] = await Promise.all([scanAllUsers(), creditsConsumed(range)]);
      return ok(await financeReport({ ...range, users, consumed }));
    } catch (e) {
      console.error('finances_error', e);
      return serverError(e.message || 'Could not load finances.');
    }
  }

  // ── Consent-gated access to a user's activity ──────────────────────────────
  // GET access status for a user (what grants exist).
  if (method === 'GET' && path.endsWith('/admin/access')) {
    if (!q.userId) return badRequest('userId required');
    return ok({ grants: await listAccessGrants(q.userId) });
  }
  // Read a user's runs / conversations — ONLY if they have an active grant.
  if (method === 'GET' && path.endsWith('/admin/activity')) {
    if (!q.userId) return badRequest('userId required');
    const target = await getUser(q.userId);
    if (!target) return badRequest('User not found');
    if (!activeAccess(target)) return json(403, { error: 'no_consent', message: 'This user has not granted access. Request it and wait for them to allow it.' });
    // Audit every cross-user view.
    console.log(JSON.stringify({ audit: 'admin_view', admin: c.email, target: q.userId, kind: q.kind || 'runs', id: q.id || null, at: new Date().toISOString() }));
    if (q.kind === 'conversations') return ok({ conversations: await listConversations(q.userId, 50) });
    if (q.kind === 'conversation') { const conv = await getConversation(q.userId, q.id); return conv ? ok({ conversation: conv }) : badRequest('Not found'); }
    return ok({ runs: await listRuns(q.userId, 100) });
  }

  const body = parseBody(event);

  // Staff requests access to a user's activity (creates a pending grant + notifies them).
  if (method === 'POST' && path.endsWith('/admin/access')) {
    if (!body.userId) return badRequest('userId required');
    const target = await getUser(body.userId);
    if (!target) return badRequest('User not found');
    const grant = await requestAccess({ userId: body.userId, requestedBy: c.email, reason: body.reason });
    await addNotification({
      userId: body.userId,
      title: 'Support is requesting data access',
      body: `A staff member asked to view your tool usage & conversations${body.reason ? ` ("${String(body.reason).slice(0, 80)}")` : ''}. Review under Account → Data access.`,
    });
    return ok({ grant });
  }

  // Preview an audience: how many (and a sample of who) a filter would reach.
  // Never sends — staff always eyeball the count before a real broadcast.
  if (method === 'POST' && path.endsWith('/admin/notifications/preview')) {
    const { matched } = await resolveAudience(body.filter);
    return ok({
      count: matched.length,
      capped: matched.length > MAX_AUDIENCE,
      maxAudience: MAX_AUDIENCE,
      sample: matched.slice(0, 25).map(audienceRow),
    });
  }

  // Upload an image for a broadcast (stored in the public broadcast bucket).
  if (method === 'POST' && path.endsWith('/admin/notifications/upload')) {
    try {
      const image = await putBroadcastImage({ name: body.name, contentType: body.contentType, dataBase64: body.data });
      return ok({ image });
    } catch (e) {
      return badRequest(e.message || 'Could not upload the image.');
    }
  }

  // Send a broadcast to the filtered audience over the chosen channels.
  if (method === 'POST' && path.endsWith('/admin/notifications/send')) {
    const title = clampStr(body.title, 120).trim();
    const messageBody = clampStr(body.body, 2000).trim();
    const link = body.link ? clampStr(body.link, 300).trim() : '';
    const channels = body.channels || {};
    const wantInApp = channels.inApp !== false; // default on
    const wantEmail = channels.email === true;
    if (!title) return badRequest('A title is required.');
    if (!messageBody) return badRequest('A message body is required.');
    if (!wantInApp && !wantEmail) return badRequest('Pick at least one channel.');
    // Only an in-app deep link is followed by the bell; reject external/unsafe.
    if (link && !link.startsWith('/')) return badRequest('Link must be an in-app path starting with “/”.');

    const { matched } = await resolveAudience(body.filter);
    if (!matched.length) return badRequest('That filter matches no users. Adjust it and preview again.');
    if (matched.length > MAX_AUDIENCE) return badRequest(`Audience too large (${matched.length} > ${MAX_AUDIENCE}). Narrow the filter.`);

    const result = await deliverBroadcast({ recipients: matched, title, body: messageBody, link, wantInApp, wantEmail });
    const record = await recordBroadcast({
      sentBy: c.email,
      title, body: messageBody, link: link || null,
      filter: body.filter || {},
      channels: { inApp: wantInApp, email: wantEmail },
      audienceCount: matched.length,
      ...result,
    });
    console.log(JSON.stringify({ audit: 'admin_broadcast', admin: c.email, audienceCount: matched.length, ...result, at: new Date().toISOString() }));
    return ok({ broadcast: record });
  }

  // One-time (re-runnable) backfill: seed lastLoginAt / lastToolUseAt from
  // existing sessions + run history so the date filters work on day one.
  if (method === 'POST' && path.endsWith('/admin/notifications/backfill')) {
    const summary = await backfillActivity();
    console.log(JSON.stringify({ audit: 'admin_activity_backfill', admin: c.email, ...summary, at: new Date().toISOString() }));
    return ok(summary);
  }

  // Flip a platform setting. Restricted to true admins (ADMIN_EMAILS), not just
  // staff — this gates everyone's ability to sign in.
  if (method === 'POST' && path.endsWith('/admin/settings')) {
    if (!isAdmin(me.email)) return json(403, { error: 'admin_only' });
    const patch = {};
    if (typeof body.passwordAuthEnabled === 'boolean') patch.passwordAuthEnabled = body.passwordAuthEnabled;
    // Additive on top of email+password — stored independently, but only takes
    // effect while passwordAuthEnabled is on (see /auth/config).
    if (typeof body.usernameAuthEnabled === 'boolean') patch.usernameAuthEnabled = body.usernameAuthEnabled;
    // Ticket lifecycle: whole days, 0 disables, capped at a year to avoid typos.
    for (const key of ['ticketReminderDays', 'ticketAutoCloseDays']) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < 0 || n > 365) return badRequest(`${key} must be a whole number of days between 0 and 365.`);
      patch[key] = n;
    }
    // Renewal reminders: a list of "days before" values. Empty list disables the
    // feature. updateSettings/viewSettings dedupe + sort; validate the range here.
    if (body.renewalReminderDays !== undefined) {
      const arr = body.renewalReminderDays;
      if (!Array.isArray(arr)) return badRequest('renewalReminderDays must be a list of days.');
      if (arr.length > 8) return badRequest('At most 8 renewal reminder days.');
      if (arr.some((x) => { const n = Number(x); return !Number.isInteger(n) || n < 0 || n > 365; })) {
        return badRequest('Each renewal reminder day must be a whole number between 0 and 365.');
      }
      patch.renewalReminderDays = arr.map(Number);
    }
    // Proactive-assistant config (Admin → Assistant). Stored as-is; updateSettings
    // normalizes/validates the nested shape before persisting.
    if (body.proactive && typeof body.proactive === 'object') patch.proactive = body.proactive;
    if (!Object.keys(patch).length) return badRequest('No valid setting provided.');
    const settings = await updateSettings(patch, c.email);
    console.log(JSON.stringify({ audit: 'admin_settings', admin: c.email, patch, at: new Date().toISOString() }));
    return ok({ settings });
  }

  if (method === 'POST' && path.endsWith('/users')) {
    const email = String(body.email || '').trim();
    if (!isEmail(email)) return badRequest('A valid email is required.');
    const role = body.role === 'staff' ? 'staff' : 'client';
    const tier = PLANS[body.tier] ? body.tier : 'free';
    const credits = Number.isFinite(Number(body.credits)) ? Math.max(0, Number(body.credits)) : PLANS[tier].monthlyCredits;
    const provision = await createProvision({ email, name: (body.name || '').trim(), role, tier, credits, invitedBy: c.email });
    if (body.sendInvite) {
      // Branded "your account is ready" notice via the authenticated SMTP path
      // (support@digimetrics.ai), same as the other transactional emails.
      // Best-effort: a mail failure must never fail the provisioning call.
      await sendInviteEmail({ email, name: body.name, role }, { appOrigin: APP_ORIGIN })
        .catch((e) => console.error('invite_email', email, e.message));
    }
    return ok({ user: shape(provision) });
  }

  if (path.endsWith('/credits')) {
    if (!body.userId) return badRequest('userId required');
    const res = await adminAdjustCredits({
      userId: body.userId,
      monthlyDelta: Number(body.monthlyDelta) || 0,
      topupDelta: Number(body.topupDelta) || 0,
      adminEmail: c.email,
      reason: body.reason,
    });
    return ok(res);
  }
  if (path.endsWith('/tier')) {
    if (!body.userId || !PLANS[body.tier]) return badRequest('userId + valid tier required');
    const user = await adminSetTier({
      userId: body.userId,
      tier: body.tier,
      monthlyCredits: PLANS[body.tier].monthlyCredits,
      adminEmail: c.email,
    });
    return ok({ user: shape(user) });
  }
  // Pause / deactivate / reactivate a user. 'paused' and 'inactive' block all
  // access (login, refresh, app routes, tool runs) until set back to 'active'.
  if (path.endsWith('/status')) {
    if (!body.userId || !ACCOUNT_STATUSES.includes(body.status)) return badRequest('userId + valid status required');
    const target = await getUser(body.userId);
    if (!target) return badRequest('User not found');
    // Guard against an admin locking a staff member (or themselves) out.
    if (isStaff(target) && body.status !== 'active') return badRequest('Staff accounts cannot be paused or deactivated.');
    const user = await adminSetStatus({ userId: body.userId, status: body.status, adminEmail: c.email });
    return ok({ user: shape(user) });
  }
  // Extend (or end) a Free account's trial window. `days` is counted from NOW,
  // not from the original deadline, so re-extending an already-expired trial
  // gives the full period rather than a window that's still in the past. `days:
  // 0` closes it immediately. Nothing here touches the account's data either
  // way — it only moves the date the gate opens until.
  if (path.endsWith('/trial')) {
    if (!body.userId) return badRequest('userId required');
    const days = Number(body.days);
    if (!Number.isInteger(days) || days < 0 || days > 365) return badRequest('days must be a whole number between 0 and 365.');
    const target = await getUser(body.userId);
    if (!target) return badRequest('User not found');
    const endsAt = new Date(Date.now() + days * 86400000).toISOString();
    await setFreeAccessEndsAt(body.userId, endsAt);
    // A fresh window should be able to warn again as it closes.
    await setAccessNotice(body.userId, null);
    console.log(JSON.stringify({ audit: 'admin_trial', admin: c.email, userId: body.userId, days, endsAt, at: new Date().toISOString() }));
    return ok({ user: shape(await getUser(body.userId)) });
  }
  // Promote/demote a user between 'client' and 'staff'. Any staff member can
  // demote another staff account to client, but granting staff access requires
  // a true admin (ADMIN_EMAILS) — prevents staff from escalating each other (or
  // themselves) to admin. Self-edits are always blocked so nobody can lock
  // themselves out or quietly self-promote.
  if (path.endsWith('/role')) {
    if (!body.userId || !['client', 'staff'].includes(body.role)) return badRequest('userId + valid role required');
    if (body.userId === me.userId) return badRequest('You cannot change your own role.');
    const target = await getUser(body.userId);
    if (!target) return badRequest('User not found');
    if (isAdmin(target.email)) return badRequest("This account is a permanent admin (ADMIN_EMAILS) and its role can't be changed here.");
    if (body.role === 'staff' && !isAdmin(me.email)) return json(403, { error: 'admin_only', message: 'Only an admin can grant staff access.' });
    const user = await adminSetRole({ userId: body.userId, role: body.role, adminEmail: c.email });
    return ok({ user: shape(user) });
  }

  return badRequest('Unknown admin route');
  } catch (err) {
    console.error('admin_error', err);
    return serverError('Something went wrong. Please try again.');
  }
};

// Resolve a {from, to} Date window from query params. Accepts either an explicit
// from/to (ISO date or datetime) or a `days` lookback; defaults to 30 days. The
// range is validated (from < to) and hard-capped so a typo can't request a
// year-long log export.
function parseRange(q = {}, { maxDays = 400, defaultDays = 30 } = {}) {
  const now = Date.now();
  let to = q.to ? Date.parse(q.to) : now;
  let from = q.from ? Date.parse(q.from)
    : Number.isFinite(Number(q.days)) ? to - Math.max(1, Number(q.days)) * 86400000
    : to - defaultDays * 86400000;
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('Invalid from/to date.');
  if (from >= to) throw new Error('`from` must be before `to`.');
  if (to > now + 86400000) to = now; // clamp a future end to now
  if ((to - from) > maxDays * 86400000) throw new Error(`Range too large (max ${maxDays} days).`);
  return { from: new Date(from), to: new Date(to) };
}

// ── Broadcast audience resolution ────────────────────────────────────────────
// Filter shape (all fields optional):
//   { match: 'all'|'any',                      // how the date clauses combine
//     signup|lastLogin|lastToolUse: {           // a date clause per field
//       type: 'before'|'after', days?: int, date?: ISO, includeMissing?: bool },
//     tiers: ['free',...], statuses: ['active',...] }  // empty/absent = no narrowing
// A clause's cutoff is an absolute `date`, else now − `days`×24h. 'before' means
// the timestamp is older than the cutoff (dormant); 'after' means newer (recent).
const FIELD_MAP = { signup: 'createdAt', lastLogin: 'lastLoginAt', lastToolUse: 'lastToolUseAt' };

function clauseMatches(clause, value, now) {
  if (!clause || !clause.type) return true;
  const cutoff = clause.date ? Date.parse(clause.date)
    : Number.isFinite(Number(clause.days)) ? now - Number(clause.days) * 86400000
    : NaN;
  if (Number.isNaN(cutoff)) return true; // an incomplete clause never narrows
  const ms = value ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    // No timestamp on this user. Default: include for 'before' (treat as long
    // dormant), exclude for 'after' — overridable per clause.
    return clause.includeMissing != null ? !!clause.includeMissing : clause.type === 'before';
  }
  return clause.type === 'before' ? ms <= cutoff : ms >= cutoff;
}

function matchesAudience(u, filter = {}, now) {
  const status = u.status || 'active';
  if (Array.isArray(filter.statuses) && filter.statuses.length && !filter.statuses.includes(status)) return false;
  if (Array.isArray(filter.tiers) && filter.tiers.length && !filter.tiers.includes(u.tier)) return false;

  const clauses = Object.entries(FIELD_MAP)
    .map(([k, field]) => [filter[k], u[field]])
    .filter(([clause]) => clause && clause.type);
  if (!clauses.length) return true; // tier/status-only audience
  const results = clauses.map(([clause, value]) => clauseMatches(clause, value, now));
  return filter.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

async function resolveAudience(filter) {
  const now = Date.now();
  const users = await audienceCandidates();
  const matched = users.filter((u) => matchesAudience(u, filter || {}, now));
  return { matched };
}

// Slim, non-sensitive projection for the preview sample.
function audienceRow(u) {
  return {
    userId: u.userId, email: u.email, name: u.name || '',
    tier: u.tier, status: u.status || 'active',
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, lastToolUseAt: u.lastToolUseAt || null,
    emailOptOut: !!u.notifyEmailOptOut,
  };
}

// Run async work over a list with bounded concurrency (keeps SES under its rate
// limit and caps in-flight DynamoDB writes).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// Minimal, inline-styled HTML email. CTA + unsubscribe footer (CAN-SPAM/PECR).
function broadcastEmailHtml({ title, body, ctaUrl, unsubUrl }) {
  const paras = String(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;color:#334155;font-size:15px;line-height:1.6">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
      <tr><td style="background:#4f46e5;padding:18px 28px"><span style="color:#fff;font-size:18px;font-weight:700">Digimetrics</span></td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 14px;color:#0f172a;font-size:20px;font-weight:700">${esc(title)}</h1>
        ${paras}
        ${ctaUrl ? `<p style="margin:22px 0 4px"><a href="${esc(ctaUrl)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:9px">Open Digimetrics</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:18px 28px;border-top:1px solid #f1f5f9">
        <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5">You're receiving this because you have a Digimetrics account.
        <a href="${esc(unsubUrl)}" style="color:#64748b">Unsubscribe from product updates</a>.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
}

// Fan a broadcast out across the requested channels. In-app first (cheap, never
// opted out of); email only to recipients with an address who haven't opted out.
async function deliverBroadcast({ recipients, title, body, link, wantInApp, wantEmail }) {
  let inAppSent = 0, emailSent = 0, emailSkippedOptOut = 0, emailNoAddress = 0;

  if (wantInApp) {
    await mapLimit(recipients, 20, async (u) => {
      try { await addNotification({ userId: u.userId, title, body, link: link || null }); inAppSent++; }
      catch (e) { console.error('broadcast_inapp_failed', u.userId, e.message); }
    });
  }

  if (wantEmail) {
    const ctaUrl = link ? `${APP_ORIGIN}${link}` : APP_ORIGIN;
    await mapLimit(recipients, EMAIL_CONCURRENCY, async (u) => {
      if (u.notifyEmailOptOut) { emailSkippedOptOut++; return; }
      if (!u.email) { emailNoAddress++; return; }
      const unsubUrl = `${APP_ORIGIN}/unsubscribe?token=${encodeURIComponent(signUnsubToken(u.userId))}`;
      const html = broadcastEmailHtml({ title, body, ctaUrl, unsubUrl });
      const text = `${title}\n\n${body}\n\n${ctaUrl}\n\nUnsubscribe: ${unsubUrl}`;
      const sent = await sendEmail({ to: u.email, subject: title, text, html });
      if (sent) emailSent++;
    });
  }

  return { inAppSent, emailSent, emailSkippedOptOut, emailNoAddress };
}

function shape(u) {
  const invited = !!u.provision || String(u.userId || '').startsWith('pending:');
  return {
    userId: u.userId,
    email: u.email,
    name: u.name,
    username: u.username || null,
    tier: u.tier,
    role: u.role || (isAdmin(u.email) ? 'staff' : 'client'),
    status: invited ? 'invited' : (u.status || 'active'),
    credits: invited ? (u.credits || 0) : totalCredits(u),
    monthlyCredits: u.credits || 0,
    topupCredits: u.topupCredits || 0,
    creditsSpent: u.creditsSpentTotal || 0,
    hasSubscription: !!u.stripeCustomerId,
    // Lifetime money paid to us, net of refunds. Null (not 0) when the account
    // has never been linked to Stripe, so the table can show "—" for accounts
    // that were never billable instead of an authoritative-looking $0.00.
    lifetimePaidUsd: u.stripeCustomerId ? Math.round(u.lifetimePaidCents || 0) / 100 : null,
    lifetimePaidCurrency: (u.lifetimePaidCurrency || 'usd').toUpperCase(),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    lastToolUseAt: u.lastToolUseAt || null,
    // Trial / past-due window: whether this account is locked out right now, and
    // when its clock runs out. Distinct from `status`, which is the admin's own
    // suspension switch — an account can be 'active' and still locked on billing.
    access: invited ? null : accessState(u),
    pastDue: !!u.pastDue,
  };
}
