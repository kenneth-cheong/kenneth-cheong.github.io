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
  rankChecker: 'https://v5bizygr4m.execute-api.ap-southeast-1.amazonaws.com/rankChecker',
  dataforseoCrawler: 'https://ak9qsl9wgi.execute-api.ap-southeast-1.amazonaws.com/dataforseoCrawler',
  onPageContentRecommendations: 'https://pkkz2e02ch.execute-api.ap-southeast-1.amazonaws.com/onPageContentRecommendations',
  serpCompetitors: 'https://itzj193chl.execute-api.ap-southeast-1.amazonaws.com/serpCompetitors',
  ahrefsProxy: 'https://b8cyd5ed90.execute-api.ap-southeast-1.amazonaws.com/new',
  checkContent: 'https://mmyvj7yj11.execute-api.ap-southeast-1.amazonaws.com/checkContent',
  aiMentions: 'https://y0ypcivaz1.execute-api.ap-southeast-1.amazonaws.com/aiMentions',
  geoOnPageAnalysis: 'https://fhan3l5vta.execute-api.ap-southeast-1.amazonaws.com/geoOnPageAnalysis',
  personaGenerator: 'https://tyqj3fni7h.execute-api.ap-southeast-1.amazonaws.com/personaGenerator',
  mediaPlanGenerator: 'https://h8ih2vc2xi.execute-api.ap-southeast-1.amazonaws.com/mediaPlanGenerator',
  auditLandingPage: 'https://llufeecqoe.execute-api.ap-southeast-1.amazonaws.com/auditLandingPage',
  auditLandingPageDirect: 'https://7eehmzk9e0.execute-api.ap-southeast-1.amazonaws.com/auditLandingPageDirectWeb',
  generateSemGoogle: 'https://bztsly2z89.execute-api.ap-southeast-1.amazonaws.com/generateSemGoogle',
};
