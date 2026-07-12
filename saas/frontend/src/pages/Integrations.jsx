import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';
import { FAMILY_META } from '@shared/catalog.mjs';

const TOOL_FOR = { gsc: 'gsc', ga4: 'ga4', 'google-ads': 'google-ads', 'meta-ads': 'meta-ads', 'linkedin-ads': 'linkedin-ads' };
const LABELS = {
  gsc: 'Search Console property', ga4: 'GA4 property', 'google-ads': 'Google Ads account',
  'meta-ads': 'Meta ad account', 'linkedin-ads': 'LinkedIn ad account',
};
const NO_ACCOUNTS = {
  gsc: 'No Search Console sites on this Google account.',
  ga4: 'No GA4 properties on this Google account.',
  'google-ads': 'No Google Ads accounts on this Google account.',
  'meta-ads': 'No ad accounts on this Meta account.',
  'linkedin-ads': 'No ad accounts on this LinkedIn account.',
};

// Each provider belongs to a "family" that shares one OAuth consent: Google's
// sign-in connects Search Console, Analytics & Ads; Meta and LinkedIn each
// connect a single Ads source. We render one connect card per family, then a
// per-source account picker beneath it. Mirrors index.html for Google.
export default function Integrations() {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({});
  const [lastPull, setLastPull] = useState({});
  const [busy, setBusy] = useState(''); // family id currently redirecting / disconnecting
  const [params, setParams] = useSearchParams();

  const load = () => api.integrations().then((d) => { setProviders(d.providers || []); setConnected(d.connected || {}); setLastPull(d.lastPull || {}); }).catch(() => {});
  useEffect(() => { load(); }, []);

  const justConnected = params.get('connected');
  const oauthError = params.get('error');
  useEffect(() => {
    if (justConnected || oauthError) {
      load();
      const t = setTimeout(() => setParams({}, { replace: true }), 4000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line
  }, [justConnected, oauthError]);

  // Group the configured providers into consent families, preserving catalog order.
  const families = [];
  const byFamily = {};
  for (const p of providers) {
    const fam = p.family || 'google';
    if (!byFamily[fam]) { byFamily[fam] = { id: fam, meta: FAMILY_META[fam] || {}, sources: [] }; families.push(byFamily[fam]); }
    byFamily[fam].sources.push(p);
  }
  const famConnected = (fam) => fam.sources.some((p) => connected[p.id]?.connected);
  // A family is connectable only if its OAuth is wired up on this deployment
  // (e.g. Meta is pending app review) — otherwise we show "Coming soon".
  const famConfigured = (fam) => fam.sources.some((p) => p.configured);

  async function connectFamily(fam) {
    setBusy(fam.id);
    try {
      const { url } = await api.authorizeIntegration(fam.meta.authVia || fam.sources[0]?.id);
      window.location.href = url;
    } catch (e) {
      setBusy('');
      alert(e.message || 'Could not start sign-in.');
    }
  }
  async function disconnectFamily(fam) {
    if (!window.confirm(`Disconnect your ${fam.meta.label || 'account'}?`)) return;
    setBusy(fam.id);
    try { await Promise.all(fam.sources.map((p) => api.connectIntegration(p.id, '', false))); await load(); }
    finally { setBusy(''); }
  }
  // Per-source connect: auth a *different* account for just this source (e.g.
  // the client's Google account for Search Console, the agency's for Ads).
  async function connectSource(p) {
    setBusy(p.id);
    try {
      const { url } = await api.authorizeIntegration(p.id, { single: true });
      window.location.href = url;
    } catch (e) {
      setBusy('');
      alert(e.message || 'Could not start sign-in.');
    }
  }
  // Per-source disconnect: clears just this tool's selected account, keeping the
  // shared family sign-in so the user can re-pick without re-consenting.
  async function disconnectSource(fam, p) {
    if (!window.confirm(`Disconnect ${p.name}? This clears its selected account but keeps your ${fam.meta.label || 'account'} sign-in.`)) return;
    setBusy(p.id);
    try { await api.clearIntegrationAccount(p.id); await load(); }
    finally { setBusy(''); }
  }

  const connectedLabel = justConnected && (FAMILY_META[justConnected]?.label || 'Account');
  const shortName = (fam) => (fam.meta.label || fam.id).replace(/ account$/, '');

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Connect your data</h1>
      <p className="mt-1 text-dim">
        Connect your ad &amp; analytics accounts to pull your own performance data — free of credits, and queryable by the assistant.
      </p>

      {justConnected && <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-500/10 px-4 py-2 text-sm text-green-700 dark:text-green-300"><Check size={15} aria-hidden /> {connectedLabel} connected. Pick an account for each source below.</div>}
      {oauthError && <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300"><AlertTriangle size={15} aria-hidden /> Sign-in failed. Please try again.</div>}

      <div className="mt-6 space-y-6">
        {families.map((fam) => {
          const isConn = famConnected(fam);
          const isConfigured = famConfigured(fam);
          const redirecting = busy === fam.id;
          return (
            <div key={fam.id}>
              {/* One connection per family */}
              <div className="card p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-sunken text-sm font-bold text-muted">{fam.meta.icon || '•'}</div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{fam.meta.label || fam.id}</div>
                    <div className="text-sm text-muted">{fam.meta.blurb}</div>
                  </div>
                  {!isConfigured ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-xs font-semibold text-muted" title="This connector is awaiting platform approval — you can still enter an account ID manually inside the tool.">Coming soon</span>
                  ) : isConn ? (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-500/15 px-2.5 py-1 text-xs font-semibold text-green-700 dark:text-green-300"><Check size={13} aria-hidden /> Connected</span>
                      <button onClick={() => connectFamily(fam)} disabled={redirecting} className="btn-ghost px-3 py-1.5 text-sm">{redirecting ? '…' : 'Reconnect'}</button>
                      <button onClick={() => disconnectFamily(fam)} disabled={redirecting} className="text-sm text-muted hover:text-red-600 dark:hover:text-red-400">Disconnect</button>
                    </>
                  ) : (
                    <button onClick={() => connectFamily(fam)} disabled={redirecting} className="btn-primary px-3 py-1.5 text-sm">{redirecting ? 'Redirecting…' : `Connect ${shortName(fam)}`}</button>
                  )}
                </div>
              </div>

              {/* Per-source account selectors (each independent) */}
              {isConn && (
                <div className="mt-3 space-y-3">
                  {fam.sources.map((p) => (
                    <div key={p.id} className="card p-4">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="grid h-8 w-8 place-items-center rounded-lg bg-sunken text-xs font-bold text-muted">{fam.meta.icon || '•'}</div>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold">{p.name}</div>
                          <div className="text-sm text-muted">{p.blurb}</div>
                          {connected[p.id]?.email && (
                            <div className="mt-0.5 truncate text-xs text-faint">Signed in as {connected[p.id].email}</div>
                          )}
                        </div>
                        {connected[p.id]?.account
                          ? <span className="inline-flex items-center gap-1 rounded-full bg-green-100 dark:bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-300"><Check size={12} aria-hidden /> Active</span>
                          : <span className="rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">Pick an account</span>}
                        <Link to={`/tool/${TOOL_FOR[p.id]}`} className="btn-ghost px-3 py-1.5 text-sm">Open tool</Link>
                        {/* Only families with >1 source (Google) benefit from a per-source login;
                            for single-source families the family Reconnect already covers it. */}
                        {fam.sources.length > 1 && (
                          <button onClick={() => connectSource(p)} disabled={busy === p.id} className="text-sm text-muted hover:text-brand-600 dark:hover:text-brand-400">{busy === p.id ? '…' : 'Different account'}</button>
                        )}
                        {connected[p.id]?.account && (
                          <button onClick={() => disconnectSource(fam, p)} disabled={busy === p.id} className="text-sm text-muted hover:text-red-600 dark:hover:text-red-400">Disconnect</button>
                        )}
                      </div>
                      <PullHealth pull={lastPull[p.id]} />
                      <AccountPicker provider={p.id} current={connected[p.id]?.account} onSaved={load} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {!families.length && (
          <div className="card p-8 text-center">
            <p className="font-semibold text-heading">Nothing to connect here yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-dim">
              Connections to Google and social accounts aren’t switched on for this workspace. If you expected to see them, we can help.
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: 'The Connect your data page says nothing is available to connect. What does that mean and what should I do?' } }))}
              className="btn-ghost mt-4 text-sm"
            >
              Ask Monty
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60) || 1}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Health of the most recent pull for this source — surfaces "data flowing" vs
// "no data" / "failed" so a selected-but-broken source is obvious.
function PullHealth({ pull }) {
  const m = {
    ok: { dot: 'bg-green-500', text: 'Data flowing', cls: 'text-muted' },
    empty: { dot: 'bg-amber-500', text: 'Last pull returned no data', cls: 'text-amber-700 dark:text-amber-300' },
    issue: { dot: 'bg-red-500', text: 'Last pull failed — try Reconnect', cls: 'text-red-600 dark:text-red-400' },
  }[pull?.status];
  if (!m) return null;
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} aria-hidden />
      <span className={m.cls}>{m.text}</span>
      {pull.at && <span className="text-slate-300">· {ago(pull.at)}</span>}
    </div>
  );
}

// Lists the accounts/properties the connected user can access and lets them pick
// the one this source should pull. Independent per source.
function AccountPicker({ provider, current, onSaved }) {
  const [accounts, setAccounts] = useState(null);
  const [saving, setSaving] = useState(false);

  const fetchAccounts = () => { setAccounts(null); api.integrationAccounts(provider).then((d) => setAccounts(d.accounts || [])).catch(() => setAccounts([])); };
  useEffect(() => { fetchAccounts(); /* eslint-disable-next-line */ }, [provider]);

  async function choose(id) {
    if (!id || id === current) return;
    setSaving(true);
    try { await api.connectIntegration(provider, id, true); onSaved(); } finally { setSaving(false); }
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-3">
      <span className="shrink-0 text-xs font-medium text-muted">{LABELS[provider] || 'Account'}:</span>
      {accounts === null ? (
        <span className="text-xs text-faint">loading…</span>
      ) : accounts.length ? (
        <select
          value={current || ''} disabled={saving}
          onChange={(e) => choose(e.target.value)}
          className="dm-select min-w-0 max-w-full flex-1 rounded-lg border border-edge py-1.5 pl-2.5 pr-8 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="" disabled>Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs text-faint">
          {current || NO_ACCOUNTS[provider] || 'No accessible accounts found.'}
          <button onClick={fetchAccounts} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Refresh</button>
        </span>
      )}
    </div>
  );
}
