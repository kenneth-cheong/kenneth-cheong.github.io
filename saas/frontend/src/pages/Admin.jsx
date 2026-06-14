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
        {[['users', 'Users'], ['tickets', 'Support tickets']].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'users' ? <AdminUsers /> : <AdminTickets />}
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────
function AdminUsers() {
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setError('');
    try { const { users } = await api.adminUsers(); setUsers(users || []); }
    catch (e) { setUsers([]); setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load users — reload and try again.'); }
  }
  async function setTier(u, tier) { await api.adminTier(u.userId, tier); flash(`${u.email} → ${PLANS[tier].name}`); load(); }
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

  const rows = (users || []).filter((u) => q === '' || (u.email + u.name).toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button onClick={() => setCreating(true)} className="btn-primary px-3 py-2 text-sm">+ New user</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email / name…"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
      </div>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={(u) => { setCreating(false); flash(`Created ${u.email} (${u.role})`); load(); }} />}
      {msg && <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="card mt-3">
        <SortableTable
          rows={rows}
          rowKey={(u) => u.userId}
          emptyText={users === null ? 'Loading…' : 'No matching users.'}
          columns={[
            { key: 'user', label: 'User', accessor: (u) => u.name || u.email || '',
              render: (u) => (<><div className="font-medium">{u.name || '—'}</div><div className="text-xs text-slate-400">{u.email}</div></>) },
            { key: 'role', label: 'Role', accessor: (u) => u.role || 'client',
              render: (u) => (u.role === 'staff'
                ? <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">Staff</span>
                : <span className="text-xs text-slate-500">Client</span>) },
            { key: 'status', label: 'Status', accessor: (u) => u.status || 'active',
              render: (u) => (u.status === 'invited'
                ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Invited</span>
                : <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">Active</span>) },
            { key: 'tier', label: 'Tier', accessor: (u) => TIER_ORDER.indexOf(u.tier),
              render: (u) => (
                <select value={u.tier} onChange={(e) => setTier(u, e.target.value)} className="rounded border border-slate-300 px-2 py-1 text-sm">
                  {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name}</option>)}
                </select>) },
            { key: 'monthlyCredits', label: 'Monthly', align: 'right', numeric: true, render: (u) => (u.monthlyCredits ?? 0).toLocaleString() },
            { key: 'topupCredits', label: 'Top-up', align: 'right', numeric: true, render: (u) => <span className="text-brand-600">{(u.topupCredits ?? 0).toLocaleString()}</span> },
            { key: 'credits', label: 'Total', align: 'right', numeric: true, render: (u) => <span className="font-semibold">{(u.credits ?? 0).toLocaleString()}</span> },
            { key: 'adjust', label: 'Adjust credits', sortable: false, render: (u) => (
                <div className="flex gap-1">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'monthly')}>± Monthly</button>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'topup')}>± Top-up</button>
                </div>) },
          ]}
        />
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Tier changes reset the monthly allowance to that plan's amount; top-up credits are untouched. All adjustments are written to the credit ledger.
      </p>
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
  const threadRef = useRef(null);

  const load = () => api.adminTicket(summary.userId, summary.ticketId).then((d) => setTicket(d.ticket)).catch(() => setTicket(false));
  useEffect(() => { load(); }, [summary.ticketId]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [ticket]);

  async function send() {
    if (!reply.trim()) return;
    setBusy(true);
    try { const { ticket: t } = await api.adminReplyTicket(summary.userId, summary.ticketId, reply.trim()); setTicket(t); setReply(''); }
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
            <select value={tier} onChange={(e) => setTier(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-2 text-sm">
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
