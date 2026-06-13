// In-app feature API (authed): assistant chat, support tickets, run history,
// and Google integration connect state.
//
//   POST /chat                  -> assistant reply (charges ai_chat credits)
//   GET  /me/runs               -> run-history list (slim)
//   GET  /me/runs/{runId}       -> one saved run (full inputs + result)
//   GET  /support/tickets       -> the user's tickets
//   POST /support/tickets       -> open a ticket
//   GET  /integrations          -> connectable providers + connection state
//   POST /integrations/connect  -> connect/disconnect a provider
import {
  getUser, totalCredits, spendCredits,
  listRuns, getRun, createTicket, listTickets, setIntegration,
} from '../lib/dynamo.mjs';
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { CREDIT_COSTS, INTEGRATIONS } from '../../../shared/catalog.mjs';
import { integrationSummary } from '../../../shared/connectors.mjs';
import { ok, badRequest, unauthorized, paymentRequired, parseBody, claims, preflight } from '../lib/http.mjs';

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return preflight();

  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');

  const path = event.rawPath || '';
  const body = parseBody(event);

  try {
    // ── Assistant chat ──────────────────────────────────────────────────────
    if (method === 'POST' && path.endsWith('/chat')) {
      const cost = CREDIT_COSTS.ai_chat ?? 2;
      if (totalCredits(user) < cost) {
        return paymentRequired({ creditsRemaining: totalCredits(user), creditsNeeded: cost, tier: user.tier, topUpAvailable: true });
      }
      const reply = await assistantReply(user, body.messages || []);
      const spent = await spendCredits({ userId: user.userId, cost, action: 'chat', tool: 'chatbot' });
      return ok({ reply, creditsUsed: cost, creditsRemaining: spent.total });
    }

    // ── Run history ─────────────────────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/me/runs')) {
      return ok({ runs: await listRuns(user.userId, 100) });
    }
    if (method === 'GET' && path.includes('/me/runs/')) {
      const runId = decodeURIComponent(event.pathParameters?.runId || path.split('/me/runs/')[1] || '');
      const run = await getRun(user.userId, runId);
      return run ? ok({ run }) : badRequest('Run not found');
    }

    // ── Support tickets ───────────────────────────────────────────────────────
    if (method === 'POST' && path.endsWith('/support/tickets')) {
      const subject = (body.subject || '').trim();
      const message = (body.message || '').trim();
      if (!subject || !message) return badRequest('Subject and message are required.');
      const ticket = await createTicket({ userId: user.userId, email: body.email || user.email, subject, message });
      return ok({ ticket });
    }
    if (method === 'GET' && path.endsWith('/support/tickets')) {
      return ok({ tickets: await listTickets(user.userId, 100) });
    }

    // ── Integrations ──────────────────────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/integrations')) {
      return ok({ providers: INTEGRATIONS, connected: user.integrations || {} });
    }
    if (method === 'POST' && path.endsWith('/integrations/connect')) {
      if (!INTEGRATIONS.some((p) => p.id === body.provider)) return badRequest('Unknown provider.');
      const integrations = await setIntegration({ userId: user.userId, provider: body.provider, account: body.account, connected: body.connected !== false });
      return ok({ connected: integrations });
    }

    return badRequest('Unknown route');
  } catch (err) {
    if (err.code === 'insufficient_credits') {
      return paymentRequired({ creditsRemaining: totalCredits(user), tier: user.tier, topUpAvailable: true });
    }
    console.error('app_error', method, path, err);
    return badRequest(err.message || 'Request failed');
  }
};

// The assistant is a Claude call via the existing aiOptimiser bridge, primed
// with the user's CONNECTED account data so it can answer questions about their
// own GSC / GA4 / Ads numbers.
async function assistantReply(user, messages) {
  const conns = user.integrations || {};
  const context = Object.keys(conns)
    .map((p) => integrationSummary(p, conns[p].account))
    .filter(Boolean).join('\n');
  const history = (messages || []).slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');

  const userPrompt =
    "Reply ONLY with the assistant's next chat message. Hard rules: 2–4 short sentences max, " +
    'plain conversational text, NO markdown, NO headings, NO tables, NO bullet lists, NO preamble.\n\n' +
    'You are the in-app assistant for Digimetrics, a self-serve SEO + AI-content + AI-visibility ' +
    'SaaS. Be helpful and brief. If you cannot resolve an issue, suggest opening a support ticket.\n\n' +
    (context ? `The user's connected account data (use it to answer data questions):\n${context}\n\n` : '') +
    `Conversation so far:\n${history}\n\nAssistant:`;

  const res = await fetch(UPSTREAMS.aiOptimiser, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'content_freeform', userPrompt }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('The assistant is unavailable right now.');
  let raw; try { raw = JSON.parse(text); } catch { raw = text; }
  if (raw && typeof raw === 'object' && raw.body !== undefined) {
    raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  }
  return (typeof raw === 'string' ? raw : (raw.result || raw.text || raw.content || '')) || '(no reply)';
}
