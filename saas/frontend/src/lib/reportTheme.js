// Dark-mode normalizer for server-rendered report HTML (tool outputs injected
// via dangerouslySetInnerHTML). Those reports are self-contained LIGHT-themed
// documents with colors baked into inline style="" — white cards, light tints,
// dark text. Every tool uses its own palette, so per-palette CSS is whack-a-mole.
//
// Instead we walk the injected DOM and transform by LUMINANCE: darken light
// backgrounds, lighten dark text, darken light borders. This auto-preserves
// saturated accents (an indigo pill or its white label is already mid/high
// contrast the "right" way, so the guards below leave it alone). Fully
// reversible — the original inline style is stashed in data-dm-orig and
// restored when the theme flips back to light.

function parseColor(str) {
  if (!str) return null;
  str = str.trim().toLowerCase();
  if (str === 'transparent' || str === 'inherit' || str === 'currentcolor') return null;
  if (str[0] === '#') {
    let h = str.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,/]/).map((x) => parseFloat(x));
    if (p.length >= 3 && p.every((v, i) => i > 2 || Number.isFinite(v))) return [p[0], p[1], p[2]];
  }
  return null; // named colors, gradients, etc. → skip
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s, l];
}

function hslStr(h, s, l) {
  h /= 360;
  const hue = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
  }
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

// Light background → dark. Returns null (leave as-is) if it's already dark
// (an accent fill, dark card, etc.).
function darkenBg(rgb) {
  const [h, s, l] = rgbToHsl(...rgb);
  if (l < 0.55) return null;
  if (s < 0.12) return l > 0.92 ? '#0f172a' : '#1e293b';   // near-grey → slate surface
  return hslStr(h, Math.min(s, 0.55), 0.17);               // saturated tint → dark tint of same hue
}

// Dark text → light. Returns null if already light (white label on an accent).
function lightenText(rgb) {
  const [h, s, l] = rgbToHsl(...rgb);
  if (l > 0.6) return null;
  if (s < 0.12) return l < 0.35 ? '#e2e8f0' : '#cbd5e1';   // near-grey → light slate
  return hslStr(h, Math.min(s, 0.75), 0.78);               // saturated dark → light of same hue
}

function darkenBorder(rgb) {
  const [, , l] = rgbToHsl(...rgb);
  return l < 0.5 ? null : '#334155';
}

const BORDER_SIDES = ['borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'];

// Apply (dark=true) or undo (dark=false) the transform across a report root.
export function themeReport(root, dark) {
  if (!root) return;
  const els = root.querySelectorAll('[style]');
  els.forEach((el) => {
    // Stash the pristine inline style once so we can always restore it.
    if (el.dataset.dmOrig == null) el.dataset.dmOrig = el.getAttribute('style') || '';
    // Reset to original first (so re-applying is idempotent and light restores).
    el.setAttribute('style', el.dataset.dmOrig);
    if (!dark) return;
    try {
      const st = el.style;
      const bg = parseColor(st.backgroundColor);
      if (bg) { const v = darkenBg(bg); if (v) st.backgroundColor = v; }
      const col = parseColor(st.color);
      if (col) { const v = lightenText(col); if (v) st.color = v; }
      BORDER_SIDES.forEach((p) => {
        const c = parseColor(st[p]);
        if (c) { const v = darkenBorder(c); if (v) st[p] = v; }
      });
    } catch { /* never let one element break the whole report */ }
  });
}
