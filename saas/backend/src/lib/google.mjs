// ─────────────────────────────────────────────────────────────────────────
// Google OAuth + live data for the Integrations tools — mirrors index.html.
//
// Matches the agency app exactly:
//   • Same OAuth client id + scopes.
//   • Token exchange/refresh via the agency `googleAuth` Lambda (it holds the
//     client secret), so the SaaS needs no GOOGLE_CLIENT_SECRET.
//   • GSC: direct Search Console API. GA4 + Ads: the agency `gscIntegration`
//     and `googleAds` Lambdas (which carry the Ads developer token).
//
// Everything degrades to seeded connector data when a call fails / isn't set,
// so the product is always usable.
// ─────────────────────────────────────────────────────────────────────────
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { decrypt } from './crypto.mjs';

// Same client as index.html unless overridden.
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1080212071394-drtg41ou6bjm412teq626rf7dn8b41q6.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT = process.env.GOOGLE_OAUTH_REDIRECT || '';
const ADS_DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
const ADS_LOGIN_CID = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '';

// The unified scope set index.html requests (one consent for all products).
// `webmasters` (full, not readonly) so the Sitemaps tool can submit/delete —
// it still covers all read access. Existing users must reconnect to upgrade.
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords',
  'openid', 'email', 'profile',
].join(' ');

// The redirect URI is derived per-request from the API's own domain (see
// app handler) so the template needn't reference the API resource — that
// reference created a CloudFormation circular dependency. Callers pass it in;
// the env var remains a fallback for any non-request context.
export function oauthConfigured() {
  return !!CLIENT_ID;
}

export function authUrl(provider, state, redirect = REDIRECT) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    include_granted_scopes: 'true',
    // select_account shows Google's account chooser so a user can connect a
    // different Google account per source (e.g. client's GSC, agency's Ads).
    prompt: 'select_account consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  if (j && typeof j === 'object' && j.statusCode !== undefined && j.body !== undefined) {
    j = typeof j.body === 'string' ? JSON.parse(j.body) : j.body;
  }
  if (!res.ok) throw new Error(`${url.split('/').pop()} ${res.status}`);
  return j;
}

export async function exchangeCode(code, redirect = REDIRECT) {
  // Prefer direct exchange when a secret is configured; else reuse the agency
  // Lambda (which holds the secret), exactly as index.html's code flow does.
  if (CLIENT_SECRET) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    return res.json();
  }
  return postJson(UPSTREAMS.googleAuth, { action: 'google_token_exchange', code, client_id: CLIENT_ID, redirect_uri: redirect });
}

async function refreshAccessToken(refreshToken) {
  if (CLIENT_SECRET) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`token refresh ${res.status}`);
    return res.json();
  }
  return postJson(UPSTREAMS.googleAuth, { action: 'google_refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });
}

async function accessTokenFor(conn) {
  if (conn.accessToken && conn.expiresAt && Date.now() < conn.expiresAt - 60_000) return decrypt(conn.accessToken);
  const t = await refreshAccessToken(decrypt(conn.refreshToken));
  return t.access_token;
}

// A YYYY-MM-DD window from either a preset ("Last 28 days") or an explicit
// custom start/end (range === 'Custom'). Custom dates are clamped in order.
function dayRange(range, customStart, customEnd) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  if (range === 'Custom' && customStart && customEnd) {
    const s = String(customStart).slice(0, 10), e = String(customEnd).slice(0, 10);
    return s <= e ? { startDate: s, endDate: e } : { startDate: e, endDate: s };
  }
  const days = range === 'Last 7 days' ? 7 : range === 'Last 3 months' ? 90 : 28;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  return { startDate: fmt(start), endDate: fmt(end) };
}
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const money = (n) => `S$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Compare-to ranges (period-over-period deltas, like index.html) ────────────
function compareCode(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('year')) return 'prev_year';
  if (s.includes('period') || s === 'previous') return 'prev_period';
  return 'none';
}
// The comparison window for a given preset: the equal-length period immediately
// before it (prev_period), or the same window shifted back a year (prev_year).
function comparisonRange(range, code, customStart, customEnd) {
  const fmt = (d) => d.toISOString().slice(0, 10);
  const cur = dayRange(range, customStart, customEnd);
  const start = new Date(cur.startDate), end = new Date(cur.endDate);
  if (code === 'prev_year') {
    return { startDate: fmt(new Date(start.getTime() - 365 * 86400_000)), endDate: fmt(new Date(end.getTime() - 365 * 86400_000)) };
  }
  // Previous period = the equal-length window ending the day before this one starts.
  const durationMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 86400_000);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  return { startDate: fmt(prevStart), endDate: fmt(prevEnd) };
}
const pctChange = (cur, prev) => {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  return p === 0 ? null : ((c - p) / p) * 100;
};

// ── GSC: direct Search Console API (as index.html) ────────────────────────────
async function liveGsc(conn, body) {
  const token = await accessTokenFor(conn);
  const site = (body.input || conn.account || '').trim();
  if (!site) throw new Error('no site');
  const dim = ['page', 'country', 'device'].includes(body.dimension) ? body.dimension : 'query';
  const { startDate, endDate } = dayRange(body.range, body.startDate, body.endDate);
  const main = await gscBreakdown(token, site, dim, startDate, endDate);
  // Second pull: a day-by-day series for the trend chart (as index.html draws).
  // Both the trend and the compare are best-effort — neither must sink the breakdown.
  const series = await gscSeries(token, site, startDate, endDate).catch((e) => { console.warn('gsc_series_failed', e.message); return []; });
  const deltas = await gscDeltas(token, site, dim, body, main.raw).catch((e) => { console.warn('gsc_compare_failed', e.message); return null; });
  const striking = await gscStriking(token, site, startDate, endDate).catch((e) => { console.warn('gsc_striking_failed', e.message); return []; });
  const { clicks, impressions, ctr, position } = main.raw;
  return { rows: main.rows, series, deltas, striking, summary: { clicks, impressions, ctr: pct(ctr), avgPosition: position ? position.toFixed(1) : '0' } };
}

// Striking distance: queries ranking on page 2 (position ~11–20) where a small
// push lands page 1. index.html's "Easy Wins" card.
async function gscStriking(token, site, startDate, endDate) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 200 }),
  });
  if (!res.ok) throw new Error(`gsc-striking ${res.status}`);
  const data = await res.json();
  return (data.rows || [])
    .filter((r) => (r.position ?? 0) > 10.5 && (r.position ?? 0) <= 20.5)
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, 15)
    .map((r) => ({ query: r.keys?.[0] ?? '—', clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: pct(r.ctr ?? 0), position: (r.position ?? 0).toFixed(1) }));
}

// ── GSC operations: URL Inspection / Sitemaps / Indexing (index.html parity) ──
// Bulk URL Inspection — index status, coverage, last crawl per URL.
export async function gscInspect(conn, body) {
  const token = await accessTokenFor(conn);
  const site = (body.input || conn.account || '').trim();
  if (!site) throw new Error('no site');
  const urls = splitUrls(body.urls).slice(0, 15); // cap per run
  if (!urls.length) throw new Error('no urls');
  const rows = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: site, languageCode: 'en-US' }),
      });
      if (!res.ok) return { url, verdict: `Error ${res.status}`, coverage: '—', lastCrawl: '—' };
      const r = (await res.json())?.inspectionResult?.indexStatusResult || {};
      return { url, verdict: r.verdict || '—', coverage: r.coverageState || '—', lastCrawl: r.lastCrawlTime ? r.lastCrawlTime.slice(0, 10) : '—' };
    } catch (e) { return { url, verdict: 'Error', coverage: e.message, lastCrawl: '—' }; }
  }));
  return { rows, count: rows.length };
}

// Sitemaps — list / submit / delete. Submit & delete need the full `webmasters`
// scope (not readonly), so a stale token will 403 until the user reconnects.
export async function gscSitemaps(conn, body) {
  const token = await accessTokenFor(conn);
  const site = (body.input || conn.account || '').trim();
  if (!site) throw new Error('no site');
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`;
  const action = String(body.sitemapAction || 'list').toLowerCase();
  const auth = { Authorization: `Bearer ${token}` };

  if (action === 'submit' || action === 'delete') {
    const feed = (body.sitemapUrl || '').trim();
    if (!feed) throw new Error('no sitemap url');
    const res = await fetch(`${base}/${encodeURIComponent(feed)}`, { method: action === 'submit' ? 'PUT' : 'DELETE', headers: auth });
    if (!res.ok) {
      if (res.status === 403) throw new Error('Permission denied — reconnect Google in Integrations to grant sitemap write access.');
      throw new Error(`sitemap ${action} failed (${res.status})`);
    }
    return { ok: true, action, feed };
  }

  const res = await fetch(base, { headers: auth });
  if (!res.ok) throw new Error(`sitemaps ${res.status}`);
  const data = await res.json();
  const rows = (data.sitemap || []).map((s) => ({
    sitemap: s.path, type: s.isSitemapsIndex ? 'index' : (s.type || 'sitemap'),
    submitted: s.lastSubmitted ? s.lastSubmitted.slice(0, 10) : '—',
    lastRead: s.lastDownloaded ? s.lastDownloaded.slice(0, 10) : '—',
    pending: s.isPending ? 'yes' : 'no',
    warnings: Number(s.warnings || 0), errors: Number(s.errors || 0),
  }));
  return { rows };
}

// Indexing API — request (re)indexing or removal of URLs.
export async function gscIndexing(conn, body) {
  const token = await accessTokenFor(conn);
  const urls = splitUrls(body.urls).slice(0, 15);
  if (!urls.length) throw new Error('no urls');
  const type = /remov|delet/i.test(String(body.indexType || '')) ? 'URL_DELETED' : 'URL_UPDATED';
  const rows = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type }),
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => '');
        return { url, status: `Error ${res.status}`, note: /permission|403/i.test(msg) ? 'Must be a verified owner' : '' };
      }
      return { url, status: type === 'URL_DELETED' ? 'Removal requested' : 'Submitted', note: '' };
    } catch (e) { return { url, status: 'Error', note: e.message }; }
  }));
  return { rows, type };
}

// Split a textarea of URLs (newline/comma/space separated) into a clean list.
function splitUrls(raw) {
  return String(raw || '').split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
}

// One breakdown query → rows + raw numeric totals (shared by the main pull and
// the comparison-period pull so deltas are apples-to-apples).
async function gscBreakdown(token, site, dim, startDate, endDate) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: [dim], rowLimit: 25 }),
  });
  if (!res.ok) throw new Error(`gsc ${res.status}`);
  const data = await res.json();
  const rows = (data.rows || []).map((r) => ({
    [dim]: r.keys?.[0] ?? '—', clicks: r.clicks ?? 0, impressions: r.impressions ?? 0,
    ctr: pct(r.ctr ?? 0), position: (r.position ?? 0).toFixed(1),
  }));
  const clicks = rows.reduce((a, r) => a + (r.clicks || 0), 0);
  const impressions = rows.reduce((a, r) => a + (r.impressions || 0), 0);
  const position = rows.length ? rows.reduce((a, r) => a + Number(r.position), 0) / rows.length : 0;
  return { rows, raw: { clicks, impressions, ctr: clicks / (impressions || 1), position } };
}

async function gscDeltas(token, site, dim, body, cur) {
  const code = compareCode(body.compare);
  if (code === 'none') return null;
  const { startDate, endDate } = comparisonRange(body.range, code, body.startDate, body.endDate);
  const prev = (await gscBreakdown(token, site, dim, startDate, endDate)).raw;
  return { clicks: pctChange(cur.clicks, prev.clicks), impressions: pctChange(cur.impressions, prev.impressions), ctr: pctChange(cur.ctr, prev.ctr), position: pctChange(cur.position, prev.position) };
}

// Clicks/impressions per day for the GSC trend chart.
async function gscSeries(token, site, startDate, endDate) {
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 90 }),
  });
  if (!res.ok) throw new Error(`gsc-series ${res.status}`);
  const data = await res.json();
  return (data.rows || [])
    .map((r) => ({ date: r.keys?.[0], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0 }))
    .filter((r) => r.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── GA4: agency gscIntegration Lambda (ga4RunReport) ──────────────────────────
async function liveGa4(conn, body) {
  const token = await accessTokenFor(conn);
  const propertyId = (body.input || conn.account || '').replace(/^properties\//, '').trim();
  if (!propertyId) throw new Error('no property');
  const dimName = body.dimension === 'page' ? 'pagePath' : body.dimension === 'country' ? 'country' : body.dimension === 'device' ? 'deviceCategory' : 'sessionDefaultChannelGroup';
  const { startDate, endDate } = dayRange(body.range, body.startDate, body.endDate);
  const main = await ga4Breakdown(token, propertyId, dimName, body.dimension, startDate, endDate);
  const series = await ga4Series(token, propertyId, startDate, endDate).catch((e) => { console.warn('ga4_series_failed', e.message); return []; });
  const deltas = await ga4Deltas(token, propertyId, dimName, body, main.raw).catch((e) => { console.warn('ga4_compare_failed', e.message); return null; });
  return { rows: main.rows, series, deltas, summary: main.raw };
}

async function ga4Breakdown(token, propertyId, dimName, dimKey, startDate, endDate) {
  const data = await postJson(UPSTREAMS.gscIntegration, {
    action: 'ga4RunReport', propertyId, access_token: token,
    payload: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: dimName }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'conversions' }],
      limit: 25,
    },
  });
  const rows = (data.rows || []).map((r) => ({
    [dimKey || 'channel']: r.dimensionValues?.[0]?.value ?? '—',
    sessions: Number(r.metricValues?.[0]?.value || 0),
    users: Number(r.metricValues?.[1]?.value || 0),
    engagedSessions: Number(r.metricValues?.[2]?.value || 0),
    conversions: Number(r.metricValues?.[3]?.value || 0),
  }));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  return { rows, raw: { sessions: sum('sessions'), users: sum('users'), engagedSessions: sum('engagedSessions'), conversions: sum('conversions') } };
}

async function ga4Deltas(token, propertyId, dimName, body, cur) {
  const code = compareCode(body.compare);
  if (code === 'none') return null;
  const { startDate, endDate } = comparisonRange(body.range, code, body.startDate, body.endDate);
  const prev = (await ga4Breakdown(token, propertyId, dimName, body.dimension, startDate, endDate)).raw;
  return { sessions: pctChange(cur.sessions, prev.sessions), users: pctChange(cur.users, prev.users), engagedSessions: pctChange(cur.engagedSessions, prev.engagedSessions), conversions: pctChange(cur.conversions, prev.conversions) };
}

// Sessions/users per day for the GA4 trend chart.
async function ga4Series(token, propertyId, startDate, endDate) {
  const data = await postJson(UPSTREAMS.gscIntegration, {
    action: 'ga4RunReport', propertyId, access_token: token,
    payload: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 365,
    },
  });
  return (data.rows || []).map((r) => {
    const d = r.dimensionValues?.[0]?.value || ''; // GA4 returns YYYYMMDD
    return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: Number(r.metricValues?.[0]?.value || 0), users: Number(r.metricValues?.[1]?.value || 0) };
  }).filter((r) => r.date.length === 10).sort((a, b) => a.date.localeCompare(b.date));
}

// ── Google Ads: agency googleAds Lambda (GAQL) ────────────────────────────────
async function liveAds(conn, body) {
  if (!ADS_DEV_TOKEN) throw new Error('no ads dev token');
  // Run GAQL AS THE USER (their access token) through the gscIntegration Lambda's
  // adsSearchStream action — exactly like index.html's fetchAdsGAQL. The old
  // standalone googleAds endpoint (UPSTREAMS.googleAds) returns API-Gateway 403
  // for server-side calls, so the pull never reached Google.
  const token = await accessTokenFor(conn);
  const customerId = String(body.input || conn.account || '').replace(/[^0-9]/g, '');
  if (!customerId) throw new Error('no customer id');
  const { startDate, endDate } = dayRange(body.range, body.startDate, body.endDate);
  const main = await adsBreakdown(customerId, startDate, endDate, token);
  const series = await adsSeries(customerId, startDate, endDate, token).catch((e) => { console.warn('ads_series_failed', e.message); return []; });
  const deltas = await adsDeltas(customerId, body, main.raw, token).catch((e) => { console.warn('ads_compare_failed', e.message); return null; });
  const { cost, clicks, conversions } = main.raw;
  return { rows: main.rows, series, deltas, summary: { cost: money(cost), clicks, conversions, cpa: conversions ? money(cost / conversions) : '—' } };
}

// Run a GAQL query as the user via gscIntegration → adsSearchStream (mirrors
// index.html). Returns the flattened result rows; throws on an upstream error.
async function adsGaql(query, customerId, token) {
  const data = await postJson(UPSTREAMS.gscIntegration, {
    action: 'adsSearchStream', customerId, access_token: token,
    developerToken: ADS_DEV_TOKEN, loginCustomerId: ADS_LOGIN_CID,
    payload: { query: query.trim() },
  });
  if (data && !Array.isArray(data) && data.error) throw new Error(typeof data.error === 'object' ? JSON.stringify(data.error) : String(data.error));
  return Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data.flatMap((c) => c.results || []) : []);
}

async function adsBreakdown(customerId, startDate, endDate, token) {
  const query = `SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY metrics.cost_micros DESC LIMIT 25`;
  const results = await adsGaql(query, customerId, token);
  const rows = results.map((r) => {
    const cost = Number(r.metrics?.costMicros || r.metrics?.cost_micros || 0) / 1e6;
    const conv = Number(r.metrics?.conversions || 0);
    return {
      campaign: r.campaign?.name || '—',
      impressions: Number(r.metrics?.impressions || 0),
      clicks: Number(r.metrics?.clicks || 0),
      ctr: pct(Number(r.metrics?.ctr || 0)),
      cost: money(cost), conversions: conv, cpa: conv ? money(cost / conv) : '—',
    };
  });
  const cost = rows.reduce((a, r) => a + (Number(String(r.cost).replace(/[^0-9.]/g, '')) || 0), 0);
  const clicks = rows.reduce((a, r) => a + r.clicks, 0);
  const conversions = rows.reduce((a, r) => a + (r.conversions || 0), 0);
  return { rows, raw: { cost, clicks, conversions } };
}

async function adsDeltas(customerId, body, cur, token) {
  const code = compareCode(body.compare);
  if (code === 'none') return null;
  const { startDate, endDate } = comparisonRange(body.range, code, body.startDate, body.endDate);
  const prev = (await adsBreakdown(customerId, startDate, endDate, token)).raw;
  const curCpa = cur.conversions ? cur.cost / cur.conversions : 0;
  const prevCpa = prev.conversions ? prev.cost / prev.conversions : 0;
  return { cost: pctChange(cur.cost, prev.cost), clicks: pctChange(cur.clicks, prev.clicks), conversions: pctChange(cur.conversions, prev.conversions), cpa: pctChange(curCpa, prevCpa) };
}

// Cost/clicks per day for the Ads trend chart — GAQL segments by date across all
// campaigns, so sum each metric per day.
async function adsSeries(customerId, startDate, endDate, token) {
  const query = `SELECT segments.date, metrics.cost_micros, metrics.clicks FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  const results = await adsGaql(query, customerId, token);
  const byDate = new Map();
  for (const r of results) {
    const date = r.segments?.date;
    if (!date) continue;
    const cur = byDate.get(date) || { date, cost: 0, clicks: 0 };
    cur.cost += Number(r.metrics?.costMicros || r.metrics?.cost_micros || 0) / 1e6;
    cur.clicks += Number(r.metrics?.clicks || 0);
    byDate.set(date, cur);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchIntegration(provider, conn, body) {
  try {
    // Live when we have a usable token: a fresh browser access token (GSI token
    // flow, as index.html uses) OR a stored refresh token (server OAuth).
    const usable = conn?.connected && (conn.accessToken || (oauthConfigured() && conn.refreshToken));
    if (!usable) throw new Error('not connected');
    let res;
    if (provider === 'gsc') res = await liveGsc(conn, body);
    else if (provider === 'ga4') res = await liveGa4(conn, body);
    else if (provider === 'google-ads') res = await liveAds(conn, body);
    if (res) return { ...res, source: 'live' };
  } catch (e) {
    console.warn('integration_live_fetch_failed', provider, e.message);
  }
  // No usable token, or the live pull failed → signal "not available" so the
  // caller shows a connect gate. No seeded/demo fallback.
  return null;
}

// ── Account/property/customer discovery (for the picker) ──────────────────────
export async function listAccounts(provider, conn) {
  const token = await accessTokenFor(conn);
  if (provider === 'gsc') {
    const r = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return (d.siteEntry || [])
      .filter((s) => ['siteFullUser', 'siteOwner'].includes(s.permissionLevel))
      .map((s) => ({ id: s.siteUrl, label: s.siteUrl }));
  }
  if (provider === 'ga4') {
    const d = await postJson(UPSTREAMS.gscIntegration, { action: 'ga4ListProperties', access_token: token });
    return (d.accountSummaries || []).flatMap((a) => (a.propertySummaries || []).map((p) => ({
      id: p.property, label: `${p.displayName} (${p.property})`,
    })));
  }
  if (provider === 'google-ads') {
    const d = await postJson(UPSTREAMS.gscIntegration, { action: 'adsListCustomers', access_token: token, developerToken: ADS_DEV_TOKEN, loginCustomerId: ADS_LOGIN_CID });
    // Keep manager (MCC) accounts in the list — index.html lists them too;
    // filtering them out is why an MCC login showed an empty dropdown. Tag
    // managers so the picker can label them, and surface non-managers first.
    return (d.results || [])
      .filter((r) => r.customerClient)
      .map((r) => {
        const id = String(r.customerClient.clientCustomer || '').replace('customers/', '');
        const isManager = r.customerClient.manager === true;
        return { id, label: `${r.customerClient.descriptiveName || 'Account'} (${id})${isManager ? ' · Manager' : ''}`, isManager };
      })
      .filter((a) => a.id)
      .sort((a, b) => (a.isManager === b.isManager ? 0 : a.isManager ? 1 : -1));
  }
  return [];
}

/** Best-effort default account right after connecting. */
export async function detectAccount(provider, accessToken) {
  try {
    const list = await listAccounts(provider, { accessToken, expiresAt: Date.now() + 600_000 });
    return list[0]?.id || '';
  } catch { return ''; }
}

// The signed-in Google account's email (openid/email scope), so the UI can show
// which account each source is connected as. Best-effort — '' if unavailable.
export async function detectEmail(accessToken) {
  try {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return '';
    const j = await res.json();
    return j.email || '';
  } catch { return ''; }
}
