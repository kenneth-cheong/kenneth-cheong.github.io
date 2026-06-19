// ─────────────────────────────────────────────────────────────────────────
// LinkedIn Ads integration — Marketing Developer Platform (MDP).
//
// Mirrors the google.mjs connector interface so the registry (integrations.mjs)
// dispatches to it generically.
//
// ⚠️ GATING: the ad scopes (`r_ads`, `r_ads_reporting`) are locked behind
// LinkedIn Marketing Developer Platform approval — you apply and LinkedIn
// reviews the app before granting them. Until LINKEDIN_CLIENT_ID +
// LINKEDIN_CLIENT_SECRET are set, the connector is hidden in the UI (see
// oauthConfigured). See docs/linkedin-mdp-application.md.
//
// TOKENS: access token ~60 days, refresh token ~12 months (refresh only works
// once MDP access is granted). exchangeCode()/refresh() return the standard
// { access_token, expires_in, refresh_token } shape the callback persists.
//
// DATA: account + analytics pulls reuse the agency monday Lambda's
// linkedin_get_ad_accounts / linkedin_get_analytics actions (same proxy the
// index.html app uses) — LinkedIn blocks browser CORS and uses fiddly Rest.li
// encoding, so the agency already solved this server-side. We obtain the token
// via real OAuth (not token-paste) and hand it to that proxy.
// ─────────────────────────────────────────────────────────────────────────
import { decrypt } from './crypto.mjs';
import { UPSTREAMS } from '../metering/upstreams.mjs';

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || '';
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET || '';

const SCOPES = ['r_ads', 'r_ads_reporting'];

export function oauthConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

export function authUrl(_provider, state, redirect) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    state,
    scope: SCOPES.join(' '),
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

async function tokenCall(form) {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(j.error_description || `linkedin token ${res.status}`);
  return j;
}

export async function exchangeCode(code, redirect) {
  const j = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  return { access_token: j.access_token, expires_in: j.expires_in, refresh_token: j.refresh_token, scope: SCOPES.join(' ') };
}

async function refreshAccessToken(refreshToken) {
  return tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
}

async function accessTokenFor(conn) {
  if (conn.accessToken && conn.expiresAt && Date.now() < conn.expiresAt - 60_000) return decrypt(conn.accessToken);
  if (conn.refreshToken) {
    const t = await refreshAccessToken(decrypt(conn.refreshToken));
    return t.access_token;
  }
  throw new Error('linkedin token expired — reconnect under Integrations');
}

// All LinkedIn data flows through the agency monday Lambda's linkedin_get_*
// actions (see UPSTREAMS.mondayBridge), exactly as the index.html app does — but
// fed the OAuth token we obtained rather than a hand-pasted one.
async function postMonday(action, payload) {
  const res = await fetch(UPSTREAMS.mondayBridge, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  // Unwrap API-Gateway proxy envelopes ({statusCode, body}) like google.mjs does.
  if (j && typeof j === 'object' && j.statusCode !== undefined && j.body !== undefined) {
    j = typeof j.body === 'string' ? JSON.parse(j.body) : j.body;
  }
  if (!res.ok) throw new Error(`${action} ${res.status}`);
  return j || {};
}

function dayRange(range) {
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  return { start, end };
}
function comparisonRange(range, code) {
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  if (code === 'prev_year') return { start: new Date(start.getTime() - 365 * 86400_000), end: new Date(end.getTime() - 365 * 86400_000) };
  const prevEnd = new Date(start.getTime() - 86400_000);
  const prevStart = new Date(prevEnd.getTime() - days * 86400_000);
  return { start: prevStart, end: prevEnd };
}
function compareCode(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('year')) return 'prev_year';
  if (s.includes('period') || s === 'previous') return 'prev_period';
  return 'none';
}
const ymd = (d) => d.toISOString().slice(0, 10);
const money = (n) => Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => `${(Number(n) * 100).toFixed(1)}%`;
const pctChange = (cur, prev) => {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  return p === 0 ? null : ((c - p) / p) * 100;
};
const acctId = (raw) => String(raw || '').replace(/\D/g, '');

// One campaign-pivoted analytics pull via the monday Lambda → breakdown rows +
// raw totals. Field parsing mirrors the index.html app (stats live on
// `e.statistics` or the element itself; the Lambda already resolves names).
async function breakdown(accountId, token, start, end) {
  const data = await postMonday('linkedin_get_analytics', {
    access_token: token, account_id: accountId,
    start_date: ymd(start), end_date: ymd(end), pivot: 'CAMPAIGN',
  });
  const els = data.elements || data.data || [];
  const rows = els.map((e, i) => {
    const stats = e.statistics || e;
    const cost = Number(stats.costInLocalCurrency || 0);
    const clicks = Number(stats.clicks || 0);
    const impressions = Number(stats.impressions || 0);
    const conv = Number(stats.externalWebsiteConversions || stats.conversions || 0);
    return {
      campaign: e.campaignName || e.name || e.id || `Campaign ${i + 1}`,
      impressions, clicks,
      ctr: pct(impressions ? clicks / impressions : 0),
      spend: money(cost), conversions: conv, cpa: conv ? money(cost / conv) : '—',
    };
  });
  const raw = {
    spend: rows.reduce((a, r) => a + (Number(String(r.spend).replace(/[^0-9.]/g, '')) || 0), 0),
    clicks: rows.reduce((a, r) => a + r.clicks, 0),
    conversions: rows.reduce((a, r) => a + r.conversions, 0),
  };
  return { rows, raw };
}

async function deltas(accountId, token, body, cur) {
  const code = compareCode(body.compare);
  if (code === 'none') return null;
  const { start, end } = comparisonRange(body.range, code);
  const prev = (await breakdown(accountId, token, start, end)).raw;
  const curCpa = cur.conversions ? cur.spend / cur.conversions : 0;
  const prevCpa = prev.conversions ? prev.spend / prev.conversions : 0;
  return { spend: pctChange(cur.spend, prev.spend), clicks: pctChange(cur.clicks, prev.clicks), conversions: pctChange(cur.conversions, prev.conversions), cpa: pctChange(curCpa, prevCpa) };
}

export async function fetchIntegration(_provider, conn, body) {
  try {
    if (!conn?.connected || !conn.accessToken) throw new Error('not connected');
    const token = await accessTokenFor(conn);
    const accountId = acctId(body.input || conn.account);
    if (!accountId) throw new Error('no ad account');
    const { start, end } = dayRange(body.range);
    const main = await breakdown(accountId, token, start, end);
    // The monday Lambda's analytics action returns campaign-aggregated rows (no
    // per-day breakdown), so the trend chart is omitted for LinkedIn for now.
    const del = await deltas(accountId, token, body, main.raw).catch((e) => { console.warn('linkedin_compare_failed', e.message); return null; });
    const { spend, clicks, conversions } = main.raw;
    return { rows: main.rows, series: [], deltas: del, summary: { cost: money(spend), clicks, conversions, cpa: conversions ? money(spend / conversions) : '—' }, source: 'live' };
  } catch (e) {
    console.warn('linkedin_live_fetch_failed', e.message);
    return null;
  }
}

export async function listAccounts(_provider, conn) {
  const token = await accessTokenFor(conn);
  const data = await postMonday('linkedin_get_ad_accounts', { access_token: token });
  // Account id is the numeric id, or derived from the sponsoredAccount URN —
  // same as the index.html dropdown.
  return (data.elements || [])
    .map((a) => {
      const id = a.id || String(a.reference || '').replace('urn:li:sponsoredAccount:', '');
      return id ? { id: String(id), label: `${a.name || 'Ad account'} (${id})` } : null;
    })
    .filter(Boolean);
}

export async function detectAccount(_provider, accessToken) {
  try {
    const list = await listAccounts('linkedin-ads', { accessToken, expiresAt: Date.now() + 600_000 });
    return list[0]?.id || '';
  } catch { return ''; }
}
