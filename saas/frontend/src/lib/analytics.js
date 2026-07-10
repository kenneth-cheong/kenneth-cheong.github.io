// Microsoft Clarity session-recording loader — for UX/usability testing.
//
// Records real screen sessions (mouse, clicks, scrolls, page flow) so we can
// watch how people actually use the app and where they get stuck. Clarity is
// free and unlimited, and by default MASKS the text you type into inputs, so
// passwords / API keys / client data never leave the browser as readable text.
//
// This module is a no-op until `VITE_CLARITY_ID` is set — recording is OFF in a
// normal build and only turns on once a project ID is provided. That gives us a
// clean on/off switch for a testing period without any code change.
//
// `initAnalytics()` injects the Clarity tag once (call it at startup).
// `identify(user)` tags the recording with who's using it, so a specific
// tester's sessions can be found by email in the Clarity dashboard.

let loaded = false;

export function initAnalytics() {
  const id = import.meta.env.VITE_CLARITY_ID;
  if (!id || loaded || typeof window === 'undefined') return;
  loaded = true;
  // Official Clarity snippet, inlined so there's no build-time dependency.
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', id);
}

// Stamp the logged-in user onto the current recording. Safe to call repeatedly
// (e.g. whenever auth state changes) and before the tag has finished loading —
// Clarity queues the calls. Wrapped so analytics can never break the app.
export function identify(user) {
  if (!loaded || typeof window === 'undefined' || typeof window.clarity !== 'function' || !user) return;
  try {
    const uid = String(user.userId || user.email || 'anon');
    // 5th arg is the friendly label shown in the dashboard session list.
    window.clarity('identify', uid, undefined, undefined, user.email || uid);
    // Custom tags → filterable facets in the dashboard, so we can jump straight
    // to "sessions from tester@example.com" or "all Starter-plan users".
    if (user.email) window.clarity('set', 'email', user.email);
    if (user.tier) window.clarity('set', 'tier', String(user.tier));
  } catch { /* never break the app for analytics */ }
}
