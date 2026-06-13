// Maps tool `upstream` ids (from shared/catalog.mjs) to the EXISTING Lambda
// URLs the agency app already calls. The metering gateway proxies to these so
// we reuse all current backend work.
//
// ⚠️ SECURITY: these are currently PUBLIC, unauthenticated URLs. They must be
// locked down (private API / shared-secret header / IAM) so they can ONLY be
// invoked by this gateway — otherwise billing is bypassable. See README §Security.
export const UPSTREAMS = {
  claudeBridge: 'https://2zsxqwth46.execute-api.ap-southeast-1.amazonaws.com/claude',
  aiOptimiser: 'https://0oes56fj4l.execute-api.ap-southeast-1.amazonaws.com/aiOptimiser',
  mangoolsKeywords: 'https://gr8ar6zc4e.execute-api.ap-southeast-1.amazonaws.com/mangoolsKeywords',
  // Keyword Analysis modes: seed-based suggestions + a domain's ranking keywords.
  similarKeywords: 'https://lgvdhcs4t2.execute-api.ap-southeast-1.amazonaws.com/similarKeywords',
  rankingKeywords: 'https://0dqny7l5y9.execute-api.ap-southeast-1.amazonaws.com/rankingKeywords',
  rankChecker: 'https://v5bizygr4m.execute-api.ap-southeast-1.amazonaws.com/rankChecker',
  dataforseoCrawler: 'https://ak9qsl9wgi.execute-api.ap-southeast-1.amazonaws.com/dataforseoCrawler',
  onPageContentRecommendations: 'https://pkkz2e02ch.execute-api.ap-southeast-1.amazonaws.com/onPageContentRecommendations',
  serpCompetitors: 'https://itzj193chl.execute-api.ap-southeast-1.amazonaws.com/serpCompetitors',
  ahrefsProxy: 'https://b8cyd5ed90.execute-api.ap-southeast-1.amazonaws.com/new',
  checkContent: 'https://mmyvj7yj11.execute-api.ap-southeast-1.amazonaws.com/checkContent',
  // Content Pillar Framework uses its own Lambda (action 'pillar_framework').
  contentPillar: 'https://j4aca9hcmh.execute-api.ap-southeast-1.amazonaws.com/contentPillar',
  // Content Checker pre-parsers: brand-guide PDFs + reference-URL pages.
  pdfParser: 'https://i3oxhgicub.execute-api.ap-southeast-1.amazonaws.com/pdfParser',
  contentParsing: 'https://0i0g9xfy63.execute-api.ap-southeast-1.amazonaws.com/contentParsing',
  // Time to Rank: live SERP + LLM time-to-rank recommendation.
  serpLite: 'https://8k6r15rg4m.execute-api.ap-southeast-1.amazonaws.com/serpLite',
  kwRecommendations: 'https://pkbguam62a.execute-api.ap-southeast-1.amazonaws.com/kwRecommendationsStructured',
  // Anchor Text Cleaner: raw page HTML fetch.
  getHtml: 'https://abrhhnjp4m.execute-api.ap-southeast-1.amazonaws.com/getHtml',
  // Performance Marketing Audit: paid-media opportunity analysis.
  performanceMarketing: 'https://4gupr9vio3.execute-api.ap-southeast-1.amazonaws.com',
  // Google integrations — reuse the agency's proven Lambdas (same as index.html):
  //   gscIntegration → ga4ListProperties / ga4RunReport / adsListCustomers
  //   googleAds      → GAQL search
  //   googleAuth     → google_token_exchange / google_refresh_token (holds secret)
  gscIntegration: 'https://v5gyq2sqdd.execute-api.ap-southeast-1.amazonaws.com/gscIntegration',
  googleAds: 'https://j4aca9hcmh.execute-api.ap-southeast-1.amazonaws.com/googleAds',
  googleAuth: 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday',
  aiMentions: 'https://y0ypcivaz1.execute-api.ap-southeast-1.amazonaws.com/aiMentions',
  // Domain → ranking-keyword map, used to seed AI-visibility discovery prompts.
  keywordsForSite: 'https://ei6xj9x2rd.execute-api.ap-southeast-1.amazonaws.com/keywordsForSite',
  geoOnPageAnalysis: 'https://fhan3l5vta.execute-api.ap-southeast-1.amazonaws.com/geoOnPageAnalysis',
  // GEO+SEO Forensic Audit — the same probes index.html's autoFillForensicAudit() fires.
  // Site data: title/desc/h1-h2/schema/spam/backlinks (DataForSEO on-page snapshot).
  forensicSiteData: 'https://9px7sjbyyb.execute-api.ap-southeast-1.amazonaws.com/new',
  mozAuthority: 'https://a7hptjtc8e.execute-api.ap-southeast-1.amazonaws.com/new',
  pageSpeed: 'https://7vkudwlzhh.execute-api.ap-southeast-1.amazonaws.com/webpageAudit',
  sslCheck: 'https://2kxt49bwp1.execute-api.ap-southeast-1.amazonaws.com/checkSsl',
  gtmetrix: 'https://y5830908vh.execute-api.ap-southeast-1.amazonaws.com/gtmetrix',
  copyscape: 'https://tg6m9b7gsj.execute-api.ap-southeast-1.amazonaws.com/plagarismCheck',
  personaGenerator: 'https://tyqj3fni7h.execute-api.ap-southeast-1.amazonaws.com/personaGenerator',
  mediaPlanGenerator: 'https://h8ih2vc2xi.execute-api.ap-southeast-1.amazonaws.com/mediaPlanGenerator',
  auditLandingPage: 'https://llufeecqoe.execute-api.ap-southeast-1.amazonaws.com/auditLandingPage',
  auditLandingPageDirect: 'https://7eehmzk9e0.execute-api.ap-southeast-1.amazonaws.com/auditLandingPageDirectWeb',
  generateSemGoogle: 'https://bztsly2z89.execute-api.ap-southeast-1.amazonaws.com/generateSemGoogle',
  // Strategy Engine uses the `strategy_generate` action on this shared lambda
  // (SEO strategy generation — not monday-board management).
  strategyEngine: 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday',
};
