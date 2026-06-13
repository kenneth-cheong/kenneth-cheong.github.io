import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';

const TOOL_FOR = { gsc: 'gsc', ga4: 'ga4', 'google-ads': 'google-ads' };

// Connect Google data sources via OAuth. Clicking Connect redirects to Google's
// consent screen; the backend stores the refresh token and bounces back here.
export default function Integrations() {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({});
  const [busy, setBusy] = useState(null);
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
  }, [justConnected, oauthError]);

  async function connect(id) {
    setBusy(id);
    try {
      const { url } = await api.authorizeIntegration(id);
      window.location.href = url; // → Google consent (mock returns a same-origin URL)
    } catch (e) {
      setBusy(null);
      alert(e.message || 'Could not start Google sign-in.');
    }
  }
  async function disconnect(id) {
    setBusy(id);
    try { const { connected: c } = await api.connectIntegration(id, '', false); setConnected(c); } finally { setBusy(null); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Integrations</h1>
      <p className="mt-1 text-slate-600">
        Connect your Google accounts to pull your own Search Console, Analytics and Ads data — free of credits, and
        queryable by the assistant.
      </p>

      {justConnected && <div className="mt-4 rounded-lg bg-green-50 px-4 py-2 text-sm text-green-700">✓ Connected {justConnected}. You can now run its tool.</div>}
      {oauthError && <div className="mt-4 rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">⚠ Google sign-in failed. Please try again.</div>}

      <div className="mt-6 space-y-3">
        {providers.map((p) => {
          const conn = connected[p.id];
          return (
            <div key={p.id} className="card p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 font-bold text-slate-500">G</div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{p.name}</div>
                  <div className="text-sm text-slate-500">{p.blurb}</div>
                </div>
                {conn?.connected ? (
                  <>
                    <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                      ✓ Connected{conn.account ? ` · ${conn.account}` : ''}
                    </span>
                    <Link to={`/tool/${TOOL_FOR[p.id]}`} className="btn-primary px-3 py-1.5 text-sm">Open tool</Link>
                    <button onClick={() => disconnect(p.id)} disabled={busy === p.id} className="text-sm text-slate-500 hover:text-slate-800">Disconnect</button>
                  </>
                ) : (
                  <button onClick={() => connect(p.id)} disabled={busy === p.id} className="btn-primary px-3 py-1.5 text-sm">
                    {busy === p.id ? 'Redirecting…' : 'Connect with Google'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
