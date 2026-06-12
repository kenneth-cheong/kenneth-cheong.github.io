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
import { getUser, putUser, spendCredits, totalCredits } from '../lib/dynamo.mjs';
import { UPSTREAMS } from './upstreams.mjs';
import { ADAPTERS, parseStrategyJson } from './adapters.mjs';
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

  return ok({
    tool: tool.id,
    teaser,
    result: payload,
    creditsUsed,
    creditsRemaining,
  });
};

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

async function callUpstream(tool, body) {
  // Pure-client tools (e.g. schema builder) have no upstream.
  if (!tool.upstream) return { clientOnly: true };
  // The Strategy Engine is a two-step composite (generate → recommendations).
  if (tool.id === 'strategy-engine') return strategyEngineRun(body);

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
