import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { Bell } from 'lucide-react';

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

  return (
    <div ref={ref} className="relative">
      <button onClick={toggle} className="relative text-muted hover:text-strong" title="Notifications" aria-label="Notifications">
        <Bell size={20} aria-hidden />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
          <div className="border-b border-hair px-4 py-2 text-sm font-semibold">Notifications</div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 && <div className="px-4 py-6 text-center text-sm text-faint">No notifications.</div>}
            {items.map((n) => (
              <button
                key={n.notifId}
                onClick={() => go(n)}
                className="block w-full border-b border-hair px-4 py-2.5 text-left hover:bg-raised"
              >
                <div className="text-sm text-strong">{n.title}</div>
                {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
                <div className="mt-0.5 text-[11px] text-faint">{new Date(n.ts).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
