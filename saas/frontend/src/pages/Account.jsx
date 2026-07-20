import { useEffect, useState } from 'react';
import { Link, useSearchParams, useLocation } from 'react-router-dom';
import { PartyPopper, Zap } from 'lucide-react';
import { PLANS, TOPUP_PACKS, CURRENCY } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';

export default function Account() {
  const { user, refresh, logout } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
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
  const [emailOptOut, setEmailOptOut] = useState(null); // null = loading
  const [emailBusy, setEmailBusy] = useState(false);
  const [uname, setUname] = useState(user.username || '');
  const [unameBusy, setUnameBusy] = useState(false);
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

  // Deep-link from the "Billing" nav item → scroll to the invoices section once
  // it has rendered (docs load async, so wait for them).
  useEffect(() => {
    if (location.hash !== '#billing' || !docs) return;
    document.getElementById('billing')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash, docs]);
  useEffect(() => { api.me().then((d) => { setSessions(d.user?.sessions || []); setEmailOptOut(!!d.user?.emailOptOut); }).catch(() => setSessions([])); }, []);
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

  async function saveUsername(e) {
    e.preventDefault();
    const next = uname.trim();
    if (next === (user.username || '')) return;
    setUnameBusy(true);
    try {
      await api.saveUsername(next);
      await refresh(); // pull the claimed handle back into context
      toast('Username saved.', 'success');
    } catch (err) {
      // The backend owns the taken/invalid wording — surface it as-is.
      toast(err?.payload?.error || err.message || 'Could not save username.', 'error');
      setUname(user.username || '');
    } finally {
      setUnameBusy(false);
    }
  }

  async function toggleEmailPref(nextOptOut) {
    setEmailBusy(true);
    setEmailOptOut(nextOptOut); // optimistic
    try { await api.setEmailPrefs(nextOptOut); toast(nextOptOut ? 'Unsubscribed from product updates.' : 'Subscribed to product updates.', 'success'); }
    catch (e) { setEmailOptOut(!nextOptOut); toast(e.message, 'error'); }
    finally { setEmailBusy(false); }
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
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-500/10 px-4 py-3 text-sm text-green-800 dark:text-green-300">
          <PartyPopper size={16} aria-hidden /> You're on {plan.name}. Credits have been topped up.
        </div>
      )}
      {params.get('topup') === 'success' && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-500/10 px-4 py-3 text-sm text-green-800 dark:text-green-300">
          <Zap size={16} aria-hidden /> Top-up successful — credits added to your balance.
        </div>
      )}

      <div className="card mt-6 p-5">
        <div className="flex items-center gap-3">
          {user.picture && <img src={user.picture} alt="" className="h-10 w-10 rounded-full" />}
          <div>
            <p className="font-semibold">{user.name}</p>
            <p className="text-sm text-muted">{user.email}</p>
            {user.username && <p className="text-sm text-muted">@{user.username}</p>}
          </div>
        </div>
      </div>

      {/* ── Username ──────────────────────────────────────────────────────
          Opt-in: without one you just keep signing in with your email. Shown
          regardless of the admin toggle so handles can be claimed before
          username sign-in is switched on. */}
      <form className="card mt-4 p-5" onSubmit={saveUsername}>
        <h2 className="font-bold">Username</h2>
        <p className="mt-1 text-sm text-muted">
          Optional. Claim a username and you can sign in with it instead of your email address.
          Your email always keeps working.
        </p>
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <label className="min-w-[16rem] flex-1">
            <span className="sr-only">Username</span>
            <input
              type="text" value={uname} onChange={(e) => setUname(e.target.value)}
              placeholder="yourname" className="field" autoComplete="username"
              minLength={3} maxLength={30} aria-describedby="uname-help"
            />
          </label>
          <button type="submit" disabled={unameBusy || uname.trim() === (user.username || '')} className="btn-primary">
            {unameBusy ? '…' : user.username ? 'Change' : 'Claim'}
          </button>
        </div>
        <p id="uname-help" className="mt-2 text-xs text-faint">
          3–30 characters: letters, numbers, and . _ - — starting and ending with a letter or number.
        </p>
      </form>

      <div className="card mt-4 p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted">Current plan</p>
            <p className="text-xl font-bold">{plan.name}</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted">Credits left</p>
            <p className="text-xl font-bold">{user.credits.toLocaleString()}</p>
            <p className="text-xs text-faint">
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
          <p className="mt-3 text-xs text-faint">
            Manage billing opens the Stripe Customer Portal — update card, download invoices, or cancel.
          </p>
        )}
      </div>

      {/* ── Invoices & receipts ───────────────────────────────────────── */}
      <div id="billing" className="card mt-4 scroll-mt-20 p-5">
        <h2 className="font-bold">Invoices &amp; receipts</h2>
        <p className="mt-1 text-sm text-muted">Your subscription invoices and one-time top-up receipts.</p>
        {docs && docs.length === 0 && (
          <p className="mt-4 text-sm text-faint">No invoices or receipts yet — they'll appear here after your first payment.</p>
        )}
        {docs && docs.length > 0 && (
          <div className="mt-4 divide-y divide-hair">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-strong">
                    {d.type === 'invoice' ? (d.number || 'Invoice') : 'Receipt'}
                    <span className="font-normal text-faint"> · {d.description}</span>
                  </div>
                  <div className="text-xs text-faint">{new Date(d.created * 1000).toLocaleDateString()}</div>
                </div>
                <span className="text-sm font-semibold tabular-nums">{money(d.amount, d.currency)}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${d.status === 'paid' || d.status === 'succeeded' ? 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300' : d.status === 'refunded' ? 'bg-sunken text-muted' : 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>{d.status}</span>
                <div className="flex gap-2">
                  {/* Invoices have a PDF (the hosted page just duplicates it) → one link.
                      Receipts have no PDF, only a hosted receipt URL → fall back to that. */}
                  {d.pdf
                    ? <a href={d.pdf} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Download</a>
                    : d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-muted hover:text-strong">{d.type === 'invoice' ? 'View' : 'Receipt'}</a>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Credit top-ups (overage) ──────────────────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Need more credits?</h2>
        <p className="mt-1 text-sm text-muted">
          One-time top-ups for when you run low mid-cycle. Top-up credits <strong>roll over</strong> — they don't expire at renewal, and stay valid for 12 months from purchase.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {TOPUP_PACKS.map((pack) => (
            <div key={pack.id} className={`rounded-lg border p-4 text-center ${pack.popular ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10' : 'border-line'}`}>
              {pack.popular && <span className="mb-1 inline-block rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold text-white">BEST VALUE</span>}
              <p className="text-lg font-bold">{pack.credits.toLocaleString()} credits</p>
              <p className="text-sm text-muted">{CURRENCY.symbol}{pack.price}</p>
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
        <p className="mt-1 text-sm text-muted">You can be signed in on up to 3 devices. Signing in on a 4th signs out the oldest.</p>
        {sessions === null ? (
          <p className="mt-3 text-sm text-faint">Loading…</p>
        ) : sessions.length === 0 ? (
          <p className="mt-3 text-sm text-faint">No tracked sessions yet — sign in again to register this device.</p>
        ) : (
          <ul className="mt-3 divide-y divide-hair">
            {sessions.map((s) => (
              <li key={s.sid} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-strong">
                    {s.device || 'Unknown device'}
                    {s.sid === currentSid && <span className="ml-2 rounded-full bg-green-100 dark:bg-green-500/15 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:text-green-300">This device</span>}
                  </div>
                  <div className="text-xs text-faint">{s.ip ? `${s.ip} · ` : ''}active {ago(s.lastSeenAt)}</div>
                </div>
                <button onClick={() => revokeDevice(s.sid)} className="text-sm text-faint hover:text-red-600 dark:hover:text-red-400">
                  {s.sid === currentSid ? 'Sign out' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Email preferences (product-update broadcasts) ──────────────── */}
      <div className="card mt-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-bold">Email preferences</h2>
            <p className="mt-1 text-sm text-muted">
              Product updates &amp; announcements. Account emails (sign-in, billing, and support
              replies) are always sent and aren't affected by this.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={emailOptOut === false}
            disabled={emailBusy || emailOptOut === null}
            onClick={() => toggleEmailPref(!emailOptOut)}
            className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${emailOptOut === false ? 'bg-brand-600' : 'bg-overlay'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${emailOptOut === false ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        {emailOptOut !== null && (
          <p className="mt-3 text-sm font-medium">
            Product-update emails:{' '}
            <span className={emailOptOut === false ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}>{emailOptOut === false ? 'On' : 'Off'}</span>
          </p>
        )}
      </div>

      {/* ── Data access requests (consent-gated admin access) ──────────── */}
      {liveGrants.length > 0 && (
        <div className="card mt-4 p-5">
          <h2 className="font-bold">Data access requests</h2>
          <p className="mt-1 text-sm text-muted">Support can view your tool usage and chatbot conversations only if you allow it. Approvals last 7 days — you can revoke anytime.</p>
          <ul className="mt-3 divide-y divide-hair">
            {liveGrants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-strong">
                    {g.requestedBy || 'Support'}{g.reason ? <span className="font-normal text-muted"> — “{g.reason}”</span> : ''}
                  </div>
                  <div className="text-xs text-faint">
                    {g.status === 'pending' ? `Requested ${ago(g.requestedAt)}` : `Allowed · expires ${new Date(g.expiresAt).toLocaleDateString()}`}
                  </div>
                </div>
                {g.status === 'pending' ? (
                  <div className="flex gap-2">
                    <button onClick={() => answerAccess(g.id, 'grant')} className="btn-primary px-3 py-1.5 text-sm">Allow 7 days</button>
                    <button onClick={() => answerAccess(g.id, 'deny')} className="btn-ghost px-3 py-1.5 text-sm">Deny</button>
                  </div>
                ) : (
                  <button onClick={() => answerAccess(g.id, 'revoke')} className="text-sm text-faint hover:text-red-600 dark:hover:text-red-400">Revoke access</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Your data (export + delete) ────────────────────────────────── */}
      <div className="card mt-4 p-5">
        <h2 className="font-bold">Your data</h2>
        <p className="mt-1 text-sm text-muted">
          Download everything we hold about you, or permanently delete your account. See our{' '}
          <Link to="/legal/privacy" className="text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Privacy Notice</Link> and{' '}
          <Link to="/legal/terms" className="text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Terms</Link>.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button onClick={exportData} disabled={exporting} className="btn-ghost">{exporting ? 'Preparing…' : 'Export my data'}</button>
          <button onClick={signOutEverywhere} disabled={revoking} className="btn-ghost">{revoking ? 'Signing out…' : 'Sign out everywhere'}</button>
          <button onClick={() => { setDelText(''); setConfirmDel(true); }} className="rounded-lg border border-red-200 dark:border-red-500/30 px-4 py-2 text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">Delete account</button>
        </div>
        <p className="mt-2 text-xs text-faint">“Sign out everywhere” ends sessions on all your other devices.</p>
      </div>

      {confirmDel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !deleting && setConfirmDel(false)}>
          <div className="w-full max-w-md rounded-xl bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-red-600 dark:text-red-400">Delete your account?</h2>
            <p className="mt-2 text-sm text-dim">
              This permanently deletes your profile, run history, projects, tracked keywords, conversations, support tickets and credit history.
              {user.hasSubscription && ' Your active subscription will be cancelled.'} This cannot be undone.
            </p>
            <p className="mt-3 text-sm text-dim">Type <strong>DELETE</strong> to confirm:</p>
            <input value={delText} onChange={(e) => setDelText(e.target.value)} placeholder="DELETE"
              className="mt-2 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-red-400 focus:outline-none" />
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
