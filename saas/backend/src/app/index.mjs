// In-app feature API (authed unless noted): assistant chat, support tickets
// (threaded, attachments, replies), run history, in-platform notifications,
// and Google OAuth connect/callback for the Integrations tools.
import {
  getUser, totalCredits, spendCredits,
  listRuns, getRun,
  createTicket, getTicket, addTicketMessage, setTicketStatus, listTickets,
  setIntegration, redactIntegrations,
  addNotification, listNotifications, markNotificationsRead,
} from '../lib/dynamo.mjs';
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { CREDIT_COSTS, INTEGRATIONS } from '../../../shared/catalog.mjs';
import { integrationSummary } from '../../../shared/connectors.mjs';
import { oauthConfigured, authUrl, exchangeCode, detectAccount } from '../lib/google.mjs';
import { signOAuthState, verifyOAuthState } from '../lib/jwt.mjs';
import { putAttachment } from '../lib/s3.mjs';
import { sendEmail, SUPPORT_INBOX } from '../lib/email.mjs';
import { isAdmin } from '../lib/admin.mjs';
import { ok, badRequest, unauthorized, paymentRequired, parseBody, claims, preflight } from '../lib/http.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';
const redirect = (url) => ({ statusCode: 302, headers: { Location: url }, body: '' });
const seg = (path, after) => decodeURIComponent((path.split(after)[1] || '').split('/')[0] || '');

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === 'OPTIONS') return preflight();
  const path = event.rawPath || '';

  // ── Public: Google OAuth callback (identity carried in the signed state) ──
  if (method === 'GET' && path.endsWith('/oauth/callback')) return oauthCallback(event);

  const c = claims(event);
  if (!c?.userId) return unauthorized();
  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');
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
    if (method === 'GET' && path.endsWith('/me/runs')) return ok({ runs: await listRuns(user.userId, 100) });
    if (method === 'GET' && path.includes('/me/runs/')) {
      const run = await getRun(user.userId, seg(path, '/me/runs/'));
      return run ? ok({ run }) : badRequest('Run not found');
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/me/notifications')) return ok({ notifications: await listNotifications(user.userId) });
    if (method === 'POST' && path.endsWith('/me/notifications/read')) { await markNotificationsRead(user.userId); return ok({ ok: true }); }

    // ── Support tickets ───────────────────────────────────────────────────────
    if (method === 'POST' && path.endsWith('/support/attachments')) {
      const att = await putAttachment({ userId: user.userId, name: body.name, contentType: body.contentType, dataBase64: body.data });
      return ok({ attachment: att });
    }
    if (method === 'POST' && path.endsWith('/support/tickets')) {
      const subject = (body.subject || '').trim();
      const message = (body.message || '').trim();
      if (!subject || !message) return badRequest('Subject and message are required.');
      const additionalEmails = (body.additionalEmails || []).map((e) => String(e).trim()).filter(Boolean).slice(0, 10);
      const ticket = await createTicket({ userId: user.userId, userEmail: user.email, additionalEmails, subject, message, attachments: body.attachments || [] });
      await addNotification({ userId: user.userId, title: `Ticket ${ticket.id} received`, body: subject, ticketId: ticket.ticketId });
      if (SUPPORT_INBOX) await sendEmail({ to: SUPPORT_INBOX, subject: `New ticket ${ticket.id}: ${subject}`, text: `${user.email} opened a ticket.\n\n${message}` });
      return ok({ ticket });
    }
    if (method === 'GET' && path.endsWith('/support/tickets')) return ok({ tickets: await listTickets(user.userId, 100) });
    if (method === 'GET' && path.includes('/support/tickets/')) {
      const ticket = await getTicket(user.userId, seg(path, '/support/tickets/'));
      return ticket ? ok({ ticket }) : badRequest('Ticket not found');
    }
    if (method === 'POST' && path.includes('/reply')) {
      const ticketId = seg(path, '/support/tickets/');
      const text = (body.body || '').trim();
      if (!text && !(body.attachments || []).length) return badRequest('Reply cannot be empty.');
      // Admins may answer another user's ticket (author = agent → notifies owner).
      const asAgent = !!body.asAgent && isAdmin(user.email);
      const ownerId = asAgent && body.ownerUserId ? body.ownerUserId : user.userId;
      const author = asAgent ? 'agent' : 'user';
      const { ticket } = await addTicketMessage({ userId: ownerId, ticketId, author, authorEmail: user.email, body: text, attachments: body.attachments || [] });
      if (author === 'agent') await notifyReply(ownerId, ticket, text);
      else if (SUPPORT_INBOX) await sendEmail({ to: SUPPORT_INBOX, subject: `Reply on ${ticket.id}`, text: `${user.email} replied:\n\n${text}` });
      return ok({ ticket });
    }
    if (method === 'POST' && path.includes('/close')) {
      await setTicketStatus(user.userId, seg(path, '/support/tickets/'), 'closed');
      return ok({ ok: true });
    }

    // ── Integrations (Google OAuth) ───────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/integrations')) {
      return ok({ providers: INTEGRATIONS, connected: redactIntegrations(user.integrations), oauthReady: oauthConfigured() });
    }
    if (method === 'GET' && path.endsWith('/integrations/authorize')) {
      const provider = (event.queryStringParameters || {}).provider;
      if (!INTEGRATIONS.some((p) => p.id === provider)) return badRequest('Unknown provider.');
      if (!oauthConfigured()) return badRequest('Google OAuth is not configured on this deployment.');
      return ok({ url: authUrl(provider, signOAuthState(user.userId, provider)) });
    }
    if (method === 'POST' && path.endsWith('/integrations/connect')) {
      // Used for disconnect, or to set/override the account id for a provider.
      if (!INTEGRATIONS.some((p) => p.id === body.provider)) return badRequest('Unknown provider.');
      const connected = await setIntegration({ userId: user.userId, provider: body.provider, account: body.account, connected: body.connected !== false });
      return ok({ connected });
    }

    return badRequest('Unknown route');
  } catch (err) {
    if (err.code === 'insufficient_credits') return paymentRequired({ creditsRemaining: totalCredits(user), tier: user.tier, topUpAvailable: true });
    console.error('app_error', method, path, err);
    return badRequest(err.message || 'Request failed');
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function oauthCallback(event) {
  const q = event.queryStringParameters || {};
  try {
    if (q.error) throw new Error(q.error);
    const st = verifyOAuthState(q.state);
    const tok = await exchangeCode(q.code);
    let account = '';
    if (tok.access_token) account = await detectAccount(st.provider, tok.access_token);
    // Only persist defined token fields (a re-consent may omit refresh_token).
    const tokens = {};
    if (tok.refresh_token) tokens.refreshToken = tok.refresh_token;
    if (tok.access_token) tokens.accessToken = tok.access_token;
    if (tok.expires_in) tokens.expiresAt = Date.now() + Number(tok.expires_in) * 1000;
    if (tok.scope) tokens.scope = tok.scope;
    await setIntegration({ userId: st.sub, provider: st.provider, account, connected: true, tokens });
    return redirect(`${APP_ORIGIN}/integrations?connected=${st.provider}`);
  } catch (e) {
    console.error('oauth_callback_error', e.message);
    return redirect(`${APP_ORIGIN}/integrations?error=oauth`);
  }
}

async function notifyReply(ownerId, ticket, text) {
  await addNotification({ userId: ownerId, title: `Support replied to ${ticket.id}`, body: text.slice(0, 120), ticketId: ticket.ticketId });
  const to = [ticket.userEmail, ...(ticket.additionalEmails || [])].filter(Boolean);
  await sendEmail({
    to,
    subject: `Re: ${ticket.subject} [${ticket.id}]`,
    text: `Support has replied to your ticket ${ticket.id}:\n\n${text}\n\nView it: ${APP_ORIGIN}/support/${encodeURIComponent(ticket.ticketId)}`,
  });
}

async function assistantReply(user, messages) {
  const conns = user.integrations || {};
  const context = Object.keys(conns).map((p) => integrationSummary(p, conns[p].account)).filter(Boolean).join('\n');
  const history = (messages || []).slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const userPrompt =
    "Reply ONLY with the assistant's next chat message. Hard rules: 2–4 short sentences max, " +
    'plain conversational text, NO markdown, NO headings, NO tables, NO bullet lists, NO preamble.\n\n' +
    'You are the in-app assistant for Digimetrics, a self-serve SEO + AI-content + AI-visibility ' +
    'SaaS. Be helpful and brief. If you cannot resolve an issue, suggest opening a support ticket.\n\n' +
    (context ? `The user's connected account data (use it to answer data questions):\n${context}\n\n` : '') +
    `Conversation so far:\n${history}\n\nAssistant:`;
  const res = await fetch(UPSTREAMS.aiOptimiser, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'content_freeform', userPrompt }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('The assistant is unavailable right now.');
  let raw; try { raw = JSON.parse(text); } catch { raw = text; }
  if (raw && typeof raw === 'object' && raw.body !== undefined) raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
  return (typeof raw === 'string' ? raw : (raw.result || raw.text || raw.content || '')) || '(no reply)';
}
