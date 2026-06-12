import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { PLANS, TIER_ORDER } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';

// Admin-only console: view users, override tier, grant/deduct credits.
// Gated client-side here AND server-side (ADMIN_EMAILS) — the UI is a convenience.
export default function Admin() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (user.isAdmin) load();
  }, [user.isAdmin]);

  async function load() {
    setError('');
    try {
      const { users } = await api.adminUsers();
      setUsers(users || []);
    } catch (e) {
      setUsers([]);
      setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load users — please reload and try again.');
    }
  }

  if (!user.isAdmin) return <Navigate to="/" replace />;

  async function setTier(u, tier) {
    await api.adminTier(u.userId, tier);
    flash(`${u.email} → ${PLANS[tier].name}`);
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

  const rows = (users || []).filter(
    (u) => q === '' || (u.email + u.name).toLowerCase().includes(q.toLowerCase())
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin · Users</h1>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search email / name…"
          className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
        />
      </div>
      {msg && <div className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">{msg}</div>}
      {error && <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="card mt-5 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2">User</th>
              <th className="px-4 py-2">Tier</th>
              <th className="px-4 py-2 text-right">Monthly</th>
              <th className="px-4 py-2 text-right">Top-up</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2">Adjust credits</th>
            </tr>
          </thead>
          <tbody>
            {users === null && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">Loading…</td></tr>
            )}
            {rows.map((u) => (
              <tr key={u.userId} className="border-t border-slate-100">
                <td className="px-4 py-2">
                  <div className="font-medium">{u.name || '—'}</div>
                  <div className="text-xs text-slate-400">{u.email}</div>
                </td>
                <td className="px-4 py-2">
                  <select
                    value={u.tier}
                    onChange={(e) => setTier(u, e.target.value)}
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                  >
                    {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name}</option>)}
                  </select>
                </td>
                <td className="px-4 py-2 text-right">{(u.monthlyCredits ?? 0).toLocaleString()}</td>
                <td className="px-4 py-2 text-right text-brand-600">{(u.topupCredits ?? 0).toLocaleString()}</td>
                <td className="px-4 py-2 text-right font-semibold">{(u.credits ?? 0).toLocaleString()}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'monthly')}>± Monthly</button>
                    <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'topup')}>± Top-up</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        Tier changes reset the monthly allowance to that plan's amount; top-up credits are untouched. All adjustments are written to the credit ledger.
      </p>
    </div>
  );
}
