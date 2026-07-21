import { useEffect, useState } from 'react';

// Whether the user has hidden the full-width plan strip (PlanBreadcrumb).
//
// Kept out of PlanContext on purpose: that context is the plan's DATA — synced
// to the account and shared across devices — while this is a throwaway "not
// right now" for one browsing session. sessionStorage matches that intent: it
// survives navigation and reloads, and clears when the tab closes.
//
// Two components care about it and neither owns the other (the strip lives under
// the nav, the chip lives inside it), so the value is shared here and changes are
// broadcast on a custom event — plain sessionStorage writes fire no `storage`
// event in the tab that made them, so without this the chip would only notice on
// the next render for some unrelated reason.
const KEY = 'dm:planStripDismissed';
const EVT = 'dm:planStripChange';

const read = () => {
  try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; }
};

export function setPlanStripDismissed(value) {
  try { if (value) sessionStorage.setItem(KEY, '1'); else sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(EVT, { detail: !!value }));
}

/** `[dismissed, setDismissed]` — shared across every component that calls it. */
export function usePlanStripDismissed() {
  const [dismissed, setDismissed] = useState(read);
  useEffect(() => {
    const onChange = (e) => setDismissed(!!e.detail);
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, []);
  return [dismissed, setPlanStripDismissed];
}
