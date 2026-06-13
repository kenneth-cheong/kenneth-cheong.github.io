import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const TOOL_FOR = { gsc: 'gsc', ga4: 'ga4', 'google-ads': 'google-ads' };
const LABELS = { gsc: 'Search Console property', ga4: 'GA4 property', 'google-ads': 'Google Ads account' };

// One Google sign-in connects Search Console, Analytics and Ads (the consent
// grants all three scopes). Each source then has its own property/account
// dropdown, so they can point at different accounts — mirrors index.html.
export default function Integrations() {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({});
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();

  const load = () => api.integrations().then((d) => { setProviders(d.providers || []); setConnected(d.connected || {}); }).catch(() => {});
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

      {justConnected && <div className="mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">✓ Google connected. Pick a property/account for each source below.</div>}
      {oauthError && <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ Google sign-in failed. Please try again.</div>}

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
              <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">✓ Connected</span>
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
                <Link to={`/tool/${TOOL_FOR[p.id]}`} className="btn-ghost px-3 py-1.5 text-sm">Open tool</Link>
              </div>
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
          className="min-w-0 max-w-full flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
        >
          <option value="" disabled>Select…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      ) : (
        <span className="flex items-center gap-2 text-xs text-slate-400">
          {current || 'No accessible accounts found.'}
          <button onClick={fetchAccounts} className="font-medium text-brand-600 hover:text-brand-700">Refresh</button>
        </span>
      )}
    </div>
  );
}
