// ── Share Card generator (shared) ────────────────────────────────────────────
// Pure, environment-agnostic: distils a tool result into a card summary and
// renders it as an SVG string. NO browser or Node APIs here, so the SAME code
// runs in the frontend (rasterised via <canvas>, Layer 1) and in the ShareFn
// Lambda (rasterised via resvg-wasm with an embedded font, Layer 2) — the card
// is therefore pixel-identical wherever it's produced.
//
// Browser-only helpers (canvas rasterise, clipboard, native share) live in
// frontend/src/lib/shareCard.js, which re-exports everything below.

import { MONTY_DATA_URI } from './montyAvatar.mjs';

export const CTA_HOST = 'platform.digimetrics.ai';
export const CTA_URL = `https://${CTA_HOST}/?ref=share`;
// The app typeface first; the rest are fallbacks for the browser canvas path
// (which can't see the webfont). resvg embeds the real "Plus Jakarta Sans".
const FONT = "'Plus Jakarta Sans','Inter','Segoe UI',system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif";

export const FORMATS = {
  square:   { id: 'square',   label: 'Square · 1080²',       w: 1080, h: 1080 },
  portrait: { id: 'portrait', label: 'Portrait · 4:5',       w: 1080, h: 1350 },
  wide:     { id: 'wide',     label: 'Link card · 1200×630', w: 1200, h: 630 },
};

// The DigiMetrics lockup, reproduced from the in-app header (Layout.jsx): a
// rounded `brand-600` square with a white "D", then the "Digimetrics" wordmark.
// `onDark` flips it for the blue header band (white square, blue "D").
function brandLockup(x, yMid, { onDark = false, scale = 1 } = {}) {
  const sq = 56 * scale, gap = 16 * scale, rx = 12 * scale;
  const wordSize = 40 * scale, dSize = 36 * scale;
  const sqFill = onDark ? '#ffffff' : '#2563eb';
  const dFill = onDark ? '#2563eb' : '#ffffff';
  const wordFill = onDark ? '#ffffff' : '#1d4ed8';
  return `
    <rect x="${x}" y="${yMid - sq / 2}" width="${sq}" height="${sq}" rx="${rx}" fill="${sqFill}"/>
    <text x="${x + sq / 2}" y="${yMid + dSize * 0.36}" text-anchor="middle" font-family="${FONT}" font-size="${dSize}" font-weight="800" fill="${dFill}">D</text>
    <text x="${x + sq + gap}" y="${yMid + wordSize * 0.34}" font-family="${FONT}" font-size="${wordSize}" font-weight="800" letter-spacing="-0.5" fill="${wordFill}">Digimetrics</text>`;
}
// Approximate rendered width of the lockup, for centering.
const lockupWidth = (scale = 1) => (56 + 16 + 'Digimetrics'.length * 40 * 0.56) * scale;

// Should this result offer a Share button at all? Guards against sharing a
// failed/teaser run or a soft-error result (e.g. "Could not fetch <url>") as a
// celebratory card. Numeric/tabular results are always shareable; a text-only
// result is rejected when it reads like an error or is empty.
const ERROR_RE = /(could ?n'?t|could not|cannot|can'?t|unable to|failed to|fail(ed|ure)|no data|not found|try again|went wrong|invalid|timed out|too many requests)/i;
export function isShareable(out) {
  if (!out || out.error || out.failed) return false;
  const r = out.result || {};
  const sections = Array.isArray(r.sections) ? r.sections : [];
  const hasStats = sections.some((s) => s.type === 'stats' && Array.isArray(s.items) && s.items.length);
  const hasRows = Array.isArray(r.rows) && r.rows.length;
  if (hasStats || hasRows) return true;
  const txt = `${sections.map((s) => s.text || s.title || '').join(' ')} ${r.text || ''}`.trim();
  if (!txt) return false;
  return !ERROR_RE.test(txt);
}

// ── Summary extraction ───────────────────────────────────────────────────────
// Distil a (possibly huge) result into the few fields a card can show: one hero
// stat + up to three supporting numbers, plus a headline. Every tool yields
// *something*, so the button is never a dead end.

const pctNum = (v) => {
  const m = String(v ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};

// Pull stat-like items from the structured `sections` result format.
function statsFromSections(sections = []) {
  const out = [];
  for (const s of sections) {
    if (s.type === 'stats' && Array.isArray(s.items)) {
      for (const it of s.items) {
        if (it && it.label && it.value != null && String(it.value).trim()) {
          out.push({ label: String(it.label), value: String(it.value), delta: it.delta || null, tone: it.tone || null });
        }
      }
    }
  }
  return out;
}

function firstText(sections = [], types) {
  const hit = sections.find((s) => types.includes(s.type) && (s.text || s.title));
  return hit ? String(hit.text || hit.title) : null;
}

/**
 * @param {object} [opts] - { redact } strips the client domain/identifier for
 *        public share cards (opt-in + auto-redact privacy model).
 * @returns {{headline, sub, stat, statLabel, supports:Array<{label,value}>, caption, brand, tone, pct, kind}}
 */
export function buildShareSummary(tool, out, project, user, opts = {}) {
  const r = (out && out.result) || {};
  const sections = Array.isArray(r.sections) ? r.sections : [];
  // Redacted cards drop the client's domain AND project/brand name — both can
  // identify the client. Metric labels/values stay (generic, non-identifying).
  const domain = opts.redact ? '' : (project?.domain || '');
  const brand = opts.redact ? 'Digimetrics' : (project?.name || (user?.email ? user.email.split('@')[0] : 'Digimetrics'));

  const stats = statsFromSections(sections);
  let stat = null, statLabel = null, supports = [], tone = null, kind = 'value';

  if (stats.length) {
    // Prefer a percentage/score as the hero — it reads best as a big number.
    const heroIdx = (() => {
      const p = stats.findIndex((s) => pctNum(s.value) != null && /%|score|readiness|visibility|health|share/i.test(`${s.label} ${s.value}`));
      return p >= 0 ? p : 0;
    })();
    const hero = stats[heroIdx];
    stat = hero.value;
    statLabel = hero.label;
    tone = hero.tone;
    kind = 'value';
    supports = stats.filter((_, i) => i !== heroIdx).slice(0, 3).map((s) => ({ label: s.label, value: s.value }));
  } else if (Array.isArray(r.rows) && r.rows.length) {
    stat = r.rows.length.toLocaleString();
    statLabel = `${tool.name} results`;
    kind = 'value';
  } else {
    // Content tools etc. — fall back to a qualitative headline.
    const t = firstText(sections, ['heading', 'callout']) || (r.text ? r.text.split('\n').find((l) => l.trim()) : '') || 'Report ready';
    stat = '✓';
    statLabel = t.slice(0, 90);
    kind = 'done';
  }

  // A 0–100 percentage hero → render as an on-brand gauge ring.
  const p = stat && String(stat).includes('%') ? pctNum(stat) : null;
  const pct = p != null && p >= 0 && p <= 100 ? Math.round(p) : null;

  const headline = tool.name;
  const sub = opts.redact ? '' : (domain || brand);
  const caption = buildCaption({ tool, stat, statLabel, domain });
  return { headline, sub, stat, statLabel, supports, caption, brand, tone, pct, kind };
}

function buildCaption({ tool, stat, statLabel, domain }) {
  const subject = domain ? ` for ${domain}` : '';
  const headlineStat = stat && stat !== '✓' ? `${statLabel}: ${stat}. ` : '';
  return `${tool.name}${subject} — ${headlineStat}Run yours free at ${CTA_HOST} 👇\n\n#SEO #GEO #AISearch #DigitalMarketing #DigiMetrics`;
}

// ── SVG card rendering ───────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Greedy word-wrap with a char-width estimate (good enough without measuring DOM).
function wrap(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
    if (lines.length === maxLines - 1 && (cur.length > maxChars)) break;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{1}$/, '…'); }
  return lines;
}

// tone → hero accent colour. Unknown/neutral falls back to brand blue so the
// card is always on-brand even when the result carries no tone.
const ACCENT = { green: '#059669', amber: '#d97706', red: '#dc2626', orange: '#ea580c', blue: '#2563eb', slate: '#2563eb' };
const accentOf = (tone) => ACCENT[tone] || ACCENT.blue;
const accentTintOf = (tone) => ({ green: '#ecfdf5', amber: '#fffbeb', red: '#fef2f2', orange: '#fff7ed' }[tone] || '#eff6ff');

// A circular gauge ring (matches the in-app StatCard Gauge) with the % in the
// centre. `a` = accent colour, c = centre, r = radius.
function gauge(cxp, cyp, r, pct, a) {
  const C = 2 * Math.PI * r;
  const off = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return `
    <circle cx="${cxp}" cy="${cyp}" r="${r}" fill="none" stroke="#eef2f7" stroke-width="26"/>
    <circle cx="${cxp}" cy="${cyp}" r="${r}" fill="none" stroke="${a}" stroke-width="26" stroke-linecap="round"
      stroke-dasharray="${C}" stroke-dashoffset="${off}" transform="rotate(-90 ${cxp} ${cyp})"/>
    <text x="${cxp}" y="${cyp + 33}" text-anchor="middle" font-family="${FONT}" font-size="92" font-weight="900" letter-spacing="-3" fill="${a}">${pct}%</text>`;
}

// Monty the Border Collie as a circular avatar — a 1:1 reproduction of the in-app
// mascot (Mascot.jsx): the same head-zoomed crop of the artwork PLUS the blue
// support-headset overlay. The mascot is authored in a 48² box (circle r=24), so
// we scale it into place with s = r/24 and reuse its exact coordinates. `ring` =
// outer ring colour; `rw` = its width. clipPath id is unique per (cx,cy).
function montyAvatar(cx, cy, r, { ring = '#ffffff', rw = 6, halo = null } = {}) {
  const id = `monty${Math.round(cx)}x${Math.round(cy)}`;
  const s = r / 24;
  return `
    ${halo ? `<circle cx="${cx}" cy="${cy}" r="${r + rw + 6}" fill="none" stroke="${halo}" stroke-width="3" stroke-opacity="0.35"/>` : ''}
    <clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/>
    <g clip-path="url(#${id})">
      <g transform="translate(${cx} ${cy}) scale(${s}) translate(-24 -24)">
        <image href="${MONTY_DATA_URI}" x="-12.52" y="-11.48" width="73.04" height="73.04"/>
        <path d="M8.4 20 Q24 -1 39.6 20" stroke="#2563eb" stroke-width="2.6" fill="none" stroke-linecap="round"/>
        <ellipse cx="8.4" cy="20.5" rx="2.7" ry="4" fill="#2563eb" stroke="#173a8a" stroke-width="0.5"/>
        <ellipse cx="39.6" cy="20.5" rx="2.7" ry="4" fill="#2563eb" stroke="#173a8a" stroke-width="0.5"/>
        <path d="M8.4 24 Q5.5 31 16 32.2" stroke="#2563eb" stroke-width="1.8" fill="none" stroke-linecap="round"/>
        <circle cx="16.3" cy="32.2" r="1.5" fill="#2563eb"/>
      </g>
    </g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring}" stroke-width="${rw}"/>`;
}

export function renderCardSvg(summary, format = 'square') {
  const f = FORMATS[format] || FORMATS.square;
  const { w, h } = f;
  const wide = format === 'wide';
  const pad = wide ? 64 : 80;
  const cx = w / 2;
  const a = accentOf(summary.tone);
  const headerH = wide ? 0 : 156;

  // Monty's circular avatar: a friendly mascot in the header (square/portrait)
  // or a large face on the right (wide). Wide reserves the right side for him,
  // so the text column stops short of it.
  const montyR = wide ? 148 : 52;
  const montyCx = wide ? w - pad - montyR - 4 : w - pad - montyR;
  const montyCy = wide ? h / 2 - 2 : 80;
  const colR = wide ? montyCx - montyR - 44 : w - pad; // right edge of the text column

  // ── Header: brand lockup + tagline, Monty avatar ──
  const header = wide
    ? `${brandLockup(pad, 62, { onDark: false, scale: 0.82 })}
       <text x="${pad}" y="108" font-family="${FONT}" font-size="18" font-weight="700" letter-spacing="3" fill="${a}">SEO · GEO · AI VISIBILITY</text>`
    : `<rect width="${w}" height="${headerH}" fill="url(#brandBand)"/>
       ${brandLockup(pad, 66, { onDark: true, scale: 0.82 })}
       <text x="${pad}" y="124" font-family="${FONT}" font-size="17" font-weight="700" letter-spacing="3" fill="#bfdbfe">SEO · GEO · AI VISIBILITY</text>
       ${montyAvatar(montyCx, montyCy, montyR, { ring: '#ffffff', rw: 6 })}`;

  // ── Title + domain pill ──
  const anchor = wide ? 'start' : 'middle';
  const titleX = wide ? pad : cx;
  const titleY = wide ? 172 : headerH + 98;
  const pillText = summary.sub || '';
  const pillW = Math.min((wide ? colR : w) - pad * 2, pillText.length * 15 + 52);
  // Redacted public cards have no domain → no pill (just title + hero).
  const pill = pillText ? `
    <g transform="translate(${wide ? pad : cx - pillW / 2},${titleY + 28})">
      <rect width="${pillW}" height="46" rx="23" fill="#eef2f8"/>
      <circle cx="27" cy="23" r="6" fill="${a}"/>
      <text x="${pillW / 2 + 13}" y="31" text-anchor="middle" font-family="${FONT}" font-size="23" font-weight="600" fill="#475569">${esc(pillText)}</text>
    </g>` : '';
  const titleBlock = `
    <text x="${titleX}" y="${titleY}" text-anchor="${anchor}" font-family="${FONT}" font-size="54" font-weight="800" letter-spacing="-1" fill="#0f172a">${esc(summary.headline)}</text>
    ${pill}`;

  // ── Hero — gauge for %, big number for a value, check badge for "done" ──
  const heroX = wide ? pad : cx;
  const heroCy = wide ? Math.round(h / 2 + 40) : Math.round((titleY + 70 + (h - 250)) / 2);
  const labelLines = wrap(summary.statLabel || '', wide ? 22 : 26, summary.kind === 'done' ? 3 : 2);
  let hero = '';
  if (summary.pct != null && !wide) {
    // Label sits clear below the ring's outer edge (heroCy-10 + 128 + 13 half-stroke).
    hero = `
      ${gauge(cx, heroCy - 10, 128, summary.pct, a)}
      ${labelLines.map((ln, i) => `<text x="${cx}" y="${heroCy + 174 + i * 36}" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="600" fill="#475569">${esc(ln)}</text>`).join('')}`;
  } else if (summary.kind === 'done') {
    const bcy = heroCy - 30;
    hero = `
      <circle cx="${heroX + (wide ? 60 : 0)}" cy="${bcy}" r="62" fill="${accentTintOf(summary.tone)}"/>
      <path d="M ${heroX + (wide ? 60 : 0) - 29} ${bcy} l 19 21 l 39 -43" fill="none" stroke="${a}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      ${labelLines.map((ln, i) => `<text x="${heroX}" y="${bcy + 108 + i * 40}" text-anchor="${anchor}" font-family="${FONT}" font-size="34" font-weight="700" fill="#1e293b">${esc(ln)}</text>`).join('')}`;
  } else {
    const big = String(summary.stat || '').length <= 6;
    const fs = big ? (wide ? 138 : 220) : (wide ? 62 : 92);
    const uY = heroCy + (big ? 44 : 24);
    hero = `
      <text x="${heroX}" y="${heroCy + (big ? 30 : 10)}" text-anchor="${anchor}" font-family="${FONT}" font-size="${fs}" font-weight="900" letter-spacing="-4" fill="${a}">${esc(summary.stat)}</text>
      <rect x="${wide ? pad + 2 : cx - 42}" y="${uY}" width="84" height="8" rx="4" fill="${a}" fill-opacity="0.22"/>
      ${labelLines.map((ln, i) => `<text x="${heroX}" y="${uY + 54 + i * 38}" text-anchor="${anchor}" font-family="${FONT}" font-size="30" font-weight="600" fill="#475569">${esc(ln)}</text>`).join('')}`;
  }

  // ── Support chips (square/portrait only) ──
  const sup = wide ? [] : (summary.supports || []).slice(0, 3);
  const supportChips = sup.map((s, i) => {
    const chipW = (w - pad * 2 - (sup.length - 1) * 18) / sup.length;
    const x = pad + i * (chipW + 18);
    const y = h - 268;
    return `
      <g transform="translate(${x},${y})">
        <rect width="${chipW}" height="112" rx="20" fill="#f8fafc" stroke="#eef2f7"/>
        <rect width="6" height="112" rx="3" fill="${a}"/>
        <text x="${chipW / 2 + 3}" y="50" text-anchor="middle" font-family="${FONT}" font-size="36" font-weight="800" fill="#0f172a">${esc(String(s.value).slice(0, 12))}</text>
        <text x="${chipW / 2 + 3}" y="84" text-anchor="middle" font-family="${FONT}" font-size="18" font-weight="600" fill="#64748b">${esc(String(s.label).slice(0, 24))}</text>
      </g>`;
  }).join('');

  // ── CTA pill. The arrow is a drawn path (not a "→" glyph) so it renders
  // identically on the browser canvas and resvg's subset font — and we lay out
  // [label][arrow][host] as a measured group so it centres precisely. ──
  const cf = 26;
  const cw = (s) => s.length * cf * 0.55; // rough advance width
  const label = 'Run your free audit', host = CTA_HOST;
  const gap = 16, arrowW = 30;
  const groupW = cw(label) + gap + arrowW + gap + cw(host);
  const ctaW = Math.max(wide ? 520 : 600, groupW + 72);
  const ctaY = h - (wide ? 64 : 84);
  const gx = (ctaW - groupW) / 2;          // group start within the pill
  const ax = gx + cw(label) + gap;         // arrow start
  const cta = `
    <g transform="translate(${wide ? pad : cx - ctaW / 2},${ctaY - 34})">
      <rect width="${ctaW}" height="68" rx="34" fill="url(#brandBand)"/>
      <text x="${gx}" y="44" text-anchor="start" font-family="${FONT}" font-size="${cf}" font-weight="700" fill="#ffffff">${esc(label)}</text>
      <path d="M ${ax} 35 h ${arrowW - 6} m -12 -9 l 12 9 l -12 9" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="${ax + arrowW + gap}" y="44" text-anchor="start" font-family="${FONT}" font-size="${cf}" font-weight="700" fill="#ffffff">${esc(host)}</text>
    </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="brandBand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#1e40af"/>
    </linearGradient>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f4f7fc"/>
    </linearGradient>
    <radialGradient id="blob" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${a}" stop-opacity="0.13"/><stop offset="1" stop-color="${a}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="dots" width="34" height="34" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.8" fill="#0f172a" fill-opacity="0.022"/>
    </pattern>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect x="0" y="${headerH}" width="${w}" height="${h - headerH}" fill="url(#dots)"/>
  ${wide
    ? `<circle cx="${montyCx}" cy="${montyCy}" r="250" fill="url(#blob)"/>`
    : `<circle cx="${w - 40}" cy="${h - 96}" r="320" fill="url(#blob)"/><circle cx="40" cy="${h - 40}" r="180" fill="url(#blob)"/>`}
  <rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="none" stroke="#e2e8f0" stroke-width="2"/>
  ${header}
  ${titleBlock}
  ${hero}
  ${supportChips}
  ${wide ? montyAvatar(montyCx, montyCy, montyR, { ring: '#ffffff', rw: 7, halo: a }) : ''}
  ${cta}
</svg>`;
}

export function svgToDataUrl(svg) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Web-intent composers. When a public `shareUrl` is given (opt-in link), the
// platforms unfurl it into the branded card; otherwise they post the caption +
// the generic CTA link and the user attaches the downloaded PNG.
export function socialIntents(summary, shareUrl) {
  const url = shareUrl || CTA_URL;
  const text = shareUrl ? `${summary.caption}\n\n${shareUrl}` : summary.caption;
  const enc = encodeURIComponent;
  return {
    x: `https://twitter.com/intent/tweet?text=${enc(text)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&quote=${enc(summary.caption)}`,
    whatsapp: `https://wa.me/?text=${enc(text)}`,
  };
}
