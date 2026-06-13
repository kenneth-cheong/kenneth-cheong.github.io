// In-app feature API (authed unless noted): assistant chat, support tickets
// (threaded, attachments, replies), run history, in-platform notifications,
// and Google OAuth connect/callback for the Integrations tools.
import {
  getUser, totalCredits, spendCredits,
  listRuns, getRun,
  createTicket, getTicket, addTicketMessage, setTicketStatus, listTickets,
  setIntegration, redactIntegrations,
  addNotification, listNotifications, markNotificationsRead,
  createProject, listProjects, deleteProject,
  addTracked, listTracked, countTracked, removeTracked, appendSnapshot,
} from '../lib/dynamo.mjs';
import { rankPosition } from '../lib/rank.mjs';
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { CREDIT_COSTS, INTEGRATIONS, PLANS } from '../../../shared/catalog.mjs';
import { integrationSummary } from '../../../shared/connectors.mjs';
import { oauthConfigured, authUrl, exchangeCode, detectAccount, listAccounts } from '../lib/google.mjs';
import { signOAuthState, verifyOAuthState } from '../lib/jwt.mjs';
import { putAttachment } from '../lib/s3.mjs';
import { sendEmail, SUPPORT_INBOX } from '../lib/email.mjs';
import { isAdmin } from '../lib/admin.mjs';
import { ok, badRequest, unauthorized, paymentRequired, parseBody, claims, preflight } from '../lib/http.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';
const redirect = (url) => ({ statusCode: 302, headers: { Location: url }, body: '' });
const seg = (path, after) => decodeURIComponent((path.split(after)[1] || '').split('/')[0] || '');
// OAuth redirect URI, derived from the API's own request domain so the template
// needn't reference the API resource (that ref caused a CFN circular dependency).
// Same value in /integrations/authorize and /oauth/callback, so Google's exact-
// match requirement holds; it's also what must be registered in the console.
const oauthRedirectUri = (event) => `https://${event.requestContext?.domainName}/oauth/callback`;

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

    // ── Projects ──────────────────────────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/projects')) return ok({ projects: await listProjects(user.userId) });
    if (method === 'POST' && path.endsWith('/projects/delete')) { await deleteProject(user.userId, body.projectId); return ok({ ok: true }); }
    if (method === 'POST' && path.endsWith('/projects')) {
      const existing = await listProjects(user.userId);
      const limit = PLANS[user.tier]?.projects ?? 1;
      if (existing.length >= limit) return badRequest(`Your ${user.tier} plan allows ${limit} project${limit > 1 ? 's' : ''}. Upgrade for more.`);
      const name = (body.name || '').trim();
      const domain = (body.domain || '').trim();
      if (!name && !domain) return badRequest('A project name or domain is required.');
      const project = await createProject({ userId: user.userId, name, domain });
      return ok({ project });
    }

    // ── Keyword tracking (rank over time) ─────────────────────────────────────
    if (method === 'GET' && path.endsWith('/tracking')) {
      return ok({ tracked: await listTracked(user.userId, (event.queryStringParameters || {}).projectId) });
    }
    if (method === 'POST' && path.endsWith('/tracking/delete')) { await removeTracked(user.userId, body.trackId); return ok({ ok: true }); }
    if (method === 'POST' && path.endsWith('/tracking/refresh')) {
      const tracked = await listTracked(user.userId, body.projectId);
      const targets = body.trackId ? tracked.filter((t) => t.trackId === body.trackId) : tracked;
      for (const t of targets) {
        try { await appendSnapshot(user.userId, t.trackId, await rankPosition({ keyword: t.keyword, target: t.domain, location: t.location })); }
        catch (e) { console.error('track_refresh', t.trackId, e.message); }
      }
      return ok({ tracked: await listTracked(user.userId, body.projectId) });
    }
    if (method === 'POST' && path.endsWith('/tracking')) {
      const limit = PLANS[user.tier]?.trackedKeywords ?? 0;
      if ((await countTracked(user.userId)) >= limit) {
        return badRequest(limit === 0 ? 'Keyword tracking is a paid feature — upgrade to start tracking.' : `Your plan tracks up to ${limit} keywords. Upgrade for more.`);
      }
      const keyword = (body.keyword || '').trim();
      const domain = (body.domain || '').trim();
      if (!keyword || !domain) return badRequest('A keyword and domain are required.');
      const item = await addTracked({ userId: user.userId, projectId: body.projectId, keyword, domain, location: body.location });
      // Seed an initial data point so the chart isn't empty.
      try { await appendSnapshot(user.userId, item.trackId, await rankPosition({ keyword, target: domain, location: body.location })); } catch { /* best-effort */ }
      return ok({ tracked: (await listTracked(user.userId, body.projectId)).find((t) => t.trackId === item.trackId) || item });
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
      const ticket = await createTicket({ userId: user.userId, userEmail: user.email, additionalEmails, category: body.category, subject, message, attachments: body.attachments || [] });
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
    if (method === 'GET' && path.endsWith('/integrations/accounts')) {
      const provider = (event.queryStringParameters || {}).provider;
      const conn = (user.integrations || {})[provider];
      if (!conn?.connected) return ok({ accounts: [] });
      try { return ok({ accounts: await listAccounts(provider, conn) }); }
      catch (e) { return ok({ accounts: [], error: e.message }); }
    }
    if (method === 'GET' && path.endsWith('/integrations/authorize')) {
      const provider = (event.queryStringParameters || {}).provider;
      if (!INTEGRATIONS.some((p) => p.id === provider)) return badRequest('Unknown provider.');
      if (!oauthConfigured()) return badRequest('Google OAuth is not configured on this deployment.');
      return ok({ url: authUrl(provider, signOAuthState(user.userId, provider), oauthRedirectUri(event)) });
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
    const tok = await exchangeCode(q.code, oauthRedirectUri(event));
    // Only persist defined token fields (a re-consent may omit refresh_token).
    const tokens = {};
    if (tok.refresh_token) tokens.refreshToken = tok.refresh_token;
    if (tok.access_token) tokens.accessToken = tok.access_token;
    if (tok.expires_in) tokens.expiresAt = Date.now() + Number(tok.expires_in) * 1000;
    if (tok.scope) tokens.scope = tok.scope;

    // One Google consent grants the GSC + GA4 + Ads scopes, so connect all three
    // at once. Preserve any property/account the user already picked; only auto-
    // pick a default for a source that doesn't have one yet. Each source keeps
    // its own account, so they can point at different properties/accounts.
    const existing = (await getUser(st.sub))?.integrations || {};
    for (const provider of ['gsc', 'ga4', 'google-ads']) {
      let account = existing[provider]?.account || '';
      if (!account && tok.access_token) account = await detectAccount(provider, tok.access_token);
      await setIntegration({ userId: st.sub, provider, account, connected: true, tokens });
    }
    return redirect(`${APP_ORIGIN}/integrations?connected=google`);
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
  const context = await buildUserContext(user);
  const history = (messages || []).slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const userPrompt =
    "Reply ONLY with the assistant's next chat message. Hard rules: 2–4 short sentences max, " +
    'plain conversational text, NO markdown, NO headings, NO tables, NO bullet lists, NO preamble.\n\n' +
    'You are the in-app assistant for Digimetrics, a self-serve SEO + AI-content + AI-visibility ' +
    'SaaS. Be helpful and brief. You can answer questions about the user\'s OWN account, plan, ' +
    'credits/billing, projects (campaigns), tracked-keyword rankings, recent tool runs, and connected ' +
    'integrations using the context below — quote the real numbers, don\'t invent. For billing changes ' +
    '(upgrade, cancel, refunds) point them to the Pricing or Account page. If you cannot resolve an ' +
    'issue, suggest opening a support ticket.\n\n' +
    `Here is everything known about this user (their own data — safe to share with them):\n${context}\n\n` +
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

// Assemble a compact, factual snapshot of the user's account so the assistant
// can answer "how many credits do I have / what's my plan / how is X ranking"
// without inventing numbers. Everything here is the user's own data.
async function buildUserContext(user) {
  const fmtDate = (iso) => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return '—'; } };
  const plan = PLANS[user.tier] || PLANS.free;
  const monthly = user.credits || 0;
  const topup = user.topupCredits || 0;

  // Pull the data-backed sections in parallel; degrade gracefully if a table
  // is missing (e.g. the local harness) so chat never hard-fails.
  const [projects, tracked, runs] = await Promise.all([
    listProjects(user.userId).catch(() => []),
    listTracked(user.userId).catch(() => []),
    listRuns(user.userId, 6).catch(() => []),
  ]);

  const lines = [];
  lines.push('ACCOUNT');
  lines.push(`- Name: ${user.name || '—'} (${user.email || '—'})`);
  lines.push(`- Plan: ${plan.name}${plan.priceMonthly ? ` (S$${plan.priceMonthly}/mo)` : ' (free)'}`);
  lines.push(`- Member since: ${fmtDate(user.createdAt)}`);
  if (isAdmin(user.email)) lines.push('- Role: admin');

  lines.push('', 'CREDITS & BILLING');
  lines.push(`- Balance: ${monthly + topup} credits (${monthly} monthly + ${topup} top-up)`);
  lines.push(`- Monthly allowance: ${plan.monthlyCredits} credits/cycle (unused monthly credits expire; top-ups roll over)`);
  if (user.periodEnd) lines.push(`- Plan renews / resets on: ${fmtDate(user.periodEnd)}`);
  if (user.tier === 'free') lines.push('- On the free plan — upgrade on the Pricing page for more credits and features.');
  lines.push('- Top-ups available from S$15 (300 credits) on the Account page; they never expire.');

  const conns = user.integrations || {};
  const intg = Object.keys(conns).map((p) => integrationSummary(p, conns[p].account)).filter(Boolean);
  lines.push('', `INTEGRATIONS (${intg.length})`);
  if (intg.length) for (const s of intg) lines.push(`- ${s}`);
  else lines.push('- None connected. Connect Google Search Console / GA4 / Google Ads on the Integrations page.');

  lines.push('', `PROJECTS / CAMPAIGNS (${projects.length} of ${plan.projects} allowed)`);
  if (projects.length) for (const p of projects.slice(0, 15)) lines.push(`- ${p.name}${p.domain ? ` — ${p.domain}` : ''}`);
  else lines.push('- No projects yet. Create one on the Projects page to group runs and tracked keywords.');

  lines.push('', `TRACKED KEYWORDS (${tracked.length} of ${plan.trackedKeywords} allowed)`);
  if (tracked.length) {
    for (const t of tracked.slice(0, 20)) {
      const h = t.history || [];
      const pos = h.length ? h[h.length - 1].position : null;
      lines.push(`- "${t.keyword}"${t.domain ? ` (${t.domain})` : ''}: ${pos ? `#${pos}` : 'not yet checked'}`);
    }
  } else if (plan.trackedKeywords === 0) {
    lines.push('- Keyword tracking is a paid feature — available on Starter and above.');
  } else {
    lines.push('- None tracked yet. Add keywords on the Tracking page.');
  }

  lines.push('', 'RECENT TOOL RUNS');
  if (runs.length) for (const r of runs) lines.push(`- ${r.toolName || r.tool || 'Tool'} — ${fmtDate(r.ts)}${r.creditsUsed ? ` (${r.creditsUsed} credits)` : ''}`);
  else lines.push('- No tool runs yet.');

  return lines.join('\n');
}
