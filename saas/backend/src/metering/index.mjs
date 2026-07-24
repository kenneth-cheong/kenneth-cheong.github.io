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
import { getUser, putUser, spendCredits, totalCredits, saveRun, getCache, putCache, appendMetricSnapshots, addNotification, recordScheduleRun } from '../lib/dynamo.mjs';
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
  estCostUsd,
  toDomain,
  toHost,
  toPageUrl,
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
  sourceOf,
} from '../lib/http.mjs';
import { accountBlocked, isStaff } from '../lib/admin.mjs';
import { accessLocked, accessLockedResponse } from '../lib/access.mjs';
import { verify } from '../lib/jwt.mjs';
import { rateLimit, RUN_LIMITS } from '../lib/ratelimit.mjs';

// How many free "teaser" runs a locked tool allows per user per month.
const TEASER_RUNS_PER_MONTH = 1;

// Absolute epoch-ms this invocation must be finished by, captured at handler
// entry so optional deep-in-the-stack stages (cwDeepCompare) can ask "does this
// still fit?" without threading `context` through six call layers. Lambda runs
// one event at a time per container, so a module-scoped value can never be read
// by a different invocation. Infinity when there's no clock (unit tests).
let INVOCATION_DEADLINE_AT = 0;
const msRemaining = () => (INVOCATION_DEADLINE_AT ? Math.max(0, INVOCATION_DEADLINE_AT - Date.now()) : Infinity);

// Front-end that triggered this invocation, captured at handler entry for the
// same reason as the deadline above (one event at a time per container). Stamped
// onto every upstream payload in postUpstream so the upstream Lambda's own LLM
// metering can attribute its model spend back to the right product.
let INVOCATION_SOURCE = 'saas';
// Tool id for the same purpose — lets per-tool cost be attributed inside the
// shared upstream Lambdas (one Lambda backs many tools, e.g. aiOptimiser).
let INVOCATION_TOOL = '';

export const handler = async (event, context) => {
  if (typeof context?.getRemainingTimeInMillis === 'function') {
    INVOCATION_DEADLINE_AT = Date.now() + context.getRemainingTimeInMillis();
  }
  // Background self-invocation (InvocationType: Event) — finalize an async run
  // (Social Audit, Content Optimiser, Technical SEO crawl) independently of any
  // browser tab. Not an HTTP event, so it must branch BEFORE any
  // CORS/auth/rate-limit handling.
  if (event && event.__bgFinalize) {
    try {
      if (event.kind === 'content-writer') await contentWriterFinalize(event, context);
      else if (event.kind === 'technical-seo') await crawlFinalize(event, context);
      else await socialAuditFinalize(event, context);
    } catch (e) { console.error('bg_finalize_failed', event.kind || 'social', event.jobId, e?.message); }
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
  // Expired trial / unpaid subscription past its grace window — no tool runs,
  // and nothing is spent. Their saved runs stay exactly where they are.
  if (accessLocked(user)) return forbidden(accessLockedResponse(user));

  const body = parseBody(event);
  // Front-end surface that drove this run (saas dashboard vs legacy index.html),
  // from the X-Source header — defaults to 'saas'. Threaded into the credit spend,
  // the saved run, and the per-source usage metric for per-product attribution.
  const source = sourceOf(event);
  body._source = source;
  INVOCATION_SOURCE = source;
  INVOCATION_TOOL = tool.id || '';
  // Expose the authenticated email to adapters that attribute upstream jobs
  // (e.g. serpCompetitors keys results by user). Gateway-trusted, not user input.
  body._email = c.email || c.userId;
  // Identity for tools that kick off background work (e.g. the async Social
  // Audit finalizer needs to re-authenticate the user it runs on behalf of).
  body._userId = c.userId;
  body._tier = user.tier;
  // Staff-only capabilities (e.g. the Content Optimiser's multi-model A/B run).
  // Gateway-trusted, never taken from the client body.
  body._isStaff = isStaff(user);
  // Connected-integration state for the Integrations tools (gsc/ga4/google-ads).
  body._integrations = user.integrations || {};
  // SEO Diagnostics' step-2 "Get rankings" is a keyword lookup, not the run that
  // earns the tool's ai_long price — billing 5 credits just to populate the table
  // would cost more than the diagnosis is worth to get to.
  const costClass = (tool.id === 'seo-diagnostics' && body.fetchRankings) ? 'keyword_lookup' : tool.cost;
  const unitCost = CREDIT_COSTS[costClass] ?? 0;

  // ── Fan-out tools (e.g. rank checker over many keywords) ──────────────────
  // The named field holds a list; we call the upstream once per item and charge
  // per item. `fullCost` is the per-item cost × item count.
  const fanItems = tool.fanout ? splitItems(body[tool.fanout]).slice(0, 50) : null;
  if (fanItems && fanItems.length === 0) return badRequest('Add at least one keyword.');
  // Reconciled down below if some items fail — the credit gate still reserves
  // against the whole list, but only the items that came back get charged.
  let fullCost = fanItems ? unitCost * fanItems.length : unitCost;

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
      // One item per upstream call, but NOT all at once and NOT all-or-nothing.
      // Both mattered (TKT-ZP4FVQ): fanning 50 keywords out concurrently is what
      // starves the upstream into the 29s gateway cap in the first place, and a
      // bare Promise.all then threw the whole run away because keyword #4 timed
      // out — the user got a 500 and an empty screen with four good positions
      // already in hand. Failed items come back as rows saying so, and only the
      // items that answered are charged for.
      const settled = await mapLimit(fanItems, FANOUT_CONCURRENCY, async (item) => {
        try {
          const r = await callUpstream(tool, { ...body, [tool.fanout]: item });
          return { keyword: item, result: r?.text ?? r?.position ?? JSON.stringify(r), _ok: true };
        } catch (err) {
          console.error('fanout_item_failed', tool.id, item, err?.message);
          return { keyword: item, result: 'Couldn’t be checked this time — not charged', _ok: false };
        }
      });
      const ok = settled.filter((s) => s._ok);
      // Everything failed → this is an outage, not a partial result. Fall through
      // to the catch below so it stays a no-charge failure rather than a table of
      // apologies the user paid nothing for but has to read.
      if (!ok.length) throw new Error(`all ${settled.length} fan-out items failed`);
      fullCost = unitCost * ok.length;
      result = { rows: settled.map(({ _ok, ...row }) => row) };
      // Rank Checker: add an AI pass over the positions (striking-distance pushes,
      // what to do for unranked keywords). Other fan-out tools keep raw rows.
      if (tool.id === 'rank-checker') {
        const rec = await aiRecommendations({
          label: 'Rank Checker',
          context: `Domain: ${body.target || ''}; Location: ${body.location || 'Singapore'}. Flag striking-distance keywords (roughly positions 4-20) to prioritise, and advise what to do for keywords not ranking in the top 100.`,
          findings: ok.map((s) => `${s.keyword}: ${s.result}`).join('\n'),
        });
        result = withRecs(result, rec);
      }
    } else {
      result = await callUpstream(tool, body);
    }
  } catch (err) {
    console.error('upstream_error', tool.id, err);
    // A connection problem that reached us as a throw is still a setup step, not
    // a fault. The 500 below is opaque by design (it never leaks upstream
    // detail), so the client can't tell the two apart — and a 500 is exactly
    // what auto-opens "Report a problem". Answer with the connect widget
    // instead, for any integration path that throws rather than returning one.
    const reason = tool.integration ? connectReasonOf(err?.message) : null;
    if (!reason) return serverError('The tool backend failed. No credits were charged.');
    console.log(JSON.stringify({ metric: 'integration_needs_connect', provider: tool.integration, reason, detail: String(err?.message || '').slice(0, 200) }));
    result = connectPrompt(tool, reason, `We couldn’t reach your ${tool.name} account — sign in again to restore access.`);
  }

  // ── Soft-failure gate (spec §6.2–6.4): some upstreams return HTTP 200 with an
  // error payload (e.g. "couldn't fetch the homepage") rather than throwing.
  // Surface the message but NEVER charge for it — credits are only for results.
  const softFailed = isSoftFailure(result);
  // Log WHICH soft failure this was. Every one of the ~40 `_failed` returns in
  // this file says something different about what went wrong, and until now none
  // of it reached CloudWatch — a support ticket for a failed run showed only
  // `softFailed: true` and a duration, so TKT-OXT0KV sat unexplained for two
  // days with the run's own diagnosis sitting in a variable we then threw away.
  // The message is ours (never upstream text), so it's safe to log verbatim.
  if (softFailed) {
    console.log(JSON.stringify({
      metric: 'soft_failure',
      tool: tool.id,
      userId: c.userId,
      reason: String(result.text || result.html || firstCalloutText(result) || '').slice(0, 300),
    }));
  }
  if (result && typeof result === 'object') delete result._failed; // strip internal flag from client payload
  // Free sub-steps (e.g. Social Media Audit discover/scrape/poll) opt out of
  // billing with `{ _noCharge: true }`: proxied like a run, but never charged,
  // saved to history, or snapshotted to the performance series.
  const noCharge = !!(result && typeof result === 'object' && result._noCharge === true);
  if (result && typeof result === 'object') delete result._noCharge;
  const charge = willCharge && !softFailed && !noCharge;
  // Per-item sub-calls (e.g. Keyword Analysis' on-demand per-keyword time-to-rank)
  // charge like a run but must NOT each spawn a history row / notification — the
  // user fired one "calculate" over N keywords, not N separate runs.
  const skipHistory = !!(result && typeof result === 'object' && result._skipHistory === true);
  if (result && typeof result === 'object') delete result._skipHistory;

  // ── Partial-results shaping for teaser / capped free tier ─────────────────
  // `noCharge` responses are control messages, not results: an async tool's
  // "here's your job id" and the progress polls that follow. Shaping them would
  // rewrite the job id out of the payload AND spend the user's one teaser reveal
  // on a message containing no findings — the real run, which re-enters this
  // handler from the finalizer, is the one that gets teased and capped.
  let payload = result;
  if (teaser && !softFailed && !noCharge) {
    payload = applyTeaser(tool, result);
    await markTeaserUsed(user, tool.id);
  } else if (tool.freeCap && user.tier === 'free' && !softFailed && !noCharge) {
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
      source,
    });
    creditsRemaining = spent.total;
    topupRemaining = spent.topupCredits;
  }

  // Persist the run so the user can re-open it from their history (best-effort).
  // Skip free sub-steps (discover/poll) so a single audit yields one history row.
  let runId = null;
  if (!noCharge && !skipHistory) {
    try {
      const saved = await saveRun({
        userId: user.userId, tool: tool.id, toolName: tool.name,
        inputs: publicInputs(body), result: payload, creditsUsed,
        projectId: body.projectId || null,
        // Tag runs fired by the schedules cron so they're queryable per-schedule.
        scheduleId: body._scheduleId || null,
        source,
      });
      runId = saved.runId;
      // Stamp the outcome onto the originating schedule (last run + count), so
      // the Schedules page shows status without the cron waiting on the run.
      if (body._scheduleId) {
        try { await recordScheduleRun(user.userId, body._scheduleId, { runId, status: softFailed ? 'failed' : 'ok' }); }
        catch (e) { console.error('schedule_record_failed', body._scheduleId, e.message); }
      }
      // In-platform "run complete" ping — the notification bell polls these so a
      // user who navigated away still learns the result is ready. Best-effort;
      // skip soft failures (the message there is the result, not a completion).
      // Links straight at the saved run (/runs/:runId re-opens it in the tool),
      // so the click lands on the result instead of a history list to hunt through.
      if (!softFailed) {
        try {
          await addNotification({
            userId: user.userId,
            title: `✅ ${tool.name} finished`,
            body: runNotificationPreview(tool, payload),
            link: runId ? `/runs/${encodeURIComponent(runId)}` : '/history',
            kind: 'run',
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
  console.log(JSON.stringify({ metric: 'tool_run', tool: tool.id, source, ms: Date.now() - t0, creditsUsed, cached: !!result?.cached, teaser, softFailed }));
  // Per-surface run + spend metric (CloudWatch EMF) so the Admin → Platform panel
  // can split runs and estimated vendor $ between the SaaS dashboard and the
  // legacy index.html tools — attribution AWS billing can't do (shared API keys).
  // Only count real, charged runs; teaser/soft-failed/zero-cost pulls don't spend.
  if (charge && !softFailed) {
    const units = fanItems ? Math.max(1, fanItems.length) : 1;
    emitUsageMetric({ source, tool: tool.id, creditsUsed, estCostUSD: estCostUsd(costClass) * units });
  }

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

// How many fan-out items may be in flight against one upstream at a time. The
// cap is the point: firing a 50-keyword list at rankChecker all at once is what
// pushed individual calls past its gateway's 29s cap, so the list "failed" from
// self-inflicted load. Five keeps a long list roughly as fast while leaving the
// upstream able to answer each one.
const FANOUT_CONCURRENCY = 5;

/** Map `fn` over `items` with at most `limit` in flight, preserving input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

// Upstreams whose generation legitimately exceeds the upstream API Gateway's
// HARD 29s integration cap (e.g. the Media Plan generator builds a full plan
// for every ad format from Claude with persona context — 30–120s). Calling
// those through the gateway 504s every time, so invoke the Lambda DIRECTLY: the
// call then rides MeteringFn's 300s budget + the upstream's own Lambda timeout.
// Value = the upstream Lambda's function name. The IAM grant is in template.yaml.
const DIRECT_INVOKE = {
  [UPSTREAMS.mediaPlanGenerator]: 'mediaPlanGenerator',
  [UPSTREAMS.personaGenerator]: 'personaGenerator',
  [UPSTREAMS.generateFunnel]: 'generateFunnel',
};

let _lambdaInvokeClient;
/** Invoke an upstream Lambda directly (RequestResponse) and return the raw
 *  response text ({ statusCode, body } envelope) for postUpstream to unwrap.
 *  These agency Lambdas sit behind a NON-proxy gateway that passes the request
 *  body straight through as the event, so the payload is sent UNWRAPPED (event =
 *  payload), NOT { body: … } — wrapping it gives the function empty inputs.
 *  Bypasses the gateway timeout. Throws on a Lambda FunctionError. */
async function invokeUpstreamLambda(fnName, payload) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  // 175s socket timeout — under MeteringFn's 300s, over the upstreams' Lambda caps.
  _lambdaInvokeClient ||= new LambdaClient({ requestHandler: { requestTimeout: 175000 } });
  const res = await _lambdaInvokeClient.send(new InvokeCommand({
    FunctionName: fnName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  const text = Buffer.from(res.Payload || []).toString('utf8');
  if (res.FunctionError) throw new Error(`upstream lambda ${res.FunctionError}: ${text.slice(0, 300)}`);
  return text;
}

/**
 * POST to an upstream, unwrapping the { statusCode, body } proxy envelope.
 * Adds an AbortController timeout and exponential-backoff retry on transient
 * failures (auto-applied to FLAKY backends; override via opts). Upstreams in
 * DIRECT_INVOKE are called via the Lambda API instead of their 29s gateway.
 */
async function postUpstream(url, payload, opts = {}) {
  // Stamp the originating front-end onto every upstream payload (one choke point
  // for both the HTTP and direct-invoke paths). The upstream Lambda reads
  // `_source` at handler entry and tags its own LLM metrics with it.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload._source == null) {
    payload = { ...payload, _source: INVOCATION_SOURCE, _tool: INVOCATION_TOOL };
  }
  const cfg = FLAKY_BY_URL[url] || {};
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? 170000; // < 180s Lambda cap
  const retries = opts.retries ?? cfg.retries ?? 0;
  const directFn = DIRECT_INVOKE[url];

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let text;
      if (directFn) {
        text = await invokeUpstreamLambda(directFn, payload);
      } else {
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
      text = await res.text();
      if (!res.ok) {
        if (attempt < retries && RETRYABLE_STATUS.has(res.status)) {
          lastErr = new Error(`upstream ${res.status}`);
          continue;
        }
        throw new Error(`upstream ${res.status}: ${text.slice(0, 300)}`);
      }
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
// On-Page is absent on purpose: it caches its FETCHED page data instead, one
// level down (see onpageRun), so a change to how the report renders shows up on
// the next run rather than a day later.
const CACHE_TTL = { 'keyword-analysis': 86400, backlinks: 86400, competitors: 86400, 'time-to-rank': 86400 };
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
  // DataForSEO crawl is async: initiate → poll get_results until done. Wrapped
  // in a background job so the browser can watch rows land instead of waiting
  // out the whole crawl on one buffered request. See crawlGateway / crawlRun.
  if (tool.id === 'technical-seo') return crawlGateway(body, tool);
  // GEO+SEO Forensic Audit: fan out ~30 probes, score them, build a remediation plan.
  if (tool.id === 'forensic-audit') return forensicAuditRun(body);
  // SEO Diagnostics: guided keyword→fix wizard — technical lanes + SERP landscape
  // + keyword buckets + AI narrative (manual keyword entry; no third-party suite).
  // Step 2's "Get rankings" is a keyword lookup, not the diagnosis — see sdxRankings.
  if (tool.id === 'seo-diagnostics') return body.fetchRankings ? sdxRankings(body) : seoDiagnosticsRun(body);
  // Page Technical & Domain Analysis: lighter probe fan-out → metric-card grid.
  if (tool.id === 'page-analysis') return pageAnalysisRun(body);
  // Page Speed Check: mobile + desktop PageSpeed for ONE url. Nothing else.
  if (tool.id === 'page-speed') return pageSpeedRun(body);
  // AI-visibility is multi-step: derive prompts → verify_mentions → poll snapshot.
  // AI Mentions: are you cited in AI answers? AI Discovery: technical GEO-readiness.
  if (tool.id === 'ai-mentions') return aiVisibilityRun(body);
  if (tool.id === 'ai-discovery') return aiDiscoveryRun(body);
  // Backlinks Explorer fans out across summary + referring domains + anchors.
  if (tool.id === 'backlinks') return backlinksRun(body);
  // AI Content Optimiser: optional draft → run the multi-agent QA suite.
  if (tool.id === 'content-writer') return contentWriterGateway(body);
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
  // Persona Generator: free "AI suggest" pass on the audience-details box —
  // reads the site (or the pasted brand description) and drafts it. Never
  // charged; the real run still goes through the adapter below.
  if (tool.id === 'persona' && String(body.action || '').trim() === 'suggest') return personaSuggest(body);
  // SEM Ad Copy: free "Auto-suggest keywords" pass on the keywords box — reads
  // the site (or expands the seeds they already typed) for the chosen market.
  // Never charged; the real ad-copy run still goes through the adapter below.
  if (tool.id === 'sem-copy' && String(body.action || '').trim() === 'suggest') return semCopySuggest(body);

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

/** A few runners phrase their soft failure as a callout section instead of
 *  `text` (the crawl and AI-discoverability paths). Dig it out so the
 *  soft_failure log line has a reason for those too. */
function firstCalloutText(result) {
  const s = Array.isArray(result?.sections) ? result.sections : [];
  return s.find((x) => x && typeof x.text === 'string' && x.text)?.text || '';
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
//
// Two steps, one tool — the same shape index.html's Competitors panel has always
// had. Step 1 DISCOVERS who shares the SERP; step 2 (`compareWith`) takes the
// domains the user ticked and pulls every keyword they and the user BOTH rank
// for, so the report finally answers "how do I stack up" rather than only "who
// is out there".
// DataForSEO spells domains however it found them — `www.` on one side of a
// comparison and not the other — so every match here goes through toDomain.
const sameDomain = (a, b) => !!a && toDomain(a) === toDomain(b);

async function competitorsRun(body) {
  const rivals = (Array.isArray(body.compareWith) ? body.compareWith : String(body.compareWith || '').split(/[\n,]+/))
    .map((s) => cleanDomain(s)).filter(Boolean);
  // De-duplicate, drop the user's own domain (comparing you to you is an empty
  // table), and cap: each rival is its own upstream round-trip.
  const unique = [...new Set(rivals)].filter((d) => !sameDomain(d, body.domain)).slice(0, 3);
  if (unique.length) return competitorsCompare(body, unique);

  const keywords = String(body.input || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!keywords.length) throw new Error('Enter at least one keyword to find competitors.');
  const location = body.location || 'Singapore';
  const language = body.language || 'English';
  const email = body._email || 'saas-user';
  const you = cleanDomain(body.domain || body.url);

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

  // Where the user themselves landed. The upstream spells domains however
  // DataForSEO does (`www.` on some, not others), so match loosely.
  const mine = you ? domains.find((d) => sameDomain(d, you)) : null;
  const myRanks = mine ? Object.values(merged[mine]).map(Number).filter(Number.isFinite) : [];
  const label = (d) => (d === mine ? `${d} (you)` : d);

  const stats = [
    { label: 'Competitors found', value: domains.length - (mine ? 1 : 0), tone: 'blue' },
    { label: 'Keywords analysed', value: keywords.length, tone: 'slate' },
  ];
  if (you) {
    stats.push({ label: 'Keywords you rank for', value: `${myRanks.length} of ${keywords.length}`, tone: myRanks.length ? 'green' : 'red' });
    if (myRanks.length) stats.push({ label: 'Your best position', value: `#${Math.min(...myRanks)}`, tone: 'blue' });
  }

  const sections = [
    { type: 'heading', text: `Competitors for: ${keywords.join(', ')}` },
    { type: 'stats', items: stats },
  ];
  // Not appearing at all is the single most useful finding here, and a table of
  // other people's rankings doesn't say it out loud.
  if (you && !mine) {
    sections.push({ type: 'callout', text: `${you} doesn’t rank in the top results for any of these keywords — every domain below is currently ahead of you. Pick two or three and compare head-to-head to see which keywords are realistically winnable.` });
  }

  // Position matrix when the keyword set is small enough to be columns; else a
  // compact joined "positions" column.
  if (keywords.length <= 8) {
    const columns = ['Competitor', ...keywords];
    const rows = domains.map((d) => {
      const row = { Competitor: label(d) };
      for (const kw of keywords) { const r = merged[d][kw]; row[kw] = (r == null) ? '—' : `#${r}`; }
      return row;
    });
    sections.push({ type: 'table', title: 'SERP position overlap', columns, rows });
  } else {
    const rows = domains.map((d) => ({
      Competitor: label(d),
      'Keyword positions': Object.entries(merged[d]).map(([kw, r]) => `${kw} #${r}`).join(', '),
      'Keywords ranked': Object.keys(merged[d]).length,
    }));
    sections.push({ type: 'table', title: 'SERP position overlap', columns: ['Competitor', 'Keyword positions', 'Keywords ranked'], rows });
  }

  // Step 2 — pick rivals, compare against yourself. Rendered as a picker the
  // user acts on in place (ResultSections `select`), so the sequel doesn't
  // require them to know it exists.
  const options = domains.filter((d) => d !== mine).slice(0, 25).map((d) => {
    const n = Object.keys(merged[d]).length;
    return { value: cleanDomain(d), label: d, meta: `${n} keyword${n === 1 ? '' : 's'} shared` };
  });
  if (options.length) {
    sections.push({
      type: 'select', name: 'compareWith', max: 3, options,
      title: 'Compare yourself against them',
      note: you
        ? `Pick up to 3 and we’ll pull every keyword ${you} and they BOTH rank for, side by side with each side’s position.`
        : 'Add your domain above, then pick up to 3 to see every keyword you and they both rank for.',
      action: { label: 'Compare ranked keywords', requires: 'domain' },
    });
  }

  // Best-effort AI insights (same monday lambda, action competitor_insights).
  try {
    const summary = domains
      .map((d) => `- ${label(d)}: ${Object.entries(merged[d]).map(([kw, r]) => `"${kw}" #${r}`).join(', ') || 'manually added'}`)
      .join('\n');
    const raw = await postUpstream(UPSTREAMS.strategyEngine, {
      action: 'competitor_insights',
      targetDomain: you,
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

// Step 2: head-to-head ranked-keyword comparison against the domains the user
// ticked in step 1. `domainIntersection` returns only keywords BOTH sides rank
// for, keyed as { keyword: { search_volume, cpc, competition_level, <domain>:
// [rank, url] } } — one call per rival, so we fan out and merge on keyword.
const COMPARE_MAX_ROWS = 300;   // keeps the saved run well under DynamoDB's item ceiling

async function competitorsCompare(body, rivals) {
  const you = cleanDomain(body.domain || body.url);
  if (!you) throw new Error('Add your domain first — the comparison needs a "you" to benchmark against.');
  const location = body.location || 'Singapore';
  const language = body.language || 'English';

  const settled = await mapLimit(rivals, FANOUT_CONCURRENCY, async (rival) => {
    try {
      const data = unwrapBody(await postUpstream(UPSTREAMS.domainIntersection,
        { language, location, target1: you, target2: rival }));
      return { rival, data: (data && typeof data === 'object' && !Array.isArray(data)) ? data : null };
    } catch (e) {
      console.error('competitors_compare_failed', rival, e.message);
      return { rival, data: null, error: e.message };
    }
  });

  // keyword → { volume, cpc, competition, mine, theirs: { rival: rank } }
  const META = new Set(['search_volume', 'cpc', 'competition_level']);
  const rank = (entry) => {
    if (Array.isArray(entry)) return Number(entry[0]);
    if (typeof entry === 'number') return entry;
    if (entry && typeof entry === 'object') return Number(entry.rank ?? entry.position ?? entry.pos);
    return NaN;
  };
  const pick = (obj, domain) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of Object.keys(obj)) if (!META.has(k) && sameDomain(k, domain)) return obj[k];
    return undefined;
  };

  const rows = new Map();
  for (const { rival, data } of settled) {
    for (const [kw, v] of Object.entries(data || {})) {
      if (!v || typeof v !== 'object') continue;
      const theirRank = rank(pick(v, rival));
      if (!Number.isFinite(theirRank)) continue;
      const row = rows.get(kw) || { volume: Number(v.search_volume) || 0, cpc: Number(v.cpc) || 0, competition: v.competition_level || '—', mine: NaN, theirs: {} };
      row.theirs[rival] = theirRank;
      const myRank = rank(pick(v, you));
      if (Number.isFinite(myRank) && !(row.mine <= myRank)) row.mine = myRank;
      rows.set(kw, row);
    }
  }

  const failed = settled.filter((s) => !s.data).map((s) => s.rival);
  if (!rows.size) {
    return { sections: [{ type: 'callout', text: failed.length === rivals.length
      ? `We couldn’t reach the comparison data for ${failed.join(', ')}. Try again in a minute.`
      : `${you} and ${rivals.join(', ')} don’t share any ranking keywords in ${location}. That usually means you’re chasing different searches — or that ${you} isn’t ranking yet for the terms they own.` }] };
  }

  // The keywords worth acting on first: they rank, you don't (or you're well
  // behind), and there's real search volume behind it. Rank by that gap.
  const best = (r) => Math.min(...Object.values(r.theirs));
  const gapOf = (r) => (Number.isFinite(r.mine) ? r.mine : 101) - best(r);
  const all = [...rows.entries()];
  const ahead = all.filter(([, r]) => Number.isFinite(r.mine) && r.mine < best(r)).length;
  const behind = all.filter(([, r]) => gapOf(r) > 0).length;
  const winnable = all.filter(([, r]) => best(r) <= 10 && (!Number.isFinite(r.mine) || r.mine > 10));

  all.sort((a, b) => (gapOf(b[1]) * Math.log10((b[1].volume || 0) + 10)) - (gapOf(a[1]) * Math.log10((a[1].volume || 0) + 10)));
  const shown = all.slice(0, COMPARE_MAX_ROWS);

  const pos = (n) => (Number.isFinite(n) ? `#${n}` : '—');
  const columns = ['Keyword', 'Volume/mo', 'CPC', 'You', ...rivals, 'Gap'];
  const tableRows = shown.map(([kw, r]) => {
    const row = {
      Keyword: kw,
      'Volume/mo': r.volume || 0,
      CPC: r.cpc ? `$${r.cpc.toFixed(2)}` : '—',
      You: pos(r.mine),
      // A gap is only meaningful once we know where you actually are; "you don't
      // rank at all" is a different (worse) story than "you're 12 places back",
      // and collapsing them into one number hides it.
      Gap: !Number.isFinite(r.mine) ? 'Not ranking' : r.mine < best(r) ? `+${best(r) - r.mine} ahead` : r.mine === best(r) ? 'Level' : `−${r.mine - best(r)} behind`,
    };
    for (const rival of rivals) row[rival] = pos(r.theirs[rival]);
    return row;
  });

  const sections = [
    { type: 'heading', text: `${you} vs ${rivals.join(', ')}` },
    { type: 'stats', items: [
      { label: 'Shared keywords', value: rows.size, tone: 'blue' },
      { label: 'You rank ahead', value: ahead, tone: ahead ? 'green' : 'slate' },
      { label: 'They rank ahead', value: behind, tone: behind ? 'red' : 'slate' },
      { label: 'Winnable (they’re top 10, you’re not)', value: winnable.length, tone: 'amber' },
    ] },
  ];
  if (failed.length) {
    sections.push({ type: 'callout', text: `We couldn’t reach the data for ${failed.join(', ')} — the table below covers the rest.` });
  }
  sections.push({
    type: 'table',
    title: `Keywords you both rank for — biggest gaps first${all.length > shown.length ? ` (top ${shown.length} of ${all.length})` : ''}`,
    columns, rows: tableRows,
  });

  const recs = await aiRecommendations({
    label: `${you} vs ${rivals.join(', ')} ranked-keyword comparison`,
    context: `Location: ${location}. ${rows.size} shared keywords. The user ranks ahead on ${ahead} and behind on ${behind}. "You"/rival columns are Google positions; "—" means not ranking.`,
    findings: rowsToFindings(tableRows, 30),
  });
  return withRecs({ sections }, recs);
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
  const images = captionImages(body);
  const pick = (raw) => {
    const d = deepBody(raw);
    return typeof d === 'string' ? d : (d?.result || d?.text || d?.content || d?.response || '');
  };
  const variations = await Promise.all(Array.from({ length: count }, (_, i) =>
    postUpstream(UPSTREAMS.aiOptimiser, { ...base, variationIndex: i, sampleText, ...(images.length ? { images } : {}), settings: { temperature: 0.75 + i * 0.02 } })
      .then(pick).catch(() => '')
  ));
  // The upstream may return each caption as a JSON object ({hook,body,cta,…}),
  // sometimes fenced — assemble it into clean, paste-ready prose rather than
  // leaking the raw JSON to the user.
  const clean = variations.map((v) => captionToProse(v)).filter(Boolean);
  if (!clean.length) return { text: 'No caption generated. Please try again.' };
  if (clean.length === 1) return { text: clean[0] };
  return { text: clean.map((v, i) => `━━━ Variation ${i + 1} ━━━\n\n${v}`).join('\n\n\n') };
}

// Reference images for the caption run, normalised to the plain data-URL strings
// the aiOptimiser `luxury_copy` branch expects.
//
// The field is `_images` (not `images`) on purpose: `publicInputs()` strips
// `_`-prefixed keys, so the base64 never reaches the saved run record. Without
// that, a 3-image run writes several MB into a DynamoDB item capped at 400KB —
// `saveRun` is best-effort inside a try/catch, so the run would look fine and
// the user would simply never see it in their history again.
//
// Capped at 3 even though the upstream allows 6: every variation is a separate
// vision call, so images multiply by `count`, and this is a free-tier tool
// metered at a flat 1 credit.
const CAPTION_IMAGE_CAP = 3;
function captionImages(body) {
  const raw = body._images;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((img) => (typeof img === 'string' ? img : img?.dataUrl))
    .filter((s) => typeof s === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(s))
    .slice(0, CAPTION_IMAGE_CAP);
}

// A caption may come back as prose OR as a JSON object (optionally ```json-fenced)
// with hook/body/cta/caption fields. Return clean prose either way; on any parse
// failure fall back to the fence-stripped raw text so we never show worse output.
function captionToProse(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}' && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(start, i + 1));
          if (o && typeof o === 'object') {
            if (typeof o.caption === 'string' && o.caption.trim()) return o.caption.trim();
            const parts = [o.hook, o.body, o.cta].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
            const hashtags = Array.isArray(o.hashtags) ? o.hashtags.map((h) => (String(h).startsWith('#') ? h : `#${h}`)).join(' ') : (o.hashtags ? String(o.hashtags) : '');
            if (hashtags) parts.push(hashtags.trim());
            if (parts.length) return parts.join('\n\n');
          }
        } catch { /* fall through to raw */ }
        break;
      }
    }
  }
  return s;
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

  // The generator emits an inline red-error <p> ("An error occurred…", "Model
  // returned no campaigns") when it can't read the site or build a plan — often
  // a bot-protected homepage it couldn't fetch. Personas/funnel alone are not a
  // media plan, so soft-fail (spec §6.2) and DON'T charge for an empty result.
  if (!mpHtml || /error occurred while generating the media plan|returned no campaigns/i.test(mpHtml)) {
    return { _failed: true, html: '<p>We couldn’t generate a media plan for this site — it may block automated access or need a fuller brief (add objectives, audience and product details). No credits were charged.</p>' };
  }

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
// recommendations (onPageRecommendations) pipeline alongside the content recs,
// plus the vision pass that proposes alt text per image (altTextGenerator) —
// image_data is stripped from the recommender payload, so the alt suggestions
// have never had anywhere else to come from.
// Whatever address shape arrived → one the upstreams can actually fetch. A bare
// "example.com/page" reaches onPageContentRecommendations schemeless and comes
// back `[]`, while getImages tolerates it — so the report renders complete apart
// from one missing section and reads as "this page has nothing to improve".
// Applied here rather than in the form because Monty, plan steps and schedules
// call the gateway directly and never touch a field `normalize` flag.
function onpageUrl(u) {
  const s = String(u || '').trim().replace(/\s+/g, '');
  return !s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

async function onpageRun(body) {
  const url = onpageUrl(body.input || body.url);
  if (!url) throw new Error('A page URL is required.');
  const keywords = String(body.keywords || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);

  // What the day-long cache holds is the four upstream answers, NOT the report
  // built from them. Caching the rendered sections meant a shipped rendering
  // change (alt-text thumbnails) was invisible for 24h to anyone who had run
  // the page before — the deploy was live, the screen still showed yesterday.
  const dataKey = onpageDataKey(url, keywords);
  const cached = await getCache(dataKey).catch(() => null);
  if (cached) {
    const sections = sectionsOnpage(url, cached.recs || {}, cached.extraction || {}, cached.contentRows || [], cached.images || [], new Map(cached.alt || []), keywords);
    if (sections.some((s) => s.type === 'table')) return { sections, cached: true };
    // A cached miss-shaped payload re-fetches rather than returning nothing.
  }

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
    // The upstream answers with current_value / suggested_value / rationale and
    // nothing else — there is no element name to show, so the row is numbered
    // instead (index.html's table did the same).
    contentRows = (Array.isArray(arr) ? arr : []).map((r, i) => ({
      '#': String(i + 1), Current: r.current_value ?? '—', Suggested: r.suggested_value ?? '—', Why: r.rationale ?? '',
    }));
  } catch (e) { console.error('onpage_content_failed', e.message); }

  // 4. Proposed alt text per image (vision endpoint, same as index.html).
  const images = onpageImages(extraction, url);
  const altBySrc = await onpageAltText(images, keywords, extraction);

  const sections = sectionsOnpage(url, recs, extraction, contentRows, images, altBySrc, keywords);
  // The snapshot stats render from whatever came back, including nothing — so
  // "did this run find anything" is a question about the tables, not the
  // section count.
  if (!sections.some((s) => s.type === 'table')) return { text: 'No on-page recommendations were returned. Check the URL and target keywords.' };
  // Only the fields the report is built from — the raw extraction carries the
  // full image_data and would push the item at the 400KB row ceiling.
  const { meta_title, meta_description, canonical_url, headings } = extraction;
  putCache(dataKey, {
    extraction: { meta_title, meta_description, canonical_url, headings },
    recs, contentRows, images, alt: [...altBySrc],
  }, ONPAGE_TTL).catch(() => {});
  return { sections };
}

const ONPAGE_TTL = 86400;
function onpageDataKey(url, keywords) {
  return createHash('sha256').update(`onpage-data|${url}|${keywords.join(',')}`).digest('hex');
}

// Page images as { src, alt }, absolute-URL only (the vision endpoint has to be
// able to fetch them) and de-duplicated — a sprite or logo repeated in the
// header, body and footer is one recommendation, not five.
function onpageImages(extraction, pageUrl) {
  // Resolved against the FULL page URL, not just its origin: `img/team.jpg` on
  // /blog/post/ is /blog/post/img/team.jpg, and origin-only resolution pointed
  // it at /img/team.jpg — a URL that 404s, which now shows as a dead thumbnail.
  let base = '';
  try { base = new URL(pageUrl.startsWith('http') ? pageUrl : `https://${pageUrl}`).href; } catch { /* leave relative srcs out */ }
  const seen = new Set();
  const out = [];
  for (const it of extraction.image_data || []) {
    let src = it && Object.keys(it)[0];
    if (!src || src.startsWith('data:')) continue;
    if (!/^https?:/i.test(src)) {
      if (!base) continue;
      try { src = new URL(src, base).href; } catch { continue; }
    }
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: String(it[Object.keys(it)[0]] || '').trim() });
  }
  return out;
}

// One vision call per image is the only way to propose alt text (image_data is
// stripped from the recommendations payload for token budget), so the fan-out is
// bounded on both axes: at most ALT_MAX images, at most ALT_CONCURRENCY in
// flight. Beyond the cap the image still appears in the table with its current
// alt — the report never silently drops a row, it just doesn't propose one.
const ALT_MAX = 30;
const ALT_CONCURRENCY = 4;

async function onpageAltText(images, keywords, extraction) {
  const bySrc = new Map();
  const targets = images.slice(0, ALT_MAX);
  if (!targets.length) return bySrc;
  const page_context = [extraction.meta_title, extraction.meta_description].filter(Boolean).join(' — ');
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < targets.length; i = next++) {
      const img = targets[i];
      try {
        const raw = deepBody(await postUpstream(UPSTREAMS.altTextGenerator, {
          page_context,
          image_placement: 'Within page content',
          primary_keyword: keywords[0] || '',
          secondary_keywords: keywords.slice(1).join(', '),
          image_url: img.src,
        }, { timeoutMs: 45000 }));
        const alt = typeof raw === 'string' ? raw : (raw?.result || raw?.alt_text || '');
        if (alt && String(alt).trim()) bySrc.set(img.src, String(alt).trim());
      } catch (e) { console.error('onpage_alt_failed', img.src, e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALT_CONCURRENCY, targets.length) }, worker));
  return bySrc;
}

// Why a given alt row reads the way it does. Deterministic on purpose: the
// alternative is a second LLM round-trip per image to explain a suggestion the
// first one already made.
function altRationale(current, proposed) {
  if (!proposed) return 'No suggestion generated for this image — describe what it shows, in plain language.';
  if (!current) return 'Image has no alt text: screen readers and image search have nothing to go on. The proposal describes it in keyword-aware plain language.';
  if (current.toLowerCase() === proposed.toLowerCase()) return 'Existing alt text is already appropriate — no change needed.';
  if (/^(image|img|photo|picture|logo|icon|banner)[\s\-_0-9]*$/i.test(current)) return 'Current alt text is a placeholder that describes nothing. The proposal says what the image actually shows.';
  return 'The proposal describes the image more specifically and works the page\'s target keywords in naturally.';
}

function sectionsOnpage(url, recs, extraction, contentRows, images = [], altBySrc = new Map(), keywords = []) {
  const out = [{ type: 'heading', text: `On-page optimisation — ${url}` }];
  const len = (s) => String(s || '').length;
  const headingsOf = (lvl) => (extraction.headings?.[lvl] || []).filter((h) => String(h || '').trim());

  // Without target keywords the recommender has nothing to optimise towards, so
  // the report would arrive as a bare inventory. Say so rather than letting the
  // user conclude the tool only checks images.
  if (!keywords.length) {
    out.push({ type: 'callout', text: 'No target keywords were given, so this run reports what the page currently has without suggested rewrites. Re-run with your target keywords to get title, heading, content and alt-text recommendations.' });
  }

  // ── Page snapshot ────────────────────────────────────────────────────────
  // The counts every on-page review starts from, and the two length checks
  // (Google truncates a title past ~60 chars and a description past ~155).
  const titleLen = len(extraction.meta_title);
  const descLen = len(extraction.meta_description);
  const missingAlt = images.filter((i) => !i.alt).length;
  const h1s = headingsOf('h1');
  out.push({ type: 'stats', items: [
    { label: 'Title length', value: titleLen ? `${titleLen} chars` : 'Missing', tone: titleLen >= 30 && titleLen <= 60 ? 'green' : titleLen ? 'amber' : 'red' },
    { label: 'Meta description', value: descLen ? `${descLen} chars` : 'Missing', tone: descLen >= 70 && descLen <= 155 ? 'green' : descLen ? 'amber' : 'red' },
    { label: 'H1 headings', value: String(h1s.length), tone: h1s.length === 1 ? 'green' : 'amber' },
    { label: 'Headings total', value: String(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].reduce((n, l) => n + headingsOf(l).length, 0)) },
    { label: 'Images', value: String(images.length) },
    { label: 'Missing alt text', value: String(missingAlt), tone: missingAlt === 0 ? 'green' : missingAlt > images.length / 2 ? 'red' : 'amber' },
  ] });

  // ── Meta & canonical ─────────────────────────────────────────────────────
  // Built from the EXTRACTION, with the recommendation merged in — driving it
  // off `recs` alone meant a run with no keywords (or a recommender hiccup)
  // dropped the whole section, and the report came back as images only.
  const metaItem = (label, current, o) => {
    const cur = o?.current_value || current;
    if (!cur && !o?.suggested_value) return null;
    return { Item: label, Current: cur || '(missing)', Suggested: o?.suggested_value || '—', Rationale: o?.rationale || '' };
  };
  const metaRows = [
    metaItem('Meta title', extraction.meta_title, recs.meta_title),
    metaItem('Meta description', extraction.meta_description, recs.meta_description),
    metaItem('Canonical URL', extraction.canonical_url, recs.canonical_url),
  ].filter(Boolean);
  if (metaRows.length) out.push({ type: 'table', title: 'Meta & canonical', columns: ['Item', 'Current', 'Suggested', 'Rationale'], rows: metaRows });

  // ── Headings ─────────────────────────────────────────────────────────────
  // Same merge: every heading on the page is listed, and a suggestion is
  // attached where the recommender returned one (matched on the current text,
  // falling back to position — the recommender answers in page order).
  const headRows = [];
  for (const lvl of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const current = headingsOf(lvl);
    const suggested = (recs.headings?.[lvl] || []).filter(Boolean);
    current.forEach((text, i) => {
      const r = suggested.find((s) => s && String(s.current_value || '').trim() === String(text).trim()) || suggested[i];
      headRows.push({ Level: lvl.toUpperCase(), Current: text, Suggested: r?.suggested_value || '—', Rationale: r?.rationale || '' });
    });
    // A missing H1/H2 is the finding — the recommender is asked to draft one,
    // and that row has no counterpart in the extraction to merge onto.
    if (!current.length && (lvl === 'h1' || lvl === 'h2')) {
      const r = suggested.find((s) => s?.suggested_value);
      if (r) headRows.push({ Level: lvl.toUpperCase(), Current: '(missing)', Suggested: r.suggested_value, Rationale: r.rationale || `This page has no ${lvl.toUpperCase()} — add one.` });
    }
  }
  if (headRows.length) out.push({ type: 'table', title: 'Headings (H1–H6)', columns: ['Level', 'Current', 'Suggested', 'Rationale'], rows: headRows });

  // ── Images ───────────────────────────────────────────────────────────────
  // Every image on the page, not a sample: the old 30-row slice under a header
  // that counted all 52 read as data loss.
  if (images.length) {
    const rows = images.map((x) => {
      const proposed = altBySrc.get(x.src) || '';
      return {
        // The absolute src, rendered as a thumbnail by the report's table: a
        // filename alone doesn't tell you whether "MediaOne Logo Square" is the
        // right description for the picture, which is the whole judgement call
        // this table is asking the reader to make.
        Preview: x.src,
        Image: x.src.split('/').pop().split('?')[0].slice(0, 70) || x.src,
        'Current alt': x.alt || '(missing)',
        'Proposed alt': proposed || '—',
        Why: proposed || x.alt ? altRationale(x.alt, proposed) : 'Image has no alt text — describe what it shows.',
      };
    });
    out.push({
      type: 'table',
      title: `Images — alt text (${images.length})`,
      columns: ['Preview', 'Image', 'Current alt', 'Proposed alt', 'Why'],
      rows,
    });
    if (images.length > ALT_MAX) {
      out.push({ type: 'text', text: `Alt text was proposed for the first ${ALT_MAX} images on the page; the remaining ${images.length - ALT_MAX} are listed with their current alt text so nothing is hidden.` });
    }
  }

  if (contentRows.length) out.push({ type: 'table', title: 'Content recommendations', columns: ['#', 'Current', 'Suggested', 'Why'], rows: contentRows });
  return out;
}

// ── GEO On-Page Optimisation: render geoOnPageAnalysis' structured JSON ────────
// The upstream returns JSON (not HTML), so the pass-through adapter dumped the
// whole object as a text blob. Render the 5-part report + assets as sections.
async function geoOnpageRun(body) {
  // Free helper: "AI suggest" on the required target-prompts box — reads the
  // page and drafts the prompts (+ brand / industry / audience). Never charged.
  if (String(body.action || '').trim() === 'suggest') return geoOnPageSuggest(body);
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

  const kwList = (keywords) => (Array.isArray(keywords) ? keywords : String(keywords || '').split(/,\s*|\n/))
    .map((k) => String(k).trim()).filter(Boolean);

  // Per-strategy keyword table with enriched Vol / KD / Rank columns.
  const kwTable = (keywords) => {
    const kws = kwList(keywords);
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
  // The strategies are alternatives to choose between, not a sequence to read
  // end to end — stacking three full keyword tables made them one long scroll
  // with no way to compare. So: a comparison strip first, then one collapsed
  // card each (the recommended one open) so the shapes are visible at a glance
  // and only the chosen strategy's detail is on screen. ReportHtml expands every
  // <details> for print, so the PDF still carries all of them in full.
  const ACCENTS = ['#3b82f6', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981'];
  const ttrOf = (s) => (s.time_to_rank
    ? (String(s.time_to_rank).toLowerCase().includes('month') ? String(s.time_to_rank) : `${s.time_to_rank} months`)
    : '');
  const statsOf = (s) => {
    const kws = kwList(s.target_keywords);
    const metrics = kws.map((k) => metricMap[cleanKw(k)]).filter(Boolean);
    const vol = metrics.reduce((a, m) => a + (Number(m.vol) || 0), 0);
    const kd = metrics.length ? Math.round(metrics.reduce((a, m) => a + (Number(m.diff) || 0), 0) / metrics.length) : null;
    const ranking = kws.filter((k) => { const r = rankMap[cleanKw(k)]; return r != null && r <= 10; }).length;
    return { n: kws.length, vol, kd, ranking };
  };

  const pill = (val, label, col) => `<span style="display:inline-flex;align-items:baseline;gap:4px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:3px 9px;font-size:11px;color:#64748b;white-space:nowrap"><strong style="color:${col};font-weight:800">${esc(val)}</strong>${label}</span>`;

  // At-a-glance comparison — only earns its space when there's a choice to make.
  const compareRows = strategies.map((s, i) => {
    const st = statsOf(s);
    const isRec = s === recommended;
    return `<tr style="border-top:1px solid #f1f5f9;background:${isRec ? '#f0f9ff' : '#fff'}">
      <td style="padding:8px 10px;color:#0f172a;font-weight:700"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${ACCENTS[i % ACCENTS.length]};margin-right:7px"></span>${isRec ? '★ ' : ''}${esc(s.name)}</td>
      <td style="padding:8px 6px;text-align:center;color:#475569">${esc(s.expected_impact || '—')}</td>
      <td style="padding:8px 6px;text-align:center;color:#475569">${esc(ttrOf(s) || '—')}</td>
      <td style="padding:8px 6px;text-align:center;color:#334155;font-weight:700">${st.n}</td>
      <td style="padding:8px 6px;text-align:center;color:#10b981;font-weight:700">${st.vol ? volFmt(st.vol) : '—'}</td>
      <td style="padding:8px 6px;text-align:center;font-weight:700;color:${st.kd == null ? '#94a3b8' : st.kd > 50 ? '#ef4444' : st.kd > 30 ? '#f59e0b' : '#10b981'}">${st.kd == null ? '—' : st.kd}</td>
    </tr>`;
  }).join('');
  const compareTable = strategies.length > 1 ? `
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin:10px 0 14px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <thead><tr style="background:#004a99;color:#fff;text-align:left">
        <th style="padding:8px 10px;font-weight:700">Strategy</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:80px">Impact</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:90px">Time to rank</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:64px">Keywords</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:70px">Vol/mo</th>
        <th style="padding:8px 6px;text-align:center;font-weight:700;width:56px">Avg KD</th>
      </tr></thead><tbody>${compareRows}</tbody></table>` : '';

  const stratCards = strategies.map((s, i) => {
    const isRec = s === recommended;
    const accent = ACCENTS[i % ACCENTS.length];
    const st = statsOf(s);
    // The numbers live in the comparison table above; the summary carries what
    // that table can't — the theme in words — plus the one stat it omits (how
    // much of the strategy is already ranking). No duplicated columns.
    const theme = s.focus_area || s.focus || '';
    // The default disclosure marker (▶/▼) is the affordance here — it rotates on
    // open for free, which no static chevron can. It only renders inline if the
    // summary's content is one inline-level box, hence the inline-block wrapper.
    return `<details${isRec ? ' open' : ''} style="border:1px solid ${isRec ? '#bfdbfe' : '#e2e8f0'};border-left:4px solid ${accent};border-radius:12px;margin:10px 0;background:#fff;overflow:hidden">
      <summary style="cursor:pointer;padding:12px 14px 12px 8px;background:${isRec ? '#f0f9ff' : '#fff'};color:#94a3b8">
        <div style="display:inline-block;width:calc(100% - 24px);vertical-align:top">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="width:22px;height:22px;border-radius:6px;background:${accent};color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${i + 1}</span>
            <strong style="font-size:15px;color:#0f172a">${esc(s.name)}</strong>
            ${isRec ? '<span style="background:#3b82f6;color:#fff;border-radius:999px;padding:2px 10px;font-size:10px;font-weight:700">RECOMMENDED</span>' : ''}
            ${st.ranking ? `<span style="margin-left:auto">${pill(String(st.ranking), 'already top 10', '#10b981')}</span>` : ''}
          </div>
          ${theme ? `<div style="margin-top:6px;font-size:12.5px;color:#475569;line-height:1.5">${esc(theme)}</div>` : ''}
        </div>
      </summary>
      <div style="padding:0 14px 14px;border-top:1px solid #f1f5f9">
        ${field('Content approach', s.content_approach)}
        <div style="margin-top:10px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b">Target keywords</div>${kwTable(s.target_keywords)}</div>
      </div>
    </details>`;
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
    <h3 style="margin:0 0 6px;font-weight:700;font-size:16px">Keyword strategy options <span style="font-weight:400;color:#64748b">— ${strategies.length} to choose from</span></h3>
    <p style="margin:0;color:#64748b;font-size:12px">Vol = monthly search volume · KD = keyword difficulty · Rank = your current position${strategies.length > 1 ? ' · click a strategy to see its keywords' : ''}</p>
    ${compareTable}
    ${stratCards}
    ${strengths ? `<h3 style="margin:18px 0 6px;font-weight:700;font-size:16px">✅ What you're doing well</h3><ul style="margin:0;padding-left:18px;font-size:13px">${strengths}</ul>` : ''}
    ${recList.length ? `<h3 style="margin:18px 0 6px;font-weight:700;font-size:16px">🎯 Prioritised action plan <span style="font-weight:400;color:#64748b">— ${recList.length} actions for “${esc(recommended.name)}”</span></h3>${statsBanner}${recSections}` : ''}`;
}

// ── Technical SEO crawl: async job + live rows ───────────────────────────────
// Same shape as the Content Optimiser's job (start → background finalizer →
// browser polls `status`), so the React page's generic job path drives it with
// no tool-specific code. See contentWriterGateway for the annotated original.
const crawlJobKey = (jobId) => `crawl_job:${jobId}`;
const CRAWL_JOB_TTL = 2 * 60 * 60; // 2h — re-openable from History / the notification
const CRAWL_MAX_MS = 11 * 60 * 1000; // hard cap on the poll loop, well inside the 900s Lambda
const CRAWL_TAIL_MS = 90_000; // reserve for the AI prioritisation pass after the loop

async function crawlStage(jobId, patch) {
  if (!jobId) return; // sync runs and tests have no job to write to
  const job = await getCache(crawlJobKey(jobId)).catch(() => null);
  if (job && job.status !== 'done' && job.status !== 'error') {
    await putCache(crawlJobKey(jobId), { ...job, status: 'running', ...patch }, CRAWL_JOB_TTL).catch(() => {});
  }
}

// The job is one DynamoDB item (400KB). An oversized put throws, crawlStage
// swallows it, and the user gets a spinner with no rows and no error — so trim
// the live table instead of betting on the limit. The count in `stage`/`progress`
// still reports every page found, and the finished result (a different item,
// saved by saveRun) always carries them all.
const CRAWL_PARTIAL_MAX_BYTES = 300 * 1024;

/** Publish the rows found so far. Whole snapshot, never a delta — see crawlRun.
 *  Progress reporting must never be able to fail the run producing it. */
async function crawlPublish(jobId, pages, progress, maxPages, teased) {
  if (!jobId || !pages.length) return;
  const rows = crawlRows(pages);
  const summary = crawlSummary(rows, progress);
  let partial = crawlPartial(rows, summary, teased);
  while (JSON.stringify(partial).length > CRAWL_PARTIAL_MAX_BYTES && rows.length > 1) {
    rows.length = Math.floor(rows.length / 2);
    partial = crawlPartial(rows, summary, teased);
  }
  await crawlStage(jobId, {
    stage: `Crawling — ${summary.pagesCrawled} page${summary.pagesCrawled === 1 ? '' : 's'} so far`,
    progress: { done: summary.pagesCrawled, total: Math.max(summary.pagesCrawled, maxPages), label: 'pages crawled' },
    partial,
  }).catch(() => {});
}

async function crawlGateway(body, tool) {
  // Poll job progress (browser live-progress; never charged).
  if (String(body.cwAction || '').trim() === 'status') {
    const job = await getCache(crawlJobKey(body.jobId)).catch(() => null);
    if (!job) return { _noCharge: true, status: 'unknown' };
    const { inputs, ...pub } = job; // don't ship the inputs back
    return { _noCharge: true, ...pub };
  }

  // The charged run — invoked by the background finalizer via a synthetic
  // authenticated gateway event, never directly by the browser.
  if (body._crawlFinalize) {
    const inputs = { ...body };
    delete inputs._crawlFinalize; delete inputs._crawlJobId;
    return crawlRun({ ...inputs, _jobId: body._crawlJobId }, tool);
  }

  // Default: start a background job and return its id immediately. Validate the
  // one hard requirement up front rather than spinning up a job that can only
  // fail (the run re-checks; this is just the fast path).
  if (!(body.input || body.url || '').trim()) {
    return { _failed: true, text: 'Add a website URL to crawl — no credits were charged.' };
  }
  const jobId = `crawl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const inputs = { ...body };
  delete inputs._email; delete inputs._integrations; delete inputs._userId; delete inputs._tier; delete inputs._isStaff;
  await putCache(crawlJobKey(jobId), {
    jobId, status: 'starting', stage: 'Queued',
    userId: body._userId || body._email, email: body._email, tier: body._tier,
    projectId: body.projectId || null,
    inputs, createdAt: new Date().toISOString(),
  }, CRAWL_JOB_TTL);
  await selfInvokeFinalize(jobId, 'technical-seo');
  return { _noCharge: true, jobId, status: 'starting' };
}

// Background worker: run the (charged) crawl by re-entering the gateway handler,
// so billing, history and the "run complete" notification all flow through the
// one canonical path, then store the finished result for the browser to adopt.
async function crawlFinalize(event, context) {
  const jobId = event.jobId;
  const job = await getCache(crawlJobKey(jobId)).catch(() => null);
  if (!job) { console.error('crawl_finalize_missing_job', jobId); return; }

  try {
    await putCache(crawlJobKey(jobId), { ...job, status: 'running', stage: 'Starting the crawl' }, CRAWL_JOB_TTL).catch(() => {});
    const synthetic = {
      rawPath: '/run/technical-seo',
      requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId: job.userId, email: job.email, tier: job.tier } } },
      headers: {},
      body: JSON.stringify({ ...job.inputs, _crawlFinalize: true, _crawlJobId: jobId, projectId: job.projectId || undefined }),
    };
    const guard = cwDeadlineGuard(context);
    let resp;
    try { resp = await Promise.race([handler(synthetic, context), guard.promise]); }
    finally { guard.cancel(); }
    const parsed = JSON.parse(resp?.body || '{}');
    const status = resp?.statusCode || 200;
    if (status === 402) throw new Error('You ran out of credits before this run. Top up and try again — nothing was charged.');
    if (status >= 300) throw new Error(parsed.error || 'The crawl failed. No credits were charged.');
    if (parsed.failed || parsed.result?._failed) throw new Error(parsed.result?.text || 'The crawl failed. No credits were charged.');

    await putCache(crawlJobKey(jobId), {
      jobId, status: 'done',
      result: parsed.result || {},
      runId: parsed.runId || null,
      creditsUsed: parsed.creditsUsed,
      creditsRemaining: parsed.creditsRemaining,
      topupRemaining: parsed.topupRemaining,
      finishedAt: new Date().toISOString(),
    }, CRAWL_JOB_TTL);
  } catch (e) {
    // At the deadline the crawl may already have finished and charged — we just
    // lost the race to record it. Never assert "no credits were charged" here.
    const timedOut = e?.message === CW_DEADLINE;
    const msg = timedOut
      ? 'This crawl took longer than we allow, so we lost track of it. Check History in a few minutes — if it finished, the result is there. If it never appears, nothing was charged.'
      : (e?.message || 'The crawl failed. No credits were charged.');
    if (timedOut) console.error('crawl_finalize_deadline', jobId);
    await putCache(crawlJobKey(jobId), {
      jobId, status: 'error', error: msg, finishedAt: new Date().toISOString(),
    }, CRAWL_JOB_TTL).catch(() => {});
    try {
      await addNotification({
        userId: job.userId,
        title: '⚠️ Technical SEO Crawler run could not finish',
        body: (timedOut ? 'It ran long — check History; the result may still have landed.' : (e?.message || 'Please try running it again.')).slice(0, 140),
        link: '/history',
        kind: 'alert',
      });
    } catch { /* best-effort */ }
  }
}

// ── Technical SEO / Forensic Audit: DataForSEO async crawl ────────────────────
// initiate(task) → poll get_results every 5s until crawl_progress != in_progress
// or we approach the Lambda timeout. Aggregates per-page rows + a summary.
//
// DataForSEO hands pages back in batches as it finds them, so the rows exist
// long before the crawl finishes. When this runs as a background job (the normal
// path — see crawlGateway) each poll publishes the table-so-far onto the job the
// browser is already polling, so the page fills in instead of showing a spinner
// for two minutes. Publishing is snapshot-based for the same reason cwPublish is:
// the job write is read-modify-write, so a lost append would drop rows for good
// while a lost snapshot self-heals on the next poll.
async function crawlRun(body, tool) {
  const url = UPSTREAMS.dataforseoCrawler;
  const target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A website URL is required.');

  const deep = tool.id === 'forensic-audit';
  const maxPages = clampInt(body.maxPages, deep ? 30 : 10, 1, deep ? 100 : 50);
  const maxDepth = clampInt(body.maxDepth, deep ? 3 : 4, 1, 10);

  const jobId = body._jobId || null;
  // Below-tier runs are teaser runs: the finished result gets reduced to the
  // summary, so the live view must not stream the page table either.
  const teased = !!body._tier && !tierMeets(body._tier, tool.minTier);
  await crawlStage(jobId, { stage: 'Starting the crawl', progress: { done: 0, total: maxPages, label: 'pages crawled' } });

  const init = await postUpstream(url, { action: 'initiate', url: target, max_pages: maxPages, max_depth: maxDepth });
  const taskId = init?.tasks?.[0]?.id;
  if (!taskId) throw new Error('The crawler did not accept the task. Check the URL and try again.');

  // As a background job we get the finalizer's budget (MeteringFn is 900s), not
  // the 180s the old buffered request had. Leave room for the AI pass that runs
  // after the loop, and never outlast the invocation itself.
  const budgetMs = Math.min(CRAWL_MAX_MS, Math.max(60_000, msRemaining() - CRAWL_TAIL_MS));
  const deadline = Date.now() + budgetMs;
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
    const done = result?.crawl_progress && result.crawl_progress !== 'in_progress';
    if (done) progress = result.crawl_progress;
    // Push the rows found so far (and the running summary) to the browser.
    await crawlPublish(jobId, [...seen.values()], progress, maxPages, teased);
    if (done) break;
  }

  const pages = [...seen.values()];
  if (!pages.length) {
    return { text: 'The crawl started but returned no pages within the time limit. Try a smaller page count or check the URL.' };
  }

  const rows = crawlRows(pages);
  const summary = crawlSummary(rows, progress);
  await crawlStage(jobId, { stage: 'Prioritising the fixes', progress: { done: rows.length, total: Math.max(rows.length, maxPages), label: 'pages crawled' } });
  const rec = await aiRecommendations({
    label: 'Technical SEO Crawler',
    context: 'Prioritise the technical SEO fixes that will most improve crawlability and rankings, based on the crawled pages, on-page scores and issue counts.',
    findings: `${summaryToFindings(summary)}\nPages (url; status; on-page score; issue count):\n${rowsToFindings(rows)}`,
  });
  return withRecs({ rows, summary }, rec);
}

/** Crawled page items → the table rows the result (and the live view) render. */
function crawlRows(pages) {
  return pages.map((p) => ({
    url: p.url,
    status: p.status_code ?? '—',
    title: p.meta?.title || '—',
    h1: p.meta?.htags?.h1?.[0] || '—',
    score: p.onpage_score != null ? Math.round(p.onpage_score) : '—',
    issues: pageIssues(p),
  }));
}

/** Headline numbers over the rows crawled so far. */
function crawlSummary(rows, progress) {
  const scored = rows.map((r) => (typeof r.score === 'number' ? r.score : null)).filter((n) => n != null);
  return {
    pagesCrawled: rows.length,
    avgOnPageScore: scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : null,
    pagesWithIssues: rows.filter((r) => r.issues > 0).length,
    status: progress === 'in_progress' ? 'partial (still crawling)' : 'complete',
  };
}

/** The live view: the same rows and summary the finished result carries, as
 *  sections (the only shape the in-progress renderer speaks).
 *
 *  `teased` is a below-tier run, which applyTeaser will reduce to summary-only
 *  when it finishes — so the live view must stop at the summary too. Streaming
 *  the page table and then locking it on completion would hand out the paid
 *  detail for the length of the crawl and read as a bug when it disappeared. */
function crawlPartial(rows, summary, teased) {
  if (!rows.length) return [];
  const stats = { type: 'stats', title: 'Crawl so far', items: [
    { label: 'Pages crawled', value: summary.pagesCrawled },
    { label: 'Pages with issues', value: summary.pagesWithIssues, tone: summary.pagesWithIssues ? 'amber' : 'green' },
    { label: 'Avg on-page score', value: summary.avgOnPageScore ?? '—' },
  ] };
  if (teased) return [stats];
  return [
    stats,
    { type: 'table', title: 'Pages', columns: ['url', 'status', 'title', 'h1', 'score', 'issues'], rows },
  ];
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

// ── Page Speed Check ──────────────────────────────────────────────────────────
// One URL, two PageSpeed calls (mobile + desktop), nothing else. Exists so the
// dashboard's Page speed card can refresh ITSELF: its "Re-run" used to open the
// GEO+SEO Forensic Audit, a 50-credit, ~2-minute, thirty-probe run, just to
// update two numbers the user was already looking at.
//
// Returns `summary` in the same shape the forensic audit's summary uses for
// these two fields, so the card can merge the result into its stored run without
// any special-casing on the client.
async function pageSpeedRun(body) {
  let target = (body.input || body.url || '').trim();
  if (!target) throw new Error('A page URL is required.');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  try { new URL(target); } catch { throw new Error('Invalid URL format.'); }

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const tryJson = (payload, ms) =>
    withTimeout(postUpstream(UPSTREAMS.pageSpeed, payload), ms).catch(() => null);

  // `checks` skips the malware + robots.txt probes this tool has never shown.
  const [psmRes, psdRes] = await Promise.all([
    tryJson({ url: target, strategy: 'mobile', checks: ['pagespeed'] }, 55000),
    tryJson({ url: target, strategy: 'desktop', checks: ['pagespeed'] }, 55000),
  ]);

  return sectionsPageSpeed(psmRes, psdRes, target);
}

function sectionsPageSpeed(psmRes, psdRes, target) {
  const parsePS = (v) => { if (v == null) return null; const n = parseInt(String(v), 10); return Number.isNaN(n) ? null : n; };
  const mobile = psmRes ? parsePS(psmRes.pagespeed) : null;
  const desktop = psdRes ? parsePS(psdRes.pagespeed) : null;

  // Both probes failed → a soft failure, so the gateway surfaces the message and
  // charges nothing. Credits are for results.
  if (mobile == null && desktop == null) {
    return { _failed: true, text: 'Google PageSpeed could not score that URL. Check the page is publicly reachable and try again.' };
  }

  const tone = (v) => (v == null ? 'slate' : v >= 90 ? 'green' : v >= 50 ? 'amber' : 'red');
  const rateTone = (r) => (r === 'good' ? 'green' : r === 'needs work' ? 'amber' : r === 'poor' ? 'red' : 'slate');
  const dash = '—';
  // Google's published "good" thresholds for each metric — the boundary below
  // which a green rating is earned. Shown next to every number so a value like
  // a layout shift of 1 reads against the 0.1 it's meant to beat, rather than
  // just being coloured red with no scale.
  const GOOD = {
    lcp: 'under 2.5s', inp: 'under 200ms', cls: 'under 0.1', ttfb: 'under 0.8s',
    fcp: 'under 1.8s', tbt: 'under 200ms', speedIndex: 'under 3.4s',
  };
  const sections = [];

  sections.push({ type: 'stats', title: 'Google PageSpeed score', items: [
    { label: 'Mobile', value: mobile ?? dash, tone: tone(mobile), sub: 'Good: 90+' },
    { label: 'Desktop', value: desktop ?? dash, tone: tone(desktop), sub: 'Good: 90+' },
  ] });

  // Mobile carries the field data we lead on: it's the strategy whose CrUX
  // sample matches how most visitors actually arrive.
  const field = psmRes?.field || psdRes?.field || null;
  const fmt = (m) => (m?.value == null ? dash
    : m.unit === 'score' ? String(m.value)
    : m.value >= 1000 ? `${(m.value / 1000).toFixed(1)}s` : `${Math.round(m.value)}ms`);

  if (field) {
    const m = field.metrics || {};
    const order = [['lcp', 'Largest Contentful Paint'], ['inp', 'Interaction to Next Paint'], ['cls', 'Layout shift'], ['ttfb', 'Server response']];
    const shown = order.filter(([k]) => m[k]);
    // Each card carries its own good target as a subtitle, so a value like a
    // layout shift of 1 is read against the 0.1 it's meant to beat right where
    // the number is, and the colour has an explicit scale.
    sections.push({ type: 'stats', title: 'What real visitors experience', items:
      shown.map(([k, label]) => ({ label, value: fmt(m[k]), tone: rateTone(m[k].rating), sub: `Good: ${GOOD[k]}` })) });

    // The whole point of the section: when the lab score is healthy and the
    // field verdict isn't, say so plainly rather than letting the green score
    // speak for the page.
    const labGood = (mobile ?? 0) >= 90;
    const scope = field.originFallback
      ? 'across your whole site (this page alone has too few visitors to report on its own)'
      : 'on this page';
    if (field.overallRating === 'poor' || field.overallRating === 'needs work') {
      sections.push({ type: 'callout', text: labGood
        ? `Your lab score is good, but Google rates the real-world experience ${scope} as "${field.overallRating}". A page can test fast on a clean run and still feel slow to visitors — banners, ads and late-loading images shift the page around after it appears. Trust this section over the score above.`
        : `Google rates the real-world experience ${scope} as "${field.overallRating}". Fixing the worst metric below will move both this and the score above.` });
    } else {
      sections.push({ type: 'callout', text: `Google rates the real-world experience ${scope} as "${field.overallRating || 'good'}" — this is measured on your actual visitors over the last 28 days, not a simulated test.` });
    }
  } else {
    sections.push({ type: 'callout', text: 'Google has no real-visitor data for this page yet — that needs a few thousand visits over 28 days. The scores above are lab tests on a simulated phone and desktop, which is a good proxy but not the same as what your visitors feel.' });
  }

  const lab = psmRes?.lab || {};
  const labRows = [
    ['lcp', 'Largest Contentful Paint', lab.lcp, 'How long until the main content appears'],
    ['tbt', 'Total Blocking Time', lab.tbt, 'How long the page ignores taps while it loads'],
    ['cls', 'Cumulative Layout Shift', lab.cls, 'How much the page jumps around as it loads'],
    ['fcp', 'First Contentful Paint', lab.fcp, 'How long until anything appears'],
    ['speedIndex', 'Speed Index', lab.speedIndex, 'How quickly the page fills in visually'],
  ].filter(([, , v]) => v);
  if (labRows.length) {
    sections.push({ type: 'table', title: 'Lab measurements (simulated mobile)',
      columns: ['Metric', 'Value', 'Good range', 'What it means'],
      rows: labRows.map(([key, label, v, means]) => ({ Metric: label, Value: v.display ?? dash, 'Good range': GOOD[key] || dash, 'What it means': means })) });
  }

  // Costed in the time and weight each fix saves, worst first, so the list
  // doubles as the running order.
  //
  // An absent `opportunities` key is NOT an empty one: an older upstream that
  // doesn't send the field would otherwise be reported as "nothing left to
  // fix", which is the same mistake as reading a green lab score as proof the
  // page is fast. Stay silent unless the upstream actually looked.
  const oppSrc = Array.isArray(psmRes?.opportunities) ? psmRes
    : Array.isArray(psdRes?.opportunities) ? psdRes : null;
  const opps = oppSrc ? oppSrc.opportunities : [];
  if (opps.length) {
    sections.push({ type: 'cards', title: 'What to fix, biggest win first',
      note: 'Savings are Google’s estimate for this page on mobile.',
      items: opps.slice(0, 10).map((o) => ({
        title: o.title,
        // Google writes these descriptions in markdown and the card renders
        // plain text, so a doc link arrives as literal "[label](url)" brackets.
        // The label alone reads as a sentence; "How do I do this?" is the way
        // through to detail from here.
        body: `${(o.description || '').replace(/\[([^\]]+)\]\(https?:[^)]*\)\.?/g, '$1.')}${o.display ? `\n\nGoogle estimates: ${o.display}.` : ''}`.trim(),
        meta: [o.savingsMs ? `saves ~${Math.round(o.savingsMs)}ms` : null,
               o.savingsBytes ? `${Math.round(o.savingsBytes / 1024)}KB lighter` : null].filter(Boolean).join(' · '),
      })) });
  } else if (oppSrc) {
    sections.push({ type: 'text', text: 'Google found no significant loading opportunities left on this page — nothing worth fixing in the way the page is built and delivered.' });
  }

  sections.push({ type: 'text', text: `Scored ${target}. 90+ is good, 50–89 needs work, under 50 is poor.` });

  return { summary: { pageSpeedMobile: mobile, pageSpeedDesktop: desktop, target }, sections };
}

// ── Digimetrics Authority Score ───────────────────────────────────────────────
// Our own 0-100 domain-strength metric. It replaces the third-party suite
// authority numbers the audit used to proxy in: those vendors' terms forbid
// reselling or repackaging their metrics, so we can neither store nor display
// them. This is computed from DataForSEO data we ARE licensed to repackage.
//
// Primary input is DataForSEO's backlink `rank` (0-1000), which is already a
// log-shaped authority signal — a straight /10 rescale keeps its ordering and
// lands on the 0-100 range users expect. When rank is absent we fall back to a
// log curve over referring domains (1 ref domain ≈ 0, ~100k ≈ 100), which tracks
// the same shape closely enough to be useful rather than blank.
export function authorityScore(siteRes) {
  const rank = Number(siteRes?.domain_rank);
  if (Number.isFinite(rank) && rank > 0) return Math.max(0, Math.min(100, Math.round(rank / 10)));
  const refs = Number(siteRes?.referring_domains);
  if (Number.isFinite(refs) && refs > 0) {
    return Math.max(0, Math.min(100, Math.round((Math.log10(refs) / 5) * 100)));
  }
  return null;
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

  // Kick everything off in parallel. The performance grade + the internal-duplication crawl
  // are the long poles; the rest resolve in well under 30s.
  const homeHtmlP = getHtmlBody(rootDomain, 30000);
  const copyscapeP = homeHtmlP.then((html) => {
    const text = faStripHtml(html).slice(0, 5000);
    if (text.length < 100) return null;
    return tryJson(UPSTREAMS.copyscape, { text }, 30000);
  });

  const [
    siteRes, psmRes, psdRes, sslRes, gtRes,
    homeHtml, robotsBody, llmsBody, llmsFullBody, notFoundBody, httpBody,
    copyscapeRaw, sitelinerItems,
  ] = await Promise.all([
    tryJson(UPSTREAMS.forensicSiteData, { url: baseDomain }, 25000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain }, 60000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain, strategy: 'desktop' }, 60000),
    tryJson(UPSTREAMS.sslCheck, { url: domain }, 20000),
    tryJson(UPSTREAMS.gtmetrix, { url: rootDomain }, 75000),
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

  // 2. Authority Score — our own 0-100 metric (see authorityScore()), never a
  //    third-party suite's proprietary authority number.
  d.da = authorityScore(siteRes);

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

  // 6. Performance grade
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

  // 12. External duplicate % — postUpstream already unwrapped the envelope.
  if (copyscapeRaw && copyscapeRaw.originality_score !== undefined) {
    d.copyscape = Math.max(0, Math.round(100 - Number(copyscapeRaw.originality_score)));
  }

  // 13. Internal duplication, computed from our own crawl
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
    // Provenance marker. Runs stored before 2026-07-20 carry a third-party
    // suite's authority number in `domainAuthority`; without this stamp the UI
    // and the trend series can't tell the two apart and would relabel vendor
    // data as ours. Absent marker => the reader hides the number.
    authoritySource: d.da == null ? null : 'digimetrics',
    pageSpeedMobile: d.psm,
    pageSpeedDesktop: d.psd,
    ssl: d.ssl,
    structuredData: d.structdata || null,
    llmsTxt: d.llmstxt || null,
    backlinks: d.backlinks,
    spamScore: d.spam,
    pagesCrawled: Array.isArray(sitelinerItems) ? sitelinerItems.length : 0,
  };

  return { sections: faSections(d, recs, score, sevCounts), summary };
}

// ── SEO Diagnostics: guided keyword → fix wizard ──────────────────────────────
// The React wizard gathers inputs across five steps (manual domain + keywords,
// keyword-opportunity bucketing, GA4/GSC context, technical checks, diagnosis);
// this is the single CHARGED step. It fans out the same technical probes the
// forensic audit uses (reusing its finding engine + fa* scoring), adds a live
// SERP-landscape lane (moreSerps), folds in pasted GA4/GSC context, and asks the
// AI for a prioritised remediation narrative. Returns render-ready `sections`.
// No third-party rank-tracking suite is involved — Step 1 is manual/project-domain entry.
const SDX_BUCKETS = {
  striking:  { label: 'Low-hanging fruit', desc: 'Pos 4-15 — one push to page 1', tone: 'green' },
  declining: { label: 'Declining', desc: 'Dropped 3+ positions', tone: 'red' },
  page2:     { label: 'Page 2+', desc: 'Pos 16-30', tone: 'amber' },
  missing:   { label: 'Not ranking', desc: 'No/low position, has volume', tone: 'blue' },
  strong:    { label: 'Already strong', desc: 'Pos 1-3', tone: 'slate' },
  other:     { label: 'Other', desc: 'Low volume / unranked', tone: 'slate' },
};
function sdxBucketFor(k) {
  const pos = k.position, ch = k.change || 0, vol = k.volume || 0;
  if (pos != null && pos >= 1 && pos <= 3) return 'strong';
  if (ch <= -3 && pos != null && pos <= 30) return 'declining';
  if (pos != null && pos >= 4 && pos <= 15) return 'striking';
  if (pos != null && pos >= 16 && pos <= 30) return 'page2';
  if ((pos == null || pos > 30) && vol > 0) return 'missing';
  return 'other';
}

// ── Step 2 "Get rankings" ─────────────────────────────────────────────────────
// The wizard used to ask people to hand-type `keyword, volume, position, change`,
// so the table was mostly em-dashes and the buckets — which key off position and
// volume — collapsed to "Other". This fills those columns from real data:
//
//   rankingKeywords(domain) → every keyword the domain ALREADY ranks for, with
//                             search volume, position and difficulty.
//   mangoolsKeywords(list)  → volume + difficulty for keywords they typed. A
//                             keyword the site does not rank for simply has no
//                             row in the first map; that's the "Not ranking"
//                             bucket (the point of the tool), not missing data.
//
// Priced as a keyword lookup, not the tool's ai_long diagnosis — see runTool.
async function sdxRankings(body) {
  const target = cleanDomain(body.input || body.url || body.domain);
  if (!target) return { _failed: true, text: 'Enter your domain in step 1 first — rankings are looked up against it.' };
  const location = String(body.location || 'Singapore');
  const language = String(body.language || 'English');
  // Accepts either the wizard's row objects or a plain list of strings.
  const typed = [...new Set((Array.isArray(body.keywords) ? body.keywords : splitItems(body.keywords))
    .map((k) => String((k && k.keyword) ?? k ?? '').trim()).filter(Boolean).slice(0, 50))];

  const [rankedRaw, metricsRaw] = await Promise.all([
    postUpstream(UPSTREAMS.rankingKeywords, { target, location, user: body._email || 'saas' })
      .then(deepBody).catch(() => null),
    typed.length
      ? postUpstream(UPSTREAMS.mangoolsKeywords, { keywords: typed, location, language }).then(deepBody).catch(() => null)
      : null,
  ]);
  // Upstream Lambda error envelopes must not become keyword rows (they'd render
  // "errorMessage" as a keyword and still bill). Treat them as absent.
  const usable = (m) => (m && typeof m === 'object' && !m.errorMessage && !m.errorType && !m.stackTrace) ? m : {};
  const ranked = usable(rankedRaw);
  const metrics = usable(metricsRaw);

  // The upstreams echo keywords back with their own casing/spacing, so match on
  // a normalised key rather than the string the user typed.
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  const rankedByKey = new Map(Object.entries(ranked).map(([k, v]) => [norm(k), { keyword: k, m: v || {} }]));
  // mangoolsKeywords returns a row for EVERY keyword asked for, with all-null
  // fields when it knows nothing — so "has a row" is not "has data".
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  // The two upstreams disagree on the difficulty scale: rankingKeywords answers
  // 0-1 (0.12, 0.55) and mangoolsKeywords answers 0-100 (26, 23). Verified by
  // curl on 2026-07-24. Normalise on the SOURCE, not the magnitude — a real KD
  // of 1 is indistinguishable from a fractional 1.0 by value alone.
  // The null/'' guard is load-bearing: mangools sends `difficulty: null` for a
  // keyword it doesn't know, and Number(null) is 0 — which would print as a
  // confident "KD 0" (easiest possible keyword) for a keyword with no data at all.
  const kd = (v, fractional) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(100, Math.round(fractional ? n * 100 : n));
  };

  const rowFor = (keyword, r, m) => ({
    keyword,
    volume: num(r.search_volume ?? r.volume ?? m.search_volume ?? m.volume),
    position: num(r.rank ?? r.best_position ?? r.position),
    // Position history isn't part of either upstream, so the wizard hides the Δ
    // column unless the user pasted their own changes. Never invent one.
    change: null,
    difficulty: r.difficulty != null ? kd(r.difficulty, true) : kd(m.difficulty, false),
    url: r.url ?? r.relative_url ?? r.relevant_url ?? null,
  });

  let rows;
  if (typed.length) {
    rows = typed.map((keyword) => {
      const hit = rankedByKey.get(norm(keyword));
      return rowFor(keyword, hit?.m || {}, metrics[keyword] || metrics[norm(keyword)] || {});
    });
  } else {
    // Empty box: give them the site's own ranking keywords rather than an error.
    rows = [...rankedByKey.values()].map(({ keyword, m }) => rowFor(keyword, m, {}));
  }
  rows.sort((a, b) => (b.volume || 0) - (a.volume || 0));
  rows = rows.slice(0, 100);

  if (!rows.length) {
    return { _failed: true, text: typed.length
      ? 'No data came back for those keywords — no credits were charged. Check the spelling, or try a different location.'
      : `We couldn't find any keywords ${target} ranks for in ${location} — no credits were charged. Paste the keywords you want to diagnose instead.` };
  }
  return { rows, matched: rows.filter((r) => r.position != null).length, _skipHistory: true };
}

async function seoDiagnosticsRun(body) {
  let target = String(body.input || body.url || body.domain || '').trim();
  if (!target) return { _failed: true, text: 'A domain is required.' };
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { return { _failed: true, text: 'Invalid domain.' }; }
  const rootDomain = u.origin, domain = u.hostname, baseDomain = domain.replace(/^www\./, '');

  const keywords = (Array.isArray(body.keywords) ? body.keywords : []).map((k) => ({ ...k, bucket: sdxBucketFor(k) }));
  const selected = keywords.filter((k) => k && k._sel);
  const selKws = (selected.length ? selected : keywords).slice(0, 8);
  const loc = { location: String(body.location || 'Singapore'), language: String(body.language || 'English') };
  const ga4Text = String(body.ga4 || '').trim();
  const gscText = String(body.gsc || '').trim();

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const tryJson = (url, payload, ms) => withTimeout(postUpstream(url, payload), ms).catch(() => null);
  const getHtmlBody = (path, ms) => withTimeout(postUpstream(UPSTREAMS.getHtml, { url: path }), ms)
    .then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : ''))).catch(() => '');

  // Technical lanes (a focused subset of the forensic probes).
  const [siteRes, psmRes, psdRes, sslRes, gtRes, homeHtml, robotsBody, llmsBody, llmsFullBody, serp] = await Promise.all([
    tryJson(UPSTREAMS.forensicSiteData, { url: baseDomain }, 25000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain }, 60000),
    tryJson(UPSTREAMS.pageSpeed, { url: rootDomain, strategy: 'desktop' }, 60000),
    tryJson(UPSTREAMS.sslCheck, { url: domain }, 20000),
    tryJson(UPSTREAMS.gtmetrix, { url: rootDomain }, 75000),
    getHtmlBody(rootDomain, 30000),
    getHtmlBody(rootDomain + '/robots.txt', 20000),
    getHtmlBody(rootDomain + '/llms.txt', 15000),
    getHtmlBody(rootDomain + '/llms-full.txt', 15000),
    sdxSerp(selKws, baseDomain, loc).catch(() => ({ byKeyword: {}, checked: 0 })),
  ]);

  const d = {
    url: target, ssl: null, da: null, psd: null, psm: null, gtmetrix: '', ga4: '', gsc: '',
    metatitle: '', metadesc: '', robots: '', sitemap: '', https: '', structdata: '', semantic: '',
    llmblock: '', llmstxt: '', llmsfull: '', cms: '', backlinks: null, refdomains: null, spam: null, h1: null, h2: null,
    custom404: '', copyscape: null, siteliner: null,
  };
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
  const parsePS = (v) => { if (v == null) return null; const n = parseInt(String(v), 10); return Number.isNaN(n) ? null : n; };
  if (psmRes) { const p = parsePS(psmRes.pagespeed); if (p != null) d.psm = p; d.sitemap = psmRes.sitemap && psmRes.sitemap !== 'Not Found' ? 'Present' : 'Missing'; }
  if (psdRes) { const p = parsePS(psdRes.pagespeed); if (p != null) d.psd = p; }
  if (sslRes) d.ssl = (sslRes.message && String(sslRes.message).toLowerCase().includes('valid')) ? 'pass' : 'fail';
  const grade = gtRes?.data?.attributes?.gtmetrix_grade; if (grade) d.gtmetrix = grade;
  faParseHomeHtml(homeHtml, d);
  faParseRobots(robotsBody, d);
  d.llmstxt = faValidTxt(llmsBody) ? 'Present' : 'Missing';
  d.llmsfull = faValidTxt(llmsFullBody) ? 'Present' : 'Missing';
  if (ga4Text) d.ga4 = 'Connected';

  // Technical findings via the forensic engine + fa* scoring.
  const recs = generateForensicRecommendations(d);
  recs.forEach((r) => { r.severity = faSeverityFor(r); });
  recs.sort((a, b) => FA_SEV_ORDER[a.severity] - FA_SEV_ORDER[b.severity]);
  const score = faComputeHealthScore(d, recs);
  const sevCounts = { critical: 0, warning: 0, opportunity: 0 };
  recs.forEach((r) => { sevCounts[r.severity]++; });

  // ── Sections ──────────────────────────────────────────────────────────────
  const sections = [];
  sections.push({ type: 'stats', title: 'Diagnosis', items: [
    { label: 'Health score', value: `${score}/100`, tone: score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red' },
    { label: 'Critical', value: String(sevCounts.critical), tone: 'red' },
    { label: 'Warnings', value: String(sevCounts.warning), tone: 'amber' },
    { label: 'Opportunities', value: String(sevCounts.opportunity), tone: 'blue' },
  ] });

  // Keyword opportunity buckets.
  const bucketCounts = {};
  keywords.forEach((k) => { bucketCounts[k.bucket] = (bucketCounts[k.bucket] || 0) + 1; });
  if (keywords.length) {
    sections.push({ type: 'stats', title: 'Keyword opportunities', items: Object.keys(SDX_BUCKETS)
      .filter((b) => bucketCounts[b]).map((b) => ({ label: SDX_BUCKETS[b].label, value: String(bucketCounts[b]), tone: SDX_BUCKETS[b].tone })) });
    const kwRows = keywords
      .filter((k) => ['striking', 'declining', 'page2', 'missing'].includes(k.bucket))
      .sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 50)
      .map((k) => ({ Keyword: k.keyword, Volume: k.volume ?? '—', Position: k.position ?? '—', Change: k.change ?? '—', Opportunity: SDX_BUCKETS[k.bucket].label }));
    if (kwRows.length) sections.push({ type: 'table', title: 'Under-performing keywords', columns: ['Keyword', 'Volume', 'Position', 'Change', 'Opportunity'], rows: kwRows });
  }

  // Live SERP landscape.
  const serpRows = Object.entries(serp.byKeyword || {}).map(([kw, v]) => ({
    Keyword: kw,
    'Live position': v.livePos ? `#${v.livePos}` : 'not in top 20',
    'Ranks above you': v.above && v.above.length ? v.above.map((a) => a.domain).slice(0, 5).join(', ') : 'nothing ranks above you',
    'SERP features': v.features && v.features.length ? v.features.join(', ') : '—',
  }));
  if (serpRows.length) sections.push({ type: 'table', title: `Live SERP landscape · ${loc.location}`, columns: ['Keyword', 'Live position', 'Ranks above you', 'SERP features'], rows: serpRows });

  // Full technical report (reuse the forensic renderer).
  // Embedded under the wizard's own verdict — rename the heading and drop the
  // duplicate health-score stats (already shown in the Diagnosis block above).
  sections.push(...faSections(d, recs, score, sevCounts, { title: 'Technical audit', skipSummary: true }));

  // AI executive summary + prioritised next steps.
  const findings = sdxFindingsText(d, recs, bucketCounts, serp, ga4Text, gscText);
  const rec = await aiRecommendations({
    label: 'SEO Diagnostics',
    context: `Domain ${baseDomain}. Market ${loc.location}. Prioritise fixes that lift the flagged under-performing keywords toward page 1.`,
    findings,
  });
  if (rec) sections.push(rec);

  const summary = {
    healthScore: score, issues: recs.length, critical: sevCounts.critical, warning: sevCounts.warning,
    opportunity: sevCounts.opportunity, keywords: keywords.length, serpChecked: serp.checked || 0,
    pageSpeedMobile: d.psm, pageSpeedDesktop: d.psd, ssl: d.ssl,
  };
  return { sections, summary };
}

// Live SERP landscape via moreSerps — who ranks above the domain for each keyword.
async function sdxSerp(kws, domain, loc) {
  const list = (kws || []).map((k) => k && k.keyword).filter(Boolean).slice(0, 8);
  if (!list.length || !domain) return { byKeyword: {}, checked: 0 };
  const byKeyword = {}; let checked = 0;
  const results = await Promise.allSettled(list.map(async (kw) => {
    const raw = deepBody(await postUpstream(UPSTREAMS.moreSerps, {
      keyword: kw, language: loc.language, location: loc.location, page_types: 'any', limit: 20,
    }, { timeoutMs: 30000 }));
    const data = raw && typeof raw === 'object' ? raw : {};
    const entries = Object.values(data).filter((e) => e && (e.url || e.domain))
      .map((e, i) => ({ rank: e.rank || (i + 1), domain: cleanDomain(e.url || e.domain || ''), title: e.title || '', type: e.type || e.page_type || 'organic' }))
      .sort((a, b) => a.rank - b.rank);
    if (!entries.length) return;
    let livePos = null;
    for (const e of entries) { if (e.domain && (e.domain === domain || e.domain.endsWith('.' + domain) || domain.endsWith('.' + e.domain))) { livePos = e.rank; break; } }
    const above = (livePos ? entries.filter((e) => e.rank < livePos) : entries).filter((e) => e.domain && e.domain !== domain).slice(0, 8);
    const features = [...new Set(entries.filter((e) => e.type && e.type !== 'organic').map((e) => e.type))];
    byKeyword[kw] = { livePos, above, features };
    checked++;
  }));
  void results;
  return { byKeyword, checked };
}

// Compact everything into a findings brief for the AI recommendations pass.
function sdxFindingsText(d, recs, bucketCounts, serp, ga4Text, gscText) {
  const lines = [];
  lines.push(`Health score: ${faComputeHealthScore(d, recs)}/100. SSL: ${d.ssl || 'unknown'}. PageSpeed mobile: ${d.psm ?? 'n/a'}, desktop: ${d.psd ?? 'n/a'}. Performance grade: ${d.gtmetrix || 'n/a'}. Structured data: ${d.structdata || 'n/a'}. Sitemap: ${d.sitemap || 'n/a'}. llms.txt: ${d.llmstxt || 'n/a'}.`);
  if (d.backlinks != null || d.spam != null) lines.push(`Backlinks: ${d.backlinks ?? 'n/a'}, referring domains: ${d.refdomains ?? 'n/a'}, spam score: ${d.spam ?? 'n/a'}.`);
  const bk = Object.entries(bucketCounts || {}).filter(([b]) => SDX_BUCKETS[b]).map(([b, n]) => `${SDX_BUCKETS[b].label}: ${n}`);
  if (bk.length) lines.push(`Keyword opportunity buckets — ${bk.join('; ')}.`);
  const serpLines = Object.entries(serp?.byKeyword || {}).slice(0, 8).map(([kw, v]) => `"${kw}": ${v.livePos ? 'live #' + v.livePos : 'not in top 20'}${v.above && v.above.length ? ', above you: ' + v.above.map((a) => a.domain).slice(0, 3).join(', ') : ''}`);
  if (serpLines.length) lines.push('Live SERP landscape:\n' + serpLines.join('\n'));
  lines.push('Top technical issues:\n' + recs.slice(0, 12).map((r) => `[${r.severity}] ${r.error} → ${r.action}`).join('\n'));
  if (ga4Text) lines.push('GA4 context (pasted):\n' + ga4Text.slice(0, 1500));
  if (gscText) lines.push('Search Console context (pasted):\n' + gscText.slice(0, 1500));
  return lines.join('\n');
}

// ── Page Technical & Domain Analysis ──────────────────────────────────────────
// The lighter cousin of the forensic audit (index.html's "Domain Analysis"
// section): fan out a focused set of FAST probes — DataForSEO link data and
// domain rank, PageSpeed (mobile+desktop), SSL and the on-page HTML — then render
// the "Domain & Page Metrics" card grid. No duplication crawl or performance-grade
// long-pole, no scoring/remediation: just the signals, in one view.
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

  const [siteRes, psmRes, psdRes, sslRes, homeHtml] = await Promise.all([
    tryJson(UPSTREAMS.forensicSiteData, { url: baseDomain }, 25000),
    tryJson(UPSTREAMS.pageSpeed, { url: target }, 55000),
    tryJson(UPSTREAMS.pageSpeed, { url: target, strategy: 'desktop' }, 55000),
    tryJson(UPSTREAMS.sslCheck, { url: domain }, 20000),
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

  // 2. Authority Score — our own 0-100 metric (see authorityScore()). There is no
  //    page-level equivalent without a third-party suite, so `pa` stays null and
  //    the card below drops out rather than showing an invented number.
  d.da = authorityScore(siteRes);

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
    { label: 'Authority Score', value: d.da ?? dash, tone: daTone(d.da) },
    { label: 'Backlinks', value: num(d.backlinks), tone: 'slate' },
    { label: 'Referring domains', value: num(d.refdomains), tone: 'slate' },
    // Organic traffic / organic keyword estimates came from a third-party SEO
    // suite and were removed with it — the user's own Search Console (via the
    // GSC integration) is the accurate source for both, so we point there rather
    // than showing a permanently empty card.
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
    { type: 'stats', title: 'Authority & links', items: authority },
    { type: 'stats', title: 'Page technical signals', items: technical },
  ];
  if (d.metatitle || d.metadesc) {
    sections.push({ type: 'table', title: 'Page metadata', columns: ['Field', 'Value'], rows: [
      { Field: 'Title', Value: d.metatitle || dash },
      { Field: 'Meta description', Value: d.metadesc || dash },
    ] });
  }

  const summary = {
    domainAuthority: d.da, authoritySource: d.da == null ? null : 'digimetrics',
    backlinks: d.backlinks,
    referringDomains: d.refdomains, spamScore: d.spam,
    pageSpeedMobile: d.psm, pageSpeedDesktop: d.psd,
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

/** Strip tags/scripts/styles to approximate visible page text (for the duplicate-content check). */
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
  // Free helper: "AI suggest" on the optional text boxes — crawls the site and
  // drafts the summary / GEO prompts / highlights so the user edits rather than
  // faces a blank box. Never charged (`_noCharge`).
  if (String(body.action || '').trim() === 'suggest') return llmsTxtSuggest(body);
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

  // robots.txt / llms.txt / llms-full.txt are static plain-text files. Fetch them
  // with a direct fetch first — it's the correct tool for plain text AND avoids the
  // getHtml headless renderer's >3-concurrent throttle, which was silently dropping
  // robots.txt (4 parallel getHtml calls) and mis-reporting an existing file "Missing".
  // Fall back to the getHtml upstream only for sites that bot-block a direct fetch.
  const getText = async (path, ms) => {
    const direct = await directFetchHtml(rootDomain + path, ms);
    if (direct && direct.trim().length > 10) return direct;
    return getBody(rootDomain + path, ms);
  };
  let [homeHtml, robotsBody, llmsBody, llmsFullBody] = await Promise.all([
    getBody(rootDomain, 25000),
    getText('/robots.txt', 12000),
    getText('/llms.txt', 10000),
    getText('/llms-full.txt', 10000),
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
      { type: 'callout', text: 'Two files, same content, different depth. llms.txt is a concise index — one line per page — that AI crawlers read first to understand your site; publish it at /llms.txt. llms-full.txt is the verbose version, expanding every page into its own section with a description and source link; publish it at /llms-full.txt for AI models that want deeper context. Best practice is to publish both: start with llms.txt (it is the one most tools look for), then add llms-full.txt if you want richer answers.' },
      { type: 'code', title: 'llms.txt', filename: 'llms.txt', content: llmsTxt },
      { type: 'code', title: 'llms-full.txt (verbose)', filename: 'llms-full.txt', content: llmsFull },
      { type: 'list', title: 'What to do with these files', items: [
        `1. Download (or copy) both files above using the buttons on each box.`,
        `2. Upload them to the root of your website so they are served at ${rootDomain}/llms.txt and ${rootDomain}/llms-full.txt (same folder as your homepage — e.g. the public/, www/, or web root; in WordPress drop them in the site root next to wp-config.php, or use a plugin like "Website LLMs.txt").`,
        `3. Serve them as plain text (Content-Type: text/plain) and make sure they return HTTP 200 — open ${rootDomain}/llms.txt in a browser to confirm it loads and is not behind a login or redirect.`,
        `4. Make sure your robots.txt allows AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) — otherwise AI tools cannot read the files you just published.`,
        `5. Re-run this tool after publishing: the checks above should flip to "Present", confirming AI models can now find and read your site's llms.txt.`,
        `6. Keep them updated — re-generate and re-upload whenever you add key pages or services so AI answers about you stay accurate.`,
      ] },
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

// ── Free helper: draft the optional text boxes from the live site ────────────
// The three long boxes (summary / GEO prompts / highlights) are the ones people
// stall on: they're optional, but a blank box gives no idea of what to write or
// what the file will look like. One crawl + one AI pass fills all three at once
// (the frontend caches the response per URL, so the other buttons are instant).
// Keys match the catalog field names so the frontend can stay generic.
async function llmsTxtSuggest(body) {
  let target = String(body.input || body.url || '').trim();
  if (!target) return { _noCharge: true, _failed: true, text: 'Enter your website URL first.' };
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { return { _noCharge: true, _failed: true, text: 'That website URL does not look valid.' }; }
  const rootDomain = u.origin;
  const host = u.hostname.replace(/^www\./, '');

  // Same two-step fetch as the full run: the headless renderer first (it gets
  // past JS-only sites), a direct fetch as the fallback for slow/blocked ones.
  let homeHtml = await Promise.race([
    postUpstream(UPSTREAMS.getHtml, { url: rootDomain }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
  ]).then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : ''))).catch(() => '');
  if (!homeHtml || homeHtml.length < 200) homeHtml = await directFetchHtml(rootDomain, 12000);
  if (!homeHtml || homeHtml.length < 200) {
    return { _noCharge: true, _failed: true, text: `Could not read ${rootDomain} — check the URL is public, or fill these in yourself.` };
  }

  const title = (homeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || host).replace(/\s+/g, ' ').trim();
  const metaDesc = (homeHtml.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
  const links = extractSiteLinks(homeHtml, host, rootDomain);

  const list = links.slice(0, 30).map((l) => `${l.label} | ${l.url}`).join('\n');
  const userPrompt =
    `Output ONLY strict JSON (no markdown fences, no prose). You are pre-filling the optional fields of an llms.txt generator for the website "${title}" (${rootDomain}).` +
    (metaDesc ? ` Homepage meta description: "${metaDesc}".` : '') +
    `\nReal internal pages found by crawling the homepage (label | url):\n${list || '(none found)'}\n` +
    `\nReturn JSON of shape: {"summary": string, "geo_prompts": string[], "highlights": string[]}.` +
    ` Rules: "summary" = ONE sentence describing what this business offers and who it is for (it becomes the > blockquote at the top of the file).` +
    ` "geo_prompts" = 4 natural questions a real person would type into ChatGPT or another AI assistant that this site should be the cited answer to — no brand-stuffing, phrase them the way a customer would.` +
    ` "highlights" = 3-5 short factual bullet lines worth surfacing to an AI (services, markets served, credentials, notable clients, differentiators) — each under 15 words, drawn only from what the site actually shows. Omit anything you cannot support.`;

  let j = null;
  try {
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    let s = aiText(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    j = JSON.parse(s);
  } catch { j = null; }
  if (!j || typeof j !== 'object') {
    return { _noCharge: true, _failed: true, text: "Couldn't draft suggestions for that site — fill these in yourself." };
  }

  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n')).map((s) => String(s).trim()).filter(Boolean);
  return {
    _noCharge: true,
    summary: String(j.summary || metaDesc || '').trim(),
    geoPrompts: lines(j.geo_prompts).slice(0, 6).join('\n'),
    // Highlights land verbatim in the file, so keep them as markdown bullets.
    highlights: lines(j.highlights).slice(0, 5).map((s) => (s.startsWith('-') ? s : `- ${s}`)).join('\n'),
  };
}

// ── Persona Generator: draft the audience-details box from the brand ─────────
// The personas are only as sharp as the "audience details" box, and that box is
// exactly where people stop — they came with a URL, not a demographic brief. So
// read whatever they already typed (a URL: crawl it; a description: use it as
// written) and draft the five lines the box asks for. Free (`_noCharge`) and
// always editable afterwards — it's a starting point, not the run.
async function personaSuggest(body) {
  const src = String(body.input || body.url || '').trim();
  if (!src) return { _noCharge: true, _failed: true, text: 'Enter your website URL or brand description first.' };

  // A URL gets crawled; anything else is treated as the brand description the
  // field also accepts (the input is "URL or brand description").
  const looksUrl = /^https?:\/\//i.test(src) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(src);
  let brandContext = '', label = src;
  if (looksUrl) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(src) ? src : 'https://' + src); }
    catch { return { _noCharge: true, _failed: true, text: 'That website URL does not look valid.' }; }
    const rootDomain = u.origin;
    label = u.hostname.replace(/^www\./, '');
    // Same two-step fetch as llmsTxtSuggest: renderer first, direct fetch after.
    let html = await Promise.race([
      postUpstream(UPSTREAMS.getHtml, { url: rootDomain }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]).then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : ''))).catch(() => '');
    if (!html || html.length < 200) html = await directFetchHtml(rootDomain, 12000);
    if (!html || html.length < 200) {
      return { _noCharge: true, _failed: true, text: `Could not read ${rootDomain} — check the URL is public, or describe the brand instead.` };
    }
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || label).replace(/\s+/g, ' ').trim();
    const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
    const links = extractSiteLinks(html, label, rootDomain).slice(0, 25).map((l) => l.label).join(', ');
    const text = html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    brandContext = `Website: ${rootDomain}\nPage title: ${title}` +
      (metaDesc ? `\nMeta description: ${metaDesc}` : '') +
      (links ? `\nMain navigation / pages: ${links}` : '') +
      `\nHomepage copy:\n${text}`;
  } else {
    brandContext = `The user describes the brand as:\n${src.slice(0, 4000)}`;
  }

  const userPrompt =
    `Output ONLY strict JSON (no markdown fences, no prose). You are pre-filling the "audience details" box of an audience-persona generator for "${label}".\n` +
    `${brandContext}\n\n` +
    `Return JSON of shape: {"audience": string, "geography": string, "behaviour": string, "lifestyle": string, "budget": string}.` +
    ` Each value is ONE short line (under 20 words), written as the user would type it — no labels, no full sentences.` +
    ` "audience" = who actually buys (role/demographic, age range if it can be inferred).` +
    ` "geography" = the markets the brand clearly serves.` +
    ` "behaviour" = how these customers buy or decide.` +
    ` "lifestyle" = interests or values that fit them.` +
    ` "budget" = income or spending level.` +
    ` Ground every line in what the brand actually shows; if something genuinely cannot be inferred, return "" for that key rather than inventing it.`;

  let j = null;
  try {
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    let s = aiText(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    j = JSON.parse(s);
  } catch { j = null; }
  if (!j || typeof j !== 'object') {
    return { _noCharge: true, _failed: true, text: "Couldn't draft audience details for that — fill the box in yourself." };
  }

  // Same labelled shape as the field's placeholder, so the draft reads like the
  // example the user was already looking at.
  const line = (lbl, v) => { const t = String(v || '').trim(); return t ? `${lbl}: ${t}` : ''; };
  const manual = [
    line('Target audience', j.audience),
    line('Geography / market', j.geography),
    line('Customer behaviour', j.behaviour),
    line('Lifestyle / interests', j.lifestyle),
    line('Budget / income', j.budget),
  ].filter(Boolean).join('\n');
  if (!manual) return { _noCharge: true, _failed: true, text: "Couldn't draft audience details for that — fill the box in yourself." };
  return { _noCharge: true, manual };
}

// ── SEM Ad Copy: draft the keywords box from the site (or from seeds) ────────
// Today the keyword box sends people out of the platform to some other AI to
// think of keywords, and they come back with generic head terms. Two cases, one
// button: with seeds we EXPAND them (the classic "auto suggest"); with an empty
// box we derive keywords from the site itself — which is the common case, since
// the URL is already required above and most users arrive without a seed list.
// Targeting matters more than volume here: these go straight into ad copy, so we
// ask for terms with commercial intent in the market/language already selected.
// Free (`_noCharge`) and fully editable — chips can be removed before running.
async function semCopySuggest(body) {
  const src = String(body.input || body.url || '').trim();
  if (!src) return { _noCharge: true, _failed: true, text: 'Enter your website URL first, then auto-suggest.' };

  const seeds = String(body.keywords || body.seed || '')
    .split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  const country = String(body.country || '').trim() || 'the target market';
  const language = String(body.language || '').trim() || 'English';
  const format = String(body.format || '').trim();

  // The field is a required URL, but accept a bare brand name too — the user
  // asked for this to work off "website OR brand name", and a name is still
  // enough for the model to reason about (no crawl, just weaker grounding).
  const looksUrl = /^https?:\/\//i.test(src) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(src);
  let brandContext = '', label = src;
  if (looksUrl) {
    let u;
    try { u = new URL(/^https?:\/\//i.test(src) ? src : 'https://' + src); }
    catch { return { _noCharge: true, _failed: true, text: 'That website URL does not look valid.' }; }
    const rootDomain = u.origin;
    label = u.hostname.replace(/^www\./, '');
    // Same two-step fetch as personaSuggest: renderer first, direct fetch after.
    let html = await Promise.race([
      postUpstream(UPSTREAMS.getHtml, { url: rootDomain }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
    ]).then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : ''))).catch(() => '');
    if (!html || html.length < 200) html = await directFetchHtml(rootDomain, 12000);
    // A dead crawl is not fatal here: the brand name alone still yields usable
    // keywords, so degrade to the name rather than refusing the whole thing.
    if (html && html.length >= 200) {
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || label).replace(/\s+/g, ' ').trim();
      const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
      const links = extractSiteLinks(html, label, rootDomain).slice(0, 25).map((l) => l.label).join(', ');
      const text = html
        .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
      brandContext = `Website: ${rootDomain}\nPage title: ${title}` +
        (metaDesc ? `\nMeta description: ${metaDesc}` : '') +
        (links ? `\nMain navigation / pages: ${links}` : '') +
        `\nHomepage copy:\n${text}`;
    } else {
      brandContext = `Website: ${rootDomain} (the page could not be read — infer from the domain name alone).`;
    }
  } else {
    brandContext = `The advertiser is the brand "${src.slice(0, 200)}". No website was given — infer what they sell from the brand name.`;
  }

  const userPrompt =
    `Output ONLY strict JSON (no markdown fences, no prose). You are suggesting keywords for a paid search / social ad campaign` +
    (format ? ` (${format} ads)` : '') + ` targeting ${country}, in ${language}.\n` +
    `${brandContext}\n\n` +
    (seeds.length
      ? `The advertiser already listed these seed keywords — EXPAND on them: ${seeds.join(', ')}.\n` +
        `Return closely related terms they have NOT already listed (variants, buyer-intent modifiers, adjacent services). Do not repeat a seed back.\n`
      : `The advertiser gave no seed keywords — derive them from what the business actually sells.\n`) +
    `Return JSON of shape: {"keywords": string[]}.` +
    ` Rules: 12 keywords, each 2-5 words, lowercase, written in ${language} the way a real buyer in ${country} would search.` +
    ` Favour commercial intent (what someone types when ready to buy or compare) over broad informational phrases.` +
    ` Ground every keyword in a product or service the brand genuinely offers — never invent an offering.` +
    ` No brand names of competitors, no duplicates, no single generic words like "software" or "services".`;

  let j = null;
  try {
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    let s = aiText(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    j = JSON.parse(s);
  } catch { j = null; }
  if (!j || typeof j !== 'object') {
    return { _noCharge: true, _failed: true, text: "Couldn't suggest keywords for that — add them yourself." };
  }

  // Dedupe case-insensitively against what the user already has, so expanding a
  // seed list never hands back chips they are looking at.
  const have = new Set(seeds.map((s) => s.toLowerCase()));
  const keywords = (Array.isArray(j.keywords) ? j.keywords : String(j.keywords || '').split(/[\n,]+/))
    .map((k) => String(k).trim().replace(/^[-•*]\s*/, ''))
    .filter((k) => k && k.length <= 80)
    .filter((k) => { const lc = k.toLowerCase(); if (have.has(lc)) return false; have.add(lc); return true; })
    .slice(0, 12);
  if (!keywords.length) {
    return { _noCharge: true, _failed: true, text: "Couldn't suggest keywords for that — add them yourself." };
  }
  return { _noCharge: true, keywords };
}

// ── GEO On-Page: draft the target prompts from the page itself ──────────────
// "Target prompts" is the field that stops people: it's required, it's the one
// input they can't lift off their own site, and getting it wrong wastes the
// run. So read the exact page they pasted and propose the three questions it
// could realistically be cited for — plus the brand / industry / audience the
// form asks for next, which are all readable from the same page. Free
// (`_noCharge`); keys match the catalog field names so the form fills itself.
async function geoOnPageSuggest(body) {
  let target = String(body.input || body.url || '').trim();
  if (!target) return { _noCharge: true, _failed: true, text: 'Enter the page URL first.' };
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let u;
  try { u = new URL(target); } catch { return { _noCharge: true, _failed: true, text: 'That page URL does not look valid.' }; }
  const host = u.hostname.replace(/^www\./, '');

  // Note this crawls the TARGET PAGE, not the homepage: the prompts have to be
  // ones this specific page can answer. Renderer first, direct fetch as fallback.
  let html = await Promise.race([
    postUpstream(UPSTREAMS.getHtml, { url: target }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
  ]).then((r) => (typeof r === 'string' ? r : (r && typeof r.body === 'string' ? r.body : ''))).catch(() => '');
  if (!html || html.length < 200) html = await directFetchHtml(target, 12000);
  if (!html || html.length < 200) {
    return { _noCharge: true, _failed: true, text: `Could not read ${target} — check the URL is public, or write the prompts yourself.` };
  }

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || host).replace(/\s+/g, ' ').trim();
  const metaDesc = (html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '').trim();
  const headings = [...html.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).slice(0, 15).join(' | ');
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);

  const userPrompt =
    `Output ONLY strict JSON (no markdown fences, no prose). You are pre-filling a GEO (Generative Engine Optimisation) tool for the page ${target}.\n` +
    `Page title: ${title}` + (metaDesc ? `\nMeta description: ${metaDesc}` : '') +
    (headings ? `\nHeadings: ${headings}` : '') + `\nPage copy:\n${text}\n\n` +
    `Return JSON of shape: {"prompts": string[], "brand": string, "industry": string, "audience": string}.` +
    ` "prompts" = exactly 3 questions a real buyer would type into ChatGPT, Perplexity or Google's AI Overview where THIS page deserves to be the cited answer.` +
    ` Write them the way a person actually asks (8-16 words), make each one distinct, keep them commercially useful (comparisons, "best X for Y", how to choose),` +
    ` and do not stuff the brand name in unless the page is genuinely about the brand itself.` +
    ` "brand" = the brand or company name. "industry" = its niche in a few words. "audience" = who the page is written for.` +
    ` Ground everything in what the page actually says; return "" for anything you cannot support.`;

  let j = null;
  try {
    const raw = await postUpstream(UPSTREAMS.aiOptimiser, { action: 'content_freeform', userPrompt });
    let s = aiText(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    j = JSON.parse(s);
  } catch { j = null; }
  if (!j || typeof j !== 'object') {
    return { _noCharge: true, _failed: true, text: "Couldn't draft prompts for that page — write them yourself." };
  }

  const prompts = (Array.isArray(j.prompts) ? j.prompts : String(j.prompts || '').split('\n'))
    // The model sometimes numbers or bullets them despite the instruction.
    .map((s) => String(s).replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim())
    .filter(Boolean).slice(0, 3);
  if (!prompts.length) return { _noCharge: true, _failed: true, text: "Couldn't draft prompts for that page — write them yourself." };
  const str = (v, n) => String(v || '').trim().slice(0, n);
  return {
    _noCharge: true,
    prompts: prompts.join('\n'),
    brand: str(j.brand, 80),
    industry: str(j.industry, 80),
    audience: str(j.audience, 120),
  };
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
  if (d.gtmetrix && d.gtmetrix !== 'A') add(`Performance Grade ${d.gtmetrix} (Not Grade A)`, 'Developer to improve the core web vitals', 'gtmetrix');
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
// `opts.title` renames the report heading and `opts.skipSummary` drops the
// health-score stat block — both used by SEO Diagnostics, which embeds this
// technical report under its own verdict rather than as a standalone audit.
function faSections(d, recs, score, sevCounts, opts = {}) {
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
    { label: 'Authority Score', value: d.da ?? dash, tone: daTone },
    { label: 'PageSpeed Desktop', value: d.psd ?? dash, tone: psTone(d.psd) },
    { label: 'PageSpeed Mobile', value: d.psm ?? dash, tone: psTone(d.psm) },
    { label: 'Performance Grade', value: d.gtmetrix || dash, tone: gtTone },
    { label: 'GA4', value: d.ga4 || dash, tone: ga4Tone },
    { label: 'Sitemap', value: d.sitemap || dash, tone: sitemapTone },
    { label: 'HTTPS Redirect', value: d.https || dash, tone: httpsTone },
    { label: 'Structured Data', value: d.structdata || dash, tone: sdTone },
    { label: 'Semantic HTML', value: d.semantic || dash, tone: d.semantic === 'Yes' ? 'green' : d.semantic ? 'red' : 'slate' },
    { label: 'LLM bots blocked', value: d.llmblock || dash, tone: d.llmblock === 'Yes' ? 'red' : d.llmblock ? 'green' : 'slate' },
    { label: 'llms.txt', value: d.llmstxt || dash, tone: llmTone },
    { label: 'llms-full.txt', value: d.llmsfull || dash, tone: d.llmsfull === 'Present' ? 'green' : d.llmsfull === 'Missing' ? 'red' : 'slate' },
    { label: 'CMS', value: d.cms || dash, tone: 'slate' },
    { label: 'External dup %', value: d.copyscape == null ? dash : `${d.copyscape}%`, tone: copyTone },
    { label: 'Internal dup %', value: d.siteliner == null ? dash : `${d.siteliner}%`, tone: sitelinerTone },
    { label: 'Backlinks', value: num(d.backlinks), tone: 'slate' },
    { label: 'Referring domains', value: num(d.refdomains), tone: 'slate' },
    { label: 'Spam score', value: d.spam == null ? dash : `${d.spam}%`, tone: spamTone },
  ];

  const sections = [
    { type: 'heading', text: `${opts.title || 'GEO+SEO Forensic Audit'} — ${d.url}` },
    ...(opts.skipSummary ? [] : [{ type: 'stats', items: [
      { label: 'Health score', value: `${score}/100`, tone: scoreTone },
      { label: 'Critical', value: sevCounts.critical, tone: sevCounts.critical ? 'red' : 'green' },
      { label: 'Warning', value: sevCounts.warning, tone: sevCounts.warning ? 'amber' : 'green' },
      { label: 'Opportunity', value: sevCounts.opportunity, tone: sevCounts.opportunity ? 'blue' : 'green' },
      { label: 'Total issues', value: recs.length, tone: recs.length === 0 ? 'green' : recs.length < 5 ? 'amber' : 'red' },
    ] }]),
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

// The client turns `needsConnect` into a "connect your account" widget; the
// reason picks which one (never linked / expired sign-in / no account chosen).
// `_noCharge` keeps a setup prompt from ever costing a credit.
function connectPrompt(tool, reason, text) {
  return { _noCharge: true, needsConnect: tool.integration, connectReason: reason, text };
}

// Which upstream failures are really "you're not connected", not a fault.
function connectReasonOf(message) {
  const m = String(message || '');
  if (/\bno (property|site|customer id|account|ad account)\b/i.test(m)) return 'account';
  if (/not connected/i.test(m)) return 'connect';
  if (/invalid_grant|token (refresh|exchange)|unauthori[sz]ed|permission denied|\b(401|403)\b/i.test(m)) return 'reconnect';
  return null;
}
async function integrationsRun(tool, body) {
  const conn = body._integrations?.[tool.integration];
  if (!conn?.connected) {
    return connectPrompt(tool, 'connect', `Connect your ${tool.name} account under Integrations to use this tool.`);
  }
  // Signed in, but no property/account picked (and none typed in the form) —
  // the pull would fail deep inside the API with "no property"; ask up front.
  if (!conn.account && !body.input) {
    return connectPrompt(tool, 'account', `Pick which ${tool.name} account this tool should read.`);
  }
  // GSC sub-tools (URL Inspection / Sitemaps / Indexing) — dispatched by gscOp.
  if (tool.integration === 'gsc' && body.gscOp && body.gscOp !== 'insights') return gscOpsRun(tool, body, conn);
  let live;
  try {
    live = await fetchIntegrationFor(tool.integration, conn, { ...body, input: body.input || conn.account });
  } catch (e) {
    // An expired/revoked token or a property we can no longer read is a
    // connection problem, not a server fault: returning 500 here is what used
    // to throw the "Report a problem" panel at users who simply hadn't finished
    // connecting. Hand the client a connect prompt instead.
    const reason = connectReasonOf(e?.message);
    if (!reason) throw e;
    console.log(JSON.stringify({ metric: 'integration_needs_connect', provider: tool.integration, reason, detail: String(e?.message || '').slice(0, 200) }));
    return connectPrompt(tool, reason, `We couldn’t reach your ${tool.name} account — sign in again to restore access.`);
  }
  // No seeded fallback: if the live pull didn't return data, prompt a reconnect.
  if (!live?.rows) {
    return connectPrompt(tool, 'reconnect', `We couldn’t pull live ${tool.name} data — reconnect your account under Integrations to continue.`);
  }
  // Advanced GAQL: raw query results, shown as a plain flat table (no dashboard).
  if (live.gaql) {
    return { rows: live.rows, sections: [{ type: 'callout', text: `Custom GAQL query — ${live.rows.length} row${live.rows.length === 1 ? '' : 's'} returned.` }] };
  }
  // Summary cards + trend chart render above the (sortable) breakdown table -
  // the dashboard layout index.html uses, not a bare table.
  const out = {
    sections: integrationSections(tool.integration, live.summary || {}, live.series || [], live.deltas, body.compare, live),
    rows: live.rows, summary: live.summary, source: live.source,
  };
  // Every integration gets an AI "what to do next" pass over the real numbers.
  const ai = AI_INTEGRATION_CTX[tool.integration];
  if (ai) {
    let findings = `${summaryToFindings(live.summary)}\nBreakdown rows:\n${rowsToFindings(live.rows)}`;
    // GSC: feed the striking-distance (page-2) queries in too, they're prime actions.
    if (Array.isArray(live.striking) && live.striking.length) {
      findings += `\nStriking-distance (position 11-20) queries:\n${rowsToFindings(live.striking, 15)}`;
    }
    const rec = await aiRecommendations({
      label: ai.label, context: `${ai.ctx} Date range: ${body.range || 'Last 28 days'}.`, findings,
    });
    return withRecs(out, rec);
  }
  return out;
}

// Per-integration label + advice framing for the AI recommendations pass.
const AI_INTEGRATION_CTX = {
  gsc: { label: 'Google Search Console', ctx: 'Advise on winning striking-distance (page-2) keywords, lifting low-CTR high-impression queries, resolving keyword cannibalisation, and content/opportunity gaps from this Search Console data.' },
  ga4: { label: 'Google Analytics (GA4)', ctx: 'Advise on traffic quality, channel mix, engagement and conversion improvements from this GA4 data.' },
  'google-ads': { label: 'Google Ads', ctx: 'Advise on budget reallocation, low-converting / high-CPA campaigns, and optimisation opportunities from this Google Ads data.' },
  'meta-ads': { label: 'Meta Ads', ctx: 'Advise on creative fatigue, audience/placement efficiency, budget reallocation and lowering cost-per-result from this Meta Ads data.' },
  'linkedin-ads': { label: 'LinkedIn Ads', ctx: 'Advise on campaign efficiency, audience targeting, bid/budget reallocation and lowering cost-per-conversion from this LinkedIn Ads data.' },
};

// Dispatch + format the GSC sub-tools. integration_pull cost is 0, so these are
// free like the main pull. Destructive ops (indexing removal, sitemap delete)
// are gated by a client-side confirm before they reach here.
async function gscOpsRun(tool, body, conn) {
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
    // These ops swallow their errors into a callout so a bad URL doesn't fail the
    // whole run - but a "gsc 403" callout left a user with a revoked token or no
    // property staring at a result they can't act on. Route a connection failure
    // to the connect widget, exactly as the insights pull does.
    const reason = connectReasonOf(e.message);
    if (reason) {
      console.log(JSON.stringify({ metric: 'integration_needs_connect', provider: 'gsc', reason, op: body.gscOp, detail: String(e.message || '').slice(0, 200) }));
      return connectPrompt(tool, reason, `We couldn\u2019t reach your ${tool.name} account \u2014 sign in again to restore access.`);
    }
    return { sections: [{ type: 'callout', text: `\u26a0 ${e.message}` }] };
  }
}

// Build the stat-card + trend-chart sections for an integration pull. The
// breakdown stays a top-level `rows` table (sortable, formatted) so it isn't
// rendered twice. Chart is omitted when no day-series came back.
function integrationSections(provider, summary, series, deltas, compareRaw, live = {}) {
  const num = (v) => (v == null ? '\u2014' : Number(v).toLocaleString());
  const striking = live.striking;
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
    // Branded vs non-branded split (only when the user supplied brand terms).
    if (live.brand) {
      const b = live.brand;
      sections.push({ type: 'stats', title: 'Branded vs non-branded', items: [
        { label: 'Branded clicks', value: num(b.brandedClicks) },
        { label: 'Non-branded clicks', value: num(b.nonBrandedClicks) },
        { label: 'Branded share', value: `${b.brandedPct}%` },
        { label: 'Branded impressions', value: num(b.brandedImpressions) },
      ] });
    }
    if (Array.isArray(striking) && striking.length) sections.push({ type: 'table', title: 'Striking distance \u2014 page-2 easy wins', columns: ['query', 'clicks', 'impressions', 'ctr', 'position'], rows: striking });
    if (Array.isArray(live.lowCtr) && live.lowCtr.length) sections.push({ type: 'table', title: 'Low-CTR opportunities \u2014 page-1 queries under-clicked (rewrite title/meta)', columns: ['query', 'clicks', 'impressions', 'ctr', 'position'], rows: live.lowCtr });
    if (Array.isArray(live.cannibalization) && live.cannibalization.length) sections.push({ type: 'table', title: 'Keyword cannibalisation \u2014 multiple pages ranking for one query', columns: ['query', 'pages', 'impressions', 'clicks'], rows: live.cannibalization });
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
    // Awareness → action funnel (renders as descending proportional bars).
    if (live.funnel) {
      const f = live.funnel;
      sections.push({ type: 'list', title: 'Funnel — impressions → reach → clicks → results', items: [
        `Impressions: ${num(f.impressions)}`, `Reach: ${num(f.reach)}`, `Clicks: ${num(f.clicks)}`, `Results: ${num(f.results)}`,
      ] });
    }
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
  const mode = body.mode || 'domain';
  // The scope decides what shape `target` has to be — a bare domain or a whole
  // page URL — and reshaping it here (not only in the form) keeps a schedule or
  // raw API call in step with what the UI sends, whichever address shape the
  // caller happened to hold. `host` no longer appears on the form; runs and
  // schedules saved while it did still arrive, and still mean that host.
  const raw = body.input || body.url;
  const target = mode === 'domain' ? cleanDomain(raw)
    : mode === 'host' ? toHost(raw)
    : toPageUrl(raw);
  if (!target) throw new Error('A domain or URL is required.');
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
    { type: 'text', text: 'Totals can differ between tools — link indexes are crawled at different times and depths, so treat each figure as a trend, not an absolute count.' },
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
  // A single-word value ("Asana") survives both checks above — `https://Asana`
  // is a *valid* URL — and the audit then crawls a host that doesn't exist and
  // reports every check as missing, at full price. The form used to hand us
  // exactly that (its required box was the brand name), and a schedule or raw
  // API call still can, so the shape of a real hostname is checked here too.
  if (!u.hostname.includes('.')) throw new Error(`“${u.hostname}” doesn’t look like a website address — enter the full site, e.g. example.com.`);
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
  // The website is genuinely optional here (no site → brand-only prompts). But
  // it used to arrive as the BRAND NAME whenever the box was left empty, which
  // sent "Acme Co" to a keywords-for-site pull and to citation matching. Take it
  // only when it looks like a site; anything else is the brand leaking through.
  const rawTarget = (body.url || '').trim();
  const target = /\./.test(cleanDomain(rawTarget)) ? rawTarget : '';
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
  const location = (body.location || 'Singapore').trim();
  const language = (body.language || 'English').trim();
  return {
    audience: (body.audience || 'Working professionals').trim(),
    brandTone: (body.brandTone || 'Professional').trim(),
    searchIntent: 'Informational', industry: 'General', riskLevel: 'Low',
    // Follow the user's chosen market: the legal agent reviews against this
    // jurisdiction and the writer actions are told the locale in plain words.
    jurisdictions: location,
    locale: `${language} (${location})`,
    readingLevel: (body.readingLevel || 'Grade 6-8 (Easy)').trim(),
    doUseWords: '', doNotUseWords: (body.doNotUseWords || '').trim(),
    focusProducts: '', schemaType: 'Article', pageType: (body.pageType || 'Any').trim(),
    complianceDisclaimers: false, suggestExternalLinks: false,
    contentType: 'general', targetReader: (body.audience || 'General public').trim(),
  };
}

// ── Readability + meta hygiene, ported from index.html's optimiser ────────────
function _cwSyllables(word) {
  word = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = word.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}
function calculateFlesch(text) {
  if (!text || !text.trim()) return 0;
  const sents = text.split(/[.!?]+/).filter((s) => s.trim().length > 3);
  const words = text.split(/\s+/).filter((w) => w.trim().length > 0);
  if (!sents.length || !words.length) return 0;
  const sylls = words.reduce((sum, w) => sum + _cwSyllables(w), 0);
  return Math.max(0, Math.min(100, Math.round(206.835 - 1.015 * (words.length / sents.length) - 84.6 * (sylls / words.length))));
}
function fleschLabel(s) {
  if (s >= 90) return 'Very Easy';
  if (s >= 70) return 'Easy';
  if (s >= 60) return 'Standard';
  if (s >= 50) return 'Fairly Difficult';
  if (s >= 30) return 'Difficult';
  return 'Very Difficult';
}
// Strip editorial scaffolding ("Word Count:", "Section X of Y", literal "H3:"
// labels…) that must never reach the published draft — mirrors index.html's
// stripEditorialMeta() (commit 6a20982).
function stripEditorialMeta(md) {
  if (!md || typeof md !== 'string') return md || '';
  const META_RE = /^(word ?count|target word ?count|recommended word ?count|section \d+ of \d+|meta[- ]?description|meta[- ]?title|url slug|slug)\b\s*[:\-]/i;
  return md.split('\n').map((line) => {
    const hMatch = line.match(/^\s*#{0,6}\s*H([1-6])\s*[:\-]\s*(.+?)\s*$/i);
    if (hMatch) return '#'.repeat(parseInt(hMatch[1], 10)) + ' ' + hMatch[2];
    const stripped = line.replace(/^[\s>*_#`~-]+/, '');
    if (META_RE.test(stripped)) return '';
    if (/^section \d+ of \d+\**\s*[:.\-]?\s*$/i.test(stripped)) return '';
    return line;
  }).join('\n');
}
// Minimal, safe Markdown → HTML so the produced draft renders as a real article
// (headings/lists/bold/links) instead of raw "##" text. Escapes first, then
// promotes tokens — only our own tags reach the output. add_links output is
// already HTML and bypasses this (sanitised separately).
function mdToHtml(md) {
  const inline = (t) => esc(t)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s"']+)\)/g, (m, txt, href) => `<a href="${href}" target="_blank" rel="noopener">${txt}</a>`)
    .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;border-radius:4px;padding:1px 5px;font-size:.92em">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:)])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  // A pipe row splits on unescaped "|", dropping the leading/trailing empties.
  const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  const isRow = (line) => line.includes('|');

  const lines = String(md || '').split('\n');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // Fenced code block — swallow to the closing fence so its contents are never
    // re-interpreted as markdown.
    const fence = line.match(/^\s*```+\s*([\w-]*)\s*$/);
    if (fence) {
      closeList();
      const buf = [];
      while (++i < lines.length && !/^\s*```+\s*$/.test(lines[i])) buf.push(lines[i]);
      out.push(`<pre style="margin:10px 0;padding:10px 12px;background:#0f172a;color:#e2e8f0;border-radius:8px;overflow:auto;font-size:12.5px;line-height:1.5"><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // GFM pipe table — only when the next line is the |---|---| divider, so a
    // stray sentence containing a pipe doesn't become a one-cell table.
    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      closeList();
      const head = cells(line);
      i += 1; // skip the divider
      const body = [];
      while (i + 1 < lines.length && isRow(lines[i + 1]) && lines[i + 1].trim()) body.push(cells(lines[++i]));
      // No inline styles: .dm-report's table rules (light + dark) then apply.
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const rows = body.map((r) => `<tr>${head.map((_, c) => `<td>${inline(r[c] || '')}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    // Thematic break — the models emit "---" as a section separator constantly.
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { closeList(); out.push('<hr style="border:0;border-top:1px solid #e2e8f0;margin:14px 0">'); continue; }

    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) { closeList(); const lv = Math.min(6, h[1].length); out.push(`<h${lv} style="margin:14px 0 6px;font-weight:700">${inline(h[2])}</h${lv}>`); continue; }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { closeList(); out.push(`<blockquote style="margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid #cbd5e1;color:#475569">${inline(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul style="margin:6px 0;padding-left:22px;list-style:disc">'); list = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol style="margin:6px 0;padding-left:22px;list-style:decimal">'); list = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }
    closeList();
    out.push(`<p style="margin:8px 0;line-height:1.6">${inline(line.trim())}</p>`);
  }
  closeList();
  return out.join('\n');
}
/** Trim long agent prose to a length cap WITHOUT slicing mid-sentence — the old
 *  hard `.slice(2000)` visibly cut words in half in the report. */
function mdTrim(md, max) {
  const s = String(md || '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(at > max * 0.5 ? cut.slice(0, at + 1) : cut).trim()}\n\n*(trimmed)*`;
}
// Defang untrusted AI-generated HTML (the add_links output) before it lands in
// the report: drop script/style/iframe, on* handlers and javascript: URLs.
function sanitizeDraftHtml(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*\/?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

// Parse an AI outline into H1/H2-delimited sections (port of index.html's
// parseOutlineIntoSections). H3+ stay with their parent section.
function parseOutlineSections(outline) {
  const sections = [];
  let cur = { header: '', content: [] };
  for (const line of String(outline).split('\n')) {
    if (!line.trim()) continue;
    if (/^#{1,2}\s/.test(line.trim())) {
      if (cur.header || cur.content.length) sections.push(cur);
      cur = { header: line.trim(), content: [] };
    } else cur.content.push(line);
  }
  if (cur.header || cur.content.length) sections.push(cur);
  if (!sections.length && String(outline).trim()) sections.push({ header: 'Introduction', content: [outline] });
  return sections.map((s) => ({ header: s.header, body: s.content.join('\n') }));
}

/** postUpstream + fold the aiOptimiser call's real token usage into `acc`
 *  ({in, out, calls}) so the run can be metered on actual work, not a flat fee. */
async function postOptimiser(url, payload, acc, opts) {
  const raw = await postUpstream(url, payload, opts);
  if (acc) {
    const d = deepBody(raw);
    const u = (d && typeof d === 'object' && d.usage) || {};
    acc.in += Number(u.input_tokens) || 0;
    acc.out += Number(u.output_tokens) || 0;
    acc.calls += 1;
  }
  return raw;
}

// ── Content Optimiser: live competitor research ──────────────────────────────
// index.html runs this interactively — SERP fan-out draws a grid of competitor
// cards and the user ticks the topics they want covered. There is no grid here,
// so it runs headless ahead of the draft and fills the three parameters the
// aiOptimiser Lambda has always accepted but that this gateway sent empty:
// `selectedTopics`, `targetWordCount` and (Phase 2) `deepCompareContext`.
// No prompt work is involved — the Lambda already knows what to do with them.
const CW_RESEARCH_URLS = 10;   // competitors we actually read (SERP returns ~20)
const CW_FALLBACK_TOPICS = 12; // when the AI picker fails, take the top N by consensus
// The picker is generous — a live run on "project management software" returned
// 23 topics from 88 candidates. index.html can afford that because a human then
// prunes the list; here it goes straight into the outline, and 23 topics across
// a ~2,350-word target is ~100 words each: a listicle of stubs. Cap it so the
// draft covers the important topics properly instead of all of them thinly.
const CW_MAX_TOPICS = 15;

/** Sum a gptTopicsPerUrl topic map ({topic: wordCount}) into a page word count. */
function cwTopicWords(topics) {
  return Object.values(topics || {}).reduce((n, v) => n + (Number(v) || 0), 0);
}

/** Median competitor length, rounded to the nearest 50 — the same rule as
 *  index.html's calculateTargetWordCount. Median, not mean: one 8,000-word
 *  outlier pillar page shouldn't drag every draft up with it. */
function cwMedianWordTarget(counts) {
  const nums = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (!nums.length) return 0;
  return Math.round(nums[Math.floor(nums.length / 2)] / 50) * 50;
}

/** SERP → per-competitor topic extraction → AI topic pick. Never throws: every
 *  stage degrades to "no research" with a `skipped` reason we show the user,
 *  because an unbriefed draft is still a usable draft. */
async function cwResearch({ keyword, location, language, pageType, secondaryArr, jobId, usage }) {
  const none = (skipped) => ({ topics: [], wordTarget: 0, competitors: [], skipped });
  if (!keyword) return none('we had no target keyword to search for');

  await cwStage(jobId, { stage: 'Finding the pages that rank for your keyword' });
  let urls = [];
  try {
    const raw = deepBody(await postUpstream(UPSTREAMS.moreSerps, {
      keyword, language, location,
      page_types: pageType && !/^any$/i.test(pageType) ? pageType : 'any',
      limit: 20,
      // 30s (copied from sdxSerp) is NOT enough here: measured 29s and 46s on
      // back-to-back live calls for the same keyword, so the shorter timeout
      // was killing the whole research pass roughly half the time.
    }, { timeoutMs: 120000 }));
    urls = Object.values(raw && typeof raw === 'object' ? raw : {})
      .map((r) => r && r.url).filter(Boolean).slice(0, CW_RESEARCH_URLS);
  } catch { return none('the search-results lookup failed'); }
  if (!urls.length) return none('no ranking pages came back for this keyword and market');

  const stageLabel = `Reading ${urls.length} ranking pages`;
  await cwStage(jobId, { stage: stageLabel, progress: { done: 0, total: urls.length } });
  let done = 0;
  const pages = await Promise.all(urls.map((u) =>
    postOptimiser(UPSTREAMS.gptTopicsPerUrl, { url: u, keyword }, usage)
      .then((raw) => {
        const d = deepBody(raw);
        const topics = d && d[u] && d[u].topics;
        return topics && Object.keys(topics).length ? { url: u, topics } : null;
      })
      .catch(() => null) // one blocked competitor must not sink the research pass
      .then((r) => {
        done += 1;
        cwStage(jobId, { stage: stageLabel, progress: { done, total: urls.length } }).catch(() => {});
        return r;
      })
  ));

  const good = pages.filter(Boolean);
  if (!good.length) return none("we couldn't read any of the ranking pages");

  const freq = new Map();
  for (const p of good) {
    for (const t of Object.keys(p.topics)) {
      const k = String(t).trim();
      if (k) freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const allTopics = [...freq.entries()].map(([topic, frequency]) => ({ topic, frequency }));
  const competitors = good.map((p) => ({ url: p.url, words: cwTopicWords(p.topics), topicCount: Object.keys(p.topics).length }));
  const wordTarget = cwMedianWordTarget(competitors.map((c) => c.words));

  let topics = [];
  if (allTopics.length) {
    await cwStage(jobId, { stage: 'Picking the topics your draft has to cover' });
    try {
      const d = deepBody(await postOptimiser(UPSTREAMS.aiTopicPicker, {
        primary_keyword: keyword, secondary_keywords: secondaryArr, all_topics: allTopics, location,
      }, usage));
      topics = Array.isArray(d && d.selected_topics) ? d.selected_topics.filter(Boolean).map(String) : [];
    } catch { /* fall through to consensus ranking */ }
  }
  // The picker is the ONLY thing choosing topics here — index.html can fall back
  // on a human ticking boxes, we can't. So a failed pick must not silently
  // un-brief the writer: take the topics the most competitors agreed on.
  if (!topics.length) {
    topics = allTopics.sort((a, b) => b.frequency - a.frequency).slice(0, CW_FALLBACK_TOPICS).map((t) => t.topic);
  }
  return { topics: topics.slice(0, CW_MAX_TOPICS), wordTarget, competitors, skipped: '' };
}

// ── Content Optimiser: Deep Compare (Optimise mode only) ─────────────────────
// deepContentCompare needs a page of YOURS to compare against, so unlike the
// research pass above it cannot run in Write mode — there is no target URL. It
// is also the slowest call in the agency stack: index.html tells users to expect
// `competitors × 30 + 30` seconds, i.e. ~3 minutes for five. That makes it the
// one stage that can plausibly push a run past the Lambda deadline, so it is
// gated on remaining time and skipped (loudly) rather than risking the draft.
const CW_DEEP_COMPARE_URLS = 5;
const CW_DEEP_COMPARE_MS = 210000;      // hard cap on the call itself (5 × 30 + 30, + margin)
const CW_DEEP_COMPARE_RESERVE_MS = 420000; // writer + QA agents still to come (measured 386s)

// [key, heading] for the five issue tables deepContentCompare returns. Each row
// is {issue, competitor_approach, target_gap, fix}.
const CW_DC_TABLES = [
  ['eeat_trust_signals', 'E-E-A-T & trust signals'],
  ['topical_authority', 'Topical authority & content clusters'],
  ['competitive_differentiation', 'Competitive differentiation & SERP positioning'],
  ['technical_schema_seo', 'Technical & schema SEO'],
  ['audience_targeting', 'Audience targeting & reader psychology'],
];

/** Flatten the Deep Compare payload into a prompt-sized brief. index.html dumps
 *  raw JSON.stringify into the prompt; that carries punctuation the model has to
 *  pay for and parse, so this writes prose-ish lines and caps the total — an
 *  over-long context here silently crowds out the draft itself. */
function cwDeepCompareBrief(data) {
  const lines = [];
  for (const [key, heading] of CW_DC_TABLES) {
    const rows = Array.isArray(data?.[key]) ? data[key] : [];
    if (!rows.length) continue;
    lines.push('', `${heading.toUpperCase()}:`);
    for (const r of rows.slice(0, 6)) {
      lines.push(`- ${r.issue || ''}${r.target_gap ? ` — we lack: ${r.target_gap}` : ''}${r.fix ? ` — fix: ${r.fix}` : ''}`);
      // What the ranking pages actually do about it — the model needs something
      // to emulate, not just a list of our own shortcomings. Truncated because
      // these run long and 20 of them would eat the whole context budget.
      if (r.competitor_approach) lines.push(`  competitors: ${String(r.competitor_approach).slice(0, 200)}`);
    }
  }
  return lines.join('\n').trim().slice(0, 12000);
}

/** The ranked "do this first" list. deepContentCompare DOES define a
 *  `priority_action_plan`, but a live run on a real page returned all five issue
 *  tables and no plan at all — index.html renders that block conditionally, so
 *  the gap was invisible there. Derive one when it's missing, taking the top row
 *  from each dimension before the second row of any, so a single dimension with
 *  many findings can't crowd out the other four. */
function cwDeepComparePlan(data, limit = 8) {
  const given = Array.isArray(data?.priority_action_plan) ? data.priority_action_plan : [];
  if (given.length) return given.slice(0, limit);

  const tables = CW_DC_TABLES
    .map(([key, heading]) => [heading, Array.isArray(data?.[key]) ? data[key] : []])
    .filter(([, rows]) => rows.length);
  const out = [];
  const depth = Math.max(0, ...tables.map(([, rows]) => rows.length));
  for (let i = 0; i < depth && out.length < limit; i++) {
    for (const [heading, rows] of tables) {
      if (out.length >= limit) break;
      const r = rows[i];
      if (!r || !(r.fix || r.issue)) continue;
      // NOT expected_outcome: the issue is what's wrong, not what fixing it
      // achieves — putting it after an arrow would read backwards.
      out.push({ priority: out.length + 1, action: r.fix || r.issue, expected_outcome: '', effort: '', dimension: heading });
    }
  }
  return out;
}

/** Compare the user's own page against the top competitors. Returns
 *  `{ brief, plan, skipped }`; never throws. */
async function cwDeepCompare({ targetUrl, competitors, keyword, jobId, usage, researchSkipped = '' }) {
  const none = (skipped) => ({ brief: '', plan: [], skipped });
  if (!targetUrl) return none('');    // Write mode / pasted text — not applicable, say nothing
  // If the research pass didn't run, it has ALREADY told the user why. Adding a
  // second callout here would read as two separate failures instead of one.
  if (researchSkipped) return none('');
  if (!competitors.length) return none('we had no competitor pages to compare against');

  const need = CW_DEEP_COMPARE_MS + CW_DEEP_COMPARE_RESERVE_MS;
  if (msRemaining() < need) {
    return none('there wasn’t enough time left in this run to also compare your page against them');
  }

  const urls = competitors.map((c) => c.url).filter((u) => u !== targetUrl).slice(0, CW_DEEP_COMPARE_URLS);
  if (!urls.length) return none('we had no competitor pages to compare against');

  await cwStage(jobId, { stage: `Comparing your page against ${urls.length} competitors` });
  try {
    const d = deepBody(await postOptimiser(UPSTREAMS.deepContentCompare, {
      target_url: targetUrl, competitor_urls: urls, keyword,
    }, usage, { timeoutMs: CW_DEEP_COMPARE_MS }));
    // The Lambda surfaces its own failures as {error}; don't turn that into an
    // empty-but-successful brief the writer would treat as "nothing to fix".
    if (!d || typeof d !== 'object' || d.error) return none(d?.error ? `the comparison failed (${d.error})` : 'the comparison returned nothing usable');
    const brief = cwDeepCompareBrief(d);
    if (!brief.trim()) return none('the comparison returned no findings');
    return { brief, plan: cwDeepComparePlan(d), skipped: '' };
  } catch (e) {
    return none(`the comparison didn’t finish (${e.message})`);
  }
}

// A measured optimise run with research + Deep Compare landed at 669s against a
// 880s self-deadline — and that was the DEFAULT 8-agent depth. "Full audit" is
// 18 agents, which would be killed mid-flight, throwing away the draft with it.
// So the QA suite is trimmed to what the remaining time can actually pay for.
const CW_AGENT_WAVE = 8;            // agents that run as one parallel wave
const CW_AGENT_WAVE_MS = 200000;    // wall-clock for a wave (the per-call cap is 170s)

/** Keep as much of the QA suite as still fits. Verify agents survive first —
 *  they're what catch factual and legal problems; research and structure are
 *  enrichment. Never trims below one wave: a run with no checks isn't a result. */
function cwFitAgents(agents, left = msRemaining()) {
  if (left === Infinity) return { agents, trimmed: 0 }; // no clock (local/tests)
  const wavesNeeded = Math.ceil(agents.length / CW_AGENT_WAVE);
  if (left >= wavesNeeded * CW_AGENT_WAVE_MS) return { agents, trimmed: 0 };
  const wavesAfforded = Math.max(1, Math.floor(left / CW_AGENT_WAVE_MS));
  const keep = wavesAfforded * CW_AGENT_WAVE;
  if (keep >= agents.length) return { agents, trimmed: 0 };
  const ORDER = { verify: 0, research: 1, structure: 2 };
  const kept = agents.slice()
    .sort((a, b) => (ORDER[a.group] ?? 9) - (ORDER[b.group] ?? 9))
    .slice(0, keep);
  return { agents: kept, trimmed: agents.length - kept.length };
}

/** Single-call fallback article (the previous behaviour). */
async function freeformDraft(url, { topic, keyword, secondaryArr, settings, provider, usage, selectedTopics = [] }) {
  const mustCover = selectedTopics.length
    ? ` Make sure the article covers these subjects, which the pages currently ranking for this keyword all address: ${selectedTopics.join('; ')}.`
    : '';
  const raw = await postOptimiser(url, {
    action: 'content_freeform', provider,
    userPrompt: `Write a focused, SEO-friendly article about: "${topic}". Use clear H2/H3 headings, a short intro, scannable sections and a brief conclusion. Primary keyword: ${keyword || topic}.${mustCover}`,
    personaContext: {}, selectedTopics, primary_keyword: keyword, secondary_keywords: secondaryArr,
    compliance_guidelines: [], settings,
  }, usage);
  return stripEditorialMeta(aiText(raw));
}

/** Write flow: outline → sections (parallel) → polish. Sections are written
 *  concurrently and the polish pass harmonises flow — keeps the one-shot run
 *  inside the gateway budget. Falls back to a single freeform draft on failure. */
async function writeArticle(url, { topic, keyword, secondaryArr, settings, provider, usage, wordTarget, selectedTopics = [] }) {
  const secondary = secondaryArr.join(', ');
  const target = Math.max(0, Number(wordTarget) || 0);
  let outline = '';
  try {
    outline = aiText(await postOptimiser(url, {
      action: 'content_outline', provider, topic, keyword, pageTypeContext: settings.pageType,
      personaContext: {}, deepCompareContext: '', selectedTopics, targetWordCount: target, locale: settings.locale,
    }, usage));
  } catch { /* fall back to freeform */ }
  if (!outline || !outline.trim()) return freeformDraft(url, { topic, keyword, secondaryArr, settings, provider, usage, selectedTopics });

  const sections = parseOutlineSections(outline).slice(0, 7); // cap for time budget
  // A real word target re-enables the Lambda's per-section hard minimum (it was
  // always 0 before, silently disabling the whole length-control machinery).
  const perSection = target > 0 ? Math.round(target / sections.length) : 0;
  const written = await Promise.all(sections.map((sec, i) =>
    postOptimiser(url, {
      action: 'content_section', provider, topic, primaryKeyword: keyword, secondaryKeywords: secondary,
      pageTypeContext: settings.pageType, personaInstruction: '', complianceInstruction: '',
      deepCompareContext: '', outline, recentContent: '', sectionHeader: sec.header, sectionContext: sec.body,
      refUrls: [], sectionTarget: perSection, totalTarget: target, sectionIndex: i, totalSections: sections.length,
      locale: settings.locale, settings,
    }, usage).then((raw) => stripEditorialMeta(aiText(raw))).catch(() => '')
  ));
  let full = written.filter(Boolean).join('\n\n');
  if (!full.trim()) return freeformDraft(url, { topic, keyword, secondaryArr, settings, provider, usage, selectedTopics });

  try {
    const polished = stripEditorialMeta(aiText(await postOptimiser(url, { action: 'content_polish', provider, fullContent: full, settings }, usage)));
    if (polished && polished.trim()) full = polished;
  } catch { /* keep unpolished draft */ }
  return full;
}

/** Optimise flow: gap analysis → rewrite applying the gaps. Returns the improved
 *  draft (empty if the rewrite failed) plus the gap summary for display. */
async function optimiseExisting(url, { content, keyword, settings, provider, usage, selectedTopics = [], deepCompareContext = '' }) {
  let gap = '';
  try {
    gap = aiText(await postOptimiser(url, {
      action: 'content_gap', provider, pageTypeContext: settings.pageType, personaContext: {},
      deepCompareContext, selectedTopics, keyword, editorContent: content, settings,
    }, usage));
  } catch { /* no gap analysis */ }
  let rewrite = '';
  if (gap && gap.trim()) {
    try {
      rewrite = aiText(await postOptimiser(url, {
        action: 'content_rewrite', provider, personaContext: {}, selectedTopics, keyword,
        suggestions: gap, originalContent: content, settings,
      }, usage));
      rewrite = stripEditorialMeta((rewrite || '').replace(/```(?:markdown)?\s*/gi, '').replace(/```\s*$/g, '').trim());
    } catch { /* keep original */ }
  }
  return { gap: gap || '', rewrite: rewrite || '' };
}

/** AI-Links: insert credible external citations. Feeds HTML in (add_links
 *  preserves existing HTML) and returns sanitised HTML. */
async function addAiLinks(url, { content, keyword, secondaryArr, settings, provider, usage }) {
  try {
    let out = aiText(await postOptimiser(url, {
      action: 'add_links', provider, content: mdToHtml(content), settings,
      primary_keyword: keyword, secondary_keywords: secondaryArr.join(', '),
    }, usage));
    if (typeof out !== 'string' || !out.trim()) return '';
    out = out.trim();
    const fence = out.match(/```(?:html)?\s*([\s\S]*?)```/i);
    out = fence ? fence[1].trim() : out.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return sanitizeDraftHtml(out);
  } catch { return ''; }
}

/** Suggest an SEO meta title + description for the produced draft. */
async function generateMeta(url, { content, keyword, settings, provider, usage }) {
  try {
    const t = aiText(await postOptimiser(url, {
      action: 'content_freeform', provider,
      userPrompt: `Based on the article below, write ONE SEO meta title (max 60 characters) and ONE meta description (max 155 characters) targeting the keyword "${keyword || ''}". Reply as exactly two lines and nothing else:\nTitle: <title>\nDescription: <description>\n\nARTICLE:\n${content.slice(0, 3500)}`,
      personaContext: {}, selectedTopics: [], primary_keyword: keyword, secondary_keywords: [],
      compliance_guidelines: [], settings,
    }, usage));
    const title = ((t.match(/title\s*[:\-]\s*(.+)/i) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    const desc = ((t.match(/description\s*[:\-]\s*(.+)/i) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    return (title || desc) ? { title, desc } : null;
  } catch { return null; }
}

// Staff-only A/B model comparison. Frontend multi-select labels → aiOptimiser
// provider ids. Both keys run the SAME pipeline so the drafts are comparable.
const OPTIMISER_MODELS = {
  haiku:    { provider: 'anthropic', label: 'Claude Haiku 4.5' },
  deepseek: { provider: 'deepseek',  label: 'DeepSeek V3' },
};

/** Resolve the requested model keys. Non-staff (or an unset field) always get
 *  Haiku only — DeepSeek + multi-model runs are a staff quality-comparison tool
 *  (a second model doubles the AI spend), so the choice is gateway-enforced. */
function selectedOptimiserModels(body) {
  const raw = Array.isArray(body.models) ? body.models : String(body.models || '').split(',');
  let keys = raw.map((s) => String(s).trim().toLowerCase()).filter((k) => OPTIMISER_MODELS[k]);
  if (!body._isStaff) keys = keys.filter((k) => k === 'haiku');
  keys = [...new Set(keys)];
  return keys.length ? keys : ['haiku'];
}

// ── content-writer async job (mirrors the Social Audit pattern) ───────────────
// The pipeline runs 10–30 LLM calls over 1–5 minutes, which used to be one long
// buffered HTTP request with cosmetic client-side progress: a dropped connection
// lost the (still-charged, still-saved) result. Now `start` persists a job and
// self-invokes a background finalizer; the browser polls `status` for REAL
// stage/agent progress; only the finalizer's `finalize` call is charged, through
// the normal handler path (billing, history, notification all standard).
const cwJobKey = (jobId) => `cw_job:${jobId}`;
const CW_JOB_TTL = 2 * 60 * 60; // 2h — re-openable from History / the notification

async function cwStage(jobId, patch) {
  if (!jobId) return;
  const job = await getCache(cwJobKey(jobId)).catch(() => null);
  if (job && job.status !== 'done' && job.status !== 'error') {
    await putCache(cwJobKey(jobId), { ...job, status: 'running', ...patch }, CW_JOB_TTL).catch(() => {});
  }
}

// ── Live partial results ─────────────────────────────────────────────────────
// The pipeline finishes real, showable artifacts long before it finishes the run
// — competitors at ~100s, the priority list at ~280s, the draft at ~400s — but
// the browser used to see nothing but a stage string until ~500s. cwPublish
// pushes a snapshot of the sections-so-far onto the SAME job the poller already
// reads, so the page fills in as work lands.
//
// Two deliberate choices:
//  · It renders through sectionsOptimiser, the same function that builds the
//    final result, so the in-progress view can never disagree with the finished
//    one. That's why every section in there is conditional.
//  · Each write carries the WHOLE snapshot, never a delta. cwStage is
//    read-modify-write and the per-agent ticks overlap, so concurrent writes can
//    lose each other; with snapshots a lost write self-heals on the next one,
//    whereas a lost append would drop that section for good.
const CW_PUBLISH_MIN_GAP_MS = 2000; // poller runs every 3.5s — finer is pure churn

/** Build a publisher bound to one job. Returns a no-op when there's no job to
 *  write to (sync runs, tests) or when several models are racing — two pipelines
 *  publishing into one job would flip the page between their drafts. */
function cwPublisher(jobId, enabled = true) {
  if (!jobId || !enabled) return () => {};
  let last = 0;
  let inflight = null;
  return (view, { force = false } = {}) => {
    const now = Date.now();
    if (!force && now - last < CW_PUBLISH_MIN_GAP_MS) return inflight || Promise.resolve();
    last = now;
    let partial;
    try { partial = sectionsOptimiser(view); } catch { return Promise.resolve(); }
    // Progress reporting must never be able to fail the run that's producing it.
    inflight = cwStage(jobId, { partial }).catch(() => {});
    return inflight;
  };
}

/** A blank view the partial renderer can consume before anything has run. */
function cwEmptyView(writing, research, deep) {
  return {
    writing, draftHtml: '', wordCount: 0, flesch: 0, meta: null, gapSummary: '',
    linkCount: 0, results: [], research, deep, wordTarget: 0,
  };
}

async function contentWriterGateway(body) {
  const action = String(body.cwAction || '').trim();

  // Poll job progress (browser live-progress; never charged).
  if (action === 'status') {
    const job = await getCache(cwJobKey(body.jobId)).catch(() => null);
    if (!job) return { _noCharge: true, status: 'unknown' };
    const { inputs, ...pub } = job; // don't ship the (potentially large) inputs back
    return { _noCharge: true, ...pub };
  }

  // The charged pipeline run — invoked by the background finalizer via a
  // synthetic authenticated gateway event (never directly by the browser).
  // The original inputs are flattened into the body (underscore markers are
  // stripped by publicInputs) so the History row shows the real form values.
  if (body._cwFinalize) {
    const inputs = { ...body };
    delete inputs._cwFinalize; delete inputs._cwJobId;
    return contentOptimiserRun({ ...inputs, _jobId: body._cwJobId });
  }

  // Default: start a background job and return its id immediately.
  // Validate the one hard requirement up front — don't spin up a job that can
  // only fail (the finalizer re-checks, this is just the fast path).
  const writingStart = /write/i.test(body.mode || '');
  if (!(body.input || '').trim() && !(!writingStart && (body.url || '').trim())) {
    return {
      _failed: true,
      text: writingStart
        ? 'Add a topic to write about — no credits were charged.'
        : 'Paste some content to optimise (or give us the page URL) — no credits were charged.',
    };
  }
  const jobId = `cw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const inputs = { ...body };
  delete inputs._email; delete inputs._integrations; delete inputs._userId; delete inputs._tier; delete inputs._isStaff;
  await putCache(cwJobKey(jobId), {
    jobId, status: 'starting', stage: 'Queued',
    userId: body._userId || body._email, email: body._email, tier: body._tier,
    projectId: body.projectId || null,
    inputs, createdAt: new Date().toISOString(),
  }, CW_JOB_TTL);
  await selfInvokeFinalize(jobId, 'content-writer');
  return { _noCharge: true, jobId, status: 'starting' };
}

// Lambda kills an invocation the moment its clock runs out — no catch runs, so
// the job stays frozen on whatever `running` stage it reached. The browser then
// polls that stale entry until its own 12-min deadline and reports a failure,
// even for a run that finished and WAS charged (exactly what happened on
// 19 Jul: pipeline done at 386s, invocation killed at 450s, user told it failed
// and billed 27 credits). Race the pipeline against a self-deadline a little
// before Lambda's so the job always lands in a state the poller can read.
const CW_DEADLINE = 'CW_DEADLINE';
function cwDeadlineGuard(context) {
  const left = typeof context?.getRemainingTimeInMillis === 'function' ? context.getRemainingTimeInMillis() : 0;
  if (!left) return { promise: new Promise(() => {}), cancel() {} }; // no clock (tests) → never fires
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(CW_DEADLINE)), Math.max(1000, left - 20000));
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Background worker: run the (charged) pipeline by re-entering the gateway
// handler — billing, history and the "run complete" notification all flow
// through the one canonical path — then store the finished result for the
// browser (or a returning user) to pick up.
async function contentWriterFinalize(event, context) {
  const jobId = event.jobId;
  const job = await getCache(cwJobKey(jobId)).catch(() => null);
  if (!job) { console.error('cw_finalize_missing_job', jobId); return; }

  try {
    await putCache(cwJobKey(jobId), { ...job, status: 'running', stage: 'Starting the pipeline' }, CW_JOB_TTL).catch(() => {});
    const synthetic = {
      rawPath: '/run/content-writer',
      requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId: job.userId, email: job.email, tier: job.tier } } },
      headers: {},
      body: JSON.stringify({ ...job.inputs, _cwFinalize: true, _cwJobId: jobId, projectId: job.projectId || undefined }),
    };
    const guard = cwDeadlineGuard(context);
    let resp;
    try { resp = await Promise.race([handler(synthetic, context), guard.promise]); }
    finally { guard.cancel(); }
    const parsed = JSON.parse(resp?.body || '{}');
    const status = resp?.statusCode || 200;
    if (status === 402) throw new Error('You ran out of credits before this run. Top up and try again — nothing was charged.');
    if (status >= 300) throw new Error(parsed.error || 'The run failed. No credits were charged.');
    if (parsed.failed || parsed.result?._failed) throw new Error(parsed.result?.text || 'The run failed. No credits were charged.');

    await putCache(cwJobKey(jobId), {
      jobId, status: 'done',
      result: parsed.result || {},
      runId: parsed.runId || null,
      creditsUsed: parsed.creditsUsed,
      creditsRemaining: parsed.creditsRemaining,
      topupRemaining: parsed.topupRemaining,
      finishedAt: new Date().toISOString(),
    }, CW_JOB_TTL);
    // The "✅ finished" notification already fired inside handler's saveRun path.
  } catch (e) {
    // At the deadline the pipeline may already have finished and charged — we
    // simply lost the race to record it. Never assert "no credits were charged"
    // here; point at History, which is the one place that knows the truth.
    const timedOut = e?.message === CW_DEADLINE;
    const msg = timedOut
      ? 'This run took longer than we allow, so we lost track of it. Check History in a few minutes — if it finished, the result is there. If it never appears, nothing was charged.'
      : (e?.message || 'The run failed. No credits were charged.');
    if (timedOut) console.error('cw_finalize_deadline', jobId);
    await putCache(cwJobKey(jobId), {
      jobId, status: 'error', error: msg,
      finishedAt: new Date().toISOString(),
    }, CW_JOB_TTL).catch(() => {});
    try {
      await addNotification({
        userId: job.userId,
        title: '⚠️ AI Content Optimiser run could not finish',
        body: (timedOut ? 'It ran long — check History; the result may still have landed.' : (e?.message || 'Please try running it again.')).slice(0, 140),
        link: '/history',
        kind: 'alert',
      });
    } catch { /* best-effort */ }
  }
}

async function contentOptimiserRun(body) {
  const url = UPSTREAMS.aiOptimiser;
  const models = selectedOptimiserModels(body);

  // Optimise mode can take a page URL instead of pasted text — fetch the page
  // content server-side (same dataforseoCrawler pull the agency editor uses)
  // so nobody has to copy-paste their own website into a textarea.
  const writing = /write/i.test(body.mode || '');
  if (!writing && !(body.input || '').trim() && (body.url || '').trim()) {
    try {
      const raw = await postUpstream(UPSTREAMS.dataforseoCrawler, { action: 'pull_content', url: String(body.url).trim() });
      const d = deepBody(raw);
      const text = d && (d.html ? faStripHtml(String(d.html)) : (d.text || ''));
      if (text && text.trim()) body = { ...body, input: text.trim().slice(0, 30000) };
      else return { _failed: true, text: `We couldn't read any content from ${body.url} — the page may be blocked or empty. Paste the content instead. No credits were charged.` };
    } catch {
      return { _failed: true, text: `We couldn't fetch ${body.url} — check the address or paste the content instead. No credits were charged.` };
    }
  }
  if (!(body.input || '').trim()) {
    return { _failed: true, text: writing
      ? 'Add a topic to write about — no credits were charged.'
      : 'Paste some content to optimise (or give us the page URL) — no credits were charged.' };
  }

  // Only a single-model run streams partials — see cwPublisher.
  const publish = cwPublisher(body._jobId, models.length === 1);

  // Competitor research runs ONCE for the whole run, not once per model: it's
  // provider-independent, and a staff dual-model A/B would otherwise pay for
  // the SERP + 10 page reads twice and could brief the two drafts differently,
  // making the comparison meaningless.
  const researchUsage = { in: 0, out: 0, calls: 0 };
  const research = /^off/i.test(String(body.competitorResearch || 'On'))
    ? { topics: [], wordTarget: 0, competitors: [], skipped: 'you turned competitor research off' }
    : await cwResearch({
      keyword: (body.keyword || '').trim(),
      location: (body.location || 'Singapore').trim(),
      language: (body.language || 'English').trim(),
      pageType: body.pageType,
      secondaryArr: splitItems(body.secondary),
      jobId: body._jobId, // renamed from _cwJobId on the way in — see contentWriterGateway
      usage: researchUsage,
    });

  // First real content the user sees — competitors read + the briefed topics,
  // roughly 400s before the finished run would have shown them anything.
  await publish(cwEmptyView(writing, research, { brief: '', plan: [], skipped: '' }), { force: true });

  // Deep Compare needs a page of the user's OWN to compare against, so it is
  // Optimise-mode-only and only when they gave us a URL (pasted text has no
  // address to fetch). Like research, it runs once for the whole run.
  const deep = (!writing && (body.url || '').trim())
    ? await cwDeepCompare({
      targetUrl: String(body.url).trim(),
      competitors: research.competitors,
      researchSkipped: research.skipped,
      keyword: (body.keyword || '').trim(),
      jobId: body._jobId,
      usage: researchUsage,
    })
    : { brief: '', plan: [], skipped: '' };
  if (deep.plan.length || deep.skipped) await publish(cwEmptyView(writing, research, deep), { force: true });

  // Each selected model runs the full pipeline. Distinct providers hit distinct
  // vendor rate limits, so running both in parallel adds little wall-clock.
  const runs = await Promise.all(models.map(async (key) => ({
    key, label: OPTIMISER_MODELS[key].label,
    view: await runOptimiserPipeline(url, body, OPTIMISER_MODELS[key].provider, research, deep, publish),
  })));

  // Meter on the real token spend across every call in every pipeline
  // (reconcileCost picks this up; the flat ai_long_research cost is the floor).
  const totalUsage = runs.reduce((t, r) => ({
    input_tokens: t.input_tokens + (r.view.usage?.in || 0),
    output_tokens: t.output_tokens + (r.view.usage?.out || 0),
  }), { input_tokens: researchUsage.in, output_tokens: researchUsage.out });

  if (runs.length === 1) {
    const view = runs[0].view;
    if (view.empty) return { _failed: true, text: 'Nothing usable came back from this run — no credits were charged. Please try again.' };
    // A run where the pipeline produced nothing AND every QA agent errored is a
    // failure, not a result — never charge for it.
    const agentsAllFailed = view.results.length > 0 && view.results.every((r) => r.parsed && r.parsed.error);
    if (!view.draftHtml && agentsAllFailed) {
      return { _failed: true, text: 'The AI backend had trouble with this run (no draft and all quality checks failed). No credits were charged — please try again in a moment.' };
    }
    return { sections: sectionsOptimiser(view), usage: totalUsage };
  }
  return { html: renderOptimiserComparison(runs), usage: totalUsage };
}

/** Structured `sections` for the single-model run — the same renderer every
 *  other content tool uses (stats, callouts, cards, themed HTML), replacing the
 *  old self-rendered HTML blob that had no theming, filtering or plan hooks.
 *  renderOptimiser stays for the staff model-comparison + old history rows. */
function sectionsOptimiser(view) {
  const { writing, draftHtml, wordCount, flesch, meta, gapSummary, linkCount, results, wordTarget } = view;
  const research = view.research || { topics: [], competitors: [], skipped: '' };
  const deep = view.deep || { brief: '', plan: [], skipped: '' };
  const scores = results.map((r) => r.parsed && r.parsed.score).filter((s) => s != null && !isNaN(Number(s)));
  const avg = scores.length ? Math.round((scores.reduce((s, v) => s + Number(v), 0) / scores.length) * 10) / 10 : null;
  const failed = results.filter((r) => r.parsed && r.parsed.error).length;

  const sections = [{
    // When the rewrite didn't land, `content` is still the user's ORIGINAL copy
    // — so these numbers describe their existing page. Calling that "Optimised
    // draft · at a glance" tells them we improved something we didn't touch.
    type: 'stats',
    title: draftHtml ? (writing ? 'Draft · at a glance' : 'Optimised draft · at a glance')
      : (writing ? 'At a glance' : 'Your current page · at a glance'),
    // Every stat is conditional so this same function can render a HALF-FINISHED
    // run for the live progress view (see cwPublish) — "Words 0 · Readability
    // 0 · Checks run 0" would read as a broken result, not a pending one.
    items: [
      wordCount ? { label: 'Words', value: wordCount } : null,
      wordCount ? { label: 'Readability', value: `${flesch} · ${fleschLabel(flesch)}`, tone: flesch >= 60 ? 'green' : flesch >= 50 ? 'amber' : 'red' } : null,
      avg != null ? { label: 'QA score', value: `${avg}/10`, tone: avg >= 7 ? 'green' : avg >= 5 ? 'amber' : 'red' } : null,
      linkCount ? { label: 'AI links', value: linkCount, tone: 'blue' } : null,
      results.length ? { label: 'Checks run', value: results.length, tone: failed ? 'amber' : 'slate' } : null,
      research.competitors.length ? { label: 'Competitors read', value: research.competitors.length, tone: 'blue' } : null,
    ].filter(Boolean),
  }];
  if (failed) sections.push({ type: 'callout', text: `${failed} of ${results.length} QA agents didn't finish — their cards below show the error. The rest of the run is unaffected.` });
  // Dropping checks to beat the clock is a real reduction in what was paid for —
  // it gets said out loud, not buried in a smaller agent count.
  if (view.agentsTrimmed > 0) {
    sections.push({ type: 'callout', text: `This run was going to exceed our time limit, so we ran the ${results.length} most important checks and skipped ${view.agentsTrimmed}. The ones that matter most for accuracy and compliance were kept. Re-run at a lighter depth for the full set.` });
  }
  // A gap analysis with no rewrite is a legitimate half-result, but it must not
  // be mistaken for an optimised page — the numbers above are the ORIGINAL copy.
  if (!writing && !draftHtml && gapSummary) {
    sections.push({ type: 'callout', text: 'The rewrite didn’t finish, so this run gives you the gap analysis and quality checks against your existing copy — the page itself hasn’t been rewritten. Re-running usually completes it.' });
  }
  // Say plainly when the draft went out unbriefed — otherwise a research-free
  // run is indistinguishable from a researched one, which is exactly the kind
  // of silent downgrade that makes people distrust the number above.
  if (research.skipped) {
    sections.push({ type: 'callout', text: `Written without competitor research — ${research.skipped}. The draft is still fully QA'd, but it wasn't briefed against the pages that currently rank.` });
  }
  // Same rule for Deep Compare: a run that quietly dropped the head-to-head is
  // not the same product as one that did it. `skipped: ''` means "not
  // applicable" (Write mode / pasted text) and stays silent.
  if (deep.skipped) {
    sections.push({ type: 'callout', text: `We couldn't compare your page head-to-head against the competitors — ${deep.skipped}. The gap analysis below still ran on the topics they cover.` });
  }
  if (deep.plan.length) {
    sections.push({
      type: 'list',
      title: `Fix these first — your page vs the ones outranking it (${deep.plan.length})`,
      note: 'From a head-to-head comparison of your page against the top results, spread across trust, topical authority, differentiation, technical SEO and audience fit.',
      items: deep.plan.map((p) => [
        p.priority != null ? `[${p.priority}]` : '',
        p.dimension ? `${p.dimension} —` : '',
        mdTrim(String(p.action || ''), 320),
        p.expected_outcome ? `→ ${p.expected_outcome}` : '',
        p.effort ? `(${p.effort} effort)` : '',
      ].filter(Boolean).join(' ')),
    });
  }
  if (meta && (meta.title || meta.desc)) {
    sections.push({
      type: 'list', title: 'Suggested meta',
      items: [meta.title ? `Title: ${meta.title}` : '', meta.desc ? `Description: ${meta.desc}` : ''].filter(Boolean),
    });
  }
  // What the writer was actually briefed with — the evidence behind the draft,
  // and the answer to "why did it cover that?".
  if (research.topics.length) {
    const med = cwMedianWordTarget(research.competitors.map((c) => c.words));
    sections.push({
      type: 'list',
      title: `Topics your competitors cover — briefed into the draft (${research.topics.length})`,
      note: [
        `Taken from the ${research.competitors.length} page${research.competitors.length === 1 ? '' : 's'} ranking for your keyword`,
        med ? `median length ${med.toLocaleString()} words` : '',
        wordTarget ? `target used ${wordTarget.toLocaleString()}` : '',
      ].filter(Boolean).join(' · ') + '.',
      items: research.topics,
    });
  }
  if (draftHtml) sections.push({ type: 'html', title: writing ? 'Your draft' : 'Optimised draft', html: draftHtml });
  if (gapSummary) sections.push({ type: 'html', title: 'Content-gap analysis', html: mdToHtml(gapSummary.slice(0, 3000)) });

  // One collapsed row per agent. Every check used to dump its findings AND its
  // full long-form report straight into the page, so eight agents read as one
  // unbroken wall — score first, detail on demand.
  const GROUP_LABEL = { verify: 'Quality check', research: 'Research', structure: 'Deliverable' };
  const ORDER = { verify: 0, research: 1, structure: 2 };
  const items = results
    .slice()
    .sort((x, y) => (ORDER[x.a.group] ?? 9) - (ORDER[y.a.group] ?? 9))
    .map(({ a, parsed: p }) => {
      if (p.error) return { title: a.label, group: GROUP_LABEL[a.group] || '', badge: 'failed', badgeTone: 'red', summary: p.error };
      const lines = (Array.isArray(p.findings) ? p.findings : []).map((f) => ({
        label: typeof f === 'string' ? '' : (String(f.severity || '').toLowerCase() || ''),
        value: typeof f === 'string' ? f : [f.issue || f.title || '', f.fix ? `→ ${f.fix}` : ''].filter(Boolean).join(' '),
      })).filter((l) => l.value);
      const n = lines.length;
      return {
        title: a.label,
        group: GROUP_LABEL[a.group] || '',
        badge: p.score != null ? `${p.score}/10` : (n ? `${n} finding${n === 1 ? '' : 's'}` : 'ok'),
        badgeTone: p.score != null ? (Number(p.score) >= 7 ? 'green' : Number(p.score) >= 5 ? 'amber' : 'red') : 'blue',
        meta: n ? `${n} finding${n === 1 ? '' : 's'}` : '',
        summary: p.summary || '',
        lines,
        // The agent's own write-up (tables, headings, examples) — rendered, not
        // dumped as raw markdown, and only once the reader opens the row.
        html: p.content && String(p.content).trim().length > 80 ? mdToHtml(mdTrim(String(p.content), 12000)) : '',
      };
    });
  if (items.length) {
    // While streaming, `agentsTotal` is the number still to come — without it a
    // half-done run reads as "Quality checks — 3 agents", i.e. a shallow run
    // rather than a partial one.
    const total = Math.max(results.length, Number(view.agentsTotal) || 0);
    sections.push({
      type: 'accordion',
      title: results.length < total
        ? `Quality checks — ${results.length} of ${total} agents`
        : `Quality checks — ${results.length} agents`,
      note: 'Each agent reviewed the draft independently. Open a row to see its findings and full write-up.',
      items,
    });
  }
  return sections;
}

/** Run the whole optimise/write + QA pipeline once, through a single provider. */
async function runOptimiserPipeline(url, body, provider, research = { topics: [], wordTarget: 0, competitors: [], skipped: '' }, deep = { brief: '', plan: [], skipped: '' }, publish = () => {}) {
  const settings = aiContentSettings(body);
  const keyword = (body.keyword || '').trim();
  const secondaryArr = splitItems(body.secondary);
  const writing = /write/i.test(body.mode || '');
  const location = (body.location || 'Singapore').trim();
  const language = (body.language || 'English').trim();
  // An explicit user target always wins; otherwise fall back to the median
  // length of the pages that actually rank (0 = let the AI decide, as before).
  const askedTarget = Math.max(0, Math.min(6000, Number(body.wordCount) || 0));
  const wordTarget = askedTarget || Math.min(6000, research.wordTarget || 0);
  const selectedTopics = research.topics || [];
  const usage = { in: 0, out: 0, calls: 0 }; // real token spend across every call

  let content = (body.input || '').trim();
  let draft = '';        // the (improved) draft we produced, as markdown
  let gapSummary = '';
  if (writing) {
    await cwStage(body._jobId, { stage: 'Writing the draft (outline → sections → polish)' });
    draft = await writeArticle(url, { topic: content, keyword, secondaryArr, settings, provider, usage, wordTarget, selectedTopics });
    if (draft) content = draft;
  } else if (content) {
    await cwStage(body._jobId, { stage: 'Analysing content gaps & rewriting' });
    const opt = await optimiseExisting(url, { content, keyword, settings, provider, usage, selectedTopics, deepCompareContext: deep.brief });
    gapSummary = opt.gap;
    if (opt.rewrite) { draft = opt.rewrite; content = opt.rewrite; }
  }
  if (!content) return { empty: true };

  // Enrich the produced draft with AI-Links + suggested meta (parallel — no extra
  // wall-clock). Only runs when we actually generated/rewrote content.
  let linkedHtml = '', meta = null;
  if (draft) {
    await cwStage(body._jobId, { stage: 'Adding AI links & suggested meta' });
    [linkedHtml, meta] = await Promise.all([
      addAiLinks(url, { content: draft, keyword, secondaryArr, settings, provider, usage }),
      generateMeta(url, { content: draft, keyword, settings, provider, usage }),
    ]);
  }

  const grp = body.analysis || '';
  const asked = /^Full/i.test(grp) ? OPTIMISER_AGENTS
    : /^Research/i.test(grp) ? OPTIMISER_AGENTS.filter((a) => a.group === 'research')
    : /^Structure/i.test(grp) ? OPTIMISER_AGENTS.filter((a) => a.group === 'structure')
    : OPTIMISER_AGENTS.filter((a) => a.group === 'verify');
  // Better to return a draft with 8 of 18 checks than to be killed at the
  // deadline and return nothing at all.
  const { agents, trimmed: agentsTrimmed } = cwFitAgents(asked);

  const flesch = calculateFlesch(content);
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  // The draft is the payoff — show it the moment it exists rather than holding
  // it hostage to the QA agents, which take another minute or two.
  const liveView = {
    writing, draftHtml: linkedHtml || (draft ? mdToHtml(draft) : ''), wordCount, flesch,
    meta, gapSummary, linkCount: linkedHtml ? (linkedHtml.match(/<a\s+[^>]*href=/gi) || []).length : 0,
    results: [], research, deep, wordTarget, agentsTrimmed,
  };
  await publish(liveView, { force: true });
  liveView.agentsTotal = agents.length; // so a partial accordion says "3 of 8", not "3"

  const context = {
    flow: writing ? 'new' : 'optimise', keyword, secondary: secondaryArr.join(', '),
    topic: writing ? (body.input || '').trim() : '', location, language,
    // selectedTopics is a STRING here (the agent prompts interpolate it), unlike
    // the array the content_* actions take.
    content, pageType: settings.pageType, compliance: '', personas: '',
    selectedTopics: selectedTopics.join(', '),
    wordCount, flesch, fleschLabel: fleschLabel(flesch),
    brandTone: settings.brandTone, jurisdictions: settings.jurisdictions, readingLevel: settings.readingLevel,
  };

  await cwStage(body._jobId, { stage: `Running ${agents.length} QA agents`, progress: { done: 0, total: agents.length } });
  // Opt-in live web verification: the Lambda only honours this for the fact
  // agents (factCheck / factGatherer) and always runs them on Anthropic. The
  // extra search-result tokens flow into `usage`, so cost self-adjusts.
  const webVerify = /^on/i.test(String(body.webVerify || ''));
  let agentsDone = 0;
  const runAgent = (a) =>
    postOptimiser(url, {
      action: 'optimiser_agent', provider, agentKey: a.key, context, settings,
      webSearch: webVerify && (a.key === 'factCheck' || a.key === 'factGatherer'),
    }, usage)
      .then((raw) => ({ a, parsed: parseAgentResult(aiText(raw)) }))
      .catch((e) => ({ a, parsed: { error: e.message } }))
      .then((r) => {
        agentsDone += 1;
        // Fire-and-forget progress write — the browser's status poll reads it.
        cwStage(body._jobId, { stage: `Running ${agents.length} QA agents`, progress: { done: agentsDone, total: agents.length } }).catch(() => {});
        // …and let the finished check appear in the accordion straight away.
        // Throttled inside cwPublisher, so a burst of parallel agents finishing
        // together produces one write, not eighteen.
        liveView.results.push(r);
        publish(liveView);
        return r;
      });

  // Run ONE agent first to warm the Anthropic prompt cache (the agents share a
  // large constitution system block), then fan the rest out in parallel — the
  // wave then reads the cached prefix instead of 17 full-price copies.
  let results;
  if (agents.length >= 6) {
    const first = await runAgent(agents[0]);
    results = [first, ...(await Promise.all(agents.slice(1).map(runAgent)))];
  } else {
    results = await Promise.all(agents.map(runAgent));
  }

  const draftHtml = linkedHtml || (draft ? mdToHtml(draft) : '');
  const linkCount = linkedHtml ? (linkedHtml.match(/<a\s+[^>]*href=/gi) || []).length : 0;
  return { writing, draftHtml, wordCount, flesch, meta, gapSummary, linkCount, results, usage, research, deep, wordTarget, agentsTrimmed };
}

/** Render two (or more) model runs side by side for staff quality comparison. */
function renderOptimiserComparison(runs) {
  const palette = ['#4f46e5', '#0e7490', '#b45309', '#9333ea'];
  const cols = runs.map((r, i) => {
    const accent = palette[i % palette.length];
    const inner = r.view.empty
      ? '<p style="color:#64748b;margin:0">Add some content to optimise (or a topic to write about).</p>'
      : renderOptimiser(r.view);
    return `<div style="flex:1 1 360px;min-width:0;border:1px solid #e2e8f0;border-radius:12px;padding:14px;background:#fff">
      <div style="display:flex;align-items:center;gap:8px;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid ${accent}">
        <span style="width:10px;height:10px;border-radius:999px;background:${accent};display:inline-block"></span>
        <span style="font-weight:800;font-size:15px;color:#0f172a">${esc(r.label)}</span>
      </div>${inner}</div>`;
  }).join('');
  return `<div style="margin:0 0 12px;color:#475569;font-size:13px">⚖️ Model comparison — the same inputs run through each model, one section per model below. Compare the drafts, readability and QA scores to judge quality.</div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">${cols}</div>`;
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

function renderOptimiser({ writing, draftHtml, wordCount, flesch, meta, gapSummary, linkCount, results }) {
  // Each agent is a self-contained, collapsed card: score + one-line verdict on
  // the surface, findings and the agent's own write-up behind a disclosure. Open
  // by default they merged into a single unreadable column.
  const card = (label, p) => {
    if (p.error) return `<div style="border:1px solid #fecaca;border-radius:10px;padding:12px;margin:8px 0;background:#fef2f2"><strong>${esc(label)}</strong> — <span style="color:#b91c1c">${esc(p.error)}</span></div>`;
    const n = Array.isArray(p.findings) ? p.findings.length : 0;
    const sc = p.score != null ? Number(p.score) : null;
    const tone = sc == null ? ['#eef2ff', '#4f46e5'] : sc >= 7 ? ['#dcfce7', '#166534'] : sc >= 5 ? ['#fef9c3', '#854d0e'] : ['#fee2e2', '#991b1b'];
    const score = sc != null ? `<span style="background:${tone[0]};color:${tone[1]};border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700">${esc(p.score)}/10</span>` : '';
    const findings = n
      ? `<ul style="margin:10px 0 0;padding-left:20px;list-style:disc;color:#334155;font-size:13px">${p.findings.map((f) => `<li style="margin:4px 0">${esc(typeof f === 'string' ? f : (f.issue || f.title || JSON.stringify(f)))}${f && f.fix ? ` — <span style="color:#475569">${esc(f.fix)}</span>` : ''}</li>`).join('')}</ul>`
      : '';
    // Agent content is markdown (## headings, tables, **bold**, lists) — render
    // it, don't dump the raw source (mdToHtml escapes first, so it's XSS-safe).
    const detail = p.content && p.content.trim().length > 80
      ? `<div style="color:#334155;margin-top:10px;padding-top:10px;border-top:1px dashed #e2e8f0;font-size:13px">${mdToHtml(mdTrim(p.content, 8000))}</div>`
      : '';
    const body = `${p.summary ? `<p style="color:#475569;margin:8px 0 0;font-size:13px">${esc(p.summary)}</p>` : ''}${findings}${detail}`;
    return `<details style="border:1px solid #e2e8f0;border-radius:10px;margin:8px 0;background:#fff">
      <summary style="cursor:pointer;padding:10px 12px;display:flex;align-items:center;gap:8px;list-style:none">
        <strong style="flex:1 1 auto;min-width:0;color:#0f172a">${esc(label)}</strong>
        ${n ? `<span style="color:#64748b;font-size:12px">${n} finding${n === 1 ? '' : 's'}</span>` : ''}${score}
      </summary>
      <div style="padding:0 12px 12px">${body || '<p style="color:#64748b;margin:8px 0 0;font-size:13px">No issues raised.</p>'}</div>
    </details>`;
  };

  const chip = (txt, bg, fg) => `<span style="background:${bg};color:${fg};border-radius:999px;padding:2px 10px;font-size:12px;margin:0 6px 6px 0;display:inline-block">${esc(txt)}</span>`;
  const scores = results.map((r) => r.parsed && r.parsed.score).filter((s) => s != null && !isNaN(Number(s)));
  const avg = scores.length ? Math.round((scores.reduce((s, v) => s + Number(v), 0) / scores.length) * 10) / 10 : null;
  const metaRow = [
    chip(`${wordCount} words`, '#eef2ff', '#4f46e5'),
    chip(`Readability ${flesch} · ${fleschLabel(flesch)}`, '#ecfeff', '#0e7490'),
    avg != null ? chip(`QA score ${avg}/10`, avg >= 7 ? '#dcfce7' : avg >= 5 ? '#fef9c3' : '#fee2e2', avg >= 7 ? '#166534' : avg >= 5 ? '#854d0e' : '#991b1b') : '',
    linkCount ? chip(`${linkCount} AI link${linkCount === 1 ? '' : 's'}`, '#f0fdf4', '#166534') : '',
  ].join('');

  const metaBlock = meta && (meta.title || meta.desc)
    ? `<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:0 0 12px;background:#f8fafc">
        <div style="font-weight:700;margin-bottom:4px">Suggested meta</div>
        ${meta.title ? `<div style="font-size:13px;margin:2px 0"><span style="color:#64748b">Title:</span> ${esc(meta.title)}</div>` : ''}
        ${meta.desc ? `<div style="font-size:13px;margin:2px 0"><span style="color:#64748b">Description:</span> ${esc(meta.desc)}</div>` : ''}
      </div>` : '';

  const draftBlock = draftHtml
    ? `<h3 style="margin:0 0 8px;font-weight:700">${writing ? 'Draft' : 'Optimised draft'}</h3>
       <div>${metaRow}</div>${metaBlock}
       <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin-bottom:16px;font-size:14px;max-height:520px;overflow:auto">${draftHtml}</div>`
    : `<div style="margin:0 0 12px">${metaRow}</div>`;

  const gapBlock = gapSummary
    ? `<details style="margin:0 0 16px"><summary style="cursor:pointer;font-weight:700">Content-gap analysis</summary><div style="color:#334155;font-size:13px;margin-top:8px">${mdToHtml(mdTrim(gapSummary, 4000))}</div></details>`
    : '';

  return `${draftBlock}${gapBlock}<h3 style="margin:0 0 6px;font-weight:700">QA agent findings <span style="font-weight:400;color:#64748b">— ${results.length} agents</span></h3>${results.map((r) => card(r.a.label, r.parsed)).join('')}`;
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

  // On-demand time-to-rank for ONE keyword (the frontend fans these out over the
  // keywords the user picked, charging + streaming results per keyword). Returns
  // just the estimate; `_skipHistory` keeps each sub-call out of run history.
  if (body.timeRankOne) {
    const domain = (body.domain || body.target || '').trim();
    const kw = String(body.timeRankOne).trim();
    if (!domain || !kw) return { _failed: true, text: 'A domain and keyword are required to estimate time to rank.' };
    const [row] = await enrichTimeToRank([{ keyword: kw, difficulty: body.timeRankDifficulty ?? '—' }], domain, location, language, user, 1);
    return { keyword: kw, timeToRank: row?.timeToRank ?? 'N/A', _skipHistory: true };
  }

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
    // Default: keyword metrics (mangoolsKeywords → volume + cpc + real KD,
    // backfilled from DataForSEO Labs when the volume provider omits it).
    const keywords = splitItems(body.input).slice(0, 25);
    if (!keywords.length) throw new Error('Add at least one keyword.');
    map = deepBody(await postUpstream(UPSTREAMS.mangoolsKeywords, { keywords, location, language }));
    cols = ['volume', 'difficulty', 'cpc'];
  }

  // An upstream Lambda error envelope ({errorType,errorMessage}) must not be
  // rendered as keyword rows (it would surface "errorMessage" as a keyword and
  // still bill). Soft-fail so nothing is charged.
  if (!map || typeof map !== 'object' || map.errorMessage || map.errorType || map.stackTrace) {
    return { _failed: true, text: 'The keyword data service returned an error — no credits were charged. Please try again in a moment.' };
  }
  let rows = kwRows(map, cols);
  if (!rows.length) return { _failed: true, text: 'No keyword data was found — no credits were charged. Try different keywords or check the domain/URL.' };

  // Time-to-rank is no longer auto-computed here — it's an explicit, per-keyword
  // step the user triggers from the results (choose keywords → calculate). We
  // just surface the domain/locale so the frontend knows where to estimate from.
  // Ranking mode is whole-site, so the follow-up time-to-rank estimates must be
  // too: a pasted page URL left intact here would quietly estimate for that one
  // page instead of the site the rows came from. From-webpage mode keeps the
  // full URL — there, the page IS the subject.
  const rawDomain = body.domain || (/(ranking|webpage)/i.test(mode) ? (body.target || body.input) : '') || '';
  const domain = /webpage/i.test(mode) ? String(rawDomain).trim() : cleanDomain(rawDomain);

  return withRecs({ rows, timeRank: { domain, location, language } }, await kaRecs(rows));
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

// Shared with the form (a field flagged `normalize: 'domain'` trims before it
// sends), so a pasted page URL means the same site at both ends — and a request
// that skips the form still gets trimmed here.
const cleanDomain = toDomain;

/** Shape a { keyword: {metrics} } map into rows with the requested columns. */
function kwRows(map, cols) {
  if (!map || typeof map !== 'object') return [];
  const rows = Object.entries(map).map(([keyword, m]) => {
    m = m || {};
    const row = { keyword };
    if (cols.includes('volume')) row.volume = m.search_volume ?? m.search_vol ?? m.volume ?? 0;
    // Real SEO keyword difficulty (0-100) only — never paid competition, which
    // gets its own column. The keyword-metrics upstream backfills KD from
    // DataForSEO Labs, so both metrics and ranking modes can carry this.
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
  // Whole-site forecast, so a pasted page URL is trimmed to its domain — the
  // form does this too, but a schedule or a raw API call skips the form.
  const domain = cleanDomain(body.domain || body.url);
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
// Action-based, mirroring index.html's tool: the bespoke React page drives free
// helper actions (autofill / discover_competitors / connectors_summary) and then
// the single charged `run` (Starter or Pro). Only `run` returns a billable
// result; every helper opts out with `_noCharge`.
async function perfMarketingRun(body) {
  const action = String(body.action || 'run').trim();
  if (action === 'autofill') return pmAutofill(body);
  if (action === 'discover_competitors') return pmDiscoverCompetitors(body);
  if (action === 'connectors_summary') return pmConnectorsSummary(body);
  return pmRunAudit(body);
}

// Country name → 2-letter code for the ad-library / SERP lookups (SG default).
const PM_COUNTRY_CODES = {
  singapore: 'sg', malaysia: 'my', indonesia: 'id', 'united states': 'us', usa: 'us', us: 'us',
  australia: 'au', 'united kingdom': 'gb', uk: 'gb', india: 'in', philippines: 'ph', thailand: 'th',
  vietnam: 'vn', 'hong kong': 'hk', taiwan: 'tw', japan: 'jp', 'south korea': 'kr', korea: 'kr',
  china: 'cn', canada: 'ca', 'new zealand': 'nz', 'united arab emirates': 'ae', uae: 'ae', 'saudi arabia': 'sa',
};
const pmCountryCode = (c) => PM_COUNTRY_CODES[String(c || '').trim().toLowerCase()] || 'sg';
const pmDomainFromLine = (line) => String(line || '').split('—')[0].split(' - ')[0].trim()
  .replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].split('?')[0].trim().toLowerCase();

// The single CHARGED step — Starter or Pro audit.
async function pmRunAudit(body) {
  const mode = String(body.mode || 'starter').trim().toLowerCase();
  const currency = String(body.currency || body.output_currency || '').trim();
  const aiInstr = String(body.aiInstructions || body.additional_instructions || '').trim();
  const currencyDirective = currency
    ? `OUTPUT CURRENCY — MANDATORY: Express ALL monetary values in your entire response (budgets, budget splits, CPC, CPL, CPA, ROAS spend figures, projected costs and any other money amounts) in ${currency}. Do NOT use US dollars or any other currency unless it is ${currency}. Format every amount with this currency's symbol/code.`
    : '';
  const additional_instructions = [currencyDirective, aiInstr].filter(Boolean).join('\n\n');

  let rfqNotes = String(body.rfqNotes || body.rfq_notes || '').trim();
  const attachments = String(body.attachments_context || '').trim();
  if (attachments) rfqNotes = (rfqNotes ? rfqNotes + '\n\n' : '') + 'ADDITIONAL CONTEXT FROM ATTACHED FILES:\n' + attachments;

  const competitors = String(body.competitors || '').trim();
  const country = String(body.country || body.target_country || 'Singapore').trim();

  // Server-side competitor ad intelligence (Google paid keywords + Meta ads),
  // best-effort — a failure here must not sink the audit.
  let competitorAdsIntel = null;
  if (competitors) {
    try { competitorAdsIntel = await pmFetchCompetitorAdsIntel(competitors, country); } catch { /* ignore */ }
  }

  const payload = {
    mode,
    website_url: String(body.input || body.url || '').trim(),
    business_category: String(body.category || '').trim(),
    target_country: country,
    target_audience: String(body.audience || '').trim(),
    monthly_budget: String(body.budget || '').trim(),
    objectives: String(body.objectives || '').trim(),
    output_currency: currency,
    products_services: String(body.products || body.products_services || '').trim(),
    competitors,
    current_platforms: splitItems(body.platforms),
    rfq_notes: rfqNotes,
    additional_instructions,
  };
  if (attachments) payload.attachments_context = attachments;
  if (competitorAdsIntel && competitorAdsIntel.length) payload.competitor_ads_intelligence = competitorAdsIntel;
  if (mode === 'pro') {
    payload.conversion_tracking    = String(body.conversionTracking || '').trim();
    payload.cpl                    = String(body.cpl || '').trim();
    payload.cpa                    = String(body.cpa || '').trim();
    payload.roas                   = String(body.roas || '').trim();
    payload.landing_pages          = String(body.landingPages || '').trim();
    payload.audience_data          = String(body.audienceData || '').trim();
    payload.historical_performance = String(body.historical || '').trim();
    payload.creatives              = String(body.creatives || '').trim();
    payload.google_ads_export      = String(body.googleAds || '').trim();
    payload.meta_ads_export        = String(body.metaAds || '').trim();
    payload.ga4_data               = String(body.ga4 || '').trim();
  }

  const raw = await postUpstream(UPSTREAMS.performanceMarketing, payload);
  const d = parsePmAnswer(raw);
  if (!d) return { _failed: true, text: 'The audit did not return a usable result. Please try again.' };
  // `pm` + `pmMode` drive the bespoke page's rich renderer; `sections` is the
  // history/chat fallback so a re-opened run still shows something sensible.
  return { sections: sectionsPerfMarketing(d), pm: d, pmMode: mode };
}

// Fetch competitor ad intelligence for up to 8 domains — Google paid keywords
// (default action) + Meta Ad Library (`action:'meta_ads'`) — and bundle it the
// way the upstream audit prompt expects.
async function pmFetchCompetitorAdsIntel(competitorsText, country) {
  const source = pmCountryCode(country);
  const domains = [...new Set(String(competitorsText).split('\n').map(pmDomainFromLine).filter((d) => d && d.includes('.')))].slice(0, 8);
  if (!domains.length) return [];
  const results = await Promise.allSettled(domains.map(async (domain) => {
    const [kwRes, metaRes] = await Promise.allSettled([
      postUpstream(UPSTREAMS.competitorAds, { domain, source, limit: 25 }, { timeoutMs: 25000 }),
      postUpstream(UPSTREAMS.competitorAds, { action: 'meta_ads', domain, source }, { timeoutMs: 25000 }),
    ]);
    const kwBody = kwRes.status === 'fulfilled' ? deepBody(kwRes.value) : null;
    const metaBody = metaRes.status === 'fulfilled' ? deepBody(metaRes.value) : null;
    const ads = Array.isArray(kwBody?.ads) ? kwBody.ads : [];
    const metaAds = Array.isArray(metaBody?.meta_ads) ? metaBody.meta_ads : [];
    if (!ads.length && !metaAds.length) return null;
    return {
      domain,
      top_paid_keywords: ads.slice(0, 25).map((a) => ({ keyword: a.keyword, volume: a.volume, cpc: a.cpc, ad_title: a.snippet_title, ad_description: a.snippet_description })),
      meta_ads: metaAds.slice(0, 10).map((a) => ({ title: a.title, body: a.body, cta: a.cta, url: a.url })),
    };
  }));
  return results.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
}

// ── Free helper: auto-fill the form from the prospect's website ──────────────
async function pmAutofill(body) {
  const input = String(body.input || body.url || '').trim();
  if (!input) return { _noCharge: true, _failed: true, text: 'Enter the website URL first.' };
  const canonicalUrl = input.startsWith('http') ? input : 'https://' + input;

  // 1) Scrape ourselves (best-effort) so the model has real page content.
  let scraped = '';
  try {
    const s = deepBody(await postUpstream(UPSTREAMS.getHtml, { url: canonicalUrl }, { timeoutMs: 20000 }));
    scraped = pmExtractText(s?.body ?? s);
  } catch { /* model will fetch instead */ }

  // 2) Structured profile research (retry a couple of times for valid JSON).
  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    try {
      const raw = deepBody(await postUpstream(UPSTREAMS.aiOptimiser, {
        action: 'strategy_url_research', input, canonicalUrl, _scraped_content: scraped || undefined,
      }, { timeoutMs: 60000 }));
      const text = (raw && (raw.result || raw.reply)) || (typeof raw === 'string' ? raw : '');
      data = pmExtractJson(text);
    } catch { /* retry */ }
  }
  if (!data) return { _noCharge: true, _failed: true, text: "Couldn't read a usable profile from that site — fill the fields in manually." };

  const competitors = Array.isArray(data.top_competitor_domains) ? data.top_competitor_domains.filter(Boolean) : [];
  // Live SERP competitor enrichment (best-effort) supersedes the AI guess.
  try {
    const keywords = [...new Set([
      ...String(data.seed_keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
      ...(Array.isArray(data.seo_keywords) ? data.seo_keywords : []),
    ])];
    const live = await pmFindCompetitors(keywords, canonicalUrl, String(body.country || 'Singapore'));
    if (live.length) { competitors.length = 0; competitors.push(...live); }
  } catch { /* keep AI competitors */ }

  return {
    _noCharge: true,
    category: pmFieldText(data.client_profile),
    audience: pmFieldText(data.target_audience),
    objectives: pmObjectivesText(data.objectives),
    marketContext: pmFieldText(data.market_context),
    competitors,
  };
}

// ── Free helper: live SERP competitor discovery ──────────────────────────────
async function pmDiscoverCompetitors(body) {
  const keywords = splitItems(body.keywords);
  const live = await pmFindCompetitors(keywords, String(body.input || body.url || ''), String(body.country || 'Singapore')).catch(() => []);
  return { _noCharge: true, competitors: live };
}

async function pmFindCompetitors(keywords, ourUrl, location) {
  const kws = (keywords || []).map((k) => String(k || '').trim()).filter(Boolean).slice(0, 10);
  if (!kws.length) return [];
  const raw = deepBody(await postUpstream(UPSTREAMS.serpCompetitors, {
    id: 'pm_comp_' + Date.now(), user: 'saas-gateway', keywords: kws, location: location || 'Singapore', language: 'English',
  }, { timeoutMs: 25000 }));
  const results = raw && typeof raw === 'object' ? raw : {};
  const ours = cleanDomain(ourUrl);
  const GENERIC = ['google.', 'youtube.', 'facebook.', 'instagram.', 'linkedin.', 'reddit.', 'wikipedia.', 'twitter.', 'x.com', 'pinterest.', 'tiktok.', 'amazon.', 'medium.com', 'quora.com', 'yelp.', 'tripadvisor.', 'glassdoor.', 'indeed.', 'github.', 'apple.com', 'microsoft.com', 'yahoo.', 'bing.com', 'shopee.', 'lazada.', 'carousell.'];
  const rows = [];
  for (const domain in results) {
    const base = cleanDomain(domain);
    if (!base) continue;
    if (ours && (base.includes(ours) || ours.includes(base))) continue;
    if (GENERIC.some((g) => base.includes(g))) continue;
    const count = Object.keys(results[domain] || {}).length;
    if (count > 0) rows.push({ base, count });
  }
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, 6).map((r) => `${r.base} — ranks for ${r.count} of your keyword${r.count === 1 ? '' : 's'}`);
}

// ── Free helper (Pro): summarise the user's connected ad/analytics accounts ───
// Pulls live data server-side via the same integration layer the gsc/ga4/ads
// tools use, and returns text blocks the user drops into the Pro export fields.
async function pmConnectorsSummary(body) {
  const providers = Array.isArray(body.providers) && body.providers.length ? body.providers : ['google-ads', 'ga4', 'meta-ads'];
  const keyFor = { 'google-ads': 'googleAds', ga4: 'ga4', 'meta-ads': 'metaAds' };
  const out = { _noCharge: true, connected: {} };
  await Promise.allSettled(providers.map(async (provider) => {
    const conn = body._integrations?.[provider];
    out.connected[provider] = !!conn?.connected;
    if (!conn?.connected) return;
    try {
      const live = await fetchIntegrationFor(provider, conn, { range: 'Last 28 days', input: conn.account });
      if (!live?.rows) return;
      const text = `${summaryToFindings(live.summary || {})}\nBreakdown:\n${rowsToFindings(live.rows, 20)}`.trim();
      out[keyFor[provider]] = text;
    } catch { /* skip this provider */ }
  }));
  return out;
}

// Salvage-aware parse of the perf-marketing lambda's answer (the generator
// occasionally returns truncated JSON — recover what we can instead of failing).
function parsePmAnswer(raw) {
  const data = deepBody(raw);
  let answer = data?.answer != null ? data.answer : data;
  if (typeof answer === 'string') {
    let s = answer.trim();
    if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(s); } catch { return pmSalvageJson(s); }
  }
  return answer && typeof answer === 'object' ? answer : null;
}

// Recover a usable object from truncated/invalid JSON (port of index.html's
// pmSalvageJson): strip fences, close open strings/brackets, drop dangling
// keys/commas, else fall back to the largest closeable prefix.
function pmSalvageJson(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim();
  if (s.startsWith('```')) s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
  const a = s.search(/[[{]/); if (a > 0) s = s.slice(a);
  const parse = (x) => { try { return { ok: true, v: JSON.parse(x) }; } catch { return { ok: false }; } };
  let r = parse(s); if (r.ok) return r.v;
  r = parse(s.replace(/,(\s*[}\]])/g, '$1')); if (r.ok) return r.v;
  const close = (frag) => {
    const stk = []; let inStr = false, esc = false;
    for (let i = 0; i < frag.length; i++) {
      const c = frag[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') stk.push(c === '{' ? '}' : ']');
      else if (c === '}' || c === ']') stk.pop();
    }
    let out = frag + (inStr ? '"' : '');
    out = out.replace(/\s+$/, '');
    out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
    out = out.replace(/[:,]\s*$/, '').replace(/,(\s*[}\]])/g, '$1');
    for (let i = stk.length - 1; i >= 0; i--) out += stk[i];
    return out.replace(/,(\s*[}\]])/g, '$1');
  };
  r = parse(close(s)); if (r.ok) return r.v;
  for (let i = s.lastIndexOf('}'); i > 0; i = s.lastIndexOf('}', i - 1)) {
    r = parse(close(s.slice(0, i + 1)));
    if (r.ok) return r.v;
  }
  return null;
}

// Extract readable text from a scraped page body (string or {text}/{content}).
function pmExtractText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (typeof body === 'object') return pmExtractText(body.text || body.content || body.html || '');
  return '';
}

// Coerce the AI research fields (string | array | object) into plain text.
function pmFieldText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(pmFieldText).filter(Boolean).join('. ');
  if (typeof val === 'object') return val.description || val.text || val.value || val.name || Object.values(val).find((x) => typeof x === 'string') || '';
  return String(val);
}
function pmObjectivesText(v) {
  if (Array.isArray(v)) return v.map((o) => String(o).replace(/_/g, ' ')).join(', ');
  return pmFieldText(v);
}

// Lenient JSON extraction from a model text response (fences / prose wrapped).
function pmExtractJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  let clean = rawText.trim();
  if (clean.includes('```')) {
    const m = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    clean = m ? m[1] : clean.replace(/```(?:json)?/g, '').replace(/```/g, '');
  }
  const fb = clean.indexOf('{'), lb = clean.lastIndexOf('}');
  if (fb === -1 || lb <= fb) return null;
  return pmSalvageJson(clean.substring(fb, lb + 1));
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
async function selfInvokeFinalize(jobId, kind) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  _lambdaClient ||= new LambdaClient({});
  await _lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ __bgFinalize: true, jobId, ...(kind ? { kind } : {}) })),
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
    // Same self-deadline as the Content Optimiser: end in a readable state
    // rather than letting Lambda kill us mid-strategy-step (see cwDeadlineGuard).
    const guard = cwDeadlineGuard(context);
    let resp;
    try { resp = await Promise.race([handler(synthetic, context), guard.promise]); }
    finally { guard.cancel(); }
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
        kind: 'alert',
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
export const __test = { captionImages, publicInputs, renderStrategy, competitorsRun, competitorsCompare, mapLimit, firstCalloutText, FANOUT_CONCURRENCY, cwDeepCompareBrief, cwDeepComparePlan, cwMedianWordTarget, cwPublisher, cwEmptyView, cwFitAgents, OPTIMISER_AGENTS, connectReasonOf, callUpstream, crawlRun, crawlGateway, crawlRows, crawlSummary, crawlPartial, aiDiscoveryRun, aiVisibilityRun, backlinksRun, strategyEngineRun, contentOptimiserRun, contentWriterGateway, sectionsOptimiser, reconcileCost, contentCheckRun, timeToRankRun, anchorCleanerRun, perfMarketingRun, socialAuditRun, parseScaAnswer, schemaRun, keywordAnalysisRun, kwRows, cleanDomain, classifyAnchor, difficultyToTime, parseAgentResult, parsePrompts, brandPrompts, pageIssues, LOC_NAME, clampInt, sectionsChecker, sectionsAnchors, sectionsBacklinks, sectionsPerfMarketing, generateForensicRecommendations, faSeverityFor, faComputeHealthScore, faSections, faParseHomeHtml, faParseRobots, faValidTxt, faStripHtml, buildLlmsTxt, buildLlmsFull, extractSiteLinks, pmSalvageJson, parsePmAnswer, sdxBucketFor, sdxRankings, sectionsOnpage, onpageImages, altRationale, onpageUrl, sectionsPageSpeed };

/**
 * AI endpoints return token usage; convert to actual credits so a tiny caption
 * doesn't cost the same as a 2,000-word article. Falls back to the flat cost.
 *
 * Per-tool rate: content-writer legitimately fans out 10–30 LLM calls per run
 * (multi-stage writer + QA agents), so it meters at a tenth of the single-call
 * rate — a default 8-agent run lands on the advertised flat 5, while a Full
 * 18-agent audit reconciles to roughly 2–3× that instead of 60+. Keeps the
 * "500 credits ≈ 62 researched AI articles" plan promise true for normal runs while
 * finally making deeper runs cost more than shallow ones.
 */
const TOKENS_PER_CREDIT = { 'content-writer': 10000 };

function reconcileCost(tool, result, flatCost) {
  const u = result?.usage || result?.token_usage;
  if (tool.cost?.startsWith('ai_') && u) {
    const inTok = u.input_tokens || u.prompt_tokens || 0;
    const outTok = u.output_tokens || u.completion_tokens || 0;
    const perCredit = TOKENS_PER_CREDIT[tool.id] || 1000;
    const tokenCredits = Math.ceil((inTok + outTok) / perCredit);
    return Math.max(flatCost, tokenCredits);
  }
  return flatCost;
}

function usageMeta(result) {
  const u = result?.usage || result?.token_usage;
  return u ? { inputTokens: u.input_tokens, outputTokens: u.output_tokens } : {};
}

// Emit one CloudWatch Embedded Metric Format (EMF) line — a specially-shaped log
// object CloudWatch auto-converts into metrics, no PutMetricData call needed. We
// dimension on Source ONLY (two values: saas | index) to keep custom-metric
// cardinality — and its cost — minimal; `tool` rides along as a plain property
// for Logs Insights drilldowns, not as a metric dimension. The Admin Platform
// panel reads these back per source (GetMetricData) as the unified cross-surface
// runs + estimated-spend view. Logging must never sink a run, so it's swallowed.
// The staffAuth Lambda emits the matching Source='index' side for index.html.
function emitUsageMetric({ source, tool, creditsUsed = 0, estCostUSD = 0 }) {
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: 'Digimetrics/Usage',
          Dimensions: [['Source']],
          Metrics: [
            { Name: 'Runs', Unit: 'Count' },
            { Name: 'EstCostUSD', Unit: 'None' },
            { Name: 'CreditsUsed', Unit: 'Count' },
          ],
        }],
      },
      Source: source,
      tool,
      Runs: 1,
      EstCostUSD: Number(estCostUSD) || 0,
      CreditsUsed: Number(creditsUsed) || 0,
    }));
  } catch { /* metrics are best-effort — never break a paid run over a log */ }
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
