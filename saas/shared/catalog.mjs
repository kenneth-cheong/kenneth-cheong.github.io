// ─────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for plans, credit costs, and the tool registry.
// Imported by BOTH the React frontend (via the `@shared` Vite alias) and the
// Lambda backend (via relative path). Never fork this — gating + pricing must
// agree on both sides, but the BACKEND is always the authority that enforces.
// ─────────────────────────────────────────────────────────────────────────

/** Billing currency — prices below and all Stripe Prices are created in SGD. */
export const CURRENCY = { code: 'SGD', symbol: 'S$' };

/**
 * Terms/Privacy version. Bump this whenever the legal text materially changes —
 * the first-run consent gate re-prompts any user whose accepted version differs,
 * so a bump forces everyone to re-accept. Keep in sync with Legal.jsx's date.
 */
export const TERMS_VERSION = '2026-07-25';

/**
 * Soft-launch Free Trial + NDA acceptance version. Independent of TERMS_VERSION:
 * bumping this re-prompts every trial user with the NDA gate. Keep in sync with
 * the NDA copy in TrialNdaGate.jsx.
 */
export const NDA_VERSION = '2026-06-29.2';

/** Tier ordering — index = rank. Used for `userTier >= requiredTier` checks. */
export const TIER_ORDER = ['free', 'starter', 'pro', 'expert'];

export function tierRank(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? 0 : i;
}

/** Does `userTier` meet-or-exceed `requiredTier`? */
export function tierMeets(userTier, requiredTier) {
  return tierRank(userTier) >= tierRank(requiredTier);
}

// ── Subscription plans ─────────────────────────────────────────────────────
// `stripePriceId` values are filled in from env at runtime on the backend; the
// frontend only needs display data. `monthlyCredits` is the allowance granted
// on each successful invoice (the billing-cycle anchor, not a cron).
export const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    monthlyCredits: 30,
    projects: 1,
    trackedKeywords: 0,
    // Scheduled tool runs: `maxSchedules` active schedules, cadences in `scheduleFreqs`.
    // Free can't schedule (the 30-credit budget can't sustain recurring runs) — an upsell.
    maxSchedules: 0,
    scheduleFreqs: [],
    blurb: 'Kick the tyres. Real tools, capped results.',
    highlights: ['30 credits / month (≈ 30 caption or keyword runs)', '1 project', 'Caption generator', 'Capped keyword + rank results'],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 39,
    monthlyCredits: 500,
    projects: 3,
    trackedKeywords: 25,
    maxSchedules: 3,
    scheduleFreqs: ['weekly', 'monthly'], // no daily — protects the monthly credit budget
    blurb: 'For solo marketers shipping content + SEO.',
    highlights: ['500 credits / month (≈ 100 AI articles or 500 keyword checks)', '3 projects', 'Full SEO Toolkit', 'Full AI Content Studio', '25 tracked keywords', '3 scheduled runs'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 109,
    monthlyCredits: 2000,
    projects: 10,
    trackedKeywords: 250,
    maxSchedules: 15,
    scheduleFreqs: ['daily', 'weekly', 'monthly'],
    popular: true,
    blurb: 'The serious operator plan. AI Visibility + ad integrations.',
    highlights: ['2,000 credits / month (≈ 400 AI articles or 40 deep site audits)', '10 projects', 'AI Visibility (GEO) suite', 'Google / Meta / GA4 integrations', '250 tracked keywords', '15 scheduled runs (daily)'],
  },
  expert: {
    id: 'expert',
    name: 'Expert',
    priceMonthly: 199,
    monthlyCredits: 6000,
    projects: 25,
    trackedKeywords: 1000,
    maxSchedules: 50,
    scheduleFreqs: ['daily', 'weekly', 'monthly'],
    blurb: 'Agencies-of-one and power users.',
    highlights: ['6,000 credits / month (≈ 1,200 AI articles or 120 deep site audits)', '25 projects', 'White-label PDF export', 'API access', '1,000 tracked keywords', '50 scheduled runs (daily)'],
  },
};

// ── One-time credit top-up packs (overage). ─────────────────────────────────
// Priced ABOVE every plan's marginal credit rate so subscriptions stay the
// better deal, but you can bail yourself out mid-cycle. Top-up credits ROLL
// OVER (they're not reset by the monthly billing cycle); monthly credits expire.
export const TOPUP_PACKS = [
  { id: 'topup_s', name: 'Small top-up', credits: 300, price: 15 },
  { id: 'topup_m', name: 'Medium top-up', credits: 1000, price: 45, popular: true },
  { id: 'topup_l', name: 'Large top-up', credits: 2500, price: 99 },
];

export function topupById(id) {
  return TOPUP_PACKS.find((p) => p.id === id) || null;
}

// ── Credit cost per metered "action". Tools reference one of these keys. ─────
// 1 credit ≈ $0.01–0.015 of underlying cost; targets ≥70% gross margin.
export const CREDIT_COSTS = {
  ai_short: 1, // caption, reply, schema, alt text, pillar
  ai_long: 5, // article write/optimise, strategy, persona set, media plan
  keyword_lookup: 1, // per batch (≤10 keywords) with volume + difficulty
  rank_check: 1, // per keyword × location
  rank_backfill: 3, // per keyword — historical dated SERP snapshots (DataForSEO Labs)
  page_speed: 1, // one page, mobile + desktop PageSpeed scores
  crawl: 2, // per 10 pages
  backlinks: 5, // per domain report
  page_analysis: 5, // landing page / SEM website analysis
  ai_visibility: 10, // multi-LLM fan-out (AI Discovery / AI Mentions)
  forensic_audit: 50,
  integration_pull: 0, // GSC / GA4 / Ads — user's own quota, drives stickiness
  ai_chat: 2, // one assistant message (Claude call + injected account context)
};

// Real credit cost of ONE run: the unit cost, multiplied by the fan-out item
// count for tools that charge per item (e.g. rank-checker → per keyword). The
// tool page, the schedule estimate, and the confirm dialog MUST all use this so
// the "Costs N credits" label and the spend-confirmation match what's charged.
// Clamped to the 1..50 window the metering backend enforces per run.
export function costPerRun(tool, inputs) {
  const unit = CREDIT_COSTS[tool?.cost] ?? 0;
  if (!unit || !tool?.fanout) return unit;
  const raw = inputs?.[tool.fanout];
  const arr = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return unit * Math.max(1, Math.min(50, arr.length));
}

// Honest per-tool runtime bands [low, high] in seconds, from measured backend
// durations (2026-07) with headroom for cold starts / bigger sites. The generic
// "30–150s" undersold ai-mentions (~184s) and oversold quick tools (~7–20s),
// so users abandoned legit long runs and distrusted fast ones. Any slow tool
// not listed falls back to the generic band.
const TOOL_ETA = {
  'content-check': [10, 45], onpage: [10, 45], 'perf-marketing': [30, 150],
  'page-speed': [10, 60],
  backlinks: [10, 45], 'ai-discovery': [15, 60], 'page-analysis': [15, 75],
  'landing-audit': [15, 75], 'anchor-cleaner': [15, 75], 'keyword-analysis': [20, 90],
  'llms-txt': [20, 90], 'time-to-rank': [20, 90], 'strategy-engine': [30, 120],
  'technical-seo': [30, 150], 'geo-onpage': [40, 150], persona: [45, 150],
  'seo-diagnostics': [60, 210],
  'content-writer': [30, 180], 'forensic-audit': [60, 210], 'media-plan': [60, 210],
  'social-audit': [45, 180], 'ai-mentions': [120, 300],
};
const GENERIC_ETA = [30, 150];

/** [low, high] seconds for a tool (or tool id), or null for non-slow tools. */
export function etaBand(tool) {
  const id = typeof tool === 'string' ? tool : tool?.id;
  if (TOOL_ETA[id]) return TOOL_ETA[id];
  const slow = typeof tool === 'object' ? tool?.slow : TOOLS.find((t) => t.id === id)?.slow;
  return slow ? GENERIC_ETA : null;
}

/** Human ETA range, e.g. "10s–45s" or "2–5 min" (no leading "~"). */
export function etaLabel(tool) {
  const b = etaBand(tool);
  if (!b) return null;
  const fmt = (s) => (s < 60 ? `${s}s` : `${String(Math.round(s / 30) / 2).replace(/\.0$/, '')} min`);
  const lo = fmt(b[0]); const hi = fmt(b[1]);
  // Collapse the unit when both ends are minutes: "2 min–5 min" → "2–5 min".
  return lo.endsWith('min') && hi.endsWith('min') ? `${lo.replace(' min', '')}–${hi}` : `${lo}–${hi}`;
}

/** Typical seconds (band midpoint) — drives the progress animation pacing. */
export function etaTypical(tool) {
  const b = etaBand(tool);
  return b ? Math.round((b[0] + b[1]) / 2) : 90;
}

// ── Tool registry ───────────────────────────────────────────────────────────
// `minTier`     — lowest plan that unlocks the tool fully.
// `cost`        — key into CREDIT_COSTS (what one run charges).
// `upstream`    — id of the existing Lambda the metering gateway proxies to
//                 (resolved to a URL in backend/src/metering/upstreams.mjs).
// `teaser`      — if set, lower tiers get ONE real-but-partial run per month.
//                 `freeRows`/`reveal` describe how much real data to return.
export const TOOLS = [
  // ── SEO Toolkit ───────────────────────────────────────────────────────────
  { id: 'keyword-analysis', name: 'Keyword Analysis', category: 'SEO', minTier: 'free',
    cost: 'keyword_lookup', upstream: 'mangoolsKeywords', slow: true,
    // slow: a domain-scoped run adds a time-to-rank estimate per keyword and can
    // take 30–60s — must route via the Function URL or it 503s on the 30s gateway.
    desc: 'Search volume & CPC for any keyword list — plus difficulty (ranking mode) and intent (from a webpage).',
    freeCap: 5 /* free tier: 5 real rows, rest blurred */ },
  { id: 'rank-checker', name: 'Rank Checker', category: 'SEO', minTier: 'free',
    cost: 'rank_check', upstream: 'rankChecker', fanout: 'input',
    desc: 'Live SERP positions by location, with position history.', freeCap: 5 },
  { id: 'time-to-rank', name: 'Time to Rank', category: 'SEO', minTier: 'starter',
    cost: 'ai_long', upstream: 'kwRecommendations', slow: true,
    desc: 'Forecast how long target keywords take to reach page one.' },
  { id: 'anchor-cleaner', name: 'Anchor Text Cleaner', category: 'SEO', minTier: 'starter',
    cost: 'crawl', upstream: 'getHtml', slow: true,
    desc: 'Audit a page’s outbound anchors + which pages link back to it.' },
  { id: 'technical-seo', name: 'Technical SEO Crawler', category: 'SEO', minTier: 'starter',
    cost: 'crawl', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Multi-page crawl: broken tags, metadata issues, performance.',
    teaser: { reveal: 'summary-only' } },
  { id: 'onpage', name: 'On-Page Optimisation', category: 'SEO', minTier: 'starter',
    cost: 'ai_long', upstream: 'onPageContentRecommendations', slow: true,
    desc: 'Benchmark title/meta/headings/images/content vs top-ranking pages.' },
  { id: 'page-analysis', name: 'Page Technical & Domain Analysis', category: 'SEO', minTier: 'starter',
    cost: 'page_analysis', upstream: 'forensicSiteData', slow: true,
    desc: 'Quick site health snapshot: domain authority, backlinks, organic traffic, page speed, SSL and on-page technical signals — all in one view.',
    teaser: { reveal: 'summary-only' } },
  // Deliberately tiny and cheap. It exists so a user who just wants FRESH SPEED
  // NUMBERS has somewhere to go: before this, the only way to update the
  // dashboard's Page speed card was to re-run the 50-credit GEO+SEO Forensic
  // Audit, which takes ~2 minutes and recomputes thirty unrelated probes. The
  // card's "Re-run" now calls this instead and patches itself in place.
  { id: 'page-speed', name: 'Page Speed Check', category: 'SEO', minTier: 'free',
    cost: 'page_speed', upstream: 'pageSpeed', slow: true,
    desc: 'Google PageSpeed scores for one page, mobile and desktop.' },
  { id: 'competitors', name: 'Competitors Identifier', category: 'SEO', minTier: 'starter',
    cost: 'keyword_lookup', upstream: 'serpCompetitors',
    desc: 'Find who shares your keywords and how you stack up.' },
  { id: 'backlinks', name: 'Backlinks Explorer', category: 'SEO', minTier: 'pro',
    cost: 'backlinks', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Link profile audit, dofollow/nofollow, competitor links.',
    teaser: { reveal: 'summary-only' } },
  { id: 'schema', name: 'Schema Generator', category: 'SEO', minTier: 'free',
    cost: 'ai_short', upstream: null, noSchedule: true, // interactive builder, no data to trend
    desc: 'Visual JSON-LD builder for rich snippets. No data fetch.' },

  // ── AI Content Studio ─────────────────────────────────────────────────────
  { id: 'caption', name: 'Caption Generator', category: 'Content', minTier: 'free',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Platform-tuned captions for IG / LinkedIn / FB / TikTok.' },
  { id: 'content-writer', name: 'AI Content Optimiser', category: 'Content', minTier: 'starter',
    cost: 'ai_long', upstream: 'aiOptimiser', slow: true,
    desc: 'Write from a topic (outline → sections → polish) or rewrite existing copy to close content gaps, then run up to 18 QA agents (you pick the depth) — with AI-Links, a suggested meta title/description and a readability score.' },
  { id: 'content-check', name: 'Content Checker', category: 'Content', minTier: 'starter',
    cost: 'ai_long', upstream: 'checkContent', slow: true,
    desc: 'Grammar, readability, keyword, compliance & brand-guide checks.' },
  { id: 'pillars', name: 'Content Pillar Framework', category: 'Content', minTier: 'starter',
    cost: 'ai_short', upstream: 'contentPillar',
    desc: 'Pillar + subtopic + angle map for social cohesion.' },

  // ── AI Visibility (GEO) — the differentiator ──────────────────────────────
  { id: 'ai-discovery', name: 'AI Discovery Audit', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_visibility', upstream: 'aiMentions', slow: true,
    desc: 'Are you cited in ChatGPT / Gemini / Perplexity answers?',
    teaser: { reveal: 'summary-only' } },
  { id: 'ai-mentions', name: 'AI Mentions Tracker', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_visibility', upstream: 'aiMentions', slow: true,
    desc: 'Track brand mention frequency across AI chatbots.',
    teaser: { reveal: 'summary-only' } },
  { id: 'llms-txt', name: 'llms.txt Generator', category: 'AI Visibility', minTier: 'starter',
    cost: 'ai_short', upstream: 'aiOptimiser', slow: true,
    desc: 'Crawl your site, check AI-readiness (existing llms.txt, robots/AI-bot access, key pages) and generate a spec-compliant llms.txt + llms-full.txt with recommendations.' },
  { id: 'geo-onpage', name: 'GEO On-Page Optimisation', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_long', upstream: 'geoOnPageAnalysis', slow: true,
    desc: 'Rewrite content to get picked up + cited by AI tools.' },
  { id: 'forensic-audit', name: 'GEO+SEO Forensic Audit', category: 'AI Visibility', minTier: 'pro',
    cost: 'forensic_audit', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Deep SEO + GEO audit: SSL, speed, backlinks, structured data, llms.txt, AI-bot access & more — with a health score and prioritised fix list.',
    teaser: { reveal: 'summary-only' } },

  // ── Ads & Strategy ────────────────────────────────────────────────────────
  { id: 'persona', name: 'Persona Generator', category: 'Strategy', minTier: 'starter',
    cost: 'ai_long', upstream: 'personaGenerator', slow: true,
    desc: 'Build 10 audience personas from a URL.' },
  { id: 'media-plan', name: 'Media Plan Generator', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'mediaPlanGenerator', slow: true,
    desc: 'Channel mix + budget allocation media plan, auto-personas & funnel.' },
  { id: 'landing-audit', name: 'Landing Page Audit', category: 'Strategy', minTier: 'starter',
    cost: 'page_analysis', upstream: 'auditLandingPageDirect', slow: true,
    desc: 'Conversion potential, clarity, speed, SEO readiness.' },
  { id: 'sem-copy', name: 'SEM Ad Copy Generator', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'generateSemGoogle',
    desc: 'USP extraction → ad copy for Google / Meta / LinkedIn.' },
  // Performance Marketing Audit — bespoke page (`route`): Starter opportunity
  // analysis + Pro account-level 9-area diagnosis, with website auto-fill, live
  // competitor ad intelligence and connected-account (Google Ads/GA4/Meta) pulls.
  { id: 'perf-marketing', name: 'Performance Marketing Audit', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'performanceMarketing', slow: true, route: '/performance-audit', noSchedule: true,
    desc: 'Channel mix, budget split & opportunities (Starter) or a full account diagnosis (Pro) for paid media.' },
  // Social Media Audit — bespoke page (`route`): live multi-platform scrape +
  // AI content-gap & competitor strategy in one combined two-phase run. The
  // strategy phase is the single charged step; scrape/discover are free helpers.
  { id: 'social-audit', name: 'Social Media Audit', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'socialMediaAudit', slow: true, route: '/social-audit', noSchedule: true, // bespoke two-phase async run
    desc: 'Live profile scrape + AI content-gap & competitor strategy across IG, TikTok, FB, LinkedIn & YouTube.' },

  // ── Strategy Engine (flagship: auto SEO action-plan generator) ────────────
  { id: 'strategy-engine', name: 'SEO Strategy', category: 'SEO', minTier: 'pro',
    cost: 'ai_long', upstream: 'strategyEngine', slow: true,
    desc: 'Auto-generates a keyword strategy with prioritised SEO action plans.' },
  // SEO Diagnostics — bespoke 5-step wizard (`route`): manual keyword entry →
  // opportunity buckets → GA4/GSC context → technical lanes (incl. live SERP) →
  // prioritised diagnosis + AI plan. Single charged run at the end.
  { id: 'seo-diagnostics', name: 'SEO Diagnostics', category: 'SEO', minTier: 'pro',
    cost: 'ai_long', upstream: 'forensicSiteData', slow: true, route: '/seo-diagnostics', noSchedule: true,
    desc: 'Guided keyword-to-fix audit: opportunity buckets, GA4/GSC context, technical checks & a prioritised diagnosis.' },

  // ── Integrations (your own Google data — 0 credits, drives stickiness) ─────
  // `integration` marks a tool that pulls the user's connected Google account
  // data instead of proxying an upstream Lambda (handled in the gateway).
  { id: 'gsc', name: 'Search Console', category: 'Integrations', minTier: 'pro',
    cost: 'integration_pull', upstream: null, integration: 'gsc',
    desc: 'Clicks, impressions, CTR and position from Google Search Console.' },
  { id: 'ga4', name: 'Google Analytics (GA4)', category: 'Integrations', minTier: 'pro',
    cost: 'integration_pull', upstream: null, integration: 'ga4',
    desc: 'Sessions, users, engagement and conversions from GA4.' },
  { id: 'google-ads', name: 'Google Ads', category: 'Integrations', minTier: 'pro',
    cost: 'integration_pull', upstream: null, integration: 'google-ads',
    desc: 'Campaign spend, clicks, conversions and CPA from Google Ads.' },
  { id: 'meta-ads', name: 'Meta Ads', category: 'Integrations', minTier: 'pro',
    cost: 'integration_pull', upstream: null, integration: 'meta-ads',
    desc: 'Campaign spend, clicks, conversions and CPA from Facebook & Instagram Ads.' },
  { id: 'linkedin-ads', name: 'LinkedIn Ads', category: 'Integrations', minTier: 'pro',
    cost: 'integration_pull', upstream: null, integration: 'linkedin-ads',
    desc: 'Campaign spend, clicks, conversions and CPA from LinkedIn Ads.' },
];

// ── Scheduled tool runs ──────────────────────────────────────────────────────
// Which tools can be put on a recurring schedule, and what each plan is allowed
// to schedule. A tool is schedulable unless it carries `noSchedule` (interactive
// builders + the bespoke two-phase Social Audit). Integrations (0-credit Google
// pulls) ARE schedulable — a weekly GSC snapshot is a natural comparison series.

/** Is this tool eligible for scheduling at all? */
export function isSchedulable(tool) {
  return !!tool && !tool.noSchedule;
}

/** The catalog tools a user may schedule (all schedulable tools they can run). */
export function schedulableTools() {
  return TOOLS.filter(isSchedulable);
}

/** Scheduling entitlement for a tier: how many active schedules + which cadences. */
export function scheduleLimits(tier) {
  const plan = PLANS[tier] || PLANS.free;
  return {
    maxSchedules: plan.maxSchedules ?? 0,
    freqs: plan.scheduleFreqs || [],
    enabled: (plan.maxSchedules ?? 0) > 0,
  };
}

export const CATEGORIES = ['SEO', 'Content', 'AI Visibility', 'Strategy', 'Integrations'];

/** Per-category accent colour for the dashboard + tool cards. The matching
 *  line-icon lives in the frontend (src/lib/icons.jsx → CategoryIcon). */
export const CATEGORY_META = {
  SEO: { color: '#2563eb' },
  Content: { color: '#7c3aed' },
  'AI Visibility': { color: '#0891b2' },
  Strategy: { color: '#ea580c' },
  Integrations: { color: '#16a34a' },
};

// ── Beginner mode ────────────────────────────────────────────────────────────
// Goal-first entry: beginners think in outcomes, not tool names. Each goal maps
// to a curated set of tools (first = the recommended starting tool), or routes
// straight to a page via `to`. `icon` is a lucide name resolved in the frontend.
export const GOALS = [
  { id: 'visitors', label: 'Get more visitors', icon: 'TrendingUp',
    desc: 'Find the searches to target and fix what holds you back on Google.',
    tools: ['keyword-analysis', 'rank-checker', 'technical-seo', 'onpage', 'strategy-engine'] },
  { id: 'health', label: 'Check my site’s health', icon: 'Stethoscope', to: '/audit',
    desc: 'A full audit with a score and a prioritised fix list.',
    tools: ['forensic-audit', 'page-analysis', 'technical-seo', 'landing-audit'] },
  { id: 'content', label: 'Create content', icon: 'PenLine',
    desc: 'Write posts, captions and plans that get found on Google.',
    tools: ['content-writer', 'caption', 'pillars', 'content-check'] },
  { id: 'rankings', label: 'Track my Google rankings', icon: 'LineChart', to: '/tracking',
    desc: 'Watch where you rank on Google, charted over time.',
    tools: ['rank-checker'] },
  { id: 'ai-visibility', label: 'Show up in AI answers', icon: 'Sparkles',
    desc: 'Get mentioned and linked by ChatGPT, Gemini & Perplexity.',
    tools: ['ai-discovery', 'geo-onpage', 'llms-txt'] },
  { id: 'competitors', label: 'Size up competitors', icon: 'Swords',
    desc: 'See who you’re up against and how you compare.',
    tools: ['competitors', 'backlinks'] },
  { id: 'my-data', label: 'See my Google data', icon: 'BarChart3', to: '/integrations',
    desc: 'Your Search Console, Analytics & Ads in one place.',
    tools: ['gsc', 'ga4', 'google-ads'] },
];

// The one-click "Site Health Check" runs these tools and synthesises a single
// scored report. Each item: tool id + how to build its input from the site URL.
export const AUDIT_TOOLS = [
  { id: 'technical-seo', label: 'Technical health', input: (url) => ({ input: url, maxPages: '10', maxDepth: '3' }) },
  { id: 'landing-audit', label: 'Page quality', input: (url) => ({ input: url }) },
  { id: 'llms-txt', label: 'AI readiness', input: (url) => ({ input: url }) },
];

// ── Explorer: the "cover the breadth" checklist ──────────────────────────────
// Distinct from the goal plan (which is the user's chosen north-star): this is a
// fixed guided tour that steers trial users across every discipline, so their
// feedback covers the whole platform — not just the one tool they happened to
// open. Completing the required `core` set pays a one-time credit reward; the
// optional `explore` set pays a second, larger one. Each task either maps to a
// real `toolId` (auto-ticks once that tool has been run) or routes to a page via
// `to` (project setup / connecting Google are detected from live account state).
// Kept here as the single source of truth so the frontend card and the backend
// reward-verification read identical definitions.
export const EXPLORER_REWARD = { core: 50, full: 100 }; // rollover credits, granted once each

export const EXPLORER_TASKS = [
  // core — the required breadth, one representative tool per discipline
  { id: 'exp-project', to: '/projects', group: 'core',
    label: 'Set up your first project', why: 'Everything — runs, tracking and reports — organises under a project.' },
  { id: 'keyword-analysis', toolId: 'keyword-analysis', group: 'core',
    label: 'Research your keywords', why: 'Find the searches worth targeting: volume, difficulty and intent.' },
  { id: 'content-writer', toolId: 'content-writer', group: 'core',
    label: 'Create a piece of content', why: 'Draft or optimise a page, then auto-run the quality checks.' },
  { id: 'competitors', toolId: 'competitors', group: 'core',
    label: 'Size up a competitor', why: 'See who shares your keywords and how you stack up.' },
  { id: 'ai-discovery', toolId: 'ai-discovery', group: 'core',
    label: 'Check your AI visibility', why: 'See if ChatGPT, Gemini & Perplexity cite you — our edge.' },
  // explore — the wider sweep, for a rounder view (and the bigger reward)
  { id: 'page-analysis', toolId: 'page-analysis', group: 'explore',
    label: 'Snapshot your site health', why: 'Authority, backlinks, speed & technical signals in one view.' },
  { id: 'pillars', toolId: 'pillars', group: 'explore',
    label: 'Plan your content', why: 'A pillar + subtopic map so your posts hang together.' },
  { id: 'social-audit', toolId: 'social-audit', group: 'explore',
    label: 'Audit your social', why: 'Live profile scrape + AI content-gap across platforms.' },
  { id: 'perf-marketing', toolId: 'perf-marketing', group: 'explore',
    label: 'Review paid performance', why: 'Channel mix, budget split & opportunities for paid media.' },
  { id: 'exp-google', to: '/integrations', group: 'explore',
    label: 'Connect your Google data', why: 'Bring Search Console, GA4 & Ads into one place.' },
];

/** Is a single explorer task complete, given live signals + a persisted done map? */
export function explorerTaskDone(task, { ranTools = [], hasProject = false, hasGoogle = false, done = {} } = {}) {
  if (done[task.id]) return true;                         // persisted / manual tick
  if (task.to === '/projects') return !!hasProject;
  if (task.to === '/integrations') return !!hasGoogle;
  if (task.toolId) return ranTools.includes(task.toolId); // ran the mapped tool
  return false;
}

/**
 * Compute breadth-checklist progress. Tier-aware: tasks whose tool the user's
 * plan can't run are split into `locked` (shown as aspirational, never required
 * for a reward) so the checklist is always completable at the current tier.
 * Pure + shared, so the dashboard card and the reward endpoint agree exactly.
 */
export function explorerProgress({ tier = 'free', ranTools = [], hasProject = false, hasGoogle = false, done = {} } = {}) {
  const available = [], locked = [];
  for (const t of EXPLORER_TASKS) {
    const runnable = !t.toolId || tierMeets(tier, toolById(t.toolId)?.minTier || 'free');
    (runnable ? available : locked).push(t);
  }
  const tasks = available.map((t) => ({ ...t, done: explorerTaskDone(t, { ranTools, hasProject, hasGoogle, done }) }));
  const core = tasks.filter((t) => t.group === 'core');
  const coreDone = core.filter((t) => t.done).length;
  const fullDone = tasks.filter((t) => t.done).length;
  const coreComplete = core.length > 0 && coreDone === core.length;
  const fullComplete = tasks.length > 0 && fullDone === tasks.length;
  return {
    tasks, locked,
    core: { done: coreDone, total: core.length },
    full: { done: fullDone, total: tasks.length },
    coreComplete,
    // "full" implies core; guard against a tier where every task is core.
    fullComplete: fullComplete && coreComplete,
  };
}

/** Plain-English name/description shown in Simple mode (overrides the pro label). */
export const SIMPLE_NAMES = {
  'technical-seo': { name: 'Website health check', desc: 'Scan your site for broken links, missing tags and speed issues.' },
  onpage: { name: 'Improve a page', desc: 'See how to make a page outrank the competition.' },
  'anchor-cleaner': { name: 'Fix your link wording', desc: 'Check the words you use for links on a page.' },
  'geo-onpage': { name: 'Get found by AI', desc: 'Rewrite a page so ChatGPT & friends cite it.' },
  'forensic-audit': { name: 'Full site audit', desc: 'Deep check of your SEO + AI readiness, with a score and fixes.' },
  'llms-txt': { name: 'AI access file', desc: 'Create the file that tells AI tools how to read your site.' },
  schema: { name: 'Rich result builder', desc: 'Make your Google listing show extra info (stars, prices…).' },
  'strategy-engine': { name: 'SEO game plan', desc: 'Get a prioritised list of what to do to rank.' },
  'page-analysis': { name: 'Quick site check', desc: 'A fast snapshot of a site’s authority, links, speed and technical health.' },
  'page-speed': { name: 'How fast is my page?', desc: 'Google’s speed score for one page, on phones and on desktop.' },
  'content-writer': { name: 'Write content', desc: 'Write or improve a page, then auto-check the quality.' },
  pillars: { name: 'Content plan', desc: 'A map of topics and angles to post about.' },
  gsc: { name: 'My Google search stats', desc: 'Clicks, impressions and positions from Google.' },
  ga4: { name: 'My website visitors', desc: 'Visitors, sessions and conversions from Analytics.' },
  'google-ads': { name: 'My Google Ads', desc: 'Spend, clicks and cost-per-result from Ads.' },
  'meta-ads': { name: 'My Meta Ads', desc: 'Spend, clicks and cost-per-result from Facebook & Instagram.' },
  'linkedin-ads': { name: 'My LinkedIn Ads', desc: 'Spend, clicks and cost-per-result from LinkedIn Ads.' },
  'sem-copy': { name: 'Write my ads', desc: 'Generate Google / Meta / LinkedIn ad copy.' },
  persona: { name: 'Know my audience', desc: 'Build audience profiles from your website.' },
  'media-plan': { name: 'Plan my ad budget', desc: 'A channel + budget plan for your campaigns.' },
  competitors: { name: 'Find my competitors', desc: 'See who you share keywords with.' },
  'landing-audit': { name: 'Check a landing page', desc: 'Will this page convert visitors? Find out.' },
};

// ── Goal intake → agentic pathway ────────────────────────────────────────────
// Simple mode asks beginners what they want to achieve (multi-select GOALS + a
// little context + free text), then `buildPathway` composes ONE ordered plan of
// tools plus proactive "beyond the ask" suggestions. This engine is pure and
// tier-aware so it always produces a sensible plan offline; the free-text-driven
// AI layer (frontend lib/planner.js) only personalises what this returns.

/** The extra multiple-choice context question shown under the goal chips. */
export const INTAKE = {
  goalQuestion: 'Choose your goals',
  goalHint: 'Pick one or more — we’ll build you a step-by-step plan.',
  context: {
    key: 'have',
    question: 'What do you already have? (optional)',
    options: [
      { id: 'website', label: 'A website' },
      { id: 'content', label: 'Content / a blog' },
      { id: 'adbudget', label: 'An ad budget' },
      { id: 'nothing', label: 'Just getting started' },
    ],
  },
};

// Rough "when in the journey" weight per tool, so a merged goal set orders itself
// into a path that reads understand → fix → plan → create → measure. Unlisted
// tools fall to stage 3 (neutral middle).
const TOOL_STAGE = {
  // 1 · research / discovery
  'keyword-analysis': 1, competitors: 1, persona: 1, 'page-analysis': 1,
  'page-speed': 2,
  // 2 · audit / diagnose
  'technical-seo': 2, 'forensic-audit': 2, 'landing-audit': 2, 'content-check': 2,
  'ai-discovery': 2, 'ai-mentions': 2, backlinks: 2,
  // 3 · plan / strategy
  'strategy-engine': 3, pillars: 3, 'media-plan': 3, 'perf-marketing': 3,
  // 4 · create / optimise
  onpage: 4, 'content-writer': 4, caption: 4, 'geo-onpage': 4, 'llms-txt': 4,
  schema: 4, 'sem-copy': 4, 'anchor-cleaner': 4, 'social-audit': 4,
  // 5 · track / measure
  'rank-checker': 5, gsc: 5, ga4: 5, 'google-ads': 5, 'meta-ads': 5, 'linkedin-ads': 5,
};
const stageOf = (id) => TOOL_STAGE[id] ?? 3;

// One plain-English reason per tool for why it's in the plan (falls back to the
// Simple-mode description). Keep each to a single motivating sentence.
const PATHWAY_REASONS = {
  'keyword-analysis': 'Find the terms your customers actually search — the foundation of everything else.',
  'rank-checker': 'See where you rank right now so you can measure progress.',
  'technical-seo': 'Fix the broken tags, links and speed issues holding your rankings back.',
  onpage: 'See exactly what to change to make a page outrank the competition.',
  'strategy-engine': 'Turn the findings into a prioritised, do-this-next action plan.',
  'forensic-audit': 'A deep SEO + AI-readiness audit with a health score and a fix list.',
  'page-analysis': 'A fast snapshot of a site’s authority, links, speed and technical health.',
  'landing-audit': 'Check whether a page actually converts the visitors it gets.',
  'content-writer': 'Write or improve a page, then auto-check the quality.',
  caption: 'Generate platform-ready captions in seconds.',
  pillars: 'Map the topics and angles worth posting about.',
  'content-check': 'Grade grammar, readability and keyword use before you publish.',
  'ai-discovery': 'See whether ChatGPT, Gemini & Perplexity cite you.',
  'geo-onpage': 'Rewrite a page so AI tools pick it up and cite it.',
  'llms-txt': 'Create the file that tells AI tools how to read your site.',
  competitors: 'Find who shares your keywords and how you stack up.',
  backlinks: 'Audit your link profile and spot competitor links to chase.',
  'media-plan': 'A channel + budget plan for your ad spend.',
  'sem-copy': 'Generate Google / Meta / LinkedIn ad copy that converts.',
  gsc: 'Your clicks, impressions and positions, straight from Google.',
  ga4: 'Your visitors, sessions and conversions.',
  'google-ads': 'Your ad spend, clicks and cost-per-result.',
};
const reasonFor = (id) => PATHWAY_REASONS[id] || SIMPLE_NAMES[id]?.desc || toolById(id)?.desc || '';

/**
 * Compose a single recommended pathway from the intake answers. Pure + tier-aware.
 *
 * @param {object}   a
 * @param {string[]} a.goalIds   selected GOAL ids (multi-select)
 * @param {string[]} [a.have]    selected INTAKE.context option ids
 * @param {string}   [a.tier]    user tier (gates which tools are runnable now)
 * @param {boolean}  [a.hasGoogle] is any Google integration connected?
 * @param {string[]} [a.ranTools] tool ids the user has already run (skip nudging these)
 * @returns {{ steps:{toolId,why,quickWin?}[], locked:{toolId,why}[],
 *            extras:{toolId?,action?,label?,why,locked?}[], quickWin:string|null }}
 */
export function buildPathway({ goalIds = [], have = [], tier = 'free', hasGoogle = false, ranTools = [] } = {}) {
  const chosen = (goalIds.length ? goalIds : ['visitors']);
  const goalSet = new Set(chosen);

  // 1 · union each chosen goal's tools, first-seen order preserved
  const ordered = [];
  const seen = new Set();
  for (const gid of chosen) {
    const g = GOALS.find((x) => x.id === gid);
    for (const tid of (g?.tools || [])) if (!seen.has(tid)) { seen.add(tid); ordered.push(tid); }
  }
  // Sequencing rule: writing content without keyword research is a common beginner
  // mistake — inject keyword research up front when they want content but didn't
  // also ask to grow visitors.
  if (goalSet.has('content') && !goalSet.has('visitors') && !seen.has('keyword-analysis')) {
    seen.add('keyword-analysis'); ordered.unshift('keyword-analysis');
  }

  // 2 · order by journey stage (stable), then split runnable vs tier-locked
  const byStage = ordered
    .map((id, i) => ({ id, i }))
    .sort((x, y) => (stageOf(x.id) - stageOf(y.id)) || (x.i - y.i))
    .map((x) => x.id);

  const steps = [];
  const locked = [];
  for (const id of byStage) {
    const t = toolById(id);
    if (!t) continue;
    (tierMeets(tier, t.minTier) ? steps : locked).push({ toolId: id, why: reasonFor(id) });
  }

  // 3 · quick win = first runnable step that costs nothing, else the first step
  const isFree = (id) => (CREDIT_COSTS[toolById(id)?.cost] ?? 0) === 0;
  const quickWin = (steps.find((s) => isFree(s.toolId)) || steps[0])?.toolId || null;
  if (quickWin) { const s = steps.find((x) => x.toolId === quickWin); if (s) s.quickWin = true; }

  // 4 · proactive "beyond the ask" extras — gaps + adjacent wins we can see even
  //     though the user didn't ask. Deduped against the plan + what they've run.
  const inPlan = new Set([...steps, ...locked].map((s) => s.toolId));
  const extras = [];
  const pushTool = (id, why) => {
    if (inPlan.has(id) || ranTools.includes(id) || extras.some((e) => e.toolId === id)) return;
    const t = toolById(id); if (!t) return;
    extras.push({ toolId: id, why, locked: !tierMeets(tier, t.minTier) });
  };

  if (!hasGoogle) {
    extras.push({ action: 'connect-google', label: 'Connect Google', locked: false,
      why: 'Link Search Console & Analytics (free) so you can measure the impact of everything above.' });
  }
  if (!goalSet.has('rankings')) pushTool('rank-checker', 'Track a keyword’s position over time so you can prove the plan worked.');
  if (!goalSet.has('competitors')) pushTool('competitors', 'Size up who you’re really up against before you invest effort.');
  if (!goalSet.has('ai-visibility')) pushTool('ai-discovery', 'Most competitors ignore this — check whether AI chatbots already cite you.');
  if (have.includes('adbudget')) pushTool('sem-copy', 'You mentioned an ad budget — generate ad copy to put it to work.');

  return { steps, locked, extras: extras.slice(0, 4), quickWin };
}

/** Jargon → plain definition, for the "i" info-icon tooltips shown next to
 *  every metric (stat cards, table headers, KPI tiles, trend charts). Matched
 *  case-insensitively against the metric label, so "Domain authority" and
 *  "Domain Authority" both resolve. Keep each definition to one plain-English
 *  sentence a non-marketer would understand — no jargon inside the definition. */
export const GLOSSARY = {
  // ── Search & Google Search Console ─────────────────────────────────────────
  CTR: 'Click-through rate — the % of people who clicked after seeing you in search.',
  'Click-through rate': 'The % of people who clicked after seeing you in search.',
  Impressions: 'How many times your site showed up in search results.',
  Clicks: 'How many people clicked through to your site.',
  Position: 'Your average ranking spot in Google (1 = top).',
  'Avg Position': 'Your average ranking spot in Google (1 = top).',
  'Avg position': 'Your average ranking spot in Google (1 = top).',
  'Branded clicks': 'Clicks from people searching for your brand name specifically.',
  'Branded impressions': 'Times you appeared for searches that include your brand name.',
  'Branded share': 'The share of your search traffic that comes from brand-name searches.',
  SERP: 'Search engine results page — what Google shows for a search.',

  // ── Keywords ───────────────────────────────────────────────────────────────
  Keyword: 'A search term people type into Google.',
  Keywords: 'The search terms people type into Google.',
  Difficulty: 'How hard it is to rank for this keyword (higher = harder).',
  'Keyword difficulty': 'How hard it is to rank on page one for this term (higher = harder).',
  Volume: 'How many people search this term each month.',
  'Search volume': 'How many people search this term each month.',
  CPC: 'Cost per click — what you would pay for one click if you advertised on this keyword.',
  Rank: 'Your position in Google for this keyword (1 = top).',
  Ranking: 'Your position in Google for this keyword (1 = top).',
  Traffic: 'Estimated monthly visits this keyword brings to the page.',
  'Est. traffic': 'Estimated monthly visits this keyword brings to the page.',
  Intent: 'Why someone searches this — to buy, to research, or to find a specific site.',

  // ── Analytics (GA4) ────────────────────────────────────────────────────────
  Sessions: 'Visits to your site (one person can visit several times).',
  Users: 'The number of distinct people who visited.',
  'New users': 'People visiting your site for the first time.',
  Conversions: 'Desired actions completed (sign-ups, sales, enquiries…).',
  'Conversion rate': 'The % of visits that ended in a desired action.',
  Engaged: 'Sessions where the visitor stayed actively engaged (GA4).',
  'Engaged sessions': 'Visits where the person stayed active — scrolled, clicked or lasted 10s+.',
  'Engagement rate': 'The % of visits that were engaged rather than instant bounces.',
  'Bounce rate': 'The % of visitors who left without doing anything.',
  Pageviews: 'How many pages were viewed in total.',

  // ── Paid ads ───────────────────────────────────────────────────────────────
  CPA: 'Cost per acquisition — what you pay, on average, for each conversion.',
  Cost: 'Total ad spend over the selected period.',
  Spend: 'Total money spent on ads over the selected period.',
  CPM: 'Cost per 1,000 times your ad is shown.',
  ROAS: 'Return on ad spend — revenue earned for every $1 spent on ads.',
  Campaign: 'A group of ads that share a budget and a goal.',
  Budget: 'The amount set aside to spend on this campaign.',

  // ── Backlinks & authority ──────────────────────────────────────────────────
  Backlinks: 'Links from other websites pointing to yours.',
  'Broken backlinks': 'Incoming links that now point to a missing or dead page.',
  'Referring domains': 'The number of different websites that link to you (quality signal).',
  'Referring IPs': 'The number of distinct servers your backlinks come from.',
  // Our own authority metric. Deliberately NOT named after any SEO suite's
  // proprietary equivalent — those names are trademarked and their terms forbid
  // repackaging the underlying number.
  'Authority Score': 'Our 0–100 estimate of how strongly a whole site can rank, based on the size and quality of its backlink profile.',
  'Domain rank': 'A score estimating how strong and trusted your domain is overall.',
  'Spam score': 'How risky or low-quality a site’s link profile looks (higher = worse).',
  'Anchor text': 'The clickable words used in a link pointing to your site.',
  Nofollow: 'A link that tells search engines not to pass ranking credit.',
  Dofollow: 'A normal link that passes ranking credit to your site.',

  // ── Technical SEO & site audit ─────────────────────────────────────────────
  'Health score': 'An overall 0–100 grade for your site’s technical health.',
  Health: 'An overall grade for your site’s technical health.',
  'Checks passed': 'How many technical checks your site passed out of those run.',
  Issues: 'Problems found that may hurt your rankings or user experience.',
  'Total issues': 'The total number of problems found across the pages checked.',
  'Pages with issues': 'How many pages have at least one problem to fix.',
  Critical: 'Serious issues to fix first — they can directly block rankings.',
  Warning: 'Minor issues worth fixing but not urgent.',
  'Pages found': 'How many pages the crawler discovered on your site.',
  'Pages sampled': 'How many pages were actually checked in this scan.',
  'Crawled pages': 'Pages the tool visited and analysed.',
  Indexed: 'Whether Google has this page stored and eligible to show in search.',
  Indexing: 'Whether Google has stored your pages so they can appear in search.',
  'Word count': 'How many words of text are on the page.',
  Words: 'How many words of text are on the page.',
  'PageSpeed': 'A 0–100 score for how fast the page loads and responds.',
  'PageSpeed (mobile)': 'A 0–100 speed score for how the page loads on phones.',
  'PageSpeed (desktop)': 'A 0–100 speed score for how the page loads on computers.',
  'Performance Grade': 'A letter grade (A–F) for the page’s overall loading performance.',
  LCP: 'Largest Contentful Paint — how long until the main content appears (lower is better).',
  CLS: 'Cumulative Layout Shift — how much the page jumps around as it loads (lower is better).',
  INP: 'Interaction to Next Paint — how quickly the page reacts to a tap or click.',
  SSL: 'The padlock security certificate that makes a site load over HTTPS.',
  'robots.txt': 'A file telling search engines which pages they may crawl.',
  Sitemap: 'A file listing your pages to help search engines find them all.',
  'Structured data': 'Hidden code that helps Google understand your content (rich results).',
  'Schema Markup': 'Hidden code that helps Google understand your content (rich results).',
  'Semantic HTML': 'Using the right page tags so machines grasp your content’s structure.',
  'Internal links': 'Links from one page of your site to another page on your site.',
  'External links': 'Links from your page out to other websites.',
  'Avg on-page score': 'The average optimisation grade across the pages checked.',
  Readability: 'How easy the text is to read (higher = easier for more people).',
  'Reading level': 'The school grade someone needs to comfortably read the text.',

  // ── GEO / AI search ────────────────────────────────────────────────────────
  GEO: 'Generative Engine Optimisation — getting cited by AI chatbots like ChatGPT.',
  'AI mention rate': 'How often AI chatbots mention your brand when asked relevant questions.',
  'AI readiness': 'How well your content is set up to be understood and cited by AI.',
  'GEO readiness': 'How well your site is prepared to be cited in AI answers.',
  'AI crawlers': 'The bots (like GPTBot) that read your site to train and answer with AI.',
  'AI bots allowed': 'Whether you let AI bots read your site so they can cite you.',
  'Share of voice': 'Your slice of all brand mentions in a space, versus competitors.',
  'llms.txt': 'A file that tells AI models how to use and cite your site’s content.',
  'Citation-worthiness': 'How likely your content is to be quoted as a source by AI.',

  // ── Social ─────────────────────────────────────────────────────────────────
  Followers: 'The number of accounts that follow this profile.',
  Reach: 'How many unique people saw your content.',
  'Eng. rate': 'Engagement rate — likes, comments and shares as a % of who saw the post.',
  'Posts/wk': 'How many times this profile posts in a typical week.',
  'Avg likes': 'The average number of likes per post.',

  // ── General ────────────────────────────────────────────────────────────────
  URL: 'The web address of a specific page.',
  Domain: 'A website’s core address, like example.com.',
  Competitors: 'Other sites competing with you for the same searches.',
  GAQL: 'Google Ads Query Language — a code-like way to ask Google Ads for exactly the data you want.',
  'JSON-LD': 'A snippet of code on your page that tells Google exactly what the page is about.',
  USP: 'Unique selling point — the one thing that makes you the better choice.',
  Persona: 'A fictional profile of a typical customer, used to sharpen your marketing.',
  'Content pillar': 'A recurring theme your content keeps coming back to, so your brand stands for something.',
};

/** One-click sample inputs per tool ("Try an example").
 *  Anchored on a real, recognisable brand (Asana / asana.com) so the worked
 *  example feels genuine in demos. The guided tours fill these same inputs and
 *  render a matching real-shaped result on the page (see frontend lib/tours.js). */
export const EXAMPLES = {
  'keyword-analysis': { mode: 'Keyword metrics', input: 'project management software, task management software, kanban board', location: 'United States', language: 'English' },
  'rank-checker': { input: 'strategic planning, sunk cost fallacy, team building activities, smart goals, project plan template', target: 'asana.com', location: 'United States' },
  'time-to-rank': { domain: 'https://asana.com', input: 'work management, gantt chart maker, task management software, kanban board', location: 'United States', language: 'English' },
  'anchor-cleaner': { input: 'https://asana.com/features', keyword: 'project management' },
  'technical-seo': { input: 'https://asana.com', maxPages: '10', maxDepth: '4' },
  onpage: { input: 'https://asana.com/features', keywords: 'project management software, work management' },
  competitors: { input: 'project management software', location: 'United States', language: 'English' },
  'page-analysis': { input: 'https://asana.com' },
  backlinks: { input: 'asana.com', mode: 'domain' },
  schema: { type: 'Organization', name: 'Asana', url: 'https://asana.com', telephone: '+1 415 525 3888', address: '633 Folsom St, San Francisco, CA' },
  caption: { input: 'New Asana feature: AI-powered project summaries that catch your team up in seconds', brand: 'Asana', platform: 'Instagram', tone: 'Friendly', language: 'English' },
  'content-writer': { mode: 'Optimise existing content', input: 'Project management is useful. Asana has tools for teams. Contact us to learn more.', keyword: 'project management software', analysis: 'Verify & QA' },
  'content-check': { input: "Asana is the best way to organise you're team's work. We offer alot of templates and the guaranteed cheapest plans.", keyword: 'project management software' },
  pillars: { input: 'Asana — work management platform for teams', businessModel: 'B2B', objectives: 'Brand authority', audienceType: 'Businesses' },
  'ai-discovery': { input: 'Asana', url: 'https://asana.com', location: 'United States' },
  'ai-mentions': { input: 'Asana', url: 'https://asana.com', location: 'United States' },
  'llms-txt': { input: 'https://asana.com' },
  'geo-onpage': { input: 'https://asana.com/features', prompts: 'What is the best project management tool for small teams?', brand: 'Asana', market: 'United States' },
  'forensic-audit': { input: 'https://asana.com' },
  persona: { input: 'https://asana.com', manual: 'Target audience: team leads & operations managers aged 28–45\nGeography: United States, United Kingdom, Australia\nCustomer behaviour: evaluating tools to replace spreadsheets\nLifestyle / interests: productivity, remote work' },
  'media-plan': { input: 'Drive awareness and free-trial sign-ups for Asana, a B2B work management platform', budget: '$8,000', location: 'United States', objectives: 'Increase brand awareness and generate trial sign-ups', targetAudience: 'Operations & team leads at 50–500-person companies, US/UK/AU, evaluating work-management tools' },
  'landing-audit': { input: 'https://asana.com/features', keyword: 'project management software' },
  'sem-copy': { input: 'https://asana.com', format: 'Google Search', country: 'United States', language: 'English', keywords: ['project management software', 'team collaboration'], tone: 'Professional' },
  'perf-marketing': { input: 'https://asana.com', category: 'B2B SaaS — work management & project management platform', country: 'United States', audience: 'Team leads & operations managers at 50–2,000 person companies', budget: '$6,000', objectives: 'qualified trial sign-ups' },
  'strategy-engine': { domain: 'https://asana.com', input: 'Asana is a work management platform that helps teams orchestrate work, from daily tasks to cross-functional strategic initiatives', objective: 'Lead Generation', location: 'United States' },
};

export function exampleFor(toolId) {
  return EXAMPLES[toolId] || null;
}

/** Providers the user can connect (OAuth) to unlock the Integrations tools. */
// `family` groups sources connected by one OAuth consent (mirrors the backend
// registry in lib/integrations.mjs). The Integrations page renders one connect
// card per family. FAMILY_META supplies that card's label/icon/blurb.
export const INTEGRATIONS = [
  { id: 'gsc', name: 'Google Search Console', blurb: 'Search clicks, impressions, CTR & position.', family: 'google' },
  { id: 'ga4', name: 'Google Analytics (GA4)', blurb: 'Sessions, users, engagement & conversions.', family: 'google' },
  { id: 'google-ads', name: 'Google Ads', blurb: 'Campaign spend, clicks, conversions & CPA.', family: 'google' },
  { id: 'meta-ads', name: 'Meta Ads', blurb: 'Facebook & Instagram spend, clicks, conversions & CPA.', family: 'meta' },
  { id: 'linkedin-ads', name: 'LinkedIn Ads', blurb: 'LinkedIn spend, clicks, conversions & CPA.', family: 'linkedin' },
];

// One connection card per family on the Integrations page. `authVia` is the
// provider id whose /authorize starts the consent (any source in the family
// works — one consent connects them all).
export const FAMILY_META = {
  google: { label: 'Google account', icon: 'G', blurb: 'One sign-in connects Search Console, Analytics & Ads.', authVia: 'gsc' },
  meta: { label: 'Meta account', icon: 'M', blurb: 'Connect Meta to pull Facebook & Instagram ad performance.', authVia: 'meta-ads' },
  linkedin: { label: 'LinkedIn account', icon: 'in', blurb: 'Connect LinkedIn to pull your Ads campaign performance.', authVia: 'linkedin-ads' },
};

export function toolById(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

// ── Per-tool input forms ────────────────────────────────────────────────────
// Each tool renders the fields below (by `name`); the frontend submits them as
// the request body, which the metering adapters read. The PRIMARY value should
// keep the name `input` (adapters + mock read body.input). `type`: text |
// textarea | url | select | number. `options` for selects.
// Full names — the upstream Lambdas (DataForSEO / Mangools / SERP) match these
// exactly, so the form must submit "Singapore", not a "SG" code.
// Locations + languages offered in the tool forms. Every value MUST be an exact
// DataForSEO location_name / language_name (the upstreams match these strings
// verbatim, so an unrecognised name fails the SERP/keyword call). ("Global" is an
// app-special handled per-tool.) Keep to standard English country names when
// adding markets, and smoke-test a new entry against a live run before relying on it.
// (Russia & Turkey were tested and are NOT served by the SERP backend — no name
// variant resolves — so they're intentionally absent here; they remain in COUNTRIES,
// which only feeds LLM tools.)
// Alphabetical so the dropdowns scan top-to-bottom; 'Global' is pinned first as
// it is an app-special "worldwide" option, not a country.
const LOCATIONS = [
  'Global',
  'Argentina', 'Australia', 'Austria', 'Bangladesh', 'Belgium', 'Brazil',
  'Bulgaria', 'Canada', 'Chile', 'China', 'Colombia', 'Croatia', 'Czechia',
  'Denmark', 'Egypt', 'Finland', 'France', 'Germany', 'Greece', 'Hong Kong',
  'Hungary', 'India', 'Indonesia', 'Ireland', 'Israel', 'Italy', 'Japan',
  'Kazakhstan', 'Kenya', 'Malaysia', 'Mexico', 'Morocco', 'Netherlands',
  'New Zealand', 'Nigeria', 'Norway', 'Pakistan', 'Peru', 'Philippines',
  'Poland', 'Portugal', 'Qatar', 'Romania', 'Saudi Arabia', 'Singapore',
  'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka',
  'Sweden', 'Switzerland', 'Taiwan', 'Thailand', 'Ukraine',
  'United Arab Emirates', 'United Kingdom', 'United States', 'Vietnam',
];
const LANGUAGES = [
  'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Dutch', 'English',
  'Filipino', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Japanese',
  'Korean', 'Malay', 'Portuguese', 'Russian', 'Spanish', 'Tamil', 'Thai',
  'Vietnamese',
];
// Broader language set for the LLM-fed tools (Caption, SEM Ad Copy, SEO Strategy).
// These don't hit DataForSEO, so the value is free — no location_name constraint —
// and the model writes in whatever is picked. 'English' pinned first (the default);
// rest alphabetical. Rendered searchable (the form auto-upgrades selects >12 long).
const LLM_LANGUAGES = [
  'English',
  'Arabic', 'Bengali', 'Bulgarian', 'Burmese', 'Chinese (Simplified)',
  'Chinese (Traditional)', 'Czech', 'Danish', 'Dutch', 'Filipino', 'Finnish',
  'French', 'German', 'Greek', 'Hebrew', 'Hindi', 'Hungarian', 'Indonesian',
  'Italian', 'Japanese', 'Khmer', 'Korean', 'Malay', 'Norwegian', 'Persian',
  'Polish', 'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Spanish', 'Swedish',
  'Tagalog', 'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese',
];
// Exhaustive country list for LLM-context fields (media plan, SEM ad copy). Unlike
// LOCATIONS — which is capped to the markets the SERP/keyword APIs actually support —
// these values only flow into a prompt, so any country is safe. Rendered as a
// searchable typeahead (the form auto-upgrades any select with >12 options).
const COUNTRIES = [
  'Global',
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda',
  'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain',
  'Bangladesh', 'Barbados', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan',
  'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
  'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde',
  'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
  'Congo (Brazzaville)', 'Congo (Kinshasa)', 'Costa Rica', 'Croatia', 'Cuba',
  'Cyprus', 'Czechia', 'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic',
  'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia',
  'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
  'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau',
  'Guyana', 'Haiti', 'Honduras', 'Hong Kong', 'Hungary', 'Iceland', 'India',
  'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast',
  'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo',
  'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia',
  'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau', 'Madagascar',
  'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands',
  'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia',
  'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal',
  'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria', 'North Korea',
  'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama',
  'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe',
  'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore',
  'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa',
  'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden',
  'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand',
  'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
  'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu',
  'Vatican City', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
];

// Country picker for GSC filters — GSC wants a lowercase ISO-3166 alpha-3 code,
// which no layman should have to know. Labels are searched; codes are stored.
// '' = no filter (all countries), which the backend treats as "skip the filter".
const GSC_COUNTRY_OPTIONS = [
  { value: '', label: 'All countries' },
  { value: 'sgp', label: 'Singapore' }, { value: 'mys', label: 'Malaysia' }, { value: 'idn', label: 'Indonesia' },
  { value: 'tha', label: 'Thailand' }, { value: 'vnm', label: 'Vietnam' }, { value: 'phl', label: 'Philippines' },
  { value: 'hkg', label: 'Hong Kong' }, { value: 'twn', label: 'Taiwan' }, { value: 'jpn', label: 'Japan' },
  { value: 'kor', label: 'South Korea' }, { value: 'chn', label: 'China' }, { value: 'ind', label: 'India' },
  { value: 'aus', label: 'Australia' }, { value: 'nzl', label: 'New Zealand' },
  { value: 'usa', label: 'United States' }, { value: 'can', label: 'Canada' },
  { value: 'gbr', label: 'United Kingdom' }, { value: 'irl', label: 'Ireland' },
  { value: 'deu', label: 'Germany' }, { value: 'fra', label: 'France' }, { value: 'esp', label: 'Spain' },
  { value: 'ita', label: 'Italy' }, { value: 'nld', label: 'Netherlands' }, { value: 'che', label: 'Switzerland' },
  { value: 'are', label: 'United Arab Emirates' }, { value: 'sau', label: 'Saudi Arabia' },
  { value: 'bra', label: 'Brazil' }, { value: 'mex', label: 'Mexico' }, { value: 'zaf', label: 'South Africa' },
];

export const INPUTS = {
  'keyword-analysis': [
    { name: 'mode', label: 'What do you want to do?', type: 'segmented',
      options: ['Keyword metrics', 'Similar keywords (from seed)', 'Ranking keywords (for a domain)', 'Keywords from a webpage'],
      optionDesc: {
        'Keyword metrics': 'Search volume, difficulty & intent for a keyword list.',
        'Similar keywords (from seed)': 'Expand seed keywords into related keyword ideas.',
        'Ranking keywords (for a domain)': 'See what keywords a domain already ranks for.',
        'Keywords from a webpage': 'Extract target keywords from a page’s content.',
      },
      default: 'Keyword metrics' },
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add a keyword and press Enter', required: true,
      showWhen: { field: 'mode', in: ['Keyword metrics', 'Similar keywords (from seed)'] } },
    { name: 'target', label: 'Domain or page URL', type: 'url', placeholder: 'https://example.com', required: true,
      showWhen: { field: 'mode', in: ['Ranking keywords (for a domain)', 'Keywords from a webpage'] } },
    { name: 'domain', label: 'Your website (optional)', type: 'url', placeholder: 'https://yoursite.com',
      help: 'Adds a “time to rank” estimate — roughly how long it could take your site to reach Google page 1 for each keyword.',
      showWhen: { field: 'mode', in: ['Keyword metrics', 'Similar keywords (from seed)'] } },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
  ],
  'rank-checker': [
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add keywords to check', required: true },
    { name: 'target', label: 'Your domain', type: 'text', placeholder: 'example.com', required: true },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
  ],
  'technical-seo': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'maxPages', label: 'Max pages to check', type: 'number', default: '10',
      help: 'How many pages of your site to check. More pages = a fuller picture and a slightly higher credit cost (2 credits per 10 pages).' },
    { name: 'maxDepth', label: 'Max crawl depth', type: 'number', default: '4',
      help: 'How many clicks away from your homepage to look. 4 is right for most sites.' },
  ],
  'time-to-rank': [
    { name: 'domain', label: 'Your domain', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'input', label: 'Target keywords', type: 'tags', placeholder: 'add a keyword and press Enter', required: true },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
  ],
  'anchor-cleaner': [
    { name: 'input', label: 'Target URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. project management', required: true },
  ],
  onpage: [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    { name: 'keywords', label: 'Target keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
  ],
  competitors: [
    { name: 'input', label: 'Keywords or domains', type: 'tags', placeholder: 'add a keyword or domain', required: true },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
  ],
  'page-analysis': [
    { name: 'input', label: 'Website or page URL', type: 'url', placeholder: 'https://example.com', required: true },
  ],
  'page-speed': [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com', required: true },
  ],
  backlinks: [
    { name: 'input', label: 'Domain', type: 'text', placeholder: 'example.com', required: true },
    { name: 'mode', label: 'What to analyse', type: 'select', options: ['domain', 'host', 'url'], default: 'domain',
      help: 'Domain = the whole site including subdomains. Host = one subdomain only. URL = just this single page.' },
  ],
  // Visual JSON-LD builder — fields surface by the chosen schema type (showWhen).
  schema: [
    { name: 'type', label: 'Schema type', type: 'select', default: 'LocalBusiness',
      options: ['LocalBusiness', 'Organization', 'Product', 'Service', 'Article', 'FAQPage', 'Person', 'WebSite', 'BreadcrumbList', 'Event', 'Recipe', 'Review', 'Course', 'JobPosting', 'SoftwareApplication', 'VideoObject'] },
    { name: 'name', label: 'Name', type: 'text', placeholder: 'Acme Corp', required: true },
    { name: 'url', label: 'URL', type: 'url', placeholder: 'https://example.com' },
    { name: 'description', label: 'Description', type: 'textarea', placeholder: 'Short description' },
    { name: 'image', label: 'Image URL', type: 'url', placeholder: 'https://example.com/photo.jpg' },
    { name: 'logo', label: 'Logo URL', type: 'url', placeholder: 'https://example.com/logo.png', showWhen: { field: 'type', in: ['Organization'] } },
    { name: 'telephone', label: 'Telephone', type: 'text', placeholder: '+1 555 555 5555', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Service'] } },
    { name: 'address', label: 'Address', type: 'text', placeholder: '123 Main St, New York', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Event'] } },
    { name: 'priceRange', label: 'Price range', type: 'text', placeholder: '$$', showWhen: { field: 'type', in: ['LocalBusiness'] } },
    { name: 'openingHours', label: 'Opening hours', type: 'text', placeholder: 'Mo-Fr 09:00-18:00', showWhen: { field: 'type', in: ['LocalBusiness'] } },
    { name: 'sameAs', label: 'Social profiles (one URL per line)', type: 'textarea', placeholder: 'https://facebook.com/acme\nhttps://linkedin.com/company/acme', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Person'] } },
    { name: 'brand', label: 'Brand', type: 'text', placeholder: 'Acme', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'sku', label: 'SKU', type: 'text', placeholder: 'SW3000-B', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'offers_price', label: 'Price', type: 'number', placeholder: '49.99', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'offers_priceCurrency', label: 'Currency', type: 'text', default: 'USD', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'offers_availability', label: 'Availability', type: 'select', options: ['InStock', 'OutOfStock', 'PreOrder', 'Discontinued'], default: 'InStock', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'rating_value', label: 'Rating value', type: 'number', placeholder: '4.5', showWhen: { field: 'type', in: ['Product', 'Review'] } },
    { name: 'rating_count', label: 'Review count', type: 'number', placeholder: '128', showWhen: { field: 'type', in: ['Product', 'Review'] } },
    { name: 'author', label: 'Author', type: 'text', placeholder: 'Jane Smith', showWhen: { field: 'type', in: ['Article', 'Recipe', 'Review'] } },
    { name: 'datePublished', label: 'Date published', type: 'text', placeholder: 'YYYY-MM-DD', showWhen: { field: 'type', in: ['Article'] } },
    { name: 'jobTitle', label: 'Job title', type: 'text', placeholder: 'Architect', showWhen: { field: 'type', in: ['Person'] } },
    { name: 'faq', label: 'FAQs — "Question | Answer" per line', type: 'textarea', placeholder: 'Do you ship overseas? | Yes, worldwide.\nWhat is the return policy? | 30 days.', showWhen: { field: 'type', in: ['FAQPage'] } },
    { name: 'breadcrumb', label: 'Breadcrumb — "Name | URL" per line', type: 'textarea', placeholder: 'Home | https://example.com\nShop | https://example.com/shop', showWhen: { field: 'type', in: ['BreadcrumbList'] } },
  ],

  // Mirrors the agency's luxury_copy form (text/select fields; file uploads omitted).
  caption: [
    { name: 'input', label: 'Core content / topic', type: 'textarea', placeholder: 'What the post is about…', required: true },
    { name: 'brand', label: 'Brand name', type: 'text', placeholder: 'Acme Co' },
    { name: 'platform', label: 'Content type', type: 'select', options: ['Instagram', 'Facebook', 'LinkedIn', 'TikTok'], default: 'Instagram' },
    { name: 'count', label: 'Variations', type: 'select', options: ['1', '2', '3', '5'], default: '3' },
    { name: 'coreMessage', label: 'Core message', type: 'text', placeholder: 'The one thing this post must land' },
    { name: 'postRole', label: 'Post role / objective', type: 'select', options: ['Build awareness', 'Build trust/credibility', 'Educate/explain', 'Drive consideration', 'Prompt action'], default: 'Build awareness' },
    { name: 'strategyFit', label: 'Strategy context', type: 'select', options: ['Brand positioning', 'Proof/credibility', 'Community engagement', 'Campaign support', 'Conversion support'], default: 'Brand positioning' },
    { name: 'subgroups', label: 'Target audiences', type: 'tags', placeholder: 'add an audience and press Enter' },
    { name: 'painpoints', label: 'Audience pain points', type: 'tags', placeholder: 'add a pain point and press Enter' },
    { name: 'audienceGoal', label: 'Audience goals', type: 'tags', placeholder: 'add a goal and press Enter' },
    { name: 'productService', label: 'Product / service', type: 'text', placeholder: 'What you are promoting' },
    { name: 'desiredAction', label: 'Call-to-action', type: 'text', placeholder: 'e.g. Sign up, Shop now' },
    { name: 'usp', label: 'Unique selling point', type: 'text', placeholder: 'What sets you apart' },
    { name: 'tone', label: 'Tone of voice', type: 'select', options: ['Friendly', 'Professional', 'Playful', 'Luxury', 'Bold'], default: 'Friendly' },
    { name: 'pov', label: 'Brand point of view', type: 'text', placeholder: 'e.g. first person plural (we)' },
    { name: 'language', label: 'Language', type: 'select', options: LLM_LANGUAGES, default: 'English' },
    { name: 'wordCount', label: 'Word count', type: 'text', placeholder: 'e.g. 60' },
    { name: 'emojis', label: 'Include emojis', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { name: 'hashtags', label: 'Include hashtags', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { name: 'constraints', label: 'Constraints / mandatories', type: 'text', placeholder: "e.g. don't use the word 'cheap'" },
    { name: 'sampleText', label: 'Style sample', type: 'textarea', placeholder: 'Paste a past caption to match its voice (optional)' },
    { name: 'specificInstructions', label: 'Specific instructions', type: 'textarea', placeholder: 'Any other direction for the copy' },
  ],
  // Full AI Content Optimiser — write/optimise + the 18-agent QA suite.
  'content-writer': [
    { name: 'mode', label: 'Mode', type: 'select', options: ['Optimise existing content', 'Write a new draft'], default: 'Optimise existing content',
      hint: 'Optimise runs a gap analysis and rewrites your copy to fill the gaps, then QAs the improved draft. Write turns a topic into a full article (outline → sections → polish).' },
    { name: 'models', label: 'Generate with', type: 'multiselect', options: ['Haiku', 'DeepSeek'], default: 'Haiku', staffOnly: true,
      hint: 'Staff only — pick one or both models. Choosing both runs the full research + generation pipeline through each and shows the drafts side by side so you can compare quality. (Two models = double the AI cost.)' },
    { name: 'url', label: 'Page URL — we’ll fetch the content for you', type: 'url', placeholder: 'https://example.com/page-to-improve',
      showWhen: { field: 'mode', in: ['Optimise existing content'] },
      help: 'Paste the page address and we pull its text automatically — no copy-pasting. Or paste the content below instead.' },
    { name: 'input', label: 'Content (or topic if writing new)', type: 'textarea',
      placeholder: 'Paste content to optimise (or leave blank if you gave a URL above), or a topic to write about…',
      hint: 'Give a URL above, paste the content here, or upload a draft below.' },
    // Not every draft is published yet — upload fills the `input` field above so
    // the backend contract is unchanged (it only ever sees text).
    { name: 'inputFile', label: '…or upload a draft', type: 'file', fills: 'input',
      accept: '.docx,.pdf,.txt,.md',
      showWhen: { field: 'mode', in: ['Optimise existing content'] },
      help: 'Not published yet? Upload the Word doc, PDF or text file and we read the text straight into the Content box. The file stays in your browser.' },
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. project management software' },
    { name: 'secondary', label: 'Secondary keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'location', label: 'Target market', type: 'select', options: LOCATIONS, default: 'Singapore',
      help: 'The country you’re writing for — spelling, examples and the legal/compliance check follow it.' },
    { name: 'language', label: 'Language', type: 'select', options: LANGUAGES, default: 'English' },
    { name: 'wordCount', label: 'Target word count (optional)', type: 'number', advanced: true,
      help: 'Leave blank to let the AI decide. Setting a target makes each section meet a hard minimum length.',
      showWhen: { field: 'mode', in: ['Write a new draft'] } },
    { name: 'webVerify', label: 'Verify facts against the live web', type: 'segmented', advanced: true,
      options: ['Off', 'On'],
      optionDesc: {
        Off: 'Fact checks run from the AI’s built-in knowledge.',
        On: 'The fact agents search real, current sources and cite URLs — a little slower.',
      },
      default: 'Off',
      help: 'When on, the Fact Checking and Fact Gatherer agents run live web searches (up to 4 each) so verdicts and statistics come from real sources instead of memory.' },
    // Values are matched by prefix in the backend (Full/Research/Structure,
    // anything else = verify) — keep those leading words if relabelling.
    { name: 'analysis', label: 'How thoroughly should we check the draft?', type: 'segmented',
      options: ['Verify & QA', 'Research deeper', 'Structure & polish', 'Full audit'],
      optionDesc: {
        'Verify & QA': 'Quick fact-check and quality pass — right for most runs.',
        'Research deeper': 'Adds topic research and source discovery.',
        'Structure & polish': 'Focuses on layout, headings and formatting.',
        'Full audit': 'Every check we have — the most thorough, and the slowest.',
      },
      default: 'Verify & QA' },
    { name: 'pageType', label: 'Page type', type: 'select', options: ['Any', 'Blog', 'Product', 'Service', 'Landing page', 'Category', 'Home'], default: 'Any' },
    { name: 'brandTone', label: 'Brand tone', type: 'select', options: ['Professional', 'Conversational', 'Authoritative', 'Friendly', 'Bold', 'Luxury'], default: 'Professional' },
    { name: 'audience', label: 'Audience', type: 'text', placeholder: 'e.g. startup founders, small business owners', default: 'Working professionals' },
    { name: 'readingLevel', label: 'Reading level', type: 'select', options: ['Grade 4-6 (Very easy)', 'Grade 6-8 (Easy)', 'Grade 9-12 (Standard)', 'University (Advanced)'], default: 'Grade 6-8 (Easy)' },
    { name: 'doNotUseWords', label: 'Words to avoid', type: 'text', placeholder: "e.g. cheap, budget" },
  ],
  // Full Content Checker — grammar/compliance with brand guides + references.
  'content-check': [
    { name: 'input', label: 'Content to check', type: 'textarea', placeholder: 'Paste the copy to check…', required: true },
    { name: 'keyword', label: 'Target SEO keyword', type: 'text', placeholder: 'e.g. project management software' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Any', 'Conversational', 'Formal', 'Authoritative', 'Friendly', 'Persuasive'], default: 'Any' },
    { name: 'languageVariant', label: 'English variant', type: 'select', options: ['British English', 'American English', 'Australian English', 'Canadian English'], default: 'British English' },
    { name: 'instructions', label: 'Extra instructions', type: 'textarea', placeholder: "e.g. don't use the word 'cheap'; keep sentences short" },
    { name: 'referenceUrls', label: 'Reference URLs', type: 'textarea', placeholder: 'one URL per line — parsed and used as source-of-truth' },
    { name: 'brandGuideUrls', label: 'Brand guide URLs (PDF)', type: 'textarea', placeholder: 'one PDF URL per line' },
    { name: 'compliance', label: 'Compliance requirements', type: 'textarea', placeholder: 'e.g. FTC advertising guidelines, no superlative claims' },
  ],
  // Mirrors the agency's contentPillar 'pillar_framework' inputs.
  pillars: [
    { name: 'input', label: 'Brand / niche / extra context', type: 'textarea', placeholder: 'sustainable skincare brand…', required: true },
    { name: 'businessModel', label: 'Business model', type: 'select', options: ['B2B', 'B2C', 'B2G', 'Hybrid'], default: 'B2C' },
    { name: 'objectives', label: 'Primary objective', type: 'select', options: ['Lead generation', 'Direct sales', 'Brand authority', 'Trust & credibility', 'Retention / repeat purchase', 'Recruitment / employer branding'], default: 'Brand authority' },
    { name: 'audienceType', label: 'Primary audience', type: 'select', options: ['Individual consumers', 'SME decision-makers', 'Enterprise / senior stakeholders', 'Mixed audiences'], default: 'Individual consumers' },
    { name: 'complexity', label: 'Decision complexity', type: 'select', options: ['Low (impulse / low consideration)', 'Medium (comparison-based)', 'High (trust-heavy / multi-touch)'], default: 'Medium (comparison-based)',
      help: 'How much thought a customer puts into buying from you — a snack is low, enterprise software is high.' },
    { name: 'platforms', label: 'Primary platform', type: 'select', options: ['LinkedIn', 'Instagram', 'TikTok', 'Facebook', 'YouTube / Shorts'], default: 'Instagram' },
    { name: 'sensitivity', label: 'Brand risk sensitivity', type: 'select', options: ['Low (playful, trend-led)', 'Medium (balanced)', 'High (regulated, reputation-heavy)'], default: 'Medium (balanced)',
      help: 'How careful your brand needs to be with tone — regulated or reputation-heavy industries are high.' },
    { name: 'promoTolerance', label: 'Promotional tolerance', type: 'select', options: ['Low (soft sell only)', 'Medium (occasional CTA)', 'High (offer-led, sales-focused)'], default: 'Medium (occasional CTA)',
      help: 'How salesy your content is allowed to be.' },
    { name: 'website', label: 'Website URLs', type: 'textarea', placeholder: 'one or more URLs' },
    { name: 'brandGuide', label: 'Brand guidelines URL', type: 'url', placeholder: 'https://example.com/brand' },
    { name: 'competitors', label: 'Key competitors', type: 'textarea', placeholder: 'competitor names or URLs' },
  ],

  'ai-discovery': [
    { name: 'input', label: 'Brand name', type: 'text', placeholder: 'Acme Co', required: true },
    { name: 'url', label: 'Website', type: 'url', placeholder: 'https://acme.co' },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
  ],
  'ai-mentions': [
    { name: 'input', label: 'Brand name', type: 'text', placeholder: 'Acme Co', required: true },
    { name: 'url', label: 'Website', type: 'url', placeholder: 'https://acme.co' },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
  ],
  // The three optional boxes each carry `suggest` — the form shows an "AI suggest"
  // button that crawls the site (free, one crawl shared by all three) and drafts
  // the text, so the user edits a real draft instead of facing a blank box.
  'llms-txt': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'summary', label: 'Summary / blockquote (optional)', type: 'textarea', placeholder: 'Leave blank to auto-write it from the site', suggest: true },
    { name: 'geoPrompts', label: 'Questions AI should answer with your site (optional, one per line)', type: 'textarea',
      placeholder: 'What makes Acme the best choice?\nHow does Acme help teams stay productive?',
      help: 'AI assistants like ChatGPT answer questions — list the questions you want your site to be the answer to.', suggest: true },
    { name: 'highlights', label: 'Extra highlights (optional)', type: 'textarea', placeholder: 'Anything else to surface in the file', suggest: true },
  ],
  'geo-onpage': [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    // The prompt box is where a beginner stalls — they know their page, not the
    // questions they want AI to cite it for. `suggest` reads the Page URL above
    // and drafts three; the same free pass also fills the empty context fields
    // below (brand / industry / audience), which it can infer from the page.
    { name: 'prompts', label: 'Target prompts (one per line, 1–3)', type: 'textarea', placeholder: 'e.g. What is the best project management tool for small teams?', required: true,
      suggest: true },
    { name: 'brand', label: 'Brand name', type: 'text', placeholder: 'e.g. Acme Co' },
    { name: 'industry', label: 'Industry / niche', type: 'text', placeholder: 'e.g. SaaS / Project management' },
    { name: 'audience', label: 'Target audience', type: 'text', placeholder: 'e.g. startup founders, small business owners' },
    { name: 'market', label: 'Target market', type: 'select', options: COUNTRIES, default: 'Singapore',
      hint: 'The primary country or market you are optimising for.' },
  ],
  'forensic-audit': [{ name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true }],

  persona: [
    { name: 'input', label: 'URL or brand description', type: 'textarea', placeholder: 'A website URL, or describe the brand + audience', required: true },
    { name: 'manual', label: 'Audience details to focus on', type: 'textarea',
      placeholder: 'Target audience: Men aged 25–40\nGeography / market: Singapore, Southeast Asia\nCustomer behaviour: Frequent online shoppers, bargain hunters\nLifestyle / interests: Fitness, travel, tech early-adopters',
      // `suggest` puts an "AI suggest" button on the box: it reads the URL (or
      // brand description) above and drafts the audience lines, because people
      // arrive with a website, not a demographic brief. Free, and editable after.
      hint: 'The more you give, the sharper the personas. Add any of: target audience (e.g. Men aged 25–40), geography or market, customer behaviour, lifestyle or interests, budget/income. Or hit AI suggest to draft it from your site.',
      suggest: true },
    { name: 'count', label: 'Number of personas', type: 'number', default: '10' },
  ],
  'media-plan': [
    { name: 'input', label: 'Campaign brief / website URLs', type: 'textarea', placeholder: 'Goals, audience, product/service, timeframe… or paste page URLs', required: true,
      hint: 'The core of the plan. Describe the campaign or paste site URLs — goals, product/service, audience and timeframe all help.' },
    { name: 'budget', label: 'Monthly budget', type: 'text', placeholder: 'e.g. $5,000',
      hint: 'Total monthly ad spend to split across channels. A ballpark is fine.' },
    { name: 'location', label: 'Target country / market', type: 'select', options: COUNTRIES, default: 'Singapore',
      hint: 'The primary country or market you are advertising in.' },
    { name: 'startDate', label: 'Campaign start date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'endDate', label: 'Campaign end date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'objectives', label: 'Organisational objectives', type: 'textarea', placeholder: 'e.g. Increase brand awareness by 20%',
      hint: 'The business outcomes this campaign should drive — ideally measurable.' },
    { name: 'channels', label: 'Ad channels', type: 'tags', placeholder: 'Google Search, Performance Max, Google Display, Meta, LinkedIn, TikTok (blank = all)',
      hint: 'Restrict the plan to specific platforms, or leave blank to let us recommend the mix.' },
    { name: 'targetAudience', label: 'Target audience', type: 'textarea', placeholder: 'e.g. SME owners in F&B, aged 30–50, Singapore, price-sensitive, active on Instagram',
      hint: 'Who you want to reach: demographics, interests, behaviours, pain points, location, income level.' },
    { name: 'customerPersonas', label: 'Customer personas', type: 'textarea', placeholder: 'Leave blank to auto-generate 3 personas',
      hint: 'Named buyer profiles if you have them — otherwise we generate 3 automatically.' },
    { name: 'productService', label: 'Product / service', type: 'text', placeholder: 'What you are promoting' },
    { name: 'touchpoints', label: 'Customer touchpoints', type: 'textarea', placeholder: 'Where customers interact with you',
      hint: 'Where prospects meet your brand — website, store, social, email, events.' },
    { name: 'contentStrategy', label: 'Content strategy', type: 'textarea', placeholder: 'Content themes / approach' },
    { name: 'landingPages', label: 'Landing pages', type: 'textarea', placeholder: 'Key landing-page URLs' },
    { name: 'cta', label: 'Call-to-action', type: 'text', placeholder: 'e.g. Book a demo, Shop now' },
    { name: 'kpis', label: 'KPIs', type: 'text', placeholder: 'e.g. CPL, ROAS, CTR',
      hint: 'The metrics success is judged on — cost per lead, ROAS, click-through rate, etc.' },
    { name: 'competitiveAnalysis', label: 'Competitive analysis', type: 'textarea', placeholder: 'Key competitors & positioning' },
    { name: 'compliance', label: 'Compliance / constraints', type: 'text', placeholder: 'Regulatory or brand constraints' },
    { name: 'technologyPlan', label: 'Technology / martech', type: 'text', placeholder: 'CRM, tracking, automation tools' },
    { name: 'analyticsReporting', label: 'Analytics & reporting', type: 'text', placeholder: 'How success is measured / reported' },
  ],
  'landing-audit': [
    { name: 'input', label: 'Landing page URL', type: 'url', placeholder: 'https://example.com/lp', required: true },
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. project management software' },
  ],
  'perf-marketing': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://client.com', required: true },
    { name: 'category', label: 'Business category / what they sell', type: 'text', placeholder: 'e.g. Dental clinic — Invisalign & implants', required: true },
    { name: 'country', label: 'Target country / market', type: 'select', options: COUNTRIES, default: 'Singapore',
      hint: 'The primary country or market you are advertising in.' },
    { name: 'audience', label: 'Target audience', type: 'textarea', placeholder: 'Who are the customers? Age, location, intent, B2B/B2C…', required: true },
    { name: 'budget', label: 'Monthly budget', type: 'text', placeholder: 'e.g. $5,000 (optional — we suggest a range)' },
    { name: 'objectives', label: 'Campaign objectives / goals', type: 'text', placeholder: 'e.g. qualified leads / online sales / awareness', required: true },
    { name: 'platforms', label: 'Current platforms', type: 'tags', placeholder: 'Google Search Ads, Meta Ads…' },
    { name: 'rfqNotes', label: 'RFQ / discussion notes', type: 'textarea', placeholder: 'Pain points, competitors, timing, constraints…' },
  ],
  'sem-copy': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'format', label: 'Ad format', type: 'select', options: ['Google Search', 'Google Performance Max', 'Google Display', 'Meta Image', 'Meta Video', 'Meta Carousel', 'Meta Collection', 'LinkedIn Image', 'LinkedIn Carousel', 'LinkedIn Video', 'LinkedIn Click to Message'], default: 'Google Search' },
    { name: 'country', label: 'Country', type: 'select', options: COUNTRIES, default: 'Singapore',
      hint: 'The target market for this ad copy.' },
    { name: 'language', label: 'Language', type: 'select', options: LLM_LANGUAGES, default: 'English' },
    { name: 'keywords', label: 'Keywords to include', type: 'tags', placeholder: 'e.g. project management software, team collaboration',
      hint: 'Optional. Keywords the ad copy should naturally incorporate where relevant.' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Professional', 'Friendly', 'Bold', 'Urgent', 'Salesy'], default: 'Professional' },
  ],

  gsc: [
    { name: 'input', label: 'Property', type: 'account', placeholder: 'https://example.com', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months', 'Custom'], default: 'Last 28 days' },
    { name: 'startDate', label: 'Start date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'endDate', label: 'End date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['query', 'page', 'country', 'device'], default: 'query' },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
    { name: 'searchType', label: 'Search type', type: 'select', options: ['Web', 'Image', 'Video', 'News', 'Discover'], default: 'Web' },
    { name: 'device', label: 'Device', type: 'select', options: ['All', 'Mobile', 'Desktop', 'Tablet'], default: 'All' },
    { name: 'country', label: 'Country (optional)', type: 'select', options: GSC_COUNTRY_OPTIONS, default: '',
      help: 'Only count searches made in one country. Leave as “All countries” to see everything.' },
    { name: 'brand', label: 'Your brand names (optional)', type: 'text', placeholder: 'e.g. mediaone, media one',
      help: 'Splits searches for your brand by name from everything else, so you can see how many people already know you.' },
  ],
  ga4: [
    { name: 'input', label: 'Property', type: 'account', placeholder: 'e.g. 123456789', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months', 'Custom'], default: 'Last 28 days' },
    { name: 'startDate', label: 'Start date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'endDate', label: 'End date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['channel', 'page', 'page title', 'landing page', 'source / medium', 'campaign', 'country', 'city', 'device', 'browser', 'operating system', 'event name', 'date'], default: 'channel' },
    { name: 'metrics', label: 'Extra metrics (Sessions, Users, Engaged, Conversions always shown)', type: 'multiselect', compatibility: 'ga4-metrics', options: ['New users', 'Active users', 'Engagement rate', 'Avg session duration', 'Bounce rate', 'Views', 'Event count', 'Total revenue', 'Add to carts', 'Purchases'] },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  'google-ads': [
    { name: 'input', label: 'Ads account', type: 'account', placeholder: 'e.g. 123-456-7890', required: true },
    { name: 'level', label: 'Level', type: 'select', options: ['Campaign', 'Ad group', 'Ad'], default: 'Campaign' },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months', 'Custom'], default: 'Last 28 days' },
    { name: 'startDate', label: 'Start date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'endDate', label: 'End date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
    { name: 'gaql', label: 'Custom GAQL query (optional)', type: 'textarea', advanced: true,
      placeholder: "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS",
      help: 'For power users only. GAQL is Google Ads Query Language — a query here replaces all the settings above. Leave blank if unsure.' },
  ],
  'meta-ads': [
    { name: 'input', label: 'Ad account', type: 'account', placeholder: 'e.g. act_1234567890', required: true },
    { name: 'level', label: 'Level', type: 'select', options: ['Campaign', 'Ad set', 'Ad'], default: 'Campaign' },
    { name: 'breakdown', label: 'Breakdown', type: 'select', options: ['None', 'Platform', 'Placement', 'Device', 'Country', 'Region', 'Age & gender', 'Hour'], default: 'None' },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months', 'Custom'], default: 'Last 28 days' },
    { name: 'startDate', label: 'Start date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'endDate', label: 'End date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  'linkedin-ads': [
    { name: 'input', label: 'Ad account', type: 'account', placeholder: 'e.g. 512345678', required: true },
    { name: 'level', label: 'Level', type: 'select', options: ['Campaign', 'Campaign group', 'Creative'], default: 'Campaign' },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months', 'Custom'], default: 'Last 28 days' },
    { name: 'startDate', label: 'Start date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'endDate', label: 'End date', type: 'date', required: true, showWhen: { field: 'range', in: ['Custom'] } },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  'strategy-engine': [
    { name: 'domain', label: 'Website', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'input', label: 'Business / brand description', type: 'textarea', placeholder: 'What the business does, products/services, positioning…', required: true },
    { name: 'seedKeywords', label: 'Seed keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'keywordInfluencers', label: 'Keyword influencers', type: 'textarea', placeholder: 'e.g. avoid competitor brand names, prioritise sustainability terms' },
    { name: 'objective', label: 'Primary objective', type: 'select', options: ['Lead Generation', 'Brand Authority', 'Local Visibility', 'E-commerce Revenue', 'Service Enquiries', 'Niche Dominance'], default: 'Lead Generation' },
    { name: 'targetAudience', label: 'Target audience', type: 'text', placeholder: 'e.g. startup founders, SME owners' },
    { name: 'marketContext', label: 'Market context', type: 'textarea', placeholder: 'Competitors, trends, positioning…' },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'select', options: LLM_LANGUAGES, default: 'English' },
  ],
};

// Fallback when a tool has no explicit schema: one field, labelled by category.
const DEFAULT_LABEL = { SEO: 'Keyword or domain', Content: 'Topic or brief', 'AI Visibility': 'Website or brand', Strategy: 'URL, brand or brief' };

export function inputsFor(tool) {
  if (INPUTS[tool.id]) return INPUTS[tool.id];
  return [{ name: 'input', label: DEFAULT_LABEL[tool.category] || 'Input', type: 'textarea', placeholder: '', required: true }];
}

// Tools that present several operations as tabs, each its own form + backend op
// (`gscOp`). Mirrors index.html's Search Console tabs. `destructiveWhen` gates a
// confirm before running (index removal / sitemap delete).
const TABS = {
  gsc: [
    { key: 'insights', label: 'Search Insights', op: 'insights', fields: INPUTS.gsc },
    { key: 'inspect', label: 'URL Inspection', op: 'inspect', fields: [
      { name: 'input', label: 'Property', type: 'account', placeholder: 'https://example.com', required: true },
      { name: 'urls', label: 'URLs to inspect', type: 'textarea', placeholder: 'One URL per line (up to 15)…', required: true },
    ] },
    { key: 'sitemaps', label: 'Sitemaps', op: 'sitemaps', fields: [
      { name: 'input', label: 'Property', type: 'account', placeholder: 'https://example.com', required: true },
      { name: 'sitemapAction', label: 'Action', type: 'select', options: ['List', 'Submit', 'Delete'], default: 'List' },
      { name: 'sitemapUrl', label: 'Sitemap URL', type: 'url', placeholder: 'https://example.com/sitemap.xml', showWhen: { field: 'sitemapAction', in: ['Submit', 'Delete'] } },
    ], destructiveWhen: { field: 'sitemapAction', in: ['Delete'] } },
    { key: 'indexing', label: 'Indexing', op: 'indexing', fields: [
      { name: 'urls', label: 'URLs', type: 'textarea', placeholder: 'One URL per line (up to 15)…', required: true },
      { name: 'indexType', label: 'Request', type: 'select', options: ['Index / update', 'Remove from index'], default: 'Index / update' },
    ], destructiveWhen: { field: 'indexType', in: ['Remove from index'] } },
  ],
};

export function tabsFor(tool) {
  return TABS[tool?.id] || null;
}

// ── User profile (progressive profiling) ─────────────────────────────────────
// A richer picture of who each account is, collected a little at a time: the
// Dashboard surfaces 1–2 unanswered questions; completing the WHOLE profile
// grants a one-time PROFILE_BONUS of rollover tokens. This schema is the single
// source of truth for both the frontend (renders inputs by `type`) and the
// backend (whitelists keys + validates select/multiselect against `options`).
//
//   key         — stored under user.profile[key]
//   group       — section, keyed into PROFILE_GROUPS
//   type        — 'text' | 'textarea' | 'select' | 'multiselect'
//   options     — allowed values for select/multiselect (also drives validation)
//   required    — counts toward completion (the bonus needs every required key)
export const PROFILE_GROUPS = {
  firmographics: 'About your company',
  marketing: 'Your marketing',
  targeting: 'Who you target',
  contact: 'Contact & preferences',
};

export const PROFILE_BONUS = 50; // rollover tokens granted once, on full completion

export const PROFILE_FIELDS = [
  // ── Firmographics ──
  // Optional: freelancers and solo consultants have no company, and making this
  // required meant they could never complete the profile — so the nudge never
  // retired and the completion bonus was unreachable for them.
  { key: 'companyName', label: 'Company name', group: 'firmographics', type: 'text',
    placeholder: 'Optional — leave blank if you’re freelance', required: false },
  { key: 'industry', label: 'Industry', group: 'firmographics', type: 'select', required: true,
    options: ['E-commerce', 'SaaS / Technology', 'Professional services', 'Healthcare', 'Education',
      'Real estate', 'Finance / Insurance', 'Travel / Hospitality', 'Manufacturing', 'Retail',
      'Media / Publishing', 'Non-profit', 'Agency', 'Other'] },
  { key: 'companySize', label: 'Company size', group: 'firmographics', type: 'select', required: true,
    options: ['Just me', '2–10', '11–50', '51–200', '201–1000', '1000+'] },
  { key: 'role', label: 'Your role', group: 'firmographics', type: 'select', required: true,
    options: ['Owner / Founder', 'Marketing manager', 'SEO / Content specialist',
      'Agency / Consultant', 'Sales', 'Developer', 'Other'] },

  // ── Marketing ──
  { key: 'primaryGoal', label: 'Primary goal', group: 'marketing', type: 'select', required: true,
    options: GOALS.map((g) => g.label) },
  { key: 'monthlyBudget', label: 'Monthly marketing budget', group: 'marketing', type: 'select', required: true,
    options: ['Under $500', '$500–$2k', '$2k–$5k', '$5k–$20k', '$20k–$50k', '$50k+', 'Not sure'] },
  { key: 'channels', label: 'Channels you use', group: 'marketing', type: 'multiselect', required: true,
    options: ['SEO', 'Google Ads', 'Meta Ads', 'LinkedIn', 'TikTok', 'Email', 'Content / Blog', 'Organic social'] },
  { key: 'seoExperience', label: 'SEO experience', group: 'marketing', type: 'select', required: true,
    options: ['Beginner', 'Intermediate', 'Advanced'] },

  // ── Targeting & geo ──
  { key: 'targetMarkets', label: 'Target markets', group: 'targeting', type: 'multiselect', required: true,
    options: ['Singapore', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam', 'Philippines',
      'Australia', 'United States', 'United Kingdom', 'India', 'Global'] },
  { key: 'targetAudience', label: 'Target audience', group: 'targeting', type: 'textarea', required: true,
    placeholder: 'e.g. SME owners in F&B looking to grow online orders' },
  { key: 'competitors', label: 'Main competitors', group: 'targeting', type: 'textarea', required: false,
    placeholder: 'One per line, or comma-separated' },

  // ── Contact & preferences ──
  { key: 'phone', label: 'Phone / WhatsApp', group: 'contact', type: 'text', required: false,
    placeholder: '+65 …' },
  // Moved off the Free Trial + NDA gate (2026-07-20) — it blocked freelancers and
  // anyone who'd have to ask HQ for it. Optional, and only surfaced this late.
  { key: 'uen', label: 'Company registration no. (UEN)', group: 'contact', type: 'text', required: false,
    placeholder: 'Optional — e.g. 201912345A' },
  { key: 'timezone', label: 'Timezone', group: 'contact', type: 'select', required: true,
    options: ['SGT (UTC+8)', 'MYT (UTC+8)', 'WIB (UTC+7)', 'ICT (UTC+7)', 'IST (UTC+5:30)',
      'GMT (UTC+0)', 'EST (UTC−5)', 'PST (UTC−8)', 'AEST (UTC+10)', 'Other'] },
  { key: 'contactMethod', label: 'Preferred contact', group: 'contact', type: 'select', required: true,
    options: ['Email', 'Phone', 'WhatsApp'] },
  { key: 'heardFrom', label: 'How did you hear about us?', group: 'contact', type: 'select', required: true,
    options: ['Google search', 'Referral', 'Social media', 'Advertisement', 'Event / Webinar', 'Other'] },
];

export const PROFILE_FIELD_KEYS = PROFILE_FIELDS.map((f) => f.key);
export const PROFILE_REQUIRED_KEYS = PROFILE_FIELDS.filter((f) => f.required).map((f) => f.key);

// A single answer is "filled" if it's a non-empty string or a non-empty array.
export function profileValueFilled(v) {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'string' ? v.trim().length > 0 : v != null && v !== '';
}

// Shared completion rule (used by the frontend progress bar AND the backend
// bonus gate, so the two can never drift): every required key is filled.
export function isProfileComplete(profile) {
  const p = profile || {};
  return PROFILE_REQUIRED_KEYS.every((k) => profileValueFilled(p[k]));
}

// How many required fields are answered — drives the progress bar / "x of y".
export function profileProgress(profile) {
  const p = profile || {};
  const done = PROFILE_REQUIRED_KEYS.filter((k) => profileValueFilled(p[k])).length;
  return { done, total: PROFILE_REQUIRED_KEYS.length };
}

// ── Proactive assistant (Helpful Otter nudges) ───────────────────────────────
// The Otter can *initiate* a message based on what the user is doing. A trigger
// binds an app EVENT (opened a page, went idle, finished a run…) + optional
// CONDITIONS to a canned message (free) or an AI-phrased one (costs credits).
// This whole config is admin-editable (Admin → Assistant) and served to every
// client via /me. The engine that evaluates these lives in the frontend
// (lib/proactive.js + components/ProactiveEngine.jsx).

// The fixed catalog of events the app knows how to emit. `fields` lists which
// condition inputs the admin form should show for that event.
export const PROACTIVE_EVENTS = [
  { key: 'app_open',       label: 'App opened',          help: 'Fires once per app load, after onboarding overlays clear.', fields: ['emptyProjects', 'firstVisitOnly', 'minDaysAway'] },
  { key: 'route_enter',    label: 'Opens a page',        help: 'Fires when the user navigates to a page matching the pattern.', fields: ['route'] },
  { key: 'idle',           label: 'Idle on a page',      help: 'Fires after the user sits inactive on a matching page.', fields: ['route', 'idleSeconds'] },
  { key: 'run_finished',   label: 'Tool run finished',   help: 'Fires when a tool run completes.', fields: ['runStatus'] },
  { key: 'low_credits',    label: 'Credits run low',     help: 'Fires when the balance drops below the threshold.', fields: ['creditsBelow'] },
  { key: 'plan_step_done', label: 'Plan step completed', help: 'Fires when the user ticks off a goal-plan step.', fields: [] },
];
export const PROACTIVE_EVENT_KEYS = PROACTIVE_EVENTS.map((e) => e.key);

// Tokens usable inside a message body — replaced at fire time with live values.
export const PROACTIVE_TOKENS = [
  { token: '{firstName}', help: "The user's first name (falls back to “there”)." },
  { token: '{domain}',    help: "The active project's domain (falls back to “your site”)." },
  { token: '{toolName}',  help: 'The tool involved (run-finished / tool pages).' },
  { token: '{credits}',   help: 'Current total credit balance.' },
];
// Message bodies may also contain the same clickable chip tokens the chat uses:
//   [[tool:id]]  [[go:/path|Label]]  [[action:verb|arg]]
//   [[ask:Label]] / [[ask:Label|text to send]] — a quick-reply button that sends
//   that text to Monty as if the user typed it (great for offering next questions).

const RUN_STATUSES = ['any', 'success', 'empty', 'error'];

// Coerce one raw trigger into a clean, fully-defaulted shape. Used by the admin
// save path (server-side validation) and the admin UI (new-row defaults), so
// the two never drift. Returns null for unusable rows (bad event / no message).
export function normalizeProactiveTrigger(raw, i = 0) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const event = PROACTIVE_EVENT_KEYS.includes(t.event) ? t.event : 'route_enter';
  const message = clampStr(t.message, 500).trim();
  if (!message && !t.aiPhrase) return null; // canned trigger with no text is meaningless
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const id = clampStr(t.id, 40).trim() || `trg_${i}_${event}`;
  return {
    id,
    label: clampStr(t.label, 80).trim() || PROACTIVE_EVENTS.find((e) => e.key === event)?.label || 'Trigger',
    enabled: t.enabled !== false,
    event,
    // conditions (only the ones relevant to `event` are honoured by the engine)
    route: clampStr(t.route, 120).trim() || (event === 'route_enter' || event === 'idle' ? '/' : ''),
    idleSeconds: num(t.idleSeconds, 25, 5, 600),
    runStatus: RUN_STATUSES.includes(t.runStatus) ? t.runStatus : 'any',
    creditsBelow: num(t.creditsBelow, 20, 0, 100000),
    emptyProjects: !!t.emptyProjects,
    profileIncomplete: !!t.profileIncomplete,
    firstVisitOnly: !!t.firstVisitOnly,
    minDaysAway: num(t.minDaysAway, 0, 0, 365),
    tiers: Array.isArray(t.tiers) ? t.tiers.filter((x) => TIER_ORDER.includes(x)) : [],
    // message
    message,
    aiPhrase: !!t.aiPhrase,
    aiPrompt: clampStr(t.aiPrompt, 500).trim(),
    // pacing
    cooldownHours: num(t.cooldownHours, 24, 0, 8760),
    maxPerSession: num(t.maxPerSession, 1, 1, 20),
    priority: num(t.priority, 0, -100, 100),
  };
}

// Normalize the whole config object (global caps + triggers array).
export function normalizeProactive(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const triggers = (Array.isArray(c.triggers) ? c.triggers : [])
    .slice(0, 100)
    .map((t, i) => normalizeProactiveTrigger(t, i))
    .filter(Boolean);
  return {
    enabled: c.enabled !== false,
    maxPerSession: num(c.maxPerSession, 2, 0, 20),      // global cap across all triggers, per app session
    defaultCooldownHours: num(c.defaultCooldownHours, 24, 0, 8760),
    triggers,
  };
}

// Small local clamp so this module stays dependency-free (mirrors http.clampStr).
function clampStr(v, max) {
  const s = v == null ? '' : String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Seeded default triggers — the high-value set. Ships enabled so the feature is
// alive on first deploy; admins tune/disable/add from Admin → Assistant.
export const DEFAULT_PROACTIVE = normalizeProactive({
  enabled: true,
  maxPerSession: 0,   // 0 = unlimited: Monty stays on all the time. Per-trigger
                      // cooldowns still stop any one nudge repeating; the user can
                      // silence all proactive prompts from the chat-panel switch.
  defaultCooldownHours: 24,
  triggers: [
    { id: 'welcome_empty', label: 'Empty dashboard → onboard', event: 'app_open', emptyProjects: true, priority: 30, cooldownHours: 72,
      message: "Hi {firstName}! I'm Monty, your Digimetrics assistant. Want to start by creating your first project? A project is just your website — everything you run gets saved under it. [[go:/projects|Create a project]]" },
    { id: 'welcome_back', label: 'Returning after a week', event: 'app_open', minDaysAway: 7, priority: 20, cooldownHours: 48,
      message: "Welcome back, {firstName}! Want a quick recap of what changed, or shall we pick up your plan? [[go:/projects|My projects]]" },
    { id: 'dashboard_idle', label: 'Idle on dashboard', event: 'idle', route: '/', idleSeconds: 30, priority: 5, cooldownHours: 24,
      message: 'Not sure where to start? Tell me your goal and I’ll suggest the right tool. [[ask:Which tool fits my goal?]] [[ask:How do I get more visitors?]]' },
    { id: 'tool_form_idle', label: 'Stuck on a tool form', event: 'idle', route: '/tool/*', idleSeconds: 25, priority: 10, cooldownHours: 12,
      message: 'Need a hand with {toolName}? [[ask:What does this tool do?|What does {toolName} do?]] [[ask:What do I put in each field?]]' },
    { id: 'run_done', label: 'Run finished → next step', event: 'run_finished', runStatus: 'success', priority: 15, cooldownHours: 2,
      message: 'Your {toolName} run is done ✅ [[ask:Explain the results]] [[ask:What should I do next?]]' },
    // Discovery tips — fire after a run, when results are on screen. Higher
    // priority than run_done but long cooldowns, so each takes its turn across
    // sessions (the global per-session cap keeps it from ever feeling naggy),
    // then run_done fills the gaps once they're all on cooldown.
    { id: 'explain_gesture', label: 'Teach highlight-to-ask gesture', event: 'run_finished', runStatus: 'success', priority: 20, cooldownHours: 168, maxPerSession: 1,
      message: "Quick tip {firstName}: you don't have to type — highlight any part of your results (or right-click a card) and I'll explain what it means and what to do about it. Give it a try 👆" },
    { id: 'share_cards', label: 'Discover Share Cards', event: 'run_finished', runStatus: 'success', priority: 19, cooldownHours: 336, maxPerSession: 1,
      message: "Nice result! Hit the Share button on it and I'll turn it into a branded image you can post or send to a client — the graphic is generated for you." },
    { id: 'schedule_recurring', label: 'Discover Schedules', event: 'run_finished', runStatus: 'success', priority: 18, cooldownHours: 336, maxPerSession: 1,
      message: "Running {toolName} regularly? I can do it automatically on a schedule and flag what changed since last time. [[go:/schedules|Set up a schedule]]" },
    { id: 'results_tldr', label: 'Offer a plain-English TL;DR', event: 'run_finished', runStatus: 'success', priority: 17, cooldownHours: 168, maxPerSession: 1,
      message: "Lots to read here — want the short version? [[ask:Give me the short version|Give me the short version — the single most important thing to fix, no jargon.]]" },
    { id: 'tool_intro', label: 'Explain a tool on open', event: 'route_enter', route: '/tool/*', priority: 8, cooldownHours: 72,
      message: "New to {toolName}? Here's what it does and what to put in each field. [[ask:What does it do?|What does {toolName} do?]] [[ask:What do I put in each field?]]" },
    { id: 'profile_bonus', label: 'Nudge profile completion for credits', event: 'app_open', profileIncomplete: true, priority: 22, cooldownHours: 96,
      message: "Quick win {firstName}: finish your profile and I'll drop 50 free credits into your account. [[go:/profile|Complete your profile]]" },
    { id: 'run_empty', label: 'Run returned nothing', event: 'run_finished', runStatus: 'empty', priority: 18, cooldownHours: 2,
      message: 'That run came back empty — usually the web address or one of the inputs just needs a tweak. Want me to take a look and re-run it with you?' },
    { id: 'low_credits', label: 'Credits running low', event: 'low_credits', creditsBelow: 15, priority: 25, cooldownHours: 24,
      message: 'Heads up {firstName} — you’re down to {credits} credits. [[go:/account|Top up]] or [[go:/pricing|upgrade]] to keep going.' },
    { id: 'plan_step', label: 'Plan step done → nudge next', event: 'plan_step_done', priority: 12, cooldownHours: 1,
      message: 'Nice work — another step done! Ready for the next one? [[go:/|Back to my plan]]' },
  ],
});
