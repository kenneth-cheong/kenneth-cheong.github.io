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
  // On-Page: page element extraction (headings/meta/images) + meta & heading recs.
  getImages: 'https://udjdc333m9.execute-api.ap-southeast-1.amazonaws.com/getImages',
  onPageRecommendations: 'https://vwmqqj251d.execute-api.ap-southeast-1.amazonaws.com/onPageRecommendations',
  serpCompetitors: 'https://itzj193chl.execute-api.ap-southeast-1.amazonaws.com/serpCompetitors',
  checkContent: 'https://mmyvj7yj11.execute-api.ap-southeast-1.amazonaws.com/checkContent',
  // Content Pillar Framework uses its own Lambda (action 'pillar_framework').
  contentPillar: 'https://j4aca9hcmh.execute-api.ap-southeast-1.amazonaws.com/contentPillar',
  // Content Checker pre-parsers: brand-guide PDFs + reference-URL pages.
  pdfParser: 'https://i3oxhgicub.execute-api.ap-southeast-1.amazonaws.com/pdfParser',
  contentParsing: 'https://0i0g9xfy63.execute-api.ap-southeast-1.amazonaws.com/contentParsing',
  // Time to Rank: live SERP + LLM time-to-rank recommendation.
  serpLite: 'https://8k6r15rg4m.execute-api.ap-southeast-1.amazonaws.com/serpLite',
  kwRecommendations: 'https://pkbguam62a.execute-api.ap-southeast-1.amazonaws.com/kwRecommendationsStructured',
  // Time to Rank: per-keyword LLM rationale for why a keyword was selected.
  reasonForKwSelection: 'https://cdahvw5qi7.execute-api.ap-southeast-1.amazonaws.com/reasonForKwSelection',
  // Anchor Text Cleaner: raw page HTML fetch.
  getHtml: 'https://abrhhnjp4m.execute-api.ap-southeast-1.amazonaws.com/getHtml',
  // Performance Marketing Audit: paid-media opportunity analysis.
  performanceMarketing: 'https://4gupr9vio3.execute-api.ap-southeast-1.amazonaws.com',
  // Performance Marketing competitor ad intelligence — Google paid keywords
  // (default action) + Meta Ad Library via Apify (`action:'meta_ads'`).
  competitorAds: 'https://dxjou20zg2.execute-api.ap-southeast-1.amazonaws.com',
  // Google integrations — reuse the agency's proven Lambdas (same as index.html):
  //   gscIntegration → ga4ListProperties / ga4RunReport / adsListCustomers / adsSearchStream (GAQL)
  //   googleAuth     → google_token_exchange / google_refresh_token (holds secret)
  gscIntegration: 'https://v5gyq2sqdd.execute-api.ap-southeast-1.amazonaws.com/gscIntegration',
  // DEPRECATED: this standalone endpoint 403s for server-side calls. Ads GAQL now
  // runs as the user via gscIntegration→adsSearchStream (see lib/google.mjs adsGaql).
  googleAds: 'https://j4aca9hcmh.execute-api.ap-southeast-1.amazonaws.com/googleAds',
  googleAuth: 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday',
  // LinkedIn Ads — reuse the agency monday Lambda's linkedin_get_ad_accounts /
  // linkedin_get_analytics actions (same endpoint as googleAuth/strategyEngine).
  // LinkedIn blocks browser CORS + uses fiddly Rest.li encoding, so the agency
  // already proxies it server-side; we feed it the OAuth token we obtained.
  // See lib/linkedin.mjs.
  mondayBridge: 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday',
  aiMentions: 'https://y0ypcivaz1.execute-api.ap-southeast-1.amazonaws.com/aiMentions',
  // Domain → ranking-keyword map, used to seed AI-visibility discovery prompts.
  keywordsForSite: 'https://ei6xj9x2rd.execute-api.ap-southeast-1.amazonaws.com/keywordsForSite',
  geoOnPageAnalysis: 'https://fhan3l5vta.execute-api.ap-southeast-1.amazonaws.com/geoOnPageAnalysis',
  // SEO Diagnostics — live SERP landscape lane (who ranks above you per keyword).
  // Also the first stage of the Content Optimiser's competitor research.
  moreSerps: 'https://2wv8kyc8dg.execute-api.ap-southeast-1.amazonaws.com/moreSerps',
  // Content Optimiser competitor research: per-competitor topic + word-count
  // extraction, then an LLM pass that picks which topics our draft must cover.
  // index.html drives these interactively (the competitor grid); here they run
  // headless before the draft so `selectedTopics` / `targetWordCount` arrive
  // populated instead of empty. See cwResearch().
  gptTopicsPerUrl: 'https://u24f9208q0.execute-api.ap-southeast-1.amazonaws.com/gptTopicsPerUrl',
  aiTopicPicker: 'https://mv0yv43k5d.execute-api.ap-southeast-1.amazonaws.com/aiTopicPicker',
  // Optimise-mode only: compares the user's OWN page against the ranking ones.
  // Slow (~30s per competitor) — see cwDeepCompare's time gate.
  deepContentCompare: 'https://8bbhravqn2.execute-api.ap-southeast-1.amazonaws.com/deepContentCompare',
  // GEO+SEO Forensic Audit — the same probes index.html's autoFillForensicAudit() fires.
  // Site data: title/desc/h1-h2/schema/spam/backlinks/refdomains/domain_rank —
  // ALL of it DataForSEO. Third-party SEO suites (whose terms forbid reselling or
  // repackaging their metrics) were removed on 2026-07-20; authority is now the
  // Digimetrics Authority Score derived from DataForSEO's domain rank. Do not
  // reintroduce a suite proxy here.
  forensicSiteData: 'https://9px7sjbyyb.execute-api.ap-southeast-1.amazonaws.com/new',
  pageSpeed: 'https://7vkudwlzhh.execute-api.ap-southeast-1.amazonaws.com/webpageAudit',
  sslCheck: 'https://2kxt49bwp1.execute-api.ap-southeast-1.amazonaws.com/checkSsl',
  gtmetrix: 'https://y5830908vh.execute-api.ap-southeast-1.amazonaws.com/gtmetrix',
  copyscape: 'https://tg6m9b7gsj.execute-api.ap-southeast-1.amazonaws.com/plagarismCheck',
  personaGenerator: 'https://tyqj3fni7h.execute-api.ap-southeast-1.amazonaws.com/personaGenerator',
  mediaPlanGenerator: 'https://h8ih2vc2xi.execute-api.ap-southeast-1.amazonaws.com/mediaPlanGenerator',
  // Media Plan: marketing-funnel stages (Awareness → Retention) generator.
  generateFunnel: 'https://dpjtg2sr30.execute-api.ap-southeast-1.amazonaws.com/generateFunnel',
  auditLandingPage: 'https://llufeecqoe.execute-api.ap-southeast-1.amazonaws.com/auditLandingPage',
  auditLandingPageDirect: 'https://7eehmzk9e0.execute-api.ap-southeast-1.amazonaws.com/auditLandingPageDirectWeb',
  generateSemGoogle: 'https://bztsly2z89.execute-api.ap-southeast-1.amazonaws.com/generateSemGoogle',
  // Strategy Engine uses the `strategy_generate` action on this shared lambda
  // (SEO strategy generation — not monday-board management).
  strategyEngine: 'https://1rxrp7gth2.execute-api.ap-southeast-1.amazonaws.com/monday',
  // Social Media Audit (flagship) — live multi-platform profile scrape (Apify +
  // DataForSEO). Async: the gateway proxies the lambda's own action protocol
  //   suggest_context / discover / discover_competitors / start → poll
  // (the React page drives the start→poll loop, same as index.html).
  socialMediaAudit: 'https://vceg7jm8w0.execute-api.ap-southeast-1.amazonaws.com/socialMediaAudit',
  // Phase 2 of the Social Media Audit — the content-gap & competitor STRATEGY
  // analysis (Starter/Pro). Reuses the agency lambda via task:'social_audit'.
  socialMediaStrategy: 'https://8domnt5y2f.execute-api.ap-southeast-1.amazonaws.com/socialMediaStrategy',
};
