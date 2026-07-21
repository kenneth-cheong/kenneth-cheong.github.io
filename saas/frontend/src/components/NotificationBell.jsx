import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Bell, Check, Trash2 } from 'lucide-react';
import { kindMeta, targetOf, relativeTime, notificationsChanged, onNotificationsChanged } from '../lib/notifications.js';

// In-platform notifications (finished runs, ticket replies, alerts). Polls
// lightly, and clicking one navigates straight to the thing it's about — a
// finished run opens that result, not the Runs list.
//
// Opening the dropdown deliberately does NOT mark everything read: the user
// owns that now via the per-row tick, "Mark all as read", and the full
// Notifications page. Reading a notification is a decision, not a side effect
// of glancing at the bell.
export default function NotificationBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const unread = items.filter((n) => !n.read).length;

  const load = () => api.notifications().then((d) => setItems(d.notifications || [])).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000); // refresh once a minute
    return () => clearInterval(t);
  }, []);

  // The Notifications page announces its own edits so the badge doesn't stay
  // stale until the next poll.
  useEffect(() => onNotificationsChanged('bell', load), []);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Every mutation updates the list optimistically and reloads on failure, so a
  // dropped request can never leave the badge disagreeing with the server.
  async function markRead(n, read = !n.read) {
    setItems((xs) => xs.map((x) => (x.notifId === n.notifId ? { ...x, read } : x)));
    try { await api.markNotificationsRead([n.notifId], read); notificationsChanged('bell'); } catch { load(); }
  }

  async function markAllRead() {
    setItems((xs) => xs.map((n) => ({ ...n, read: true })));
    try { await api.markNotificationsRead(); notificationsChanged('bell'); } catch { load(); }
  }

  async function remove(n) {
    setItems((xs) => xs.filter((x) => x.notifId !== n.notifId));
    try { await api.deleteNotifications(n.notifId); notificationsChanged('bell'); } catch { load(); }
  }

  function go(n) {
    if (!n.read) markRead(n, true);
    const to = targetOf(n);
    if (!to) return;
    setOpen(false);
    navigate(to);
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} data-tour="notifications" className="relative text-muted hover:text-strong" title="Notifications" aria-label="Notifications">
        <Bell size={20} aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-96 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-hair px-4 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs font-medium text-brand-500 hover:underline">Mark all as read</button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">No notifications.</div>}
            {items.map((n) => {
              const meta = kindMeta(n);
              const to = targetOf(n);
              return (
                <div key={n.notifId}
                  className={`group flex items-start gap-2 border-b border-hair px-3 py-2.5 last:border-0 hover:bg-raised ${n.read ? '' : 'bg-brand-50/50 dark:bg-brand-500/5'}`}>
                  <button onClick={() => go(n)} disabled={!to} className={`min-w-0 flex-1 text-left ${to ? '' : 'cursor-default'}`}>
                    <div className="flex items-center gap-1.5">
                      {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                      <span className={`truncate text-sm ${n.read ? 'text-body' : 'font-semibold text-strong'}`}>{n.title}</span>
                    </div>
                    {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}>{meta.label}</span>
                      <span className="text-[11px] text-faint" title={new Date(n.ts).toLocaleString()}>{relativeTime(n.ts)}</span>
                    </div>
                  </button>
                  {/* Row actions — always in the DOM (and focusable) so keyboard
                      users get them too; hover just fades them in. */}
                  <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <button onClick={() => markRead(n)} title={n.read ? 'Mark as unread' : 'Mark as read'}
                      aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
                      className="rounded-md p-1 text-muted hover:bg-sunken hover:text-strong"><Check size={14} aria-hidden /></button>
                    <button onClick={() => remove(n)} title="Delete" aria-label="Delete notification"
                      className="rounded-md p-1 text-muted hover:bg-sunken hover:text-red-500"><Trash2 size={14} aria-hidden /></button>
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => { setOpen(false); navigate('/notifications'); }}
            className="block w-full border-t border-hair px-4 py-2 text-center text-sm font-medium text-brand-500 hover:bg-raised">
            All notifications →
          </button>
        </div>
      )}
    </div>
  );
}
