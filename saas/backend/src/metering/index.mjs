// ─────────────────────────────────────────────────────────────────────────
// METERING GATEWAY — the single choke point in front of every tool.
//
//   POST /run/{toolId}   body: { ...whatever the upstream tool expects }
//
// Flow:
//   1. authorizer already verified the JWT → claims on the event
//   2. resolve tool from the shared catalog
//   3. tier gate:   tool.minTier met?            no → 403 (or a teaser run)
//   4. credit gate: balance ≥ estimated cost?    no → 402 + upsell
//   5. proxy to the existing upstream Lambda (unchanged code)
//   6. reconcile credits from ACTUAL usage (AI returns token counts)
//   7. return result + { creditsUsed, creditsRemaining }
// ─────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { getUser, putUser, spendCredits, totalCredits, saveRun, getCache, putCache } from '../lib/dynamo.mjs';
import { UPSTREAMS } from './upstreams.mjs';
import { ADAPTERS, parseStrategyJson } from './adapters.mjs';
import { fetchIntegration } from '../lib/google.mjs';
import {
  TOOLS,
  CREDIT_COSTS,
  PLANS,
  tierMeets,
} from '../../../shared/catalog.mjs';
import {
  ok,
  badRequest,
  unauthorized,
  paymentRequired,
  tierLocked,
  serverError,
  parseBody,
  claims,
  preflight,
} from '../lib/http.mjs';
import { verify } from '../lib/jwt.mjs';

// How many free "teaser" runs a locked tool allows per user per month.
const TEASER_RUNS_PER_MONTH = 1;

export const handler = async (event) => {
  const t0 = Date.now();
  // CORS preflight (Function URL path has no API-Gateway CORS layer).
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return preflight();

  // API-Gateway path supplies claims via the JWT authorizer. The Function URL
  // path (used for slow, >30s tools) is unauthenticated at the edge, so verify
  // the Bearer token here.
  let c = claims(event);
  if (!c?.userId) {
    const hdr = event.headers?.authorization || event.headers?.Authorization || '';
    try {
      const t = verify(hdr.replace(/^Bearer\s+/i, ''));
      if (t?.sub && t.typ !== 'refresh') c = { userId: t.sub, email: t.email, tier: t.tier };
    } catch { /* fall through to 401 */ }
  }
  if (!c?.userId) return unauthorized();

  const toolId =
    event.pathParameters?.toolId ||
    (event.rawPath || '').split('/').pop();
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return badRequest(`Unknown tool: ${toolId}`);

  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');

  const body = parseBody(event);
  // Expose the authenticated email to adapters that attribute upstream jobs
  // (e.g. serpCompetitors keys results by user). Gateway-trusted, not user input.
  body._email = c.email || c.userId;
  // Connected-integration state for the Integrations tools (gsc/ga4/google-ads).
  body._integrations = user.integrations || {};
  const unitCost = CREDIT_COSTS[tool.cost] ?? 0;

  // ── Fan-out tools (e.g. rank checker over many keywords) ──────────────────
  // The named field holds a list; we call the upstream once per item and charge
  // per item. `fullCost` is the per-item cost × item count.
  const fanItems = tool.fanout ? splitItems(body[tool.fanout]).slice(0, 50) : null;
  if (fanItems && fanItems.length === 0) return badRequest('Add at least one keyword.');
  const fullCost = fanItems ? unitCost * fanItems.length : unitCost;

  // ── Tier gate ─────────────────────────────────────────────────────────────
  let teaser = false;
  if (!tierMeets(user.tier, tool.minTier)) {
    // A locked tool may still allow ONE real-but-partial run to drive upgrades.
    if (tool.teaser && (await teaserBudget(user, tool.id)) > 0) {
      teaser = true;
    } else {
      return tierLocked(tool.minTier);
    }
  }

  // ── Credit gate (skip charge for teaser + zero-cost integration pulls) ─────
  const willCharge = !teaser && fullCost > 0;
  if (willCharge && totalCredits(user) < fullCost) {
    return paymentRequired({
      creditsRemaining: totalCredits(user),
      creditsNeeded: fullCost,
      tier: user.tier,
      topUpAvailable: true, // anyone can buy a one-time top-up
    });
  }

  // ── Proxy to the existing upstream Lambda (fanned out if applicable) ───────
  let result;
  try {
    if (fanItems) {
      const settled = await Promise.all(
        fanItems.map(async (item) => {
          const r = await callUpstream(tool, { ...body, [tool.fanout]: item });
          return { keyword: item, result: r?.text ?? r?.position ?? JSON.stringify(r) };
        })
      );
      result = { rows: settled };
    } else {
      result = await callUpstream(tool, body);
    }
  } catch (err) {
    console.error('upstream_error', tool.id, err);
    return serverError('The tool backend failed. No credits were charged.');
  }

  // ── Partial-results shaping for teaser / capped free tier ─────────────────
  let payload = result;
  if (teaser) {
    payload = applyTeaser(tool, result);
    await markTeaserUsed(user, tool.id);
  } else if (tool.freeCap && user.tier === 'free') {
    payload = capRows(tool, result, tool.freeCap);
  }

  // ── Reconcile credits from actual usage ───────────────────────────────────
  let creditsUsed = 0;
  let creditsRemaining = totalCredits(user);
  if (willCharge) {
    creditsUsed = reconcileCost(tool, result, fullCost);
    const spent = await spendCredits({
      userId: user.userId,
      cost: creditsUsed,
      tool: tool.id,
      meta: usageMeta(result),
    });
    creditsRemaining = spent.total;
  }

  // Persist the run so the user can re-open it from their history (best-effort).
  let runId = null;
  try {
    const saved = await saveRun({
      userId: user.userId, tool: tool.id, toolName: tool.name,
      inputs: publicInputs(body), result: payload, creditsUsed,
      projectId: body.projectId || null,
    });
    runId = saved.runId;
  } catch (e) { console.error('save_run_failed', tool.id, e.message); }

  // Structured metric line (CloudWatch Logs Insights / metric filters).
  console.log(JSON.stringify({ metric: 'tool_run', tool: tool.id, ms: Date.now() - t0, creditsUsed, cached: !!result?.cached, teaser }));

  return ok({
    tool: tool.id,
    teaser,
    result: payload,
    creditsUsed,
    creditsRemaining,
    runId,
  });
};

/** Strip gateway-injected (underscore-prefixed) keys before saving inputs. */
function publicInputs(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) if (!k.startsWith('_') && k !== 'projectId') out[k] = v;
  return out;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Split a comma/newline-separated field into a deduped list of items. */
function splitItems(v) {
  const seen = new Set();
  return String(v || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s) && seen.add(s));
}

/** POST to an upstream, unwrapping the { statusCode, body } proxy envelope. */
async function postUpstream(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Shared secret so the (eventually private) upstream trusts the gateway.
      'x-gateway-secret': process.env.GATEWAY_SECRET || '',
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = text; // plain text / HTML
  }
  if (raw && typeof raw === 'object' && raw.statusCode !== undefined && raw.body !== undefined) {
    raw = typeof raw.body === 'string' ? safeParse(raw.body) : raw.body;
  }
  return raw;
}

// Deterministic-ish data tools whose results we cache (TTL seconds). Live/AI
// and user-data tools are never cached.
const CACHE_TTL = { 'keyword-analysis': 86400, backlinks: 86400, competitors: 86400, 'time-to-rank': 86400, onpage: 86400 };
function cacheKey(tool, body) {
  const pub = {};
  for (const [k, v] of Object.entries(body)) if (!k.startsWith('_') && k !== 'projectId' && k !== 'url') pub[k] = v;
  return createHash('sha256').update(`${tool.id}|${JSON.stringify(pub)}`).digest('hex');
}

async function callUpstream(tool, body) {
  const ttl = CACHE_TTL[tool.id];
  if (!ttl) return callUpstreamRaw(tool, body);
  const key = cacheKey(tool, body);
  const hit = await getCache(key).catch(() => null);
  if (hit) return { ...hit, cached: true };
  const res = await callUpstreamRaw(tool, body);
  putCache(key, res, ttl).catch(() => {}); // best-effort
  return res;
}

async function callUpstreamRaw(tool, body) {
  // Integrations pull the user's own connected Google data (no upstream proxy).
  if (tool.integration) return integrationsRun(tool, body);
  // Schema Generator: deterministic JSON-LD builder (no upstream).
  if (tool.id === 'schema') return schemaRun(body);
  // Keyword Analysis: metrics / similar / ranking / from-webpage modes.
  if (tool.id === 'keyword-analysis') return keywordAnalysisRun(body);
  // Pure-client tools have no upstream.
  if (!tool.upstream) return { clientOnly: true };
  // The Strategy Engine is a two-step composite (generate → recommendations).
  if (tool.id === 'strategy-engine') return strategyEngineRun(body);
  // DataForSEO crawl is async: initiate → poll get_results until done.
  if (tool.id === 'technical-seo') return crawlRun(body, tool);
  // GEO+SEO Forensic Audit: fan out ~30 probes, score them, build a remediation plan.
  if (tool.id === 'forensic-audit') return forensicAuditRun(body);
  // AI-visibility is multi-step: derive prompts → verify_mentions → poll snapshot.
  if (tool.id === 'ai-discovery' || tool.id === 'ai-mentions') return aiVisibilityRun(body);
  // Backlinks Explorer fans out across summary + referring domains + anchors.
  if (tool.id === 'backlinks') return backlinksRun(body);
  // AI Content Optimiser: optional draft → run the multi-agent QA suite.
  if (tool.id === 'content-writer') return contentOptimiserRun(body);
  // Content Checker: parse brand guides + references → checkContent.
  if (tool.id === 'content-check') return contentCheckRun(body);
  // Time to Rank: keyword metrics + SERP + LLM time-to-rank per keyword.
  if (tool.id === 'time-to-rank') return timeToRankRun(body);
  // Anchor Text Cleaner: fetch page HTML → classify internal anchors.
  if (tool.id === 'anchor-cleaner') return anchorCleanerRun(body);
  // Performance Marketing Audit: paid-media opportunity analysis.
  if (tool.id === 'perf-marketing') return perfMarketingRun(body);
  // llms.txt Generator: crawl the site → validate (llms.txt/robots/AI-bots/key
  // pages) → generate a spec-compliant llms.txt + llms-full.txt + recommendations.
  if (tool.id === 'llms-txt') return llmsTxtRun(body);

  const url = UPSTREAMS[tool.upstream];
  if (!url) throw new Error(`No upstream URL for ${tool.upstream}`);

  const adapter = ADAPTERS[tool.id];
  const raw = await postUpstream(url, adapter ? adapter.request(body) : body);
  // Shape to the generic { rows | text | html } the UI renders: prefer a
  // tool-specific response adapter, else a best-effort normaliser.
  const shaped = adapter?.response ? adapter.response(raw) : normalize(raw);
  return { ...shaped, usage: raw?.usage };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

/** Best-effort: turn an arbitrary upstream payload into { rows | text | html }. */
function normalize(raw) {
  if (raw == null) return { text: '(no response)' };
  const isHtml = (s) => /<\/?[a-z][\s\S]*>/i.test(s);
  if (typeof raw === 'string') return isHtml(raw) ? { html: raw } : { text: raw };
  if (raw.rows || raw.text || raw.html) return raw;
  if (Array.isArray(raw)) return { rows: raw };
  const t = raw.result ?? raw.content ?? raw.message ?? raw.summary ?? raw.answer;
  if (typeof t === 'string') return isHtml(t) ? { html: t } : { text: t };
  if (Array.isArray(raw.items)) return { rows: raw.items };
  // Surface upstream error objects clearly instead of as silent empties.
  if (raw.errorMessage || raw.error) return { text: `⚠ Upstream error: ${raw.errorMessage || raw.error}` };
  return { text: JSON.stringify(raw, null, 2) };
}

// ── Strategy Engine: generate strategies → actionable recommendations ─────────
async function strategyEngineRun(body) {
  const url = UPSTREAMS.strategyEngine;
  const a = ADAPTERS['strategy-engine'];

  const gen = await postUpstream(url, a.request(body));
  const strategies = strategiesFrom(gen);
  if (!strategies.length) return a.response(gen); // fall back to raw shape

  const recommended = strategies.find((s) => s.recommended) || strategies[0];
  let recs = { strengths: [], recommendations: [] };
  try {
    const recRaw = await postUpstream(url, {
      action: 'strategy_recommendations',
      strategy: recommended,
      auditContext: { domainMetrics: { domain: (body.domain || body.url || '').trim() } },
    });
    recs = recsFrom(recRaw);
  } catch (e) {
    console.error('strategy_recommendations_failed', e.message); // best-effort
  }

  // Enrich every strategy's target keywords with real Vol/KD (mangoolsKeywords)
  // and the domain's current Rank (serpCompetitors) — mirrors the metric table
  // index.html paints into its strategy grid. Best-effort: a failure here just
  // leaves the metric cells as "—" rather than failing the whole run.
  let metricMap = {}, rankMap = {};
  try {
    const location = body.location || 'Singapore';
    const language = body.language || 'English';
    const domain = (body.domain || body.url || '').trim();
    const keywords = collectStrategyKeywords(strategies).slice(0, 60);
    if (keywords.length) {
      [metricMap, rankMap] = await Promise.all([
        fetchKeywordMetrics(keywords, location, language),
        domain
          ? fetchKeywordRanks(keywords.slice(0, 40), domain, location, language, body._email || 'saas')
          : Promise.resolve({}),
      ]);
    }
  } catch (e) {
    console.error('strategy_enrichment_failed', e.message); // best-effort
  }

  return { html: renderStrategy(strategies, recommended, recs, metricMap, rankMap) };
}

// ── Keyword enrichment for the strategy grid ──────────────────────────────────
const cleanKw = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const strategyBaseDomain = (u) => String(u ?? '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
function chunkArr(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function unwrapBody(raw) {
  return raw && raw.body !== undefined
    ? (typeof raw.body === 'string' ? safeParse(raw.body) : raw.body)
    : raw;
}
// Gather unique target keywords across all strategies, from both the flat
// `target_keywords` list and any `keyword_data.semantic_clusters[].keywords`.
function collectStrategyKeywords(strategies) {
  const set = new Set();
  for (const s of strategies || []) {
    const kd = s.keyword_data || s.keyword_analysis;
    if (kd && Array.isArray(kd.semantic_clusters)) {
      for (const c of kd.semantic_clusters)
        if (Array.isArray(c.keywords))
          for (const k of c.keywords) if (k && String(k).trim()) set.add(String(k).trim());
    }
    const tk = s.target_keywords;
    if (Array.isArray(tk)) {
      for (const k of tk) if (k && String(k).trim()) set.add(String(k).trim());
    } else if (typeof tk === 'string') {
      for (const k of tk.split(/,\s*|\n/)) if (k && k.trim()) set.add(k.trim());
    }
  }
  return Array.from(set);
}
// Vol/KD via mangoolsKeywords (chunks of 20, in parallel). Returns { kw: {vol,diff} }.
async function fetchKeywordMetrics(keywords, location, language) {
  const map = {};
  await Promise.all(chunkArr(keywords, 20).map(async (c) => {
    try {
      const data = unwrapBody(await postUpstream(UPSTREAMS.mangoolsKeywords, { keywords: c, location, language }));
      if (data && typeof data === 'object') {
        for (const kw of Object.keys(data)) {
          const e = data[kw];
          if (e && typeof e === 'object')
            map[cleanKw(kw)] = { vol: e.search_volume ?? e.volume ?? 0, diff: e.difficulty ?? e.competition ?? 0 };
        }
      }
    } catch (err) { console.error('strategy_metrics_chunk_failed', err.message); }
  }));
  return map;
}
// Current rank via serpCompetitors (chunks of 5). Keeps only rows whose domain
// matches the target. Returns { kw: position }.
async function fetchKeywordRanks(keywords, domain, location, language, email) {
  const map = {};
  const targetBase = strategyBaseDomain(domain);
  if (!targetBase) return map;
  await Promise.all(chunkArr(keywords, 5).map(async (c, i) => {
    try {
      const data = unwrapBody(await postUpstream(UPSTREAMS.serpCompetitors, {
        id: `strat_rank_${i}_${email}`, user: email, keywords: c, location, language,
      }));
      if (!data || typeof data !== 'object') return;
      for (const dom of Object.keys(data)) {
        const cb = strategyBaseDomain(dom);
        if (cb && (cb.includes(targetBase) || targetBase.includes(cb))) {
          const ranks = data[dom];
          if (ranks && typeof ranks === 'object')
            for (const kw of Object.keys(ranks)) map[cleanKw(kw)] = ranks[kw];
        }
      }
    } catch (err) { console.error('strategy_rank_chunk_failed', err.message); }
  }));
  return map;
}

function strategiesFrom(raw) {
  if (Array.isArray(raw?.strategies)) return raw.strategies;
  if (typeof raw?.result === 'string') {
    const p = parseStrategyJson(raw.result);
    if (Array.isArray(p?.strategies)) return p.strategies;
  }
  return [];
}
function recsFrom(raw) {
  let d = raw;
  if (typeof raw?.result === 'string') { const p = parseStrategyJson(raw.result); if (p) d = p; }
  return { strengths: d?.strengths || [], recommendations: d?.recommendations || [] };
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function renderStrategy(strategies, recommended, recs, metricMap = {}, rankMap = {}) {
  const volFmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v || '0'));

  // Per-strategy keyword table with enriched Vol / KD / Rank columns.
  const kwTable = (keywords) => {
    const kws = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/,\s*|\n/))
      .map((k) => String(k).trim()).filter(Boolean);
    if (!kws.length) return '<p style="color:#94a3b8;font-size:12px;margin:6px 0">No target keywords.</p>';
    const rows = kws.map((kw) => {
      const c = cleanKw(kw);
      const m = metricMap[c];
      const r = rankMap[c];
      const vol = m ? volFmt(m.vol) : '—';
      const diff = m ? (m.diff || 0) : '—';
      const dCol = m ? (m.diff > 50 ? '#ef4444' : m.diff > 30 ? '#f59e0b' : '#10b981') : '#94a3b8';
      const hasRank = r !== undefined && r !== null;
      const rTxt = hasRank ? (r <= 100 ? r : '100+') : '—';
      const rCol = hasRank ? (r <= 10 ? '#10b981' : r <= 30 ? '#f59e0b' : '#6366f1') : '#94a3b8';
      return `<tr style="border-top:1px solid #f1f5f9">
        <td style="padding:7px 10px;color:#334155;font-weight:600">${esc(kw)}</td>
        <td style="padding:7px 6px;text-align:center;color:${m ? '#10b981' : '#94a3b8'};font-weight:700">${vol}</td>
        <td style="padding:7px 6px;text-align:center;color:${dCol};font-weight:700">${diff}</td>
        <td style="padding:7px 6px;text-align:center;color:${rCol};font-weight:700">${rTxt}</td>
      </tr>`;
    }).join('');
    return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#004a99;color:#fff;text-align:left">
        <th style="padding:8px 10px;font-weight:700">Target keyword</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:54px">Vol</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:48px">KD</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:54px">Rank</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
  };

  const field = (label, val) => val
    ? `<div style="margin-top:8px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b">${label}</div><div style="font-size:13px;color:#334155;line-height:1.5">${esc(val)}</div></div>`
    : '';
  const stratCards = strategies.map((s) => {
    const isRec = s === recommended;
    const ttr = s.time_to_rank
      ? (String(s.time_to_rank).toLowerCase().includes('month') ? s.time_to_rank : `${s.time_to_rank} months`)
      : '';
    return `<div style="border:1px solid ${isRec ? '#bfdbfe' : '#e2e8f0'};border-radius:12px;padding:14px 16px;margin:10px 0;background:${isRec ? '#f0f9ff' : '#fff'}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <strong style="font-size:15px;color:#0f172a">${isRec ? '★ ' : ''}${esc(s.name)}</strong>
        ${isRec ? '<span style="background:#3b82f6;color:#fff;border-radius:999px;padding:2px 10px;font-size:10px;font-weight:700">RECOMMENDED</span>' : ''}
      </div>
      ${field('Core keyword theme', s.focus_area || s.focus)}
      ${field('Content approach', s.content_approach)}
      ${field('Expected impact', s.expected_impact)}
      ${field('Est. time to rank', ttr)}
      <div style="margin-top:10px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b">Target keywords</div>${kwTable(s.target_keywords)}</div>
    </div>`;
  }).join('');

  const strengths = (recs.strengths || []).map((x) => `
    <li style="margin:6px 0"><strong>${esc(x.title)}</strong> — <span style="color:#475569">${esc(x.detail || x.description)}</span></li>`).join('');

  // Recommendations grouped into the same four categories as index.html, with a
  // priority stats banner and impact/effort/rationale per card.
  const CATS = [
    { key: 'Content', label: 'Content Strategy', color: '#6366f1', bg: '#eef2ff', emoji: '📝' },
    { key: 'Technical SEO', label: 'Technical SEO', color: '#0ea5e9', bg: '#e0f2fe', emoji: '🔧' },
    { key: 'Performance', label: 'Performance', color: '#f59e0b', bg: '#fef3c7', emoji: '⚡' },
    { key: 'Domain & Trust', label: 'Domain & Trust', color: '#10b981', bg: '#d1fae5', emoji: '🛡️' },
  ];
  const recList = (recs.recommendations || []).filter(Boolean);
  const grouped = Object.fromEntries(CATS.map((c) => [c.key, []]));
  for (const r of recList) {
    const raw = String(r.category || 'Content');
    const cat = CATS.find((c) => raw.toLowerCase().includes(c.key.toLowerCase())) || CATS[0];
    grouped[cat.key].push(r);
  }
  const prioRank = { high: 1, medium: 2, low: 3 };
  const PRC = { high: { badge: '#ef4444' }, medium: { badge: '#f59e0b' }, low: { badge: '#10b981' } };
  const IMP = { high: '#ef4444', medium: '#f59e0b', low: '#10b981' };
  const EFF = { high: '#f43f5e', medium: '#8b5cf6', low: '#3b82f6' };
  const count = (p) => recList.filter((r) => String(r.priority || '').toLowerCase() === p).length;
  const activeCats = CATS.filter((c) => grouped[c.key].length).length;

  const statBox = (n, label, c1, c2, border, txt) =>
    `<div style="flex:1;min-width:110px;background:linear-gradient(135deg,${c1},${c2});border:1px solid ${border};border-radius:12px;padding:12px 16px"><div style="font-size:1.4rem;font-weight:900;color:${txt};line-height:1">${n}</div><div style="font-size:.65rem;font-weight:700;color:${txt};text-transform:uppercase;letter-spacing:.05em">${label}</div></div>`;
  const statsBanner = recList.length ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 6px">
    ${statBox(count('high'), 'High priority', '#fef2f2', '#fee2e2', '#fecaca', '#991b1b')}
    ${statBox(count('medium'), 'Medium priority', '#fffbeb', '#fef3c7', '#fde68a', '#92400e')}
    ${statBox(count('low'), 'Low priority', '#f0fdf4', '#dcfce7', '#bbf7d0', '#065f46')}
    ${statBox(activeCats, 'Focus areas', '#f8fafc', '#f1f5f9', '#e2e8f0', '#1e293b')}
  </div>` : '';

  const chip = (label, val, col) =>
    `<div style="display:flex;align-items:center;gap:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:4px 9px"><span style="width:8px;height:8px;border-radius:50%;background:${col}"></span><span style="font-size:.65rem;font-weight:700;color:#475569;text-transform:uppercase">${label}</span><span style="font-size:.7rem;font-weight:800;color:${col}">${esc(val)}</span></div>`;
  const recCard = (r, idx) => {
    const pc = PRC[String(r.priority || 'Medium').toLowerCase()] || PRC.medium;
    const impKey = String(r.impact || 'Medium').toLowerCase();
    const effKey = String(r.effort || 'Medium').toLowerCase();
    const task = r.task || r.title || `Recommendation ${idx + 1}`;
    const rationale = r.rationale || 'Part of the strategic roadmap';
    return `<div style="border:1px solid #e2e8f0;border-left:5px solid ${pc.badge};border-radius:12px;padding:12px 14px;margin:8px 0;background:#fff">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap">
        <strong style="font-size:14px;color:#0f172a">${esc(task)}</strong>
        <div style="display:flex;gap:6px;flex-shrink:0">
          ${r.priority ? `<span style="background:${pc.badge};color:#fff;border-radius:999px;padding:2px 9px;font-size:10px;font-weight:800;text-transform:uppercase">${esc(r.priority)}</span>` : ''}
          <span style="background:#f1f5f9;color:#475569;border-radius:999px;padding:2px 9px;font-size:10px;font-weight:700">#${idx + 1}</span>
        </div>
      </div>
      ${r.description ? `<p style="color:#334155;margin:8px 0;font-size:13px;line-height:1.55">${esc(r.description)}</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">
        ${chip('Impact', r.impact || 'Medium', IMP[impKey] || '#f59e0b')}
        ${chip('Effort', r.effort || 'Medium', EFF[effKey] || '#8b5cf6')}
        <div style="flex:1;min-width:180px;display:flex;gap:6px;background:#fafafa;border:1px solid #e2e8f0;border-radius:8px;padding:4px 9px"><span style="font-size:.72rem;color:#64748b;line-height:1.45">💡 <strong style="color:#475569">Rationale:</strong> ${esc(rationale)}</span></div>
      </div>
      ${Array.isArray(r.action_items) && r.action_items.length ? `<ul style="margin:8px 0 0;padding-left:18px;font-size:13px;color:#475569">${r.action_items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    </div>`;
  };

  let recSections = '';
  let runningIdx = 0;
  for (const c of CATS) {
    const items = grouped[c.key].slice().sort(
      (a, b) => (prioRank[String(a.priority || '').toLowerCase()] || 9) - (prioRank[String(b.priority || '').toLowerCase()] || 9)
    );
    if (!items.length) continue;
    recSections += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 6px;padding:10px 14px;background:${c.bg};border-left:4px solid ${c.color};border-radius:10px">
      <span style="font-size:1rem">${c.emoji}</span>
      <span style="font-weight:800;color:#1e293b;font-size:14px">${c.label}</span>
      <span style="margin-left:auto;font-weight:800;color:${c.color}">${items.length}</span>
    </div>`;
    recSections += items.map((r) => recCard(r, runningIdx++)).join('');
  }

  return `
    <h3 style="margin:0 0 6px;font-weight:700;font-size:16px">Keyword strategy options</h3>
    <p style="margin:0;color:#64748b;font-size:12px">Vol = monthly search volume · KD = keyword difficulty · Rank = your current position</p>
    ${stratCards}
    ${strengths ? `<h3 style="margin:18px 0 6px;font-weight:700;font-size:16px">✅ What you're doing well</h3><ul style="margin:0;padding-left:18px;font-size:13px">${strengths}</ul>` : ''}
    ${recList.length ? `<h3 style="margin:18px 0 6px;font-weight:700;font-size:16px">🎯 Prioritised action plan <span style="font-weight:400;color:#64748b">— ${recList.length} actions for “${esc(recommended.name)}”</span></h3>${statsBanner}${recSections}` : ''}`;
}

// ── Technical SEO / Forensic Audit: DataForSEO async crawl ────────────────────
// initiate(task) → poll get_results every 5s until crawl_progress != in_progress
// or we approach the Lambda timeout. Aggregates per-page rows + a summary.
async function crawlRun(body, tool) {
  const url = UPSTREAMS.dataforseoCrawler;
  const target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A website URL is required.');

  const deep = tool.id === 'forensic-audit';
  const maxPages = clampInt(body.maxPages, deep ? 30 : 10, 1, deep ? 100 : 50);
  const maxDepth = clampInt(body.maxDepth, deep ? 3 : 4, 1, 10);

  const init = await postUpstream(url, { action: 'initiate', url: target, max_pages: maxPages, max_depth: maxDepth });
  const taskId = init?.tasks?.[0]?.id;
  if (!taskId) throw new Error('The crawler did not accept the task. Check the URL and try again.');

  const deadline = Date.now() + 150_000; // stay within the 180s Lambda timeout
  const seen = new Map(); // url → page item (deduped)
  let progress = 'in_progress';
  while (Date.now() < deadline) {
    await sleep(5000);
    let task;
    try {
      const res = await postUpstream(url, { action: 'get_results', task_id: taskId });
      task = res?.tasks?.[0];
    } catch { continue; } // transient poll failure — keep trying until deadline
    const result = task?.result?.[0];
    for (const item of result?.items || []) {
      if (item?.url && !seen.has(item.url)) seen.set(item.url, item);
    }
    if (result?.crawl_progress && result.crawl_progress !== 'in_progress') { progress = result.crawl_progress; break; }
  }

  const pages = [...seen.values()];
  if (!pages.length) {
    return { text: 'The crawl started but returned no pages within the time limit. Try a smaller page count or check the URL.' };
  }

  const rows = pages.map((p) => ({
    url: p.url,
    status: p.status_code ?? '—',
    title: p.meta?.title || '—',
    h1: p.meta?.htags?.h1?.[0] || '—',
    score: p.onpage_score != null ? Math.round(p.onpage_score) : '—',
    issues: pageIssues(p),
  }));
  const scored = rows.map((r) => (typeof r.score === 'number' ? r.score : null)).filter((n) => n != null);
  const summary = {
    pagesCrawled: pages.length,
    avgOnPageScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    pagesWithIssues: rows.filter((r) => r.issues > 0).length,
    status: progress === 'in_progress' ? 'partial (still crawling)' : 'complete',
  };
  return { rows, summary };
}

/** Count obvious on-page problems on a crawled page (safe, polarity-known checks). */
function pageIssues(p) {
  let n = 0;
  if (!p.meta?.title) n++;
  if (!p.meta?.description) n++;
  if (!(p.meta?.htags?.h1?.length)) n++;
  if ((p.status_code || 0) >= 400) n++;
  if (p.checks && p.checks.is_https === false) n++;
  return n;
}

// ── GEO+SEO Forensic Audit ────────────────────────────────────────────────────
// Server-side port of index.html's autoFillForensicAudit(): fan out the same
// ~30 probes in parallel, normalise them into the `d` shape, then reuse the
// agency's exact recommendation / severity / health-score logic. Returns a
// themed `sections` report plus a compact `summary` (used by the teaser path).
async function forensicAuditRun(body) {
  let target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A website URL is required.');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { throw new Error('Invalid URL format.'); }

  const rootDomain = u.origin;                       // https://www.example.com
  const domain = u.hostname;                         // www.example.com
  const baseDomain = domain.replace(/^www\./, '');   // example.com
  const httpUrl = 'http://' + domain;
  const notFoundPath = `${rootDomain}/fa-audit-404-check-${Date.now()}`;

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const tryJson = (url, payload, ms) => withTimeout(postUpstream(url, payload), ms).catch(() => null);
  // getHtml returns { body: "<html>" }; postUpstream may pass it through or
  // unwrap an envelope to the raw string — handle both, never throw.
  const getHtmlBody = (path, ms) =>
    withTimeout(postUpstream(UPSTREAMS.getHtml, { url: path }), ms)
      .then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : '')))
      .catch(() => '');

  // Kick everything off in parallel. GTmetrix + the internal-duplication crawl
  // are the long poles; the rest resolve in well under 30s.
  const homeHtmlP = getHtmlBody(rootDomain, 30000);
  const copyscapeP = homeHtmlP.then((html) => {
    const text = faStripHtml(html).slice(0, 5000);
    if (text.length < 100) return null;
    return tryJson(UPSTREAMS.copyscape, { text }, 30000);
  });

  const [
    siteRes, mozRes, psmRes, psdRes, sslRes, gtRes, ahrefsRes,
    homeHtml, robotsBody, llmsBody, llmsFullBody, notFoundBody, httpBody,
    copyscapeRaw, sitelinerItems,
  ] = await Promise.all([
    tryJson(UPSTREAMS.forensicSiteData, { url: baseDomain }, 25000),
    tryJson(UPSTREAMS.mozAuthority, { domain: baseDomain }, 25000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain }, 60000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain, strategy: 'desktop' }, 60000),
    tryJson(UPSTREAMS.sslCheck, { url: domain }, 20000),
    tryJson(UPSTREAMS.gtmetrix, { url: rootDomain }, 75000),
    tryJson(UPSTREAMS.ahrefsProxy, { endpoint: 'overview', params: { target: baseDomain } }, 25000),
    homeHtmlP,
    getHtmlBody(rootDomain + '/robots.txt', 20000),
    getHtmlBody(rootDomain + '/llms.txt', 15000),
    getHtmlBody(rootDomain + '/llms-full.txt', 15000),
    getHtmlBody(notFoundPath, 15000),
    getHtmlBody(httpUrl, 15000),
    copyscapeP,
    faSitelinerCrawl(rootDomain, 110000),
  ]);

  // ── Normalise everything into the `d` shape generateForensicRecommendations expects ──
  const d = {
    url: target, client: body.client || '', date: '',
    ssl: null, da: null, psd: null, psm: null, gtmetrix: '', copyscape: null,
    ga4: '', gsc: '', metatitle: '', metadesc: '', robots: '', custom404: '',
    cdn: '', uptime: '', siteliner: null, h1: null, h2: null, sitemap: '',
    https: '', structdata: '', semantic: '', llmblock: '', llmstxt: '', llmsfull: '',
    cms: '', backlinks: null, refdomains: null, orgkw: null, spam: null,
    // Screaming-Frog CSV fields aren't available without a manual upload — leave
    // null so no false findings are raised.
    duptitles: null, dupdescs: null, unoptmeta: null, canonical: null,
    hreflang: null, multislash: null, sf404: null, sderrors: null,
    rankmath: '', wordfence: '', notes: '',
  };

  // 1. Site data (title / desc / h1-h2 / schema / spam / backlinks)
  if (siteRes) {
    if (siteRes.title) d.metatitle = String(siteRes.title);
    if (siteRes.description) d.metadesc = String(siteRes.description);
    if (siteRes.backlinks_spam_score != null) d.spam = Number(siteRes.backlinks_spam_score);
    const toCount = (v) => (Array.isArray(v) ? v.length : (v !== '' && v != null ? Number(v) : null));
    const h1c = toCount(siteRes.h1), h2c = toCount(siteRes.h2);
    if (h1c != null && !Number.isNaN(h1c)) d.h1 = h1c;
    if (h2c != null && !Number.isNaN(h2c)) d.h2 = h2c;
    if (siteRes.schema && siteRes.schema !== 'None') d.structdata = 'Yes';
    if (siteRes.backlinks != null) d.backlinks = Number(siteRes.backlinks);
    if (siteRes.referring_domains != null) d.refdomains = Number(siteRes.referring_domains);
  }

  // Backlinks / ref domains / organic keywords — prefer Ahrefs, fall back to site data.
  const ah = ahrefsRes?.domain || ahrefsRes || {};
  if (ah.backlinks != null) d.backlinks = Number(ah.backlinks);
  if (ah.referring_domains != null) d.refdomains = Number(ah.referring_domains);
  if (ah.org_keywords != null) d.orgkw = Number(ah.org_keywords);
  const backlinksSource = (ah.backlinks != null || ah.referring_domains != null) ? 'Ahrefs' : (siteRes?.backlinks != null ? 'DataForSEO' : null);

  // 2. Moz Domain Authority
  if (mozRes?.domain_authority != null) d.da = Number(mozRes.domain_authority);

  // 3. PageSpeed (mobile) + sitemap presence
  const parsePS = (v) => { if (v == null) return null; const n = parseInt(String(v), 10); return Number.isNaN(n) ? null : n; };
  if (psmRes) {
    const psm = parsePS(psmRes.pagespeed);
    if (psm != null) d.psm = psm;
    d.sitemap = psmRes.sitemap && psmRes.sitemap !== 'Not Found' ? 'Present' : 'Missing';
  }
  // 4. PageSpeed (desktop)
  if (psdRes) { const psd = parsePS(psdRes.pagespeed); if (psd != null) d.psd = psd; }

  // 5. SSL
  if (sslRes) d.ssl = (sslRes.message && String(sslRes.message).toLowerCase().includes('valid')) ? 'pass' : 'fail';

  // 6. GTmetrix grade
  const grade = gtRes?.data?.attributes?.gtmetrix_grade;
  if (grade) d.gtmetrix = grade;

  // 7. Homepage HTML — GA4 / CDN / semantic / CMS / plugins / structured data / H1-H2 fallback
  faParseHomeHtml(homeHtml, d);

  // 8. robots.txt + LLM-bot block check
  faParseRobots(robotsBody, d);

  // 9. llms.txt / llms-full.txt
  d.llmstxt = faValidTxt(llmsBody) ? 'Present' : 'Missing';
  d.llmsfull = faValidTxt(llmsFullBody) ? 'Present' : 'Missing';

  // 10. Custom 404
  {
    const b = (notFoundBody || '').trim();
    d.custom404 = (b.length > 400 && !b.toLowerCase().includes('cannot get') && b.includes('<')) ? 'Configured' : 'Not Configured';
  }
  // 11. HTTP → HTTPS redirect
  {
    const b = (httpBody || '').trim();
    const works = b.length > 500 && b.toLowerCase().includes('https');
    d.https = works ? 'Yes' : (d.ssl === 'pass' ? 'Yes' : 'No');
  }

  // 12. Copyscape (external duplicate %) — postUpstream already unwrapped the envelope.
  if (copyscapeRaw && copyscapeRaw.originality_score !== undefined) {
    d.copyscape = Math.max(0, Math.round(100 - Number(copyscapeRaw.originality_score)));
  }

  // 13. Internal duplication (Siteliner-equivalent) from the crawl
  if (Array.isArray(sitelinerItems) && sitelinerItems.length) {
    const dup = sitelinerItems.filter((i) => i.duplicate_content === true).length;
    d.siteliner = Math.round((dup / sitelinerItems.length) * 100);
  }

  // ── Recommendations + severity + health score (agency logic, ported verbatim) ──
  const recs = generateForensicRecommendations(d);
  recs.forEach((r) => { r.severity = faSeverityFor(r); });
  recs.sort((a, b) => FA_SEV_ORDER[a.severity] - FA_SEV_ORDER[b.severity]);
  const score = faComputeHealthScore(d, recs);
  const sevCounts = { critical: 0, warning: 0, opportunity: 0 };
  recs.forEach((r) => { sevCounts[r.severity]++; });

  const summary = {
    healthScore: score,
    issues: recs.length,
    critical: sevCounts.critical,
    warning: sevCounts.warning,
    opportunity: sevCounts.opportunity,
    domainAuthority: d.da,
    pageSpeedMobile: d.psm,
    pageSpeedDesktop: d.psd,
    ssl: d.ssl,
    structuredData: d.structdata || null,
    llmsTxt: d.llmstxt || null,
    backlinks: d.backlinks,
    spamScore: d.spam,
    pagesCrawled: Array.isArray(sitelinerItems) ? sitelinerItems.length : 0,
  };

  return { sections: faSections(d, recs, score, sevCounts, backlinksSource), summary };
}

/** DataForSEO async crawl used only for the internal-duplication ratio. */
async function faSitelinerCrawl(url, maxWaitMs) {
  try {
    const init = await postUpstream(UPSTREAMS.dataforseoCrawler, { action: 'initiate', url, max_pages: 20, max_depth: 2 });
    const taskId = init?.tasks?.[0]?.id;
    if (!taskId) return null;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(5000);
      let result;
      try {
        const res = await postUpstream(UPSTREAMS.dataforseoCrawler, { action: 'get_results', task_id: taskId, limit: 200 });
        result = res?.tasks?.[0]?.result?.[0];
      } catch { continue; }
      if (!result) continue;
      if (result.crawl_progress && result.crawl_progress !== 'in_progress') return result.items || [];
    }
  } catch { /* fall through */ }
  return null;
}

/** Strip tags/scripts/styles to approximate visible page text (for Copyscape). */
function faStripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if a fetched .txt body is a real text file (not HTML / an error page). */
function faValidTxt(body) {
  const t = (body || '').trim();
  return t.length > 20 && !t.toLowerCase().startsWith('error') &&
    !t.includes('<?xml') && !t.includes('<!DOCTYPE') && !t.includes('<html');
}

/** Homepage HTML heuristics — mirrors the DOM checks in autoFillForensicAudit. */
function faParseHomeHtml(html, d) {
  if (!html || html.length < 200) return;
  const lc = html.toLowerCase();
  const count = (re) => (html.match(re) || []).length;

  if (d.h1 == null) d.h1 = count(/<h1[\s>]/gi);
  if (d.h2 == null) d.h2 = count(/<h2[\s>]/gi);

  const semFound = ['<header', '<footer', '<main', '<nav'].filter((t) => lc.includes(t)).length;
  d.semantic = semFound >= 2 ? 'Yes' : 'No';

  d.ga4 = (lc.includes('gtag') || lc.includes('googletagmanager')) ? 'Connected' : 'Not Connected';

  if (lc.includes('rank-math') || lc.includes('rankmath')) d.rankmath = 'Installed';
  if (lc.includes('wordfence') || lc.includes('wfvt_') || lc.includes('wf-fingerprint')) d.wordfence = 'Installed';

  const cdnPatterns = ['cloudflare', 'cloudfront.net', 'fastly.net', 'akamai', 'stackpath',
    'cdn-cgi', '__cf_bm', 'bunnycdn', 'keycdn', 'maxcdn', 'edgecastcdn', 'cdn.jsdelivr', 'cdnjs.cloudflare'];
  d.cdn = cdnPatterns.some((p) => lc.includes(p)) ? 'Yes' : 'No';

  if (lc.includes('application/ld+json')) d.structdata = 'Yes';
  else if (!d.structdata) d.structdata = 'No';

  if (!d.metatitle) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (m) d.metatitle = m[1].trim(); }
  if (!d.metadesc) { const m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i); if (m) d.metadesc = m[1].trim(); }

  let cms = '';
  if (lc.includes('/wp-content/') || lc.includes('/wp-includes/') || lc.includes('wp-json')) cms = 'WordPress';
  else if (lc.includes('wixstatic.com') || lc.includes('wix.com')) cms = 'Wix';
  else if (lc.includes('cdn.shopify.com') || lc.includes('shopify')) cms = 'Shopify';
  else if (lc.includes('squarespace.com') || lc.includes('squarespace-cdn.com')) cms = 'Squarespace';
  else if (lc.includes('webflow.com') || lc.includes('.webflow.io')) cms = 'Webflow';
  else if (lc.includes('hs-scripts.com') || lc.includes('js.hs-analytics.net')) cms = 'HubSpot CMS';
  else if (lc.includes('drupal')) cms = 'Drupal';
  else if (lc.includes('/components/com_') || lc.includes('joomla')) cms = 'Joomla';
  else if (lc.includes('bigcommerce.com')) cms = 'BigCommerce';
  else if (lc.includes('magento')) cms = 'Magento';
  else if (lc.includes('ghost.io') || lc.includes('ghost.org')) cms = 'Ghost';
  if (cms) d.cms = cms;
}

/** robots.txt presence + whether it blocks AI crawlers. */
function faParseRobots(robotsBody, d) {
  const robots = (robotsBody || '').trim();
  const lc = robots.toLowerCase();
  const hasUserAgent = lc.includes('user-agent:');
  const isHtml = lc.includes('<!doctype') || lc.includes('<html') || lc.includes('<?xml');
  const isErr = lc.startsWith('error') || lc.includes('not found') || lc.includes('internal server error');
  const ok = robots.length > 10 && (hasUserAgent || (!isHtml && !isErr));
  d.robots = ok ? 'Pass' : 'Missing';
  if (!ok) { d.llmblock = 'No'; return; }
  const bots = ['gptbot', 'claudebot', 'oai-searchbot', 'perplexitybot', 'anthropic-ai'];
  let agent = '', blocked = false;
  for (const line of robots.split('\n')) {
    const l = line.trim().toLowerCase();
    if (l.startsWith('user-agent:')) agent = l.replace('user-agent:', '').trim();
    else if (l.startsWith('disallow:') && bots.some((b) => agent.includes(b)) && l.replace('disallow:', '').trim() === '/') { blocked = true; break; }
  }
  d.llmblock = blocked ? 'Yes' : 'No';
}

// ── llms.txt Generator: crawl → validate → generate ──────────────────────────
// Mirrors index.html's structured builder but driven from a live crawl: fetches
// the homepage + robots.txt + any existing llms.txt, validates the site for AI
// readiness, then builds a spec-compliant llms.txt + llms-full.txt from real
// internal links (organised + described by the AI), plus a recommendations list.
async function llmsTxtRun(body) {
  let target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A website URL is required.');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { throw new Error('Invalid URL format.'); }
  const rootDomain = u.origin;
  const host = u.hostname.replace(/^www\./, '');

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const getBody = (path, ms) => withTimeout(postUpstream(UPSTREAMS.getHtml, { url: path }), ms)
    .then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : '')))
    .catch(() => '');

  const [homeHtml, robotsBody, llmsBody, llmsFullBody] = await Promise.all([
    getBody(rootDomain, 25000),
    getBody(rootDomain + '/robots.txt', 12000),
    getBody(rootDomain + '/llms.txt', 10000),
    getBody(rootDomain + '/llms-full.txt', 10000),
  ]);
  if (!homeHtml || homeHtml.length < 200) {
    throw new Error(`Could not fetch ${rootDomain}. Check the URL is public and reachable.`);
  }

  const title = (homeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || host).replace(/\s+/g, ' ').trim();
  const metaDesc = (homeHtml.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
  const links = extractSiteLinks(homeHtml, host, rootDomain);

  // ── Validation checks ──
  const d = {};
  faParseRobots(robotsBody, d);                 // sets d.robots, d.llmblock
  const hasLlms = faValidTxt(llmsBody);
  const hasLlmsFull = faValidTxt(llmsFullBody);
  const has = (re) => links.some((l) => re.test(l.url.toLowerCase()) || re.test(l.label.toLowerCase()));
  const keyPages = {
    About: has(/about/), Contact: has(/contact/), Services: has(/service|solution/),
    Products: has(/product|shop|store|pricing/), Blog: has(/blog|resource|article|guide|news|insight/),
  };

  // ── AI organises the real links into sections + writes the summary/prompts ──
  const plan = await llmsAiPlan(title, rootDomain, metaDesc, links);
  const summary = (body.summary || plan?.summary || metaDesc || '').trim();
  const userPrompts = String(body.geoPrompts || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const geoPrompts = userPrompts.length ? userPrompts.slice(0, 6) : (Array.isArray(plan?.geo_prompts) ? plan.geo_prompts.filter(Boolean).slice(0, 5) : []);
  let sections = Array.isArray(plan?.sections)
    ? plan.sections.filter((s) => s && s.title && Array.isArray(s.links) && s.links.length).map((s) => ({
        title: String(s.title), links: s.links.filter((l) => l && l.label && l.url).slice(0, 8),
      })).filter((s) => s.links.length)
    : [];
  if (!sections.length) sections = links.length ? [{ title: 'Pages', links: links.slice(0, 6).map((l) => ({ label: l.label, url: l.url, desc: '' })) }] : [];

  const llmsTxt = buildLlmsTxt({ title, summary, geoPrompts, sections, highlights: (body.highlights || '').trim() });
  const llmsFull = buildLlmsFull({ title, summary, geoPrompts, sections });

  // ── Recommendations from the checks ──
  const recs = [];
  recs.push(hasLlms ? 'You already have an llms.txt — replace it with the improved version below.' : 'No llms.txt found — publish the generated file at /llms.txt.');
  if (!hasLlmsFull) recs.push('No llms-full.txt — publish the verbose version below at /llms-full.txt for deeper AI context.');
  if (d.llmblock === 'Yes') recs.push('⚠ Your robots.txt blocks AI crawlers (GPTBot, ClaudeBot, etc.) — unblock them or AI tools cannot read your llms.txt.');
  if (d.robots === 'Missing') recs.push('No robots.txt found — add one that allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended).');
  if (!metaDesc) recs.push('Your homepage has no meta description — add one; it seeds how AI summarises you.');
  if (!keyPages.About) recs.push('No About page linked from the homepage — add one so AI can describe your company.');
  if (!keyPages.Contact) recs.push('No Contact page linked from the homepage — add one to surface your contact details.');

  return {
    sections: [
      { type: 'heading', text: `llms.txt for ${title}` },
      { type: 'stats', title: 'Site checks', items: [
        { label: 'llms.txt', value: hasLlms ? 'Present' : 'Missing', tone: hasLlms ? 'green' : 'amber' },
        { label: 'llms-full.txt', value: hasLlmsFull ? 'Present' : 'Missing', tone: hasLlmsFull ? 'green' : 'amber' },
        { label: 'robots.txt', value: d.robots || '—', tone: d.robots === 'Pass' ? 'green' : 'amber' },
        { label: 'AI crawlers', value: d.llmblock === 'Yes' ? 'Blocked' : 'Allowed', tone: d.llmblock === 'Yes' ? 'red' : 'green' },
        { label: 'Pages found', value: String(links.length) },
      ] },
      { type: 'list', title: 'Key pages on the homepage', items: Object.entries(keyPages).map(([k, v]) => `${v ? '✓' : '✗'} ${k}${v ? '' : ' — not linked'}`) },
      { type: 'list', title: 'Recommendations', items: recs },
      { type: 'code', title: 'llms.txt', filename: 'llms.txt', content: llmsTxt },
      { type: 'code', title: 'llms-full.txt (verbose)', filename: 'llms-full.txt', content: llmsFull },
    ],
    summary: { llmsTxtPresent: hasLlms, aiBlocked: d.llmblock === 'Yes', pagesFound: links.length },
  };
}

/** Internal homepage links → [{ label, url }] (absolute, deduped, junk filtered). */
function extractSiteLinks(html, host, rootDomain) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 60) {
    const href = m[1].trim();
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, rootDomain); } catch { continue; }
    if (abs.hostname.replace(/^www\./, '') !== host) continue; // internal only
    abs.hash = '';
    const url = abs.href.replace(/\/$/, '');
    if (url === rootDomain.replace(/\/$/, '')) continue;        // skip the homepage itself
    if (seen.has(url)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;
    seen.add(url);
    out.push({ label: text, url });
  }
  return out;
}

/** Ask the AI to organise crawled links into sections + write summary/prompts. */
async function llmsAiPlan(title, rootDomain, metaDesc, links) {
  const list = links.slice(0, 40).map((l) => `${l.label} | ${l.url}`).join('\n');
  const userPrompt =
    `Output ONLY strict JSON (no markdown fences, no prose). You are building an llms.txt for the website "${title}" (${rootDomain}).` +
    (metaDesc ? ` Homepage meta description: "${metaDesc}".` : '') +
    `\nReal internal pages found by crawling the homepage (label | url):\n${list || '(none found)'}\n` +
    `\nReturn JSON of shape: {"summary": string, "geo_prompts": string[], "sections": [{"title": string, "links": [{"label": string, "url": string, "desc": string}]}]}.` +
    ` Rules: "summary" = one sentence on what the site offers (for the > blockquote). "geo_prompts" = exactly 3 natural questions a user would ask an AI assistant that this site should be cited for. Group the most important pages into 2-4 sections named like Services, Products, Company, Resources. Use ONLY urls from the list above. Write a one-sentence "desc" per link. 4-8 links total.`;
  try {
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    let s = aiText(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(s);
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

/** Build a concise, spec-compliant llms.txt (mirrors index.html's generateLlmsTxt). */
function buildLlmsTxt({ title, summary, geoPrompts, sections, highlights }) {
  let c = `# ${title}\n\n`;
  if (summary) c += `> ${summary}\n\n`;
  if (geoPrompts?.length) { c += `Target Prompts for GEO:\n\n`; geoPrompts.forEach((p, i) => { c += `${i + 1}. ${p}\n`; }); c += `\n`; }
  if (highlights) c += `${highlights}\n\n`;
  for (const s of sections || []) {
    if (!s.title || !(s.links || []).length) continue;
    c += `## ${s.title}\n\n`;
    for (const l of s.links) if (l.label && l.url) c += `- [${l.label}](${l.url})${l.desc ? ': ' + l.desc : ''}\n`;
    c += `\n`;
  }
  c += `\n# Generated by Digimetrics | Specification: https://llmstxt.org\n`;
  return c.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** Build a verbose llms-full.txt (mirrors index.html's generateLlmsFullTxt). */
function buildLlmsFull({ title, summary, geoPrompts, sections }) {
  let c = `# ${title}\n\n`;
  if (summary) c += `> ${summary}\n\n`;
  if (geoPrompts?.length) { c += `Target Prompts for GEO:\n\n`; geoPrompts.forEach((p, i) => { c += `${i + 1}. ${p}\n`; }); c += `\n`; }
  for (const s of sections || []) {
    if (!s.title || !(s.links || []).length) continue;
    c += `---\n\n## ${s.title}\n\n`;
    for (const l of s.links) {
      if (!l.label || !l.url) continue;
      c += `### ${l.label}\n\n`;
      if (l.desc) c += `> ${l.desc}\n\n`;
      c += `**Source**: ${l.url}\n\n---\n\n`;
    }
  }
  c += `\n# Generated by Digimetrics (llms-full.txt) | Specification: https://llmstxt.org\n`;
  return c.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ── Forensic recommendation engine (ported verbatim from index.html) ──────────
function generateForensicRecommendations(d) {
  const recs = [];
  const add = (error, action, checkKey = null) => recs.push({ error, action, checkKey });

  if (d.ssl === 'fail') add('Invalid SSL Certificate', 'Client to renew SSL certificate', 'ssl');
  if (d.psd !== null && d.psd < 90) add(`Poor Desktop Page Speed (score: ${d.psd})`, 'Developer to minify bloated CSS or JS components and serve images in .webp format to reduce page load time. Additional plugins may be required for cache purposes', 'psd');
  if (d.psm !== null && d.psm < 90) add(`Poor Mobile Page Speed (score: ${d.psm})`, 'Developer to minify bloated CSS or JS components and serve images in .webp format to reduce page load time. Additional plugins may be required for cache purposes', 'psm');
  if (d.gtmetrix && d.gtmetrix !== 'A') add(`GTmetrix Grade ${d.gtmetrix} (Not Grade A)`, 'Developer to improve the core web vitals', 'gtmetrix');
  if (d.copyscape !== null && d.copyscape > 15) add(`High Duplicate Content (${d.copyscape}%)`, 'MediaOne can assist with the write up to rephrase the duplicate content', 'copyscape');
  if (d.robots === 'Missing') add('robots.txt Does Not Exist', 'Developer to create robots.txt and add sitemap URL into robots.txt', 'robots');
  if (d.robots === 'Fail') add('robots.txt Missing Sitemap URL', 'Developer to add sitemap URL in robots.txt', 'robots');
  if (d.custom404 === 'Not Configured') add('No Custom 404 Error Page', "Developer to create a '404 Error' page with a home page button", 'custom404');
  if (d.cdn === 'No') add('No CDN Implemented', 'Developer to set up CDN. We recommend Cloudflare, but developer can choose any other CDN that serves similar function', 'html');
  if (d.uptime === 'Not Monitoring') add('Uptimerobot Property Not Created', 'Developer to create Uptimerobot property to monitor site uptime');
  if (d.siteliner !== null && d.siteliner > 15) add(`High Internal Duplicate Content (${d.siteliner}%)`, 'MediaOne can assist with the write up to rephrase the duplicate content');
  if (d.sitemap === 'Missing') add('XML Sitemap Missing', 'Developer will create a sitemap and submit it to Google Search Console', 'sitemap');
  if (d.sitemap === 'Not Submitted in GSC') add('Sitemap Not Submitted in GSC', 'Developer to ensure the sitemap is submitted in Google Search Console', 'sitemap');
  if (d.sitemap === 'Has / Error in GSC') add('Sitemap Has "/" Error in GSC', 'Developer to ensure the sitemap is submitted in GSC and delete "/" error in GSC (if any)', 'sitemap');
  if (d.sitemap === 'Not Formatted Properly') add('Sitemap Not Formatted Properly', 'Developer to ensure that the sitemap is formatted correctly', 'sitemap');
  if (d.https === 'No') add('HTTP to HTTPS Redirect Not Configured', 'Developer to 301 redirect http:// URLs to https://', 'https');
  if (!d.metatitle) add('Missing Meta Title', 'MediaOne will address the meta titles for targeted pages in the On Page Recommendation document. Client may provide the meta titles for other pages and MediaOne can assist with implementing them', 'sitedata');
  if (!d.metadesc) add('Missing Meta Description', 'MediaOne will address the meta descriptions for targeted pages in the On Page Recommendation document. Client may provide the meta descriptions for other pages and MediaOne can assist with implementing them', 'sitedata');
  if (d.duptitles !== null && d.duptitles > 0) add(`${d.duptitles} Duplicate Title Tags Found`, 'MediaOne will address the meta titles for targeted pages in the On Page Recommendation document. Client may provide the meta titles for other pages and MediaOne can assist with implementing them');
  if (d.dupdescs !== null && d.dupdescs > 0) add(`${d.dupdescs} Duplicate Meta Descriptions Found`, 'MediaOne will address the meta descriptions for targeted pages in the On Page Recommendation document. Client may provide the meta descriptions for other pages and MediaOne can assist with implementing them');
  if (d.unoptmeta !== null && d.unoptmeta > 0) add(`${d.unoptmeta} Unoptimised Meta Tags Found`, 'MediaOne will address the meta titles and descriptions for targeted pages in the On Page Recommendation document');
  if (d.canonical !== null && d.canonical > 0) add(`${d.canonical} Canonical Tag Issues Found`, 'Developer to canonicalise targeted pages');
  if (d.hreflang !== null && d.hreflang > 0) add(`${d.hreflang} Hreflang Tag Issues Found`, 'Developer to implement en-SG hreflang tagging: (1) Open header.php in the active theme, (2) Add <link rel="alternate" href="[websiteURL]" hreflang="en-sg" /> before the closing </head> tag, (3) Save the file');
  if (d.multislash !== null && d.multislash > 0) add(`${d.multislash} Multiple Slash URL Issues Found`, 'Developer to redirect multiple slash URLs to single slash (e.g. https://www.example.com// → https://www.example.com/). MediaOne will also remove the multiple slash URLs from sitemap.xml');
  if (d.sf404 !== null && d.sf404 > 0) add(`${d.sf404} Broken Links (404) Detected`, 'Developer to remove these pages from sitemap.xml and fix or redirect all broken links to relevant live pages');
  if (d.ga4 === 'Not Connected') add('No Data Flowing into GA4', 'Developer will assist with the GA4 tagging and ensure data is flowing into GA4', 'html');
  if (d.ga4 === 'No Access') add('No Access to Google Analytics 4', 'Client to provide access to GA4');
  if (d.gsc === 'No Access') add('No Access to Google Search Console', 'Client to give GSC access first. After which, MediaOne will ensure the sitemap is submitted in GSC and delete "/" error in GSC (if any)');
  if (d.structdata === 'No') add('No Structured Data Markup', 'MediaOne will be recommending relevant structured data on specific pages to enhance how your pages show up for GEO during On-page recommendations', 'html');
  if (d.sderrors !== null && d.sderrors > 0) add(`${d.sderrors} Structured Data Errors Detected`, 'MediaOne will be reviewing structured data with errors on specific pages to enhance how your pages show up for GEO during On-page recommendations');
  if (d.llmblock === 'Yes') add('LLM Bots Blocked in robots.txt', 'MediaOne to check & fix the robots.txt to ensure that the website does not block LLM bots', 'robots');
  if (d.llmstxt === 'Missing') add('llms.txt File Missing', 'MediaOne to check, create and install llms.txt', 'llmstxt');
  if (d.llmsfull === 'Missing') add('llms-full.txt File Missing', 'MediaOne to check, create and install llms-full.txt', 'llmsfull');
  if (d.semantic === 'Partial') add('Website is Partly Semantic HTML', 'MediaOne to check and provide the semantic HTML structure for developers to deploy', 'html');
  if (d.semantic === 'No') add('Website is Not Semantic HTML Optimised', 'MediaOne to check and provide the full semantic HTML structure for developers to deploy', 'html');
  if (d.spam !== null && d.spam > 30) add(`High Spam Score (${d.spam}%)`, 'Audit backlink profile and disavow toxic links via Google Search Console', 'backlinks');
  const rmMissing = d.rankmath === 'Not Installed';
  const wfMissing = d.wordfence === 'Not Installed';
  if (rmMissing || wfMissing) {
    const missing = [rmMissing && 'Rank Math', wfMissing && 'Wordfence'].filter(Boolean).join(' and ');
    add(`${missing} Plugin(s) Not Installed`, 'MediaOne to install Rank Math (but turn off schema markup generation) and Wordfence plugins to enhance SEO management and strengthen website security monitoring', 'html');
  }
  if (d.h1 !== null && d.h1 === 0) add('Missing H1 Tag', "Add a single H1 heading that clearly describes the page's primary topic", 'html');
  if (d.h1 !== null && d.h1 > 1) add(`Multiple H1 Tags (${d.h1} found)`, 'Reduce H1 tags to one per page to maintain clear heading hierarchy', 'html');
  return recs;
}

const FA_SEV_ORDER = { critical: 0, warning: 1, opportunity: 2 };
const FA_SEV_LABEL = { critical: 'Critical', warning: 'Warning', opportunity: 'Opportunity' };

function faSeverityFor(rec) {
  const e = (rec.error || '').toLowerCase();
  const k = (rec.checkKey || '').toLowerCase();
  if (/invalid ssl|ssl certificate/.test(e)) return 'critical';
  if (/not installed|wordfence|rank math/.test(e)) return 'critical';
  if (/ga4|analytics 4|search console/.test(e)) return 'critical';
  if (/duplicate content/.test(e)) return 'critical';
  if (/broken link|canonical tag issue|structured data errors/.test(e)) return 'critical';
  if (/high spam score/.test(e)) return 'critical';
  if (/llms?\.txt|llms-full|llm bots|semantic|structured data markup|no structured data/.test(e)) return 'opportunity';
  if (k === 'llmstxt' || k === 'llmsfull') return 'opportunity';
  return 'warning';
}

function faComputeHealthScore(d, recs) {
  let score = 100;
  recs.forEach((r) => {
    const s = r.severity || faSeverityFor(r);
    score -= s === 'critical' ? 12 : s === 'warning' ? 6 : 3;
  });
  if (d.ssl === 'fail') score -= 5;
  if (d.psd !== null && d.psd < 50) score -= 4;
  if (d.psm !== null && d.psm < 50) score -= 4;
  if (d.spam !== null && d.spam > 30) score -= 4;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Build the themed `sections` report for the forensic audit. */
function faSections(d, recs, score, sevCounts, backlinksSource) {
  const dash = '—';
  const scoreTone = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
  const num = (v) => (v == null ? dash : Number(v).toLocaleString());

  const sslTone = d.ssl === 'pass' ? 'green' : d.ssl === 'fail' ? 'red' : 'slate';
  const psTone = (v) => (v == null ? 'slate' : v >= 90 ? 'green' : v >= 50 ? 'amber' : 'red');
  const daTone = d.da == null ? 'slate' : d.da >= 50 ? 'green' : d.da >= 30 ? 'amber' : 'red';
  const gtTone = !d.gtmetrix ? 'slate' : ['A', 'B'].includes(d.gtmetrix) ? 'green' : d.gtmetrix === 'C' ? 'amber' : 'red';
  const ga4Tone = d.ga4 === 'Connected' ? 'green' : d.ga4 ? 'red' : 'slate';
  const sitemapTone = d.sitemap === 'Present' ? 'green' : d.sitemap ? 'red' : 'slate';
  const httpsTone = d.https === 'Yes' ? 'green' : d.https === 'No' ? 'red' : 'slate';
  const sdTone = d.structdata === 'Yes' ? 'green' : d.structdata === 'No' ? 'red' : 'slate';
  const llmTone = d.llmstxt === 'Present' ? 'green' : d.llmstxt === 'Missing' ? 'red' : 'slate';
  const spamTone = d.spam == null ? 'slate' : d.spam > 30 ? 'red' : d.spam > 15 ? 'amber' : 'green';
  const copyTone = d.copyscape == null ? 'slate' : d.copyscape > 15 ? 'red' : 'green';
  const sitelinerTone = d.siteliner == null ? 'slate' : d.siteliner > 15 ? 'red' : 'green';

  const sections = [
    { type: 'heading', text: `GEO+SEO Forensic Audit — ${d.url}` },
    { type: 'stats', items: [
      { label: 'Health score', value: `${score}/100`, tone: scoreTone },
      { label: 'Critical', value: sevCounts.critical, tone: sevCounts.critical ? 'red' : 'green' },
      { label: 'Warning', value: sevCounts.warning, tone: sevCounts.warning ? 'amber' : 'green' },
      { label: 'Opportunity', value: sevCounts.opportunity, tone: sevCounts.opportunity ? 'blue' : 'green' },
      { label: 'Total issues', value: recs.length, tone: recs.length === 0 ? 'green' : recs.length < 5 ? 'amber' : 'red' },
    ] },
    { type: 'stats', title: 'Key metrics', items: [
      { label: 'SSL', value: d.ssl === 'pass' ? 'Pass' : d.ssl === 'fail' ? 'Fail' : dash, tone: sslTone },
      { label: 'Domain Authority', value: d.da ?? dash, tone: daTone },
      { label: 'PageSpeed Desktop', value: d.psd ?? dash, tone: psTone(d.psd) },
      { label: 'PageSpeed Mobile', value: d.psm ?? dash, tone: psTone(d.psm) },
      { label: 'GTmetrix Grade', value: d.gtmetrix || dash, tone: gtTone },
      { label: 'GA4', value: d.ga4 || dash, tone: ga4Tone },
      { label: 'Sitemap', value: d.sitemap || dash, tone: sitemapTone },
      { label: 'HTTPS Redirect', value: d.https || dash, tone: httpsTone },
      { label: 'Structured Data', value: d.structdata || dash, tone: sdTone },
      { label: 'Semantic HTML', value: d.semantic || dash, tone: d.semantic === 'Yes' ? 'green' : d.semantic ? 'red' : 'slate' },
      { label: 'LLM bots blocked', value: d.llmblock || dash, tone: d.llmblock === 'Yes' ? 'red' : d.llmblock ? 'green' : 'slate' },
      { label: 'llms.txt', value: d.llmstxt || dash, tone: llmTone },
      { label: 'llms-full.txt', value: d.llmsfull || dash, tone: d.llmsfull === 'Present' ? 'green' : d.llmsfull === 'Missing' ? 'red' : 'slate' },
      { label: 'CMS', value: d.cms || dash, tone: 'slate' },
      { label: 'Copyscape dup %', value: d.copyscape == null ? dash : `${d.copyscape}%`, tone: copyTone },
      { label: 'Internal dup %', value: d.siteliner == null ? dash : `${d.siteliner}%`, tone: sitelinerTone },
      { label: 'Backlinks', value: num(d.backlinks) + (backlinksSource ? ` · ${backlinksSource}` : ''), tone: 'slate' },
      { label: 'Referring domains', value: num(d.refdomains), tone: 'slate' },
      { label: 'Organic keywords', value: num(d.orgkw), tone: 'slate' },
      { label: 'Spam score', value: d.spam == null ? dash : `${d.spam}%`, tone: spamTone },
    ] },
  ];

  if (recs.length) {
    sections.push({
      type: 'table',
      title: `Prioritised action plan — ${recs.length} ${recs.length === 1 ? 'issue' : 'issues'}`,
      columns: ['#', 'Severity', 'Issue', 'Recommended action'],
      rows: recs.map((r, i) => ({
        '#': i + 1,
        Severity: FA_SEV_LABEL[r.severity],
        Issue: r.error,
        'Recommended action': r.action,
      })),
    });
  } else {
    sections.push({ type: 'callout', text: 'No issues detected across the audited factors. 🎉' });
  }
  return sections;
}

// ── Integrations: the user's own connected Google data (GSC / GA4 / Ads) ──────
// Calls the live Google API with the user's stored OAuth token (refreshing as
// needed), falling back to seeded data if OAuth isn't configured.
async function integrationsRun(tool, body) {
  const conn = body._integrations?.[tool.integration];
  if (!conn?.connected) {
    return { needsConnect: tool.integration, text: `Connect your ${tool.name} account under Integrations to use this tool.` };
  }
  const live = await fetchIntegration(tool.integration, conn, { ...body, input: body.input || conn.account });
  // No seeded fallback: if the live pull didn't return data, prompt a reconnect.
  if (!live?.rows) {
    return { needsConnect: tool.integration, text: `We couldn’t pull live ${tool.name} data — reconnect your account under Integrations to continue.` };
  }
  return { rows: live.rows, summary: live.summary, source: live.source };
}

// ── Backlinks Explorer: DataForSEO backlinks (summary + ref domains + anchors) ─
// Mirrors the agency's `post(action, {target, mode, ...})` calls and response
// paths (tasks[0].result[0]). Renders the overview as an HTML report.
async function backlinksRun(body) {
  const url = UPSTREAMS.dataforseoCrawler;
  const target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A domain or URL is required.');
  const mode = body.mode || 'domain';
  const post = (action, extra = {}) => postUpstream(url, { action, target, mode, ...extra });
  const result0 = (res) => res?.tasks?.[0]?.result?.[0];

  const [summaryRes, refRes, anchorRes] = await Promise.all([
    post('backlinks_summary').catch(() => null),
    post('referring_domains', { limit: 100 }).catch(() => null),
    post('anchors', { limit: 100 }).catch(() => null),
  ]);

  const s = result0(summaryRes) || {};
  const refDomains = (result0(refRes)?.items || []).slice(0, 15);
  const anchors = (result0(anchorRes)?.items || []).slice(0, 15);

  const summary = {
    backlinks: s.backlinks ?? null,
    referringDomains: s.referring_domains ?? null,
    domainRank: s.rank ?? null,
    spamScore: s.backlinks_spam_score ?? null,
    brokenBacklinks: s.broken_backlinks ?? null,
    referringIps: s.referring_ips ?? null,
  };
  if (summary.backlinks == null && !refDomains.length && !anchors.length) {
    return { text: 'No backlinks data was returned for this target. Check the domain and analysis scope.' };
  }
  return { sections: sectionsBacklinks(target, mode, summary, refDomains, anchors), summary };
}

function sectionsBacklinks(target, mode, s, refDomains, anchors) {
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const isNofollow = (a) => a && (a.nofollow || a.sponsored || a.ugc);
  const out = [
    { type: 'heading', text: `Backlink profile — ${target} (${mode})` },
    { type: 'stats', items: [
      { label: 'Backlinks', value: n(s.backlinks) },
      { label: 'Referring domains', value: n(s.referringDomains) },
      { label: 'Domain rank', value: s.domainRank ?? '—' },
      { label: 'Spam score', value: s.spamScore != null ? `${s.spamScore}%` : '—', tone: s.spamScore > 30 ? 'red' : undefined },
      { label: 'Broken backlinks', value: n(s.brokenBacklinks), tone: s.brokenBacklinks > 0 ? 'amber' : undefined },
      { label: 'Referring IPs', value: n(s.referringIps) },
    ] },
  ];
  if (refDomains.length) out.push({ type: 'table', title: 'Top referring domains', columns: ['Domain', 'Rank', 'Backlinks', 'First seen', 'Type'],
    rows: refDomains.map((d) => ({ Domain: d.domain, Rank: d.rank ?? '—', Backlinks: n(d.backlinks), 'First seen': String(d.first_seen || '').slice(0, 10) || '—', Type: isNofollow(d.referring_links_attributes) ? 'nofollow' : 'dofollow' })) });
  if (anchors.length) out.push({ type: 'table', title: 'Top anchors', columns: ['Anchor', 'Backlinks', 'Ref. domains', 'First seen'],
    rows: anchors.map((a) => ({ Anchor: a.anchor || '(image / no text)', Backlinks: n(a.backlinks), 'Ref. domains': n(a.referring_domains), 'First seen': String(a.first_seen || '').slice(0, 10) || '—' })) });
  return out;
}

// ── AI Discovery / AI Mentions: multi-LLM visibility check ─────────────────────
// derive prompts (keywordsForSite → discovery_prompts, else brand fallback) →
// verify_mentions per prompt × model → poll Bright Data snapshots → summarise.
const AI_MODELS = ['gpt-4o-mini', 'claude-haiku-4-5', 'perplexity'];
const AI_MODEL_LABEL = { 'gpt-4o-mini': 'GPT-4o', 'claude-haiku-4-5': 'Claude', perplexity: 'Perplexity' };

async function aiVisibilityRun(body) {
  const brand = (body.input || '').trim();
  if (!brand) throw new Error('A brand name is required.');
  const target = (body.url || '').trim();
  const location = LOC_NAME(body.location);
  const language = 'English';

  // 1. Derive up to 3 discovery prompts.
  let prompts = [];
  if (target) {
    try {
      const kwRaw = await postUpstream(UPSTREAMS.keywordsForSite, { target, location, language, skip_ai: true });
      const keywords = Object.keys(kwRaw || {})
        .sort((a, b) => (kwRaw[b]?.search_volume || 0) - (kwRaw[a]?.search_volume || 0))
        .slice(0, 5);
      if (keywords.length) {
        const pr = await postUpstream(UPSTREAMS.aiOptimiser, {
          action: 'discovery_prompts', keywords, existingPrompts: [], settings: { temperature: 0.7 },
        });
        prompts = parsePrompts(pr);
      }
    } catch (e) {
      console.error('prompt_derivation_failed', e.message); // fall back to brand prompts
    }
  }
  if (!prompts.length) prompts = brandPrompts(brand, location);
  prompts = prompts.slice(0, 3);

  // 2. Verify each prompt against each model concurrently, under a shared deadline.
  const deadline = Date.now() + 150_000;
  const grid = await Promise.all(
    prompts.flatMap((prompt) =>
      AI_MODELS.map((model) => verifyMention(prompt, model, brand, target, location, deadline).then((r) => ({ ...r, prompt, model })))
    )
  );

  // 3. One row per prompt: ✓score / ✗ per model + average visibility.
  const rows = prompts.map((prompt) => {
    const row = { prompt };
    let sum = 0;
    for (const model of AI_MODELS) {
      const g = grid.find((x) => x.prompt === prompt && x.model === model);
      if (!g || g.error) row[AI_MODEL_LABEL[model]] = '—';
      else { row[AI_MODEL_LABEL[model]] = g.isMentioned ? `✓ ${g.score}%` : '✗'; sum += g.isMentioned ? g.score : 0; }
    }
    row.Avg = `${Math.round(sum / AI_MODELS.length)}%`;
    return row;
  });

  const mentions = grid.filter((g) => g && !g.error && g.isMentioned).length;
  const checks = grid.filter((g) => g && !g.error).length;
  const summary = {
    brand,
    promptsChecked: prompts.length,
    modelsChecked: AI_MODELS.length,
    mentionRate: checks ? `${Math.round((mentions / (prompts.length * AI_MODELS.length)) * 100)}%` : '0%',
  };
  return { rows, summary };
}

/** One verify_mentions call (+ snapshot polling) → normalised finding. */
async function verifyMention(prompt, model, brand, url, location, deadline) {
  try {
    const raw = await postUpstream(UPSTREAMS.aiMentions, { action: 'verify_mentions', prompt, brand, url, location, models: [model] });
    let r = raw?.verification ? raw.verification[0] : raw;
    if (r?.status === 'snapshot_pending' && r.snapshot_id) {
      r = await pollSnapshot(r.snapshot_id, brand, url, model, deadline);
    }
    if (!r || r.status === 'error' || r.status === 'snapshot_pending') return { error: r?.error || 'no result' };
    const analysis = typeof r.analysis === 'string' ? safeParse(r.analysis) : (r.analysis || {});
    return {
      isMentioned: !!analysis.is_mentioned,
      score: Number(analysis.visibility_score) || 0,
      sentiment: analysis.sentiment || 'neutral',
      cited: !!analysis.is_cited,
      rank: Number(analysis.rank) || 0,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Poll a Bright Data snapshot until success/error or the shared deadline. */
async function pollSnapshot(snapshotId, brand, url, model, deadline) {
  while (Date.now() < deadline) {
    await sleep(8000);
    let pd;
    try {
      pd = await postUpstream(UPSTREAMS.aiMentions, { action: 'poll_snapshot', snapshot_id: snapshotId, brand, url, model });
    } catch { continue; }
    if (pd?.status === 'running') continue;
    if (pd?.status === 'success') return pd;
    if (pd?.error) return { status: 'error', error: pd.error };
  }
  return { status: 'error', error: 'snapshot timed out' };
}

function parsePrompts(raw) {
  const content = raw?.result || raw?.text || (typeof raw === 'string' ? raw : '');
  try {
    const m = content.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : content);
    if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
  } catch { /* fall through to line-splitting */ }
  return content.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter((l) => l.length > 5).slice(0, 10);
}

function brandPrompts(brand, location) {
  const loc = location && location !== 'Global' ? ` in ${location}` : '';
  return [
    `What is ${brand} and what do they offer?`,
    `Is ${brand} a good option${loc}?`,
    `What are the best alternatives to ${brand}${loc}?`,
  ];
}

// LOCATION code (from the catalog selects) → full name the upstreams expect.
const LOC_NAMES = { SG: 'Singapore', MY: 'Malaysia', US: 'United States', GB: 'United Kingdom', AU: 'Australia', Worldwide: 'Global' };
function LOC_NAME(code) { return LOC_NAMES[code] || code || 'Singapore'; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

// ── AI Content Optimiser: write/optimise + 18-agent QA suite ──────────────────
// Mirrors the agency's OPTIMISER_AGENTS + optimiser_agent / content_freeform
// actions. Optionally drafts content first, then runs the selected agent group
// over it and renders each agent's structured findings.
const OPTIMISER_AGENTS = [
  { key: 'keyResearcher', group: 'research', label: 'Key Researcher' },
  { key: 'marketResearcher', group: 'research', label: 'Market Researcher' },
  { key: 'topicGenerator', group: 'research', label: 'Topic Generator' },
  { key: 'factGatherer', group: 'research', label: 'Fact Gatherer' },
  { key: 'povInfo', group: 'research', label: 'POV Information Assets' },
  { key: 'pov', group: 'research', label: 'POV & Uniqueness' },
  { key: 'helpfulness', group: 'research', label: 'Helpfulness' },
  { key: 'branding', group: 'verify', label: 'Branding Check' },
  { key: 'legal', group: 'verify', label: 'Legal & Compliance' },
  { key: 'factCheck', group: 'verify', label: 'Fact Checking' },
  { key: 'language', group: 'verify', label: 'Language & Readability' },
  { key: 'length', group: 'verify', label: 'Length & Sufficiency' },
  { key: 'formatting', group: 'verify', label: 'Formatting' },
  { key: 'flow', group: 'verify', label: 'Flow & Cohesion' },
  { key: 'hierarchy', group: 'verify', label: 'Topical Hierarchy' },
  { key: 'faqs', group: 'structure', label: 'FAQs' },
  { key: 'schemas', group: 'structure', label: 'Schema Markup' },
  { key: 'tocTldr', group: 'structure', label: 'Table of Contents / TL;DR' },
];

function aiContentSettings(body) {
  return {
    audience: (body.audience || 'Working professionals').trim(),
    brandTone: (body.brandTone || 'Professional').trim(),
    searchIntent: 'Informational', industry: 'General', riskLevel: 'Low',
    jurisdictions: 'Singapore', locale: 'en-SG',
    readingLevel: (body.readingLevel || 'Grade 6-8 (Easy)').trim(),
    doUseWords: '', doNotUseWords: (body.doNotUseWords || '').trim(),
    focusProducts: '', schemaType: 'Article', pageType: (body.pageType || 'Any').trim(),
    complianceDisclaimers: false, suggestExternalLinks: false,
    contentType: 'general', targetReader: (body.audience || 'General public').trim(),
  };
}

async function contentOptimiserRun(body) {
  const url = UPSTREAMS.aiOptimiser;
  const settings = aiContentSettings(body);
  const keyword = (body.keyword || '').trim();
  const secondaryArr = splitItems(body.secondary);
  const writing = /write/i.test(body.mode || '');

  let content = (body.input || '').trim();
  let draft = '';
  if (writing) {
    const draftRaw = await postUpstream(url, {
      action: 'content_freeform',
      userPrompt: `Write a focused, SEO-friendly article about: "${content}". Use clear H2/H3 headings, a short intro, scannable sections and a brief conclusion. Primary keyword: ${keyword || content}.`,
      personaContext: {}, selectedTopics: [],
      primary_keyword: keyword, secondary_keywords: secondaryArr,
      compliance_guidelines: [], settings,
    });
    draft = aiText(draftRaw);
    if (draft) content = draft;
  }
  if (!content) return { text: 'Add some content to optimise (or a topic to write about).' };

  const grp = body.analysis || '';
  const agents = /^Full/i.test(grp) ? OPTIMISER_AGENTS
    : /^Research/i.test(grp) ? OPTIMISER_AGENTS.filter((a) => a.group === 'research')
    : /^Structure/i.test(grp) ? OPTIMISER_AGENTS.filter((a) => a.group === 'structure')
    : OPTIMISER_AGENTS.filter((a) => a.group === 'verify');

  const context = {
    flow: writing ? 'new' : 'optimise', keyword, secondary: secondaryArr.join(', '),
    topic: writing ? (body.input || '').trim() : '', location: 'Singapore', language: 'English',
    content, pageType: settings.pageType, compliance: '', personas: '', selectedTopics: '',
    wordCount: content.split(/\s+/).filter(Boolean).length, flesch: null, fleschLabel: '',
    brandTone: settings.brandTone, jurisdictions: settings.jurisdictions, readingLevel: settings.readingLevel,
  };

  const results = await Promise.all(agents.map((a) =>
    postUpstream(url, { action: 'optimiser_agent', agentKey: a.key, context, settings })
      .then((raw) => ({ a, parsed: parseAgentResult(aiText(raw)) }))
      .catch((e) => ({ a, parsed: { error: e.message } }))
  ));
  return { html: renderOptimiser(writing, draft, context.wordCount, results) };
}

/** Replica of the agency's parseAgentStructuredResult(): JSON header + ---CONTENT---. */
function parseAgentResult(raw) {
  if (!raw || typeof raw !== 'string') return { content: '' };
  const marker = raw.indexOf('---CONTENT---');
  let head = (marker !== -1 ? raw.slice(0, marker) : raw).trim();
  const fence = head.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) head = fence[1].trim();
  const s = head.indexOf('{'), e = head.lastIndexOf('}');
  let obj = null;
  if (s !== -1 && e > s) { try { obj = JSON.parse(head.slice(s, e + 1)); } catch { /* leave null */ } }
  const content = marker !== -1
    ? raw.slice(marker + '---CONTENT---'.length).replace(/^\s*```(?:markdown)?\s*/i, '').replace(/```\s*$/, '').trim()
    : (obj ? '' : raw);
  return { summary: obj?.summary, findings: obj?.findings, score: obj?.score, content };
}

function renderOptimiser(writing, draft, wordCount, results) {
  const card = (label, p) => {
    if (p.error) return `<div style="border:1px solid #fecaca;border-radius:10px;padding:12px;margin:8px 0;background:#fef2f2"><strong>${esc(label)}</strong> — <span style="color:#b91c1c">${esc(p.error)}</span></div>`;
    const score = p.score != null ? `<span style="background:#eef2ff;color:#4f46e5;border-radius:999px;padding:1px 8px;font-size:11px;margin-left:6px">score ${esc(p.score)}</span>` : '';
    const findings = Array.isArray(p.findings) && p.findings.length
      ? `<ul style="margin:6px 0 0;padding-left:18px">${p.findings.map((f) => `<li>${esc(typeof f === 'string' ? f : (f.issue || f.title || JSON.stringify(f)))}${f && f.fix ? ` — <span style="color:#475569">${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul>`
      : '';
    const detail = p.content ? `<div style="white-space:pre-wrap;color:#334155;margin-top:6px;font-size:13px">${esc(p.content.slice(0, 1200))}</div>` : '';
    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0">
      <div><strong>${esc(label)}</strong>${score}</div>
      ${p.summary ? `<p style="color:#475569;margin:6px 0">${esc(p.summary)}</p>` : ''}${findings}${detail}</div>`;
  };
  const draftBlock = writing && draft
    ? `<h3 style="margin:0 0 6px;font-weight:700">Draft (${wordCount} words)</h3><div style="white-space:pre-wrap;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:16px;font-size:13px">${esc(draft.slice(0, 4000))}</div>`
    : '';
  return `${draftBlock}<h3 style="margin:0 0 6px;font-weight:700">QA agent findings <span style="font-weight:400;color:#64748b">— ${results.length} agents</span></h3>${results.map((r) => card(r.a.label, r.parsed)).join('')}`;
}

// ── Content Checker: parse brand guides + references → checkContent ───────────
async function contentCheckRun(body) {
  const content = (body.input || '').trim();
  if (!content) return { text: 'Paste some content to check.' };
  const keyword = (body.keyword || '').trim();
  const tone = (body.tone || 'Any').trim();
  const langVariant = (body.languageVariant || 'British English').trim();
  const compliance = (body.compliance || '').trim();
  const custom = (body.instructions || '').trim();
  const brandGuideUrls = splitItems(body.brandGuideUrls);
  const refUrls = splitItems(body.referenceUrls);

  const [bg, refs] = await Promise.all([
    Promise.all(brandGuideUrls.map((u) => postUpstream(UPSTREAMS.pdfParser, { url: u }).then((r) => ({ u, r })).catch(() => ({ u, r: null })))),
    Promise.all(refUrls.map((u) => postUpstream(UPSTREAMS.contentParsing, { url: u }).then((r) => ({ u, r })).catch(() => ({ u, r: null })))),
  ]);
  const brand_guide = {}; for (const { u, r } of bg) brand_guide[u] = r ?? 'No content';
  const other_sources = {}; for (const { u, r } of refs) other_sources[u] = (r && r.body) ? r.body : (r || 'No content');

  const instructions = [
    `Write and check grammar using ${langVariant} spelling, punctuation, and conventions.`,
    compliance ? `Compliance requirements: ${compliance}` : '',
    custom,
  ].filter(Boolean).join('\n\n');

  const raw = await postUpstream(UPSTREAMS.checkContent, { brand_guide, instructions, content, other_sources, keyword, tone });
  const d = deepBody(raw);
  if (typeof d === 'string') return { text: d };
  const issues = Array.isArray(d.issues) ? d.issues : [];
  if (!issues.length && !d.summary) return { text: typeof d.result === 'string' ? d.result : JSON.stringify(d, null, 2) };
  return { sections: sectionsChecker(d.summary, issues) };
}

function sectionsChecker(summary, issues) {
  const tone = (s) => ({ critical: 'red', high: 'red', medium: 'amber', low: 'green' }[String(s).toLowerCase()] || 'slate');
  const out = [];
  if (summary && typeof summary === 'object') {
    const items = [];
    if (summary.flesch_score != null) items.push({ label: 'Readability', value: `${summary.flesch_score}${summary.flesch_label ? ` · ${summary.flesch_label}` : ''}` });
    if (summary.word_count != null) items.push({ label: 'Words', value: summary.word_count });
    if (summary.avg_sentence_length != null) items.push({ label: 'Avg sentence', value: summary.avg_sentence_length });
    if (summary.total_issues != null) items.push({ label: 'Issues', value: summary.total_issues });
    for (const [k, v] of Object.entries(summary.by_type || {})) items.push({ label: k, value: v });
    if (items.length) out.push({ type: 'stats', items });
  } else if (summary) {
    out.push({ type: 'text', text: String(summary) });
  }
  out.push({ type: 'heading', text: `Issues — ${issues.length}` });
  if (!issues.length) { out.push({ type: 'text', text: 'No issues found. 🎉' }); return out; }
  out.push({
    type: 'cards',
    items: issues.map((i) => ({
      title: i.type || 'Issue',
      badge: i.severity || undefined,
      badgeTone: i.severity ? tone(i.severity) : undefined,
      body: i.reason || undefined,
      lines: i.original ? [{ value: `${i.original}${i.suggested ? ` → ${i.suggested}` : ''}` }] : [],
    })),
  });
  return out;
}

// ── Schema Generator: deterministic JSON-LD builder (mirrors the agency) ──────
function schemaRun(body) {
  const type = (body.type || 'LocalBusiness').trim();
  const schema = { '@context': 'https://schema.org', '@type': type };
  const set = (k, v) => { if (v != null && String(v).trim() !== '') schema[k] = String(v).trim(); };
  for (const k of ['name', 'url', 'description', 'image', 'logo', 'telephone', 'address', 'priceRange', 'openingHours', 'brand', 'sku', 'author', 'datePublished', 'jobTitle']) set(k, body[k]);

  if (body.sameAs) { const u = splitItems(body.sameAs); if (u.length) schema.sameAs = u.length === 1 ? u[0] : u; }
  if (body.offers_price) {
    schema.offers = { '@type': 'Offer', price: String(body.offers_price), priceCurrency: (body.offers_priceCurrency || 'SGD').trim() };
    if (body.offers_availability) schema.offers.availability = `https://schema.org/${body.offers_availability}`;
  }
  if (body.rating_value) schema.aggregateRating = { '@type': 'AggregateRating', ratingValue: String(body.rating_value), reviewCount: String(body.rating_count || 0) };
  if (type === 'FAQPage' && body.faq) {
    const items = String(body.faq).split('\n').map((l) => l.split('|')).filter((p) => p[0]?.trim() && p[1]?.trim())
      .map(([q, a]) => ({ '@type': 'Question', name: q.trim(), acceptedAnswer: { '@type': 'Answer', text: a.trim() } }));
    if (items.length) schema.mainEntity = items;
  }
  if (type === 'BreadcrumbList' && body.breadcrumb) {
    const items = String(body.breadcrumb).split('\n').map((l) => l.split('|')).filter((p) => p[0]?.trim() && p[1]?.trim())
      .map(([n, u], i) => ({ '@type': 'ListItem', position: i + 1, name: n.trim(), item: u.trim() }));
    if (items.length) schema.itemListElement = items;
  }
  const json = JSON.stringify(schema, null, 2);
  const html = `<p style="color:#475569;margin:0 0 8px">Paste this into your page's &lt;head&gt;:</p>`
    + `<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:10px;overflow:auto;font-size:12px;line-height:1.5">${esc(`<script type="application/ld+json">\n${json}\n</script>`)}</pre>`;
  return { html, text: json };
}

// ── Keyword Analysis: metrics / similar / ranking / from-webpage ──────────────
async function keywordAnalysisRun(body) {
  const mode = body.mode || 'Keyword metrics';
  const location = body.location || 'Singapore';
  const language = body.language || 'English';
  const user = body._email || 'saas';

  if (/similar/i.test(mode)) {
    const keywords = splitItems(body.input).slice(0, 25);
    if (!keywords.length) throw new Error('Add at least one seed keyword.');
    const map = deepBody(await postUpstream(UPSTREAMS.similarKeywords, { keywords, location, language, user }));
    return { rows: kwRows(map, ['volume', 'difficulty', 'cpc']) };
  }
  if (/ranking/i.test(mode)) {
    const target = cleanDomain(body.target || body.input);
    if (!target) throw new Error('A domain is required.');
    const map = deepBody(await postUpstream(UPSTREAMS.rankingKeywords, { target, location, user }));
    return { rows: kwRows(map, ['volume', 'rank', 'difficulty', 'traffic']) };
  }
  if (/webpage/i.test(mode)) {
    const target = (body.target || body.input || '').trim();
    if (!target) throw new Error('A page URL is required.');
    const map = deepBody(await postUpstream(UPSTREAMS.keywordsForSite, { location, language, target, skip_ai: false }));
    return { rows: kwRows(map, ['volume', 'difficulty', 'intent', 'reason']) };
  }
  // Default: keyword metrics (mangoolsKeywords)
  const keywords = splitItems(body.input).slice(0, 25);
  if (!keywords.length) throw new Error('Add at least one keyword.');
  const map = deepBody(await postUpstream(UPSTREAMS.mangoolsKeywords, { keywords, location, language }));
  return { rows: kwRows(map, ['volume', 'difficulty', 'cpc']) };
}

function cleanDomain(u) {
  return String(u || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim();
}

/** Shape a { keyword: {metrics} } map into rows with the requested columns. */
function kwRows(map, cols) {
  if (!map || typeof map !== 'object') return [];
  const rows = Object.entries(map).map(([keyword, m]) => {
    m = m || {};
    const row = { keyword };
    if (cols.includes('volume')) row.volume = m.search_volume ?? m.search_vol ?? m.volume ?? 0;
    if (cols.includes('difficulty')) row.difficulty = m.difficulty ?? m.competition ?? m.seo ?? '—';
    if (cols.includes('cpc')) row.cpc = m.cpc != null ? `S$${Number(m.cpc).toFixed(2)}` : '—';
    if (cols.includes('rank')) row.rank = m.rank ?? m.best_position ?? '—';
    if (cols.includes('traffic')) row.traffic = m.traffic ?? '—';
    if (cols.includes('intent')) row.intent = m.search_intent ?? m.intent ?? '—';
    if (cols.includes('reason')) row.reason = m.reason_for_choosing ?? m.reason ?? '';
    return row;
  });
  rows.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
  return rows;
}

// ── Time to Rank: keyword metrics + SERP + LLM time-to-rank forecast ──────────
async function timeToRankRun(body) {
  const keywords = splitItems(body.input).slice(0, 8);
  if (!keywords.length) throw new Error('Add at least one keyword.');
  const domain = (body.domain || body.url || '').trim();
  const location = body.location || 'Singapore';
  const language = body.language || 'English';

  let kwMap = {};
  try { kwMap = deepBody(await postUpstream(UPSTREAMS.mangoolsKeywords, { keywords, location, language })) || {}; } catch { /* metrics optional */ }

  const rows = await Promise.all(keywords.map(async (keyword) => {
    const m = kwMap[keyword] || {};
    const difficulty = m.difficulty ?? m.competition ?? null;
    let timeToRank = '';
    try {
      const serps = deepBody(await postUpstream(UPSTREAMS.serpLite, { keyword, language, location, user: body._email || 'saas' }));
      const rec = await postUpstream(UPSTREAMS.kwRecommendations, { keyword, target_content: [{ url: domain, domain_metrics: {}, rank: null }], serps_dict: serps });
      const recText = String(deepBody(rec) ?? '');
      const hit = recText.match(/(0-3 months|3-6 months|6-9 months|9-12 months|more than 12 months)/i);
      if (hit) timeToRank = hit[0];
    } catch { /* fall through to heuristic */ }
    if (!timeToRank) timeToRank = difficultyToTime(difficulty);
    return {
      keyword,
      volume: m.search_volume ?? m.volume ?? '—',
      difficulty: difficulty ?? '—',
      cpc: m.cpc != null ? `S$${Number(m.cpc).toFixed(2)}` : '—',
      timeToRank,
    };
  }));
  rows.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
  return { rows };
}

function difficultyToTime(kd) {
  const d = Number(kd);
  if (!Number.isFinite(d)) return 'N/A';
  if (d < 15) return '0-3 months';
  if (d < 30) return '3-6 months';
  if (d < 50) return '6-9 months';
  if (d < 70) return '9-12 months';
  return 'more than 12 months';
}

// ── Anchor Text Cleaner: fetch page HTML → classify internal anchors ──────────
const GENERIC_ANCHORS = new Set(['click here', 'read more', 'here', 'this', 'learn more', 'find out more', 'more', 'link', 'read', 'view', 'see more', 'click', 'continue reading', 'details']);

async function anchorCleanerRun(body) {
  const target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A target URL is required.');
  const keyword = (body.keyword || '').trim().toLowerCase();
  const kwTokens = keyword.split(/\s+/).filter(Boolean);
  let host = '';
  try { host = new URL(target).hostname.replace(/^www\./, ''); } catch { /* leave blank */ }

  const raw = await postUpstream(UPSTREAMS.getHtml, { url: target });
  const html = typeof raw === 'string' ? raw : (raw?.body || raw?.html || '');
  if (!html || typeof html !== 'string') return { text: 'Could not fetch the page HTML. Check the URL.' };

  const anchors = extractAnchors(html, host);
  if (!anchors.length) return { text: 'No internal links were found on this page.' };
  const classified = anchors.map((a) => ({ ...a, ...classifyAnchor(a.text, keyword, kwTokens) }));

  const total = classified.length;
  const exact = classified.filter((a) => a.status === 'Exact match').length;
  const generic = classified.filter((a) => a.status === 'Topically generic').length;
  const empty = classified.filter((a) => a.status === 'Empty / broken').length;
  const overOpt = total > 0 && exact / total > 0.3;
  let health = 100;
  if (empty) health -= Math.min(25, empty * 8);
  if (generic) health -= Math.min(30, generic * 5);
  if (overOpt) health -= 25;
  health = Math.max(0, Math.round(health));

  const flagged = classified.filter((a) => a.priority !== 'KEEP');
  return { sections: sectionsAnchors(target, { total, exact, generic, empty, overOpt, health }, flagged) };
}

function extractAnchors(html, host) {
  const out = [];
  const re = /<a\b[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 400) {
    const href = m[1].trim();
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    let internal = false;
    if (href.startsWith('/') && !href.startsWith('//')) internal = true;
    else { try { internal = !!host && new URL(href).hostname.replace(/^www\./, '') === host; } catch { internal = false; } }
    if (!internal) continue;
    out.push({ href, text });
  }
  return out;
}

function classifyAnchor(text, keyword, kwTokens) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return { status: 'Empty / broken', priority: 'CRITICAL', recommendation: 'Add descriptive, relevant anchor text or remove the link.' };
  if (GENERIC_ANCHORS.has(t)) return { status: 'Topically generic', priority: 'HIGH', recommendation: 'Replace with anchor text that describes the destination topic.' };
  if (keyword && t === keyword) return { status: 'Exact match', priority: 'MEDIUM', recommendation: 'Fine in moderation — vary anchors site-wide to avoid over-optimisation.' };
  if (keyword && kwTokens.length && kwTokens.every((tok) => t.includes(tok))) return { status: 'Partial match', priority: 'KEEP', recommendation: 'Natural partial-match anchor.' };
  if (keyword && kwTokens.some((tok) => t.includes(tok))) return { status: 'Near miss', priority: 'KEEP', recommendation: 'Relevant variation — fine.' };
  return { status: 'Brand / other', priority: 'KEEP', recommendation: 'Natural anchor — keeps link profile diverse.' };
}

function sectionsAnchors(target, s, flagged) {
  const out = [
    { type: 'heading', text: `Anchor audit — ${target}` },
    { type: 'stats', items: [
      { label: 'Health', value: `${s.health}/100`, tone: s.health < 60 ? 'red' : undefined },
      { label: 'Internal links', value: s.total },
      { label: 'Exact-match', value: s.exact, tone: s.overOpt ? 'red' : undefined },
      { label: 'Generic', value: s.generic, tone: s.generic > 0 ? 'amber' : undefined },
      { label: 'Empty / broken', value: s.empty, tone: s.empty > 0 ? 'red' : undefined },
    ] },
  ];
  if (s.overOpt) out.push({ type: 'callout', text: '⚠ Over-optimisation: more than 30% of internal anchors are exact-match. Diversify them.' });
  out.push({ type: 'heading', text: `Anchors to fix — ${flagged.length} of ${s.total}` });
  if (!flagged.length) { out.push({ type: 'text', text: 'No problem anchors found. 🎉' }); return out; }
  out.push({
    type: 'table',
    columns: ['Anchor', 'Links to', 'Issue', 'Priority', 'Fix'],
    rows: flagged.map((a) => ({ Anchor: a.text || '(empty)', 'Links to': a.href, Issue: a.status, Priority: a.priority, Fix: a.recommendation })),
  });
  return out;
}

// ── Performance Marketing Audit: paid-media opportunity analysis ──────────────
async function perfMarketingRun(body) {
  const raw = await postUpstream(UPSTREAMS.performanceMarketing, {
    website_url: (body.input || body.url || '').trim(),
    business_category: (body.category || '').trim(),
    target_country: (body.country || 'Singapore').trim(),
    target_audience: (body.audience || '').trim(),
    monthly_budget: (body.budget || '').trim(),
    objectives: (body.objectives || '').trim(),
    current_platforms: splitItems(body.platforms),
    rfq_notes: (body.rfqNotes || '').trim(),
  });
  const d = parsePmAnswer(raw);
  if (!d) return { text: 'The audit did not return a usable result. Please try again.' };
  return { sections: sectionsPerfMarketing(d) };
}

function parsePmAnswer(raw) {
  const data = deepBody(raw);
  let answer = data?.answer != null ? data.answer : data;
  if (typeof answer === 'string') {
    let s = answer.trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch { return null; }
  }
  return answer && typeof answer === 'object' ? answer : null;
}

function sectionsPerfMarketing(d) {
  const out = [];
  if (d.executive_summary) out.push({ type: 'callout', text: d.executive_summary });
  const r = d.estimated_budget_range || {};
  out.push({ type: 'stats', title: `Estimated budget range${r.currency ? ` (${r.currency})` : ''}`, items: [
    { label: 'Conservative', value: r.conservative || '—', tone: 'green' },
    { label: 'Recommended', value: r.recommended || '—', tone: 'blue' },
    { label: 'Aggressive', value: r.aggressive || '—', tone: 'orange' },
  ] });
  if (r.rationale) out.push({ type: 'text', text: r.rationale });
  const suitTone = (s) => ({ high: 'green', medium: 'amber', low: 'slate' }[String(s).toLowerCase()] || 'slate');
  out.push({ type: 'cards', title: 'Recommended channel mix', items: (d.platform_recommendations || []).map((p) => ({
    title: p.platform, badge: p.suitability, badgeTone: suitTone(p.suitability),
    meta: `${p.monthly_budget || ''}${p.budget_share_pct != null ? ` · ${p.budget_share_pct}%` : ''}`.trim(),
    barPct: Number(p.budget_share_pct) || 0,
    lines: [p.primary_objective && { label: 'Objective', value: p.primary_objective }, p.rationale && { label: 'Why', value: p.rationale }, p.expected_outcome && { label: 'Expected', value: p.expected_outcome }].filter(Boolean),
  })) });
  if ((d.opportunities || []).length) out.push({ type: 'cards', title: 'Opportunities', items: d.opportunities.map((o) => ({
    title: o.title, lines: [o.insight && { label: '', value: o.insight }, o.recommended_action && { label: 'Action', value: o.recommended_action }].filter(Boolean),
  })) });
  if ((d.quick_wins || []).length) out.push({ type: 'list', title: '✅ Quick wins', items: d.quick_wins, tone: 'green' });
  if ((d.watch_outs || []).length) out.push({ type: 'list', title: '⚠ Watch-outs', items: d.watch_outs, tone: 'red' });
  if ((d.sales_talking_points || []).length) out.push({ type: 'list', title: 'Sales talking points', items: d.sales_talking_points });
  return out;
}

/** aiOptimiser response → text (handles statusCode/body + result/text/content). */
function aiText(raw) {
  const d = deepBody(raw);
  if (typeof d === 'string') return d;
  return d.result || d.text || d.content || d.response || '';
}
/** Unwrap a possibly-doubly-wrapped { body } / { statusCode, body } envelope. */
function deepBody(raw) {
  let b = raw?.body ?? raw;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return raw; } }
  return b;
}

// Exposed for unit tests (orchestration is otherwise unreachable without a full
// authed event). Not used by the handler path.
export const __test = { callUpstream, crawlRun, aiVisibilityRun, backlinksRun, strategyEngineRun, contentOptimiserRun, contentCheckRun, timeToRankRun, anchorCleanerRun, perfMarketingRun, schemaRun, keywordAnalysisRun, kwRows, cleanDomain, classifyAnchor, difficultyToTime, parseAgentResult, parsePrompts, brandPrompts, pageIssues, LOC_NAME, clampInt, sectionsChecker, sectionsAnchors, sectionsBacklinks, sectionsPerfMarketing, generateForensicRecommendations, faSeverityFor, faComputeHealthScore, faSections, faParseHomeHtml, faParseRobots, faValidTxt, faStripHtml, buildLlmsTxt, buildLlmsFull, extractSiteLinks };

/**
 * AI endpoints return token usage; convert to actual credits so a tiny caption
 * doesn't cost the same as a 2,000-word article. Falls back to the flat cost.
 */
function reconcileCost(tool, result, flatCost) {
  const u = result?.usage || result?.token_usage;
  if (tool.cost?.startsWith('ai_') && u) {
    const inTok = u.input_tokens || u.prompt_tokens || 0;
    const outTok = u.output_tokens || u.completion_tokens || 0;
    // ~1 credit per 1k tokens, but never less than the advertised minimum.
    const tokenCredits = Math.ceil((inTok + outTok) / 1000);
    return Math.max(flatCost, tokenCredits);
  }
  return flatCost;
}

function usageMeta(result) {
  const u = result?.usage || result?.token_usage;
  return u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : {};
}

function applyTeaser(tool, result) {
  const reveal = tool.teaser?.reveal;
  if (reveal === 'first-2-of-10' && Array.isArray(result?.items)) {
    return {
      items: result.items.slice(0, 2),
      lockedCount: Math.max(0, result.items.length - 2),
      teaserMessage: `${Math.max(0, result.items.length - 2)} more findings — unlock with ${PLANS[tool.minTier].name}`,
    };
  }
  if (reveal === 'summary-only') {
    return {
      summary: result?.summary || result?.score || result,
      detailsLocked: true,
      teaserMessage: `Full report unlocks with ${PLANS[tool.minTier].name}`,
    };
  }
  return { teaserMessage: `Unlock the full tool with ${PLANS[tool.minTier].name}`, preview: result };
}

function capRows(tool, result, cap) {
  if (!Array.isArray(result?.rows)) return result;
  return {
    rows: result.rows.slice(0, cap),
    blurredCount: Math.max(0, result.rows.length - cap),
    capMessage: `${Math.max(0, result.rows.length - cap)} more rows — upgrade to reveal`,
  };
}

// Teaser budget is tracked on the user record as a {toolId: 'YYYY-MM'} map.
async function teaserBudget(user, toolId) {
  const month = new Date().toISOString().slice(0, 7);
  const used = user.teasers?.[toolId] === month ? 1 : 0;
  return TEASER_RUNS_PER_MONTH - used;
}

async function markTeaserUsed(user, toolId) {
  const month = new Date().toISOString().slice(0, 7);
  const teasers = { ...(user.teasers || {}), [toolId]: month };
  await putUser({ ...user, teasers, updatedAt: new Date().toISOString() });
}
