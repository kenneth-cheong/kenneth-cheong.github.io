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
import { getUser, putUser, spendCredits, totalCredits, saveRun, getCache, putCache, appendMetricSnapshots, addNotification } from '../lib/dynamo.mjs';
import { extractMetrics } from '../../../shared/metrics.mjs';
import { UPSTREAMS } from './upstreams.mjs';
import { ADAPTERS, parseStrategyJson, asciiPunct } from './adapters.mjs';
import { gscInspect, gscSitemaps, gscIndexing } from '../lib/google.mjs';
import { fetchIntegrationFor } from '../lib/integrations.mjs';
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
  forbidden,
  paymentRequired,
  tierLocked,
  serverError,
  tooManyRequests,
  parseBody,
  claims,
  preflight,
} from '../lib/http.mjs';
import { accountBlocked } from '../lib/admin.mjs';
import { verify } from '../lib/jwt.mjs';
import { rateLimit, RUN_LIMITS } from '../lib/ratelimit.mjs';

// How many free "teaser" runs a locked tool allows per user per month.
const TEASER_RUNS_PER_MONTH = 1;

export const handler = async (event, context) => {
  // Background self-invocation (InvocationType: Event) — finalize an async
  // Social Audit independently of any browser tab. Not an HTTP event, so it must
  // branch BEFORE any CORS/auth/rate-limit handling.
  if (event && event.__bgFinalize) {
    try { await socialAuditFinalize(event, context); }
    catch (e) { console.error('social_finalize_failed', event.jobId, e?.message); }
    return { ok: true };
  }

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

  // Per-user rate limit (generous burst + hourly ceiling). Runs before any
  // upstream work or credit spend, and covers the Function-URL path too.
  const rl = await rateLimit('run', c.userId, RUN_LIMITS);
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);

  const toolId =
    event.pathParameters?.toolId ||
    (event.rawPath || '').split('/').pop();
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) return badRequest(`Unknown tool: ${toolId}`);

  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');
  if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });

  const body = parseBody(event);
  // Expose the authenticated email to adapters that attribute upstream jobs
  // (e.g. serpCompetitors keys results by user). Gateway-trusted, not user input.
  body._email = c.email || c.userId;
  // Identity for tools that kick off background work (e.g. the async Social
  // Audit finalizer needs to re-authenticate the user it runs on behalf of).
  body._userId = c.userId;
  body._tier = user.tier;
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
      // Rank Checker: add an AI pass over the positions (striking-distance pushes,
      // what to do for unranked keywords). Other fan-out tools keep raw rows.
      if (tool.id === 'rank-checker') {
        const rec = await aiRecommendations({
          label: 'Rank Checker',
          context: `Domain: ${body.target || ''}; Location: ${body.location || 'Singapore'}. Flag striking-distance keywords (roughly positions 4-20) to prioritise, and advise what to do for keywords not ranking in the top 100.`,
          findings: settled.map((s) => `${s.keyword}: ${s.result}`).join('\n'),
        });
        result = withRecs(result, rec);
      }
    } else {
      result = await callUpstream(tool, body);
    }
  } catch (err) {
    console.error('upstream_error', tool.id, err);
    return serverError('The tool backend failed. No credits were charged.');
  }

  // ── Soft-failure gate (spec §6.2–6.4): some upstreams return HTTP 200 with an
  // error payload (e.g. "couldn't fetch the homepage") rather than throwing.
  // Surface the message but NEVER charge for it — credits are only for results.
  const softFailed = isSoftFailure(result);
  if (result && typeof result === 'object') delete result._failed; // strip internal flag from client payload
  // Free sub-steps (e.g. Social Media Audit discover/scrape/poll) opt out of
  // billing with `{ _noCharge: true }`: proxied like a run, but never charged,
  // saved to history, or snapshotted to the performance series.
  const noCharge = !!(result && typeof result === 'object' && result._noCharge === true);
  if (result && typeof result === 'object') delete result._noCharge;
  const charge = willCharge && !softFailed && !noCharge;

  // ── Partial-results shaping for teaser / capped free tier ─────────────────
  let payload = result;
  if (teaser && !softFailed) {
    payload = applyTeaser(tool, result);
    await markTeaserUsed(user, tool.id);
  } else if (tool.freeCap && user.tier === 'free' && !softFailed) {
    payload = capRows(tool, result, tool.freeCap);
  }

  // ── Reconcile credits from actual usage ───────────────────────────────────
  let creditsUsed = 0;
  let creditsRemaining = totalCredits(user);
  let topupRemaining = user.topupCredits || 0;
  if (charge) {
    creditsUsed = reconcileCost(tool, result, fullCost);
    const spent = await spendCredits({
      userId: user.userId,
      cost: creditsUsed,
      tool: tool.id,
      meta: usageMeta(result),
    });
    creditsRemaining = spent.total;
    topupRemaining = spent.topupCredits;
  }

  // Persist the run so the user can re-open it from their history (best-effort).
  // Skip free sub-steps (discover/poll) so a single audit yields one history row.
  let runId = null;
  if (!noCharge) {
    try {
      const saved = await saveRun({
        userId: user.userId, tool: tool.id, toolName: tool.name,
        inputs: publicInputs(body), result: payload, creditsUsed,
        projectId: body.projectId || null,
      });
      runId = saved.runId;
      // In-platform "run complete" ping — the notification bell polls these so a
      // user who navigated away still learns the result is ready. Best-effort;
      // skip soft failures (the message there is the result, not a completion).
      if (!softFailed) {
        try {
          await addNotification({
            userId: user.userId,
            title: `✅ ${tool.name} finished`,
            body: runNotificationPreview(tool, payload),
            link: '/history',
          });
        } catch (e) { console.error('notify_run_failed', tool.id, e.message); }
      }
    } catch (e) { console.error('save_run_failed', tool.id, e.message); }
  }

  // Snapshot the run's headline metric(s) into the per-project performance
  // series — only for real, project-scoped runs (skip teaser/soft-failed runs so
  // partial/empty data never pollutes the trend). Best-effort: never blocks the
  // response. `result` (not the teaser-capped `payload`) carries the full summary.
  if (!teaser && !softFailed && !noCharge && body.projectId) {
    try {
      const metrics = extractMetrics(tool.id, result);
      if (metrics.length) {
        await appendMetricSnapshots(user.userId, {
          projectId: body.projectId, tool: tool.id, toolName: tool.name,
          target: deriveMetricTarget(body), inputs: publicInputs(body),
        }, metrics);
      }
    } catch (e) { console.error('metric_capture_failed', tool.id, e.message); }
  }

  // Structured metric line (CloudWatch Logs Insights / metric filters).
  console.log(JSON.stringify({ metric: 'tool_run', tool: tool.id, ms: Date.now() - t0, creditsUsed, cached: !!result?.cached, teaser, softFailed }));

  return ok({
    tool: tool.id,
    teaser: teaser && !softFailed,
    failed: softFailed,
    result: payload,
    creditsUsed,
    creditsRemaining,
    topupRemaining, // lets the client keep the monthly/top-up split exact without a /me refetch
    runId,
  });
};

/** Human label of what a run measured (the property / domain / URL) for the
 *  Performance series — falls back to the connected integration account. */
function deriveMetricTarget(body) {
  return String(body.input || body.url || body.domain || body.target || '').trim();
}

/** Short body line for the "run complete" notification — a snippet of the
 *  result if there's prose, else a generic "ready to view" nudge. */
function runNotificationPreview(tool, payload) {
  const text = payload && typeof payload === 'object' ? payload.text : null;
  if (typeof text === 'string' && text.trim()) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean;
  }
  return `Your ${tool.name} result is ready to view.`;
}

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
  return asciiPunct(v)
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s) && seen.add(s));
}

// Per-upstream resilience config for backends that hit transient 503s/timeouts
// under load (spec §6.5). Only FAST tools are retried in-process — a slow
// generator (media-plan ~150s) can't fit retries inside the 180s Lambda budget,
// so it relies on the generous default timeout instead.
const FLAKY = {
  contentPillar: { retries: 2, timeoutMs: 60000 },      // Content Pillar Framework — fast; safe to retry
  // GEO On-Page legitimately runs ~50–90s (it rewrites page content via Claude),
  // so it gets a long timeout and NO in-process retry — the transient-503 root
  // cause (a CPU-starved 128MB backend) is fixed at the Lambda, not here.
  geoOnPageAnalysis: { retries: 0, timeoutMs: 170000 },
};
const FLAKY_BY_URL = Object.fromEntries(
  Object.entries(FLAKY).map(([k, v]) => [UPSTREAMS[k], v])
);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * POST to an upstream, unwrapping the { statusCode, body } proxy envelope.
 * Adds an AbortController timeout and exponential-backoff retry on transient
 * failures (auto-applied to FLAKY backends; override via opts).
 */
async function postUpstream(url, payload, opts = {}) {
  const cfg = FLAKY_BY_URL[url] || {};
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? 170000; // < 180s Lambda cap
  const retries = opts.retries ?? cfg.retries ?? 0;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Shared secret so the (eventually private) upstream trusts the gateway.
          'x-gateway-secret': process.env.GATEWAY_SECRET || '',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
          lastErr = new Error(`upstream ${res.status}`);
          continue;
        }
        throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
      }
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
    } catch (err) {
      lastErr = err;
      // Aborted (timeout) or network-level failure → retry if budget remains.
      const transient = err.name === 'AbortError' || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|upstream 5\d\d|upstream 429/i.test(err.message || '');
      if (attempt < retries && transient) continue;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Direct page fetch from the gateway itself — a fallback for when the getHtml
 * upstream (a headless renderer) is slow (>timeout) or returns a bot-challenge
 * page for some WP/CDN sites. Without this, a perfectly reachable homepage can
 * produce a false "could not fetch — check the URL is public" message. Uses a
 * realistic browser UA and follows redirects; returns '' on any failure.
 */
async function directFetchHtml(url, ms = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
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
  if (!isSoftFailure(res)) putCache(key, res, ttl).catch(() => {}); // never cache a soft failure
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
  // Competitors: SERP overlap fan-out → rank table + AI insights.
  if (tool.id === 'competitors') return competitorsRun(body);
  // GEO On-Page: geoOnPageAnalysis returns JSON → render the structured report.
  if (tool.id === 'geo-onpage') return geoOnpageRun(body);
  // Caption: generate N diverse variations (rotating index + temperature).
  if (tool.id === 'caption') return captionRun(body);
  // Media Plan: plan + auto-personas + marketing funnel composite.
  if (tool.id === 'media-plan') return mediaPlanRun(body);
  // On-Page: extract page elements → meta/heading recs + content recs + images.
  if (tool.id === 'onpage') return onpageRun(body);
  // DataForSEO crawl is async: initiate → poll get_results until done.
  if (tool.id === 'technical-seo') return crawlRun(body, tool);
  // GEO+SEO Forensic Audit: fan out ~30 probes, score them, build a remediation plan.
  if (tool.id === 'forensic-audit') return forensicAuditRun(body);
  // Page Technical & Domain Analysis: lighter probe fan-out → metric-card grid.
  if (tool.id === 'page-analysis') return pageAnalysisRun(body);
  // AI-visibility is multi-step: derive prompts → verify_mentions → poll snapshot.
  // AI Mentions: are you cited in AI answers? AI Discovery: technical GEO-readiness.
  if (tool.id === 'ai-mentions') return aiVisibilityRun(body);
  if (tool.id === 'ai-discovery') return aiDiscoveryRun(body);
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
  // Social Media Audit: async, fully server-side. `start` kicks off a background
  // finalizer (scrape→strategy→save→notify); the React page polls `status`. Only
  // the strategy step is charged. See socialAuditRun / socialAuditFinalize.
  if (tool.id === 'social-audit') return socialAuditRun(body);
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

/**
 * Did the upstream return a "soft failure" — an HTTP-200 result that is really
 * an error (couldn't fetch a page, backend exception, empty generation)? Such
 * results are shown to the user but must never be billed (spec §6.2–6.4).
 * Runners and normalize() opt in by setting `_failed: true`.
 */
function isSoftFailure(result) {
  return !!(result && typeof result === 'object' && result._failed === true);
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
  // Upstream returned a 200 with an error payload (e.g. a Python stack trace —
  // spec §6.2). NEVER echo it to the user; log the detail server-side, return a
  // clean message, and flag it non-billable (spec §6.4).
  if (raw.errorMessage || raw.error) {
    console.error('upstream_soft_error', String(raw.errorMessage || raw.error).slice(0, 500));
    return { _failed: true, text: 'The tool backend returned an error — no credits were charged. Please try again in a moment.' };
  }
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

// ── Competitors Identifier: SERP overlap table + AI insights ──────────────────
// index.html dumped serpCompetitors' { domain: { keyword: rank } } straight into
// a table; the SaaS adapter left it unadapted so it rendered as a raw JSON blob.
// Fan out in small batches (avoids upstream 504s), then render a position matrix
// plus a best-effort `competitor_insights` LLM pass.
async function competitorsRun(body) {
  const keywords = String(body.input || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!keywords.length) throw new Error('Enter at least one keyword to find competitors.');
  const location = body.location || 'Singapore';
  const language = body.language || 'English';
  const email = body._email || 'saas-user';

  const merged = {};
  for (const batch of chunkArr(keywords, 3)) {
    try {
      const data = unwrapBody(await postUpstream(UPSTREAMS.serpCompetitors, {
        id: `comp_${email}_${batch.join('|')}`, user: email, keywords: batch, location, language,
      }));
      if (data && typeof data === 'object') {
        for (const dom of Object.keys(data)) merged[dom] = Object.assign(merged[dom] || {}, data[dom] || {});
      }
    } catch (e) { console.error('competitors_batch_failed', e.message); }
  }

  const domains = Object.keys(merged);
  if (!domains.length) {
    return { sections: [{ type: 'callout', text: 'No competitors found ranking for these keywords. Try broader or different keywords.' }] };
  }
  // Most-overlapping competitors first.
  domains.sort((a, b) => Object.keys(merged[b]).length - Object.keys(merged[a]).length);

  const sections = [
    { type: 'heading', text: `Competitors for: ${keywords.join(', ')}` },
    { type: 'stats', items: [
      { label: 'Competitors found', value: domains.length, tone: 'blue' },
      { label: 'Keywords analysed', value: keywords.length, tone: 'slate' },
    ] },
  ];

  // Position matrix when the keyword set is small enough to be columns; else a
  // compact joined "positions" column.
  if (keywords.length <= 8) {
    const columns = ['Competitor', ...keywords];
    const rows = domains.map((d) => {
      const row = { Competitor: d };
      for (const kw of keywords) { const r = merged[d][kw]; row[kw] = (r == null) ? '—' : `#${r}`; }
      return row;
    });
    sections.push({ type: 'table', title: 'SERP position overlap', columns, rows });
  } else {
    const rows = domains.map((d) => ({
      Competitor: d,
      'Keyword positions': Object.entries(merged[d]).map(([kw, r]) => `${kw} #${r}`).join(', '),
      'Keywords ranked': Object.keys(merged[d]).length,
    }));
    sections.push({ type: 'table', title: 'SERP position overlap', columns: ['Competitor', 'Keyword positions', 'Keywords ranked'], rows });
  }

  // Best-effort AI insights (same monday lambda, action competitor_insights).
  try {
    const summary = domains
      .map((d) => `- ${d}: ${Object.entries(merged[d]).map(([kw, r]) => `"${kw}" #${r}`).join(', ') || 'manually added'}`)
      .join('\n');
    const raw = await postUpstream(UPSTREAMS.strategyEngine, {
      action: 'competitor_insights',
      targetDomain: (body.domain || body.url || '').trim(),
      location, summary, keywords: keywords.join(', '),
    });
    const items = parseInsightsArray(raw).map((it) => {
      const isInsight = String(it.type || '').toLowerCase() === 'insight';
      const prio = String(it.priority || 'medium').toLowerCase();
      return {
        title: it.title || '',
        badge: isInsight ? 'Insight' : (prio === 'high' ? 'High' : prio === 'low' ? 'Low' : 'Medium'),
        badgeTone: isInsight ? 'blue' : (prio === 'high' ? 'red' : prio === 'low' ? 'green' : 'amber'),
        body: it.detail || '',
      };
    });
    if (items.length) sections.push({ type: 'cards', title: '💡 Competitive insights & recommendations', items });
  } catch (e) { console.error('competitor_insights_failed', e.message); }

  return { sections };
}

// Pull a JSON array out of an LLM response that may be fenced/truncated.
function parseInsightsArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.insights)) return raw.insights;
  let txt = typeof raw === 'string' ? raw : (raw?.result || raw?.reply || raw?.text || '');
  if (!txt) return [];
  let clean = String(txt).trim();
  const m = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (m) clean = m[1];
  const fa = clean.indexOf('['), la = clean.lastIndexOf(']');
  if (fa !== -1 && la > fa) clean = clean.slice(fa, la + 1);
  try { const p = JSON.parse(clean); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ── Generic AI recommendations (shared by the data-tool runners) ──────────────
// Turns a findings summary into 3–5 prioritised, actionable recommendation cards
// — the same `cards` section competitors/perf-marketing already render, so the UI
// needs no change. Best-effort: any failure just omits the section and the tool
// still returns its data. The LLM call is folded into the tool's existing cost
// (not charged separately), mirroring competitor_insights.
async function aiRecommendations({ label, context, findings }) {
  if (!findings || !String(findings).trim()) return null;
  try {
    const userPrompt =
      `You are an expert SEO & digital-marketing analyst. Based ONLY on the real "${label}" data below, ` +
      `give 3 to 5 specific, prioritised, actionable recommendations for the user's next steps. ` +
      `Cite the actual numbers/findings; never invent data.\n` +
      (context ? `Context: ${context}\n` : '') +
      `\nData:\n${String(findings).slice(0, 6000)}\n\n` +
      `Output ONLY strict JSON (no markdown fences, no prose): an array of 3-5 objects of shape ` +
      `{"title": string (short imperative action, <=8 words), "priority": "high"|"medium"|"low", ` +
      `"detail": string (1-2 sentences citing the data)}.`;
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    const items = parseInsightsArray(aiText(raw))
      .map((it) => {
        const prio = String(it.priority || 'medium').toLowerCase();
        return {
          title: String(it.title || '').trim(),
          badge: prio === 'high' ? 'High' : prio === 'low' ? 'Low' : 'Medium',
          badgeTone: prio === 'high' ? 'red' : prio === 'low' ? 'green' : 'amber',
          body: String(it.detail || it.body || '').trim(),
        };
      })
      .filter((x) => x.title)
      .slice(0, 5);
    return items.length ? { type: 'cards', title: '💡 Recommendations & next steps', items } : null;
  } catch (e) { console.error('ai_recommendations_failed', label, e.message); return null; }
}

// Append a recommendations card section to a result, preserving rows/sections.
function withRecs(result, recSection) {
  if (!recSection || !result || typeof result !== 'object') return result;
  return { ...result, sections: [...(result.sections || []), recSection] };
}

// Compact a row array into a short "key: value; …" text table for the recommender.
function rowsToFindings(rows, max = 25) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return rows.slice(0, max).map((r) => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join('; ')).join('\n');
}

// Compact a flat summary object into "Key: value" lines (skips empties/objects).
function summaryToFindings(summary) {
  if (!summary || typeof summary !== 'object') return '';
  return Object.entries(summary)
    .filter(([, v]) => v != null && v !== '' && v !== '—' && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

// ── Caption Generator: N diverse variations ───────────────────────────────────
// index.html generates up to 10 variations (rotating variationIndex + rising
// temperature); the SaaS adapter hardcoded a single call. Restore multi-variation
// (capped at 5 to keep the ai_short credit economics sane) + a style sample.
async function captionRun(body) {
  const count = Math.min(Math.max(parseInt(body.count, 10) || 3, 1), 5);
  const base = ADAPTERS.caption.request(body);
  const sampleText = (body.sampleText || '').trim();
  const pick = (raw) => {
    const d = deepBody(raw);
    return typeof d === 'string' ? d : (d?.result || d?.text || d?.content || d?.response || '');
  };
  const variations = await Promise.all(Array.from({ length: count }, (_, i) =>
    postUpstream(UPSTREAMS.aiOptimiser, { ...base, variationIndex: i, sampleText, settings: { temperature: 0.75 + i * 0.02 } })
      .then(pick).catch(() => '')
  ));
  const clean = variations.map((v) => String(v || '').trim()).filter(Boolean);
  if (!clean.length) return { text: 'No caption generated. Please try again.' };
  if (clean.length === 1) return { text: clean[0] };
  return { text: clean.map((v, i) => `━━━ Variation ${i + 1} ━━━\n\n${v}`).join('\n\n\n') };
}

// ── Media Plan: plan + auto-personas + marketing funnel ───────────────────────
// index.html collected ~20 inputs, auto-generated 3 personas when none were
// given, then appended a 5-stage marketing funnel. The SaaS adapter mapped only
// a handful of fields and dropped both the persona + funnel sections. The
// upstream tolerates string inputs, so we skip the contentParsing scrape and
// pass the brief straight through; personas + funnel are best-effort.
async function mediaPlanRun(body) {
  const brief = (body.input || '').trim();
  const personasIn = (body.customerPersonas || '').trim();

  // Auto-generate 3 personas when none provided (mirrors index.html).
  let personaRaw = null, personaHtml = '';
  if (!personasIn) {
    try {
      personaRaw = await postUpstream(UPSTREAMS.personaGenerator, {
        data: brief, manual: (body.manual || '').trim(), existing_personas: [], num_personas: 3,
      });
      const pb = personaRaw?.body ?? personaRaw;
      personaHtml = typeof pb === 'string' ? pb : '';
    } catch (e) { console.error('media_plan_persona_failed', e.message); }
  }

  const data = {
    webpagesInput: brief,
    manualInput: brief,
    budget: (body.budget || '').trim(),
    mediaPlanStartDate: (body.startDate || '').trim(),
    mediaPlanEndDate: (body.endDate || '').trim(),
    organisationalObjectives: (body.objectives || '').trim(),
    mediaPlanLocation: (body.location || 'Singapore').trim(),
    mediaPlanTargetAudience: (body.targetAudience || '').trim(),
    mediaPlanCustomerPersonas: personasIn || personaRaw || '',
    mediaPlanTouchpoints: (body.touchpoints || '').trim(),
    mediaPlanContentStrategy: (body.contentStrategy || '').trim(),
    mediaPlanLandingPages: (body.landingPages || '').trim(),
    mediaPlanCta: (body.cta || '').trim(),
    mediaPlanProductService: (body.productService || '').trim(),
    mediaPlanKpis: (body.kpis || '').trim(),
    mediaPlanCompetitiveAnalysis: (body.competitiveAnalysis || '').trim(),
    mediaPlanCompliance: (body.compliance || '').trim(),
    mediaPlanTechnologyPlan: (body.technologyPlan || '').trim(),
    mediaPlanAnalyticsReporting: (body.analyticsReporting || '').trim(),
    adFormats: parseAdFormats(body.channels),
  };

  const mpRaw = await postUpstream(UPSTREAMS.mediaPlanGenerator, data);
  const mpHtml = typeof mpRaw === 'string' ? mpRaw : (mpRaw?.html || mpRaw?.body || '');

  // Marketing funnel (best-effort): merge persona + plan payloads like index.html.
  let funnelHtml = '';
  try {
    const asObj = (raw, htmlStr) => (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { body: htmlStr };
    const fraw = await postUpstream(UPSTREAMS.generateFunnel, Object.assign({}, asObj(personaRaw, personaHtml), asObj(mpRaw, mpHtml)));
    let f = fraw?.body ?? fraw;
    if (typeof f === 'string') { try { f = JSON.parse(f); } catch { f = null; } }
    if (f && typeof f === 'object') funnelHtml = renderFunnel(f);
  } catch (e) { console.error('media_plan_funnel_failed', e.message); }

  const parts = [mpHtml];
  if (personaHtml) parts.push(`<h3 style="margin-top:18px;font-weight:700">Generated personas</h3><div>${personaHtml}</div>`);
  if (funnelHtml) parts.push(funnelHtml);
  const html = parts.filter(Boolean).join('\n');
  if (!html) return { _failed: true, html: '<p>No media plan was generated — no credits were charged. Please try again.</p>' };
  return { html };
}

// Friendly channel names (tags or comma string) → upstream adFormats flags.
// Empty selection defaults to all-on (matches the prior SaaS behaviour).
function parseAdFormats(channels) {
  const list = Array.isArray(channels) ? channels : String(channels || '').split(/[\n,]+/);
  const set = list.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  if (!set.length) return { googleSearch: true, performanceMax: true, googleDisplay: true, fbIg: true, linkedIn: true, tikTok: true };
  const has = (...keys) => set.some((c) => keys.some((k) => c.includes(k)));
  return {
    googleSearch: has('google search', 'search'),
    performanceMax: has('performance max', 'pmax', 'performance'),
    googleDisplay: has('google display', 'display'),
    fbIg: has('facebook', 'instagram', 'meta', 'fb', 'ig'),
    linkedIn: has('linkedin'),
    tikTok: has('tiktok', 'tik tok'),
  };
}

function renderFunnel(f) {
  const stages = ['Awareness', 'Discovery', 'Consideration', 'Conversion', 'Retention'];
  const cards = stages.map((st) => {
    const raw = f[st];
    const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    if (!items.length) return '';
    return `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px 14px;margin:8px 0">
      <strong style="color:#0f172a">${st}</strong>
      <ul style="margin:6px 0 0;padding-left:18px;color:#475569;font-size:13px">${items.map((i) => `<li>${esc(String(i))}</li>`).join('')}</ul>
    </div>`;
  }).join('');
  return cards ? `<h3 style="margin-top:18px;font-weight:700">Marketing funnel</h3>${cards}` : '';
}

// ── On-Page Optimisation: extract → meta/heading recs + content recs + images ──
// index.html ran 5 sub-analyses; the SaaS adapter shipped only the content
// recommender. Restore the page extraction (getImages) → meta/heading
// recommendations (onPageRecommendations) pipeline alongside the content recs.
async function onpageRun(body) {
  const url = (body.input || body.url || '').trim();
  if (!url) throw new Error('A page URL is required.');
  const keywords = String(body.keywords || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  // 1. Extract page elements (headings, meta, images).
  let extraction = {};
  try { extraction = deepBody(await postUpstream(UPSTREAMS.getImages, { url, keywords })) || {}; }
  catch (e) { console.error('onpage_extract_failed', e.message); }

  // 2. Meta + heading recommendations (strip image_data — Claude token budget;
  //    inject placeholders so missing H1/H2 get a fresh suggestion).
  let recs = {};
  if (keywords.length) {
    try {
      const { image_data, _source, ...dataForRec } = extraction;
      if (dataForRec.headings) {
        for (const lvl of ['h1', 'h2']) {
          if (!dataForRec.headings[lvl]?.length) dataForRec.headings[lvl] = [`[MISSING — suggest a new ${lvl.toUpperCase()} heading based on the content and target keywords]`];
        }
      }
      recs = deepBody(await postUpstream(UPSTREAMS.onPageRecommendations, { data: dataForRec, keywords })) || {};
    } catch (e) { console.error('onpage_recs_failed', e.message); }
  }

  // 3. Content recommendations (the originally-wired endpoint).
  let contentRows = [];
  try {
    const craw = await postUpstream(UPSTREAMS.onPageContentRecommendations, { url, keywords });
    const arr = Array.isArray(craw) ? craw : deepBody(craw);
    contentRows = (Array.isArray(arr) ? arr : []).map((r) => ({
      Element: r.element || r.field || '—', Current: r.current_value ?? '—', Suggested: r.suggested_value ?? '—', Why: r.rationale ?? '',
    }));
  } catch (e) { console.error('onpage_content_failed', e.message); }

  const sections = sectionsOnpage(url, recs, extraction, contentRows);
  if (sections.length <= 1) return { text: 'No on-page recommendations were returned. Check the URL and target keywords.' };
  return { sections };
}

function sectionsOnpage(url, recs, extraction, contentRows) {
  const out = [{ type: 'heading', text: `On-page optimisation — ${url}` }];
  const metaItem = (label, o) => (o && (o.suggested_value || o.current_value))
    ? { Item: label, Current: o.current_value || '—', Suggested: o.suggested_value || '—', Rationale: o.rationale || '' } : null;
  const metaRows = [metaItem('Meta title', recs.meta_title), metaItem('Meta description', recs.meta_description), metaItem('Canonical URL', recs.canonical_url)].filter(Boolean);
  if (metaRows.length) out.push({ type: 'table', title: 'Meta & canonical', columns: ['Item', 'Current', 'Suggested', 'Rationale'], rows: metaRows });

  const headRows = [];
  for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    for (const h of (recs.headings?.[lvl] || [])) {
      if (!h || (!h.suggested_value && !h.current_value)) continue;
      headRows.push({ Level: lvl.toUpperCase(), Current: h.current_value || '—', Suggested: h.suggested_value || '—', Rationale: h.rationale || '' });
    }
  }
  if (headRows.length) out.push({ type: 'table', title: 'Headings (H1–H6)', columns: ['Level', 'Current', 'Suggested', 'Rationale'], rows: headRows });

  // Current alt text per image (AI-suggested alt is a separate vision pass).
  const imgs = (extraction.image_data || [])
    .map((it) => { const src = Object.keys(it)[0]; return { src, alt: it[src] }; })
    .filter((x) => x.src && /^https?:/.test(x.src));
  if (imgs.length) out.push({ type: 'table', title: `Images — alt text (${imgs.length})`, columns: ['Image', 'Current alt'],
    rows: imgs.slice(0, 30).map((x) => ({ Image: x.src.split('/').pop().slice(0, 60), 'Current alt': x.alt || '(missing)' })) });

  if (contentRows.length) out.push({ type: 'table', title: 'Content recommendations', columns: ['Element', 'Current', 'Suggested', 'Why'], rows: contentRows });
  return out;
}

// ── GEO On-Page Optimisation: render geoOnPageAnalysis' structured JSON ────────
// The upstream returns JSON (not HTML), so the pass-through adapter dumped the
// whole object as a text blob. Render the 5-part report + assets as sections.
async function geoOnpageRun(body) {
  const a = ADAPTERS['geo-onpage'];
  const raw = await postUpstream(UPSTREAMS.geoOnPageAnalysis, a.request(body));
  const data = unwrapBody(raw);
  if (!data || typeof data !== 'object') return normalize(raw);
  if (data.error) throw new Error(data.error);
  return { sections: renderGeoOnpage(data, (body.input || body.url || '').trim()) };
}

// Normalise a GEO insight list (items may be strings or { positive, text }) into
// ✓/✗-prefixed strings for a `list` section.
function geoInsightLines(arr) {
  return (arr || []).map((p) => {
    if (p && typeof p === 'object') return `${p.positive === false ? '✗' : '✓'} ${p.text ?? ''}`;
    return `• ${p}`;
  }).filter((s) => s.trim().length > 2);
}

function renderGeoOnpage(data, url) {
  const tone = (s) => (s > 70 ? 'green' : s > 40 ? 'amber' : 'red');
  const sections = [{ type: 'heading', text: `GEO On-Page Optimisation${url ? ` — ${url}` : ''}` }];

  const ve = data.vector_embedding || {};
  const eo = data.entity_optimization || {};
  const cs = data.content_structure || {};
  const il = data.internal_linking || {};
  const cw = data.citation_worthiness || {};
  const overall = data.overall_score || 0;

  sections.push({ type: 'stats', items: [
    { label: 'Overall score', value: `${overall}%`, tone: tone(overall) },
    { label: 'Vector embedding', value: `${ve.score || 0}%`, tone: tone(ve.score || 0) },
    { label: 'Entity optimisation', value: `${eo.score || 0}%`, tone: tone(eo.score || 0) },
    { label: 'Content structure', value: `${cs.score || 0}%`, tone: tone(cs.score || 0) },
    { label: 'Internal linking', value: `${il.score || 0}%`, tone: tone(il.score || 0) },
    { label: 'Citation-worthiness', value: `${cw.score || 0}%`, tone: tone(cw.score || 0) },
  ] });

  // Page metadata: existing vs proposed.
  const pm = data.page_metadata || {};
  const metaRows = [
    { Field: 'Canonical', Existing: pm.existing_canonical_url || '—', Proposed: '—' },
    { Field: 'Meta title', Existing: pm.existing_meta_title || '—', Proposed: data.proposed_meta_title || '—' },
    { Field: 'Meta description', Existing: pm.existing_meta_description || '—', Proposed: data.proposed_meta_description || '—' },
  ];
  sections.push({ type: 'table', title: 'Page metadata', columns: ['Field', 'Existing', 'Proposed'], rows: metaRows });

  // Part 1 — Vector embedding.
  if (Array.isArray(ve.recommended_terms) && ve.recommended_terms.length)
    sections.push({ type: 'list', title: `Recommended terms to include (semantic coverage ${ve.semantic_coverage || 0}%)`, items: ve.recommended_terms });
  if (Array.isArray(ve.topic_clusters) && ve.topic_clusters.length)
    sections.push({ type: 'list', title: 'Topic clusters', items: ve.topic_clusters });
  const veInsights = geoInsightLines([...(ve.strengths || []), ...(ve.missing_elements || []), ...(ve.insights || [])]);
  if (veInsights.length) sections.push({ type: 'list', title: 'Vector embedding notes', items: veInsights });

  // Part 2 — Entity optimisation.
  if (Array.isArray(eo.entities) && eo.entities.length) {
    sections.push({
      type: 'table', title: 'Primary entities',
      columns: ['#', 'Name', 'Type', 'Status'],
      rows: eo.entities.map((e, i) => ({ '#': i + 1, Name: e.name || '—', Type: e.type || '—', Status: e.status === 'found' ? 'Found' : 'Add' })),
    });
  }
  if (Array.isArray(eo.eeat_signals) && eo.eeat_signals.length)
    sections.push({ type: 'list', title: 'E-E-A-T signals', items: eo.eeat_signals.map((s) => `${s.present ? '✓' : '✗'} ${s.signal}`) });
  const eoInsights = geoInsightLines(eo.insights);
  if (eoInsights.length) sections.push({ type: 'list', title: 'Entity notes', items: eoInsights });

  // Part 3 — Content structure & FAQ.
  if (Array.isArray(cs.heading_hierarchy) && cs.heading_hierarchy.length) {
    sections.push({
      type: 'table', title: 'Heading hierarchy',
      columns: ['Level', 'Heading', 'Status'],
      rows: cs.heading_hierarchy.map((h) => ({ Level: h.level || '—', Heading: h.text || '—', Status: h.status === 'found' ? 'Found' : 'Add' })),
    });
  }
  if (Array.isArray(cs.faq_suggestions) && cs.faq_suggestions.length)
    sections.push({ type: 'list', title: 'Suggested FAQ', items: cs.faq_suggestions.map((f) => `Q: ${f.question} — A: ${f.answer_preview || ''}`) });
  const csInsights = geoInsightLines(cs.insights);
  if (csInsights.length) sections.push({ type: 'list', title: 'Content structure notes', items: csInsights });

  // Part 4 — Internal linking.
  if (Array.isArray(il.linking_table) && il.linking_table.length) {
    sections.push({
      type: 'table', title: 'Internal linking plan',
      columns: ['Anchor text', 'Target URL', 'Status'],
      rows: il.linking_table.map((l) => ({ 'Anchor text': l.anchor_text || '—', 'Target URL': l.target_url || '—', Status: l.url_status === 'missing' ? 'Needs creation' : 'OK' })),
    });
  }
  const ilInsights = geoInsightLines(il.insights);
  if (ilInsights.length) sections.push({ type: 'list', title: 'Internal linking notes', items: ilInsights });

  // Part 5 — Citation-worthiness.
  if (Array.isArray(cw.quotable_statements) && cw.quotable_statements.length)
    sections.push({ type: 'list', title: 'Quotable statements to add', items: cw.quotable_statements.map((q) => `“${q.statement}”${q.topic ? ` — ${q.topic}` : ''}`) });
  const cwInsights = geoInsightLines(cw.insights);
  if (cwInsights.length) sections.push({ type: 'list', title: 'Citation-worthiness notes', items: cwInsights });

  // Assets — optimised content + schema markup.
  const optimised = Array.isArray(data.optimized_chunks) && data.optimized_chunks.length
    ? data.optimized_chunks.map((c, i) => `# Chunk ${i + 1}\n${c.optimized || ''}`).join('\n\n')
    : (data.optimized_content || '');
  if (optimised && optimised.trim())
    sections.push({ type: 'code', title: 'Optimised content', filename: 'optimised-content.txt', content: optimised });
  if (data.schema_markup) {
    let sm = data.schema_markup;
    const arr = Array.isArray(sm) ? sm : [sm];
    const jsonLd = arr.length && arr[0] && arr[0].json_ld ? arr.map((x) => x.json_ld) : arr;
    sections.push({ type: 'code', title: 'Schema markup (JSON-LD)', filename: 'schema.jsonld', content: JSON.stringify(jsonLd, null, 2) });
  }

  return sections;
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
  const rec = await aiRecommendations({
    label: 'Technical SEO Crawler',
    context: 'Prioritise the technical SEO fixes that will most improve crawlability and rankings, based on the crawled pages, on-page scores and issue counts.',
    findings: `${summaryToFindings(summary)}\nPages (url; status; on-page score; issue count):\n${rowsToFindings(rows)}`,
  });
  return withRecs({ rows, summary }, rec);
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

// ── Page Technical & Domain Analysis ──────────────────────────────────────────
// The lighter cousin of the forensic audit (index.html's "Domain Analysis"
// section): fan out a focused set of FAST probes — Moz authority, Ahrefs /
// DataForSEO link data, PageSpeed (mobile+desktop), SSL and the on-page HTML —
// then render the agency's "Domain & Page Metrics" card grid. No siteliner crawl
// or GTmetrix long-pole, no scoring/remediation: just the signals, in one view.
async function pageAnalysisRun(body) {
  let target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A website URL is required.');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { throw new Error('Invalid URL format.'); }

  const rootDomain = u.origin;                       // https://www.example.com
  const domain = u.hostname;                         // www.example.com
  const baseDomain = domain.replace(/^www\./, '');   // example.com

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const tryJson = (url, payload, ms) => withTimeout(postUpstream(url, payload), ms).catch(() => null);
  const getHtmlBody = (path, ms) =>
    withTimeout(postUpstream(UPSTREAMS.getHtml, { url: path }), ms)
      .then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : '')))
      .catch(() => '');

  const [siteRes, mozRes, psmRes, psdRes, sslRes, ahrefsRes, homeHtml] = await Promise.all([
    tryJson(UPSTREAMS.forensicSiteData, { url: baseDomain }, 25000),
    tryJson(UPSTREAMS.mozAuthority, { domain: baseDomain }, 25000),
    tryJson(UPSTREAMS.pageSpeed, { url: target }, 55000),
    tryJson(UPSTREAMS.pageSpeed, { url: target, strategy: 'desktop' }, 55000),
    tryJson(UPSTREAMS.sslCheck, { url: domain }, 20000),
    tryJson(UPSTREAMS.ahrefsProxy, { endpoint: 'overview', params: { target: baseDomain } }, 25000),
    getHtmlBody(target, 30000),
  ]);

  // Normalise into a flat shape (mirrors the forensic `d` fields we reuse).
  const d = {
    url: target, da: null, pa: null, backlinks: null, refdomains: null,
    orgkw: null, orgtraffic: null, spam: null, ssl: null, psm: null, psd: null,
    metatitle: '', metadesc: '', h1: null, h2: null, structdata: '', semantic: '', cms: '',
  };

  // 1. DataForSEO site data — title / desc / h1-h2 / schema / spam / links.
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

  // Backlinks / ref domains / organic — prefer Ahrefs, fall back to site data.
  const ah = ahrefsRes?.domain || ahrefsRes || {};
  if (ah.backlinks != null) d.backlinks = Number(ah.backlinks);
  if (ah.referring_domains != null) d.refdomains = Number(ah.referring_domains);
  if (ah.org_keywords != null) d.orgkw = Number(ah.org_keywords);
  if (ah.org_traffic != null) d.orgtraffic = Number(ah.org_traffic);
  const linkSource = (ah.backlinks != null || ah.referring_domains != null)
    ? 'Ahrefs' : (siteRes?.backlinks != null ? 'DataForSEO' : null);

  // 2. Moz Domain / Page Authority.
  if (mozRes?.domain_authority != null) d.da = Number(mozRes.domain_authority);
  if (mozRes?.page_authority != null) d.pa = Number(mozRes.page_authority);

  // 3. PageSpeed (mobile + desktop) — the upstream returns a 0-100 score string.
  const parsePS = (v) => { if (v == null) return null; const n = parseInt(String(v), 10); return Number.isNaN(n) ? null : n; };
  if (psmRes) { const v = parsePS(psmRes.pagespeed); if (v != null) d.psm = v; }
  if (psdRes) { const v = parsePS(psdRes.pagespeed); if (v != null) d.psd = v; }

  // 4. SSL.
  if (sslRes) d.ssl = (sslRes.message && String(sslRes.message).toLowerCase().includes('valid')) ? 'pass' : 'fail';

  // 5. On-page HTML — fills title/desc/h1-h2/schema/semantic/CMS when absent.
  faParseHomeHtml(homeHtml, d);
  const page = pageHtmlStats(homeHtml, domain);

  // ── Build the metric-card grid (mirrors index.html's Domain & Page Metrics) ──
  const dash = '—';
  const num = (v) => (v == null ? dash : Number(v).toLocaleString());
  const daTone = (v) => (v == null ? 'slate' : v >= 50 ? 'green' : v >= 30 ? 'amber' : 'red');
  const psTone = (v) => (v == null ? 'slate' : v >= 90 ? 'green' : v >= 50 ? 'amber' : 'red');
  const sslTone = d.ssl === 'pass' ? 'green' : d.ssl === 'fail' ? 'red' : 'slate';
  const spamTone = d.spam == null ? 'slate' : d.spam > 30 ? 'red' : d.spam > 15 ? 'amber' : 'green';
  const readTone = page.readability == null ? 'slate' : page.readability >= 60 ? 'green' : page.readability >= 30 ? 'amber' : 'red';

  const authority = [
    { label: 'Domain Authority', value: d.da ?? dash, tone: daTone(d.da) },
    { label: 'Page Authority', value: d.pa ?? dash, tone: daTone(d.pa) },
    { label: 'Backlinks', value: num(d.backlinks) + (linkSource ? ` · ${linkSource}` : ''), tone: 'slate' },
    { label: 'Referring domains', value: num(d.refdomains), tone: 'slate' },
    { label: 'Organic traffic', value: d.orgtraffic == null ? dash : `${num(d.orgtraffic)}/mo`, tone: 'slate' },
    { label: 'Organic keywords', value: num(d.orgkw), tone: 'slate' },
    { label: 'Spam score', value: d.spam == null ? dash : `${d.spam}%`, tone: spamTone },
  ];

  const technical = [
    { label: 'SSL', value: d.ssl === 'pass' ? 'Valid' : d.ssl === 'fail' ? 'Invalid' : dash, tone: sslTone },
    { label: 'PageSpeed (mobile)', value: d.psm ?? dash, tone: psTone(d.psm) },
    { label: 'PageSpeed (desktop)', value: d.psd ?? dash, tone: psTone(d.psd) },
    { label: 'Structured data', value: d.structdata || dash, tone: d.structdata === 'Yes' ? 'green' : d.structdata === 'No' ? 'red' : 'slate' },
    { label: 'Semantic HTML', value: d.semantic || dash, tone: d.semantic === 'Yes' ? 'green' : d.semantic ? 'red' : 'slate' },
    { label: 'Word count', value: num(page.words), tone: page.words == null ? 'slate' : page.words >= 1000 ? 'green' : 'amber' },
    { label: 'Readability', value: page.readability == null ? dash : String(page.readability), tone: readTone },
    { label: 'H1 / H2', value: (d.h1 == null && d.h2 == null) ? dash : `${d.h1 ?? 0} / ${d.h2 ?? 0}`, tone: d.h1 == null ? 'slate' : d.h1 === 1 ? 'green' : 'amber' },
    { label: 'Internal links', value: num(page.internal), tone: 'slate' },
    { label: 'External links', value: num(page.external), tone: 'slate' },
    { label: 'Images', value: num(page.images), tone: 'slate' },
    { label: 'CMS', value: d.cms || dash, tone: 'slate' },
  ];

  const sections = [
    { type: 'heading', text: `Page Technical & Domain Analysis — ${d.url}` },
    { type: 'stats', title: 'Domain authority & links', items: authority },
    { type: 'stats', title: 'Page technical signals', items: technical },
  ];
  if (d.metatitle || d.metadesc) {
    sections.push({ type: 'table', title: 'Page metadata', columns: ['Field', 'Value'], rows: [
      { Field: 'Title', Value: d.metatitle || dash },
      { Field: 'Meta description', Value: d.metadesc || dash },
    ] });
  }

  const summary = {
    domainAuthority: d.da, pageAuthority: d.pa, backlinks: d.backlinks,
    referringDomains: d.refdomains, spamScore: d.spam, organicKeywords: d.orgkw,
    organicTraffic: d.orgtraffic, pageSpeedMobile: d.psm, pageSpeedDesktop: d.psd,
    ssl: d.ssl, wordCount: page.words,
  };

  // Every probe failed → non-billable soft failure (spec §6.2/6.4), never charge.
  const gotData = d.da != null || d.backlinks != null || d.psm != null || d.psd != null || page.words != null;
  if (!gotData) return { _failed: true, text: 'Could not retrieve metrics for this URL — no credits were charged. Please check the URL and try again.' };

  const rec = await aiRecommendations({
    label: 'Page Technical & Domain Analysis',
    context: 'Advise on the most impactful technical SEO & authority improvements (page speed, SSL, on-page signals, backlinks/authority) based on these signals.',
    findings: summaryToFindings(summary),
  });
  return withRecs({ sections, summary }, rec);
}

/** Word count, Flesch readability, link + image counts from a page's HTML. */
function pageHtmlStats(html, host) {
  const empty = { words: null, readability: null, internal: null, external: null, images: null };
  if (!html || html.length < 200) return empty;
  const text = faStripHtml(html);
  const words = (text.match(/\b[\w’']+\b/g) || []).length;
  if (!words) return empty;
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
  const syllables = faEstimateSyllables(text);
  // Flesch Reading Ease, clamped to the 0-100 display range.
  const flesch = 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
  const readability = Math.max(0, Math.min(100, Math.round(flesch)));

  const baseHost = host.replace(/^www\./, '');
  let internal = 0, external = 0;
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"']+)["']/gi)) {
    const href = m[1];
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    if (/^https?:\/\//i.test(href)) {
      try { (new URL(href).hostname.replace(/^www\./, '') === baseHost ? internal++ : external++); } catch { /* skip */ }
    } else internal++; // relative path
  }
  const images = (html.match(/<img[\s>]/gi) || []).length;
  return { words, readability, internal, external, images };
}

/** Rough English syllable count for Flesch (samples up to 4k words). */
function faEstimateSyllables(text) {
  const words = (text.toLowerCase().match(/[a-z]+/g) || []).slice(0, 4000);
  let total = 0;
  for (const w of words) {
    const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').match(/[aeiouy]{1,2}/g);
    total += Math.max(1, groups ? groups.length : 1);
  }
  return total || 1;
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

  let [homeHtml, robotsBody, llmsBody, llmsFullBody] = await Promise.all([
    getBody(rootDomain, 25000),
    getBody(rootDomain + '/robots.txt', 12000),
    getBody(rootDomain + '/llms.txt', 10000),
    getBody(rootDomain + '/llms-full.txt', 10000),
  ]);
  // The homepage gates the whole tool. The getHtml upstream's headless renderer
  // can time out or return a challenge page for slow WP/CDN sites, so fall back
  // to a direct fetch before giving up — many "unreachable" sites respond fine.
  if (!homeHtml || homeHtml.length < 200) {
    homeHtml = await directFetchHtml(rootDomain, 12000);
  }
  if (!homeHtml || homeHtml.length < 200) {
    // Soft-fail (not a 500): the site bot-blocks the fetcher or is unreachable.
    // Surface the actionable reason and charge nothing — mirrors aiDiscoveryRun.
    return { _failed: true, sections: [{ type: 'callout', text: `Could not fetch ${rootDomain} to read the homepage. Check the URL is public and reachable — no credits were charged.` }] };
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

// ── GEO/AI readiness + finding categorisation (report depth) ──────────────────
const FA_CAT_ORDER = ['Security & Trust', 'Performance', 'Crawlability & Indexing', 'On-Page SEO', 'Content Quality', 'Structured Data & GEO', 'Authority & Backlinks', 'Analytics & Access', 'CMS & Plugins', 'Other'];
const FA_IMPACT = {
  'Security & Trust': 'Browsers flag insecure sites and Google demotes them — it erodes visitor trust.',
  'Performance': 'Slow pages raise bounce rate and drag down Core Web Vitals rankings.',
  'Crawlability & Indexing': 'If Google can’t crawl or index a page, it can’t rank at all.',
  'On-Page SEO': 'Weak titles, tags and headings cut click-through and topical clarity.',
  'Content Quality': 'Duplicate content splits ranking signals and can suppress pages.',
  'Structured Data & GEO': 'Limits how AI assistants and rich results understand and cite your site.',
  'Authority & Backlinks': 'Toxic links risk penalties; low authority caps ranking potential.',
  'Analytics & Access': 'Without data and access you can’t measure or act on performance.',
  'CMS & Plugins': 'Missing SEO/security tooling leaves optimisation and protection gaps.',
  'Other': 'General site-health factors.',
};
function faCategoryFor(r) {
  const e = (r.error || '').toLowerCase();
  if (/ssl|https/.test(e)) return 'Security & Trust';
  if (/page speed|gtmetrix|cdn|web vital/.test(e)) return 'Performance';
  if (/robots|sitemap|404|uptime|multiple slash|broken link/.test(e)) return 'Crawlability & Indexing';
  if (/meta title|meta description|duplicate title|duplicate meta|unoptimised meta|canonical|hreflang|h1 tag/.test(e)) return 'On-Page SEO';
  if (/duplicate content/.test(e)) return 'Content Quality';
  if (/structured data|llm bots|llms\.txt|llms-full|semantic/.test(e)) return 'Structured Data & GEO';
  if (/spam score|backlink|disavow/.test(e)) return 'Authority & Backlinks';
  if (/ga4|analytics 4|search console/.test(e)) return 'Analytics & Access';
  if (/plugin|rank math|wordfence/.test(e)) return 'CMS & Plugins';
  return 'Other';
}
// AI-visibility sub-score from the GEO signals the audit already gathered.
function faGeoReadiness(d) {
  const factors = [
    { label: 'llms.txt present', ok: d.llmstxt === 'Present', weight: 20, note: d.llmstxt === 'Present' ? 'AI crawlers have a curated map of your key content.' : 'Add llms.txt so AI assistants can find and cite your important pages.' },
    { label: 'llms-full.txt present', ok: d.llmsfull === 'Present', weight: 15, note: d.llmsfull === 'Present' ? 'Full-content file is available for AI ingestion.' : 'Add llms-full.txt with your full content for deeper AI grounding.' },
    { label: 'AI bots allowed', ok: d.llmblock !== 'Yes', weight: 25, note: d.llmblock === 'Yes' ? 'robots.txt blocks AI bots (GPTBot, ClaudeBot, etc.) — they cannot read your site.' : 'AI crawlers are not blocked in robots.txt.' },
    { label: 'Structured data', ok: d.structdata === 'Yes', weight: 20, note: d.structdata === 'Yes' ? 'Schema helps AI and rich results parse your pages.' : 'Add schema markup so AI and rich results can understand your pages.' },
    { label: 'Semantic HTML', ok: d.semantic === 'Yes', partial: d.semantic === 'Partial', weight: 20, note: d.semantic === 'Yes' ? 'Clean semantic structure aids machine parsing.' : d.semantic === 'Partial' ? 'Partly semantic — tighten heading/landmark structure for AI parsing.' : 'Non-semantic markup is hard for AI to parse; adopt semantic HTML5.' },
  ];
  let score = 0;
  for (const f of factors) score += f.ok ? f.weight : (f.partial ? f.weight / 2 : 0);
  score = Math.round(score);
  return { score, tone: score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red', factors };
}

/** Build the themed `sections` report for the forensic audit. */
function faSections(d, recs, score, sevCounts, backlinksSource) {
  const dash = '—';
  const scoreTone = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
  const num = (v) => (v == null ? dash : Number(v).toLocaleString());
  const sevBadge = { critical: 'red', warning: 'amber', opportunity: 'blue' };

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
  const geo = faGeoReadiness(d);

  const metrics = [
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
  ];

  const sections = [
    { type: 'heading', text: `GEO+SEO Forensic Audit — ${d.url}` },
    { type: 'stats', items: [
      { label: 'Health score', value: `${score}/100`, tone: scoreTone },
      { label: 'Critical', value: sevCounts.critical, tone: sevCounts.critical ? 'red' : 'green' },
      { label: 'Warning', value: sevCounts.warning, tone: sevCounts.warning ? 'amber' : 'green' },
      { label: 'Opportunity', value: sevCounts.opportunity, tone: sevCounts.opportunity ? 'blue' : 'green' },
      { label: 'Total issues', value: recs.length, tone: recs.length === 0 ? 'green' : recs.length < 5 ? 'amber' : 'red' },
    ] },
    { type: 'heading', text: 'AI Visibility (GEO) readiness' },
    { type: 'stats', items: [{ label: 'GEO readiness', value: `${geo.score}/100`, tone: geo.tone }] },
    { type: 'cards', note: 'How ready your site is to be read and cited by AI assistants (ChatGPT, Perplexity, Google AI Overviews).', items: geo.factors.map((g) => ({ title: g.label, badge: g.ok ? 'Ready' : g.partial ? 'Partial' : 'Gap', badgeTone: g.ok ? 'green' : g.partial ? 'amber' : 'red', body: g.note })) },
  ];

  if (recs.length) {
    sections.push({ type: 'heading', text: `Prioritised findings — ${recs.length} ${recs.length === 1 ? 'issue' : 'issues'}` });
    for (const cat of FA_CAT_ORDER) {
      const items = recs.filter((r) => faCategoryFor(r) === cat);
      if (!items.length) continue;
      sections.push({ type: 'cards', title: `${cat} · ${items.length}`, note: FA_IMPACT[cat], items: items.map((r) => ({ title: r.error, badge: FA_SEV_LABEL[r.severity], badgeTone: sevBadge[r.severity], body: r.action })) });
    }
  } else {
    sections.push({ type: 'callout', text: 'No issues detected across the audited factors. 🎉' });
  }

  sections.push({ type: 'stats', title: 'All measured signals', items: metrics });
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
  // GSC sub-tools (URL Inspection / Sitemaps / Indexing) — dispatched by gscOp.
  if (tool.integration === 'gsc' && body.gscOp && body.gscOp !== 'insights') return gscOpsRun(body, conn);
  const live = await fetchIntegrationFor(tool.integration, conn, { ...body, input: body.input || conn.account });
  // No seeded fallback: if the live pull didn't return data, prompt a reconnect.
  if (!live?.rows) {
    return { needsConnect: tool.integration, text: `We couldn’t pull live ${tool.name} data — reconnect your account under Integrations to continue.` };
  }
  // Summary cards + trend chart render above the (sortable) breakdown table -
  // the dashboard layout index.html uses, not a bare table.
  const out = {
    sections: integrationSections(tool.integration, live.summary || {}, live.series || [], live.deltas, body.compare, live.striking),
    rows: live.rows, summary: live.summary, source: live.source,
  };
  // GA4 / Google Ads return raw metrics — add an AI "what to do next" pass over
  // the real numbers. (GSC already surfaces striking-distance easy-wins.)
  if (tool.integration === 'ga4' || tool.integration === 'google-ads') {
    const label = tool.integration === 'ga4' ? 'Google Analytics (GA4)' : 'Google Ads';
    const ctx = tool.integration === 'ga4'
      ? 'Advise on traffic quality, channel mix, engagement and conversion improvements from this GA4 data.'
      : 'Advise on budget reallocation, low-converting / high-CPA campaigns, and optimisation opportunities from this Google Ads data.';
    const rec = await aiRecommendations({
      label, context: `${ctx} Date range: ${body.range || 'Last 28 days'}.`,
      findings: `${summaryToFindings(live.summary)}\nBreakdown rows:\n${rowsToFindings(live.rows)}`,
    });
    return withRecs(out, rec);
  }
  return out;
}

// Dispatch + format the GSC sub-tools. integration_pull cost is 0, so these are
// free like the main pull. Destructive ops (indexing removal, sitemap delete)
// are gated by a client-side confirm before they reach here.
async function gscOpsRun(body, conn) {
  try {
    if (body.gscOp === 'inspect') {
      const { rows, count } = await gscInspect(conn, body);
      const indexed = rows.filter((r) => /indexed/i.test(r.coverage) && !/not\s+indexed/i.test(r.coverage)).length;
      return { sections: [{ type: 'stats', items: [{ label: 'URLs checked', value: String(count) }, { label: 'Indexed', value: String(indexed) }] }], rows };
    }
    if (body.gscOp === 'sitemaps') {
      const action = String(body.sitemapAction || 'list').toLowerCase();
      const res = await gscSitemaps(conn, body);
      if (action !== 'list') return { sections: [{ type: 'callout', text: `Sitemap ${action === 'submit' ? 'submitted' : 'deleted'}: ${res.feed}` }] };
      if (!res.rows.length) return { sections: [{ type: 'text', text: 'No sitemaps submitted for this property yet.' }], rows: [] };
      return { sections: [{ type: 'heading', text: 'Submitted sitemaps' }], rows: res.rows };
    }
    if (body.gscOp === 'indexing') {
      const { rows, type } = await gscIndexing(conn, body);
      const ok = rows.filter((r) => !/error/i.test(r.status)).length;
      return { sections: [{ type: 'callout', text: `${type === 'URL_DELETED' ? 'Removal' : 'Indexing'} requested for ${ok}/${rows.length} URL${rows.length > 1 ? 's' : ''}.` }], rows };
    }
    return { text: 'Unknown Search Console operation.' };
  } catch (e) {
    return { sections: [{ type: 'callout', text: `\u26a0 ${e.message}` }] };
  }
}

// Build the stat-card + trend-chart sections for an integration pull. The
// breakdown stays a top-level `rows` table (sortable, formatted) so it isn't
// rendered twice. Chart is omitted when no day-series came back.
function integrationSections(provider, summary, series, deltas, compareRaw, striking) {
  const num = (v) => (v == null ? '\u2014' : Number(v).toLocaleString());
  const d = deltas || {};
  // value + optional period-over-period delta chip. dir: 'up' = good-when-up,
  // 'down' = good-when-down (position/CPA), 'neutral' = no good/bad colour.
  const stat = (label, value, deltaPct, dir = 'up') => {
    const item = { label, value: value ?? '\u2014' };
    if (deltaPct != null && Number.isFinite(deltaPct)) {
      item.delta = `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%`;
      if (dir === 'neutral' || Math.abs(deltaPct) < 0.05) item.deltaTone = 'slate';
      else item.deltaTone = (dir === 'up' ? deltaPct > 0 : deltaPct < 0) ? 'green' : 'red';
    }
    return item;
  };
  const sections = [];
  if (provider === 'gsc') {
    sections.push({ type: 'stats', items: [stat('Clicks', num(summary.clicks), d.clicks), stat('Impressions', num(summary.impressions), d.impressions), stat('CTR', summary.ctr, d.ctr), stat('Avg position', summary.avgPosition, d.position, 'down')] });
    pushTrend(sections, 'Clicks & impressions over time', series, [{ key: 'clicks', label: 'Clicks', color: '#2563eb' }, { key: 'impressions', label: 'Impressions', color: '#a855f7' }]);
    if (Array.isArray(striking) && striking.length) sections.push({ type: 'table', title: 'Striking distance \u2014 page-2 easy wins', columns: ['query', 'clicks', 'impressions', 'ctr', 'position'], rows: striking });
  } else if (provider === 'ga4') {
    sections.push({ type: 'stats', items: [stat('Sessions', num(summary.sessions), d.sessions), stat('Users', num(summary.users), d.users), stat('Engaged', num(summary.engagedSessions), d.engagedSessions), stat('Conversions', num(summary.conversions), d.conversions)] });
    pushTrend(sections, 'Sessions & users over time', series, [{ key: 'sessions', label: 'Sessions', color: '#2563eb' }, { key: 'users', label: 'Users', color: '#10b981' }]);
  } else if (provider === 'google-ads') {
    sections.push({ type: 'stats', items: [stat('Cost', summary.cost, d.cost, 'neutral'), stat('Clicks', num(summary.clicks), d.clicks), stat('Conversions', num(summary.conversions), d.conversions), stat('CPA', summary.cpa, d.cpa, 'down')] });
    pushTrend(sections, 'Cost & clicks over time', series, [{ key: 'cost', label: 'Cost (S$)', color: '#2563eb' }, { key: 'clicks', label: 'Clicks', color: '#f59e0b' }]);
  } else if (provider === 'meta-ads' || provider === 'linkedin-ads') {
    // Meta / LinkedIn share the Ads stat shape; their day-series key is `spend`.
    const accent = provider === 'meta-ads' ? '#1877f2' : '#0a66c2';
    sections.push({ type: 'stats', items: [stat('Spend', summary.cost, d.spend, 'neutral'), stat('Clicks', num(summary.clicks), d.clicks), stat('Conversions', num(summary.conversions), d.conversions), stat('CPA', summary.cpa, d.cpa, 'down')] });
    pushTrend(sections, 'Spend & clicks over time', series, [{ key: 'spend', label: 'Spend', color: accent }, { key: 'clicks', label: 'Clicks', color: '#f59e0b' }]);
  }
  if (deltas) {
    const lbl = /year/i.test(String(compareRaw || '')) ? 'the same period last year' : 'the previous period';
    sections.unshift({ type: 'text', text: `Deltas shown vs ${lbl}.` });
  }
  return sections;
}

// Turn a day-series into a multi-line `chart` section; drop all-zero series.
function pushTrend(sections, title, series, defs) {
  if (!Array.isArray(series) || !series.length) return;
  const built = defs
    .map((d) => ({ label: d.label, color: d.color, points: series.map((p) => ({ date: p.date, value: Number(p[d.key]) || 0 })) }))
    .filter((s) => s.points.some((p) => p.value > 0));
  if (built.length) sections.push({ type: 'chart', title, series: built });
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

  const [summaryRes, refRes, anchorRes, listRes, brokenRes, histRes] = await Promise.all([
    post('backlinks_summary').catch(() => null),
    post('referring_domains', { limit: 100 }).catch(() => null),
    post('anchors', { limit: 100 }).catch(() => null),
    post('backlinks_list', { limit: 100 }).catch(() => null),
    post('broken_backlinks', { limit: 100, offset: 0 }).catch(() => null),
    post('backlinks_history').catch(() => null),
  ]);

  const s = result0(summaryRes) || {};
  const refDomains = (result0(refRes)?.items || []).slice(0, 50);
  const anchors = (result0(anchorRes)?.items || []).slice(0, 50);
  const backlinks = (result0(listRes)?.items || []).slice(0, 50);
  const brokenResult = result0(brokenRes) || {};
  const broken = (brokenResult.items || []).slice(0, 50);
  const brokenTotal = brokenResult.total_count ?? broken.length;
  const history = (result0(histRes)?.items || [])
    .filter((it) => it && it.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const summary = {
    backlinks: s.backlinks ?? null,
    referringDomains: s.referring_domains ?? null,
    domainRank: s.rank ?? null,
    spamScore: s.backlinks_spam_score ?? null,
    brokenBacklinks: s.broken_backlinks ?? null,
    referringIps: s.referring_ips ?? null,
    types: s.referring_links_types || null,
    attributes: s.referring_links_attributes || null,
    countries: s.referring_links_countries || null,
    platforms: s.referring_links_platform_types || null,
    tld: s.referring_links_tld || null,
  };
  if (summary.backlinks == null && !refDomains.length && !anchors.length && !backlinks.length) {
    return { text: 'No backlinks data was returned for this target. Check the domain and analysis scope.' };
  }
  const out = { sections: sectionsBacklinks(target, mode, summary, refDomains, anchors, backlinks, broken, brokenTotal, history), summary };
  const rec = await aiRecommendations({
    label: 'Backlinks Explorer',
    context: `Target: ${target} (${mode}). Advise on link-building priorities, disavowing toxic/spammy links, recovering broken backlinks, and anchor-text diversity.`,
    findings: summaryToFindings(summary) +
      (brokenTotal ? `\nbrokenBacklinksTotal: ${brokenTotal}` : '') +
      (refDomains.length ? `\nTop referring domains: ${refDomains.slice(0, 10).map((d) => d.domain || d.referring_domain || d.Domain).filter(Boolean).join(', ')}` : ''),
  });
  return withRecs(out, rec);
}

function sectionsBacklinks(target, mode, s, refDomains, anchors, backlinks = [], broken = [], brokenTotal = 0, history = []) {
  const n = (v) => (v == null ? '—' : Number(v).toLocaleString());
  const isNofollow = (a) => a && (a.nofollow || a.sponsored || a.ugc);
  const shortUrl = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');
  // Top-6 breakdown of a DataForSEO {key: count} map → a list section.
  const breakdown = (title, obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const items = Object.entries(obj).filter(([k]) => k !== '').sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => `${k}: ${Number(v).toLocaleString()}`);
    return items.length ? { type: 'list', title, items } : null;
  };
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
  for (const sec of [
    breakdown('Link types', s.types),
    breakdown('Link attributes', s.attributes),
    breakdown('Top countries', s.countries),
    breakdown('Platform types', s.platforms),
    breakdown('TLD distribution', s.tld),
  ]) if (sec) out.push(sec);

  if (refDomains.length) out.push({ type: 'table', title: `Top referring domains (${refDomains.length})`, columns: ['Domain', 'Rank', 'Backlinks', 'First seen', 'Type'],
    rows: refDomains.map((d) => ({ Domain: d.domain, Rank: d.rank ?? '—', Backlinks: n(d.backlinks), 'First seen': String(d.first_seen || '').slice(0, 10) || '—', Type: isNofollow(d.referring_links_attributes) ? 'nofollow' : 'dofollow' })) });
  if (anchors.length) out.push({ type: 'table', title: `Top anchors (${anchors.length})`, columns: ['Anchor', 'Backlinks', 'Ref. domains', 'First seen'],
    rows: anchors.map((a) => ({ Anchor: a.anchor || '(image / no text)', Backlinks: n(a.backlinks), 'Ref. domains': n(a.referring_domains), 'First seen': String(a.first_seen || '').slice(0, 10) || '—' })) });
  if (backlinks.length) out.push({ type: 'table', title: `Backlinks (${backlinks.length})`, columns: ['From', 'Anchor', 'To', 'Follow', 'Rank'],
    rows: backlinks.map((b) => ({ From: shortUrl(b.url_from), Anchor: b.anchor || '(no text)', To: shortUrl(b.url_to), Follow: b.dofollow ? 'dofollow' : 'nofollow', Rank: b.rank ?? '—' })) });
  if (broken.length) out.push({ type: 'table', title: `Broken backlinks${brokenTotal ? ` — ${Number(brokenTotal).toLocaleString()} total` : ''}`, columns: ['From', 'To', 'Status', 'Rank'],
    rows: broken.map((b) => ({ From: shortUrl(b.url_from), To: shortUrl(b.url_to), Status: b.url_to_status_code ?? '—', Rank: b.rank ?? '—' })) });
  if (history.length) out.push({ type: 'table', title: 'Backlink history (monthly)', columns: ['Month', 'Backlinks', 'Ref. domains', 'New', 'Lost', 'Broken'],
    rows: history.slice(-16).map((h) => ({ Month: String(h.date).slice(0, 7), Backlinks: n(h.backlinks), 'Ref. domains': n(h.referring_domains), New: h.new_backlinks != null ? `+${n(h.new_backlinks)}` : '—', Lost: h.lost_backlinks != null ? `−${n(h.lost_backlinks)}` : '—', Broken: n(h.broken_backlinks) })) });
  return out;
}

// ── AI Discovery / AI Mentions: multi-LLM visibility check ─────────────────────
// derive prompts (keywordsForSite → discovery_prompts, else brand fallback) →
// verify_mentions per prompt × model → poll Bright Data snapshots → summarise.
const AI_MODELS = ['gpt-4o-mini', 'claude-haiku-4-5', 'perplexity'];
const AI_MODEL_LABEL = { 'gpt-4o-mini': 'GPT-4o', 'claude-haiku-4-5': 'Claude', perplexity: 'Perplexity' };

// ── AI Discovery Audit: technical GEO-readiness ───────────────────────────────
// index.html's runDiscoveryAudit was a technical audit (gauge + ~25 checks), but
// the SaaS wired ai-discovery to the *mentions* engine, duplicating ai-mentions.
// Re-frame it as a focused GEO-readiness audit, reusing the forensic HTML/robots
// parsers (no heavy SEO-perf probes — those belong to forensic-audit).
async function aiDiscoveryRun(body) {
  let target = (body.url || body.input || '').trim();
  if (!target) throw new Error('A website URL is required.');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { throw new Error('Invalid URL format.'); }
  const root = u.origin;

  const getHtmlBody = (path, ms) =>
    Promise.race([postUpstream(UPSTREAMS.getHtml, { url: path }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))])
      .then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : '')))
      .catch(() => '');

  let [homeHtml, robotsBody, llmsBody, llmsFullBody] = await Promise.all([
    getHtmlBody(root, 25000),
    getHtmlBody(root + '/robots.txt', 15000),
    getHtmlBody(root + '/llms.txt', 12000),
    getHtmlBody(root + '/llms-full.txt', 12000),
  ]);
  // The getHtml upstream's headless renderer can time out or return a challenge
  // page for slow/bot-protected sites; fall back to a direct fetch so reachable
  // sites aren't falsely reported unreachable (mirrors llmsTxtRun).
  if (!homeHtml || homeHtml.length < 200) {
    homeHtml = await directFetchHtml(root, 12000);
  }
  if (!homeHtml || homeHtml.length < 200) {
    // §6.3: graceful failure must not be billed.
    return { _failed: true, sections: [{ type: 'callout', text: 'Could not fetch the homepage to assess AI discoverability. Check the URL — no credits were charged.' }] };
  }

  const d = {};
  faParseHomeHtml(homeHtml, d);
  faParseRobots(robotsBody, d);
  const llmstxt = faValidTxt(llmsBody);
  const llmsfull = faValidTxt(llmsFullBody);

  const checks = [
    { factor: 'llms.txt file', pass: llmstxt, fix: 'Create an llms.txt so AI assistants can index your key pages (use the llms.txt Generator).' },
    { factor: 'llms-full.txt file', pass: llmsfull, fix: 'Add an llms-full.txt with expanded page content for richer AI context.' },
    { factor: 'AI crawlers allowed', pass: d.llmblock !== 'Yes', fix: 'robots.txt blocks AI bots (GPTBot/ClaudeBot/etc.) — unblock them so you can be cited.' },
    { factor: 'Structured data (JSON-LD)', pass: d.structdata === 'Yes', fix: 'Add JSON-LD schema (Organization/Product/FAQ) so AI tools can parse your entities.' },
    { factor: 'Semantic HTML', pass: d.semantic === 'Yes', fix: 'Use semantic landmarks (header/main/nav/footer) so AI can structure your content.' },
    { factor: 'Meta title', pass: !!d.metatitle, fix: 'Add a descriptive <title> — AI answers often quote it.' },
    { factor: 'Meta description', pass: !!d.metadesc, fix: 'Add a meta description summarising the page for AI snippets.' },
    { factor: 'H1 heading', pass: d.h1 > 0, fix: 'Add a single clear H1 stating the page topic.' },
    { factor: 'robots.txt present', pass: d.robots === 'Pass', fix: 'Add a robots.txt with your sitemap so crawlers (incl. AI) discover pages.' },
  ];
  const passed = checks.filter((c) => c.pass).length;
  const score = Math.round((passed / checks.length) * 100);
  const tone = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
  const fails = checks.filter((c) => !c.pass);

  const sections = [
    { type: 'heading', text: `AI Discovery audit — ${u.hostname}` },
    { type: 'stats', items: [
      { label: 'GEO readiness', value: `${score}%`, tone },
      { label: 'Checks passed', value: `${passed}/${checks.length}`, tone: passed === checks.length ? 'green' : 'amber' },
      { label: 'llms.txt', value: llmstxt ? 'Present' : 'Missing', tone: llmstxt ? 'green' : 'red' },
      { label: 'AI bots', value: d.llmblock === 'Yes' ? 'Blocked' : 'Allowed', tone: d.llmblock === 'Yes' ? 'red' : 'green' },
      { label: 'Structured data', value: d.structdata === 'Yes' ? 'Yes' : 'No', tone: d.structdata === 'Yes' ? 'green' : 'red' },
      { label: 'CMS', value: d.cms || '—', tone: 'slate' },
    ] },
    { type: 'table', title: 'Discoverability checklist', columns: ['Factor', 'Status'],
      rows: checks.map((c) => ({ Factor: c.factor, Status: c.pass ? '✓ Pass' : '✗ Fix' })) },
  ];
  if (fails.length) sections.push({ type: 'list', title: '🎯 Prioritised fixes', items: fails.map((c) => `${c.factor}: ${c.fix}`) });
  else sections.push({ type: 'callout', text: 'Your site covers the core AI-discoverability factors. 🎉' });
  // `summary` feeds the Performance tracker (GEO readiness over time).
  return { sections, summary: { geoReadiness: score, checksPassed: passed, checksTotal: checks.length } };
}

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
  const rec = await aiRecommendations({
    label: 'AI Mentions Tracker',
    context: `Brand: ${brand}. Overall mention rate ${summary.mentionRate} across ${AI_MODELS.length} AI models. Advise how to raise mention frequency on the weak prompts/models (content, structured data, citations, llms.txt, authority).`,
    findings: `Mention rate: ${summary.mentionRate}\nPer-prompt results (✓ = mentioned, score; ✗ = not mentioned):\n${rowsToFindings(rows)}`,
  });
  return withRecs({ rows, summary }, rec);
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

  // Recommend which keywords to prioritise (volume vs difficulty, intent, likely
  // time-to-rank), content angles and quick wins — from the real rows.
  const kaRecs = (rows) => aiRecommendations({
    label: 'Keyword Analysis',
    context: `Mode: ${mode}; Location: ${location}; Language: ${language}. Advise which keywords to prioritise (weigh search volume against difficulty and likely time-to-rank), the search intent to target, content angles, and quick wins.`,
    findings: rowsToFindings(rows),
  });

  // Where to assess time-to-rank from: an explicit domain (metrics/similar modes)
  // or the target the ranking/webpage modes already carry. When present we add a
  // per-keyword `timeToRank` column (parity with index.html's keyword analysis,
  // which folds time-to-rank into the same flow). Heavier: 2 upstream calls per
  // keyword (capped), so it's opt-in via the domain field.
  let map, cols;
  if (/similar/i.test(mode)) {
    const keywords = splitItems(body.input).slice(0, 25);
    if (!keywords.length) throw new Error('Add at least one seed keyword.');
    map = deepBody(await postUpstream(UPSTREAMS.similarKeywords, { keywords, location, language, user }));
    cols = ['volume', 'cpc', 'competition'];
  } else if (/ranking/i.test(mode)) {
    const target = cleanDomain(body.target || body.input);
    if (!target) throw new Error('A domain is required.');
    map = deepBody(await postUpstream(UPSTREAMS.rankingKeywords, { target, location, user }));
    cols = ['volume', 'rank', 'difficulty', 'traffic', 'url'];
  } else if (/webpage/i.test(mode)) {
    const target = (body.target || body.input || '').trim();
    if (!target) throw new Error('A page URL is required.');
    map = deepBody(await postUpstream(UPSTREAMS.keywordsForSite, { location, language, target, skip_ai: false }));
    cols = ['volume', 'competition', 'intent', 'reason'];
  } else {
    // Default: keyword metrics (mangoolsKeywords → volume + cpc only; no KD).
    const keywords = splitItems(body.input).slice(0, 25);
    if (!keywords.length) throw new Error('Add at least one keyword.');
    map = deepBody(await postUpstream(UPSTREAMS.mangoolsKeywords, { keywords, location, language }));
    cols = ['volume', 'cpc'];
  }

  // An upstream Lambda error envelope ({errorType,errorMessage}) must not be
  // rendered as keyword rows (it would surface "errorMessage" as a keyword and
  // still bill). Soft-fail so nothing is charged.
  if (!map || typeof map !== 'object' || map.errorMessage || map.errorType || map.stackTrace) {
    return { _failed: true, text: 'The keyword data service returned an error — no credits were charged. Please try again in a moment.' };
  }
  let rows = kwRows(map, cols);
  if (!rows.length) return { _failed: true, text: 'No keyword data was found — no credits were charged. Try different keywords or check the domain/URL.' };

  const domain = (body.domain || (/(ranking|webpage)/i.test(mode) ? (body.target || body.input) : '') || '').trim();
  if (domain) rows = await enrichTimeToRank(rows, domain, location, language, user);

  return withRecs({ rows }, await kaRecs(rows));
}

/** Google-Ads paid competition (0–1 or 0–100) → a readable Low/Medium/High band. */
function fmtCompetition(v) {
  if (v == null || v === '') return '—';
  let n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n <= 1) n = n * 100;
  n = Math.round(n);
  return n < 33 ? `Low (${n})` : n < 66 ? `Medium (${n})` : `High (${n})`;
}

/** Add a `timeToRank` column per keyword when a domain is given — the real
 *  serpLite → kwRecommendations path (capped) the dedicated Time-to-Rank tool
 *  uses, with a difficulty heuristic fallback. Mutates + returns rows. */
async function enrichTimeToRank(rows, domain, location, language, email, cap = 10) {
  if (!Array.isArray(rows) || !rows.length || !domain) return rows;
  await Promise.all(rows.slice(0, cap).map(async (row) => {
    try {
      const serps = deepBody(await postUpstream(UPSTREAMS.serpLite, { keyword: row.keyword, language, location, user: email }));
      const rec = await postUpstream(UPSTREAMS.kwRecommendations, {
        keyword: row.keyword,
        target_content: [{ url: domain, domain_metrics: {}, rank: (row.rank && row.rank !== '—') ? row.rank : null }],
        serps_dict: serps,
      });
      const recText = String(deepBody(rec) ?? '');
      const hit = recText.match(/(0-3 months|3-6 months|6-9 months|9-12 months|more than 12 months)/i);
      row.timeToRank = hit ? hit[0] : difficultyToTime(row.difficulty);
    } catch { row.timeToRank = difficultyToTime(row.difficulty); }
  }));
  // Beyond the cap: cheap heuristic from KD (or N/A when KD is unavailable).
  for (const row of rows.slice(cap)) row.timeToRank = difficultyToTime(row.difficulty);
  return rows;
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
    // Real SEO keyword difficulty only (DataForSEO `difficulty`, in ranking mode).
    // Mangools/Keyword-metrics has no KD, so it omits this column entirely rather
    // than showing a dead "—"; Google-Ads paid competition gets its own column.
    if (cols.includes('difficulty')) row.difficulty = m.difficulty ?? '—';
    if (cols.includes('competition')) row.competition = fmtCompetition(m.competition ?? m.competition_index);
    if (cols.includes('cpc')) row.cpc = m.cpc != null ? `S$${Number(m.cpc).toFixed(2)}` : '—';
    if (cols.includes('rank')) row.rank = m.rank ?? m.best_position ?? '—';
    if (cols.includes('traffic')) row.traffic = m.traffic ?? '—';
    if (cols.includes('intent')) row.intent = m.search_intent ?? m.intent ?? '—';
    if (cols.includes('reason')) row.reason = m.reason_for_choosing ?? m.reason ?? '';
    if (cols.includes('url')) row.url = m.url ?? m.relative_url ?? m.relevant_url ?? '—';
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
    // Per-keyword LLM rationale (index.html's "Reasoning & Recommendations").
    let reasoning = '';
    try {
      reasoning = String(deepBody(await postUpstream(UPSTREAMS.reasonForKwSelection, { keyword, location, language, target: domain })) ?? '').trim();
    } catch { /* best-effort — leave blank */ }
    return {
      keyword,
      volume: m.search_volume ?? m.volume ?? '—',
      difficulty: difficulty ?? '—',
      cpc: m.cpc != null ? `S$${Number(m.cpc).toFixed(2)}` : '—',
      timeToRank,
      reasoning: reasoning || '—',
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
  const sections = sectionsAnchors(target, { total, exact, generic, empty, overOpt, health }, flagged);

  // Inbound audit (best-effort, bounded): which other pages link to this URL?
  try {
    const inbound = await anchorInboundAudit(target, host, keyword, kwTokens);
    if (inbound) {
      const good = inbound.found.filter((f) => f.priority === 'KEEP').length;
      sections.push({ type: 'heading', text: 'Inbound internal links' });
      sections.push({ type: 'stats', items: [
        { label: 'Pages sampled', value: inbound.pagesChecked },
        { label: 'Inbound links found', value: inbound.found.length, tone: inbound.found.length ? 'green' : 'amber' },
        { label: 'Well-optimised', value: good, tone: good ? 'green' : undefined },
      ] });
      if (inbound.found.length) {
        sections.push({ type: 'table', title: 'Pages linking to this URL', columns: ['Source page', 'Anchor', 'Status'],
          rows: inbound.found.slice(0, 50).map((f) => ({ 'Source page': f.source, Anchor: f.text || '(empty)', Status: f.status })) });
      } else {
        sections.push({ type: 'callout', text: 'No inbound internal links to this page were found among the sampled pages. Add contextual links from related pages to strengthen it.' });
      }
    }
  } catch (e) { console.error('anchor_inbound_failed', e.message); }

  return { sections };
}

// Bounded inbound audit: sample internal pages (homepage links, capped) and find
// anchors pointing at `target`. Not a full-site crawl — kept bounded so a single
// synchronous run stays within the slow-tool timeout.
async function anchorInboundAudit(target, host, keyword, kwTokens) {
  let root = '';
  try { root = new URL(target).origin; } catch { return null; }
  const norm = (href, base) => {
    try { const u = new URL(href, base); return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '')).toLowerCase(); }
    catch { return ''; }
  };
  const targetKey = norm(target, root);

  const fetchHtml = (url, ms) =>
    Promise.race([postUpstream(UPSTREAMS.getHtml, { url }), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))])
      .then((raw) => (typeof raw === 'string' ? raw : (raw?.body || raw?.html || '')))
      .catch(() => '');

  const homeHtml = await fetchHtml(root, 20000);
  if (!homeHtml) return null;

  const candidates = [];
  const seen = new Set([targetKey]);
  for (const a of extractAnchors(homeHtml, host)) {
    let abs = '';
    try { abs = new URL(a.href, root).href; } catch { continue; }
    const key = norm(abs, root);
    if (!key || seen.has(key)) continue;
    seen.add(key); candidates.push(abs);
    if (candidates.length >= 10) break;
  }
  if (!candidates.length) return null;

  const found = [];
  await Promise.all(candidates.map(async (page) => {
    const html = await fetchHtml(page, 12000);
    if (!html) return;
    for (const a of extractAnchors(html, host)) {
      if (norm(a.href, page) === targetKey) found.push({ source: page, text: a.text, ...classifyAnchor(a.text, keyword, kwTokens) });
    }
  }));
  return { pagesChecked: candidates.length, found };
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

// ── Social Media Audit: live multi-platform scrape + content-gap strategy ─────
// The lambda is async (start → poll, up to ~5 min) so the React page — not the
// gateway — drives the loop, calling us once per `action`. Only the Phase-2
// `strategy` step is billable; every scrape/discover/poll step opts out of
// billing with `{ _noCharge: true }` so the user is charged exactly once.
// A Social Audit is a long, two-phase job (live scrape → strategy analysis).
// Rather than have the browser drive it (and lose the run if the tab closes),
// `start` persists the job and fires a background self-invocation that runs the
// whole thing server-side. The browser only polls `status` for live progress;
// the run completes, saves to history, and notifies even if the user leaves.
const socialJobKey = (jobId) => `social_job:${jobId}`;
const SOCIAL_JOB_TTL = 6 * 60 * 60; // 6h — re-openable from History / the notification

async function socialAuditRun(body) {
  const action = String(body.action || '').trim();
  // Strip gateway-injected + routing keys before forwarding upstream.
  const fwd = { ...body };
  delete fwd._email; delete fwd._integrations; delete fwd._userId; delete fwd._tier; delete fwd.projectId;

  // ── Kick off the whole audit server-side, return a job id immediately ─────
  if (action === 'start') {
    const userId = body._userId || body._email;
    const scrape = (body.scrape && typeof body.scrape === 'object') ? body.scrape : {};
    const strategy = (body.strategy && typeof body.strategy === 'object') ? body.strategy : {};
    const platforms = Array.isArray(scrape.platforms) ? scrape.platforms : [];

    // Start the upstream live scrape (only when handles were provided).
    let scrapeJobId = null, total = 0;
    if (platforms.length) {
      const raw = await postUpstream(UPSTREAMS.socialMediaAudit, { ...scrape, action: 'start' });
      const sd = deepBody(raw) || {};
      if (sd.error) return { _failed: true, text: sd.error };
      if (!sd.jobId) return { _failed: true, text: 'The live scrape did not start. Please try again.' };
      scrapeJobId = sd.jobId;
      total = (sd.platforms || platforms).length;
    }

    const jobId = `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await putCache(socialJobKey(jobId), {
      status: scrapeJobId ? 'scraping' : 'analyzing',
      jobId, scrapeJobId,
      progress: { done: 0, total },
      strategy,                 // consumed once by the finalizer
      userId, email: body._email, tier: body._tier,
      createdAt: new Date().toISOString(),
    }, SOCIAL_JOB_TTL);

    // Fire-and-forget: a separate Lambda invocation runs scrape→strategy→save.
    await selfInvokeFinalize(jobId);
    return { _noCharge: true, jobId, status: scrapeJobId ? 'scraping' : 'analyzing' };
  }

  // ── Poll job status (browser live-progress; never charged) ────────────────
  if (action === 'status') {
    const job = await getCache(socialJobKey(body.jobId)).catch(() => null);
    if (!job) return { _noCharge: true, status: 'unknown' };
    // Don't ship the (potentially large) strategy inputs back to the browser.
    const { strategy, ...pub } = job;
    return { _noCharge: true, ...pub };
  }

  // ── Strategy analysis — the single CHARGED step, run by the finalizer ─────
  if (action === 'strategy') {
    delete fwd.action;
    const raw = await postUpstream(UPSTREAMS.socialMediaStrategy, { ...fwd, task: 'social_audit' });
    const data = parseScaAnswer(raw);
    if (!data) return { _failed: true, text: 'The strategy analysis did not return a usable result. Please try again.' };
    return { sca: data, usage: deepBody(raw)?.usage };
  }

  // ── Free helper / live-scrape actions — proxied raw, never charged ────────
  const ALLOWED = new Set(['suggest_context', 'discover', 'discover_competitors', 'poll']);
  if (!ALLOWED.has(action)) return { _failed: true, text: `Unknown social-audit action: ${action || '(none)'}` };
  const raw = await postUpstream(UPSTREAMS.socialMediaAudit, fwd);
  const d = deepBody(raw);
  const obj = d && typeof d === 'object' && !Array.isArray(d) ? d : { data: d };
  return { _noCharge: true, ...obj };
}

// Fire the background finalizer as its own Lambda invocation (Event mode), so it
// runs independently of the request that started it. AWS_LAMBDA_FUNCTION_NAME is
// always set by the runtime; the IAM self-invoke grant is in template.yaml. The
// SDK client is imported lazily (it's provided by the nodejs runtime, not the
// local node_modules) and memoised across warm invocations.
let _lambdaClient = null;
async function selfInvokeFinalize(jobId) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  _lambdaClient ||= new LambdaClient({});
  await _lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ __bgFinalize: true, jobId })),
  }));
}

// Background worker: poll the live scrape to completion, run the (charged)
// strategy step by re-entering the gateway handler — so billing, history and the
// "run complete" notification all flow through the one canonical path — then
// store the finished result for the browser (and a returning user) to pick up.
async function socialAuditFinalize(event, context) {
  const jobId = event.jobId;
  const job = await getCache(socialJobKey(jobId)).catch(() => null);
  if (!job) { console.error('social_finalize_missing_job', jobId); return; }

  try {
    // Phase 1 — drive the upstream scrape, surfacing progress to the browser.
    let scorecard = null;
    if (job.scrapeJobId) {
      scorecard = await pollSocialScrape(job, jobId);
      await putCache(socialJobKey(jobId), { ...job, status: 'analyzing', scorecard }, SOCIAL_JOB_TTL).catch(() => {});
    }

    // Phase 2 — strategy analysis via a synthetic, authenticated gateway call.
    const strategyBody = { action: 'strategy', ...job.strategy };
    if (scorecard) strategyBody.live_social_data = JSON.stringify(scorecard);
    const synthetic = {
      rawPath: '/run/social-audit',
      requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId: job.userId, email: job.email, tier: job.tier } } },
      headers: {},
      body: JSON.stringify(strategyBody),
    };
    const resp = await handler(synthetic, context);
    const parsed = JSON.parse(resp?.body || '{}');
    const status = resp?.statusCode || 200;
    if (status === 402) throw new Error('You ran out of credits before the strategy step. Top up and run it again.');
    if (status >= 300 || parsed.failed || parsed.result?._failed) {
      throw new Error(parsed.result?.text || parsed.error || 'Strategy analysis failed.');
    }
    if (!parsed.result?.sca) throw new Error('No strategy data was returned.');

    await putCache(socialJobKey(jobId), {
      jobId, status: 'done', scorecard,
      sca: parsed.result.sca,
      runId: parsed.runId || null,
      creditsRemaining: parsed.creditsRemaining,
      topupRemaining: parsed.topupRemaining,
      creditsUsed: parsed.creditsUsed,
      finishedAt: new Date().toISOString(),
    }, SOCIAL_JOB_TTL);
    // The "✅ Social Audit finished" notification already fired inside handler's
    // saveRun path, so there's nothing more to do here on success.
  } catch (e) {
    await putCache(socialJobKey(jobId), {
      jobId, status: 'error', error: e?.message || 'The audit failed.',
      finishedAt: new Date().toISOString(),
    }, SOCIAL_JOB_TTL).catch(() => {});
    try {
      await addNotification({
        userId: job.userId,
        title: '⚠️ Social Audit could not finish',
        body: (e?.message || 'Please try running it again.').slice(0, 140),
        link: '/social-audit',
      });
    } catch { /* best-effort */ }
  }
}

// Poll the upstream live scrape until done, writing progress into the job record
// so the browser's `status` poll can show "N/M sources ready". Bounded well
// inside the Lambda timeout; a slow scrape surfaces as a clean job error.
async function pollSocialScrape(job, jobId) {
  const deadline = Date.now() + 220000; // leave headroom under the 300s timeout for strategy
  while (Date.now() < deadline) {
    const raw = await postUpstream(UPSTREAMS.socialMediaAudit, { action: 'poll', jobId: job.scrapeJobId }).catch(() => null);
    const d = raw ? deepBody(raw) : null;
    if (d) {
      if (d.error) throw new Error(d.error);
      if (d.status === 'done') return d.scorecard || {};
      await putCache(socialJobKey(jobId), {
        ...job,
        status: d.status === 'finalizing' ? 'finalizing' : 'scraping',
        progress: d.progress || job.progress,
      }, SOCIAL_JOB_TTL).catch(() => {});
    }
    await sleep(6000);
  }
  throw new Error('Timed out collecting live social data.');
}

// Unwrap the socialMediaStrategy response (proxy envelope → answer → JSON) into
// the structured object renderSocialAudit() expects. Mirrors index.html.
function parseScaAnswer(raw) {
  let answer = deepBody(raw);
  if (answer && typeof answer === 'object' && answer.answer == null && answer.body != null) {
    let b = answer.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { /* keep string */ } }
    answer = b;
  }
  if (answer && typeof answer === 'object' && answer.answer != null) answer = answer.answer;
  if (typeof answer === 'string') {
    let s = answer.trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch { return null; }
  }
  return answer && typeof answer === 'object' ? answer : null;
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
export const __test = { callUpstream, crawlRun, aiVisibilityRun, backlinksRun, strategyEngineRun, contentOptimiserRun, contentCheckRun, timeToRankRun, anchorCleanerRun, perfMarketingRun, socialAuditRun, parseScaAnswer, schemaRun, keywordAnalysisRun, kwRows, cleanDomain, classifyAnchor, difficultyToTime, parseAgentResult, parsePrompts, brandPrompts, pageIssues, LOC_NAME, clampInt, sectionsChecker, sectionsAnchors, sectionsBacklinks, sectionsPerfMarketing, generateForensicRecommendations, faSeverityFor, faComputeHealthScore, faSections, faParseHomeHtml, faParseRobots, faValidTxt, faStripHtml, buildLlmsTxt, buildLlmsFull, extractSiteLinks };

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
  // Spread the rest of the result so non-row content (e.g. the recommendations
  // `sections`, `summary`) survives the free-tier row cap.
  return {
    ...result,
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
