// Per-tool request/response adapters.
//
// The frontend sends a GENERIC input (`{ input, url }`). Each existing upstream
// Lambda expects its OWN payload shape and returns its OWN response shape. An
// adapter maps generic-in → upstream-in, and upstream-out → generic-out:
//   { rows: [...] }  — table tools
//   { text: '...' }  — AI text tools
//   { html: '...' }  — tools whose upstream returns ready HTML
// which is exactly what the React result view + free-tier capping render.
//
// Tools without an adapter fall through to a raw pass-through.

export const ADAPTERS = {
  // ── Caption Generator → aiOptimiser action 'luxury_copy' ────────────────
  // Mirrors the agency's _luxuryFields + buildLuxuryCopyPrompt() exactly.
  caption: {
    request(body) {
      const list = (v) => parseList(v);
      const fields = {
        brandName: (body.brand || '').trim(),
        postRole: (body.postRole || '').trim(),
        strategyFit: (body.strategyFit || '').trim(),
        coreMessage: (body.coreMessage || '').trim(),
        subgroups: list(body.subgroups),
        painpoints: list(body.painpoints),
        audienceGoal: list(body.audienceGoal),
        productService: (body.productService || '').trim(),
        postInfo: (body.input || '').trim(),
        desiredAction: (body.desiredAction || '').trim(),
        usp: (body.usp || '').trim(),
        constraints: (body.constraints || '').trim(),
        pov: (body.pov || '').trim(),
        tone: body.tone ? [String(body.tone).trim()] : [],
        language: (body.language || 'English').trim(),
        wordCount: (body.wordCount || '').trim(),
        emojis: (body.emojis || 'Yes').toLowerCase(),
        hashtags: (body.hashtags || 'Yes').toLowerCase(),
        specificInstructions: (body.specificInstructions || '').trim(),
      };
      const labels = { Instagram: 'Instagram caption', Facebook: 'Facebook post', LinkedIn: 'LinkedIn post' };
      const contentTypeLabel = labels[body.platform] || body.platform || 'Instagram caption';
      return {
        action: 'luxury_copy',
        contentTypeLabel,
        fields,
        prompt: buildLuxuryPrompt(contentTypeLabel, fields),
        previousCaptions: [],
        sampleText: '',
        brandGuideText: '',
        webpageText: '',
        variationIndex: 0,
        settings: { temperature: 0.75 },
      };
    },
    response: (raw) => ({ text: pickText(raw) }),
  },

  // AI Content Optimiser (content-writer) is a multi-agent composite handled in
  // the gateway (contentOptimiserRun) — no single-call adapter here.

  // ── Content Pillar Framework → contentPillar action 'pillar_framework' ──
  pillars: {
    request: (body) => ({
      type: 'pillar_framework',
      business_model: (body.businessModel || '').trim(),
      objectives: body.objectives ? [String(body.objectives).trim()] : [],
      audience_type: (body.audienceType || '').trim(),
      decision_complexity: (body.complexity || '').trim(),
      platforms: body.platforms ? [String(body.platforms).trim()] : [],
      risk_sensitivity: (body.sensitivity || '').trim(),
      promotional_tolerance: (body.promoTolerance || '').trim(),
      reference_urls: {
        website: (body.website || '').trim(),
        brandGuide: (body.brandGuide || '').trim(),
        competitors: (body.competitors || '').trim(),
      },
      additional_info: (body.input || '').trim(),
    }),
    response(raw) {
      const d = unwrap(raw);
      let answer = d.answer ?? d.result ?? (typeof d === 'string' ? d : '');
      if (answer && typeof answer === 'object') {
        answer = Array.isArray(answer) ? answer.map((b) => b?.text || '').join('') : (answer.text || '');
      }
      return { text: String(answer || '') };
    },
  },

  // Keyword Analysis is a multi-mode composite (metrics / similar / ranking /
  // from-webpage) handled in the gateway (keywordAnalysisRun) — no adapter here.

  // ── On-Page Optimisation → onPageContentRecommendations ─────────────────
  // out: [ { current_value, suggested_value, rationale } ]
  onpage: {
    request: (body) => ({ url: (body.input || '').trim(), keywords: parseList(body.keywords || '') }),
    response(raw) {
      const arr = Array.isArray(raw) ? raw : unwrap(raw);
      const rows = (Array.isArray(arr) ? arr : []).map((r) => ({
        element: r.element || r.field || '—',
        current: r.current_value ?? '—',
        suggested: r.suggested_value ?? '—',
        why: r.rationale ?? '',
      }));
      return { rows };
    },
  },

  // ── Persona Generator → personaGenerator (returns HTML cards) ───────────
  persona: {
    request: (body) => ({
      data: (body.input || '').trim(),
      manual: (body.manual || '').trim(),
      existing_personas: [],
      num_personas: Number(body.count) > 0 ? Number(body.count) : 10,
    }),
    response: (raw) => ({ html: htmlOf(raw) }),
  },

  // ── Landing Page Audit → auditLandingPageDirect (returns HTML report) ───
  'landing-audit': {
    request: (body) => ({ url: (body.input || '').trim(), keyword: (body.keyword || '').trim() || null, use_ai: true }),
    response: (raw) => ({ html: htmlOf(raw) }),
  },

  // ── SEM Ad Copy → generateSemGoogle ─────────────────────────────────────
  // out: { body: { headlines: [...], descriptions: [...], sitelinks: [...] } }
  'sem-copy': {
    request: (body) => ({
      country: (body.country || 'Singapore').trim(),
      input: (body.input || '').trim(),
      tone: (body.tone || 'professional').toLowerCase(),
      language: (body.language || 'English').trim().toLowerCase(),
      type: SEM_FORMATS[body.format] || 'google-responsive-search-ads',
      model: 'claude-haiku-4-5',
    }),
    response(raw) {
      const groups = unwrap(raw);
      const text = Object.entries(groups)
        .map(([cat, items]) => `## ${cat}\n` + (Array.isArray(items) ? items.map((i) => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n') : ''))
        .join('\n\n');
      return { text: text || 'No ad copy returned.' };
    },
  },

  // ── Rank Checker → rankChecker (returns a numeric position) ─────────────
  'rank-checker': {
    request: (body) => ({
      keyword: (body.input || '').trim(),
      target: (body.target || '').trim(),
      language: body.language || 'English',
      location: body.location || 'Singapore',
    }),
    response(raw) {
      const pos = typeof raw === 'number' ? raw : (raw?.position ?? raw?.rank ?? unwrap(raw)?.position);
      return { text: pos && pos > 0 ? `📍 Current position: #${pos}` : 'Not ranking in the top 100 for this keyword/target.' };
    },
  },

  // ── Competitors → serpCompetitors (expects id, user, keywords[], location, language) ─
  // Request only; response shaping falls through to the gateway's normalize().
  competitors: {
    request: (body) => ({
      id: 'comp_' + Date.now(),
      user: body._email || 'saas-user',
      keywords: parseList(body.input),
      location: body.location || 'Singapore',
      language: body.language || 'English',
    }),
  },

  // ── Strategy Engine → strategy_generate (auto SEO action plan) ──────────
  // in:  { action:'strategy_generate', inputs:{...}, discoveryData:[] }
  // out: { strategies:[{ name, description, recommended, target_keywords[],
  //        focus_area, monthly_volume, difficulty }] }  (or markdown result)
  'strategy-engine': {
    request: (body) => ({
      action: 'strategy_generate',
      inputs: {
        clientProfile: (body.input || '').trim(),
        objectives: body.objective ? [body.objective] : [],
        targetAudience: (body.targetAudience || '').trim(),
        marketContext: (body.marketContext || '').trim(),
        seedKeywords: (body.seedKeywords || '').trim(),
        keywordInfluencers: (body.keywordInfluencers || '').trim(),
        domain: (body.domain || body.url || '').trim(),
        location: body.location || 'Singapore',
        language: body.language || 'English',
      },
      discoveryData: [],
    }),
    response(raw) {
      const data = unwrap(raw);
      // strategies may be inline, or inside a ```json-fenced `result` string.
      let strategies = data.strategies || (Array.isArray(data) ? data : null);
      if (!strategies && typeof data.result === 'string') {
        strategies = parseStrategyJson(data.result)?.strategies;
      }
      if (Array.isArray(strategies) && strategies.length) {
        return {
          rows: strategies.map((s) => ({
            strategy: (s.recommended ? '★ ' : '') + (s.name || '—'),
            focus: s.focus_area || s.focus || '—',
            keywords: Array.isArray(s.target_keywords) ? s.target_keywords.slice(0, 8).join(', ') : '',
          })),
        };
      }
      const text = (typeof data.result === 'string' && data.result) || (typeof data === 'string' ? data : '');
      return { text: text || JSON.stringify(data, null, 2) };
    },
  },

  // Backlinks Explorer is a multi-action composite (summary + referring domains
  // + anchors) handled in the gateway (backlinksRun), so it has no adapter here.

  // ── Media Plan → mediaPlanGenerator (returns an HTML plan) ──────────────
  // Upstream reads its own per-field keys; map the streamlined SaaS form onto
  // the ones that meaningfully shape the plan and let the rest default server-side.
  'media-plan': {
    request: (body) => ({
      webpagesInput: (body.input || '').trim(),
      manualInput: (body.input || '').trim(),
      budget: (body.budget || '').trim(),
      mediaPlanLocation: (body.location || 'Singapore').trim(),
      mediaPlanStartDate: (body.startDate || '').trim(),
      mediaPlanEndDate: (body.endDate || '').trim(),
      organisationalObjectives: (body.objectives || '').trim(),
      adFormats: { googleSearch: true, performanceMax: true, googleDisplay: true, fbIg: true, linkedIn: true, tikTok: true },
    }),
    response: (raw) => ({ html: typeof raw === 'string' ? raw : (raw?.html || raw?.body || JSON.stringify(raw)) }),
  },

  // ── GEO On-Page Optimisation → geoOnPageAnalysis ────────────────────────
  // upstream in: { url, prompts, brand, industry, audience, market }
  'geo-onpage': {
    request: (body) => ({
      url: (body.input || body.url || '').trim(),
      // Agency sends the raw newline-separated string; the Lambda splits it itself.
      prompts: (body.prompts || '').trim(),
      brand: (body.brand || '').trim(),
      industry: (body.industry || '').trim(),
      audience: (body.audience || '').trim(),
      market: (body.market || 'Singapore').trim(),
    }),
    response: (raw) => {
      const b = unwrap(raw);
      if (typeof b === 'string') return { text: b };
      return b.html ? { html: b.html } : { text: JSON.stringify(b, null, 2) };
    },
  },

  // Content Checker (content-check) parses brand-guide PDFs + reference URLs
  // before calling checkContent — handled in the gateway (contentCheckRun).
};

// SEM ad-format friendly label → generateSemGoogle `type` slug.
const SEM_FORMATS = {
  'Google Search': 'google-responsive-search-ads',
  'Google Performance Max': 'google-performance-max-ads',
  'Google Display': 'google-display-ads',
  'Meta Image': 'meta-image-ads',
  'Meta Carousel': 'meta-carousel-ads',
  'LinkedIn Image': 'linkedin-image-ads',
};

// ── helpers ──────────────────────────────────────────────────────────────
function parseList(s) {
  return String(s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

/** Verbatim replica of the agency's buildLuxuryCopyPrompt() (luxury_copy). */
function buildLuxuryPrompt(contentTypeLabel, f) {
  const parts = [];
  parts.push(`Content Type: ${contentTypeLabel}`);
  if (f.brandName) parts.push(`Brand: ${f.brandName}\nIMPORTANT: Always write the brand name exactly as "${f.brandName}" — preserve the exact capitalisation and spelling every time it appears.`);
  if (f.coreMessage) parts.push(`Core Message: ${f.coreMessage}`);
  if (f.postRole) parts.push(`Post Role/Objective: ${f.postRole}`);
  if (f.strategyFit) parts.push(`Strategy Context: ${f.strategyFit}`);
  if (Array.isArray(f.subgroups) && f.subgroups.length) parts.push(`Target Audiences: ${f.subgroups.join(', ')}`);
  if (Array.isArray(f.painpoints) && f.painpoints.length) parts.push(`Audience Pain Points: ${f.painpoints.join(', ')}`);
  if (Array.isArray(f.audienceGoal) && f.audienceGoal.length) parts.push(`Audience Goals: ${f.audienceGoal.join(', ')}`);
  if (f.productService) parts.push(`Product/Service: ${f.productService}`);
  if (f.postInfo) parts.push(`Content/Topic: ${f.postInfo}`);
  if (f.desiredAction) parts.push(`Call-to-Action: ${f.desiredAction}`);
  if (f.usp) parts.push(`Unique Selling Point: ${f.usp}`);
  if (Array.isArray(f.tone) && f.tone.length) parts.push(`Tone of Voice: ${f.tone.join(', ')}`);
  if (f.pov) parts.push(`Brand Point of View: ${f.pov}`);
  if (f.constraints) parts.push(`Constraints/Mandatories: ${f.constraints}`);
  if (f.specificInstructions) parts.push(`Special Instructions: ${f.specificInstructions}`);
  if (f.wordCount) parts.push(`Word Count: ${f.wordCount}`);
  if (f.language) parts.push(`Language: ${f.language}`);
  if (f.emojis === 'yes') parts.push('Include emojis in the content');
  if (f.hashtags === 'yes') parts.push('Include relevant hashtags');
  return parts.join('\n');
}

/** aiOptimiser response → text, matching the agency's result/text/content order. */
function pickText(raw) {
  const d = unwrap(raw);
  if (typeof d === 'string') return d;
  return d.result || d.text || d.content || d.response || '';
}

/** Unwrap a `body` that may be a JSON string or an object. */
function unwrap(raw) {
  let b = raw?.body ?? raw;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return {}; }
  }
  return b || {};
}

/**
 * Robustly pull JSON out of LLM text that may be ```json-fenced, missing its
 * closing fence, or truncated. Tries: whole parse → balanced top-level object
 * → salvage of complete array elements (strategies/recommendations/strengths).
 */
export function parseStrategyJson(s) {
  let str = String(s).replace(/```(?:json)?/gi, '').trim();
  const start = str.indexOf('{');
  if (start >= 0) str = str.slice(start);
  try { return JSON.parse(str); } catch { /* fall through */ }
  const bal = balancedSlice(str, str.indexOf('{'));
  if (bal) { try { return JSON.parse(bal); } catch { /* fall through */ } }
  // Salvage: keep whichever array elements are complete.
  const out = {};
  for (const key of ['strategies', 'recommendations', 'strengths']) {
    const m = str.match(new RegExp('"' + key + '"\\s*:\\s*\\['));
    if (!m) continue;
    let i = str.indexOf('[', m.index) + 1;
    const items = [];
    while (i < str.length) {
      while (i < str.length && /[\s,]/.test(str[i])) i++;
      if (str[i] !== '{') break;
      const el = balancedSlice(str, i);
      if (!el) break;
      try { items.push(JSON.parse(el)); } catch { /* drop incomplete */ }
      i += el.length;
    }
    if (items.length) out[key] = items;
  }
  return Object.keys(out).length ? out : null;
}

/** Return the string-aware balanced {...}/[...] starting at index i, or null. */
function balancedSlice(str, i) {
  if (i < 0) return null;
  const startCh = str[i];
  if (startCh !== '{' && startCh !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < str.length; j++) {
    const c = str[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return str.slice(i, j + 1); }
  }
  return null;
}

/** Some upstreams return HTML in `body` (string). */
function htmlOf(raw) {
  const b = raw?.body ?? raw;
  return typeof b === 'string' ? b : (b?.html || JSON.stringify(b));
}
