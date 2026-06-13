// API client for the SAM backend. Requires VITE_API_BASE to point at the
// deployed HTTP API; auth is a real Google sign-in → our JWT.
const BASE = import.meta.env.VITE_API_BASE || '';
// Lambda Function URL for slow (>30s) tools — bypasses the API Gateway 30s cap.
const RUN_URL = import.meta.env.VITE_RUN_URL || '';

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

async function call(path, { method = 'GET', body, auth = true, base, _retried = false } = {}) {
  const res = await fetch((base || BASE) + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Token expired/denied → refresh once and retry before surfacing the error.
  if ((res.status === 401 || res.status === 403) && auth && !_retried && (await tryRefresh())) {
    return call(path, { method, body, auth, base, _retried: true });
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

export const api = {
  loginGoogle: (idToken) => call('/auth/google', { method: 'POST', body: { idToken }, auth: false }),
  me: () => call('/me'),
  usage: () => call('/me/usage'),
  // Slow tools (catalog `slow:true`) route through the Function URL to dodge
  // the 30s API Gateway limit; everything else uses the normal API.
  runTool: (toolId, input, slow = false) =>
    slow && RUN_URL
      ? call(`run/${toolId}`, { method: 'POST', body: input, base: RUN_URL })
      : call(`/run/${toolId}`, { method: 'POST', body: input }),
  checkout: (tier, interval) => call('/billing/checkout', { method: 'POST', body: { tier, interval } }),
  topup: (packId) => call('/billing/topup', { method: 'POST', body: { packId } }),
  portal: () => call('/billing/portal', { method: 'POST' }),
  // In-app features: assistant chat, run history, support, integrations.
  chat: (messages) => call('/chat', { method: 'POST', body: { messages } }),
  runs: () => call('/me/runs'),
  run: (runId) => call(`/me/runs/${encodeURIComponent(runId)}`),
  // Notifications
  notifications: () => call('/me/notifications'),
  markNotificationsRead: () => call('/me/notifications/read', { method: 'POST' }),
  // Support tickets (threaded + attachments)
  tickets: () => call('/support/tickets'),
  ticket: (ticketId) => call(`/support/tickets/${encodeURIComponent(ticketId)}`),
  createTicket: (subject, message, opts = {}) =>
    call('/support/tickets', { method: 'POST', body: { subject, message, additionalEmails: opts.additionalEmails || [], attachments: opts.attachments || [], category: opts.category } }),
  replyTicket: (ticketId, body, attachments = []) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/reply`, { method: 'POST', body: { body, attachments } }),
  closeTicket: (ticketId) => call(`/support/tickets/${encodeURIComponent(ticketId)}/close`, { method: 'POST' }),
  uploadAttachment: ({ name, contentType, data }) =>
    call('/support/attachments', { method: 'POST', body: { name, contentType, data } }),
  // Projects
  projects: () => call('/projects'),
  createProject: (name, domain) => call('/projects', { method: 'POST', body: { name, domain } }),
  deleteProject: (projectId) => call('/projects/delete', { method: 'POST', body: { projectId } }),
  // Keyword tracking
  tracking: (projectId) => call(`/tracking${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  addTracked: (keyword, domain, location, projectId) => call('/tracking', { method: 'POST', body: { keyword, domain, location, projectId } }),
  removeTracked: (trackId) => call('/tracking/delete', { method: 'POST', body: { trackId } }),
  refreshTracking: (projectId, trackId) => call('/tracking/refresh', { method: 'POST', body: { projectId, trackId } }),
  // Integrations (Google OAuth)
  integrations: () => call('/integrations'),
  integrationAccounts: (provider) => call(`/integrations/accounts?provider=${encodeURIComponent(provider)}`),
  authorizeIntegration: (provider) => call(`/integrations/authorize?provider=${encodeURIComponent(provider)}`),
  connectIntegration: (provider, account, connected = true) =>
    call('/integrations/connect', { method: 'POST', body: { provider, account, connected } }),
  // Admin
  adminUsers: () => call('/admin/users'),
  adminCredits: (userId, monthlyDelta, topupDelta, reason) =>
    call('/admin/credits', { method: 'POST', body: { userId, monthlyDelta, topupDelta, reason } }),
  adminTier: (userId, tier) => call('/admin/tier', { method: 'POST', body: { userId, tier } }),
};
