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
  if (tool.id === 'technical-seo' || tool.id === 'forensic-audit') return crawlRun(body, tool);
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
  return { html: renderStrategy(strategies, recommended, recs) };
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
function renderStrategy(strategies, recommended, recs) {
  const prio = (p) => ({ high: '#dc2626', medium: '#d97706', low: '#16a34a' }[String(p).toLowerCase()] || '#64748b');
  const stratRows = strategies.map((s) => `
    <tr style="border-top:1px solid #e2e8f0">
      <td style="padding:8px;font-weight:600">${s === recommended ? '★ ' : ''}${esc(s.name)}</td>
      <td style="padding:8px;color:#475569">${esc(s.focus_area || s.focus)}</td>
      <td style="padding:8px;color:#475569">${esc((s.target_keywords || []).slice(0, 6).join(', '))}</td>
    </tr>`).join('');
  const strengths = (recs.strengths || []).map((x) => `
    <li style="margin:6px 0"><strong>${esc(x.title)}</strong> — <span style="color:#475569">${esc(x.detail || x.description)}</span></li>`).join('');
  const recCards = (recs.recommendations || []).map((r) => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(r.title)}</strong>
        ${r.priority ? `<span style="background:${prio(r.priority)};color:#fff;border-radius:999px;padding:1px 8px;font-size:11px;text-transform:uppercase">${esc(r.priority)}</span>` : ''}
        ${r.effort ? `<span style="background:#f1f5f9;color:#475569;border-radius:999px;padding:1px 8px;font-size:11px">effort: ${esc(r.effort)}</span>` : ''}
      </div>
      <p style="color:#475569;margin:6px 0">${esc(r.description)}</p>
      ${Array.isArray(r.action_items) && r.action_items.length ? `<ul style="margin:6px 0 0;padding-left:18px">${r.action_items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
    </div>`).join('');

  return `
    <h3 style="margin:0 0 6px;font-weight:700">Keyword strategy options</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:#64748b"><th style="padding:8px">Strategy</th><th style="padding:8px">Focus</th><th style="padding:8px">Top keywords</th></tr></thead>
      <tbody>${stratRows}</tbody>
    </table>
    ${strengths ? `<h3 style="margin:18px 0 6px;font-weight:700">✅ What you're doing well</h3><ul style="margin:0;padding-left:18px;font-size:13px">${strengths}</ul>` : ''}
    ${recCards ? `<h3 style="margin:18px 0 6px;font-weight:700">🎯 Prioritised action plan <span style="font-weight:400;color:#64748b">— for “${esc(recommended.name)}”</span></h3>${recCards}` : ''}`;
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

// ── Integrations: the user's own connected Google data (GSC / GA4 / Ads) ──────
// Calls the live Google API with the user's stored OAuth token (refreshing as
// needed), falling back to seeded data if OAuth isn't configured.
async function integrationsRun(tool, body) {
  const conn = body._integrations?.[tool.integration];
  if (!conn?.connected) {
    return { needsConnect: tool.integration, text: `Connect your ${tool.name} account under Integrations to use this tool.` };
  }
  const { rows, summary } = await fetchIntegration(tool.integration, conn, { ...body, input: body.input || conn.account });
  return { rows, summary };
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
  return { html: renderBacklinks(target, mode, summary, refDomains, anchors), summary };
}

function renderBacklinks(target, mode, s, refDomains, anchors) {
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
  const isNofollow = (a) => a && (a.nofollow || a.sponsored || a.ugc);
  const stat = (label, value) => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;min-width:130px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b">${esc(label)}</div>
      <div style="font-size:20px;font-weight:700;color:#0f172a">${esc(value)}</div>
    </div>`;
  const stats = [
    stat('Backlinks', fmtNum(s.backlinks)),
    stat('Referring domains', fmtNum(s.referringDomains)),
    stat('Domain rank', s.domainRank ?? '—'),
    stat('Spam score', s.spamScore != null ? `${s.spamScore}%` : '—'),
    stat('Broken backlinks', fmtNum(s.brokenBacklinks)),
    stat('Referring IPs', fmtNum(s.referringIps)),
  ].join('');

  const refRows = refDomains.map((d) => `
    <tr style="border-top:1px solid #f1f5f9">
      <td style="padding:6px 8px">${esc(d.domain)}</td>
      <td style="padding:6px 8px">${d.rank ?? '—'}</td>
      <td style="padding:6px 8px">${fmtNum(d.backlinks)}</td>
      <td style="padding:6px 8px">${esc(String(d.first_seen || '').slice(0, 10) || '—')}</td>
      <td style="padding:6px 8px">${isNofollow(d.referring_links_attributes) ? 'nofollow' : 'dofollow'}</td>
    </tr>`).join('');
  const anchorRows = anchors.map((a) => `
    <tr style="border-top:1px solid #f1f5f9">
      <td style="padding:6px 8px">${esc(a.anchor || '(image / no text)')}</td>
      <td style="padding:6px 8px">${fmtNum(a.backlinks)}</td>
      <td style="padding:6px 8px">${fmtNum(a.referring_domains)}</td>
      <td style="padding:6px 8px">${esc(String(a.first_seen || '').slice(0, 10) || '—')}</td>
    </tr>`).join('');

  const th = (cols) => `<thead><tr style="text-align:left;color:#64748b;font-size:12px">${cols.map((c) => `<th style="padding:6px 8px">${c}</th>`).join('')}</tr></thead>`;
  return `
    <h3 style="margin:0 0 8px;font-weight:700">Backlink profile — ${esc(target)} <span style="font-weight:400;color:#64748b">(${esc(mode)})</span></h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">${stats}</div>
    ${refRows ? `<h4 style="margin:0 0 6px;font-weight:700">Top referring domains</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">
        ${th(['Domain', 'Rank', 'Backlinks', 'First seen', 'Type'])}<tbody>${refRows}</tbody></table>` : ''}
    ${anchorRows ? `<h4 style="margin:0 0 6px;font-weight:700">Top anchors</h4>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        ${th(['Anchor', 'Backlinks', 'Ref. domains', 'First seen'])}<tbody>${anchorRows}</tbody></table>` : ''}`;
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
  return { html: renderChecker(d.summary, issues) };
}

function renderChecker(summary, issues) {
  const sev = (s) => ({ critical: '#dc2626', high: '#dc2626', medium: '#d97706', low: '#16a34a' }[String(s).toLowerCase()] || '#64748b');
  const stat = (label, value) => `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b">${esc(label)}</div><div style="font-size:18px;font-weight:700">${esc(value)}</div></div>`;
  let summaryHtml = '';
  if (summary && typeof summary === 'object') {
    const chips = [];
    if (summary.flesch_score != null) chips.push(stat('Readability', `${summary.flesch_score}${summary.flesch_label ? ` · ${summary.flesch_label}` : ''}`));
    if (summary.word_count != null) chips.push(stat('Words', summary.word_count));
    if (summary.avg_sentence_length != null) chips.push(stat('Avg sentence', summary.avg_sentence_length));
    if (summary.total_issues != null) chips.push(stat('Issues', summary.total_issues));
    for (const [k, v] of Object.entries(summary.by_type || {})) chips.push(stat(k, v));
    summaryHtml = `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px">${chips.join('')}</div>`;
  } else if (summary) {
    summaryHtml = `<p style="color:#475569;margin:0 0 14px">${esc(summary)}</p>`;
  }
  const rows = issues.map((i) => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(i.type || 'Issue')}</strong>
        ${i.severity ? `<span style="background:${sev(i.severity)};color:#fff;border-radius:999px;padding:1px 8px;font-size:11px;text-transform:uppercase">${esc(i.severity)}</span>` : ''}
      </div>
      ${i.reason ? `<p style="color:#475569;margin:6px 0">${esc(i.reason)}</p>` : ''}
      ${i.original ? `<div style="font-size:13px"><span style="color:#b91c1c;text-decoration:line-through">${esc(i.original)}</span>${i.suggested ? ` → <span style="color:#16a34a">${esc(i.suggested)}</span>` : ''}</div>` : ''}
    </div>`).join('');
  return `${summaryHtml}<h3 style="margin:0 0 6px;font-weight:700">Issues <span style="font-weight:400;color:#64748b">— ${issues.length}</span></h3>${rows || '<p style="color:#16a34a">No issues found. 🎉</p>'}`;
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
  return { html: renderAnchors(target, { total, exact, generic, empty, overOpt, health }, flagged) };
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

function renderAnchors(target, s, flagged) {
  const prio = (p) => ({ CRITICAL: '#dc2626', HIGH: '#d97706', MEDIUM: '#2563eb' }[p] || '#64748b');
  const stat = (label, value, warn) => `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:8px 12px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#64748b">${esc(label)}</div><div style="font-size:18px;font-weight:700;color:${warn ? '#dc2626' : '#0f172a'}">${esc(value)}</div></div>`;
  const stats = [
    stat('Health', `${s.health}/100`, s.health < 60),
    stat('Internal links', s.total),
    stat('Exact-match', s.exact, s.overOpt),
    stat('Generic', s.generic, s.generic > 0),
    stat('Empty / broken', s.empty, s.empty > 0),
  ].join('');
  const rows = flagged.map((a) => `
    <tr style="border-top:1px solid #f1f5f9">
      <td style="padding:6px 8px">${esc(a.text || '(empty)')}</td>
      <td style="padding:6px 8px;color:#475569;max-width:260px;overflow:hidden;text-overflow:ellipsis">${esc(a.href)}</td>
      <td style="padding:6px 8px">${esc(a.status)}</td>
      <td style="padding:6px 8px"><span style="background:${prio(a.priority)};color:#fff;border-radius:999px;padding:1px 8px;font-size:11px">${esc(a.priority)}</span></td>
      <td style="padding:6px 8px;color:#475569">${esc(a.recommendation)}</td>
    </tr>`).join('');
  return `
    <h3 style="margin:0 0 8px;font-weight:700">Anchor audit — ${esc(target)}</h3>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">${stats}</div>
    ${s.overOpt ? '<p style="color:#b91c1c;font-size:13px;margin:0 0 12px">⚠ Over-optimisation: more than 30% of internal anchors are exact-match. Diversify them.</p>' : ''}
    <h4 style="margin:6px 0;font-weight:700">Anchors to fix <span style="font-weight:400;color:#64748b">— ${flagged.length} of ${s.total}</span></h4>
    ${flagged.length ? `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="text-align:left;color:#64748b;font-size:12px"><th style="padding:6px 8px">Anchor</th><th style="padding:6px 8px">Links to</th><th style="padding:6px 8px">Issue</th><th style="padding:6px 8px">Priority</th><th style="padding:6px 8px">Fix</th></tr></thead>
      <tbody>${rows}</tbody></table>` : '<p style="color:#16a34a">No problem anchors found. 🎉</p>'}`;
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
  return { html: renderPerfMarketing(d) };
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

function renderPerfMarketing(d) {
  const suit = (s) => ({ high: '#16a34a', medium: '#d97706', low: '#64748b' }[String(s).toLowerCase()] || '#64748b');
  const list = (arr, color) => Array.isArray(arr) && arr.length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${arr.map((x) => `<li style="margin:3px 0;color:${color || '#334155'}">${esc(x)}</li>`).join('')}</ul>` : '';
  const r = d.estimated_budget_range || {};
  const tile = (label, val, color) => `<div style="flex:1;min-width:120px;border:1px solid #e2e8f0;border-top:3px solid ${color};border-radius:10px;padding:10px"><div style="font-size:11px;text-transform:uppercase;color:#64748b">${label}</div><div style="font-size:18px;font-weight:700">${esc(val || '—')}</div></div>`;
  const platforms = (d.platform_recommendations || []).map((p) => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <strong>${esc(p.platform)}</strong>
        <span style="background:${suit(p.suitability)};color:#fff;border-radius:999px;padding:1px 8px;font-size:11px">${esc(p.suitability)}</span>
        <span style="margin-left:auto;font-weight:700">${esc(p.monthly_budget || '')} ${p.budget_share_pct != null ? `· ${esc(p.budget_share_pct)}%` : ''}</span>
      </div>
      <div style="height:6px;background:#f1f5f9;border-radius:999px;margin:8px 0;overflow:hidden"><div style="height:100%;width:${Number(p.budget_share_pct) || 0}%;background:#4f46e5"></div></div>
      ${p.primary_objective ? `<div style="font-size:13px"><strong>Objective:</strong> ${esc(p.primary_objective)}</div>` : ''}
      ${p.rationale ? `<div style="font-size:13px;color:#475569"><strong>Why:</strong> ${esc(p.rationale)}</div>` : ''}
      ${p.expected_outcome ? `<div style="font-size:13px;color:#475569"><strong>Expected:</strong> ${esc(p.expected_outcome)}</div>` : ''}
    </div>`).join('');
  const opps = (d.opportunities || []).map((o) => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0">
      <strong>${esc(o.title)}</strong>
      ${o.insight ? `<p style="color:#475569;margin:6px 0">${esc(o.insight)}</p>` : ''}
      ${o.recommended_action ? `<div style="font-size:13px"><strong>Action:</strong> ${esc(o.recommended_action)}</div>` : ''}
    </div>`).join('');
  return `
    ${d.executive_summary ? `<div style="border-left:3px solid #4f46e5;background:#f8fafc;padding:10px 14px;border-radius:0 8px 8px 0;margin-bottom:16px">${esc(d.executive_summary)}</div>` : ''}
    <h3 style="margin:0 0 6px;font-weight:700">Estimated budget range ${r.currency ? `<span style="font-weight:400;color:#64748b">(${esc(r.currency)})</span>` : ''}</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">${tile('Conservative', r.conservative, '#16a34a')}${tile('Recommended', r.recommended, '#2563eb')}${tile('Aggressive', r.aggressive, '#ea580c')}</div>
    ${r.rationale ? `<p style="color:#475569;font-size:13px;margin:0 0 16px">${esc(r.rationale)}</p>` : ''}
    <h3 style="margin:0 0 6px;font-weight:700">Recommended channel mix</h3>${platforms}
    ${opps ? `<h3 style="margin:18px 0 6px;font-weight:700">Opportunities</h3>${opps}` : ''}
    ${(d.quick_wins || []).length || (d.watch_outs || []).length ? `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:14px">
      ${(d.quick_wins || []).length ? `<div style="flex:1;min-width:220px"><h4 style="margin:0 0 4px;font-weight:700">✅ Quick wins</h4>${list(d.quick_wins, '#166534')}</div>` : ''}
      ${(d.watch_outs || []).length ? `<div style="flex:1;min-width:220px"><h4 style="margin:0 0 4px;font-weight:700">⚠ Watch-outs</h4>${list(d.watch_outs, '#991b1b')}</div>` : ''}
    </div>` : ''}
    ${(d.sales_talking_points || []).length ? `<h3 style="margin:18px 0 6px;font-weight:700">Sales talking points</h3>${list(d.sales_talking_points)}` : ''}`;
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
export const __test = { callUpstream, crawlRun, aiVisibilityRun, backlinksRun, strategyEngineRun, contentOptimiserRun, contentCheckRun, timeToRankRun, anchorCleanerRun, perfMarketingRun, schemaRun, keywordAnalysisRun, kwRows, cleanDomain, classifyAnchor, difficultyToTime, parseAgentResult, parsePrompts, brandPrompts, pageIssues, LOC_NAME, clampInt };

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
