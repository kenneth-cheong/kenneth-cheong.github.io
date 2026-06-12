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

// ── Free-form AI text factory (aiOptimiser, action 'content_freeform') ───────
// upstream in:  { action:'content_freeform', userPrompt }
// upstream out: { statusCode, body:'{"result":"<text>"}' }  (gateway unwraps the
// statusCode/body envelope before this runs, so `raw` is the inner object).
function claude(buildMessage) {
  return {
    request: (body) => ({
      action: 'content_freeform',
      // Steer the server's long-form SEO framing toward the exact task.
      userPrompt: `Follow this instruction exactly and output only what it asks, no preamble or meta-commentary.\n\n${buildMessage((body.input || '').trim(), body)}`,
    }),
    response: (raw) => ({ text: raw.result || raw.response || raw.text || (typeof raw === 'string' ? raw : '') }),
  };
}

const PROMPTS = {
  caption: (t, body) =>
    `Write 3 scroll-stopping ${body?.platform || 'Instagram'} captions about: "${t}".\n` +
    `Tone: ${body?.tone || 'Friendly'}. Vary the angle (hook-led, value-led, story-led). ` +
    `Keep each under 60 words, add tasteful emojis and 3–5 relevant hashtags. Number 1–3, no preamble.`,
  'llms-txt': (t) =>
    `Generate a complete llms.txt file for the website/brand: "${t}". Follow the llms.txt spec ` +
    `(# title, > summary blockquote, then sectioned markdown links). Output only the file contents.`,
  pillars: (t) =>
    `Create a content pillar framework for: "${t}". Give 3–4 pillars, each with 4–5 subtopics ` +
    `and a content angle. Format as markdown.`,
  'content-writer': (t) =>
    `Write a focused, SEO-friendly web copy draft for: "${t}". Clear headings, a short intro, ` +
    `2–3 scannable sections and a brief conclusion. Aim for ~450 words so it returns promptly.`,
};

export const ADAPTERS = {
  // Prompt tools (Claude bridge)
  ...Object.fromEntries(Object.entries(PROMPTS).map(([id, fn]) => [id, claude(fn)])),

  // ── Keyword Analysis → mangoolsKeywords ─────────────────────────────────
  'keyword-analysis': {
    request(body) {
      return { keywords: parseList(body.input).slice(0, 25), location: body.location || 'SG', language: body.language || 'en' };
    },
    response(raw) {
      const map = unwrap(raw);
      const rows = Object.entries(map).map(([keyword, m]) => ({
        keyword,
        volume: m.search_volume ?? m.volume ?? 0,
        difficulty: m.difficulty ?? m.competition ?? 0,
        cpc: m.cpc != null ? `S$${Number(m.cpc).toFixed(2)}` : '—',
      }));
      rows.sort((a, b) => b.volume - a.volume);
      return { rows };
    },
  },

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
    request: (body) => ({ data: (body.input || '').trim(), manual: '', existing_personas: [] }),
    response: (raw) => ({ html: htmlOf(raw) }),
  },

  // ── Landing Page Audit → auditLandingPageDirect (returns HTML report) ───
  'landing-audit': {
    request: (body) => ({ url: (body.input || '').trim(), keyword: null, use_ai: true }),
    response: (raw) => ({ html: htmlOf(raw) }),
  },

  // ── SEM Ad Copy → generateSemGoogle ─────────────────────────────────────
  // out: { body: { headlines: [...], descriptions: [...], sitelinks: [...] } }
  'sem-copy': {
    request: (body) => ({ country: 'SG', input: (body.input || '').trim(), tone: (body.tone || 'professional').toLowerCase(), language: 'english', type: 'search' }),
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
      language: 'en',
      location: body.location || 'SG',
    }),
    response(raw) {
      const pos = typeof raw === 'number' ? raw : (raw?.position ?? raw?.rank ?? unwrap(raw)?.position);
      return { text: pos && pos > 0 ? `📍 Current position: #${pos}` : 'Not ranking in the top 100 for this keyword/target.' };
    },
  },

  // ── Competitors → serpCompetitors (expects keywords[] + location) ───────
  // Request only; response shaping falls through to the gateway's normalize().
  competitors: {
    request: (body) => ({ keywords: parseList(body.input), location: body.location || 'SG' }),
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
        marketContext: '',
        seedKeywords: (body.seedKeywords || '').trim(),
        keywordInfluencers: '',
        domain: (body.domain || body.url || '').trim(),
        location: body.location || 'SG',
        language: 'English',
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

  // ── Backlinks → ahrefsProxy (endpoint-routed) ───────────────────────────
  backlinks: {
    request: (body) => ({ endpoint: 'overview', params: { target: (body.input || '').trim() } }),
    response(raw) {
      const d = raw?.domain || raw || {};
      return {
        rows: [
          { metric: 'Domain Rating', value: d.domain_rating ?? d.dr ?? '—' },
          { metric: 'Referring Domains', value: fmt(d.referring_domains) },
          { metric: 'Backlinks', value: fmt(d.backlinks ?? d.total_backlinks) },
          { metric: 'Organic Traffic', value: fmt(d.traffic ?? d.organic_traffic) },
          { metric: 'Organic Keywords', value: fmt(d.organic_keywords ?? d.keywords) },
        ],
      };
    },
  },

  // ── Media Plan → mediaPlanGenerator (returns an HTML plan) ──────────────
  'media-plan': {
    request: (body) => ({ data: (body.input || '').trim(), brief: (body.input || '').trim() }),
    response: (raw) => ({ html: typeof raw === 'string' ? raw : (raw?.html || raw?.body || JSON.stringify(raw)) }),
  },
};

// ── helpers ──────────────────────────────────────────────────────────────
function parseList(s) {
  return String(s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

/** Unwrap a `body` that may be a JSON string or an object. */
function unwrap(raw) {
  let b = raw?.body ?? raw;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch { return {}; }
  }
  return b || {};
}

function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString();
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
