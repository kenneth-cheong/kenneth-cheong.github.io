// Shared assistant prompt + account-context builder, used by BOTH the streaming
// chat (chatstream, Anthropic Messages API) and the non-streaming fallback
// (app /chat → aiOptimiser). Keeping them in one place keeps the two paths
// behaviourally identical.
import { listProjects, listTracked, listRuns } from './dynamo.mjs';
import { isStaff } from './admin.mjs';
import { CREDIT_COSTS, PLANS, TOOLS } from '../../../shared/catalog.mjs';
import { integrationSummary } from '../../../shared/connectors.mjs';

export const TOOL_CATALOG = TOOLS
  .map((t) => `${t.id} — ${t.name} [${t.minTier}, ${CREDIT_COSTS[t.cost] ?? 0}cr]: ${t.desc}`)
  .join('\n');

// The behavioural rules + tool-recommendation + quick-action instructions.
export const CHAT_RULES =
  "Reply with the assistant's next chat message only. Keep it short and conversational " +
  '(2–5 sentences), NO markdown, NO headings, NO tables, NO bullet lists, NO preamble.\n\n' +
  'You are the in-app assistant for Digimetrics, a self-serve SEO + AI-content + AI-visibility ' +
  'SaaS. Be helpful and brief. You can answer questions about the user\'s OWN account, plan, ' +
  'credits/billing, projects (campaigns), tracked-keyword rankings, recent tool runs, and connected ' +
  'integrations using the context below — quote the real numbers, don\'t invent. For billing changes ' +
  '(upgrade, cancel, refunds) point them to the Pricing or Account page. If you cannot resolve an ' +
  'issue, suggest opening a support ticket.\n\n' +
  'RECOMMEND TOOLS: when a tool would help the user reach their goal, recommend the best 1–2 and ' +
  'link each by writing [[tool:<id>]] inline — the app renders that token as a clickable button that ' +
  'opens the tool. Use ids ONLY from the Tools list below (never invent one), prefer free/low-cost ' +
  'tools the user\'s tier can run, and don\'t write raw URLs or markdown links. Example: ' +
  '"To find low-competition keywords, try [[tool:keyword-analysis]]."\n\n' +
  'QUICK ACTIONS (use sparingly, only when the user clearly wants to act): to add a keyword to their ' +
  'rank tracking, write [[action:track|<keyword>]]; if you cannot resolve their issue, offer ' +
  '[[action:ticket|<short subject>]] to open a support ticket. These render as confirm buttons. Never ' +
  'invent data or claim an action is done — the button performs it after the user confirms.';

// Assemble a compact, factual snapshot of the user's account so the assistant
// can answer "how many credits do I have / what's my plan / how is X ranking"
// without inventing numbers. Everything here is the user's own data.
export async function buildUserContext(user) {
  const fmtDate = (iso) => { try { return new Date(iso).toISOString().slice(0, 10); } catch { return '—'; } };
  const plan = PLANS[user.tier] || PLANS.free;
  const monthly = user.credits || 0;
  const topup = user.topupCredits || 0;

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
  if (isStaff(user)) lines.push('- Role: admin');

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

/** Full system prompt for the chat (rules + tool catalog + this user's context). */
export async function buildChatSystem(user) {
  const context = await buildUserContext(user);
  return `${CHAT_RULES}\n\nTools you can recommend (id — name [min tier, credits]: what it does):\n${TOOL_CATALOG}\n\n` +
    `Here is everything known about this user (their own data — safe to share with them):\n${context}`;
}
