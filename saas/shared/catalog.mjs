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
    cost: 'crawl', upstream: 'getHtml',
    desc: 'Flag over-optimised, generic or broken internal anchor text.' },
  { id: 'technical-seo', name: 'Technical SEO Crawler', category: 'SEO', minTier: 'starter',
    cost: 'crawl', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Multi-page crawl: broken tags, metadata issues, performance.',
    teaser: { reveal: 'summary-only' } },
  { id: 'onpage', name: 'On-Page Optimisation', category: 'SEO', minTier: 'starter',
    cost: 'ai_long', upstream: 'onPageContentRecommendations',
    desc: 'Benchmark title/meta/headings/content vs top-ranking pages.' },
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
    cost: 'ai_short', upstream: 'aiOptimiser',
    desc: 'Generate an llms.txt so AI chatbots index you correctly.' },
  { id: 'geo-onpage', name: 'GEO On-Page Optimisation', category: 'AI Visibility', minTier: 'pro',
    cost: 'ai_long', upstream: 'geoOnPageAnalysis',
    desc: 'Rewrite content to get picked up + cited by AI tools.' },
  { id: 'forensic-audit', name: 'GEO+SEO Forensic Audit', category: 'AI Visibility', minTier: 'pro',
    cost: 'forensic_audit', upstream: 'dataforseoCrawler', slow: true,
    desc: 'Deep SEO + GEO readiness check across 50+ factors.',
    teaser: { reveal: 'summary-only' } },

  // ── Ads & Strategy ────────────────────────────────────────────────────────
  { id: 'persona', name: 'Persona Generator', category: 'Strategy', minTier: 'starter',
    cost: 'ai_long', upstream: 'personaGenerator', slow: true,
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
  { id: 'perf-marketing', name: 'Performance Marketing Audit', category: 'Strategy', minTier: 'pro',
    cost: 'ai_long', upstream: 'performanceMarketing', slow: true,
    desc: 'Channel mix, budget split & opportunities for a paid-media plan.' },

  // ── Strategy Engine (flagship: auto SEO action-plan generator) ────────────
  { id: 'strategy-engine', name: 'Digimetrics Strategy Engine', category: 'SEO', minTier: 'pro',
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
    { name: 'input', label: 'Keywords', type: 'tags', placeholder: 'add a keyword and press Enter', required: true },
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
  schema: [{ name: 'input', label: 'What is this page about?', type: 'textarea', placeholder: 'e.g. a product page for trail running shoes', required: true }],

  // Mirrors the agency's luxury_copy form (text/select fields; file uploads omitted).
  caption: [
    { name: 'input', label: 'Core content / topic', type: 'textarea', placeholder: 'What the post is about…', required: true },
    { name: 'brand', label: 'Brand name', type: 'text', placeholder: 'Acme Co' },
    { name: 'platform', label: 'Content type', type: 'select', options: ['Instagram', 'Facebook', 'LinkedIn', 'TikTok'], default: 'Instagram' },
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
    { name: 'input', label: 'Website or brand', type: 'text', placeholder: 'https://example.com', required: true },
    { name: 'summary', label: 'Summary / blockquote', type: 'textarea', placeholder: 'One-line description of what the site offers' },
    { name: 'highlights', label: 'Key sections / highlights', type: 'textarea', placeholder: 'Services, products, resources to surface (one per line)' },
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
    { name: 'input', label: 'Campaign brief', type: 'textarea', placeholder: 'Goals, audience, product/service, timeframe…', required: true },
    { name: 'budget', label: 'Monthly budget', type: 'text', placeholder: 'e.g. S$5,000' },
    { name: 'location', label: 'Target location', type: 'text', default: 'Singapore' },
    { name: 'startDate', label: 'Campaign start date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'endDate', label: 'Campaign end date', type: 'text', placeholder: 'YYYY-MM-DD' },
    { name: 'objectives', label: 'Organisational objectives', type: 'textarea', placeholder: 'e.g. Increase brand awareness by 20%' },
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
    { name: 'format', label: 'Ad format', type: 'select', options: ['Google Search', 'Google Performance Max', 'Google Display', 'Meta Image', 'Meta Carousel', 'LinkedIn Image'], default: 'Google Search' },
    { name: 'country', label: 'Country', type: 'text', default: 'Singapore' },
    { name: 'language', label: 'Language', type: 'text', default: 'English' },
    { name: 'tone', label: 'Tone', type: 'select', options: ['Professional', 'Friendly', 'Bold', 'Urgent', 'Salesy'], default: 'Professional' },
  ],

  gsc: [
    { name: 'input', label: 'Property (site URL)', type: 'url', placeholder: 'https://example.com', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['query', 'page', 'country', 'device'], default: 'query' },
  ],
  ga4: [
    { name: 'input', label: 'GA4 property ID', type: 'text', placeholder: 'e.g. 123456789', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
    { name: 'dimension', label: 'Break down by', type: 'select', options: ['channel', 'page', 'country', 'device'], default: 'channel' },
  ],
  'google-ads': [
    { name: 'input', label: 'Ads account ID', type: 'text', placeholder: 'e.g. 123-456-7890', required: true },
    { name: 'range', label: 'Date range', type: 'select', options: ['Last 7 days', 'Last 28 days', 'Last 3 months'], default: 'Last 28 days' },
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
