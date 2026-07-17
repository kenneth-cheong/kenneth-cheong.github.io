/** @type {import('tailwindcss').Config} */

// Semantic color tokens are backed by CSS variables (RGB triplets, defined in
// src/index.css for :root and .dark). The `rgb(var(--x) / <alpha-value>)` form
// keeps Tailwind's `/opacity` modifiers working (e.g. bg-surface/80). Each
// token's LIGHT value equals the exact slate/white shade it replaced, so the
// light theme is pixel-identical to before dark mode — only the dark values are new.
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  // `relative: true` resolves these globs against THIS file, not the process
  // CWD — required when Vite runs from the repo root (dev-preview tooling).
  content: { relative: true, files: ['./index.html', './src/**/*.{js,jsx}'] },
  // Dark mode is opt-in via a `.dark` class on <html> (toggled by the theme
  // switcher, persisted to localStorage, applied pre-paint in index.html).
  // Royal — the approved mockup design — is a third theme on a `.royal` class;
  // it re-points the same semantic tokens, so no `royal:` variants are needed.
  darkMode: 'class',
  theme: {
    extend: {
      // Brand palette mirrors index.html's primary blue (--primary-blue #2563eb
      // = blue-600, hover #1d4ed8 = blue-700) so the SaaS app reads as the same product.
      colors: {
        brand: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
          400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
          800: '#1e40af', 900: '#1e3a8a',
        },
        // ── Semantic neutral tokens (theme-aware) ──────────────────────────
        // Surfaces (page → raised → hover):
        canvas: token('--c-canvas'),     // page background (body)      ← slate-50
        surface: token('--c-surface'),   // cards / panels / inputs     ← white
        raised: token('--c-raised'),     // subtle raised / soft hover  ← slate-50
        sunken: token('--c-sunken'),     // pills / button rest         ← slate-100
        overlay: token('--c-overlay'),   // stronger hover              ← slate-200/300
        // Text (strong → faint):
        heading: token('--c-heading'),   // headings / strongest text   ← slate-900
        strong: token('--c-strong'),     // strong text                 ← slate-800
        body: token('--c-body'),         // default body text           ← slate-700
        dim: token('--c-dim'),           // secondary text              ← slate-600
        muted: token('--c-muted'),       // tertiary text               ← slate-500
        faint: token('--c-faint'),       // icons / placeholders        ← slate-400
        // Borders:
        line: token('--c-line'),         // default border              ← slate-200
        hair: token('--c-hair'),         // hairline divider            ← slate-100/50
        edge: token('--c-edge'),         // input border (stronger)     ← slate-300
        // ── Accent tokens (mockups/saas-overview.html) ────────────────────
        // Themed, not fixed hexes: the mockup's accents are tuned for white
        // text on deep blue and drop to ~1.6:1 on a white canvas, so the light
        // theme substitutes darker equivalents of the same hues.
        pos: token('--c-pos'),           // positive / up   — royal #4ade87
        neg: token('--c-neg'),           // negative / down — royal #ff7a68
        warn: token('--c-warn'),         // caution         — royal #ffc857
        peri: token('--c-peri'),         // periwinkle info — royal #9fb0ff
        cta: token('--c-cta'),           // primary action fill
        'cta-ink': token('--c-cta-ink'), // text ON the primary action
        'cta-hover': token('--c-cta-hover'),
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        // Royal sets `font-display` on <body>; the mockup is set in Inter.
        display: ['Inter', '"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        // index.html metric/cockpit card lift on hover
        lift: '0 12px 24px rgba(0, 0, 0, 0.05)',
        // Themed card shadow — the mockup's deep blue cast in royal, a soft
        // neutral in light/dark. Value lives in --e-shadow (src/index.css).
        card: 'var(--e-shadow)',
      },
      // Assistant panel "launch" entrance — slides in from the right edge while
      // fading in. Applied (motion-safe) on the ChatDrawer aside each open.
      keyframes: {
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        // Monty's proactive nudge grows out of the bottom-right launcher: a
        // small rise + scale from the corner (pair with origin-bottom-right).
        'pop-from-corner': {
          '0%': { transform: 'translateY(8px) scale(.96)', opacity: '0' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
      },
      animation: {
        'slide-in-right': 'slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'pop-from-corner': 'pop-from-corner 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
