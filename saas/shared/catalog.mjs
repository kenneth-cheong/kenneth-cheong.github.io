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
export const TERMS_VERSION = '2026-06-19';

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
    blurb: 'Kick the tyres. Real tools, capped results.',
    highlights: ['30 AI credits / month', '1 project', 'Caption generator', 'Capped keyword + rank results'],
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 39,
    monthlyCredits: 500,
    projects: 3,
    trackedKeywords: 25,
    blurb: 'For solo marketers shipping content + SEO.',
    highlights: ['500 credits / month', '3 projects', 'Full SEO Toolkit', 'Full AI Content Studio', '25 tracked keywords'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 109,
    monthlyCredits: 2000,
    projects: 10,
    trackedKeywords: 250,
    popular: true,
    blurb: 'The serious operator plan. AI Visibility + ad integrations.',
    highlights: ['2,000 credits / month', '10 projects', 'AI Visibility (GEO) suite', 'Google / Meta / GA4 integrations', '250 tracked keywords', 'Advanced AI model'],
  },
  expert: {
    id: 'expert',
    name: 'Expert',
    priceMonthly: 199,
    monthlyCredits: 6000,
    projects: 25,
    trackedKeywords: 1000,
    blurb: 'Agencies-of-one and power users.',
    highlights: ['6,000 credits / month', '25 projects', 'White-label PDF export', 'API access', '1,000 tracked keywords', 'Priority AI queue'],
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
  crawl: 2, // per 10 pages
  backlinks: 5, // per domain report
  page_analysis: 5, // landing page / SEM website analysis
  ai_visibility: 10, // multi-LLM fan-out (AI Discovery / AI Mentions)
  forensic_audit: 50,
  integration_pull: 0, // GSC / GA4 / Ads — user's own quota, drives stickiness
  ai_chat: 2, // one assistant message (Claude call + injected account context)
};

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
    desc: 'Search volume, difficulty and intent for any keyword list.',
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
  { id: 'competitors', name: 'Competitors Identifier', category: 'SEO', minTier: 'starter',
    cost: 'keyword_lookup', upstream: 'serpCompetitors',
    desc: 'Find who shares your keywords and how you stack up.' },
  { id: 'backlinks', name: 'Backlinks Explorer', category: 'SEO', minTier: 'pro',
    cost: 'backlinks', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Link profile audit, dofollow/nofollow, competitor links.',
    teaser: { reveal: 'summary-only' } },
  { id: 'schema', name: 'Schema Generator', category: 'SEO', minTier: 'free',
    cost: 'ai_short', upstream: null,
    desc: 'Visual JSON-LD builder for rich snippets. No data fetch.' },

  // ── AI Content Studio ─────────────────────────────────────────────────────
  { id: 'caption', name: 'Caption Generator', category: 'Content', minTier: 'free',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Platform-tuned captions for IG / LinkedIn / FB / TikTok.' },
  { id: 'content-writer', name: 'AI Content Optimiser', category: 'Content', minTier: 'starter',
    cost: 'ai_long', upstream: 'aiOptimiser', slow: true,
    desc: 'Write or optimise content, then run the 18-agent QA suite over it.' },
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
  { id: 'perf-marketing', name: 'Performance Marketing Audit', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'performanceMarketing', slow: true,
    desc: 'Channel mix, budget split & opportunities for a paid-media plan.' },
  // Social Media Audit — bespoke page (`route`): live multi-platform scrape +
  // AI content-gap & competitor strategy in one combined two-phase run. The
  // strategy phase is the single charged step; scrape/discover are free helpers.
  { id: 'social-audit', name: 'Social Media Audit', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'socialMediaAudit', slow: true, route: '/social-audit',
    desc: 'Live profile scrape + AI content-gap & competitor strategy across IG, TikTok, FB, LinkedIn & YouTube.' },

  // ── Strategy Engine (flagship: auto SEO action-plan generator) ────────────
  { id: 'strategy-engine', name: 'SEO Strategy', category: 'SEO', minTier: 'pro',
    cost: 'ai_long', upstream: 'strategyEngine', slow: true,
    desc: 'Auto-generates a keyword strategy with prioritised SEO action plans.' },

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
    desc: 'Find keywords and fix what holds your rankings back.',
    tools: ['keyword-analysis', 'rank-checker', 'technical-seo', 'onpage', 'strategy-engine'] },
  { id: 'health', label: 'Check my site’s health', icon: 'Stethoscope', to: '/audit',
    desc: 'A full audit with a score and a prioritised fix list.',
    tools: ['forensic-audit', 'page-analysis', 'technical-seo', 'landing-audit'] },
  { id: 'content', label: 'Create content', icon: 'PenLine',
    desc: 'Write posts, captions and content plans that rank.',
    tools: ['content-writer', 'caption', 'pillars', 'content-check'] },
  { id: 'rankings', label: 'Track my Google rankings', icon: 'LineChart', to: '/tracking',
    desc: 'Watch your keyword positions over time.',
    tools: ['rank-checker'] },
  { id: 'ai-visibility', label: 'Show up in AI answers', icon: 'Sparkles',
    desc: 'Get cited by ChatGPT, Gemini & Perplexity.',
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
  'Domain Authority': 'A 0–100 score estimating how strongly a whole site can rank.',
  'Domain rank': 'A score estimating how strong and trusted your domain is overall.',
  'Domain Rating': 'A 0–100 score of how strong your backlink profile is.',
  'Page Authority': 'A 0–100 score estimating how well a single page can rank.',
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
  'GTmetrix Grade': 'A letter grade (A–F) for the page’s overall loading performance.',
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
  'content-writer': { mode: 'Optimise existing content', input: 'Project management is useful. Asana has tools for teams. Contact us to learn more.', keyword: 'project management software', analysis: 'Verify & QA (8 agents)' },
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
  'Poland', 'Portugal', 'Qatar', 'Romania', 'Russia', 'Saudi Arabia',
  'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain',
  'Sri Lanka', 'Sweden', 'Switzerland', 'Taiwan', 'Thailand', 'Turkey',
  'Ukraine', 'United Arab Emirates', 'United Kingdom', 'United States', 'Vietnam',
];
const LANGUAGES = [
  'Arabic', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Dutch', 'English',
  'Filipino', 'French', 'German', 'Hindi', 'Indonesian', 'Italian', 'Japanese',
  'Korean', 'Malay', 'Portuguese', 'Russian', 'Spanish', 'Tamil', 'Thai',
  'Vietnamese',
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
    { name: 'domain', label: 'Your domain (optional — lets you estimate time-to-rank for chosen keywords)', type: 'url', placeholder: 'https://yoursite.com',
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
    { name: 'maxPages', label: 'Max pages to crawl', type: 'number', default: '10' },
    { name: 'maxDepth', label: 'Max crawl depth', type: 'number', default: '4' },
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
  backlinks: [
    { name: 'input', label: 'Domain', type: 'text', placeholder: 'example.com', required: true },
    { name: 'mode', label: 'Analysis scope', type: 'select', options: ['domain', 'host', 'url'], default: 'domain' },
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
    { name: 'language', label: 'Language', type: 'select', options: ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese', 'Arabic'], default: 'English' },
    { name: 'wordCount', label: 'Word count', type: 'text', placeholder: 'e.g. 60' },
    { name: 'emojis', label: 'Include emojis', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { name: 'hashtags', label: 'Include hashtags', type: 'select', options: ['Yes', 'No'], default: 'Yes' },
    { name: 'constraints', label: 'Constraints / mandatories', type: 'text', placeholder: "e.g. don't use the word 'cheap'" },
    { name: 'sampleText', label: 'Style sample', type: 'textarea', placeholder: 'Paste a past caption to match its voice (optional)' },
    { name: 'specificInstructions', label: 'Specific instructions', type: 'textarea', placeholder: 'Any other direction for the copy' },
  ],
  // Full AI Content Optimiser — write/optimise + the 18-agent QA suite.
  'content-writer': [
    { name: 'mode', label: 'Mode', type: 'select', options: ['Optimise existing content', 'Write a new draft'], default: 'Optimise existing content' },
    { name: 'input', label: 'Content (or topic if writing new)', type: 'textarea', placeholder: 'Paste content to optimise, or a topic to write about…', required: true },
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. project management software' },
    { name: 'secondary', label: 'Secondary keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'analysis', label: 'QA agents to run', type: 'select', options: ['Verify & QA (8 agents)', 'Research & Discovery (7 agents)', 'Structure & Enrichment (3 agents)', 'Full audit (all 18 agents)'], default: 'Verify & QA (8 agents)' },
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
    { name: 'complexity', label: 'Decision complexity', type: 'select', options: ['Low (impulse / low consideration)', 'Medium (comparison-based)', 'High (trust-heavy / multi-touch)'], default: 'Medium (comparison-based)' },
    { name: 'platforms', label: 'Primary platform', type: 'select', options: ['LinkedIn', 'Instagram', 'TikTok', 'Facebook', 'YouTube / Shorts'], default: 'Instagram' },
    { name: 'sensitivity', label: 'Brand risk sensitivity', type: 'select', options: ['Low (playful, trend-led)', 'Medium (balanced)', 'High (regulated, reputation-heavy)'], default: 'Medium (balanced)' },
    { name: 'promoTolerance', label: 'Promotional tolerance', type: 'select', options: ['Low (soft sell only)', 'Medium (occasional CTA)', 'High (offer-led, sales-focused)'], default: 'Medium (occasional CTA)' },
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
  'llms-txt': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'summary', label: 'Summary / blockquote (optional)', type: 'textarea', placeholder: 'Leave blank to auto-write it from the site' },
    { name: 'geoPrompts', label: 'Target prompts for GEO (optional, one per line)', type: 'textarea', placeholder: 'What makes Acme the best choice?\nHow does Acme help teams stay productive?' },
    { name: 'highlights', label: 'Extra highlights (optional)', type: 'textarea', placeholder: 'Anything else to surface in the file' },
  ],
  'geo-onpage': [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    { name: 'prompts', label: 'Target prompts (one per line, 1–3)', type: 'textarea', placeholder: 'e.g. What is the best project management tool for small teams?', required: true },
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
      hint: 'The more you give, the sharper the personas. Add any of: target audience (e.g. Men aged 25–40), geography or market, customer behaviour, lifestyle or interests, budget/income.' },
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
    { name: 'language', label: 'Language', type: 'text', default: 'English' },
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
    { name: 'country', label: 'Country (3-letter code, optional)', type: 'text', placeholder: 'e.g. sgp' },
    { name: 'brand', label: 'Brand terms for branded/non-branded split (optional)', type: 'text', placeholder: 'e.g. mediaone, media one' },
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
    { name: 'gaql', label: 'Advanced: custom GAQL query (optional — overrides the above)', type: 'textarea', placeholder: "SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS" },
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
    { name: 'language', label: 'Language', type: 'select', options: ['English', 'Chinese (Simplified)', 'Chinese (Traditional)', 'Malay', 'Indonesian', 'Tamil'], default: 'English' },
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
  { key: 'companyName', label: 'Company name', group: 'firmographics', type: 'text',
    placeholder: 'Acme Pte Ltd', required: true },
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
