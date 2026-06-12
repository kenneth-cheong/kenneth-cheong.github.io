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
    highlights: ['2,000 credits / month', '10 projects', 'AI Visibility (GEO) suite', 'Google / Meta / GA4 integrations', '250 tracked keywords', 'Advanced AI model (Sonnet)'],
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
  crawl: 2, // per 10 pages
  backlinks: 5, // per domain report
  page_analysis: 5, // landing page / SEM website analysis
  ai_visibility: 10, // multi-LLM fan-out (AI Discovery / AI Mentions)
  forensic_audit: 50,
  integration_pull: 0, // GSC / GA4 / Ads — user's own quota, drives stickiness
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
  { id: 'technical-seo', name: 'Technical SEO Crawler', category: 'SEO', minTier: 'starter',
    cost: 'crawl', upstream: 'dataforseoCrawler',
    desc: 'Multi-page crawl: broken tags, metadata issues, performance.',
    teaser: { reveal: 'summary-only' } },
  { id: 'onpage', name: 'On-Page Optimisation', category: 'SEO', minTier: 'starter',
    cost: 'ai_long', upstream: 'onPageContentRecommendations',
    desc: 'Benchmark title/meta/headings/content vs top-ranking pages.' },
  { id: 'competitors', name: 'Competitors Identifier', category: 'SEO', minTier: 'starter',
    cost: 'keyword_lookup', upstream: 'serpCompetitors',
    desc: 'Find who shares your keywords and how you stack up.' },
  { id: 'backlinks', name: 'Backlinks Explorer', category: 'SEO', minTier: 'pro',
    cost: 'backlinks', upstream: 'ahrefsProxy',
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
    cost: 'ai_long', upstream: 'aiOptimiser',
    desc: 'Write from scratch or optimise a URL against the SERP.' },
  { id: 'content-check', name: 'Content Check', category: 'Content', minTier: 'starter',
    cost: 'ai_long', upstream: 'checkContent',
    desc: 'Readability, keyword density, originality, compliance.' },
  { id: 'pillars', name: 'Content Pillar Framework', category: 'Content', minTier: 'starter',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Pillar + subtopic + angle map for social cohesion.' },

  // ── AI Visibility (GEO) — the differentiator ──────────────────────────────
  { id: 'ai-discovery', name: 'AI Discovery Audit', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_visibility', upstream: 'aiMentions',
    desc: 'Are you cited in ChatGPT / Gemini / Perplexity answers?',
    teaser: { reveal: 'first-2-of-10' } },
  { id: 'ai-mentions', name: 'AI Mentions Tracker', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_visibility', upstream: 'aiMentions',
    desc: 'Track brand mention frequency across AI chatbots.',
    teaser: { reveal: 'first-2-of-10' } },
  { id: 'llms-txt', name: 'llms.txt Generator', category: 'AI Visibility', minTier: 'starter',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Generate an llms.txt so AI chatbots index you correctly.' },
  { id: 'geo-onpage', name: 'GEO On-Page Optimisation', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_long', upstream: 'geoOnPageAnalysis',
    desc: 'Rewrite content to get picked up + cited by AI tools.' },
  { id: 'forensic-audit', name: 'GEO+SEO Forensic Audit', category: 'AI Visibility', minTier: 'pro',
    cost: 'forensic_audit', upstream: 'dataforseoCrawler',
    desc: 'Deep SEO + GEO readiness check across 50+ factors.',
    teaser: { reveal: 'summary-only' } },

  // ── Ads & Strategy ────────────────────────────────────────────────────────
  { id: 'persona', name: 'Persona Generator', category: 'Strategy', minTier: 'starter',
    cost: 'ai_long', upstream: 'personaGenerator',
    desc: 'Build 10 audience personas from a URL.' },
  { id: 'media-plan', name: 'Media Plan Generator', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'mediaPlanGenerator',
    desc: 'Channel mix + budget allocation media plan.' },
  { id: 'landing-audit', name: 'Landing Page Audit', category: 'Strategy', minTier: 'starter',
    cost: 'page_analysis', upstream: 'auditLandingPageDirect',
    desc: 'Conversion potential, clarity, speed, SEO readiness.' },
  { id: 'sem-copy', name: 'SEM Ad Copy Generator', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'generateSemGoogle',
    desc: 'USP extraction → ad copy for Google / Meta / LinkedIn.' },

  // ── Added tools (AI, single-input → text via the Claude bridge) ───────────
  { id: 'meta-writer', name: 'Meta Title & Description Writer', category: 'SEO', minTier: 'free',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Click-worthy SEO titles + meta descriptions under the pixel limit.' },
  { id: 'faq-generator', name: 'FAQ Generator', category: 'SEO', minTier: 'starter',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Generate FAQ Q&As ready for FAQ schema and People-Also-Ask.' },
  { id: 'blog-outline', name: 'Blog Post Outline', category: 'Content', minTier: 'starter',
    cost: 'ai_long', upstream: 'aiOptimiser',
    desc: 'SEO-structured H2/H3 outline with talking points for any topic.' },
  { id: 'email-subjects', name: 'Email Subject Lines', category: 'Content', minTier: 'free',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: '10 high-open-rate subject lines for your campaign.' },
  { id: 'value-prop', name: 'Value Proposition Builder', category: 'Strategy', minTier: 'starter',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Sharp value props + tagline options from a product description.' },
  { id: 'hashtag-generator', name: 'Hashtag Generator', category: 'Content', minTier: 'free',
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Reach + niche hashtag mix per platform for any post.' },
];

export const CATEGORIES = ['SEO', 'Content', 'AI Visibility', 'Strategy'];

export function toolById(id) {
  return TOOLS.find((t) => t.id === id) || null;
}

// ── Per-tool input forms ────────────────────────────────────────────────────
// Each tool renders the fields below (by `name`); the frontend submits them as
// the request body, which the metering adapters read. The PRIMARY value should
// keep the name `input` (adapters + mock read body.input). `type`: text |
// textarea | url | select | number. `options` for selects.
const LOCATIONS = ['SG', 'MY', 'US', 'GB', 'AU', 'Worldwide'];

export const INPUTS = {
  'keyword-analysis': [
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add a keyword and press Enter', required: true },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'SG' },
    { name: 'language', label: 'Language', type: 'select', options: ['en', 'zh', 'ms'], default: 'en' },
  ],
  'rank-checker': [
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add keywords to check', required: true },
    { name: 'target', label: 'Your domain', type: 'text', placeholder: 'example.com', required: true },
    { name: 'location', label: 'Location', type: 'select', options: LOCATIONS, default: 'SG' },
  ],
  'technical-seo': [{ name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true }],
  onpage: [
    { name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true },
    { name: 'keywords', label: 'Target keywords', type: 'tags', placeholder: 'add a keyword and press Enter' },
  ],
  competitors: [{ name: 'input', label: 'Keywords or domains', type: 'tags', placeholder: 'add a keyword or domain', required: true }],
  backlinks: [{ name: 'input', label: 'Domain', type: 'text', placeholder: 'example.com', required: true }],
  schema: [{ name: 'input', label: 'What is this page about?', type: 'textarea', placeholder: 'e.g. a product page for trail running shoes', required: true }],

  caption: [
    { name: 'input', label: "What's the post about?", type: 'textarea', placeholder: 'New arrival, behind the scenes, promo…', required: true },
    { name: 'platform', label: 'Platform', type: 'select', options: ['Instagram', 'LinkedIn', 'Facebook', 'TikTok'], default: 'Instagram' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Friendly', 'Professional', 'Playful', 'Luxury', 'Bold'], default: 'Friendly' },
  ],
  'content-writer': [
    { name: 'input', label: 'Topic or URL to optimise', type: 'textarea', placeholder: 'A topic to write about, or a URL to optimise', required: true },
  ],
  'content-check': [{ name: 'input', label: 'Paste your content', type: 'textarea', placeholder: 'Paste the copy to check…', required: true }],
  pillars: [{ name: 'input', label: 'Brand or niche', type: 'text', placeholder: 'sustainable skincare brand', required: true }],

  'ai-discovery': [
    { name: 'input', label: 'Brand name', type: 'text', placeholder: 'Acme Co', required: true },
    { name: 'url', label: 'Website', type: 'url', placeholder: 'https://acme.co' },
  ],
  'ai-mentions': [
    { name: 'input', label: 'Brand name', type: 'text', placeholder: 'Acme Co', required: true },
    { name: 'url', label: 'Website', type: 'url', placeholder: 'https://acme.co' },
  ],
  'llms-txt': [{ name: 'input', label: 'Website or brand', type: 'text', placeholder: 'https://example.com', required: true }],
  'geo-onpage': [{ name: 'input', label: 'Page URL', type: 'url', placeholder: 'https://example.com/page', required: true }],
  'forensic-audit': [{ name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true }],

  persona: [{ name: 'input', label: 'URL or brand description', type: 'textarea', placeholder: 'A website URL, or describe the brand + audience', required: true }],
  'media-plan': [{ name: 'input', label: 'Campaign brief', type: 'textarea', placeholder: 'Goals, budget, audience, timeframe…', required: true }],
  'landing-audit': [{ name: 'input', label: 'Landing page URL', type: 'url', placeholder: 'https://example.com/lp', required: true }],
  'sem-copy': [
    { name: 'input', label: 'Website URL', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Professional', 'Friendly', 'Bold', 'Urgent'], default: 'Professional' },
  ],

  'meta-writer': [{ name: 'input', label: 'Page topic or target keyword', type: 'text', placeholder: 'best yoga studio singapore', required: true }],
  'faq-generator': [{ name: 'input', label: 'Topic', type: 'text', placeholder: 'electric vehicle charging', required: true }],
  'blog-outline': [{ name: 'input', label: 'Blog topic / target keyword', type: 'text', placeholder: 'how to start a podcast', required: true }],
  'email-subjects': [{ name: 'input', label: 'Campaign or offer', type: 'text', placeholder: 'Black Friday 30% off sale', required: true }],
  'value-prop': [{ name: 'input', label: 'Product or service description', type: 'textarea', placeholder: 'What you offer and to whom…', required: true }],
  'hashtag-generator': [{ name: 'input', label: 'Post topic', type: 'text', placeholder: 'morning coffee routine', required: true }],
};

// Fallback when a tool has no explicit schema: one field, labelled by category.
const DEFAULT_LABEL = { SEO: 'Keyword or domain', Content: 'Topic or brief', 'AI Visibility': 'Website or brand', Strategy: 'URL, brand or brief' };

export function inputsFor(tool) {
  if (INPUTS[tool.id]) return INPUTS[tool.id];
  return [{ name: 'input', label: DEFAULT_LABEL[tool.category] || 'Input', type: 'textarea', placeholder: '', required: true }];
}
