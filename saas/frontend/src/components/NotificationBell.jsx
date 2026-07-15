import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { Bell, X } from 'lucide-react';

// In-platform notifications (ticket replies, ticket closed, etc.). Polls lightly
// and opens the related ticket on click.
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

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread) {
      try { await api.markNotificationsRead(); setItems((xs) => xs.map((n) => ({ ...n, read: true }))); } catch { /* ignore */ }
    }
  }

  function go(n) {
    setOpen(false);
    if (n.ticketId) navigate(`/support/${encodeURIComponent(n.ticketId)}`);
    // Broadcast notifications may carry an in-app deep link (must be a local path).
    else if (n.link && n.link.startsWith('/')) navigate(n.link);
  }

  // Dismiss/clear are optimistic — the feed is disposable, so a slow round-trip
  // shouldn't make the UI feel stuck. On failure we reload to undo the guess.
  async function dismiss(e, n) {
    e.stopPropagation(); // don't navigate; the row itself is a button
    const prev = items;
    setItems((xs) => xs.filter((x) => x.notifId !== n.notifId));
    try { await api.deleteNotification(n.notifId); }
    catch { setItems(prev); toast('Could not dismiss that notification', 'error'); }
  }

  async function clearAll() {
    const prev = items;
    setItems([]);
    try { await api.clearNotifications(); }
    catch { setItems(prev); toast('Could not clear notifications', 'error'); }
  }

  return (
    <div ref={ref} className="relative">
      <button onClick={toggle} data-tour="notifications" className="relative text-muted hover:text-strong" title="Notifications" aria-label="Notifications">
        <Bell size={20} aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="flex items-center gap-2 border-b border-hair px-4 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {items.length > 0 && (
              <button onClick={clearAll} className="ml-auto rounded px-1.5 py-0.5 text-xs font-medium text-muted hover:bg-sunken hover:text-strong">
                Clear all
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">No notifications.</div>}
            {items.map((n) => (
              // Row + dismiss are SIBLING buttons: a button nested inside a
              // button is invalid HTML and browsers drop the inner click.
              <div key={n.notifId} className="group relative border-b border-hair hover:bg-raised">
                <button onClick={() => go(n)} className="block w-full px-4 py-2.5 pr-9 text-left">
                  <div className="text-sm text-strong">{n.title}</div>
                  {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
                  {n.image && <img src={n.image} alt="" className="mt-1.5 max-h-28 w-full rounded-lg border border-hair object-cover" />}
                  <div className="mt-0.5 text-[11px] text-faint">{new Date(n.ts).toLocaleString()}</div>
                </button>
                <button
                  onClick={(e) => dismiss(e, n)}
                  title="Dismiss"
                  aria-label={`Dismiss notification: ${n.title}`}
                  className="absolute right-1.5 top-2 rounded p-1 text-faint opacity-0 transition-opacity hover:bg-sunken hover:text-strong focus:opacity-100 group-hover:opacity-100"
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
