// Theme preference: 'light' | 'dark' | 'system' (default). Persisted to
// localStorage under 'dm:theme' and applied as a `.dark` class on <html>.
// A matching inline script in index.html applies it pre-paint (no FOUC); this
// module keeps the DOM + React in sync afterwards and reacts to OS changes.

const KEY = 'dm:theme';
const listeners = new Set();
const mql = window.matchMedia('(prefers-color-scheme: dark)');

export function getPreference() {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

// The concrete theme actually shown, resolving 'system' against the OS.
export function resolveTheme(pref = getPreference()) {
  if (pref === 'system') return mql.matches ? 'dark' : 'light';
  return pref;
}

function apply(pref = getPreference()) {
  document.documentElement.classList.toggle('dark', resolveTheme(pref) === 'dark');
}

export function setPreference(pref) {
  if (pref === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, pref);
  apply(pref);
  listeners.forEach((fn) => fn(pref));
}

// Cycle order for a single-button toggle: light → dark → system → light.
export function cyclePreference() {
  const order = ['light', 'dark', 'system'];
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
