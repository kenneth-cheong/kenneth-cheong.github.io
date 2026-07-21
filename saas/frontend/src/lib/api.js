// API client for the SAM backend. Requires VITE_API_BASE to point at the
// deployed HTTP API; auth is a real Google sign-in → our JWT.
const BASE = import.meta.env.VITE_API_BASE || '';
// Lambda Function URL for slow (>30s) tools — bypasses the API Gateway 30s cap.
const RUN_URL = import.meta.env.VITE_RUN_URL || '';
// Lambda RESPONSE_STREAM Function URL for the streaming assistant chat.
const CHAT_STREAM_URL = import.meta.env.VITE_CHAT_STREAM_URL || '';
export const chatStreamAvailable = !!CHAT_STREAM_URL;

// localStorage is the single source of truth for both tokens — they're read on
// every use rather than cached in a module variable. The app is routinely open
// in several tabs of one origin, and a cached copy outlives another tab
// clearing storage: a tab could keep renewing `dm_access` from an in-memory
// refresh token that storage no longer had, leaving an access token with no
// refresh token behind it. The account then looked signed in until the access
// token lapsed (30m), after which every call was denied with no way to recover.
const getToken = () => localStorage.getItem('dm_access') || null;
const getRefreshToken = () => localStorage.getItem('dm_refresh') || null;
export function setToken(t) {
  if (t) localStorage.setItem('dm_access', t);
  else localStorage.removeItem('dm_access');
}
export function setRefreshToken(t) {
  if (t) localStorage.setItem('dm_refresh', t);
  else localStorage.removeItem('dm_refresh');
}

/** Custom error carrying the backend's structured 402/403 payload. */
export class ApiError extends Error {
  constructor(status, payload) {
    // `message` is API Gateway's own field (our handlers always use `error`), so
    // falling back to it keeps a gateway-level rejection from surfacing as a
    // bare, unreadable "HTTP 403".
    super(payload?.error || payload?.message || `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

// Every 4xx our own handlers emit carries an `error` field; API Gateway's do not
// (it sends {"message":"Unauthorized"|"Forbidden"}). So a 401/403 with no
// `error` is the JWT authorizer rejecting the token — a missing or expired
// session — and never a real authorization verdict like tier_locked or
// admin_only, which must not sign anyone out.
const isSessionDenial = (status, payload) =>
  (status === 401 || status === 403) && !payload?.error;

// A denial we couldn't refresh away means the session is unrecoverable. Drop the
// dead tokens and tell the app to show the login screen, rather than leaving the
// UI looking signed in while every request fails.
function endSession() {
  setToken(null);
  setRefreshToken(null);
  try { window.dispatchEvent(new CustomEvent('dm:session-expired')); } catch { /* non-browser */ }
  return new ApiError(401, { error: 'Your session expired — please sign in again.' });
}

// Access tokens are short-lived (30m). When one lapses, transparently mint a
// new one from the refresh token and retry the request once.
async function tryRefresh() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(BASE + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const { accessToken: t } = await res.json();
    if (!t) return false;
    setToken(t);
    return true;
  } catch {
    return false;
  }
}

// Notify the diagnostics collector (lib/diagnostics.js listens) about a failed
// request so the fault reporter can show "which functions weren't run". Best-effort.
// `background:true` marks a probe the user didn't initiate and that fails softly
// (has its own fallback) — still logged, but it must not auto-open the reporter.
function reportApiError(method, path, status, message, background) {
  try { window.dispatchEvent(new CustomEvent('dm:api-error', { detail: { method, path, status, message, background } })); } catch { /* non-browser */ }
}

// Same idea for successes — lets a ticket reviewer tell "this one endpoint is
// blocked" from "everything's down" by seeing what else went through fine.
function reportApiSuccess(method, path) {
  try { window.dispatchEvent(new CustomEvent('dm:api-success', { detail: { method, path } })); } catch { /* non-browser */ }
}

async function call(path, { method = 'GET', body, auth = true, base, signal, background = false, _retried = false } = {}) {
  let res;
  const token = getToken();
  try {
    res = await fetch((base || BASE) + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // A caller that aborted this request (e.g. a component unmounting) isn't a
    // real failure — don't report it, or an orphaned in-flight fetch pollutes
    // diagnostics and can trip the fault reporter after the view is gone.
    if (err?.name === 'AbortError') throw err;
    // Network-level failure (offline, DNS, CORS) — no response at all.
    reportApiError(method, path, 0, err?.message || 'Network request failed', background);
    throw err;
  }
  const payload = await res.json().catch(() => ({}));
  // Token missing/expired → mint a fresh one from the refresh token and replay
  // once. If that can't be done the session is unrecoverable, so surface it as
  // an expiry (and send the user to sign in) instead of a raw HTTP error.
  if (isSessionDenial(res.status, payload) && auth) {
    if (!_retried && (await tryRefresh())) {
      return call(path, { method, body, auth, base, signal, background, _retried: true });
    }
    reportApiError(method, path, res.status, 'Session expired', background);
    throw endSession();
  }
  if (res.status === 429) {
    const secs = payload?.retryAfter || Number(res.headers.get('Retry-After')) || 60;
    reportApiError(method, path, 429, 'Rate limited', background);
    throw new ApiError(429, { ...payload, error: `You're going a bit fast — try again in ${secs}s.` });
  }
  if (!res.ok) {
    reportApiError(method, path, res.status, payload?.error || `HTTP ${res.status}`, background);
    throw new ApiError(res.status, payload);
  }
  reportApiSuccess(method, path);
  return payload;
}

// Authed GET that returns a binary Blob (e.g. a server-rendered PNG). Same
// token-refresh-and-retry behaviour as call(), but reads res.blob() on success.
async function callBlob(path, { _retried = false } = {}) {
  const token = getToken();
  const res = await fetch(BASE + path, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    if (isSessionDenial(res.status, payload)) {
      if (!_retried && (await tryRefresh())) return callBlob(path, { _retried: true });
      reportApiError('GET', path, res.status, 'Session expired');
      throw endSession();
    }
    reportApiError('GET', path, res.status, payload?.error || `HTTP ${res.status}`);
    throw new ApiError(res.status, payload);
  }
  reportApiSuccess('GET', path);
  return res.blob();
}

// Streaming chat: POSTs to the streaming Function URL and calls onDelta(text)
// as tokens arrive. Returns { conversationId, reply }. Refreshes the access
// token once on 401/403; throws ApiError on non-2xx so the caller can fall back.
export async function chatStream(messages, conversationId, onDelta, { signal, context } = {}, _retried = false) {
  const res = await fetch(CHAT_STREAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: JSON.stringify({ messages, conversationId, context }),
    signal,
  });
  if ((res.status === 401 || res.status === 403) && !_retried && (await tryRefresh())) {
    return chatStream(messages, conversationId, onDelta, { signal, context }, true);
  }
  if (!res.ok || !res.body) {
    const payload = await res.json().catch(() => ({}));
    reportApiError('POST', 'chatStream', res.status, payload?.error || `HTTP ${res.status}`);
    throw new ApiError(res.status, payload);
  }
  const conversationIdOut = res.headers.get('x-conversation-id') || conversationId;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let reply = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    if (chunk) { reply += chunk; onDelta?.(chunk); }
  }
  return { conversationId: conversationIdOut, reply };
}

export const api = {
  loginGoogle: (idToken) => call('/auth/google', { method: 'POST', body: { idToken }, auth: false }),
  // Email / password auth (all public, pre-token).
  signup: (email, password) => call('/auth/signup', { method: 'POST', body: { email, password }, auth: false }),
  // `identifier` is an email or, when username sign-in is on, a username.
  loginPassword: (identifier, password) => call('/auth/password', { method: 'POST', body: { identifier, password }, auth: false }),
  verifyEmail: (token) => call('/auth/verify', { method: 'POST', body: { token }, auth: false }),
  resendVerification: (email) => call('/auth/resend', { method: 'POST', body: { email }, auth: false }),
  forgotPassword: (email) => call('/auth/forgot', { method: 'POST', body: { email }, auth: false }),
  resetPassword: (token, password) => call('/auth/reset', { method: 'POST', body: { token, password }, auth: false }),
  // Public pre-auth config — which sign-in methods the login page should show.
  authConfig: () => call('/auth/config', { auth: false }),
  me: () => call('/me'),
  usage: () => call('/me/usage'),
  // Site Health Check — synthesise several tool results into one scored report.
  auditSynthesize: (url, inputs) => call('/audit/synthesize', { method: 'POST', body: { url, inputs } }),
  // First-run onboarding state (welcome flow, chosen goal, dismissed checklist).
  setOnboarding: (patch) => call('/me/onboarding', { method: 'POST', body: patch }),
  // Soft-launch Free Trial + NDA acceptance (company form + NDA). Persists a
  // durable proof-of-acceptance and notifies tom@mediaone.co server-side.
  acceptNda: (payload) => call('/me/nda', { method: 'POST', body: payload }),
  // Progressive-profiling answers; completing the whole profile pays a one-time bonus.
  saveProfile: (patch) => call('/me/profile', { method: 'POST', body: { patch } }),
  saveUsername: (username) => call('/me/username', { method: 'POST', body: { username } }),
  // Explorer breadth checklist: claim a completion reward ('core' | 'full'). The
  // server re-verifies completion and grants the credits at most once.
  claimExplorer: (milestone) => call('/me/explorer/claim', { method: 'POST', body: { milestone } }),
  // Per-tool thumbs up/down (+ optional note) on a result, attached to the run.
  runFeedback: (runId, rating, note) => call(`/me/runs/${encodeURIComponent(runId)}/feedback`, { method: 'POST', body: { rating, note } }),
  // Feedback surveys: post-usage NPS questionnaire ('nps') + exit micro-survey ('exit').
  submitSurvey: (kind, answers) => call('/me/survey', { method: 'POST', body: { kind, answers } }),
  // GDPR: export everything we hold, or permanently delete the account.
  exportData: () => call('/me/export'),
  deleteAccount: () => call('/me/delete', { method: 'POST' }),
  revokeSessions: () => call('/me/sessions/revoke', { method: 'POST' }),
  revokeSession: (sid) => call('/me/sessions/revoke', { method: 'POST', body: { sid } }),
  // Consent-gated admin access: the user lists/answers staff requests; staff
  // request access + view activity ONLY while the user has an active grant.
  accessRequests: () => call('/me/access'),
  respondAccess: (id, action) => call('/me/access/respond', { method: 'POST', body: { id, action } }),
  adminRequestAccess: (userId, reason) => call('/admin/access', { method: 'POST', body: { userId, reason } }),
  adminAccessStatus: (userId) => call(`/admin/access?userId=${encodeURIComponent(userId)}`),
  // Per-tool usage counts — operational metadata, visible without a grant.
  adminUsage: (userId) => call(`/admin/usage?userId=${encodeURIComponent(userId)}`),
  adminActivity: (userId, kind, id) => call(`/admin/activity?userId=${encodeURIComponent(userId)}&kind=${kind}${id ? `&id=${encodeURIComponent(id)}` : ''}`),
  // Slow tools (catalog `slow:true`) route through the Function URL to dodge
  // the 30s API Gateway limit; everything else uses the normal API.
  runTool: (toolId, input, slow = false) =>
    slow && RUN_URL
      ? call(`run/${toolId}`, { method: 'POST', body: input, base: RUN_URL })
      : call(`/run/${toolId}`, { method: 'POST', body: input }),
  // Social Media Audit — one metered tool, many actions. `start` hands the whole
  // job to a server-side finalizer that runs scrape→strategy→save→notify even if
  // the tab closes; the page only polls `status` for progress. The gateway
  // charges only the `strategy` step (everything else opts out via _noCharge).
  // Routes via the Function URL (slow tool) when configured.
  socialAudit: (payload) =>
    RUN_URL
      ? call('run/social-audit', { method: 'POST', body: payload, base: RUN_URL })
      : call('/run/social-audit', { method: 'POST', body: payload }),
  checkout: (tier, interval) => call('/billing/checkout', { method: 'POST', body: { tier, interval } }),
  topup: (packId) => call('/billing/topup', { method: 'POST', body: { packId } }),
  // Airwallex has no hosted customer portal, so "manage billing" is these three
  // routes rather than one redirect.
  paymentMethod: () => call('/billing/payment-method', { method: 'POST' }),
  changePlan: (tier, interval) => call('/billing/subscription/change', { method: 'POST', body: { tier, interval } }),
  cancelPlan: (atPeriodEnd = true) => call('/billing/subscription/cancel', { method: 'POST', body: { atPeriodEnd } }),
  invoices: () => call('/billing/invoices'),
  // In-app features: assistant chat, run history, support, integrations.
  chat: (messages, conversationId, context) => call('/chat', { method: 'POST', body: { messages, conversationId, context } }),
  // Free plain-English summary of a tool result (the "What this means" panel).
  explainResult: (toolName, resultText) => call('/chat/explain', { method: 'POST', body: { toolName, resultText } }),
  conversations: () => call('/chat/conversations'),
  conversation: (id) => call(`/chat/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id) => call('/chat/conversations/delete', { method: 'POST', body: { conversationId: id } }),
  // No limit → the newest 100 (enough for the dashboard widgets). The Runs
  // page passes one, since it promises the user their full history.
  runs: (limit) => call(`/me/runs${limit ? `?limit=${limit}` : ''}`),
  run: (runId) => call(`/me/runs/${encodeURIComponent(runId)}`),
  // Server-rendered share card (PNG Blob). Authed like any /me route, so we
  // fetch it with the bearer token rather than putting it in an <img src>.
  runCard: (runId, format = 'square') =>
    callBlob(`/me/runs/${encodeURIComponent(runId)}/card?format=${encodeURIComponent(format)}`),
  // Public share link (opt-in, auto-redacted). Mint is idempotent per run. For
  // dashboard tools with no saved run, pass a `snapshot` ({toolId,toolName,
  // result,target}) — the server embeds it on the share and returns its shareId.
  shareRun: (runId, snapshot) => call(`/me/runs/${encodeURIComponent(runId)}/share`, { method: 'POST', body: snapshot ? { snapshot } : undefined }),
  // Revoke by run (run-backed shares) or by shareId (snapshot shares).
  revokeShare: (runId, shareId) => call(`/me/runs/${encodeURIComponent(runId)}/share/revoke`, { method: 'POST', body: shareId ? { shareId } : undefined }),
  // Scheduled tool runs (recurring runs with saved inputs; period-over-period compare)
  schedules: () => call('/me/schedules'),
  createSchedule: (payload) => call('/me/schedules', { method: 'POST', body: payload }),
  updateSchedule: (payload) => call('/me/schedules/update', { method: 'POST', body: payload }),
  deleteSchedule: (scheduleId) => call('/me/schedules/delete', { method: 'POST', body: { scheduleId } }),
  runScheduleNow: (scheduleId) => call('/me/schedules/run-now', { method: 'POST', body: { scheduleId } }),
  scheduleCompare: (scheduleId) => call(`/me/schedules/${encodeURIComponent(scheduleId)}/compare`),
  // Notifications — the bell takes the default page, the Notifications page
  // asks for the full history. No ids on /read marks EVERYTHING read.
  notifications: (limit) => call(`/me/notifications${limit ? `?limit=${limit}` : ''}`),
  markNotificationsRead: (notifIds, read = true) =>
    call('/me/notifications/read', { method: 'POST', body: notifIds?.length ? { notifIds, read } : {} }),
  deleteNotifications: (notifIds) =>
    call('/me/notifications/delete', { method: 'POST', body: { notifIds: [].concat(notifIds) } }),
  clearNotifications: () => call('/me/notifications/clear', { method: 'POST' }),
  // Support tickets (threaded + attachments)
  tickets: () => call('/support/tickets'),
  ticket: (ticketId) => call(`/support/tickets/${encodeURIComponent(ticketId)}`),
  createTicket: (subject, message, opts = {}) =>
    call('/support/tickets', { method: 'POST', body: { subject, message, additionalEmails: opts.additionalEmails || [], attachments: opts.attachments || [], category: opts.category, diagnostics: opts.diagnostics } }),
  replyTicket: (ticketId, body, attachments = []) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/reply`, { method: 'POST', body: { body, attachments } }),
  closeTicket: (ticketId) => call(`/support/tickets/${encodeURIComponent(ticketId)}/close`, { method: 'POST' }),
  uploadAttachment: ({ name, contentType, data }) =>
    call('/support/attachments', { method: 'POST', body: { name, contentType, data } }),
  // Admin support console — list/view/reply/close ANY user's ticket (server
  // verifies the caller is an admin; reply is posted as the support agent).
  adminTickets: () => call('/support/tickets?all=1'),
  adminTicket: (ownerUserId, ticketId) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}?ownerUserId=${encodeURIComponent(ownerUserId)}`),
  // fromMonty: reply as the "Monty" persona (default) or as the staff member themselves.
  adminReplyTicket: (ownerUserId, ticketId, body, attachments = [], fromMonty = true) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/reply`, { method: 'POST', body: { body, attachments, asAgent: true, ownerUserId, fromMonty } }),
  adminCloseTicket: (ownerUserId, ticketId) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/close`, { method: 'POST', body: { ownerUserId } }),
  // Re-send the email for a past staff reply (no new message posted).
  adminResendReply: (ownerUserId, ticketId, messageId) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/resend`, { method: 'POST', body: { ownerUserId, messageId } }),
  // Projects
  projects: () => call('/projects'),
  createProject: (name, domain) => call('/projects', { method: 'POST', body: { name, domain } }),
  deleteProject: (projectId) => call('/projects/delete', { method: 'POST', body: { projectId } }),
  // Keyword tracking
  tracking: (projectId) => call(`/tracking${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  addTracked: (keyword, domain, location, projectId) => call('/tracking', { method: 'POST', body: { keyword, domain, location, projectId } }),
  addTrackedBulk: (keywords, domain, location, projectId) => call('/tracking', { method: 'POST', body: { keywords, domain, location, projectId } }),
  removeTracked: (trackId) => call('/tracking/delete', { method: 'POST', body: { trackId } }),
  refreshTracking: (projectId, trackId) => call('/tracking/refresh', { method: 'POST', body: { projectId, trackId } }),
  backfillTracking: (projectId, trackId) => call('/tracking/refresh', { method: 'POST', body: { projectId, trackId, backfill: true } }),
  // Tool performance metrics over time (per project)
  metrics: (projectId) => call(`/metrics${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  // Integrations (Google OAuth)
  integrations: () => call('/integrations'),
  integrationAccounts: (provider) => call(`/integrations/accounts?provider=${encodeURIComponent(provider)}`),
  // GA4: metrics compatible with the chosen breakdown dimension (null = allow all).
  ga4Compatibility: (dimension, signal) => call(`/integrations/ga4/compatibility?dimension=${encodeURIComponent(dimension || '')}`, { signal, background: true }),
  // single:true → auth a different account for just this source (not the whole family).
  // scope:'family' → started from the family card, so the consent refreshes the
  // family instead of switching on a source the user disconnected on purpose.
  authorizeIntegration: (provider, { single = false, scope = '' } = {}) =>
    call(`/integrations/authorize?provider=${encodeURIComponent(provider)}${single ? '&single=1' : ''}${scope ? `&scope=${encodeURIComponent(scope)}` : ''}`),
  connectIntegration: (provider, account, connected = true) =>
    call('/integrations/connect', { method: 'POST', body: { provider, account, connected } }),
  // Admin
  adminUsers: () => call('/admin/users'),
  // Free Trial + NDA agreements collected in-app (replaces the email notification).
  adminAgreements: () => call('/admin/agreements'),
  adminAgreementPdf: (userId) => call(`/admin/agreements/pdf?userId=${encodeURIComponent(userId)}`),
  adminAgreementSamplePdf: () => call('/admin/agreements/sample-pdf'),
  adminCreateUser: ({ email, name, role, tier, credits, sendInvite }) =>
    call('/admin/users', { method: 'POST', body: { email, name, role, tier, credits, sendInvite } }),
  adminCredits: (userId, monthlyDelta, topupDelta, reason) =>
    call('/admin/credits', { method: 'POST', body: { userId, monthlyDelta, topupDelta, reason } }),
  adminTier: (userId, tier) => call('/admin/tier', { method: 'POST', body: { userId, tier } }),
  adminStatus: (userId, status) => call('/admin/status', { method: 'POST', body: { userId, status } }),
  adminRole: (userId, role) => call('/admin/role', { method: 'POST', body: { userId, role } }),
  adminSettings: () => call('/admin/settings'),
  adminSetSettings: (patch) => call('/admin/settings', { method: 'POST', body: patch }),
  // Broadcast notifications — preview an audience, send, view history, and the
  // one-time activity backfill (seeds last-login / last-tool-use from history).
  adminBroadcastPreview: (filter) => call('/admin/notifications/preview', { method: 'POST', body: { filter } }),
  adminBroadcastSend: ({ filter, title, body, link, channels }) =>
    call('/admin/notifications/send', { method: 'POST', body: { filter, title, body, link, channels } }),
  adminBroadcastHistory: () => call('/admin/notifications/history'),
  adminBackfillActivity: () => call('/admin/notifications/backfill', { method: 'POST' }),
  // Platform (Amplify Hosting) usage over a date range: fast traffic/cost/build
  // panel, plus the heavier on-demand access-log breakdowns.
  adminPlatformUsage: ({ from, to } = {}) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const qs = p.toString();
    return call(`/admin/platform/usage${qs ? `?${qs}` : ''}`);
  },
  adminPlatformAccessLogs: ({ from, to } = {}) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const qs = p.toString();
    return call(`/admin/platform/access-logs${qs ? `?${qs}` : ''}`);
  },
  // Finances balance sheet (Airwallex revenue vs AWS + estimated COGS, in SGD).
  adminFinances: ({ from, to } = {}) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    const qs = p.toString();
    return call(`/admin/finances${qs ? `?${qs}` : ''}`);
  },
  // Product-email preference (Account toggle) + the public one-click unsubscribe.
  setEmailPrefs: (emailOptOut) => call('/me/email-prefs', { method: 'POST', body: { emailOptOut } }),
  unsubscribeEmail: (token) => call('/notify/unsubscribe', { method: 'POST', body: { token }, auth: false }),
};
