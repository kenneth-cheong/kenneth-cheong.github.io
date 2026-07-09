// AWS Amplify Hosting usage for the Admin → Platform tab.
//
// Two independent reads, so the fast panel never waits on the slow one:
//   • amplifyUsage()      — CloudWatch traffic metrics (Requests, bytes, errors,
//                            latency) + derived rates, Cost Explorer $ (transfer +
//                            storage), and build activity from Amplify list-jobs.
//                            All quick API reads.
//   • amplifyAccessLogs() — generate-access-logs → fetch the presigned CSV →
//                            parse into top pages / referrers / devices / edge
//                            geo / cache-hit ratio / status breakdown. Heavier
//                            (a per-request log export), so it's on-demand.
//
// The AWS SDK v3 clients are `@aws-sdk/client-*` — kept external by the build and
// provided by the nodejs20 runtime — so they're dynamically imported here (never
// installed locally; keeps `npm test` from trying to resolve them).

const APP_ID = process.env.AMPLIFY_APP_ID || '';
const DOMAIN = process.env.AMPLIFY_DOMAIN || '';
const BRANCH = process.env.AMPLIFY_BRANCH || 'main';
const REGION = process.env.AWS_REGION || 'ap-southeast-1';

const DAY = 86400000;

// ── CloudWatch traffic metrics ───────────────────────────────────────────────
const NS = 'AWS/AmplifyHosting';
// Each entry → one GetMetricData query. `key` is what we return; `stat` the CW
// statistic. Latency is emitted twice (avg + p90) so the UI can show a spread.
const METRICS = [
  { key: 'requests', metric: 'Requests', stat: 'Sum' },
  { key: 'bytesDownloaded', metric: 'BytesDownloaded', stat: 'Sum' },
  { key: 'bytesUploaded', metric: 'BytesUploaded', stat: 'Sum' },
  { key: 'errors4xx', metric: '4xxErrors', stat: 'Sum' },
  { key: 'errors5xx', metric: '5xxErrors', stat: 'Sum' },
  { key: 'latencyAvg', metric: 'Latency', stat: 'Average' },
  { key: 'latencyP90', metric: 'Latency', stat: 'p90' },
];

// Bucket size: hourly for a day-or-two window, otherwise daily. Keeps the series
// readable (a 90-day hourly chart would be 2160 points).
function pickPeriod(from, to) {
  return (to - from) <= 2 * DAY ? 3600 : 86400;
}

export async function amplifyUsage({ from, to }) {
  if (!APP_ID) throw new Error('AMPLIFY_APP_ID not configured');
  const period = pickPeriod(from, to);
  const [metrics, cost, builds] = await Promise.all([
    trafficMetrics(from, to, period),
    costBreakdown(from, to).catch((e) => ({ error: e.message })),
    buildActivity(from, to).catch((e) => ({ error: e.message })),
  ]);
  return {
    // Only the public-facing identity — the raw app id / region stay server-side.
    app: { domain: DOMAIN, branch: BRANCH },
    range: { from: from.toISOString(), to: to.toISOString(), period },
    ...metrics,
    cost,
    builds,
  };
}

async function trafficMetrics(from, to, period) {
  const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
  const cw = new CloudWatchClient({ region: REGION });
  const res = await cw.send(new GetMetricDataCommand({
    StartTime: from,
    EndTime: to,
    ScanBy: 'TimestampAscending',
    MetricDataQueries: METRICS.map((m, i) => ({
      Id: `m${i}`,
      MetricStat: {
        Metric: { Namespace: NS, MetricName: m.metric, Dimensions: [{ Name: 'App', Value: APP_ID }] },
        Period: period,
        Stat: m.stat,
      },
    })),
  }));

  const byId = Object.fromEntries((res.MetricDataResults || []).map((r) => [r.Id, r]));
  // Union of all timestamps (metrics can have gaps), aligned into one series.
  const stamps = new Map(); // ms → { t, ...perMetric }
  METRICS.forEach((m, i) => {
    const r = byId[`m${i}`];
    (r?.Timestamps || []).forEach((ts, j) => {
      const ms = new Date(ts).getTime();
      if (!stamps.has(ms)) stamps.set(ms, { t: new Date(ms).toISOString() });
      stamps.get(ms)[m.key] = r.Values[j];
    });
  });
  const series = [...stamps.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  const sum = (k) => series.reduce((a, p) => a + (p[k] || 0), 0);
  const totals = {
    requests: sum('requests'),
    bytesDownloaded: sum('bytesDownloaded'),
    bytesUploaded: sum('bytesUploaded'),
    errors4xx: sum('errors4xx'),
    errors5xx: sum('errors5xx'),
  };
  const reqs = totals.requests || 0;
  // Request-weighted average latency across buckets (each bucket's avg × its reqs).
  const latWeighted = series.reduce((a, p) => a + (p.latencyAvg || 0) * (p.requests || 0), 0);
  const derived = {
    errorRate: reqs ? (totals.errors4xx + totals.errors5xx) / reqs : 0,
    errorRate5xx: reqs ? totals.errors5xx / reqs : 0,
    avgPageWeight: reqs ? totals.bytesDownloaded / reqs : 0, // bytes per request
    avgLatency: reqs ? latWeighted / reqs : 0,               // seconds
    peakLatencyP90: series.reduce((a, p) => Math.max(a, p.latencyP90 || 0), 0),
    busiestBucket: series.reduce((a, p) => ((p.requests || 0) > (a?.requests || 0) ? p : a), null),
  };
  return { series, totals, derived };
}

// ── Cost Explorer ($ transfer + storage) ─────────────────────────────────────
// CE is a global service pinned to us-east-1. Dates are YYYY-MM-DD with an
// EXCLUSIVE end, so we bump `to` to the next day to include the final day.
async function costBreakdown(from, to) {
  const { CostExplorerClient, GetCostAndUsageCommand } = await import('@aws-sdk/client-cost-explorer');
  const ce = new CostExplorerClient({ region: 'us-east-1' });
  const span = to - from;
  const granularity = span <= 40 * DAY ? 'DAILY' : 'MONTHLY';
  const start = ymd(from);
  const end = ymd(new Date(to.getTime() + DAY)); // exclusive → include `to`
  const res = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: start, End: end },
    Granularity: granularity,
    Metrics: ['UnblendedCost', 'UsageQuantity'],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['AWS Amplify'] } },
    GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
  }));

  // Collapse per-day groups into per-usage-type totals; strip the region prefix
  // (e.g. "APS1-DataTransferOut" → "DataTransferOut") for a clean label.
  const byType = {};
  let totalCost = 0;
  for (const bucket of res.ResultsByTime || []) {
    for (const g of bucket.Groups || []) {
      const raw = g.Keys?.[0] || 'Unknown';
      const label = raw.replace(/^[A-Z0-9]+-/, '');
      const cost = Number(g.Metrics?.UnblendedCost?.Amount || 0);
      const qty = Number(g.Metrics?.UsageQuantity?.Amount || 0);
      const unit = g.Metrics?.UsageQuantity?.Unit || '';
      const row = (byType[label] ||= { usageType: label, cost: 0, quantity: 0, unit });
      row.cost += cost;
      row.quantity += qty;
      totalCost += cost;
    }
  }
  return {
    currency: 'USD',
    granularity,
    totalCost,
    byType: Object.values(byType).sort((a, b) => b.cost - a.cost),
    estimated: (res.ResultsByTime || []).some((b) => b.Estimated),
  };
}

// ── Build / deploy activity (Amplify list-jobs) ──────────────────────────────
// Build minutes never hit Cost Explorer while under the free tier, so we derive
// them from the branch's job history: count + summed duration + pass/fail.
async function buildActivity(from, to) {
  if (!APP_ID) return { error: 'AMPLIFY_APP_ID not configured' };
  const { AmplifyClient, ListJobsCommand } = await import('@aws-sdk/client-amplify');
  const amp = new AmplifyClient({ region: REGION });
  let count = 0, succeeded = 0, failed = 0, cancelled = 0, durationMs = 0;
  let token, pages = 0;
  const jobs = [];
  do {
    const res = await amp.send(new ListJobsCommand({ appId: APP_ID, branchName: BRANCH, maxResults: 50, nextToken: token }));
    for (const j of res.jobSummaries || []) {
      const start = j.startTime ? new Date(j.startTime).getTime() : null;
      // A job commits to this window by its start time. Cancelled jobs have no
      // timestamps — count them only if we can't tell they're out of range.
      if (start != null && (start < from.getTime() || start > to.getTime())) continue;
      count++;
      if (j.status === 'SUCCEED') succeeded++;
      else if (j.status === 'FAILED') failed++;
      else if (j.status === 'CANCELLED') cancelled++;
      if (start != null && j.endTime) {
        const d = new Date(j.endTime).getTime() - start;
        if (d > 0) durationMs += d;
      }
      jobs.push({ id: j.jobId, status: j.status, startTime: j.startTime ? new Date(j.startTime).toISOString() : null });
    }
    token = res.nextToken;
    // Stop paging once we've walked past the window (jobs are newest-first) or
    // hit a hard page cap — protects a very long history from unbounded paging.
  } while (token && pages++ < 20 && !pastWindow(jobs, from));
  return {
    count, succeeded, failed, cancelled,
    buildMinutes: Math.round(durationMs / 60000),
    recent: jobs.slice(0, 10),
  };
}

// True once the oldest job we've seen predates the window — nothing older can
// still be in range, so paging can stop.
function pastWindow(jobs, from) {
  const oldest = jobs.filter((j) => j.startTime).at(-1);
  return oldest ? new Date(oldest.startTime).getTime() < from.getTime() : false;
}

// ── Access logs (per-request CSV) ────────────────────────────────────────────
const MAX_LOG_BYTES = 40 * 1024 * 1024; // 40MB safety cap on the CSV download
const MAX_ROWS = 300000;                 // parse cap (bounds Lambda memory/time)

export async function amplifyAccessLogs({ from, to }) {
  if (!APP_ID || !DOMAIN) throw new Error('AMPLIFY_APP_ID / AMPLIFY_DOMAIN not configured');
  const { AmplifyClient, GenerateAccessLogsCommand } = await import('@aws-sdk/client-amplify');
  const amp = new AmplifyClient({ region: REGION });
  const { logUrl } = await amp.send(new GenerateAccessLogsCommand({
    appId: APP_ID, domainName: DOMAIN, startTime: from, endTime: to,
  }));
  if (!logUrl) return { rows: 0, truncated: false, note: 'No log URL returned.' };

  const res = await fetch(logUrl);
  if (!res.ok) throw new Error(`access log fetch failed (${res.status})`);
  const csv = await readCapped(res, MAX_LOG_BYTES);
  return parseAccessLog(csv.text, csv.truncated, { from, to }, { selfDomain: DOMAIN });
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0, truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { truncated = true; reader.cancel(); break; }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// CloudFront W3C-extended log: comma-separated, values URL-encoded (%20) with
// backslash-escaped parens/equals. Unescape then decode each field.
function unescape(v) {
  const s = String(v).replace(/\\(.)/g, '$1');
  try { return decodeURIComponent(s); } catch { return s; }
}

export function parseAccessLog(text, downloadTruncated, range, opts = {}) {
  const selfDomain = (opts.selfDomain || '').toLowerCase();
  const lines = text.split('\n');
  const header = (lines.shift() || '').split(',').map((h) => h.replace(/\\(.)/g, '$1'));
  const col = (name) => header.indexOf(name);
  const iUri = col('cs-uri-stem');
  const iStatus = col('sc-status');
  const iResult = col('x-edge-result-type');
  const iRef = col('cs(Referer)');
  const iUa = col('cs(User-Agent)');
  const iPop = col('x-edge-location');
  const iBytes = col('sc-bytes');

  const pages = new Map(), referrers = new Map(), devices = new Map(),
        browsers = new Map(), geo = new Map(), status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0 };
  let rows = 0, bytes = 0, hits = 0, misses = 0, truncated = downloadTruncated;
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

  for (const line of lines) {
    if (!line) continue;
    if (rows >= MAX_ROWS) { truncated = true; break; }
    const f = line.split(',');
    // Amplify encodes field separators, so a well-formed row has exactly the
    // header's column count. Skip anything else rather than risk misaligned
    // columns (a stray unescaped comma would shift every field after it).
    if (f.length !== header.length) continue;
    rows++;
    const sc = parseInt(f[iBytes], 10); if (Number.isFinite(sc)) bytes += sc;

    const uri = iUri >= 0 ? unescape(f[iUri]) : '';
    if (uri && !isAsset(uri)) bump(pages, uri.slice(0, 200));

    const code = parseInt(f[iStatus], 10);
    if (code >= 200 && code < 300) status['2xx']++;
    else if (code >= 300 && code < 400) status['3xx']++;
    else if (code >= 400 && code < 500) status['4xx']++;
    else if (code >= 500) status['5xx']++;
    else status.other++;

    const result = iResult >= 0 ? f[iResult] : '';
    if (/hit/i.test(result)) hits++; else if (/miss/i.test(result)) misses++;

    const ref = iRef >= 0 ? refHost(unescape(f[iRef])) : '';
    // Only external sources belong in "top referrers": drop self-referrals
    // (in-app navigation) and AWS infra hosts (API Gateway / CloudFront / S3),
    // which are noise here and needlessly expose internal endpoint names.
    if (ref && !isExcludedReferrer(ref, selfDomain)) bump(referrers, ref);

    const ua = iUa >= 0 ? unescape(f[iUa]) : '';
    if (ua) { bump(devices, deviceClass(ua)); bump(browsers, browserClass(ua)); }

    const pop = iPop >= 0 ? String(f[iPop]).slice(0, 3).toUpperCase() : '';
    if (pop) bump(geo, popRegion(pop));
  }

  const top = (m, n = 15) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    rows, bytes, truncated,
    cacheHitRatio: hits + misses ? hits / (hits + misses) : 0,
    status,
    topPages: top(pages, 20),
    topReferrers: top(referrers, 15),
    devices: top(devices, 6),
    browsers: top(browsers, 8),
    edgeGeo: top(geo, 12),
  };
}

// Ignore static build assets so "top pages" reflects real navigations.
function isAsset(uri) {
  return /\/assets\//.test(uri) || /\.(js|css|map|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|json|txt|xml)$/i.test(uri);
}

function refHost(ref) {
  if (!ref || ref === '-') return '';
  try { return new URL(ref).host; } catch { return ''; }
}

// A referrer we don't want in the external-sources list: our own domain (any
// subdomain) or AWS-managed infra hostnames (their raw ids aren't meaningful
// traffic sources and shouldn't be surfaced).
function isExcludedReferrer(host, selfDomain) {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (/(^|\.)amazonaws\.com$|(^|\.)cloudfront\.net$/.test(h)) return true;
  if (selfDomain && (h === selfDomain || h.endsWith(`.${selfDomain}`))) return true;
  return false;
}

function deviceClass(ua) {
  if (/\bbot\b|crawler|spider|slurp|bingpreview|facebookexternalhit|headless/i.test(ua)) return 'Bot / crawler';
  if (/iPad|Tablet/i.test(ua)) return 'Tablet';
  if (/Mobi|Android.*Mobile|iPhone|iPod/i.test(ua)) return 'Mobile';
  return 'Desktop';
}

function browserClass(ua) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/OPR\/|Opera/i.test(ua)) return 'Opera';
  if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && /Version\//i.test(ua)) return 'Safari';
  if (/bot|crawler|spider|curl|python|node|okhttp/i.test(ua)) return 'Bot / script';
  return 'Other';
}

// CloudFront edge POP codes → a human region. This is the serving edge, not the
// client's true location, but it's a solid geographic proxy at city granularity.
const POP_REGION = {
  SIN: 'Singapore', KUL: 'Malaysia', BKK: 'Thailand', CGK: 'Indonesia', MNL: 'Philippines',
  HKG: 'Hong Kong', TPE: 'Taiwan', NRT: 'Japan', KIX: 'Japan', ICN: 'South Korea',
  BOM: 'India', MAA: 'India', DEL: 'India', HYD: 'India', SYD: 'Australia', MEL: 'Australia',
  LHR: 'United Kingdom', DUB: 'Ireland', FRA: 'Germany', CDG: 'France', AMS: 'Netherlands',
  ARN: 'Sweden', MXP: 'Italy', MAD: 'Spain', WAW: 'Poland', DXB: 'UAE', FJR: 'UAE',
  JFK: 'United States', EWR: 'United States', IAD: 'United States', ATL: 'United States',
  ORD: 'United States', DFW: 'United States', LAX: 'United States', SFO: 'United States',
  SEA: 'United States', MIA: 'United States', YUL: 'Canada', YTO: 'Canada', GRU: 'Brazil',
  ZAF: 'South Africa', JNB: 'South Africa',
};
function popRegion(pop) {
  return POP_REGION[pop] || `${pop} (edge)`;
}

const ymd = (d) => d.toISOString().slice(0, 10);
