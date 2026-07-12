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
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        // index.html metric/cockpit card lift on hover
        lift: '0 12px 24px rgba(0, 0, 0, 0.05)',
      },
      // Assistant panel "launch" entrance — slides in from the right edge while
      // fading in. Applied (motion-safe) on the ChatDrawer aside each open.
      keyframes: {
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'slide-in-right': 'slide-in-right 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
