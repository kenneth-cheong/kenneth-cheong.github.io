// API client for the SAM backend. Requires VITE_API_BASE to point at the
// deployed HTTP API; auth is a real Google sign-in → our JWT.
const BASE = import.meta.env.VITE_API_BASE || '';
// Lambda Function URL for slow (>30s) tools — bypasses the API Gateway 30s cap.
const RUN_URL = import.meta.env.VITE_RUN_URL || '';
// Lambda RESPONSE_STREAM Function URL for the streaming assistant chat.
const CHAT_STREAM_URL = import.meta.env.VITE_CHAT_STREAM_URL || '';
export const chatStreamAvailable = !!CHAT_STREAM_URL;

let accessToken = localStorage.getItem('dm_access') || null;
let refreshToken = localStorage.getItem('dm_refresh') || null;
export function setToken(t) {
  accessToken = t;
  if (t) localStorage.setItem('dm_access', t);
  else localStorage.removeItem('dm_access');
}
export function setRefreshToken(t) {
  refreshToken = t;
  if (t) localStorage.setItem('dm_refresh', t);
  else localStorage.removeItem('dm_refresh');
}

/** Custom error carrying the backend's structured 402/403 payload. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error || `HTTP ${status}`);
    this.status = status;
    this.payload = payload;
  }
}

// Access tokens are short-lived (30m). When one lapses, transparently mint a
// new one from the refresh token and retry the request once.
async function tryRefresh() {
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
function reportApiError(method, path, status, message) {
  try { window.dispatchEvent(new CustomEvent('dm:api-error', { detail: { method, path, status, message } })); } catch { /* non-browser */ }
}

async function call(path, { method = 'GET', body, auth = true, base, _retried = false } = {}) {
  let res;
  try {
    res = await fetch((base || BASE) + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // Network-level failure (offline, DNS, CORS) — no response at all.
    reportApiError(method, path, 0, err?.message || 'Network request failed');
    throw err;
  }
  // Token expired/denied → refresh once and retry before surfacing the error.
  if ((res.status === 401 || res.status === 403) && auth && !_retried && (await tryRefresh())) {
    return call(path, { method, body, auth, base, _retried: true });
  }
  const payload = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const secs = payload?.retryAfter || Number(res.headers.get('Retry-After')) || 60;
    reportApiError(method, path, 429, 'Rate limited');
    throw new ApiError(429, { ...payload, error: `You're going a bit fast — try again in ${secs}s.` });
  }
  if (!res.ok) {
    reportApiError(method, path, res.status, payload?.error || `HTTP ${res.status}`);
    throw new ApiError(res.status, payload);
  }
  return payload;
}

// Authed GET that returns a binary Blob (e.g. a server-rendered PNG). Same
// token-refresh-and-retry behaviour as call(), but reads res.blob() on success.
async function callBlob(path, { _retried = false } = {}) {
  const res = await fetch(BASE + path, {
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  if ((res.status === 401 || res.status === 403) && !_retried && (await tryRefresh())) {
    return callBlob(path, { _retried: true });
  }
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    reportApiError('GET', path, res.status, payload?.error || `HTTP ${res.status}`);
    throw new ApiError(res.status, payload);
  }
  return res.blob();
}

// Streaming chat: POSTs to the streaming Function URL and calls onDelta(text)
// as tokens arrive. Returns { conversationId, reply }. Refreshes the access
// token once on 401/403; throws ApiError on non-2xx so the caller can fall back.
export async function chatStream(messages, conversationId, onDelta, { signal } = {}, _retried = false) {
  const res = await fetch(CHAT_STREAM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ messages, conversationId }),
    signal,
  });
  if ((res.status === 401 || res.status === 403) && !_retried && (await tryRefresh())) {
    return chatStream(messages, conversationId, onDelta, { signal }, true);
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
  loginPassword: (email, password) => call('/auth/password', { method: 'POST', body: { email, password }, auth: false }),
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
  portal: () => call('/billing/portal', { method: 'POST' }),
  invoices: () => call('/billing/invoices'),
  // In-app features: assistant chat, run history, support, integrations.
  chat: (messages, conversationId) => call('/chat', { method: 'POST', body: { messages, conversationId } }),
  conversations: () => call('/chat/conversations'),
  conversation: (id) => call(`/chat/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id) => call('/chat/conversations/delete', { method: 'POST', body: { conversationId: id } }),
  runs: () => call('/me/runs'),
  run: (runId) => call(`/me/runs/${encodeURIComponent(runId)}`),
  // Server-rendered share card (PNG Blob). Authed like any /me route, so we
  // fetch it with the bearer token rather than putting it in an <img src>.
  runCard: (runId, format = 'square') =>
    callBlob(`/me/runs/${encodeURIComponent(runId)}/card?format=${encodeURIComponent(format)}`),
  // Public share link (opt-in, auto-redacted). Mint is idempotent per run.
  shareRun: (runId) => call(`/me/runs/${encodeURIComponent(runId)}/share`, { method: 'POST' }),
  revokeShare: (runId) => call(`/me/runs/${encodeURIComponent(runId)}/share/revoke`, { method: 'POST' }),
  // Notifications
  notifications: () => call('/me/notifications'),
  markNotificationsRead: () => call('/me/notifications/read', { method: 'POST' }),
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
  adminReplyTicket: (ownerUserId, ticketId, body, attachments = []) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/reply`, { method: 'POST', body: { body, attachments, asAgent: true, ownerUserId } }),
  adminCloseTicket: (ownerUserId, ticketId) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/close`, { method: 'POST', body: { ownerUserId } }),
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
  authorizeIntegration: (provider) => call(`/integrations/authorize?provider=${encodeURIComponent(provider)}`),
  connectIntegration: (provider, account, connected = true) =>
    call('/integrations/connect', { method: 'POST', body: { provider, account, connected } }),
  // Per-source disconnect: clears this source's chosen account but keeps the shared family sign-in.
  clearIntegrationAccount: (provider) =>
    call('/integrations/connect', { method: 'POST', body: { provider, account: '', connected: true, clearAccount: true } }),
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
  adminSettings: () => call('/admin/settings'),
  adminSetSettings: (patch) => call('/admin/settings', { method: 'POST', body: patch }),
  // Broadcast notifications — preview an audience, send, view history, and the
  // one-time activity backfill (seeds last-login / last-tool-use from history).
  adminBroadcastPreview: (filter) => call('/admin/notifications/preview', { method: 'POST', body: { filter } }),
  adminBroadcastSend: ({ filter, title, body, link, channels }) =>
    call('/admin/notifications/send', { method: 'POST', body: { filter, title, body, link, channels } }),
  adminBroadcastHistory: () => call('/admin/notifications/history'),
  adminBackfillActivity: () => call('/admin/notifications/backfill', { method: 'POST' }),
  // Product-email preference (Account toggle) + the public one-click unsubscribe.
  setEmailPrefs: (emailOptOut) => call('/me/email-prefs', { method: 'POST', body: { emailOptOut } }),
  unsubscribeEmail: (token) => call('/notify/unsubscribe', { method: 'POST', body: { token }, auth: false }),
};
