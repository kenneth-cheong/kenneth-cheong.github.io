// API client. Talks to the SAM backend in production; falls back to an
// in-memory MOCK when VITE_MOCK=1 so the whole UI runs with no AWS at all.
import { PLANS, TOOLS, CREDIT_COSTS, TOPUP_PACKS, topupById, tierMeets, INTEGRATIONS } from '@shared/catalog.mjs';
import { integrationResult, integrationSummary } from '@shared/connectors.mjs';

const BASE = import.meta.env.VITE_API_BASE || '';
// Lambda Function URL for slow (>30s) tools — bypasses the API Gateway 30s cap.
const RUN_URL = import.meta.env.VITE_RUN_URL || '';
const MOCK = import.meta.env.VITE_MOCK === '1' || !BASE;

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
  if (MOCK) return mock(path, { method, body });
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
  createTicket: (subject, message, additionalEmails = [], attachments = []) =>
    call('/support/tickets', { method: 'POST', body: { subject, message, additionalEmails, attachments } }),
  replyTicket: (ticketId, body, attachments = []) =>
    call(`/support/tickets/${encodeURIComponent(ticketId)}/reply`, { method: 'POST', body: { body, attachments } }),
  closeTicket: (ticketId) => call(`/support/tickets/${encodeURIComponent(ticketId)}/close`, { method: 'POST' }),
  uploadAttachment: ({ name, contentType, data }) =>
    call('/support/attachments', { method: 'POST', body: { name, contentType, data } }),
  // Integrations (Google OAuth)
  integrations: () => call('/integrations'),
  authorizeIntegration: (provider) => call(`/integrations/authorize?provider=${encodeURIComponent(provider)}`),
  connectIntegration: (provider, account, connected = true) =>
    call('/integrations/connect', { method: 'POST', body: { provider, account, connected } }),
  // Admin
  adminUsers: () => call('/admin/users'),
  adminCredits: (userId, monthlyDelta, topupDelta, reason) =>
    call('/admin/credits', { method: 'POST', body: { userId, monthlyDelta, topupDelta, reason } }),
  adminTier: (userId, tier) => call('/admin/tier', { method: 'POST', body: { userId, tier } }),
};

// ─────────────────────────────────────────────────────────────────────────
// MOCK BACKEND — mirrors the real metering logic so the upsell/credit UX is
// fully exercisable offline. State persists in localStorage for the session.
// ─────────────────────────────────────────────────────────────────────────
function mockState() {
  const raw = localStorage.getItem('dm_mock');
  if (raw) return JSON.parse(raw);
  const s = {
    user: {
      userId: 'mock', email: 'you@example.com', name: 'Demo User', tier: 'free',
      monthlyCredits: PLANS.free.monthlyCredits, topupCredits: 0,
      hasSubscription: false, isAdmin: true, // demo: admin so the portal is visible
    },
    usage: [],
    teasers: {},
    runs: [],
    tickets: [],
    notifications: [],
    // A few seeded users so the admin portal has rows to manage.
    adminUsers: [
      { userId: 'u_amy', email: 'amy@startup.sg', name: 'Amy Tan', tier: 'pro', monthlyCredits: 1450, topupCredits: 300, hasSubscription: true },
      { userId: 'u_ben', email: 'ben@shop.sg', name: 'Ben Lee', tier: 'starter', monthlyCredits: 80, topupCredits: 0, hasSubscription: true },
      { userId: 'u_cara', email: 'cara@agency.sg', name: 'Cara Wong', tier: 'free', monthlyCredits: 12, topupCredits: 0, hasSubscription: false },
    ],
  };
  localStorage.setItem('dm_mock', JSON.stringify(s));
  return s;
}
const mockTotal = (u) => (u.monthlyCredits || 0) + (u.topupCredits || 0);
function withTotal(u) { return { ...u, credits: mockTotal(u) }; }
function mockFindUser(s, userId) {
  if (s.user.userId === userId) return s.user;
  return s.adminUsers.find((u) => u.userId === userId);
}
function saveMock(s) { localStorage.setItem('dm_mock', JSON.stringify(s)); return s; }

async function mock(path, { method, body }) {
  await new Promise((r) => setTimeout(r, 400)); // feel like a network
  const s = mockState();

  if (path === '/auth/google') {
    setToken('mock-token');
    return { accessToken: 'mock-token', user: withTotal(s.user) };
  }
  if (path === '/me') return { user: withTotal(s.user), plan: PLANS[s.user.tier] };
  if (path === '/me/usage') return { usage: s.usage };

  if (path.startsWith('/billing/checkout')) {
    // Simulate a successful subscription instead of redirecting to Stripe.
    const tier = body.tier;
    s.user.tier = tier;
    s.user.monthlyCredits = PLANS[tier].monthlyCredits; // topup rolls over
    s.user.hasSubscription = true;
    saveMock(s);
    return { url: `${location.origin}/account?checkout=success&mock=1` };
  }
  if (path === '/billing/topup') {
    // Simulate a one-time purchase granting rollover credits.
    const pack = topupById(body.packId);
    s.user.topupCredits = (s.user.topupCredits || 0) + (pack?.credits || 0);
    s.usage.unshift({ ts: new Date().toISOString(), tool: 'topup_purchase', delta: pack?.credits || 0, balanceAfter: mockTotal(s.user) });
    saveMock(s);
    return { url: `${location.origin}/account?topup=success&mock=1` };
  }
  if (path === '/billing/portal') return { url: `${location.origin}/account` };

  // ── Admin (mock) ──────────────────────────────────────────────────────
  if (path === '/admin/users') {
    return { users: [withTotal(s.user), ...s.adminUsers.map(withTotal)] };
  }
  if (path === '/admin/credits') {
    const u = mockFindUser(s, body.userId);
    if (u) {
      u.monthlyCredits = Math.max(0, (u.monthlyCredits || 0) + (Number(body.monthlyDelta) || 0));
      u.topupCredits = Math.max(0, (u.topupCredits || 0) + (Number(body.topupDelta) || 0));
      saveMock(s);
    }
    return { credits: u?.monthlyCredits, topupCredits: u?.topupCredits, total: u ? mockTotal(u) : 0 };
  }
  if (path === '/admin/tier') {
    const u = mockFindUser(s, body.userId);
    if (u) { u.tier = body.tier; u.monthlyCredits = PLANS[body.tier].monthlyCredits; saveMock(s); }
    return { user: u ? withTotal(u) : null };
  }

  // ── In-app features (mock) ────────────────────────────────────────────────
  if (path === '/chat') {
    const cost = CREDIT_COSTS.ai_chat ?? 2;
    if (mockTotal(s.user) < cost) throw new ApiError(402, { error: 'insufficient_credits', creditsRemaining: mockTotal(s.user), creditsNeeded: cost, tier: s.user.tier, topUpAvailable: true });
    const fromMonthly = Math.min(s.user.monthlyCredits || 0, cost);
    s.user.monthlyCredits -= fromMonthly;
    s.user.topupCredits = (s.user.topupCredits || 0) - (cost - fromMonthly);
    s.usage.unshift({ ts: new Date().toISOString(), tool: 'chatbot', delta: -cost, balanceAfter: mockTotal(s.user) });
    saveMock(s);
    const last = (body.messages || []).slice(-1)[0]?.content || '';
    const conns = s.user.integrations || {};
    const ctx = Object.keys(conns).map((p) => integrationSummary(p, conns[p].account)).join(' ');
    const reply = ctx
      ? `Based on your connected data — ${ctx} Ask me to break any of it down further, or about any tool. (demo reply)`
      : `Happy to help with "${last.slice(0, 60)}". Connect GSC/GA4/Google Ads under Integrations and I can answer questions about your own numbers too. (demo reply)`;
    return { reply, creditsUsed: cost, creditsRemaining: mockTotal(s.user) };
  }
  if (path === '/me/runs') return { runs: s.runs.map(({ result, inputs, ...slim }) => slim) };
  if (path.startsWith('/me/runs/')) {
    const id = decodeURIComponent(path.split('/me/runs/')[1]);
    const run = s.runs.find((r) => r.runId === id);
    return run ? { run } : (() => { throw new ApiError(404, { error: 'Run not found' }); })();
  }
  // ── Notifications (mock) ──────────────────────────────────────────────────
  if (path === '/me/notifications') return { notifications: s.notifications || [] };
  if (path === '/me/notifications/read') { (s.notifications || []).forEach((n) => { n.read = true; }); saveMock(s); return { ok: true }; }

  // ── Support (mock) ────────────────────────────────────────────────────────
  if (path === '/support/attachments') {
    // Echo a data URL so pasted/uploaded images render inline offline.
    const url = body.data && String(body.data).startsWith('data:') ? body.data : `https://example.com/${body.name || 'file'}`;
    return { attachment: { url, name: body.name || 'attachment', contentType: body.contentType || '', size: 0 } };
  }
  if (path === '/support/tickets' && method === 'GET') return { tickets: s.tickets.map(({ messages, ...t }) => t) };
  if (path === '/support/tickets' && method === 'POST') {
    const ts = new Date().toISOString();
    const ticket = {
      userId: 'mock', ticketId: `${ts}#${Math.random().toString(36).slice(2, 8)}`, id: 'TKT-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      userEmail: s.user.email, additionalEmails: body.additionalEmails || [], subject: body.subject, status: 'open', ts, lastActivityAt: ts,
      messages: [{ id: 'm_' + Math.random().toString(36).slice(2, 8), author: 'user', authorEmail: s.user.email, body: body.message, attachments: body.attachments || [], ts }],
    };
    s.tickets.unshift(ticket);
    (s.notifications = s.notifications || []).unshift({ notifId: `${ts}#n`, title: `Ticket ${ticket.id} received`, body: body.subject, ticketId: ticket.ticketId, read: false, ts });
    saveMock(s);
    return { ticket };
  }
  if (path.startsWith('/support/tickets/') && path.endsWith('/reply')) {
    const id = decodeURIComponent(path.split('/support/tickets/')[1].split('/')[0]);
    const t = s.tickets.find((x) => x.ticketId === id);
    if (!t) throw new ApiError(404, { error: 'Ticket not found' });
    const ts = new Date().toISOString();
    t.messages.push({ id: 'm_' + Math.random().toString(36).slice(2, 8), author: 'user', authorEmail: s.user.email, body: body.body, attachments: body.attachments || [], ts });
    t.status = 'open'; t.lastActivityAt = ts; saveMock(s);
    return { ticket: t };
  }
  if (path.startsWith('/support/tickets/') && path.endsWith('/close')) {
    const id = decodeURIComponent(path.split('/support/tickets/')[1].split('/')[0]);
    const t = s.tickets.find((x) => x.ticketId === id);
    if (t) { t.status = 'closed'; saveMock(s); }
    return { ok: true };
  }
  if (path.startsWith('/support/tickets/') && method === 'GET') {
    const id = decodeURIComponent(path.split('/support/tickets/')[1]);
    const t = s.tickets.find((x) => x.ticketId === id);
    if (!t) throw new ApiError(404, { error: 'Ticket not found' });
    return { ticket: t };
  }

  // ── Integrations (mock — no real Google; "connect" instantly) ─────────────
  if (path === '/integrations' && method === 'GET') return { providers: INTEGRATIONS, connected: s.user.integrations || {}, oauthReady: false };
  if (path.startsWith('/integrations/authorize')) {
    const provider = new URLSearchParams((path.split('?')[1] || '')).get('provider');
    s.user.integrations = { ...(s.user.integrations || {}) };
    s.user.integrations[provider] = { connected: true, account: 'demo-account', connectedAt: new Date().toISOString() };
    saveMock(s);
    return { url: `${location.origin}/integrations?connected=${provider}` };
  }
  if (path === '/integrations/connect') {
    s.user.integrations = { ...(s.user.integrations || {}) };
    if (body.connected === false) delete s.user.integrations[body.provider];
    else s.user.integrations[body.provider] = { connected: true, account: body.account || s.user.integrations[body.provider]?.account || '', connectedAt: new Date().toISOString() };
    saveMock(s);
    return { connected: s.user.integrations };
  }

  if (path.startsWith('/run/')) {
    const toolId = path.split('/').pop();
    const tool = TOOLS.find((t) => t.id === toolId);
    const cost = CREDIT_COSTS[tool.cost] ?? 0;

    let teaser = false;
    if (!tierMeets(s.user.tier, tool.minTier)) {
      const month = new Date().toISOString().slice(0, 7);
      if (tool.teaser && s.teasers[toolId] !== month) {
        teaser = true;
        s.teasers[toolId] = month;
      } else {
        throw new ApiError(403, { error: 'tier_locked', requiredTier: tool.minTier });
      }
    }
    const willCharge = !teaser && cost > 0;
    if (willCharge && mockTotal(s.user) < cost) {
      throw new ApiError(402, { error: 'insufficient_credits', creditsRemaining: mockTotal(s.user), creditsNeeded: cost, tier: s.user.tier, topUpAvailable: true });
    }

    const result = mockResult(tool, body, teaser, s.user.tier);
    let used = 0;
    if (willCharge) {
      used = cost;
      // Spend monthly bucket first, then top-up.
      const fromMonthly = Math.min(s.user.monthlyCredits || 0, cost);
      s.user.monthlyCredits -= fromMonthly;
      s.user.topupCredits = (s.user.topupCredits || 0) - (cost - fromMonthly);
      s.usage.unshift({ ts: new Date().toISOString(), tool: tool.id, delta: -cost, balanceAfter: mockTotal(s.user) });
    }
    // Persist the run so the History page can re-open it (mirrors the backend).
    const runId = new Date().toISOString() + '#' + Math.random().toString(36).slice(2, 8);
    const preview = result.text ? result.text.slice(0, 90) : Array.isArray(result.rows) ? `${result.rows.length} rows` : result.html ? 'report' : '';
    s.runs.unshift({ runId, tool: tool.id, toolName: tool.name, ts: new Date().toISOString(), preview, creditsUsed: used, inputs: body, result });
    s.runs = s.runs.slice(0, 200);
    saveMock(s);
    return { tool: tool.id, teaser, result, creditsUsed: used, creditsRemaining: mockTotal(s.user), runId };
  }

  throw new ApiError(404, { error: 'not found' });
}

function mockResult(tool, body, teaser, tier) {
  const subject = body?.input || body?.url || 'your brand';
  // Integrations → the user's own connected Google data (or a connect prompt).
  if (tool.integration) {
    const conn = (mockState().user.integrations || {})[tool.integration];
    if (!conn?.connected) return { needsConnect: tool.integration, text: `Connect your ${tool.name} account under Integrations to use this tool.` };
    return integrationResult(tool.integration, { ...body, input: body.input || conn.account });
  }
  // Content Checker / AI Content Optimiser return HTML reports.
  if (tool.id === 'content-check') {
    return { html: `<div style="display:flex;gap:8px;margin-bottom:14px"><div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;color:#64748b">READABILITY</div><div style="font-size:18px;font-weight:700">84 · Easy</div></div><div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;color:#64748b">ISSUES</div><div style="font-size:18px;font-weight:700">2</div></div></div><h3 style="font-weight:700">Issues — 2</h3><div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><strong>grammar</strong> · <span style="color:#b91c1c;text-decoration:line-through">you're items</span> → <span style="color:#16a34a">your items</span></div><div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><strong>compliance</strong><p style="color:#475569;margin:6px 0">Avoid the superlative "cheapest".</p></div>` };
  }
  if (tool.id === 'content-writer') {
    return { html: `<h3 style="font-weight:700">QA agent findings — 8 agents</h3>${['Branding Check', 'Legal & Compliance', 'Language & Readability', 'Length & Sufficiency', 'Formatting', 'Flow & Cohesion', 'FAQs', 'Schema Markup'].map((l) => `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><strong>${l}</strong> <span style="background:#eef2ff;color:#4f46e5;border-radius:999px;padding:1px 8px;font-size:11px">score 8</span><p style="color:#475569;margin:6px 0">In production this is the live agent analysis with concrete, applyable suggestions.</p></div>`).join('')}` };
  }
  if (tool.id === 'schema') {
    const obj = { '@context': 'https://schema.org', '@type': body.type || 'LocalBusiness', name: body.name || 'Acme Corp' };
    if (body.url) obj.url = body.url;
    if (body.telephone) obj.telephone = body.telephone;
    const block = `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n</script>`.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return { html: `<p style="color:#475569;margin:0 0 8px">Paste this into your page's &lt;head&gt;:</p><pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:10px;overflow:auto;font-size:12px">${block}</pre>` };
  }
  if (tool.id === 'time-to-rank') {
    const kws = String(body.input || 'keyword').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const times = ['0-3 months', '3-6 months', '6-9 months', '9-12 months'];
    return { rows: kws.map((k, i) => ({ keyword: k, volume: 5400 - i * 600, difficulty: 18 + i * 12, cpc: `S$${(1.5 + i * 0.6).toFixed(2)}`, timeToRank: times[Math.min(i, 3)] })) };
  }
  if (tool.id === 'anchor-cleaner') {
    return { html: `<h3 style="font-weight:700">Anchor audit — ${subject}</h3><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"><div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;color:#64748b">HEALTH</div><div style="font-size:18px;font-weight:700">72/100</div></div><div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;color:#64748b">INTERNAL LINKS</div><div style="font-size:18px;font-weight:700">34</div></div><div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;color:#64748b">GENERIC</div><div style="font-size:18px;font-weight:700;color:#dc2626">5</div></div></div><h4 style="font-weight:700">Anchors to fix — 6 of 34</h4><p style="color:#475569">In production this lists each over-optimised, generic or broken internal anchor with a fix + priority.</p>` };
  }
  if (tool.id === 'perf-marketing') {
    return { html: `<div style="border-left:3px solid #4f46e5;background:#f8fafc;padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:16px">For ${subject}, focus budget on high-intent search first, then layer Meta for retargeting. (sample)</div><h3 style="font-weight:700">Estimated budget range (SGD)</h3><div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px"><div style="flex:1;min-width:120px;border:1px solid #e2e8f0;border-top:3px solid #16a34a;border-radius:10px;padding:10px"><div style="font-size:11px;color:#64748b">CONSERVATIVE</div><div style="font-size:18px;font-weight:700">S$3,000</div></div><div style="flex:1;min-width:120px;border:1px solid #e2e8f0;border-top:3px solid #2563eb;border-radius:10px;padding:10px"><div style="font-size:11px;color:#64748b">RECOMMENDED</div><div style="font-size:18px;font-weight:700">S$6,000</div></div><div style="flex:1;min-width:120px;border:1px solid #e2e8f0;border-top:3px solid #ea580c;border-radius:10px;padding:10px"><div style="font-size:11px;color:#64748b">AGGRESSIVE</div><div style="font-size:18px;font-weight:700">S$12,000</div></div></div><h3 style="font-weight:700">Recommended channel mix</h3><div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><strong>Google Search Ads</strong> <span style="background:#16a34a;color:#fff;border-radius:999px;padding:1px 8px;font-size:11px">High</span> — 60%</div><div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><strong>Meta Ads (Facebook/Instagram)</strong> <span style="background:#d97706;color:#fff;border-radius:999px;padding:1px 8px;font-size:11px">Medium</span> — 40%</div>` };
  }
  // Tools whose real upstream returns ready HTML.
  if (tool.id === 'persona' || tool.id === 'landing-audit' || tool.id === 'media-plan') {
    if (teaser) return { teaserMessage: `Unlock the full ${tool.name} with Pro`, detailsLocked: true };
    return { html: `<h3 style="margin:0 0 8px;font-weight:700">Sample ${tool.name} — ${subject}</h3>` +
      `<p style="color:#475569">In production this renders the live HTML report from the backend.</p>` +
      `<ul><li>✅ Finding one with a concrete recommendation</li><li>✅ Finding two</li><li>✅ Finding three</li></ul>` };
  }
  if (tool.category === 'Content' || tool.cost.startsWith('ai_')) {
    const txt = tool.id === 'caption'
      ? `1. ${subject}, reimagined. ☕ The everyday upgrade you didn't know you needed. #SGBrands #MadeForYou #DailyEdit\n\n` +
        `2. Stop scrolling — ${subject} just changed the game. Here's why it matters. ✨ #Innovation #SmallBusinessSG\n\n` +
        `3. We built ${subject} for the ones who notice the details. Are you one of them? 👀 #Craft #LocalLove`
      : `✨ Sample ${tool.name} output for "${subject}":\n\nHere's a polished, on-brand draft generated to demonstrate the tool. In production this is your real AI result, metered by tokens.`;
    if (teaser) return { teaserMessage: `Unlock the full ${tool.name} with Pro`, preview: txt.slice(0, 120) + '…' };
    return { text: txt };
  }
  // Data tool → rows (mirrors the real mangoolsKeywords adapter output)
  const allRows = Array.from({ length: 32 }, (_, i) => ({
    keyword: `${subject} idea ${i + 1}`,
    volume: 5400 - i * 120,
    difficulty: 12 + (i % 40),
    cpc: `S$${(1.2 + (i % 9) * 0.4).toFixed(2)}`,
    intent: ['Informational', 'Commercial', 'Transactional'][i % 3],
  }));
  if (teaser) return { summary: { found: allRows.length }, detailsLocked: true, teaserMessage: `Full report unlocks with ${PLANS[tool.minTier].name}` };
  if (tool.freeCap && tier === 'free') {
    return { rows: allRows.slice(0, tool.freeCap), blurredCount: allRows.length - tool.freeCap, capMessage: `${allRows.length - tool.freeCap} more rows — upgrade to reveal` };
  }
  return { rows: allRows };
}
