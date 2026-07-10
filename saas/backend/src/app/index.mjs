// In-app feature API (authed unless noted): assistant chat, support tickets
// (threaded, attachments, replies), run history, in-platform notifications,
// and Google OAuth connect/callback for the Integrations tools.
import {
  getUser, totalCredits, spendCredits,
  listRuns, getRun,
  saveConversation, listConversations, getConversation, deleteConversation,
  createTicket, getTicket, addTicketMessage, setTicketStatus, listTickets, listAllTickets,
  setIntegration, redactIntegrations,
  addNotification, listNotifications, markNotificationsRead,
  createProject, listProjects, deleteProject,
  addTracked, listTracked, countTracked, removeTracked, appendSnapshot, mergeSnapshots,
  listMetrics,
  createSchedule, listSchedules, getSchedule, updateSchedule, deleteSchedule, listScheduleRuns,
  exportAllUserData, deleteAllUserData, bumpTokenVersion, revokeSession,
  listAccessGrants, respondAccess, updateOnboarding, setEmailOptOut,
  updateProfile, claimProfileBonus,
} from '../lib/dynamo.mjs';
import { rankPosition, rankHistory } from '../lib/rank.mjs';
import { UPSTREAMS } from '../metering/upstreams.mjs';
import { CREDIT_COSTS, INTEGRATIONS, PLANS, PROFILE_FIELDS, PROFILE_BONUS, isProfileComplete, TOOLS, tierMeets, scheduleLimits, isSchedulable } from '../../../shared/catalog.mjs';
import { normaliseSchedule, nextRunAt } from '../../../shared/schedule.mjs';
import { compareRuns } from '../../../shared/metrics.mjs';
import { buildChatSystem } from '../lib/assistant.mjs';
import { integrationSummary } from '../../../shared/connectors.mjs';
import { connectorConfigured, providersInFamilyOf, familyOf, authorizeUrl, exchangeCodeFor, listAccountsFor, detectAccountFor, detectEmailFor, ga4CompatibleMetrics } from '../lib/integrations.mjs';
import { signOAuthState, verifyOAuthState } from '../lib/jwt.mjs';
import { putAttachment, signTicketAttachments, deleteUserAttachments } from '../lib/s3.mjs';
import Stripe from 'stripe';

// Only used by account deletion (to cancel an active subscription so a deleted
// account isn't billed). Null when no key is configured.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
import { sendEmail, sendRawEmail, sendSmtpEmail, sendNotice, smtpConfigured, SUPPORT_INBOX, noticeFrom } from '../lib/email.mjs';
import { buildAcceptancePdf } from '../lib/pdf.mjs';
import { isStaff, accountBlocked } from '../lib/admin.mjs';
import { ok, badRequest, unauthorized, forbidden, paymentRequired, tooManyRequests, serverError, parseBody, claims, preflight, isEmail, clampStr } from '../lib/http.mjs';
import { rateLimit, APP_LIMITS } from '../lib/ratelimit.mjs';

const APP_ORIGIN = process.env.APP_ORIGIN || '';
const redirect = (url) => ({ statusCode: 302, headers: { Location: url }, body: '' });
const seg = (path, after) => decodeURIComponent((path.split(after)[1] || '').split('/')[0] || '');

// ── Scheduled runs helpers ───────────────────────────────────────────────────
// Fire a tool run through the metering gateway exactly as the schedules cron
// does — a synthetic, authenticated /run event (Event mode) tagged with the
// scheduleId, so billing + history + the completion notification all flow
// through the one canonical path. Used by "Run now".
let _lambda = null;
async function invokeScheduledRun({ userId, email, tier, tool, inputs, projectId, scheduleId }) {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  _lambda ||= new LambdaClient({});
  const synthetic = {
    rawPath: `/run/${tool.id}`,
    requestContext: { http: { method: 'POST' }, authorizer: { lambda: { userId, email, tier } } },
    headers: {},
    body: JSON.stringify({ ...(inputs || {}), ...(projectId ? { projectId } : {}), _scheduleId: scheduleId }),
  };
  await _lambda.send(new InvokeCommand({
    FunctionName: process.env.METERING_FN,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify(synthetic)),
  }));
}

/** Keep only plain scalar/array input fields (drop gateway keys + oversized/odd
 *  values) before persisting a schedule's saved inputs. */
function sanitizeScheduleInputs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_') || k === 'projectId') continue;
    if (Object.keys(out).length >= 40) break;
    if (typeof v === 'string') out[k] = v.slice(0, 4000);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 100).map((x) => String(x).slice(0, 500));
  }
  return out;
}

// Lenient JSON extraction from an LLM reply (strips code fences / prose around it).
function parseJsonLoose(s) {
  if (!s) return null;
  let t = String(s).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

// Bound the beginner "north-star" plan before persisting it on the user record
// (stored under onboarding.plan). Purely defensive: clamps sizes/strings and
// keeps only known fields so a client can't write arbitrary/oversized blobs.
function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const strs = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map((x) => clampStr(x, len)).filter(Boolean);
  const items = (arr, n) => (Array.isArray(arr) ? arr : []).slice(0, n).map((s) => (s && typeof s === 'object' ? {
    ...(s.toolId ? { toolId: clampStr(s.toolId, 40) } : {}),
    ...(s.action ? { action: clampStr(s.action, 40) } : {}),
    ...(s.label ? { label: clampStr(s.label, 60) } : {}),
    why: clampStr(s.why, 200),
    ...(s.quickWin ? { quickWin: true } : {}),
    ...(s.locked ? { locked: true } : {}),
  } : null)).filter((s) => s && (s.toolId || s.action));
  const done = {};
  if (raw.done && typeof raw.done === 'object') {
    for (const k of Object.keys(raw.done).slice(0, 40)) if (raw.done[k]) done[clampStr(k, 40)] = true;
  }
  return {
    goals: strs(raw.goals, 8, 40),
    have: strs(raw.have, 8, 24),
    freeText: clampStr(raw.freeText, 500),
    steps: items(raw.steps, 20),
    locked: items(raw.locked, 20),
    extras: items(raw.extras, 10),
    quickWin: raw.quickWin ? clampStr(raw.quickWin, 40) : null,
    aiRefined: !!raw.aiRefined,
    done,
    updatedAt: new Date().toISOString(),
  };
}

// Coarse health of an integration pull, derived from the saved run preview
// (same heuristic as the History page): 'issue' | 'empty' | 'ok'.
function pullStatus(preview) {
  const p = String(preview || '').toLowerCase().trim();
  if (/couldn.?t|could not|unable|fail|error|reconnect|not connected|disconnect/.test(p)) return 'issue';
  if (/^0 rows?\b|^0$/.test(p)) return 'empty';
  return 'ok';
}
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

  // Generous per-user limiter across all in-app endpoints (chat, support,
  // tracking, integrations) — a cheap backstop against a runaway client.
  const rl = await rateLimit('app', c.userId, APP_LIMITS);
  if (!rl.allowed) return tooManyRequests(rl.retryAfter);

  const user = await getUser(c.userId);
  if (!user) return unauthorized('User not found');
  if (accountBlocked(user)) return forbidden({ error: 'account_suspended', status: user.status });
  const body = parseBody(event);

  try {
    // ── Assistant chat ──────────────────────────────────────────────────────
    // Conversation history (list / open / delete) — checked before the /chat
    // POST so the more specific paths win.
    if (method === 'GET' && path.endsWith('/chat/conversations')) {
      return ok({ conversations: await listConversations(user.userId) });
    }
    if (method === 'POST' && path.endsWith('/chat/conversations/delete')) {
      await deleteConversation(user.userId, body.conversationId); return ok({ ok: true });
    }
    if (method === 'GET' && path.includes('/chat/conversations/')) {
      const conv = await getConversation(user.userId, seg(path, '/chat/conversations/'));
      return conv ? ok({ conversation: conv }) : badRequest('Conversation not found');
    }
    if (method === 'POST' && path.endsWith('/chat')) {
      const cost = CREDIT_COSTS.ai_chat ?? 2;
      if (totalCredits(user) < cost) {
        return paymentRequired({ creditsRemaining: totalCredits(user), creditsNeeded: cost, tier: user.tier, topUpAvailable: true });
      }
      // Bound the conversation we forward: last 50 turns, each capped at 8k chars.
      const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-50)
        .map((m) => ({ ...m, content: clampStr(m?.content, 8000) }));
      const reply = await assistantReply(user, messages);
      const spent = await spendCredits({ userId: user.userId, cost, action: 'chat', tool: 'chatbot' });
      // Persist the thread (incl. this reply) so it shows in history. Best-effort
      // — a storage hiccup must not fail the chat the user already paid for.
      let conversationId = body.conversationId || null;
      try {
        const thread = [...messages, { role: 'assistant', content: reply }]
          .slice(-60).map((m) => ({ role: m.role, content: clampStr(m?.content, 4000) }));
        ({ conversationId } = await saveConversation({ userId: user.userId, conversationId, messages: thread }));
      } catch (e) { console.error('conversation_save', e.message); }
      return ok({ reply, conversationId, creditsUsed: cost, creditsRemaining: spent.total, topupRemaining: spent.topupCredits });
    }

    // ── Onboarding: persist first-run state (welcome, chosen goal, checklist) ──
    // Whitelisted keys only — this endpoint can't be used to write arbitrary
    // user fields. Returns the merged onboarding object for the client to cache.
    if (method === 'POST' && path.endsWith('/me/onboarding')) {
      const patch = {};
      if (typeof body.welcomed === 'boolean') patch.welcomed = body.welcomed;
      if (typeof body.dismissedChecklist === 'boolean') patch.dismissedChecklist = body.dismissedChecklist;
      if (typeof body.seenPlatformTour === 'boolean') patch.seenPlatformTour = body.seenPlatformTour;
      if (body.goal === null || typeof body.goal === 'string') patch.goal = body.goal ? clampStr(body.goal, 40) : null;
      // Legal consent. Record the accepted version and a server-stamped timestamp
      // (don't trust a client time) so we have a durable proof-of-acceptance.
      if (typeof body.acceptedTerms === 'boolean') {
        patch.acceptedTerms = body.acceptedTerms;
        if (body.acceptedTerms) patch.acceptedTermsAt = new Date().toISOString();
      }
      if (typeof body.acceptedTermsVersion === 'string') patch.acceptedTermsVersion = clampStr(body.acceptedTermsVersion, 20);
      // The beginner north-star plan (goal pathway + checklist progress) — synced
      // here so it follows the user across devices. `null` clears it.
      if (body.plan === null) patch.plan = null;
      else if (body.plan && typeof body.plan === 'object') { const p = sanitizePlan(body.plan); if (p) patch.plan = p; }
      if (!Object.keys(patch).length) return badRequest('Nothing to update.');
      return ok({ onboarding: await updateOnboarding(user.userId, patch) });
    }

    // ── Soft-launch Free Trial + NDA acceptance ──────────────────────────────
    // The trial user fills the company form and accepts the NDA. We persist a
    // durable, server-stamped proof-of-acceptance in `onboarding` (so the gate
    // never re-prompts) and notify tom@mediaone.co. Stricter than /me/onboarding:
    // all fields are required, validated and clamped here.
    if (method === 'POST' && path.endsWith('/me/nda')) {
      if (body.accepted !== true) return badRequest('You must accept the terms.');
      const form = {
        name: clampStr(body.name, 200).trim(),
        organisation: clampStr(body.organisation, 200).trim(),
        uen: clampStr(body.uen, 60).trim(),
        telephone: clampStr(body.telephone, 60).trim(),
        email: clampStr(body.email, 200).trim(),
      };
      const missing = Object.entries(form).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) return badRequest(`Missing required field(s): ${missing.join(', ')}`);
      if (!isEmail(form.email)) return badRequest('A valid email is required.');

      const version = clampStr(body.version, 20) || 'unversioned';
      const acceptedAt = new Date().toISOString();
      // Proof-of-consent record (per the NDA's Electronic Acceptance section):
      // capture IP + device/browser alongside the account/org details + version.
      const ip = event.requestContext?.http?.sourceIp || 'unknown';
      const userAgent = clampStr(event.headers?.['user-agent'] || event.headers?.['User-Agent'] || '', 400);
      const firstTime = user.onboarding?.acceptedNda !== true;
      const onboarding = await updateOnboarding(user.userId, {
        acceptedNda: true,
        acceptedNdaAt: acceptedAt,
        acceptedNdaVersion: version,
        acceptedNdaIp: ip,
        acceptedNdaUserAgent: userAgent,
        nda: form,
      });

      // Notify Tom + Kenneth (best-effort — acceptance is already saved). Only on
      // the first acceptance so re-runs after a version bump don't spam the inbox.
      // The full details ride along as a one-page "Acceptance Record" PDF; the
      // email body itself is a short summary.
      if (firstTime) {
        const subject = `Digimetrics Free Trial + NDA accepted — ${form.organisation || form.name}`;
        const text = [
          `${form.name} (${form.organisation}) accepted the Digimetrics Free Trial + NDA.`,
          '',
          `Email: ${form.email}`,
          `Account: ${user.email || '—'}`,
          `Accepted at (UTC): ${acceptedAt}`,
          `NDA version: ${version}`,
          '',
          'Full details are in the attached Acceptance Record (PDF).',
        ].join('\n');
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#0f172a;">`
          + `<h2 style="color:#1d4ed8;margin:0 0 6px;">New Free Trial + NDA acceptance</h2>`
          + `<p style="color:#475569;margin:0 0 14px;"><b>${form.name}</b> (${form.organisation}) confirmed they are authorised to accept the Digimetrics Free Trial and NDA Terms.</p>`
          + `<p style="color:#475569;margin:0;font-size:14px;">Email: ${form.email}<br>Account: ${user.email || '—'}<br>Accepted at (UTC): ${acceptedAt}<br>NDA version: ${version}</p>`
          + `<p style="color:#64748b;margin:16px 0 0;font-size:13px;">The full proof-of-consent details are in the attached <b>Acceptance Record (PDF)</b>.</p>`
          + `</div>`;

        let pdf = null;
        try {
          pdf = await buildAcceptancePdf({
            formName: form.name, organisation: form.organisation, uen: form.uen,
            telephone: form.telephone, formEmail: form.email,
            accountEmail: user.email, acceptedAt, ip, userAgent, version,
          });
        } catch (e) { console.warn('nda_pdf_failed', e.message); }

        const safeOrg = (form.organisation || form.name || 'trial-user').replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
        const filename = `Digimetrics-NDA-Acceptance-${safeOrg}.pdf`;
        const recipients = ['tom@mediaone.co', 'kenneth@mediaone.co'];
        const attachments = pdf ? [{ filename, contentType: 'application/pdf', content: pdf }] : [];
        // Prefer authenticated SMTP (Gmail/Workspace): it sends from a real
        // @mediaone.co mailbox, so the notification passes DMARC and lands cleanly.
        // Falls back to SES when SMTP isn't configured — but SES must send from a
        // non-mediaone.co address (NDA_NOTIFY_FROM, gmail p=none) because
        // mediaone.co's DMARC rejects unverified SES mail. The Admin → Agreements
        // view is the authoritative record regardless of email outcome.
        try {
          let sent = false;
          if (smtpConfigured()) {
            sent = await sendSmtpEmail({ to: recipients, replyTo: form.email, subject, text, html, attachments });
          }
          if (!sent) {
            const notifyFrom = process.env.NDA_NOTIFY_FROM || 'Digimetrics Free Trial <clarinet.kenneth@gmail.com>';
            if (pdf) {
              await sendRawEmail({ to: recipients, from: notifyFrom, replyTo: form.email, subject, text, html, attachments });
            } else {
              // PDF generation failed — still send the notification without it.
              await sendEmail({ to: recipients, from: notifyFrom, subject, text, html });
            }
          }
        } catch (e) { console.warn('nda_notify_failed', e.message); }
      }

      return ok({ onboarding });
    }

    // ── Progressive profiling: save profile answers, reward on completion ──────
    // Accepts ONLY known PROFILE_FIELDS keys (same safety posture as onboarding —
    // can't write arbitrary user fields) and validates select/multiselect values
    // against the field's declared `options`. When the merge completes the WHOLE
    // profile for the first time, grant a one-time PROFILE_BONUS of tokens.
    if (method === 'POST' && path.endsWith('/me/profile')) {
      const incoming = body.patch && typeof body.patch === 'object' ? body.patch : null;
      if (!incoming) return badRequest('patch (object) required.');
      const patch = {};
      for (const f of PROFILE_FIELDS) {
        if (!(f.key in incoming)) continue;
        const raw = incoming[f.key];
        if (f.type === 'multiselect') {
          const arr = Array.isArray(raw) ? raw : [];
          // keep declared options only, de-dup, cap length
          const allowed = new Set(f.options || []);
          patch[f.key] = [...new Set(arr.map((v) => clampStr(v, 60)).filter((v) => !f.options || allowed.has(v)))].slice(0, 30);
        } else if (f.type === 'select') {
          const v = clampStr(raw, 60);
          if (v === '' || (f.options && f.options.includes(v))) patch[f.key] = v;
        } else {
          // text / textarea
          patch[f.key] = clampStr(raw, f.type === 'textarea' ? 2000 : 200);
        }
      }
      if (!Object.keys(patch).length) return badRequest('No valid profile fields to update.');
      const profile = await updateProfile(user.userId, patch);
      // Grant the completion bonus once. Guard on the prior flag to skip the
      // conditional write in the common case; claimProfileBonus is itself atomic.
      let bonusGranted = false;
      const complete = isProfileComplete(profile);
      if (complete && !user.profileBonusGrantedAt) {
        bonusGranted = await claimProfileBonus({ userId: user.userId, amount: PROFILE_BONUS });
      }
      const fresh = await getUser(user.userId);
      return ok({ profile, complete, bonusGranted, bonusAmount: bonusGranted ? PROFILE_BONUS : 0, credits: totalCredits(fresh) });
    }

    // ── Email preferences: opt in/out of product-update broadcast emails ──────
    // (Transactional mail — verification, password reset, ticket replies — is
    // always sent and unaffected by this flag.)
    if (method === 'POST' && path.endsWith('/me/email-prefs')) {
      if (typeof body.emailOptOut !== 'boolean') return badRequest('emailOptOut (boolean) required.');
      await setEmailOptOut(user.userId, body.emailOptOut);
      return ok({ emailOptOut: body.emailOptOut });
    }

    // ── Consent: list + respond to staff data-access requests ────────────────
    if (method === 'GET' && path.endsWith('/me/access')) {
      return ok({ grants: await listAccessGrants(user.userId) });
    }
    if (method === 'POST' && path.endsWith('/me/access/respond')) {
      const action = ['grant', 'deny', 'revoke'].includes(body.action) ? body.action : null;
      if (!body.id || !action) return badRequest('id and action are required.');
      return ok({ grant: await respondAccess({ userId: user.userId, id: body.id, action }) });
    }

    // ── Sessions: revoke one device (body.sid) or all ("sign out everywhere") ──
    if (method === 'POST' && path.endsWith('/me/sessions/revoke')) {
      if (body.sid) { await revokeSession(user.userId, body.sid); return ok({ ok: true }); }
      await bumpTokenVersion(user.userId); // clears the whole session registry too
      return ok({ ok: true });
    }

    // ── Account data export + deletion (GDPR) ─────────────────────────────────
    if (method === 'GET' && path.endsWith('/me/export')) {
      return ok(await exportAllUserData(user.userId));
    }
    if (method === 'POST' && path.endsWith('/me/delete')) {
      // Cancel any active Stripe subscription first, so a deleted account isn't
      // billed again. Invoice history is kept on the Stripe customer for tax.
      if (user.stripeCustomerId && stripe) {
        try {
          const subs = await stripe.subscriptions.list({ customer: user.stripeCustomerId, status: 'active', limit: 20 });
          for (const s of subs.data) { try { await stripe.subscriptions.cancel(s.id); } catch (e) { console.error('delete_cancel_sub', s.id, e.message); } }
        } catch (e) { console.error('delete_stripe', e.message); }
      }
      try { await deleteUserAttachments(user.userId); } catch (e) { console.error('delete_attachments', e.message); }
      await deleteAllUserData(user.userId);
      return ok({ deleted: true });
    }

    // ── Site Health Check: synthesise several tool results into one scored,
    // beginner-friendly report (the sub-tools are run + charged client-side). ──
    if (method === 'POST' && path.endsWith('/audit/synthesize')) {
      const cost = CREDIT_COSTS.ai_short ?? 1;
      if (totalCredits(user) < cost) return paymentRequired({ creditsRemaining: totalCredits(user), creditsNeeded: cost, tier: user.tier, topUpAvailable: true });
      const url = clampStr(body.url || '', 200);
      const inputs = (Array.isArray(body.inputs) ? body.inputs : []).slice(0, 8);
      if (!inputs.length) return badRequest('Nothing to summarise.');
      const blocks = inputs.map((i) => `## ${clampStr(i.name || i.tool || 'Check', 80)}\n${clampStr(i.text || '', 2500)}`).join('\n\n');
      const userPrompt =
        `You are an SEO + AI-visibility expert writing a BEGINNER-friendly website health report for ${url || 'a website'}. ` +
        'Using the tool outputs below, return ONLY valid JSON (no markdown, no code fence) with EXACTLY this shape:\n' +
        '{"score": <0-100 integer overall health>, "grade": "<A|B|C|D|F>", "summary": "<2 plain-English sentences, no jargon>", ' +
        '"areas": [{"name": "<short>", "score": <0-100>, "status": "<good|fair|poor>", "note": "<one short line>"}], ' +
        '"fixes": [{"title": "<short action>", "priority": "<high|medium|low>", "why": "<one short line, plain English>"}]}\n' +
        'Rules: 4-6 areas; 5-8 fixes ordered highest-priority first; plain English (explain any term); be specific to the findings.\n\n' +
        `Tool outputs:\n${blocks}`;
      let aiText = '';
      try {
        const res = await fetch(UPSTREAMS.aiOptimiser, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'content_freeform', userPrompt }),
        });
        const t = await res.text();
        if (!res.ok) throw new Error('ai_unavailable');
        let raw; try { raw = JSON.parse(t); } catch { raw = t; }
        if (raw && typeof raw === 'object' && raw.body !== undefined) raw = typeof raw.body === 'string' ? JSON.parse(raw.body) : raw.body;
        aiText = typeof raw === 'string' ? raw : (raw.result || raw.text || raw.content || '');
      } catch { return serverError('Could not generate the audit summary — please try again.'); }
      const report = parseJsonLoose(aiText);
      if (!report || typeof report.score === 'undefined') return serverError('Could not parse the audit summary — please try again.');
      const spent = await spendCredits({ userId: user.userId, cost, action: 'audit_synthesis', tool: 'site-audit' });
      return ok({ report, creditsUsed: cost, creditsRemaining: spent.total, topupRemaining: spent.topupCredits });
    }

    // ── Run history ─────────────────────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/me/runs')) return ok({ runs: await listRuns(user.userId, 100) });
    if (method === 'GET' && path.includes('/me/runs/')) {
      const run = await getRun(user.userId, seg(path, '/me/runs/'));
      return run ? ok({ run }) : badRequest('Run not found');
    }

    // ── Scheduled tool runs ───────────────────────────────────────────────────
    // Recurring runs of a tool with saved inputs. The schedules cron fires them;
    // each run lands in history tagged with scheduleId so periods can be diffed.
    if (method === 'GET' && path.endsWith('/me/schedules')) {
      return ok({ schedules: await listSchedules(user.userId), limits: scheduleLimits(user.tier) });
    }
    // Period-over-period comparison of a schedule's two most recent runs.
    if (method === 'GET' && path.includes('/me/schedules/') && path.endsWith('/compare')) {
      const scheduleId = seg(path, '/me/schedules/');
      const s = await getSchedule(user.userId, scheduleId);
      if (!s) return badRequest('Schedule not found.');
      const runsSlim = await listScheduleRuns(scheduleId, 30); // GSI, newest first
      const [curFull, prevFull] = await Promise.all([
        runsSlim[0] ? getRun(user.userId, runsSlim[0].runId) : null,
        runsSlim[1] ? getRun(user.userId, runsSlim[1].runId) : null,
      ]);
      const comparison = curFull ? compareRuns(s.toolId, curFull.result, prevFull?.result || null) : [];
      return ok({
        schedule: s,
        runs: runsSlim.map((r) => ({ runId: r.runId, ts: r.ts, preview: r.preview, target: r.target, creditsUsed: r.creditsUsed })),
        comparison,
        current: curFull ? { runId: curFull.runId, ts: curFull.ts } : null,
        previous: prevFull ? { runId: prevFull.runId, ts: prevFull.ts } : null,
      });
    }
    if (method === 'POST' && path.endsWith('/me/schedules/update')) {
      const s = await getSchedule(user.userId, body.scheduleId);
      if (!s) return badRequest('Schedule not found.');
      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.name != null) patch.name = clampStr(body.name, 80);
      if (body.inputs && typeof body.inputs === 'object') patch.inputs = sanitizeScheduleInputs(body.inputs);
      if ('projectId' in body) patch.projectId = body.projectId || null;
      // Cadence change → renormalise, gate on plan, recompute the next fire, and
      // clear whichever day field no longer applies.
      if (body.frequency || body.hour != null || body.dayOfWeek != null || body.dayOfMonth != null || body.timezone) {
        const norm = normaliseSchedule({
          frequency: body.frequency || s.frequency, hour: body.hour ?? s.hour,
          dayOfWeek: body.dayOfWeek ?? s.dayOfWeek, dayOfMonth: body.dayOfMonth ?? s.dayOfMonth,
          timezone: body.timezone || s.timezone,
        });
        if (!norm.ok) return badRequest(norm.error);
        const limits = scheduleLimits(user.tier);
        if (!limits.freqs.includes(norm.spec.frequency)) return badRequest(`Your ${user.tier} plan allows ${limits.freqs.join(' / ') || 'no'} schedules.`);
        patch.frequency = norm.spec.frequency;
        patch.hour = norm.spec.hour;
        patch.timezone = norm.spec.timezone;
        patch.dayOfWeek = norm.spec.dayOfWeek ?? null;   // null → REMOVE the attribute
        patch.dayOfMonth = norm.spec.dayOfMonth ?? null;
        patch.nextRunAt = nextRunAt(norm.spec, Date.now());
      }
      // Re-enabling a schedule whose window has passed: roll it to the next fire
      // so it doesn't immediately run on the next tick.
      if (patch.enabled === true && patch.nextRunAt == null && s.nextRunAt <= Date.now()) {
        patch.nextRunAt = nextRunAt(s, Date.now());
      }
      const updated = await updateSchedule(user.userId, body.scheduleId, patch);
      return ok({ schedule: updated });
    }
    if (method === 'POST' && path.endsWith('/me/schedules/delete')) {
      await deleteSchedule(user.userId, body.scheduleId);
      return ok({ ok: true });
    }
    if (method === 'POST' && path.endsWith('/me/schedules/run-now')) {
      const s = await getSchedule(user.userId, body.scheduleId);
      if (!s) return badRequest('Schedule not found.');
      const tool = TOOLS.find((t) => t.id === s.toolId);
      if (!tool || !isSchedulable(tool)) return badRequest('That tool can’t be run.');
      await invokeScheduledRun({ userId: user.userId, email: user.email, tier: user.tier, tool, inputs: s.inputs, projectId: s.projectId, scheduleId: s.scheduleId });
      return ok({ ok: true, queued: true });
    }
    if (method === 'POST' && path.endsWith('/me/schedules')) {
      const limits = scheduleLimits(user.tier);
      if (!limits.enabled) return badRequest(`Scheduling isn’t available on the ${user.tier} plan — upgrade to automate tool runs.`);
      const tool = TOOLS.find((t) => t.id === body.toolId);
      if (!tool || !isSchedulable(tool)) return badRequest('That tool can’t be scheduled.');
      if (!tierMeets(user.tier, tool.minTier)) return badRequest(`Your plan can’t run ${tool.name} — upgrade to schedule it.`);
      const norm = normaliseSchedule(body);
      if (!norm.ok) return badRequest(norm.error);
      if (!limits.freqs.includes(norm.spec.frequency)) return badRequest(`Your ${user.tier} plan allows ${limits.freqs.join(' / ') || 'no'} schedules — pick a longer interval or upgrade.`);
      const existing = await listSchedules(user.userId);
      if (existing.length >= limits.maxSchedules) return badRequest(`Your ${user.tier} plan allows ${limits.maxSchedules} scheduled run${limits.maxSchedules === 1 ? '' : 's'}. Delete one or upgrade.`);
      const schedule = await createSchedule({
        userId: user.userId, toolId: tool.id, toolName: tool.name,
        name: clampStr(body.name, 80) || tool.name,
        inputs: sanitizeScheduleInputs(body.inputs), projectId: body.projectId || null,
        spec: norm.spec, nextRunAt: nextRunAt(norm.spec, Date.now()),
      });
      return ok({ schedule });
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

      // ── Historical backfill (billable) — pull past dated SERP snapshots and
      // merge them in. Charges rank_backfill credits per keyword; the client
      // confirms the cost before calling. Bill only keywords we actually fetch.
      if (body.backfill) {
        if (!targets.length) return badRequest('No keywords to backfill.');
        const per = CREDIT_COSTS.rank_backfill;
        const need = per * targets.length;
        const have = totalCredits(user);
        if (have < need) return badRequest(`Backfilling ${targets.length} keyword${targets.length > 1 ? 's' : ''} costs ${need} credits — you have ${have}. Top up or select fewer keywords.`);
        let charged = 0;
        for (let i = 0; i < targets.length; i += 5) {
          await Promise.all(targets.slice(i, i + 5).map(async (t) => {
            try {
              const points = await rankHistory({ keyword: t.keyword, target: t.domain, location: t.location });
              await mergeSnapshots(user.userId, t.trackId, points);
              await spendCredits({ userId: user.userId, cost: per, action: 'rank_backfill', tool: 'keyword-tracking', meta: { keyword: t.keyword } });
              charged += per;
            } catch (e) { console.error('track_backfill', t.trackId, e.message); }
          }));
        }
        return ok({ tracked: await listTracked(user.userId, body.projectId), charged });
      }

      // ── Live refresh (free) — check today's position in small parallel
      // batches so a big keyword set still finishes inside the Lambda timeout.
      for (let i = 0; i < targets.length; i += 8) {
        await Promise.all(targets.slice(i, i + 8).map(async (t) => {
          try { const { position, url } = await rankPosition({ keyword: t.keyword, target: t.domain, location: t.location }); await appendSnapshot(user.userId, t.trackId, position, url); }
          catch (e) { console.error('track_refresh', t.trackId, e.message); }
        }));
      }
      return ok({ tracked: await listTracked(user.userId, body.projectId) });
    }
    if (method === 'POST' && path.endsWith('/tracking')) {
      const limit = PLANS[user.tier]?.trackedKeywords ?? 0;
      const current = await countTracked(user.userId);
      // Tracking lives under a project: require one the user actually owns.
      if (!body.projectId) return badRequest('Create a project first — keywords are tracked under a project.');
      const projects = await listProjects(user.userId);
      if (!projects.some((p) => p.projectId === body.projectId)) return badRequest('That project no longer exists.');
      const domain = (body.domain || '').trim();

      // ── Bulk add (one record per keyword, no initial check — the user/daily
      // job fills positions via refresh, keeping this request fast). ──────────
      if (Array.isArray(body.keywords)) {
        if (!domain) return badRequest('A domain is required.');
        const kws = [...new Set(body.keywords.map((k) => String(k).trim()).filter(Boolean))].slice(0, 100);
        if (!kws.length) return badRequest('Add at least one keyword.');
        if (current + kws.length > limit) {
          return badRequest(limit === 0 ? 'Keyword tracking is a paid feature — upgrade to start tracking.' : `Your plan tracks up to ${limit} keywords — you have ${current}, so you can add ${Math.max(0, limit - current)} more.`);
        }
        await Promise.all(kws.map((keyword) => addTracked({ userId: user.userId, projectId: body.projectId, keyword, domain, location: body.location })));
        return ok({ tracked: await listTracked(user.userId, body.projectId) });
      }

      // ── Single add (seeds an initial data point so the chart isn't empty). ──
      if (current >= limit) {
        return badRequest(limit === 0 ? 'Keyword tracking is a paid feature — upgrade to start tracking.' : `Your plan tracks up to ${limit} keywords. Upgrade for more.`);
      }
      const keyword = (body.keyword || '').trim();
      if (!keyword || !domain) return badRequest('A keyword and domain are required.');
      const item = await addTracked({ userId: user.userId, projectId: body.projectId, keyword, domain, location: body.location });
      try { const { position, url } = await rankPosition({ keyword, target: domain, location: body.location }); await appendSnapshot(user.userId, item.trackId, position, url); } catch { /* best-effort */ }
      return ok({ tracked: (await listTracked(user.userId, body.projectId)).find((t) => t.trackId === item.trackId) || item });
    }

    // ── Tool performance metrics (headline scalars over time, per project) ─────
    if (method === 'GET' && path.endsWith('/metrics')) {
      return ok({ metrics: await listMetrics(user.userId, (event.queryStringParameters || {}).projectId) });
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
      const subject = clampStr((body.subject || '').trim(), 200);
      const message = clampStr((body.message || '').trim(), 10000);
      if (!subject || !message) return badRequest('Subject and message are required.');
      // Keep only well-formed addresses (drops junk before it reaches SES).
      const additionalEmails = (Array.isArray(body.additionalEmails) ? body.additionalEmails : [])
        .map((e) => String(e).trim()).filter(isEmail).slice(0, 10);
      // Optional fault diagnostics — keep only if it stays within a sane size so a
      // crafted payload can't bloat the ticket item (Dynamo items cap at 400KB).
      let diagnostics;
      if (body.diagnostics && typeof body.diagnostics === 'object') {
        try { if (JSON.stringify(body.diagnostics).length <= 20000) diagnostics = body.diagnostics; } catch { /* drop malformed */ }
      }
      const ticket = await createTicket({ userId: user.userId, userEmail: user.email, additionalEmails, category: body.category, subject, message, attachments: body.attachments || [], diagnostics });
      await addNotification({ userId: user.userId, title: `Ticket ${ticket.id} received`, body: subject, ticketId: ticket.ticketId });
      if (SUPPORT_INBOX) {
        const diagLine = diagnostics ? `\n\n— Diagnostics —\nPage: ${diagnostics.env?.url || 'n/a'}\nLast error: ${diagnostics.errors?.slice(-1)[0]?.message || 'none'}\nFailed calls: ${(diagnostics.apiFailures || []).map((f) => `${f.method} ${f.path} (${f.status || 'net'})`).join(', ') || 'none'}` : '';
        await sendNotice({ to: SUPPORT_INBOX, replyTo: user.email, subject: `New ticket ${ticket.id}: ${subject}`, text: `${user.email} opened a ticket.\n\n${message}${diagLine}` });
      }
      return ok({ ticket });
    }
    if (method === 'GET' && path.endsWith('/support/tickets')) {
      // Admin support console: every user's tickets. Otherwise just the caller's.
      if (event.queryStringParameters?.all && isStaff(user)) return ok({ tickets: await listAllTickets(), admin: true });
      return ok({ tickets: await listTickets(user.userId, 100) });
    }
    if (method === 'GET' && path.includes('/support/tickets/')) {
      // Admins can open any user's ticket by passing the owner's id.
      const owner = (isStaff(user) && event.queryStringParameters?.ownerUserId) || user.userId;
      const ticket = await getTicket(owner, seg(path, '/support/tickets/'));
      if (!ticket) return badRequest('Ticket not found');
      // Mint fresh presigned URLs for attachments (private bucket — stored urls expire).
      const signed = await signTicketAttachments(ticket);
      return ok({ ticket: isStaff(user) ? signed : redactTicketForCustomer(signed) });
    }
    if (method === 'POST' && path.includes('/reply')) {
      const ticketId = seg(path, '/support/tickets/');
      const text = clampStr((body.body || '').trim(), 10000);
      if (!text && !(body.attachments || []).length) return badRequest('Reply cannot be empty.');
      // Admins may answer another user's ticket (author = agent → notifies owner).
      const asAgent = !!body.asAgent && isStaff(user);
      const ownerId = asAgent && body.ownerUserId ? body.ownerUserId : user.userId;
      const author = asAgent ? 'agent' : 'user';
      // Staff choose the identity the customer sees: reply as "Monty" (the
      // platform persona — hides who the real person was) or as themselves (their
      // own name/email). Resolved server-side so the client can't spoof a name.
      const asMonty = asAgent && body.fromMonty !== false; // default to Monty
      const authorName = author === 'agent' ? (asMonty ? 'Monty' : (user.name || user.email)) : '';
      // Public email shown to the customer: none for a Monty reply (stay in
      // persona); the staff address when they reply as themselves. `agentEmail`
      // always records who really sent it, for admin accountability (redacted
      // from the customer's copy of the ticket).
      const publicEmail = author === 'agent' ? (asMonty ? '' : user.email) : user.email;
      const { ticket } = await addTicketMessage({ userId: ownerId, ticketId, author, authorEmail: publicEmail, authorName, agentEmail: author === 'agent' ? user.email : undefined, body: text, attachments: body.attachments || [] });
      // For an agent reply, return whether the customer was actually emailed so
      // the admin UI can warn the staff member when delivery failed.
      let email = null;
      if (author === 'agent') email = await notifyReply(ownerId, ticket, text, authorName);
      else if (SUPPORT_INBOX) await sendNotice({ to: SUPPORT_INBOX, replyTo: user.email, subject: `Reply on ${ticket.id}`, text: `${user.email} replied:\n\n${text}` });
      return ok({ ticket: isStaff(user) ? ticket : redactTicketForCustomer(ticket), email });
    }
    if (method === 'POST' && path.includes('/close')) {
      // Admins can close any user's ticket by passing the owner's id.
      const owner = (isStaff(user) && body.ownerUserId) || user.userId;
      await setTicketStatus(owner, seg(path, '/support/tickets/'), 'closed');
      return ok({ ok: true });
    }

    // ── Integrations (Google OAuth) ───────────────────────────────────────────
    if (method === 'GET' && path.endsWith('/integrations')) {
      // Surface every connector, flagging whether its OAuth is wired up on this
      // deployment. Unconfigured ones render as "Coming soon" (no dead Connect
      // button) rather than vanishing — so a tool that says "connect in
      // Integrations" never points at a source that isn't listed.
      const providers = INTEGRATIONS.map((p) => ({ ...p, configured: connectorConfigured(p.id) }));
      // Last-pull health per source, derived from the most recent run of each
      // integration tool (newest-first), so the UI can flag "data flowing" vs
      // "no data / failed" beyond just "account selected".
      const lastPull = {};
      try {
        const recent = await listRuns(user.userId, 100);
        for (const p of providers) {
          if (!p.configured) continue;
          const r = recent.find((x) => x.tool === p.id);
          if (r) lastPull[p.id] = { status: pullStatus(r.preview), at: r.ts };
        }
      } catch { /* best-effort */ }
      return ok({ providers, connected: redactIntegrations(user.integrations), oauthReady: connectorConfigured('gsc'), lastPull });
    }
    if (method === 'GET' && path.endsWith('/integrations/accounts')) {
      const provider = (event.queryStringParameters || {}).provider;
      const conn = (user.integrations || {})[provider];
      if (!conn?.connected) return ok({ accounts: [] });
      try { return ok({ accounts: await listAccountsFor(provider, conn) }); }
      catch (e) { return ok({ accounts: [], error: e.message }); }
    }
    // GA4: which extra metrics are valid for a chosen breakdown dimension, so the
    // UI can disable the rest. metrics:null → "unknown, allow all" (never blocks).
    if (method === 'GET' && path.endsWith('/integrations/ga4/compatibility')) {
      const conn = (user.integrations || {}).ga4;
      if (!conn?.connected) return ok({ metrics: null });
      const dimension = (event.queryStringParameters || {}).dimension || 'channel';
      try { return ok({ metrics: await ga4CompatibleMetrics(conn, dimension) }); }
      catch (e) { return ok({ metrics: null, error: e.message }); }
    }
    if (method === 'GET' && path.endsWith('/integrations/authorize')) {
      const provider = (event.queryStringParameters || {}).provider;
      // single=1 → connect a different account for just this source, not the whole family.
      const single = (event.queryStringParameters || {}).single === '1';
      if (!INTEGRATIONS.some((p) => p.id === provider)) return badRequest('Unknown provider.');
      if (!connectorConfigured(provider)) return badRequest('This integration is not configured on this deployment.');
      return ok({ url: authorizeUrl(provider, signOAuthState(user.userId, provider, single), oauthRedirectUri(event)) });
    }
    if (method === 'POST' && path.endsWith('/integrations/connect')) {
      // Used for disconnect, per-source account-clear, or to set/override the account id for a provider.
      if (!INTEGRATIONS.some((p) => p.id === body.provider)) return badRequest('Unknown provider.');
      const connected = await setIntegration({ userId: user.userId, provider: body.provider, account: body.account, connected: body.connected !== false, clearAccount: body.clearAccount === true });
      return ok({ connected });
    }

    return badRequest('Unknown route');
  } catch (err) {
    if (err.code === 'insufficient_credits') return paymentRequired({ creditsRemaining: totalCredits(user), tier: user.tier, topUpAvailable: true });
    // Log the detail server-side; return a generic message so internal errors
    // (DynamoDB validation, upstream URLs, etc.) never leak to the client.
    console.error('app_error', method, path, err);
    return serverError('Something went wrong. Please try again.');
  }
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function oauthCallback(event) {
  const q = event.queryStringParameters || {};
  try {
    if (q.error) throw new Error(q.error);
    const st = verifyOAuthState(q.state);
    const provider = st.provider;
    const tok = await exchangeCodeFor(provider, q.code, oauthRedirectUri(event));
    // Only persist defined token fields (a re-consent may omit refresh_token).
    const tokens = {};
    if (tok.refresh_token) tokens.refreshToken = tok.refresh_token;
    if (tok.access_token) tokens.accessToken = tok.access_token;
    if (tok.expires_in) tokens.expiresAt = Date.now() + Number(tok.expires_in) * 1000;
    if (tok.scope) tokens.scope = tok.scope;

    // By default one consent connects every source in the provider's family
    // (Google's sign-in grants GSC + GA4 + Ads). A `single` state scopes it to
    // just the one source, so a user can auth a different Google account per tool.
    const targets = st.single ? [provider] : providersInFamilyOf(provider);
    // Which account this consent signed in as — shown per-source in the UI.
    const email = tok.access_token ? await detectEmailFor(provider, tok.access_token) : '';
    // Preserve any account the user already picked; only auto-pick a default for
    // a source that doesn't have one yet. For a single-source re-auth we clear it
    // first — the old account id may belong to the previously-signed-in account.
    const existing = (await getUser(st.sub))?.integrations || {};
    for (const pid of targets) {
      let account = st.single ? '' : (existing[pid]?.account || '');
      if (!account && tok.access_token) account = await detectAccountFor(pid, tok.access_token);
      await setIntegration({ userId: st.sub, provider: pid, account, connected: true, tokens, email });
    }
    return redirect(`${APP_ORIGIN}/integrations?connected=${familyOf(provider) || 'google'}`);
  } catch (e) {
    console.error('oauth_callback_error', e.message);
    return redirect(`${APP_ORIGIN}/integrations?error=oauth`);
  }
}

// Notify the ticket owner of an agent reply. The in-app notification always
// fires; the email is best-effort. Returns delivery info so the replying staff
// member can be warned when the customer wasn't reached by email.
//   delivered: true  → email sent, false → send failed, null → no address on file
// Strip the internal `agentEmail` (who on staff really sent an agent reply)
// from a ticket before it's served to the customer — they only ever see the
// public identity (authorName / authorEmail). Admins keep the full record.
function redactTicketForCustomer(ticket) {
  if (!ticket?.messages) return ticket;
  ticket.messages = ticket.messages.map(({ agentEmail, ...m }) => m);
  return ticket;
}

async function notifyReply(ownerId, ticket, text, senderName) {
  const who = senderName || 'Support';
  await addNotification({ userId: ownerId, title: `${who} replied to ${ticket.id}`, body: text.slice(0, 120), ticketId: ticket.ticketId });
  const recipients = [ticket.userEmail, ...(ticket.additionalEmails || [])].filter(Boolean);
  const delivered = recipients.length
    ? await sendNotice({
        to: recipients,
        from: noticeFrom(`${who} · Digimetrics Support`),
        replyTo: SUPPORT_INBOX || undefined,
        subject: `Re: ${ticket.subject} [${ticket.id}]`,
        text: `${who} has replied to your ticket ${ticket.id}:\n\n${text}\n\nView it: ${APP_ORIGIN}/support/${encodeURIComponent(ticket.ticketId)}`,
      })
    : null;
  return { recipients, delivered };
}

async function assistantReply(user, messages) {
  const query = [...(messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
  const system = await buildChatSystem(user, query);
  const history = (messages || []).slice(-10).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n');
  const userPrompt = `${system}\n\nConversation so far:\n${history}\n\nAssistant:`;
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
