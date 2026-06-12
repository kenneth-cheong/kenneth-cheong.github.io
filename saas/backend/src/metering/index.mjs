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
import { ADAPTERS } from './adapters.mjs';
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

async function callUpstream(tool, body) {
  // Pure-client tools (e.g. schema builder) have no upstream.
  if (!tool.upstream) return { clientOnly: true };
  const url = UPSTREAMS[tool.upstream];
  if (!url) throw new Error(`No upstream URL for ${tool.upstream}`);

  const adapter = ADAPTERS[tool.id];
  const payload = adapter ? adapter.request(body) : body;

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
  // Many upstreams return an API-Gateway-proxy envelope { statusCode, body }.
  // Unwrap to the inner payload (parsing body if it's a JSON string) so the
  // adapter/normaliser sees the real content.
  if (raw && typeof raw === 'object' && raw.statusCode !== undefined && raw.body !== undefined) {
    raw = typeof raw.body === 'string' ? safeParse(raw.body) : raw.body;
  }
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
