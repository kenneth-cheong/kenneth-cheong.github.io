// API client. Talks to the SAM backend in production; falls back to an
// in-memory MOCK when VITE_MOCK=1 so the whole UI runs with no AWS at all.
import { PLANS, TOOLS, CREDIT_COSTS, TOPUP_PACKS, topupById, tierMeets } from '@shared/catalog.mjs';

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
    saveMock(s);
    return { tool: tool.id, teaser, result, creditsUsed: used, creditsRemaining: mockTotal(s.user) };
  }

  throw new ApiError(404, { error: 'not found' });
}

function mockResult(tool, body, teaser, tier) {
  const subject = body?.input || body?.url || 'your brand';
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
