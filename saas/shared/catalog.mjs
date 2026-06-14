// ─────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for plans, credit costs, and the tool registry.
// Imported by BOTH the React frontend (via the `@shared` Vite alias) and the
// Lambda backend (via relative path). Never fork this — gating + pricing must
// agree on both sides, but the BACKEND is always the authority that enforces.
// ─────────────────────────────────────────────────────────────────────────

/** Billing currency — prices below and all Stripe Prices are created in SGD. */
export const CURRENCY = { code: 'SGD', symbol: 'S$' };

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
    cost: 'keyword_lookup', upstream: 'mangoolsKeywords',
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
    tools: ['forensic-audit', 'technical-seo', 'landing-audit'] },
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
  'content-writer': { name: 'Write content', desc: 'Write or improve a page, then auto-check the quality.' },
  pillars: { name: 'Content plan', desc: 'A map of topics and angles to post about.' },
  gsc: { name: 'My Google search stats', desc: 'Clicks, impressions and positions from Google.' },
  ga4: { name: 'My website visitors', desc: 'Visitors, sessions and conversions from Analytics.' },
  'google-ads': { name: 'My Google Ads', desc: 'Spend, clicks and cost-per-result from Ads.' },
  'sem-copy': { name: 'Write my ads', desc: 'Generate Google / Meta / LinkedIn ad copy.' },
  persona: { name: 'Know my audience', desc: 'Build audience profiles from your website.' },
  'media-plan': { name: 'Plan my ad budget', desc: 'A channel + budget plan for your campaigns.' },
  competitors: { name: 'Find my competitors', desc: 'See who you share keywords with.' },
  'landing-audit': { name: 'Check a landing page', desc: 'Will this page convert visitors? Find out.' },
};

/** Jargon → plain definition, for hover tooltips (Simple mode + result labels). */
export const GLOSSARY = {
  CTR: 'Click-through rate — the % of people who clicked after seeing you in search.',
  Impressions: 'How many times your site showed up in search results.',
  Clicks: 'How many people clicked through to your site.',
  Position: 'Your average ranking spot in Google (1 = top).',
  'Avg Position': 'Your average ranking spot in Google (1 = top).',
  Difficulty: 'How hard it is to rank for this keyword (higher = harder).',
  Volume: 'How many people search this term each month.',
  CPC: 'Cost per click if you advertised on this keyword.',
  CPA: 'Cost per acquisition — what you pay for each conversion.',
  Sessions: 'Visits to your site (one person can visit several times).',
  Users: 'The number of distinct people who visited.',
  Conversions: 'Desired actions completed (sign-ups, sales, enquiries…).',
  Backlinks: 'Links from other websites pointing to yours.',
  SERP: 'Search engine results page — what Google shows for a search.',
  GEO: 'Generative Engine Optimisation — getting cited by AI chatbots.',
};

/** One-click sample inputs per tool ("Try an example"). */
export const EXAMPLES = {
  'keyword-analysis': { mode: 'Keyword metrics', input: 'self storage singapore, storage units', location: 'Singapore', language: 'English' },
  'rank-checker': { input: 'self storage singapore', target: 'extraspaceasia.com.sg', location: 'Singapore' },
  'time-to-rank': { domain: 'https://www.extraspaceasia.com.sg', input: 'self storage singapore', location: 'Singapore', language: 'English' },
  'anchor-cleaner': { input: 'https://www.extraspaceasia.com.sg/personal-storage/', keyword: 'self storage' },
  'technical-seo': { input: 'https://www.extraspaceasia.com.sg', maxPages: '10', maxDepth: '4' },
  onpage: { input: 'https://www.extraspaceasia.com.sg/personal-storage/', keywords: 'self storage, storage units' },
  competitors: { input: 'self storage singapore', location: 'Singapore', language: 'English' },
  backlinks: { input: 'extraspaceasia.com.sg', mode: 'domain' },
  schema: { type: 'LocalBusiness', name: 'Acme Storage', url: 'https://acme.sg', telephone: '+65 6555 5555', address: '1 Main St, Singapore' },
  caption: { input: 'New climate-controlled storage units just launched', brand: 'Acme Storage', platform: 'Instagram', tone: 'Friendly', language: 'English' },
  'content-writer': { mode: 'Optimise existing content', input: 'Self storage in Singapore is useful. We have units. Contact us.', keyword: 'self storage singapore', analysis: 'Verify & QA (8 agents)' },
  'content-check': { input: "Self storage is the cheapest way to store you're items. We offer alot of unit sizes.", keyword: 'self storage singapore' },
  pillars: { input: 'eco-friendly self storage brand', businessModel: 'B2C', objectives: 'Brand authority', audienceType: 'Individual consumers' },
  'ai-discovery': { input: 'Extra Space Asia', url: 'https://www.extraspaceasia.com.sg', location: 'Singapore' },
  'ai-mentions': { input: 'Extra Space Asia', url: 'https://www.extraspaceasia.com.sg', location: 'Singapore' },
  'llms-txt': { input: 'https://www.extraspaceasia.com.sg' },
  'geo-onpage': { input: 'https://www.extraspaceasia.com.sg/personal-storage/', prompts: 'Where can I find self storage in Singapore?', brand: 'Extra Space Asia', market: 'Singapore' },
  'forensic-audit': { input: 'https://www.extraspaceasia.com.sg' },
  persona: { input: 'https://www.extraspaceasia.com.sg' },
  'media-plan': { input: 'Launch awareness + leads for a Singapore self-storage brand', budget: 'S$8,000', location: 'Singapore', objectives: 'Increase brand awareness and generate enquiries' },
  'landing-audit': { input: 'https://www.extraspaceasia.com.sg/personal-storage/', keyword: 'self storage singapore' },
  'sem-copy': { input: 'https://www.extraspaceasia.com.sg', format: 'Google Search', country: 'Singapore', language: 'English', tone: 'Professional' },
  'perf-marketing': { input: 'https://acme-dental.sg', category: 'Dental clinic — Invisalign & implants', country: 'Singapore', audience: 'Adults 25-45 considering Invisalign', budget: 'S$6,000', objectives: 'qualified leads' },
  'strategy-engine': { domain: 'https://acme.sg', input: 'A Singapore self-storage operator targeting urban renters and SMEs', objective: 'Lead Generation', location: 'Singapore' },
};

export function exampleFor(toolId) {
  return EXAMPLES[toolId] || null;
}

/** Providers the user can connect (OAuth) to unlock the Integrations tools. */
export const INTEGRATIONS = [
  { id: 'gsc', name: 'Google Search Console', blurb: 'Search clicks, impressions, CTR & position.' },
  { id: 'ga4', name: 'Google Analytics (GA4)', blurb: 'Sessions, users, engagement & conversions.' },
  { id: 'google-ads', name: 'Google Ads', blurb: 'Campaign spend, clicks, conversions & CPA.' },
];

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
const LOCATIONS = ['Singapore', 'Malaysia', 'United States', 'United Kingdom', 'Australia', 'Global'];
const LANGUAGES = ['English', 'Chinese', 'Malay'];

export const INPUTS = {
  'keyword-analysis': [
    { name: 'mode', label: 'Mode', type: 'select', options: ['Keyword metrics', 'Similar keywords (from seed)', 'Ranking keywords (for a domain)', 'Keywords from a webpage'], default: 'Keyword metrics' },
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add a keyword and press Enter', required: true,
      showWhen: { field: 'mode', in: ['Keyword metrics', 'Similar keywords (from seed)'] } },
    { name: 'target', label: 'Domain or page URL', type: 'url', placeholder: 'https://example.com', required: true,
      showWhen: { field: 'mode', in: ['Ranking keywords (for a domain)', 'Keywords from a webpage'] } },
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
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. self storage', required: true },
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
    { name: 'telephone', label: 'Telephone', type: 'text', placeholder: '+65 6555 5555', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Service'] } },
    { name: 'address', label: 'Address', type: 'text', placeholder: '123 Main St, Singapore', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Event'] } },
    { name: 'priceRange', label: 'Price range', type: 'text', placeholder: '$$', showWhen: { field: 'type', in: ['LocalBusiness'] } },
    { name: 'openingHours', label: 'Opening hours', type: 'text', placeholder: 'Mo-Fr 09:00-18:00', showWhen: { field: 'type', in: ['LocalBusiness'] } },
    { name: 'sameAs', label: 'Social profiles (one URL per line)', type: 'textarea', placeholder: 'https://facebook.com/acme\nhttps://linkedin.com/company/acme', showWhen: { field: 'type', in: ['LocalBusiness', 'Organization', 'Person'] } },
    { name: 'brand', label: 'Brand', type: 'text', placeholder: 'Acme', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'sku', label: 'SKU', type: 'text', placeholder: 'SW3000-B', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'offers_price', label: 'Price', type: 'number', placeholder: '49.99', showWhen: { field: 'type', in: ['Product'] } },
    { name: 'offers_priceCurrency', label: 'Currency', type: 'text', default: 'SGD', showWhen: { field: 'type', in: ['Product'] } },
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
    { name: 'language', label: 'Language', type: 'select', options: ['English', 'Chinese', 'Singlish', 'Xiao Hong Shu'], default: 'English' },
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
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. self storage Singapore' },
    { name: 'secondary', label: 'Secondary keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'analysis', label: 'QA agents to run', type: 'select', options: ['Verify & QA (8 agents)', 'Research & Discovery (7 agents)', 'Structure & Enrichment (3 agents)', 'Full audit (all 18 agents)'], default: 'Verify & QA (8 agents)' },
    { name: 'pageType', label: 'Page type', type: 'select', options: ['Any', 'Blog', 'Product', 'Service', 'Landing page', 'Category', 'Home'], default: 'Any' },
    { name: 'brandTone', label: 'Brand tone', type: 'select', options: ['Professional', 'Conversational', 'Authoritative', 'Friendly', 'Bold', 'Luxury'], default: 'Professional' },
    { name: 'audience', label: 'Audience', type: 'text', placeholder: 'e.g. SME owners in Singapore', default: 'Working professionals' },
    { name: 'readingLevel', label: 'Reading level', type: 'select', options: ['Grade 4-6 (Very easy)', 'Grade 6-8 (Easy)', 'Grade 9-12 (Standard)', 'University (Advanced)'], default: 'Grade 6-8 (Easy)' },
    { name: 'doNotUseWords', label: 'Words to avoid', type: 'text', placeholder: "e.g. cheap, budget" },
  ],
  // Full Content Checker — grammar/compliance with brand guides + references.
  'content-check': [
    { name: 'input', label: 'Content to check', type: 'textarea', placeholder: 'Paste the copy to check…', required: true },
    { name: 'keyword', label: 'Target SEO keyword', type: 'text', placeholder: 'e.g. self storage Singapore' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Any', 'Conversational', 'Formal', 'Authoritative', 'Friendly', 'Persuasive'], default: 'Any' },
    { name: 'languageVariant', label: 'English variant', type: 'select', options: ['British English', 'American English', 'Australian English', 'Canadian English'], default: 'British English' },
    { name: 'instructions', label: 'Extra instructions', type: 'textarea', placeholder: "e.g. don't use the word 'cheap'; keep sentences short" },
    { name: 'referenceUrls', label: 'Reference URLs', type: 'textarea', placeholder: 'one URL per line — parsed and used as source-of-truth' },
    { name: 'brandGuideUrls', label: 'Brand guide URLs (PDF)', type: 'textarea', placeholder: 'one PDF URL per line' },
    { name: 'compliance', label: 'Compliance requirements', type: 'textarea', placeholder: 'e.g. MAS advertising guidelines, no superlative claims' },
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
    { name: 'geoPrompts', label: 'Target prompts for GEO (optional, one per line)', type: 'textarea', placeholder: 'What makes Acme the best storage choice?\nHow does self-storage help businesses scale?' },
    { name: 'highlights', label: 'Extra highlights (optional)', type: 'textarea', placeholder: 'Anything else to surface in the file' },
  ],
  'geo-onpage': [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    { name: 'prompts', label: 'Target prompts (one per line, 1–3)', type: 'textarea', placeholder: 'e.g. Where can I find self-storage in Singapore?', required: true },
    { name: 'brand', label: 'Brand name', type: 'text', placeholder: 'e.g. Acme Co' },
    { name: 'industry', label: 'Industry / niche', type: 'text', placeholder: 'e.g. Self-storage' },
    { name: 'audience', label: 'Target audience', type: 'text', placeholder: 'e.g. homeowners, small business owners' },
    { name: 'market', label: 'Target market', type: 'text', default: 'Singapore' },
  ],
  'forensic-audit': [{ name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true }],

  persona: [
    { name: 'input', label: 'URL or brand description', type: 'textarea', placeholder: 'A website URL, or describe the brand + audience', required: true },
    { name: 'manual', label: 'Any other information', type: 'textarea', placeholder: 'Anything specific the personas should focus on' },
    { name: 'count', label: 'Number of personas', type: 'number', default: '10' },
  ],
  'media-plan': [
    { name: 'input', label: 'Campaign brief / website URLs', type: 'textarea', placeholder: 'Goals, audience, product/service, timeframe… or paste page URLs', required: true },
    { name: 'budget', label: 'Monthly budget', type: 'text', placeholder: 'e.g. S$5,000' },
    { name: 'location', label: 'Target location', type: 'text', default: 'Singapore' },
    { name: 'startDate', label: 'Campaign start date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'endDate', label: 'Campaign end date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'objectives', label: 'Organisational objectives', type: 'textarea', placeholder: 'e.g. Increase brand awareness by 20%' },
    { name: 'channels', label: 'Ad channels', type: 'tags', placeholder: 'Google Search, Performance Max, Google Display, Meta, LinkedIn, TikTok (blank = all)' },
    { name: 'targetAudience', label: 'Target audience', type: 'textarea', placeholder: 'Who you are trying to reach' },
    { name: 'customerPersonas', label: 'Customer personas', type: 'textarea', placeholder: 'Leave blank to auto-generate 3 personas' },
    { name: 'productService', label: 'Product / service', type: 'text', placeholder: 'What you are promoting' },
    { name: 'touchpoints', label: 'Customer touchpoints', type: 'textarea', placeholder: 'Where customers interact with you' },
    { name: 'contentStrategy', label: 'Content strategy', type: 'textarea', placeholder: 'Content themes / approach' },
    { name: 'landingPages', label: 'Landing pages', type: 'textarea', placeholder: 'Key landing-page URLs' },
    { name: 'cta', label: 'Call-to-action', type: 'text', placeholder: 'e.g. Book a demo, Shop now' },
    { name: 'kpis', label: 'KPIs', type: 'text', placeholder: 'e.g. CPL, ROAS, CTR' },
    { name: 'competitiveAnalysis', label: 'Competitive analysis', type: 'textarea', placeholder: 'Key competitors & positioning' },
    { name: 'compliance', label: 'Compliance / constraints', type: 'text', placeholder: 'Regulatory or brand constraints' },
    { name: 'technologyPlan', label: 'Technology / martech', type: 'text', placeholder: 'CRM, tracking, automation tools' },
    { name: 'analyticsReporting', label: 'Analytics & reporting', type: 'text', placeholder: 'How success is measured / reported' },
  ],
  'landing-audit': [
    { name: 'input', label: 'Landing page URL', type: 'url', placeholder: 'https://example.com/lp', required: true },
    { name: 'keyword', label: 'Target keyword', type: 'text', placeholder: 'e.g. self storage singapore' },
  ],
  'perf-marketing': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://client.com', required: true },
    { name: 'category', label: 'Business category / what they sell', type: 'text', placeholder: 'e.g. Dental clinic — Invisalign & implants', required: true },
    { name: 'country', label: 'Target country / market', type: 'text', default: 'Singapore' },
    { name: 'audience', label: 'Target audience', type: 'textarea', placeholder: 'Who are the customers? Age, location, intent, B2B/B2C…', required: true },
    { name: 'budget', label: 'Monthly budget', type: 'text', placeholder: 'e.g. S$5,000 (optional — we suggest a range)' },
    { name: 'objectives', label: 'Campaign objectives / goals', type: 'text', placeholder: 'e.g. qualified leads / online sales / awareness', required: true },
    { name: 'platforms', label: 'Current platforms', type: 'tags', placeholder: 'Google Search Ads, Meta Ads…' },
    { name: 'rfqNotes', label: 'RFQ / discussion notes', type: 'textarea', placeholder: 'Pain points, competitors, timing, constraints…' },
  ],
  'sem-copy': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'format', label: 'Ad format', type: 'select', options: ['Google Search', 'Google Performance Max', 'Google Display', 'Meta Image', 'Meta Video', 'Meta Carousel', 'Meta Collection', 'LinkedIn Image', 'LinkedIn Carousel', 'LinkedIn Video', 'LinkedIn Click to Message'], default: 'Google Search' },
    { name: 'country', label: 'Country', type: 'text', default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'text', default: 'English' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Professional', 'Friendly', 'Bold', 'Urgent', 'Salesy'], default: 'Professional' },
  ],

  gsc: [
    { name: 'input', label: 'Property', type: 'account', placeholder: 'https://example.com', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['query', 'page', 'country', 'device'], default: 'query' },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  ga4: [
    { name: 'input', label: 'Property', type: 'account', placeholder: 'e.g. 123456789', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['channel', 'page', 'country', 'device'], default: 'channel' },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  'google-ads': [
    { name: 'input', label: 'Ads account', type: 'account', placeholder: 'e.g. 123-456-7890', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
    { name: 'compare', label: 'Compare to', type: 'select', options: ['None', 'Previous period', 'Previous year'], default: 'None' },
  ],
  'strategy-engine': [
    { name: 'domain', label: 'Website', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'input', label: 'Business / brand description', type: 'textarea', placeholder: 'What the business does, products/services, positioning…', required: true },
    { name: 'seedKeywords', label: 'Seed keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
    { name: 'keywordInfluencers', label: 'Keyword influencers', type: 'textarea', placeholder: 'e.g. avoid competitor brand names, prioritise sustainability terms' },
    { name: 'objective', label: 'Primary objective', type: 'select', options: ['Lead Generation', 'Brand Authority', 'Local Visibility', 'E-commerce Revenue', 'Service Enquiries', 'Niche Dominance'], default: 'Lead Generation' },
    { name: 'targetAudience', label: 'Target audience', type: 'text', placeholder: 'e.g. SME owners in Singapore' },
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
