// Theme preference: 'royal' (default) | 'light' | 'dark' | 'system'. Persisted
// to localStorage under 'dm:theme' and applied as a `.royal` or `.dark` class
// on <html>. A matching inline script in index.html applies it pre-paint (no
// FOUC); this module keeps the DOM + React in sync afterwards and reacts to OS
// changes. Royal is the approved mockup design (mockups/saas-overview.html) and
// is what a user with no saved preference now gets.
//
// NOTE: the pre-paint script in index.html mirrors this logic and is allow-listed
// in the CSP by a sha256 hash. If you change how a preference maps to a class,
// change it there too AND recompute the hash in public/customHttp.yml +
// amplify.yml, or the theme silently stops applying on load in production.

const KEY = 'dm:theme';
const DEFAULT = 'royal';
const listeners = new Set();
const mql = window.matchMedia('(prefers-color-scheme: dark)');

export function getPreference() {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'royal' || v === 'system' ? v : DEFAULT;
}

// The concrete theme actually shown, resolving 'system' against the OS.
// Returns 'royal' | 'light' | 'dark' — note royal is a THIRD value, so never
// branch on `resolveTheme() === 'dark'` to mean "is this a dark canvas"; use
// isDarkTheme() or royal gets treated as light.
export function resolveTheme(pref = getPreference()) {
  if (pref === 'system') return mql.matches ? 'dark' : 'light';
  return pref;
}

// True when the canvas is dark and light-on-dark content is correct — i.e. dark
// OR royal. This is the question almost every caller actually has.
export function isDarkTheme(pref = getPreference()) {
  return resolveTheme(pref) !== 'light';
}

// Royal carries BOTH classes: `dark royal`. It's a dark theme — white ink on a
// deep blue canvas — so it wants every `dark:` variant the app already has
// (tint chips, auth gradients, form-control fallbacks: ~576 of them). `.royal`
// then re-points the tokens to blue; it's declared after `.dark` in index.css,
// so at equal specificity source order lets royal win. Keep that order.
function apply(pref = getPreference()) {
  const theme = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark' || theme === 'royal');
  root.classList.toggle('royal', theme === 'royal');
}

export function setPreference(pref) {
  // 'royal' is the default, so it's stored explicitly rather than cleared —
  // clearing has to keep meaning "never chose", which now also resolves royal.
  localStorage.setItem(KEY, pref);
  apply(pref);
  listeners.forEach((fn) => fn(pref));
}

// Cycle order for a single-button toggle: royal → light → dark → system → royal.
export function cyclePreference() {
  const order = ['royal', 'light', 'dark', 'system'];
  const next = order[(order.indexOf(getPreference()) + 1) % order.length];
  setPreference(next);
  return next;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keep 'system' preference live when the OS theme flips.
mql.addEventListener('change', () => {
  if (getPreference() === 'system') { apply('system'); listeners.forEach((fn) => fn('system')); }
});
