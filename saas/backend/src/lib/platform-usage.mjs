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

// ── Per-surface tool runs + estimated spend (Digimetrics/Usage EMF) ──────────
// The single cross-product view: how many tool runs, and how much estimated
// vendor $, each front-end drove — the SaaS dashboard ('saas') vs the legacy
// index.html tools ('index'). Both surfaces emit CloudWatch EMF into the same
// custom namespace (SaaS: metering/index.mjs emitUsageMetric; index: staffAuth
// emit_usage_metric), dimensioned on Source, so this is one GetMetricData read.
//
// NOTE: this only reflects runs since the metric shipped — there is no historical
// backfill, because untagged runs were never attributed. It accrues going forward.
const USAGE_NS = 'Digimetrics/Usage';
const USAGE_SOURCES = ['saas', 'index'];
const USAGE_METRICS = [
  { key: 'runs', name: 'Runs' },
  { key: 'estCostUSD', name: 'EstCostUSD' },
  { key: 'creditsUsed', name: 'CreditsUsed' },
];

export async function toolSpendBySource({ from, to }) {
  const { CloudWatchClient, GetMetricDataCommand } = await import('@aws-sdk/client-cloudwatch');
  const cw = new CloudWatchClient({ region: REGION });
  // One period bucket spanning the whole window — we only need window totals here.
  // CloudWatch requires Period to be a multiple of 60, so round the span (in
  // seconds) UP to the next minute; a period ≥ the range yields a single bucket.
  const period = Math.max(60, Math.ceil((to - from) / 60000) * 60);
  // Build one query per (source × metric); Id maps back to which is which.
  const specs = [];
  USAGE_SOURCES.forEach((source, si) =>
    USAGE_METRICS.forEach((m, mi) => specs.push({
      id: `s${si}m${mi}`, source, key: m.key,
      query: {
        Id: `s${si}m${mi}`,
        MetricStat: {
          Metric: { Namespace: USAGE_NS, MetricName: m.name, Dimensions: [{ Name: 'Source', Value: source }] },
          Period: period,
          Stat: 'Sum',
        },
      },
    })));
  const res = await cw.send(new GetMetricDataCommand({
    StartTime: from, EndTime: to, ScanBy: 'TimestampAscending',
    MetricDataQueries: specs.map((s) => s.query),
  }));
  // Sum each series' values (there may be >1 bucket if CW clamps the period).
  const totalById = Object.fromEntries(
    (res.MetricDataResults || []).map((r) => [r.Id, (r.Values || []).reduce((a, b) => a + b, 0)])
  );
  const bySource = {};
  for (const source of USAGE_SOURCES) bySource[source] = { runs: 0, estCostUSD: 0, creditsUsed: 0 };
  for (const s of specs) bySource[s.source][s.key] = totalById[s.id] || 0;
  const combined = USAGE_SOURCES.reduce((a, s) => ({
    runs: a.runs + bySource[s].runs,
    estCostUSD: a.estCostUSD + bySource[s].estCostUSD,
    creditsUsed: a.creditsUsed + bySource[s].creditsUsed,
  }), { runs: 0, estCostUSD: 0, creditsUsed: 0 });
  return {
    currency: 'USD',
    range: { from: from.toISOString(), to: to.toISOString() },
    bySource,
    combined,
  };
}

// ── Per-provider LLM usage (Digimetrics/LLM EMF) ─────────────────────────────
// Claude vs DeepSeek (vs OpenAI) usage across the whole fleet — every Lambda that
// calls a model emits RAW token buckets into this namespace (dims Provider and
// Provider+Model). We discover the exact models present, sum each bucket, and
// derive $ HERE from a single per-model rate table below — so prices live in one
// place, never go stale in 30 Lambda copies, and caching/web-search are priced
// correctly. Forward-only. Still an estimate — the Anthropic/DeepSeek consoles
// (and the optional cost-report reconciliation) are the authoritative bill.
const LLM_NS = 'Digimetrics/LLM';

// $ per MILLION tokens (input / output / cache-read / cache-write) + web-search $
// per 1,000 requests. Longest-specific prefix wins. Anthropic caches: read ~0.1x
// input, write ~1.25x input. OpenAI cached ~0.5x. DeepSeek cache-hit is its own
// rate. web_search billed per request (Anthropic). TUNABLE — update from the
// pricing pages here, and the whole history recomputes on next read.
const LLM_PRICING = [
  ['claude-3-5-haiku', { in: 0.80, out: 4.00, cacheRead: 0.08, cacheWrite: 1.00, ws: 10 }],
  ['claude-3-haiku', { in: 0.25, out: 1.25, cacheRead: 0.03, cacheWrite: 0.30, ws: 10 }],
  ['claude-haiku', { in: 1.00, out: 5.00, cacheRead: 0.10, cacheWrite: 1.25, ws: 10 }],
  ['claude-3-5-sonnet', { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75, ws: 10 }],
  ['claude-sonnet', { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75, ws: 10 }],
  ['claude-opus', { in: 15.00, out: 75.00, cacheRead: 1.50, cacheWrite: 18.75, ws: 10 }],
  ['claude', { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75, ws: 10 }],
  ['deepseek-reasoner', { in: 0.55, out: 2.19, cacheRead: 0.14, cacheWrite: 0, ws: 0 }],
  ['deepseek-chat', { in: 0.27, out: 1.10, cacheRead: 0.07, cacheWrite: 0, ws: 0 }],
  ['deepseek', { in: 0.27, out: 1.10, cacheRead: 0.07, cacheWrite: 0, ws: 0 }],
  ['gpt-4o-mini', { in: 0.15, out: 0.60, cacheRead: 0.075, cacheWrite: 0, ws: 0 }],
  ['gpt-4o', { in: 2.50, out: 10.00, cacheRead: 1.25, cacheWrite: 0, ws: 0 }],
  ['gpt-4.1-mini', { in: 0.40, out: 1.60, cacheRead: 0.10, cacheWrite: 0, ws: 0 }],
  ['gpt-4.1', { in: 2.00, out: 8.00, cacheRead: 0.50, cacheWrite: 0, ws: 0 }],
  ['o3', { in: 2.00, out: 8.00, cacheRead: 0.50, cacheWrite: 0, ws: 0 }],
  ['o1', { in: 15.00, out: 60.00, cacheRead: 7.50, cacheWrite: 0, ws: 0 }],
  ['gpt', { in: 0.50, out: 1.50, cacheRead: 0.25, cacheWrite: 0, ws: 0 }],
];
const LLM_RATE_FALLBACK = { in: 1.0, out: 5.0, cacheRead: 0.1, cacheWrite: 1.25, ws: 10 };

// Exact-id match via longest prefix (avoids gpt/haiku-version collisions).
function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  let best = null;
  for (const [key, r] of LLM_PRICING) {
    if (m.includes(key) && (!best || key.length > best.key.length)) best = { key, r };
  }
  return best ? best.r : LLM_RATE_FALLBACK;
}

function costOf(model, b) {
  const r = ratesFor(model);
  return (b.inputTokens * r.in + b.outputTokens * r.out
        + b.cacheReadTokens * r.cacheRead + b.cacheWriteTokens * r.cacheWrite) / 1e6
        + (b.webSearchRequests / 1000) * r.ws;
}

const LLM_BUCKETS = ['Calls', 'InputTokens', 'OutputTokens', 'CacheReadTokens', 'CacheWriteTokens', 'WebSearchRequests'];
const zeroBuckets = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearchRequests: 0, estCostUSD: 0 });

export async function llmSpendByProvider({ from, to }) {
  const { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } = await import('@aws-sdk/client-cloudwatch');
  const cw = new CloudWatchClient({ region: REGION });
  const period = Math.max(60, Math.ceil((to - from) / 60000) * 60);

  // 1. Discover the exact (Provider, Model) pairs actually emitting.
  const pairMap = new Map();
  let token;
  do {
    const lm = await cw.send(new ListMetricsCommand({ Namespace: LLM_NS, MetricName: 'Calls', NextToken: token }));
    for (const m of lm.Metrics || []) {
      const dims = Object.fromEntries((m.Dimensions || []).map((d) => [d.Name, d.Value]));
      if (dims.Provider && dims.Model) pairMap.set(`${dims.Provider}|${dims.Model}`, { provider: dims.Provider, model: dims.Model });
    }
    token = lm.NextToken;
  } while (token);
  const pairs = [...pairMap.values()];
  const empty = { currency: 'USD', range: { from: from.toISOString(), to: to.toISOString() }, byProvider: {}, byModel: [], bySource: {}, combined: zeroBuckets() };
  if (!pairs.length) return empty;

  // 2. Sum every bucket per pair (chunked — GetMetricData caps at 500 queries).
  const specs = [];
  pairs.forEach((p, pi) => LLM_BUCKETS.forEach((b, bi) => specs.push({ id: `q${pi}_${bi}`, pi, name: b })));
  const totalById = {};
  for (let i = 0; i < specs.length; i += 450) {
    const chunk = specs.slice(i, i + 450);
    const res = await cw.send(new GetMetricDataCommand({
      StartTime: from, EndTime: to, ScanBy: 'TimestampAscending',
      MetricDataQueries: chunk.map((s) => ({
        Id: s.id,
        MetricStat: {
          Metric: { Namespace: LLM_NS, MetricName: s.name, Dimensions: [{ Name: 'Provider', Value: pairs[s.pi].provider }, { Name: 'Model', Value: pairs[s.pi].model }] },
          Period: period, Stat: 'Sum',
        },
      })),
    }));
    for (const r of res.MetricDataResults || []) totalById[r.Id] = (r.Values || []).reduce((a, v) => a + v, 0);
  }

  // 3. Per-model buckets → per-model cost → aggregate to provider + combined.
  const key = (name) => ({ Calls: 'calls', InputTokens: 'inputTokens', OutputTokens: 'outputTokens', CacheReadTokens: 'cacheReadTokens', CacheWriteTokens: 'cacheWriteTokens', WebSearchRequests: 'webSearchRequests' }[name]);
  const byModel = [];
  const byProvider = {};
  const combined = zeroBuckets();
  pairs.forEach((p, pi) => {
    const b = zeroBuckets();
    LLM_BUCKETS.forEach((name, bi) => { b[key(name)] = totalById[`q${pi}_${bi}`] || 0; });
    b.estCostUSD = costOf(p.model, b);
    byModel.push({ provider: p.provider, model: p.model, ...b });
    const pv = (byProvider[p.provider] ||= zeroBuckets());
    for (const k of Object.keys(b)) pv[k] += b[k];
    for (const k of Object.keys(b)) combined[k] += b[k];
  });
  // Only providers with real traffic; models sorted by cost.
  const active = Object.fromEntries(Object.entries(byProvider).filter(([, v]) => v.calls > 0));
  byModel.sort((a, x) => x.estCostUSD - a.estCostUSD);
  // Per-front-end split (saas | index | unknown), priced the same way. Queried on
  // the [Source, Provider] dimension set so each source's models price correctly.
  const bySource = await llmBySource(cw, { from, to, period });
  return { currency: 'USD', range: { from: from.toISOString(), to: to.toISOString() }, byProvider: active, byModel, bySource, combined };
}

// Split LLM usage per originating front-end. Uses the [Source, Provider] set (not
// [Source] alone) so per-provider rates apply; models within a provider are close
// enough in mix that provider-level rates are a fair approximation here.
async function llmBySource(cw, { from, to, period }) {
  const { GetMetricDataCommand, ListMetricsCommand } = await import('@aws-sdk/client-cloudwatch');
  const combos = new Map();
  let token;
  do {
    const lm = await cw.send(new ListMetricsCommand({ Namespace: LLM_NS, MetricName: 'Calls', NextToken: token }));
    for (const m of lm.Metrics || []) {
      const d = Object.fromEntries((m.Dimensions || []).map((x) => [x.Name, x.Value]));
      if (d.Source && d.Provider && !d.Model) combos.set(`${d.Source}|${d.Provider}`, { source: d.Source, provider: d.Provider });
    }
    token = lm.NextToken;
  } while (token);
  if (!combos.size) return {};
  const list = [...combos.values()];
  const specs = [];
  list.forEach((c, ci) => LLM_BUCKETS.forEach((b, bi) => specs.push({ id: `s${ci}_${bi}`, ci, name: b })));
  const totals = {};
  for (let i = 0; i < specs.length; i += 450) {
    const chunk = specs.slice(i, i + 450);
    const res = await cw.send(new GetMetricDataCommand({
      StartTime: from, EndTime: to, ScanBy: 'TimestampAscending',
      MetricDataQueries: chunk.map((s) => ({
        Id: s.id,
        MetricStat: {
          Metric: { Namespace: LLM_NS, MetricName: s.name, Dimensions: [{ Name: 'Source', Value: list[s.ci].source }, { Name: 'Provider', Value: list[s.ci].provider }] },
          Period: period, Stat: 'Sum',
        },
      })),
    }));
    for (const r of res.MetricDataResults || []) totals[r.Id] = (r.Values || []).reduce((a, v) => a + v, 0);
  }
  const keyOf = (name) => ({ Calls: 'calls', InputTokens: 'inputTokens', OutputTokens: 'outputTokens', CacheReadTokens: 'cacheReadTokens', CacheWriteTokens: 'cacheWriteTokens', WebSearchRequests: 'webSearchRequests' }[name]);
  const out = {};
  list.forEach((c, ci) => {
    const b = zeroBuckets();
    LLM_BUCKETS.forEach((name, bi) => { b[keyOf(name)] = totals[`s${ci}_${bi}`] || 0; });
    // Price with the provider's representative model rate.
    b.estCostUSD = costOf(c.provider === 'deepseek' ? 'deepseek-chat' : c.provider === 'openai' ? 'gpt-4o-mini' : 'claude-haiku', b);
    const row = (out[c.source] ||= zeroBuckets());
    for (const k of Object.keys(b)) row[k] += b[k];
  });
  return out;
}

// ── Optional: reconcile against Anthropic's authoritative cost report ─────────
// The metric above is a token-based ESTIMATE; Anthropic's org Cost/Usage Admin
// API is the real bill. Reads an Admin key (sk-ant-admin-…) from Secrets Manager
// (`digimetrics-saas/anthropic-admin-key`) — a DIFFERENT key from the regular
// message key. Returns { configured:false } when absent, so the panel simply
// shows the estimate until the key is added. DeepSeek exposes no comparable cost
// API, so only Anthropic is reconciled.
export async function anthropicCostReport({ from, to }) {
  let key;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({ region: REGION });
    const s = await sm.send(new GetSecretValueCommand({ SecretId: 'digimetrics-saas/anthropic-admin-key' }));
    key = (s.SecretString || '').trim();
  } catch { return { configured: false }; }
  if (!key) return { configured: false };
  // The report is PAGINATED (daily buckets, ~7/page by default). Summing only the
  // first page silently truncates long windows — a 30-day total came back SMALLER
  // than the 7-day one until this followed `next_page` to the end.
  let totalUSD = 0;
  let buckets = 0;
  const byModelCost = {};
  let page = null;
  let guard = 0;
  let truncated = false;
  // Daily cost buckets are day-aligned: floor the start to UTC midnight and push
  // the end to the next midnight, or the API rejects the window (400) — an
  // arbitrary intra-day `starting_at` is not a valid 1d bucket boundary.
  const DAY_MS = 86400000;
  const startUtc = new Date(Math.floor(new Date(from).getTime() / DAY_MS) * DAY_MS);
  const endUtc = new Date(Math.ceil(new Date(to).getTime() / DAY_MS) * DAY_MS);
  do {
    const params = new URLSearchParams({
      starting_at: startUtc.toISOString(),
      ending_at: endUtc.toISOString(),
      bucket_width: '1d',
      limit: '31',
    });
    // The cost report only supports these two groupings (not model).
    params.append('group_by[]', 'description');
    params.append('group_by[]', 'workspace_id');
    if (page) params.set('page', page);
    const res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${params}`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      // Surface the API's own reason — a bare status code made a malformed-window
      // 400 indistinguishable from an auth/permission problem.
      const detail = await res.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(detail)?.error?.message || ''; } catch { msg = detail.slice(0, 200); }
      return { configured: true, error: `Anthropic cost API ${res.status}${msg ? `: ${msg}` : ''}` };
    }
    const data = await res.json().catch(() => ({}));
    for (const bucket of data.data || []) {
      buckets += 1;
      for (const item of bucket.results || []) {
        // `amount` is in CENTS despite the row's `currency: "USD"` — proven by
        // cross-checking against the usage report: Haiku output billed 4895.77
        // for 9,791,542 tokens, and 9.79M x $5/Mtok = $48.96 = 4895.77/100.
        // Taking it at face value overstated spend by 100x ($32k/mo vs ~$308/mo).
        const amt = Number(item.amount || item.cost || 0) / 100;
        totalUSD += amt;
        // Grouped by model, so we can show WHERE the bill actually goes — the
        // ungrouped total alone can't tell a runaway workload from broad usage.
        const label = item.description || item.model || 'unattributed';
        byModelCost[label] = (byModelCost[label] || 0) + amt;
      }
    }
    page = data.has_more ? data.next_page : null;
    if (page && ++guard >= 24) { truncated = true; break; } // safety stop
  } while (page);
  const byModel = Object.entries(byModelCost).map(([model, costUSD]) => ({ model, costUSD })).sort((a, b) => b.costUSD - a.costUSD);
  return { configured: true, provider: 'claude', totalCostUSD: totalUSD, currency: 'USD', buckets, byModel, ...(truncated ? { truncated: true } : {}) };
}

// ── Per-tool cost, per platform (CloudWatch Logs Insights) ───────────────────
// Deliberately NOT a metric dimension. Tool x Source would add ~80 dimension
// combinations across ~9 metric names — several hundred custom metrics at
// ~$0.30/metric/month, i.e. more per month than the LLM spend it measures. The
// `tool` value is already a PROPERTY on every Digimetrics/LLM line, so Logs
// Insights answers the same question for ~$0.005/GB scanned, on demand.
//
// Heavier than a GetMetricData read (seconds, not milliseconds), so it's its own
// route the UI only calls when the operator opens the panel — same treatment as
// the Amplify access-log export.
const LLM_LOG_GROUPS = [
  'aiOptimiser', 'geoDataForSeo', 'webpageFomating', 'whatsappBot', 'socialMediaAudit',
  'campaignSummaryProcessor', 'content-generator', 'similarKeywords',
  'onPageRecommendations', 'gptTopicsPerUrl', 'pageDesignAnalysis', 'socialMediaStrategy',
  'contentPillar', 'reasonForKwSelection', 'onPageContentRecommendations', 'mediaPlanGenerator',
  'personaGenerator', 'techAuditSummary', 'AiMentions', 'checkKeywordRelevance',
  'geoOnPageAnalysis', 'checkContent', 'proposeElementorContent', 'generateSemGoogle',
  'performanceMarketing', 'monday', 'claude', 'overdueResponses',
].map((f) => `/aws/lambda/${f}`);

const TOOL_COST_QUERY = `
fields coalesce(tool, fn) as toolKey, Source, Model, Calls, InputTokens, OutputTokens, CacheReadTokens, CacheWriteTokens, WebSearchRequests
| filter ispresent(Calls) and ispresent(Model)
| stats sum(Calls) as calls, sum(InputTokens) as inTok, sum(OutputTokens) as outTok, sum(CacheReadTokens) as crTok, sum(CacheWriteTokens) as cwTok, sum(WebSearchRequests) as ws by Source, toolKey, Model
| sort outTok desc
| limit 500`;

export async function toolCostBreakdown({ from, to, chatStreamLogGroup }) {
  const { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const cwl = new CloudWatchLogsClient({ region: REGION });
  const wanted = [...LLM_LOG_GROUPS, ...(chatStreamLogGroup ? [chatStreamLogGroup] : [])];
  // StartQuery fails outright if ANY named group is missing, and a Lambda that
  // has never been invoked has no log group yet (geoDataForSeo was exactly this).
  // So intersect with what actually exists rather than failing the whole report.
  const { DescribeLogGroupsCommand } = await import('@aws-sdk/client-cloudwatch-logs');
  const existing = new Set();
  let lgToken;
  do {
    const r = await cwl.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/aws/lambda/', nextToken: lgToken, limit: 50 }));
    for (const g of r.logGroups || []) existing.add(g.logGroupName);
    lgToken = r.nextToken;
  } while (lgToken);
  const groups = wanted.filter((g) => existing.has(g));
  const skipped = wanted.filter((g) => !existing.has(g)).map((g) => g.replace('/aws/lambda/', ''));
  if (!groups.length) return { error: 'No model-call log groups exist yet for this account.' };
  let queryId;
  try {
    ({ queryId } = await cwl.send(new StartQueryCommand({
      logGroupNames: groups,
      startTime: Math.floor(from.getTime() / 1000),
      endTime: Math.floor(to.getTime() / 1000),
      queryString: TOOL_COST_QUERY,
      limit: 500,
    })));
  } catch (e) {
    return { error: `Logs Insights query failed: ${e.message}` };
  }
  // Poll within the API Gateway 30s budget; return partial results rather than
  // failing outright if the scan is still running.
  const deadline = Date.now() + 20000;
  let status = 'Running';
  let results = [];
  while (Date.now() < deadline) {
    const r = await cwl.send(new GetQueryResultsCommand({ queryId }));
    status = r.status;
    results = r.results || [];
    if (status === 'Complete' || status === 'Failed' || status === 'Cancelled') break;
    await new Promise((res) => setTimeout(res, 1200));
  }
  if (status === 'Failed' || status === 'Cancelled') return { error: `Logs Insights query ${status}` };

  // Price each (source, tool, model) row, then fold models into one row per
  // tool+platform so the panel shows "what this tool costs on this surface".
  const byKey = new Map();
  for (const row of results) {
    const f = Object.fromEntries(row.map((c) => [c.field, c.value]));
    const num = (k) => Number(f[k] || 0);
    const b = {
      calls: num('calls'), inputTokens: num('inTok'), outputTokens: num('outTok'),
      cacheReadTokens: num('crTok'), cacheWriteTokens: num('cwTok'), webSearchRequests: num('ws'),
    };
    const source = f.Source || 'unknown';
    const tool = f.toolKey || 'unattributed';
    const k = `${source}|${tool}`;
    const cur = byKey.get(k) || { source, tool, ...zeroBuckets() };
    for (const kk of Object.keys(b)) cur[kk] += b[kk];
    cur.estCostUSD += costOf(f.Model, b);
    byKey.set(k, cur);
  }
  const rows = [...byKey.values()].sort((a, b) => b.estCostUSD - a.estCostUSD);
  const totals = rows.reduce((a, r) => ({
    calls: a.calls + r.calls, inputTokens: a.inputTokens + r.inputTokens,
    outputTokens: a.outputTokens + r.outputTokens, estCostUSD: a.estCostUSD + r.estCostUSD,
  }), { calls: 0, inputTokens: 0, outputTokens: 0, estCostUSD: 0 });
  return {
    currency: 'USD',
    range: { from: from.toISOString(), to: to.toISOString() },
    complete: status === 'Complete',
    rows,
    totals,
    // Named so a missing tool isn't mistaken for zero spend.
    ...(skipped.length ? { skippedLogGroups: skipped } : {}),
  };
}

/** Read a Secrets Manager string, or null when absent/unreadable. */
async function readSecret(id) {
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const sm = new SecretsManagerClient({ region: REGION });
    const s = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    return (s.SecretString || '').trim() || null;
  } catch { return null; }
}

// ── Anthropic usage report — AUTHORITATIVE token counts, grouped by model ─────
// The cost report can only group by description/workspace_id, so it can't tell
// you which model burned the tokens. The usage report CAN group by model, which
// is how we attribute output-token volume precisely. Same paging + day-alignment
// rules as the cost report. Token buckets come back split by cache type.
export async function anthropicUsageReport({ from, to }) {
  const key = await readSecret('digimetrics-saas/anthropic-admin-key');
  if (!key) return { configured: false };
  const DAY_MS = 86400000;
  const startUtc = new Date(Math.floor(new Date(from).getTime() / DAY_MS) * DAY_MS);
  const endUtc = new Date(Math.ceil(new Date(to).getTime() / DAY_MS) * DAY_MS);
  const byModel = {};
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let page = null;
  let guard = 0;
  let truncated = false;
  do {
    const params = new URLSearchParams({
      starting_at: startUtc.toISOString(),
      ending_at: endUtc.toISOString(),
      bucket_width: '1d',
      limit: '31',
    });
    params.append('group_by[]', 'model');
    if (page) params.set('page', page);
    const res = await fetch(`https://api.anthropic.com/v1/organizations/usage_report/messages?${params}`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(detail)?.error?.message || ''; } catch { msg = detail.slice(0, 200); }
      return { configured: true, error: `Anthropic usage API ${res.status}${msg ? `: ${msg}` : ''}` };
    }
    const data = await res.json().catch(() => ({}));
    for (const bucket of data.data || []) {
      for (const r of bucket.results || []) {
        const model = r.model || 'unattributed';
        const cw = r.cache_creation
          ? Object.values(r.cache_creation).reduce((a, v) => a + (Number(v) || 0), 0)
          : Number(r.cache_creation_input_tokens || 0);
        const row = (byModel[model] ||= { model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
        const inp = Number(r.uncached_input_tokens ?? r.input_tokens ?? 0);
        const out = Number(r.output_tokens || 0);
        const cr = Number(r.cache_read_input_tokens || 0);
        row.inputTokens += inp; row.outputTokens += out; row.cacheReadTokens += cr; row.cacheWriteTokens += cw;
        totals.inputTokens += inp; totals.outputTokens += out; totals.cacheReadTokens += cr; totals.cacheWriteTokens += cw;
      }
    }
    page = data.has_more ? data.next_page : null;
    if (page && ++guard >= 24) { truncated = true; break; }
  } while (page);
  // Price the authoritative token counts with the same central table, so this
  // line is directly comparable to (and should beat) our own metric's estimate.
  const rows = Object.values(byModel).map((r) => ({ ...r, estCostUSD: costOf(r.model, { ...r, webSearchRequests: 0 }) }))
    .sort((a, b) => b.estCostUSD - a.estCostUSD);
  return {
    configured: true,
    byModel: rows,
    totals: { ...totals, estCostUSD: rows.reduce((a, r) => a + r.estCostUSD, 0) },
    ...(truncated ? { truncated: true } : {}),
  };
}

// ── DeepSeek balance — actual remaining credit (not spend) ────────────────────
// DeepSeek exposes a balance endpoint, so unlike Anthropic we CAN show real
// remaining credit. Returns { configured:false } when no key is stored.
export async function deepseekBalance() {
  const key = await readSecret('digimetrics-saas/deepseek-key');
  if (!key) return { configured: false };
  const res = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { configured: true, error: `DeepSeek balance API ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}` };
  }
  const data = await res.json().catch(() => ({}));
  return {
    configured: true,
    isAvailable: !!data.is_available,
    balances: (data.balance_infos || []).map((b) => ({
      currency: b.currency,
      total: Number(b.total_balance || 0),
      granted: Number(b.granted_balance || 0),
      toppedUp: Number(b.topped_up_balance || 0),
    })),
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
