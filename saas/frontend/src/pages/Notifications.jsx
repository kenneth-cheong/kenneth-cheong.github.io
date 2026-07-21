import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Trash2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { NOTIF_KINDS, kindMeta, kindOf, targetOf, relativeTime, notificationsChanged, onNotificationsChanged } from '../lib/notifications.js';

// The full notification history: filter by type or unread, select rows, and
// mark/delete in bulk. The bell only shows the recent few — this is where older
// items get managed.
export default function Notifications() {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'unread' | a kind key
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = () => api.notifications(300).then((d) => setItems(d.notifications || [])).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  // Pick up anything the header bell changed while this page is open.
  useEffect(() => onNotificationsChanged('page', load), []);

  const unread = (items || []).filter((n) => !n.read).length;
  const counts = useMemo(() => {
    const m = {};
    for (const n of items || []) m[kindOf(n)] = (m[kindOf(n)] || 0) + 1;
    return m;
  }, [items]);

  const visible = useMemo(() => {
    if (!items) return items;
    if (filter === 'all') return items;
    if (filter === 'unread') return items.filter((n) => !n.read);
    return items.filter((n) => kindOf(n) === filter);
  }, [items, filter]);

  // Only ever act on rows the current filter actually shows, so "select all"
  // can't quietly delete items scrolled out of view by a filter.
  const visibleIds = useMemo(() => (visible || []).map((n) => n.notifId), [visible]);
  const pickedVisible = visibleIds.filter((id) => picked.has(id));
  const allPicked = visibleIds.length > 0 && pickedVisible.length === visibleIds.length;

  function togglePick(id) {
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(visibleIds));

  async function markRead(ids, read = true) {
    if (!ids.length) return;
    setItems((xs) => xs.map((n) => (ids.includes(n.notifId) ? { ...n, read } : n)));
    try { await api.markNotificationsRead(ids, read); notificationsChanged('page'); } catch { load(); }
  }

  async function markAllRead() {
    setBusy(true);
    setItems((xs) => xs.map((n) => ({ ...n, read: true })));
    try { await api.markNotificationsRead(); notificationsChanged('page'); } catch { load(); }
    setBusy(false);
  }

  async function remove(ids) {
    if (!ids.length) return;
    setBusy(true);
    setItems((xs) => xs.filter((n) => !ids.includes(n.notifId)));
    setPicked((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
    try { await api.deleteNotifications(ids); notificationsChanged('page'); } catch { load(); }
    setBusy(false);
  }

  async function clearAll() {
    if (!window.confirm('Delete every notification? This cannot be undone.')) return;
    setBusy(true);
    setItems([]);
    setPicked(new Set());
    try { await api.clearNotifications(); notificationsChanged('page'); } catch { load(); }
    setBusy(false);
  }

  function open(n) {
    if (!n.read) markRead([n.notifId]);
    const to = targetOf(n);
    if (to) navigate(to);
  }

  const tabs = [
    ['all', 'All', items?.length || 0],
    ['unread', 'Unread', unread],
    ...NOTIF_KINDS.filter((k) => counts[k.key]).map((k) => [k.key, k.label, counts[k.key]]),
  ];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="mt-1 text-dim">Everything the platform has told you. Click one to jump straight to it.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={markAllRead} disabled={busy || !unread} className="btn-ghost text-sm disabled:opacity-40">Mark all as read</button>
          <button onClick={clearAll} disabled={busy || !items?.length} className="btn-ghost text-sm disabled:opacity-40">Delete all</button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {tabs.map(([key, label, count]) => (
          <button key={key} onClick={() => { setFilter(key); setPicked(new Set()); }}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === key ? 'bg-brand-600 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
            {label} <span className={filter === key ? 'opacity-80' : 'text-faint'}>{count}</span>
          </button>
        ))}
      </div>

      {/* Bulk bar — only once something is selected, so it never nags. */}
      {pickedVisible.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-raised px-4 py-2.5">
          <span className="text-sm font-medium text-strong">{pickedVisible.length} selected</span>
          <button onClick={() => markRead(pickedVisible, true)} className="text-sm font-medium text-brand-500 hover:underline">Mark as read</button>
          <button onClick={() => markRead(pickedVisible, false)} className="text-sm font-medium text-brand-500 hover:underline">Mark as unread</button>
          <button onClick={() => remove(pickedVisible)} className="text-sm font-medium text-red-500 hover:underline">Delete</button>
          <button onClick={() => setPicked(new Set())} className="ml-auto text-sm text-muted hover:underline">Clear selection</button>
        </div>
      )}

      {visible === null && <p className="mt-6 text-faint">Loading…</p>}

      {visible?.length === 0 && (
        <div className="card mt-6 p-8 text-center">
          <p className="font-semibold text-heading">Nothing here</p>
          <p className="mt-1.5 text-sm text-dim">
            {filter === 'all' ? 'Finished runs, replies and alerts will show up here.' : 'No notifications match this filter.'}
          </p>
        </div>
      )}

      {visible?.length > 0 && (
        <div className="card mt-4 overflow-hidden">
          <label className="flex items-center gap-3 border-b border-hair px-4 py-2.5 text-sm text-muted">
            <input type="checkbox" checked={allPicked} onChange={toggleAll} className="h-4 w-4 rounded border-line" />
            Select all {visible.length} shown
          </label>
          {visible.map((n) => {
            const meta = kindMeta(n);
            const to = targetOf(n);
            return (
              <div key={n.notifId} className={`flex items-start gap-3 border-b border-hair px-4 py-3 last:border-0 ${n.read ? '' : 'bg-brand-50/50 dark:bg-brand-500/5'}`}>
                <input type="checkbox" checked={picked.has(n.notifId)} onChange={() => togglePick(n.notifId)}
                  className="mt-1 h-4 w-4 rounded border-line" aria-label={`Select "${n.title}"`} />
                <button onClick={() => open(n)} disabled={!to} className={`min-w-0 flex-1 text-left ${to ? '' : 'cursor-default'}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                    <span className={`text-sm ${n.read ? 'text-body' : 'font-semibold text-strong'}`}>{n.title}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}>{meta.label}</span>
                  </div>
                  {n.body && <div className="mt-0.5 text-xs text-muted">{n.body}</div>}
                  <div className="mt-0.5 text-[11px] text-faint" title={new Date(n.ts).toLocaleString()}>{relativeTime(n.ts)}</div>
                </button>
                <div className="flex shrink-0 gap-1">
                  <button onClick={() => markRead([n.notifId], !n.read)} title={n.read ? 'Mark as unread' : 'Mark as read'}
                    aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
                    className="rounded-lg p-1.5 text-muted hover:bg-sunken hover:text-strong"><Check size={15} aria-hidden /></button>
                  <button onClick={() => remove([n.notifId])} title="Delete" aria-label="Delete notification"
                    className="rounded-lg p-1.5 text-muted hover:bg-sunken hover:text-red-500"><Trash2 size={15} aria-hidden /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
