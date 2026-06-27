import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PLANS, TIER_ORDER } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import SortableTable from '../components/SortableTable.jsx';

// Admin-only console: manage users (tier + credits) and the support inbox
// (view / reply / close every user's ticket). Gated client-side here AND
// server-side (ADMIN_EMAILS) — the UI is a convenience over the gated API.
export default function Admin() {
  const { user } = useAuth();
  const [tab, setTab] = useState('users');
  if (!user.isAdmin) return <Navigate to="/" replace />;

  return (
    <div>
      <h1 className="text-2xl font-bold">Admin</h1>
      <div className="mt-3 flex gap-1 border-b border-slate-200">
        {[['users', 'Users'], ['notifications', 'Notifications'], ['tickets', 'Support tickets'], ['settings', 'Settings']].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'users' ? <AdminUsers /> : tab === 'notifications' ? <AdminNotifications /> : tab === 'tickets' ? <AdminTickets /> : <AdminSettings />}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Platform-wide toggles. Currently: whether email/password sign-in is allowed
// (Google sign-in is always on). Saving is restricted to ADMIN_EMAILS admins
// server-side; staff without that role get a 403.
function AdminSettings() {
  const [settings, setSettings] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // Editable copy of the ticket-lifecycle numbers (strings while typing).
  const [tForm, setTForm] = useState({ ticketReminderDays: '', ticketAutoCloseDays: '' });

  useEffect(() => {
    let live = true;
    api.adminSettings()
      .then(({ settings }) => {
        if (!live) return;
        setSettings(settings);
        setTForm({
          ticketReminderDays: String(settings.ticketReminderDays ?? 3),
          ticketAutoCloseDays: String(settings.ticketAutoCloseDays ?? 7),
        });
      })
      .catch(() => live && setError('Could not load settings.'));
    return () => { live = false; };
  }, []);

  async function toggle(key, value) {
    setBusy(true); setError(''); setMsg('');
    try {
      const { settings } = await api.adminSetSettings({ [key]: value });
      setSettings(settings);
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setError(e?.payload?.error === 'admin_only'
        ? 'Only a primary admin can change this setting.'
        : (e?.message || 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveTickets(e) {
    e.preventDefault();
    const reminder = Number(tForm.ticketReminderDays);
    const close = Number(tForm.ticketAutoCloseDays);
    if (![reminder, close].every((n) => Number.isInteger(n) && n >= 0 && n <= 365)) {
      setError('Enter whole numbers of days between 0 and 365.');
      return;
    }
    setBusy(true); setError(''); setMsg('');
    try {
      const { settings } = await api.adminSetSettings({ ticketReminderDays: reminder, ticketAutoCloseDays: close });
      setSettings(settings);
      setTForm({ ticketReminderDays: String(settings.ticketReminderDays), ticketAutoCloseDays: String(settings.ticketAutoCloseDays) });
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setError(e?.payload?.error === 'admin_only'
        ? 'Only a primary admin can change these settings.'
        : (e?.payload?.error || e?.message || 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (settings === null && !error) return <p className="mt-6 text-sm text-slate-500">Loading…</p>;

  return (
    <div className="mt-4 max-w-2xl">
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Email &amp; password sign-in</h2>
            <p className="mt-1 text-sm text-slate-500">
              When off, new sign-ups and existing email/password logins are blocked and the login page
              shows only “Sign in with Google”. Google sign-in is always available.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!settings?.passwordAuthEnabled}
            disabled={busy || !settings}
            onClick={() => toggle('passwordAuthEnabled', !settings.passwordAuthEnabled)}
            className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${settings?.passwordAuthEnabled ? 'bg-brand-600' : 'bg-slate-300'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${settings?.passwordAuthEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="mt-3 text-sm font-medium">
          Status:{' '}
          <span className={settings?.passwordAuthEnabled ? 'text-emerald-600' : 'text-slate-500'}>
            {settings?.passwordAuthEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </p>
      </div>

      <form className="card mt-4 p-5" onSubmit={saveTickets}>
        <h2 className="text-base font-semibold">Support ticket reminders &amp; auto-close</h2>
        <p className="mt-1 text-sm text-slate-500">
          When support has replied and is waiting on the client, send a reminder email every so many days,
          and automatically close the ticket if there&apos;s still no response. Applies to the daily
          maintenance job. Set a value to <span className="font-medium">0</span> to turn that behaviour off.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Remind the client every</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number" min="0" max="365" step="1" inputMode="numeric"
                className="field w-24" disabled={busy || !settings}
                value={tForm.ticketReminderDays}
                onChange={(e) => setTForm((f) => ({ ...f, ticketReminderDays: e.target.value }))}
              />
              <span className="text-sm text-slate-500">days</span>
            </div>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Auto-close after</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number" min="0" max="365" step="1" inputMode="numeric"
                className="field w-24" disabled={busy || !settings}
                value={tForm.ticketAutoCloseDays}
                onChange={(e) => setTForm((f) => ({ ...f, ticketAutoCloseDays: e.target.value }))}
              />
              <span className="text-sm text-slate-500">days of no reply</span>
            </div>
          </label>
        </div>
        {Number(tForm.ticketReminderDays) > 0 && Number(tForm.ticketAutoCloseDays) > 0
          && Number(tForm.ticketReminderDays) >= Number(tForm.ticketAutoCloseDays) && (
          <p className="mt-3 text-sm text-amber-600">
            Heads up: the reminder interval is longer than the auto-close window, so the ticket will close
            before any reminder is sent.
          </p>
        )}
        <button type="submit" className="btn-primary mt-4" disabled={busy || !settings}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>

      {msg && <p className="mt-3 text-sm text-emerald-600">{msg}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

// ── Broadcast notifications ──────────────────────────────────────────────────
// Build a target audience from sign-up / last-login / last-tool-use date filters
// (+ optional tier/status narrowing), preview who it reaches, then send an
// in-app and/or email broadcast. Server enforces staff-only + the audience cap.
const CLAUSES = [
  { key: 'signup', label: 'Signed up', help: 'when the account was created' },
  { key: 'lastLogin', label: 'Last login', help: 'tracked from when this shipped' },
  { key: 'lastToolUse', label: 'Last tool use', help: 'backfilled from run history' },
];
const BROADCAST_STATUSES = ['active', 'paused', 'inactive'];

function AdminNotifications() {
  // Audience filter state.
  const [clauses, setClauses] = useState({
    signup: { enabled: false, type: 'after', days: 7 },
    lastLogin: { enabled: false, type: 'before', days: 30 },
    lastToolUse: { enabled: false, type: 'before', days: 14 },
  });
  const [match, setMatch] = useState('all');
  const [tiers, setTiers] = useState(new Set());
  const [statuses, setStatuses] = useState(new Set(['active']));

  // Composer state.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [channels, setChannels] = useState({ inApp: true, email: false });

  // Async + result state.
  const [preview, setPreview] = useState(null); // { count, sample, capped, maxAudience }
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const loadHistory = () => api.adminBroadcastHistory().then((d) => setHistory(d.broadcasts || [])).catch(() => setHistory([]));
  useEffect(() => { loadHistory(); }, []);

  function setClause(key, patch) {
    setClauses((c) => ({ ...c, [key]: { ...c[key], ...patch } }));
    setPreview(null); // any audience change invalidates a prior preview
  }
  function toggleIn(set, setter, value) {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    setter(next); setPreview(null);
  }

  function buildFilter() {
    const f = { match };
    for (const { key } of CLAUSES) {
      const cl = clauses[key];
      if (cl.enabled && Number.isFinite(Number(cl.days))) f[key] = { type: cl.type, days: Number(cl.days) };
    }
    if (tiers.size) f.tiers = [...tiers];
    if (statuses.size) f.statuses = [...statuses];
    return f;
  }

  async function doPreview() {
    setPreviewing(true); setError(''); setMsg('');
    try { setPreview(await api.adminBroadcastPreview(buildFilter())); }
    catch (e) { setError(e?.payload?.error || 'Could not preview the audience.'); }
    finally { setPreviewing(false); }
  }

  async function doSend() {
    setError(''); setMsg('');
    if (!title.trim()) { setError('Add a title.'); return; }
    if (!body.trim()) { setError('Add a message.'); return; }
    if (!channels.inApp && !channels.email) { setError('Pick at least one channel.'); return; }
    if (link && !link.startsWith('/')) { setError('Link must be an in-app path starting with “/”.'); return; }
    const count = preview?.count;
    const who = count != null ? `${count} user${count === 1 ? '' : 's'}` : 'the matching users';
    const via = [channels.inApp && 'in-app', channels.email && 'email'].filter(Boolean).join(' + ');
    if (!confirm(`Send "${title.trim()}" to ${who} via ${via}? This can't be undone.`)) return;
    setSending(true);
    try {
      const { broadcast } = await api.adminBroadcastSend({
        filter: buildFilter(), title: title.trim(), body: body.trim(),
        link: link.trim() || undefined, channels,
      });
      const parts = [`${broadcast.inAppSent || 0} in-app`];
      if (channels.email) parts.push(`${broadcast.emailSent || 0} email${broadcast.emailSkippedOptOut ? `, ${broadcast.emailSkippedOptOut} opted out` : ''}`);
      setMsg(`Sent to ${broadcast.audienceCount} user${broadcast.audienceCount === 1 ? '' : 's'} (${parts.join(' · ')}).`);
      setTitle(''); setBody(''); setLink(''); setPreview(null);
      loadHistory();
    } catch (e) { setError(e?.payload?.error || 'Could not send the broadcast.'); }
    finally { setSending(false); }
  }

  async function doBackfill() {
    if (!confirm('Seed last-login and last-tool-use from existing sessions + run history? Safe to run anytime — it only fills missing values.')) return;
    setBackfilling(true); setError(''); setMsg('');
    try {
      const r = await api.adminBackfillActivity();
      setMsg(`Backfill done — scanned ${r.scanned} users, filled ${r.loginFilled} logins + ${r.toolFilled} tool-use dates.`);
    } catch (e) { setError(e?.payload?.error || 'Backfill failed.'); }
    finally { setBackfilling(false); }
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      {/* ── Audience builder ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Audience</h2>
          <select value={match} onChange={(e) => { setMatch(e.target.value); setPreview(null); }}
            className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-xs">
            <option value="all">Match ALL date rules</option>
            <option value="any">Match ANY date rule</option>
          </select>
        </div>
        <p className="mt-1 text-xs text-slate-500">Leave all date rules off to target everyone (after the tier/status narrowing below).</p>

        <div className="mt-3 space-y-2">
          {CLAUSES.map(({ key, label, help }) => {
            const cl = clauses[key];
            return (
              <div key={key} className={`rounded-lg border p-2.5 ${cl.enabled ? 'border-brand-200 bg-brand-50/40' : 'border-slate-200'}`}>
                <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <input type="checkbox" checked={cl.enabled} onChange={(e) => setClause(key, { enabled: e.target.checked })} className="h-4 w-4" />
                  {label}
                  <span className="font-normal text-xs text-slate-400">· {help}</span>
                </label>
                {cl.enabled && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-sm">
                    <select value={cl.type} onChange={(e) => setClause(key, { type: e.target.value })}
                      className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
                      <option value="before">more than</option>
                      <option value="after">within the last</option>
                    </select>
                    <input type="number" min="0" value={cl.days} onChange={(e) => setClause(key, { days: e.target.value })}
                      className="w-20 rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                    <span className="text-slate-500">days ago</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tiers</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TIER_ORDER.map((t) => (
                <button key={t} type="button" onClick={() => toggleIn(tiers, setTiers, t)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tiers.has(t) ? 'border-brand-500 bg-brand-100 text-brand-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                  {PLANS[t].name}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">{tiers.size ? '' : 'All tiers'}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {BROADCAST_STATUSES.map((s) => (
                <button key={s} type="button" onClick={() => toggleIn(statuses, setStatuses, s)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${statuses.has(s) ? 'border-brand-500 bg-brand-100 text-brand-700' : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}>
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-slate-400">{statuses.size ? '' : 'Any status'}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={doPreview} disabled={previewing} className="btn-ghost px-3 py-2 text-sm disabled:opacity-50">
            {previewing ? 'Previewing…' : 'Preview audience'}
          </button>
          {preview && (
            <span className="text-sm font-semibold text-slate-700">
              {preview.count.toLocaleString()} user{preview.count === 1 ? '' : 's'}
              {preview.capped && <span className="ml-1 text-red-600">· exceeds cap of {preview.maxAudience}</span>}
            </span>
          )}
        </div>

        {preview?.sample?.length > 0 && (
          <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-slate-100">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-left text-slate-400">
                <tr><th className="px-2 py-1 font-medium">User</th><th className="px-2 py-1 font-medium">Tier</th><th className="px-2 py-1 font-medium">Last login</th><th className="px-2 py-1 font-medium">Last tool</th></tr>
              </thead>
              <tbody>
                {preview.sample.map((u) => (
                  <tr key={u.userId} className="border-t border-slate-50">
                    <td className="px-2 py-1"><div className="font-medium text-slate-600">{u.email}</div></td>
                    <td className="px-2 py-1 text-slate-500">{u.tier}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-slate-400">{u.lastLoginAt ? fmtWhen(u.lastLoginAt) : '—'}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-slate-400">{u.lastToolUseAt ? fmtWhen(u.lastToolUseAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview && preview.count > preview.sample.length && <p className="mt-1.5 text-[11px] text-slate-400">Showing first {preview.sample.length} of {preview.count.toLocaleString()}.</p>}

        <div className="mt-4 border-t border-slate-100 pt-3">
          <button onClick={doBackfill} disabled={backfilling} className="text-xs text-slate-500 underline hover:text-slate-700 disabled:opacity-50">
            {backfilling ? 'Backfilling…' : 'Backfill last-login / last-tool-use from history'}
          </button>
          <p className="mt-1 text-[11px] text-slate-400">Run once so the date filters reflect activity from before this feature shipped.</p>
        </div>
      </div>

      {/* ── Composer ── */}
      <div className="card flex flex-col p-5">
        <h2 className="text-base font-semibold">Message</h2>

        <label className="mt-3 block text-sm font-medium text-slate-700">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="What's new in Digimetrics"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-slate-700">Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={5} placeholder="Write your update… (blank lines start a new paragraph in the email)"
          className="mt-1 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-slate-700">In-app link <span className="font-normal text-slate-400">(optional)</span></label>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/pricing"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
        <p className="mt-1 text-[11px] text-slate-400">A path inside the app (e.g. /pricing). Clicking the notification opens it.</p>

        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Channels</h3>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={channels.inApp} onChange={(e) => setChannels((c) => ({ ...c, inApp: e.target.checked }))} className="h-4 w-4" />
              In-app notification <span className="text-xs text-slate-400">· shows in the bell</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={channels.email} onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))} className="h-4 w-4" />
              Email <span className="text-xs text-slate-400">· skips opted-out users; includes an unsubscribe link</span>
            </label>
          </div>
        </div>

        {msg && <div className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
        {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-slate-400">{preview ? `Will reach ${preview.count.toLocaleString()} user${preview.count === 1 ? '' : 's'}.` : 'Preview the audience first.'}</span>
          <button onClick={doSend} disabled={sending} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{sending ? 'Sending…' : 'Send broadcast'}</button>
        </div>
      </div>

      {/* ── History ── */}
      <div className="card p-5 lg:col-span-2">
        <h2 className="text-base font-semibold">Recent broadcasts</h2>
        {history === null ? <p className="mt-3 text-sm text-slate-400">Loading…</p>
          : history.length === 0 ? <p className="mt-3 text-sm text-slate-400">No broadcasts sent yet.</p>
          : (
            <div className="mt-3 divide-y divide-slate-100">
              {history.map((b) => (
                <div key={b.broadcastId} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-800">{b.title}</div>
                    <div className="truncate text-xs text-slate-500">{b.body}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      by {b.sentBy} · {fmtWhen(b.ts)}
                      {b.channels?.inApp && ` · ${b.inAppSent || 0} in-app`}
                      {b.channels?.email && ` · ${b.emailSent || 0} email`}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{(b.audienceCount || 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────
// Date fields the range filter can target, keyed to the user projection.
const DATE_FIELDS = [
  { key: 'lastLoginAt', label: 'Last login' },
  { key: 'lastToolUseAt', label: 'Last tool use' },
  { key: 'createdAt', label: 'Signed up' },
];

function AdminUsers() {
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');     // all | client | staff
  const [statusFilter, setStatusFilter] = useState('all');  // all | active | paused | inactive | invited
  const [dateField, setDateField] = useState('lastLoginAt');
  const [fromDate, setFromDate] = useState('');             // YYYY-MM-DD (inclusive)
  const [toDate, setToDate] = useState('');                 // YYYY-MM-DD (inclusive, end of day)
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [activityUser, setActivityUser] = useState(null);

  useEffect(() => { load(); }, []);
  async function load() {
    setError('');
    try { const { users } = await api.adminUsers(); setUsers(users || []); }
    catch (e) { setUsers([]); setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load users — reload and try again.'); }
  }
  async function setTier(u, tier) { await api.adminTier(u.userId, tier); flash(`${u.email} → ${PLANS[tier].name}`); load(); }
  async function setStatus(u, status) {
    if (status === (u.status || 'active')) return;
    if (status !== 'active' && !confirm(`Set ${u.email} to "${status}"? They'll be signed out and blocked from signing in or using the app until you reactivate them.`)) { load(); return; }
    try { await api.adminStatus(u.userId, status); flash(`${u.email} → ${status}`); }
    catch (e) { setError(e?.payload?.error || 'Could not update status.'); }
    load();
  }
  async function adjust(u, bucket) {
    const raw = prompt(`Adjust ${bucket} credits for ${u.email} (use a negative number to deduct):`, '100');
    if (raw === null) return;
    const amt = parseInt(raw, 10);
    if (Number.isNaN(amt)) return;
    const reason = prompt('Reason (optional, logged to the ledger):', '') || '';
    await api.adminCredits(u.userId, bucket === 'monthly' ? amt : 0, bucket === 'topup' ? amt : 0, reason);
    flash(`${amt >= 0 ? '+' : ''}${amt} ${bucket} credits → ${u.email}`);
    load();
  }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  // Range is inclusive on both ends; `toDate` covers the whole selected day.
  const fromMs = fromDate ? Date.parse(fromDate) : null;
  const toMs = toDate ? Date.parse(toDate) + 86399999 : null;
  const rows = (users || []).filter((u) => {
    if (q && !((u.email || '') + (u.name || '')).toLowerCase().includes(q.toLowerCase())) return false;
    if (roleFilter !== 'all' && (u.role || 'client') !== roleFilter) return false;
    if (statusFilter !== 'all' && (u.status || 'active') !== statusFilter) return false;
    if (fromMs != null || toMs != null) {
      const ms = u[dateField] ? Date.parse(u[dateField]) : NaN;
      if (Number.isNaN(ms)) return false; // no activity on this field → out of range
      if (fromMs != null && ms < fromMs) return false;
      if (toMs != null && ms > toMs) return false;
    }
    return true;
  });
  const filtersActive = roleFilter !== 'all' || statusFilter !== 'all' || fromDate || toDate;
  function clearFilters() { setRoleFilter('all'); setStatusFilter('all'); setFromDate(''); setToDate(''); }

  return (
    <div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button onClick={() => setCreating(true)} className="btn-primary px-3 py-2 text-sm">+ New user</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email / name…"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
      </div>

      {/* Filters: role / status pickers + a date range over a chosen activity field. */}
      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Role
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
            <option value="all">All</option>
            <option value="client">Client</option>
            <option value="staff">Staff</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="inactive">Inactive</option>
            <option value="invited">Invited</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Date range on
          <select value={dateField} onChange={(e) => setDateField(e.target.value)}
            className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
            {DATE_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          From
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-500">
          To
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)}
            className="rounded border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        {filtersActive && (
          <button onClick={clearFilters} className="btn-ghost px-2.5 py-1.5 text-xs">Clear filters</button>
        )}
        {users && (
          <span className="ml-auto self-center text-xs text-slate-400">
            {rows.length} of {users.length} user{users.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={(u) => { setCreating(false); flash(`Created ${u.email} (${u.role})`); load(); }} />}
      {msg && <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="card mt-3">
        <SortableTable
          rows={rows}
          rowKey={(u) => u.userId}
          stickyFirstCol
          emptyText={users === null ? 'Loading…' : 'No matching users.'}
          columns={[
            { key: 'user', label: 'User', accessor: (u) => u.name || u.email || '',
              render: (u) => (<><div className="font-medium">{u.name || '—'}</div><div className="text-xs text-slate-400">{u.email}</div></>) },
            { key: 'role', label: 'Role', accessor: (u) => u.role || 'client',
              render: (u) => (u.role === 'staff'
                ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">Staff</span>
                : <span className="text-xs text-slate-500">Client</span>) },
            { key: 'status', label: 'Status', accessor: (u) => u.status || 'active',
              render: (u) => (
                u.status === 'invited'
                  ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Invited</span>
                  : u.role === 'staff'
                    ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Active</span>
                    : <StatusSelect u={u} onChange={(s) => setStatus(u, s)} />) },
            { key: 'tier', label: 'Tier', accessor: (u) => TIER_ORDER.indexOf(u.tier),
              render: (u) => (
                <select value={u.tier} onChange={(e) => setTier(u, e.target.value)} className="dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm">
                  {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name}</option>)}
                </select>) },
            { key: 'monthlyCredits', label: 'Monthly', align: 'right', numeric: true, render: (u) => (u.monthlyCredits ?? 0).toLocaleString() },
            { key: 'topupCredits', label: 'Top-up', align: 'right', numeric: true, render: (u) => <span className="text-brand-600">{(u.topupCredits ?? 0).toLocaleString()}</span> },
            { key: 'credits', label: 'Total', align: 'right', numeric: true, render: (u) => <span className="font-semibold">{(u.credits ?? 0).toLocaleString()}</span> },
            { key: 'creditsSpent', label: 'Used', align: 'right', numeric: true, tip: 'Lifetime credits this user has spent on tool runs.',
              render: (u) => <span className="text-slate-500 tabular-nums">{(u.creditsSpent ?? 0).toLocaleString()}</span> },
            { key: 'lastLoginAt', label: 'Last login', numeric: false, accessor: (u) => u.lastLoginAt || '',
              render: (u) => <span className="whitespace-nowrap text-xs text-slate-500">{u.lastLoginAt ? fmtWhen(u.lastLoginAt) : '—'}</span> },
            { key: 'lastToolUseAt', label: 'Last tool use', numeric: false, accessor: (u) => u.lastToolUseAt || '',
              render: (u) => <span className="whitespace-nowrap text-xs text-slate-500">{u.lastToolUseAt ? fmtWhen(u.lastToolUseAt) : '—'}</span> },
            { key: 'adjust', label: 'Adjust credits', sortable: false, render: (u) => (
                <div className="flex gap-1">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'monthly')}>± Monthly</button>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'topup')}>± Top-up</button>
                </div>) },
            { key: 'activity', label: 'Activity', sortable: false, render: (u) => (
                u.status === 'invited'
                  ? <span className="text-xs text-slate-300">—</span>
                  : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setActivityUser(u)}>View</button>) },
          ]}
        />
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Tier changes reset the monthly allowance to that plan's amount; top-up credits are untouched. Setting a user to <strong>Paused</strong> or <strong>Inactive</strong> blocks sign-in and all app/tool access until you set them back to Active. Staff accounts can't be blocked. All changes are written to the credit ledger.
      </p>
      {activityUser && <AdminUserActivity user={activityUser} onClose={() => setActivityUser(null)} />}
    </div>
  );
}

// Active / Paused / Inactive picker for the Users table. Colour-codes the
// current state; 'paused'/'inactive' lock the account out everywhere (enforced
// server-side). Invited + staff rows render a plain pill instead (see above).
function StatusSelect({ u, onChange }) {
  const status = u.status || 'active';
  const tone = status === 'active' ? 'text-green-700' : status === 'paused' ? 'text-amber-700' : 'text-red-700';
  return (
    <select
      value={status}
      onChange={(e) => onChange(e.target.value)}
      className={`dm-select rounded border border-slate-300 py-1 pl-2 pr-7 text-sm font-semibold ${tone}`}
    >
      <option value="active">Active</option>
      <option value="paused">Paused</option>
      <option value="inactive">Inactive</option>
    </select>
  );
}

// ── Consent-gated activity viewer ─────────────────────────────────────────────
// Staff can only see a user's runs + conversations while that user has an ACTIVE
// grant (they approve it under Account → Data access). Until then we show the
// request flow. The server enforces this too — the UI just mirrors the gate.
function AdminUserActivity({ user, onClose }) {
  const [grants, setGrants] = useState(null);   // null = loading
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [runs, setRuns] = useState(null);
  const [convos, setConvos] = useState(null);
  const [openConvo, setOpenConvo] = useState(null);
  const [usage, setUsage] = useState(null);   // per-tool counts (ungated)

  const active = (grants || []).find((g) => g.status === 'granted' && (!g.expiresAt || new Date(g.expiresAt) > new Date()));
  const pending = (grants || []).find((g) => g.status === 'pending');

  async function loadGrants() {
    setErr('');
    try { const { grants } = await api.adminAccessStatus(user.userId); setGrants(grants || []); }
    catch (e) { setGrants([]); setErr(e?.payload?.error || 'Could not load access status.'); }
  }
  useEffect(() => { loadGrants(); }, [user.userId]);

  // Tool-usage counts are operational metadata — load them regardless of consent.
  useEffect(() => {
    let live = true;
    api.adminUsage(user.userId).then((d) => live && setUsage(d)).catch(() => live && setUsage({ tools: [], totalRuns: 0 }));
    return () => { live = false; };
  }, [user.userId]);

  // Once a grant is active, pull the user's activity.
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.adminActivity(user.userId, 'runs').then((d) => live && setRuns(d.runs || [])).catch(() => live && setRuns([]));
    api.adminActivity(user.userId, 'conversations').then((d) => live && setConvos(d.conversations || [])).catch(() => live && setConvos([]));
    return () => { live = false; };
  }, [active, user.userId]);

  async function request() {
    setBusy(true); setErr('');
    try { await api.adminRequestAccess(user.userId, reason.trim()); await loadGrants(); }
    catch (e) { setErr(e?.payload?.error || 'Could not send the request.'); }
    finally { setBusy(false); }
  }

  async function openConversation(id) {
    setOpenConvo({ id, loading: true });
    try { const { conversation } = await api.adminActivity(user.userId, 'conversation', id); setOpenConvo({ id, conversation }); }
    catch { setOpenConvo({ id, error: true }); }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 p-4">
          <div>
            <h3 className="text-base font-bold">Activity · {user.name || user.email}</h3>
            <p className="text-xs text-slate-400">{user.email}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
        </div>

        <div className="overflow-y-auto p-4">
          {err && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

          {/* Tool-usage counts — always visible (operational metadata, no content). */}
          {!openConvo && (
            <section className="mb-5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-slate-700">Tool usage</h4>
                {usage && <span className="text-xs text-slate-400">{(usage.totalRuns || 0).toLocaleString()} runs · {(usage.totalCreditsSpent || 0).toLocaleString()} credits</span>}
              </div>
              {usage === null ? <p className="mt-2 text-sm text-slate-400">Loading…</p>
                : usage.tools.length === 0 ? <p className="mt-2 text-sm text-slate-400">No tool runs yet.</p>
                : (
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                        <th className="pb-1 font-medium">Tool</th>
                        <th className="pb-1 text-right font-medium">Runs</th>
                        <th className="pb-1 text-right font-medium">Credits</th>
                        <th className="pb-1 text-right font-medium">Last used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.tools.map((t) => (
                        <tr key={t.tool} className="border-b border-slate-50">
                          <td className="py-1.5 font-medium text-slate-700">{t.toolName || t.tool}</td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">{(t.count || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right text-slate-500 tabular-nums">{(t.credits || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right whitespace-nowrap text-xs text-slate-400">{t.lastUsed ? fmtWhen(t.lastUsed) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              <p className="mt-2 text-[11px] text-slate-400">Usage counts are always visible. Opening run details or conversations below requires the user’s consent.</p>
            </section>
          )}

          {grants === null && <p className="text-sm text-slate-400">Loading…</p>}

          {/* No active grant → request flow. */}
          {grants !== null && !active && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-2">
                <span className="text-lg">🔒</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900">Consent required for details</p>
                  <p className="mt-1 text-sm text-amber-800">
                    Run details and conversation contents need the user’s permission. Send a request and they’ll
                    approve it under <span className="font-medium">Account → Data access</span>. Grants last 7 days.
                  </p>
                  {pending
                    ? <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-sm text-amber-900">
                        ⏳ Request pending since {fmtWhen(pending.requestedAt)} — waiting for the user to allow it.
                      </p>
                    : (
                      <div className="mt-3">
                        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to the user, optional)"
                          className="w-full rounded-lg border border-amber-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
                        <button onClick={request} disabled={busy} className="btn-primary mt-2 px-3 py-2 text-sm disabled:opacity-50">
                          {busy ? 'Sending…' : 'Request access'}
                        </button>
                      </div>
                    )}
                </div>
              </div>
            </div>
          )}

          {/* Active grant → show runs + conversations. */}
          {active && !openConvo && (
            <div className="space-y-5">
              <p className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-800">
                ✓ Access granted{active.expiresAt ? ` until ${fmtWhen(active.expiresAt)}` : ''}. Every view is logged.
              </p>

              <section>
                <h4 className="text-sm font-semibold text-slate-700">Recent tool runs</h4>
                {runs === null ? <p className="mt-2 text-sm text-slate-400">Loading…</p>
                  : runs.length === 0 ? <p className="mt-2 text-sm text-slate-400">No runs yet.</p>
                  : (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                      {runs.map((r) => (
                        <div key={r.runId} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5 text-sm">
                          <span className="font-medium text-slate-700">{r.toolName || r.tool}</span>
                          <span className="whitespace-nowrap text-xs text-slate-400">{fmtWhen(r.ts)}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </section>

              <section>
                <h4 className="text-sm font-semibold text-slate-700">Assistant conversations</h4>
                {convos === null ? <p className="mt-2 text-sm text-slate-400">Loading…</p>
                  : convos.length === 0 ? <p className="mt-2 text-sm text-slate-400">No conversations yet.</p>
                  : (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                      {convos.map((c) => (
                        <button key={c.conversationId} onClick={() => openConversation(c.conversationId)}
                          className="flex w-full items-center justify-between rounded-lg border border-slate-100 px-3 py-1.5 text-left text-sm hover:bg-slate-50">
                          <span className="truncate font-medium text-slate-700">{c.title || '(untitled)'}</span>
                          <span className="ml-2 whitespace-nowrap text-xs text-slate-400">{fmtWhen(c.updatedAt || c.createdAt)}</span>
                        </button>
                      ))}
                    </div>
                  )}
              </section>
            </div>
          )}

          {/* Conversation drill-down. */}
          {active && openConvo && (
            <div>
              <button onClick={() => setOpenConvo(null)} className="text-sm text-slate-500 hover:text-slate-800">← Conversations</button>
              {openConvo.loading && <p className="mt-3 text-sm text-slate-400">Loading…</p>}
              {openConvo.error && <p className="mt-3 text-sm text-red-600">Could not load this conversation.</p>}
              {openConvo.conversation && (
                <div className="mt-3 space-y-3">
                  {(openConvo.conversation.messages || []).map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${m.role === 'user' ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-slate-100 text-slate-800'}`}>
                        <div className={`mb-0.5 text-[11px] ${m.role === 'user' ? 'text-white/70' : 'text-slate-400'}`}>{m.role === 'user' ? 'User' : 'Assistant'}</div>
                        <div className="whitespace-pre-wrap">{typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Support tickets ──────────────────────────────────────────────────────────
function statusPill(status) {
  const map = { open: 'bg-amber-100 text-amber-700', answered: 'bg-brand-100 text-brand-700', closed: 'bg-slate-100 text-slate-500' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${map[status] || 'bg-slate-100 text-slate-500'}`}>{status || '—'}</span>;
}

function AdminTickets() {
  const [tickets, setTickets] = useState(null);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState('');

  const load = () => { setError(''); api.adminTickets().then((d) => setTickets(d.tickets || [])).catch((e) => { setTickets([]); setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load tickets.'); }); };
  useEffect(() => { load(); }, []);

  if (sel) return <AdminTicketDetail summary={sel} onBack={() => { setSel(null); load(); }} />;

  const open = (tickets || []).filter((t) => t.status !== 'closed').length;
  return (
    <div>
      {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {tickets && <p className="mt-4 text-sm text-slate-500">{tickets.length} ticket{tickets.length === 1 ? '' : 's'} · <span className="font-semibold text-amber-700">{open} open</span></p>}
      <div className="card mt-3">
        <SortableTable
          rows={tickets || []}
          rowKey={(t) => t.userId + t.ticketId}
          emptyText={tickets === null ? 'Loading…' : 'No tickets yet.'}
          columns={[
            { key: 'id', label: 'Ticket', accessor: (t) => t.id,
              render: (t) => <button className="font-mono text-xs font-semibold text-brand-600 hover:underline" onClick={() => setSel(t)}>{t.id}</button> },
            { key: 'userEmail', label: 'User', accessor: (t) => t.userEmail || t.userId, render: (t) => <span className="text-slate-600">{t.userEmail || t.userId}</span> },
            { key: 'subject', label: 'Subject', accessor: (t) => t.subject || '',
              render: (t) => <button className="max-w-xs truncate text-left font-medium text-slate-800 hover:underline" onClick={() => setSel(t)}>{t.subject || '(no subject)'}</button> },
            { key: 'category', label: 'Category', render: (t) => <span className="text-slate-500">{t.category || '—'}</span> },
            { key: 'status', label: 'Status', accessor: (t) => t.status, render: (t) => statusPill(t.status) },
            { key: 'lastActivityAt', label: 'Last activity', accessor: (t) => t.lastActivityAt || t.ts || '',
              render: (t) => <span className="whitespace-nowrap text-slate-500">{fmtWhen(t.lastActivityAt || t.ts)}</span> },
          ]}
        />
      </div>
    </div>
  );
}

function AdminTicketDetail({ summary, onBack }) {
  const [ticket, setTicket] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState('');
  const threadRef = useRef(null);

  const load = () => api.adminTicket(summary.userId, summary.ticketId).then((d) => setTicket(d.ticket)).catch(() => setTicket(false));
  useEffect(() => { load(); }, [summary.ticketId]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [ticket]);

  async function send() {
    if (!reply.trim()) return;
    setBusy(true); setWarn('');
    try {
      const { ticket: t, email } = await api.adminReplyTicket(summary.userId, summary.ticketId, reply.trim());
      setTicket(t); setReply('');
      // The customer always gets an in-app notification; warn only when the
      // EMAIL didn't reach them, so staff can follow up another way.
      if (email && email.delivered === false) {
        setWarn(`Your reply was saved and the customer was notified in-app, but the email to ${email.recipients?.join(', ') || 'the customer'} could not be delivered — they were NOT emailed. SES may still be in the sandbox, or the address bounced. Follow up another way if it's urgent.`);
      } else if (email && email.delivered === null) {
        setWarn('Your reply was saved and posted in-app, but this customer has no email address on file, so no email was sent.');
      }
    }
    catch { /* surfaced by the disabled state resetting */ } finally { setBusy(false); }
  }
  async function close() {
    if (!confirm('Close this ticket?')) return;
    setBusy(true);
    try { await api.adminCloseTicket(summary.userId, summary.ticketId); setTicket((t) => ({ ...t, status: 'closed' })); } finally { setBusy(false); }
  }

  if (ticket === false) return <div className="mt-5"><button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-800">← All tickets</button><p className="mt-4 text-red-600">Ticket not found.</p></div>;
  if (!ticket) return <p className="mt-5 text-slate-400">Loading…</p>;

  return (
    <div className="mt-4">
      <button onClick={onBack} className="text-sm text-slate-500 hover:text-slate-800">← All tickets</button>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">{ticket.subject}</h2>
        {statusPill(ticket.status)}
        {ticket.category && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{ticket.category}</span>}
        <span className="font-mono text-xs text-slate-400">{ticket.id}</span>
        {ticket.status !== 'closed' && (
          <button onClick={close} disabled={busy} className="ml-auto rounded-lg border border-slate-200 px-2.5 py-1 text-sm font-medium text-slate-600 hover:bg-slate-50">Close ticket</button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-400">
        From <strong className="text-slate-500">{ticket.userEmail || summary.userId}</strong>
        {ticket.additionalEmails?.length ? ` · CC ${ticket.additionalEmails.join(', ')}` : ''}
      </p>

      {/* Conversation — staff (agent) bubbles on the right, customer on the left. */}
      <div ref={threadRef} className="mt-3 max-h-[55vh] space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-4">
        {(ticket.messages || []).map((m) => {
          const staff = m.author === 'agent';
          return (
            <div key={m.id} className={`flex ${staff ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${staff ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-white text-slate-800 shadow-sm ring-1 ring-slate-200'}`}>
                <div className={`mb-0.5 text-[11px] ${staff ? 'text-white/70' : 'text-slate-400'}`}>
                  {staff ? `Support${m.authorEmail ? ` · ${m.authorEmail}` : ''}` : (m.authorEmail || 'Customer')} · {new Date(m.ts).toLocaleString()}
                </div>
                {m.body && <div className="whitespace-pre-wrap text-sm">{m.body}</div>}
                {(m.attachments || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.attachments.map((a, i) => (
                      <a key={i} href={a.url} target="_blank" rel="noreferrer" className={`text-xs underline ${staff ? 'text-white/80' : 'text-brand-600'}`}>{a.name || 'attachment'}</a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {warn && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800">
          <span aria-hidden="true">⚠️</span>
          <span>{warn}</span>
          <button onClick={() => setWarn('')} className="ml-auto text-amber-500 hover:text-amber-700" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Reply as the support agent. */}
      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}
          rows={3}
          placeholder="Reply to the customer as Support…  (⌘/Ctrl + Enter to send)"
          className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">Emails + notifies {ticket.userEmail || 'the customer'}.</span>
          <button onClick={send} disabled={busy || !reply.trim()} className="btn-primary disabled:opacity-50">{busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </div>
    </div>
  );
}

// Provision a client or staff account by email (they link on first Google login).
function CreateUserDialog({ onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('client');
  const [tier, setTier] = useState('free');
  const [credits, setCredits] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!email.trim()) { setErr('Email is required.'); return; }
    setBusy(true);
    try {
      const { user } = await api.adminCreateUser({
        email: email.trim(), name: name.trim(), role, tier,
        credits: credits === '' ? undefined : Number(credits), sendInvite,
      });
      onCreated(user);
    } catch (e2) { setErr(e2?.payload?.error || 'Could not create the user.'); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold">Create user</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700" aria-label="Close">✕</button>
        </div>
        <p className="mt-1 text-sm text-slate-500">They sign in with Google using this email and link automatically.</p>
        {err && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        <label className="mt-3 block text-sm font-medium text-slate-700">Email <span className="text-red-500">*</span></label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-slate-700">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-slate-700">Role</label>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {[['client', 'Client', 'Uses tools, billed by plan'], ['staff', 'Staff', 'Full admin + support']].map(([v, t, d]) => (
            <button type="button" key={v} onClick={() => setRole(v)}
              className={`rounded-lg border p-2.5 text-left ${role === v ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200 hover:border-slate-300'}`}>
              <div className="text-sm font-medium">{t}</div>
              <div className="text-xs text-slate-500">{d}</div>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700">Plan</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)} className="dm-select mt-1 w-full rounded-lg border border-slate-300 py-2 pl-2 pr-8 text-sm">
              {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name} — {PLANS[t].monthlyCredits.toLocaleString()} cr</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Starting credits</label>
            <input type="number" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder={String(PLANS[tier]?.monthlyCredits ?? 0)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} className="h-4 w-4" /> Send invite email
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create user'}</button>
        </div>
      </form>
    </div>
  );
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
