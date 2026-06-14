import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';

const TOOL_FOR = { gsc: 'gsc', ga4: 'ga4', 'google-ads': 'google-ads' };
const LABELS = { gsc: 'Search Console property', ga4: 'GA4 property', 'google-ads': 'Google Ads account' };
const NO_ACCOUNTS = {
  gsc: 'No Search Console sites on this Google account.',
  ga4: 'No GA4 properties on this Google account.',
  'google-ads': 'No Google Ads accounts on this Google account.',
};

// One Google sign-in connects Search Console, Analytics and Ads (the consent
// grants all three scopes). Each source then has its own property/account
// dropdown, so they can point at different accounts — mirrors index.html.
export default function Integrations() {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({});
  const [lastPull, setLastPull] = useState({});
  const [busy, setBusy] = useState(false);
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

  const anyConnected = Object.values(connected).some((c) => c?.connected);

  async function connectGoogle() {
    setBusy(true);
    try {
      const { url } = await api.authorizeIntegration('gsc'); // one consent → all 3 sources
      window.location.href = url;
    } catch (e) {
      setBusy(false);
      alert(e.message || 'Could not start Google sign-in.');
    }
  }
  async function disconnectAll() {
    if (!window.confirm('Disconnect your Google account from all three sources?')) return;
    setBusy(true);
    try { await Promise.all(providers.map((p) => api.connectIntegration(p.id, '', false))); await load(); }
    finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Integrations</h1>
      <p className="mt-1 text-slate-600">
        Connect your Google account once to pull your own Search Console, Analytics and Ads data — free of credits, and queryable by the assistant.
      </p>

      {justConnected && <div className="mt-4 flex items-center gap-2 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700"><Check size={15} aria-hidden /> Google connected. Pick a property/account for each source below.</div>}
      {oauthError && <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700"><AlertTriangle size={15} aria-hidden /> Google sign-in failed. Please try again.</div>}

      {/* One Google connection for all three sources */}
      <div className="card mt-6 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 text-lg font-bold text-slate-500">G</div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Google account</div>
            <div className="text-sm text-slate-500">One sign-in connects Search Console, Analytics &amp; Ads.</div>
          </div>
          {anyConnected ? (
            <>
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700"><Check size={13} aria-hidden /> Connected</span>
              <button onClick={connectGoogle} disabled={busy} className="btn-ghost px-3 py-1.5 text-sm">{busy ? '…' : 'Reconnect'}</button>
              <button onClick={disconnectAll} disabled={busy} className="text-sm text-slate-500 hover:text-red-600">Disconnect</button>
            </>
          ) : (
            <button onClick={connectGoogle} disabled={busy} className="btn-primary px-3 py-1.5 text-sm">{busy ? 'Redirecting…' : 'Connect with Google'}</button>
          )}
        </div>
      </div>

      {/* Per-source property / account selectors (each independent) */}
      {anyConnected ? (
        <div className="mt-4 space-y-3">
          {providers.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100 text-xs font-bold text-slate-500">G</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-sm text-slate-500">{p.blurb}</div>
                </div>
                {connected[p.id]?.account
                  ? <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700"><Check size={12} aria-hidden /> Active</span>
                  : <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Pick an account</span>}
                <Link to={`/tool/${TOOL_FOR[p.id]}`} className="btn-ghost px-3 py-1.5 text-sm">Open tool</Link>
              </div>
              <PullHealth pull={lastPull[p.id]} />
              <AccountPicker provider={p.id} current={connected[p.id]?.account} onSaved={load} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-4 text-sm text-slate-400">
          Not connected yet — sign in above to choose your Search Console property, GA4 property and Ads account.
        </p>
      )}
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
    ok: { dot: 'bg-green-500', text: 'Data flowing', cls: 'text-slate-500' },
    empty: { dot: 'bg-amber-500', text: 'Last pull returned no data', cls: 'text-amber-700' },
    issue: { dot: 'bg-red-500', text: 'Last pull failed — try Reconnect', cls: 'text-red-600' },
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

// Lists the properties/accounts the connected Google user can access and lets
// them pick the one this source should pull. Independent per source.
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
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
      <span className="shrink-0 text-xs font-medium text-slate-500">{LABELS[provider] || 'Account'}:</span>
      {accounts === null ? (
        <span className="text-xs text-slate-400">loading…</span>
      ) : accounts.length ? (
        <select
          value={current || ''} disabled={saving}
          onChange={(e) => choose(e.target.value)}
          className="dm-select min-w-0 max-w-full flex-1 rounded-lg border border-slate-300 py-1.5 pl-2.5 pr-8 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="" disabled>Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      ) : (
        <span className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {current || NO_ACCOUNTS[provider] || 'No accessible accounts found.'}
          <button onClick={fetchAccounts} className="font-medium text-brand-600 hover:text-brand-700">Refresh</button>
        </span>
      )}
    </div>
  );
}
