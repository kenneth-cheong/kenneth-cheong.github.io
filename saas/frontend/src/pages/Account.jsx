import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PartyPopper, Zap } from 'lucide-react';
import { PLANS, TOPUP_PACKS, CURRENCY } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';

export default function Account() {
  const { user, refresh, logout } = useAuth();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [topupBusy, setTopupBusy] = useState(null);
  const [docs, setDocs] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [delText, setDelText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [sessions, setSessions] = useState(null);
  const [grants, setGrants] = useState(null);
  const plan = PLANS[user.tier];
  // The current device's session id lives in the refresh token (decode locally).
  const currentSid = (() => {
    try { return JSON.parse(atob((localStorage.getItem('dm_refresh') || '').split('.')[1])).sid; } catch { return null; }
  })();

  // Returning from Stripe Checkout / top-up → pull the fresh tier + credits.
  useEffect(() => {
    if (params.get('checkout') === 'success' || params.get('topup') === 'success') refresh();
  }, [params, refresh]);

  useEffect(() => { api.invoices().then((d) => setDocs(d.documents || [])).catch(() => setDocs([])); }, []);
  useEffect(() => { api.me().then((d) => setSessions(d.user?.sessions || [])).catch(() => setSessions([])); }, []);
  useEffect(() => { api.accessRequests().then((d) => setGrants(d.grants || [])).catch(() => setGrants([])); }, []);

  async function answerAccess(id, action) {
    setGrants((g) => (g || []).map((x) => (x.id === id ? { ...x, status: action === 'grant' ? 'granted' : action === 'deny' ? 'denied' : 'revoked' } : x)));
    try {
      await api.respondAccess(id, action);
      toast(action === 'grant' ? 'Access granted for 7 days.' : action === 'revoke' ? 'Access revoked.' : 'Request denied.', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }
  const liveGrants = (grants || []).filter((g) => g.status === 'pending' || (g.status === 'granted' && (!g.expiresAt || g.expiresAt > new Date().toISOString())));

  async function revokeDevice(sid) {
    setSessions((s) => (s || []).filter((x) => x.sid !== sid));
    try { await api.revokeSession(sid); if (sid === currentSid) logout(); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function buyTopup(packId) {
    setTopupBusy(packId);
    try {
      const { url } = await api.topup(packId);
      window.location.href = url;
    } finally {
      setTopupBusy(null);
    }
  }

  async function openPortal() {
    setBusy(true);
    try {
      const { url } = await api.portal();
      window.location.href = url;
    } finally {
      setBusy(false);
    }
  }

  async function exportData() {
    setExporting(true);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `digimetrics-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, 'error'); }
    finally { setExporting(false); }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      await api.deleteAccount();
      logout(); // clears tokens + user → app redirects to the sign-in screen
    } catch (e) { toast(e.message, 'error'); setDeleting(false); }
  }

  async function signOutEverywhere() {
    setRevoking(true);
    try {
      await api.revokeSessions();
      logout(); // invalidates other devices' refresh tokens; sign out here too
    } catch (e) { toast(e.message, 'error'); setRevoking(false); }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold">Account</h1>

      {params.get('checkout') === 'success' && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          <PartyPopper size={16} aria-hidden /> You're on {plan.name}. Credits have been topped up.
        </div>
      )}
      {params.get('topup') === 'success' && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800">
          <Zap size={16} aria-hidden /> Top-up successful — credits added to your balance.
        </div>
      )}

      <div className="card mt-6 p-5">
        <div className="flex items-center gap-3">
          {user.picture && <img src={user.picture} alt="" className="h-10 w-10 rounded-full" />}
          <div>
            <p className="font-semibold">{user.name}</p>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-slate-500">Current plan</p>
            <p className="text-xl font-bold">{plan.name}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-slate-500">Credits left</p>
            <p className="text-xl font-bold">{user.credits.toLocaleString()}</p>
            <p className="text-xs text-slate-400">
              {(user.monthlyCredits ?? user.credits).toLocaleString()} monthly
              {(user.topupCredits || 0) > 0 && <> · {user.topupCredits.toLocaleString()} top-up</>}
            </p>
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <Link to="/pricing" className="btn-primary">Change plan</Link>
          {user.hasSubscription && (
            <button onClick={openPortal} disabled={busy} className="btn-ghost">
              {busy ? '…' : 'Manage billing'}
            </button>
          )}
        </div>
        {user.hasSubscription && (
          <p className="mt-3 text-xs text-slate-400">
            Manage billing opens the Stripe Customer Portal — update card, download invoices, or cancel.
          </p>
        )}
      </div>

      {/* ── Invoices & receipts ───────────────────────────────────────── */}
      {docs && docs.length > 0 && (
        <div className="card mt-4 p-5">
          <h2 className="font-bold">Invoices &amp; receipts</h2>
          <p className="mt-1 text-sm text-slate-500">Your subscription invoices and one-time top-up receipts.</p>
          <div className="mt-4 divide-y divide-slate-100">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-800">
                    {d.type === 'invoice' ? (d.number || 'Invoice') : 'Receipt'}
                    <span className="font-normal text-slate-400"> · {d.description}</span>
                  </div>
                  <div className="text-xs text-slate-400">{new Date(d.created * 1000).toLocaleDateString()}</div>
                </div>
                <span className="text-sm font-semibold tabular-nums">{money(d.amount, d.currency)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${d.status === 'paid' || d.status === 'succeeded' ? 'bg-green-100 text-green-700' : d.status === 'refunded' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{d.status}</span>
                <div className="flex gap-2">
                  {d.pdf && <a href={d.pdf} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-600 hover:text-brand-700">Download</a>}
                  {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-slate-500 hover:text-slate-800">{d.pdf ? 'View' : 'Receipt'}</a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Credit top-ups (overage) ──────────────────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Need more credits?</h2>
        <p className="mt-1 text-sm text-slate-500">
          One-time top-ups for when you run low mid-cycle. Top-up credits <strong>roll over</strong> — they don't expire at renewal.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {TOPUP_PACKS.map((pack) => (
            <div key={pack.id} className={`rounded-lg border p-4 text-center ${pack.popular ? 'border-brand-400 bg-brand-50' : 'border-slate-200'}`}>
              {pack.popular && <span className="mb-1 inline-block rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">BEST VALUE</span>}
              <p className="text-lg font-bold">{pack.credits.toLocaleString()} credits</p>
              <p className="text-sm text-slate-500">{CURRENCY.symbol}{pack.price}</p>
              <button
                onClick={() => buyTopup(pack.id)}
                disabled={topupBusy === pack.id}
                className="btn-ghost mt-3 w-full"
              >
                {topupBusy === pack.id ? '…' : 'Buy'}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── Active devices (concurrent-session cap) ────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Active devices</h2>
        <p className="mt-1 text-sm text-slate-500">You can be signed in on up to 3 devices. Signing in on a 4th signs out the oldest.</p>
        {sessions === null ? (
          <p className="mt-3 text-sm text-slate-400">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No tracked sessions yet — sign in again to register this device.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {sessions.map((s) => (
              <li key={s.sid} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800">
                    {s.device || 'Unknown device'}
                    {s.sid === currentSid && <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700">This device</span>}
                  </div>
                  <div className="text-xs text-slate-400">{s.ip ? `${s.ip} · ` : ''}active {ago(s.lastSeenAt)}</div>
                </div>
                <button onClick={() => revokeDevice(s.sid)} className="text-sm text-slate-400 hover:text-red-600">
                  {s.sid === currentSid ? 'Sign out' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Data access requests (consent-gated admin access) ──────────── */}
      {liveGrants.length > 0 && (
        <div className="card mt-4 p-5">
          <h2 className="font-bold">Data access requests</h2>
          <p className="mt-1 text-sm text-slate-500">Support can view your tool usage and chatbot conversations only if you allow it. Approvals last 7 days — you can revoke anytime.</p>
          <ul className="mt-3 divide-y divide-slate-100">
            {liveGrants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800">
                    {g.requestedBy || 'Support'}{g.reason ? <span className="font-normal text-slate-500"> — “{g.reason}”</span> : ''}
                  </div>
                  <div className="text-xs text-slate-400">
                    {g.status === 'pending' ? `Requested ${ago(g.requestedAt)}` : `Allowed · expires ${new Date(g.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                {g.status === 'pending' ? (
                  <div className="flex gap-2">
                    <button onClick={() => answerAccess(g.id, 'grant')} className="btn-primary px-3 py-1.5 text-sm">Allow 7 days</button>
                    <button onClick={() => answerAccess(g.id, 'deny')} className="btn-ghost px-3 py-1.5 text-sm">Deny</button>
                  </div>
                ) : (
                  <button onClick={() => answerAccess(g.id, 'revoke')} className="text-sm text-slate-400 hover:text-red-600">Revoke access</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Your data (export + delete) ────────────────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Your data</h2>
        <p className="mt-1 text-sm text-slate-500">
          Download everything we hold about you, or permanently delete your account. See our{' '}
          <Link to="/legal/privacy" className="text-brand-600 hover:text-brand-700">Privacy Policy</Link> and{' '}
          <Link to="/legal/terms" className="text-brand-600 hover:text-brand-700">Terms</Link>.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button onClick={exportData} disabled={exporting} className="btn-ghost">{exporting ? 'Preparing…' : 'Export my data'}</button>
          <button onClick={signOutEverywhere} disabled={revoking} className="btn-ghost">{revoking ? 'Signing out…' : 'Sign out everywhere'}</button>
          <button onClick={() => { setDelText(''); setConfirmDel(true); }} className="rounded-lg border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">Delete account</button>
        </div>
        <p className="mt-2 text-xs text-slate-400">“Sign out everywhere” ends sessions on all your other devices.</p>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !deleting && setConfirmDel(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-red-600">Delete your account?</h2>
            <p className="mt-2 text-sm text-slate-600">
              This permanently deletes your profile, run history, projects, tracked keywords, conversations, support tickets and credit history.
              {user.hasSubscription && ' Your active subscription will be cancelled.'} This cannot be undone.
            </p>
            <p className="mt-3 text-sm text-slate-600">Type <strong>DELETE</strong> to confirm:</p>
            <input value={delText} onChange={(e) => setDelText(e.target.value)} placeholder="DELETE"
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-red-400 focus:outline-none" />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDel(false)} disabled={deleting} className="btn-ghost text-sm">Cancel</button>
              <button onClick={deleteAccount} disabled={deleting || delText !== 'DELETE'}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                {deleting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ago(iso) {
  if (!iso) return 'recently';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function money(amountCents, currency) {
  try {
    return ((amountCents || 0) / 100).toLocaleString(undefined, { style: 'currency', currency: (currency || 'sgd').toUpperCase() });
  } catch {
    return `${((amountCents || 0) / 100).toFixed(2)} ${(currency || '').toUpperCase()}`;
  }
}
