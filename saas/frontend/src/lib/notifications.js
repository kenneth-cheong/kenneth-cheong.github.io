// Shared notification vocabulary for the bell dropdown and the Notifications
// page, so both label and filter a row the same way.
//
// Rows written from 2026-07 carry an explicit `kind`. Older rows don't, so
// `kindOf` falls back to the shape they already had: a ticketId means support,
// a `/runs/...` or `/history` link means a finished run, and a ⚠️/⏸️ title is
// something that needs attention.
export const NOTIF_KINDS = [
  { key: 'run', label: 'Results', cls: 'bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300' },
  { key: 'support', label: 'Support', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' },
  { key: 'alert', label: 'Alerts', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  { key: 'schedule', label: 'Schedules', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  { key: 'announcement', label: 'Announcements', cls: 'bg-sunken text-muted' },
];

// The bell and the Notifications page can be on screen at once (the bell lives
// in the header), and the bell only polls once a minute — so without this a
// mark-read on one leaves the other showing stale counts. Each announces its
// own mutations and reloads on everyone else's. `source` keeps a component from
// refetching in response to its own event, which would just undo the optimistic
// update it already applied.
export const NOTIF_CHANGED = 'dm:notifications-changed';
export const notificationsChanged = (source) =>
  window.dispatchEvent(new CustomEvent(NOTIF_CHANGED, { detail: { source } }));

// Subscribe to changes made anywhere but `source`. Returns an unsubscribe fn.
export function onNotificationsChanged(source, fn) {
  const handler = (e) => { if (e.detail?.source !== source) fn(); };
  window.addEventListener(NOTIF_CHANGED, handler);
  return () => window.removeEventListener(NOTIF_CHANGED, handler);
}

export function kindOf(n) {
  if (n?.kind && NOTIF_KINDS.some((k) => k.key === n.kind)) return n.kind;
  if (n?.ticketId) return 'support';
  if (/^\/runs?\//.test(n?.link || '') || n?.link === '/history') return 'run';
  if (/^(⚠️|⏸️|❌)/.test(n?.title || '')) return 'alert';
  return 'announcement';
}

export const kindMeta = (n) => NOTIF_KINDS.find((k) => k.key === kindOf(n)) || NOTIF_KINDS[4];

// Where a notification should take you. Support rows open their ticket; every
// other row follows its own in-app link (external/absolute links are ignored —
// notifications must never navigate the user off-platform).
export function targetOf(n) {
  if (n?.ticketId) return `/support/${encodeURIComponent(n.ticketId)}`;
  if (n?.link && n.link.startsWith('/')) return n.link;
  return null;
}

// "just now" / "3h ago" / "12 Jul" — compact enough for the dropdown.
export function relativeTime(ts) {
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
