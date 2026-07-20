// Product knowledge base for the assistant — authoritative facts about how
// Digimetrics works (credits, billing, integrations, tools, data, etc.) so the
// chatbot grounds how-to/policy answers instead of guessing. Small, curated
// corpus → lexical retrieval (top-k by term overlap) keeps the prompt lean
// without any vector-store infra. Keep entries factual + in sync with the app.

export const KB = [
  { id: 'credits', title: 'How credits work',
    keywords: ['credit', 'credits', 'cost', 'charge', 'spend', 'topup', 'top-up', 'monthly', 'allowance', 'balance', 'run out', 'expire'],
    text: 'Most tools spend credits per run (the cost is shown on each tool, e.g. 1–50 credits; the assistant costs 2 per message). Your plan includes a monthly credit allowance that resets at the start of each billing cycle — unused monthly credits do NOT roll over. Top-up credits you buy separately DO roll over — they survive the monthly reset and stay valid for 12 months from purchase (see Terms section 8.3); spending draws from monthly credits first, then top-ups. Connecting your own Google data (Search Console, GA4, Ads) costs 0 credits. Failed runs are not charged. Buy top-ups any time on the Account page.' },
  { id: 'getting-started', title: 'Getting started',
    keywords: ['start', 'getting started', 'begin', 'new', 'setup', 'first', 'project', 'how to use'],
    text: 'Three steps: (1) create a Project to group a site\'s runs and data; (2) run a free tool like Keyword Analysis to see results; (3) connect your Google account to pull your own Search Console / GA4 / Ads data. Switch between Simple mode (goal-first, plain language) and Advanced mode (the full tool grid) using the toggle on the dashboard. Right-click any result — or click "Explain this" — to have the assistant explain it in plain English.' },
  { id: 'plans', title: 'Plans & upgrading',
    keywords: ['plan', 'plans', 'tier', 'upgrade', 'downgrade', 'pricing', 'free', 'starter', 'pro', 'expert', 'features', 'unlock'],
    text: 'Plans (Free, Starter, Pro, Expert) differ in monthly credits, number of projects, tracked-keyword limits, and which tools are unlocked. Higher tiers unlock more advanced tools (some are Pro-only). See the Pricing page for current prices and limits, and to change plan. Lower tiers still get one real preview run on locked tools.' },
  { id: 'billing', title: 'Billing, invoices & cancelling',
    keywords: ['billing', 'invoice', 'receipt', 'cancel', 'refund', 'card', 'payment', 'stripe', 'subscription', 'manage'],
    text: 'Billing is handled by Stripe. On the Account page, "Manage billing" opens the Stripe Customer Portal to update your card, download invoices, or cancel — cancelling takes effect at the end of the current billing period. Your subscription invoices and one-time top-up receipts are also listed on the Account page (with PDF download). If a payment fails, the account is flagged past-due with a banner until you update your card.' },
  { id: 'integrations', title: 'Connecting Google (Search Console, GA4, Ads)',
    keywords: ['google', 'connect', 'integration', 'gsc', 'search console', 'ga4', 'analytics', 'ads', 'oauth', 'property', 'account', 'reconnect'],
    text: 'On the Integrations page, one Google sign-in connects all three sources (Search Console, GA4, Google Ads) — it grants every needed scope at once. Then pick the specific property/account for each source (they can point at different ones). These integration tools cost 0 credits because it\'s your own data. If a source shows "Last pull failed" or stops returning data, click Reconnect. A source must have an account selected (shows "Active") to return data.' },
  { id: 'tracking', title: 'Keyword rank tracking',
    keywords: ['track', 'tracking', 'rank', 'ranking', 'keyword', 'position', 'backfill', 'history', 'serp', 'monitor'],
    text: 'Add keywords on the Tracking page (singly or paste a bulk list) and Digimetrics checks their Google position; a daily job updates each automatically so history builds over time. "Refresh positions" pulls an on-demand check (free). "Backfill history" pulls past dated rankings and costs extra credits (it confirms the cost first). Export rankings to CSV, and filter the charts by period. Your plan sets how many keywords you can track.' },
  { id: 'audit', title: 'Site Health Check (one-click audit)',
    keywords: ['audit', 'health', 'check', 'score', 'site', 'website', 'fix', 'health check', 'whats wrong'],
    text: 'The Site Health Check (the "Check my site\'s health" goal, or /audit) runs several checks at once — technical SEO, page quality, and AI-readiness — then gives you ONE overall score (0–100), an area-by-area breakdown, and a prioritised list of fixes in plain English. Each sub-check spends its own credits; it works on Starter and above.' },
  { id: 'geo', title: 'AI Visibility / GEO (getting cited by AI)',
    keywords: ['geo', 'ai visibility', 'chatgpt', 'gemini', 'perplexity', 'ai', 'cited', 'mentions', 'llms', 'generative'],
    text: 'GEO (Generative Engine Optimisation) is about getting your site cited in AI answers (ChatGPT, Gemini, Perplexity). The AI Visibility tools check whether AI tools mention/cite you (AI Discovery, AI Mentions), rewrite pages to be AI-citable (GEO On-Page), and generate an llms.txt file that tells AI crawlers how to read your site.' },
  { id: 'tools-pick', title: 'Which tool should I use?',
    keywords: ['which tool', 'recommend', 'tool', 'goal', 'help', 'best', 'use for', 'traffic', 'content', 'competitor'],
    text: 'Match your goal to a tool: keyword ideas + difficulty → Keyword Analysis; where you rank → Rank Checker; fix on-site issues → Technical SEO Crawler / On-Page; write or improve content → AI Content Optimiser; a full prioritised plan → SEO Strategy; show up in AI answers → the AI Visibility tools; understand competitors → Competitors Identifier / Backlinks Explorer. In Simple mode, the "What do you want to do?" goal cards group the right tools for you.' },
  { id: 'data-privacy', title: 'Your data, export & account deletion',
    keywords: ['data', 'export', 'delete', 'account', 'privacy', 'gdpr', 'remove', 'download my data', 'erase'],
    text: 'On the Account page under "Your data" you can export everything we hold about you as a JSON file, or permanently delete your account (which removes your data and cancels any active subscription). See the Privacy Notice and Terms and Conditions of Use (linked in the footer / sign-in). Tool inputs/outputs are stored as run history you can reopen.' },
  { id: 'sessions', title: 'Devices & signing out',
    keywords: ['device', 'devices', 'session', 'sessions', 'sign out', 'logout', 'login', 'sharing', 'security'],
    text: 'You can be signed in on up to 3 devices at once; signing in on a 4th signs out the oldest. Manage them under Account → "Active devices", where you can revoke any device or "Sign out everywhere" (which ends every session).' },
  { id: 'support', title: 'Getting help / support tickets',
    keywords: ['support', 'ticket', 'help', 'contact', 'issue', 'problem', 'bug', 'email'],
    text: 'Open a support ticket from the Support page (you can attach screenshots and add CC emails). Staff reply in-app and by email. A ticket auto-closes after a period of inactivity — just reply to reopen it. If the assistant can\'t resolve something, it can offer to open a ticket for you.' },
  { id: 'history', title: 'Run history',
    keywords: ['history', 'runs', 'past', 'results', 'rerun', 'previous', 'saved'],
    text: 'Every tool run is saved on the History page. Open one to revisit its result and the exact inputs (no extra credits for re-opening). You can group history by tool or by target domain, and filter by project.' },
  { id: 'projects', title: 'Projects / campaigns',
    keywords: ['project', 'projects', 'campaign', 'site', 'domain', 'group', 'workspace'],
    text: 'A Project groups a site\'s runs, tracked keywords and connected data under one place. Pick the active project from the top bar — runs are saved to it, and tool URL/domain fields auto-fill from its domain. Your plan sets how many projects you can have.' },
];

const CORE = ['credits', 'getting-started'];
const STOP = new Set(['the', 'and', 'for', 'how', 'what', 'can', 'does', 'did', 'your', 'you', 'with', 'that', 'this', 'are', 'was', 'from', 'use', 'using', 'get', 'got', 'about', 'our', 'have', 'has', 'will', 'when', 'why', 'which', 'who', 'where', 'into', 'out', 'should', 'would', 'could', 'they', 'them', 'their', 'there', 'here', 'just', 'not', 'but', 'all', 'any', 'some', 'more', 'most', 'than', 'then', 'now', 'one', 'two', 'too', 'its']);

const termsOf = (s) => [...new Set((String(s).toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w)))];

/** Top-k KB entries most relevant to the query (lexical term overlap), plus the
 *  always-included core entries — formatted for injection into the prompt. */
export function retrieveKb(query, k = 5) {
  const q = termsOf(query);
  const scored = KB.map((e) => {
    const title = e.title.toLowerCase();
    const kws = e.keywords.map((x) => x.toLowerCase());
    const hay = `${title} ${kws.join(' ')} ${e.text.toLowerCase()}`;
    let s = 0;
    for (const t of q) {
      if (title.includes(t)) s += 3;
      else if (kws.some((kw) => kw.includes(t))) s += 2;
      else if (hay.includes(t)) s += 1;
    }
    return { e, s };
  });
  const top = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k).map((x) => x.e);
  for (const id of CORE) if (!top.some((e) => e.id === id)) { const c = KB.find((e) => e.id === id); if (c) top.push(c); }
  return top.map((e) => `### ${e.title}\n${e.text}`).join('\n\n');
}
