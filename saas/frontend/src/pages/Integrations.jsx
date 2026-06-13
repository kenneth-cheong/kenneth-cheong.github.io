import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api.js';

const TOOL_FOR = { gsc: 'gsc', ga4: 'ga4', 'google-ads': 'google-ads' };

// Connect Google data sources. Production completes a real OAuth handshake; here
// connecting records the account id you enter so the tools + assistant light up.
export default function Integrations() {
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({});
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    api.integrations().then((d) => { setProviders(d.providers || []); setConnected(d.connected || {}); }).catch(() => {});
  }, []);

  async function connect(id) {
    setBusy(id);
    try {
      const { connected: c } = await api.connectIntegration(id, drafts[id] || '');
      setConnected(c);
    } finally { setBusy(null); }
  }
  async function disconnect(id) {
    setBusy(id);
    try {
      const { connected: c } = await api.connectIntegration(id, '', false);
      setConnected(c);
    } finally { setBusy(null); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Integrations</h1>
      <p className="mt-1 text-slate-600">
        Connect your Google accounts to pull your own Search Console, Analytics and Ads data — free of credits, and
        queryable by the assistant.
      </p>

      <div className="mt-6 space-y-3">
        {providers.map((p) => {
          const conn = connected[p.id];
          return (
            <div key={p.id} className="card p-5">
              <div className="flex flex-wrap items-center gap-3">
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
                    <button onClick={() => disconnect(p.id)} disabled={busy === p.id} className="text-sm text-slate-500 hover:text-slate-800">
                      Disconnect
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      value={drafts[p.id] || ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                      placeholder={p.id === 'gsc' ? 'https://example.com' : p.id === 'ga4' ? 'GA4 property id' : 'Ads account id'}
                      className="w-44 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
                    />
                    <button onClick={() => connect(p.id)} disabled={busy === p.id} className="btn-primary px-3 py-1.5 text-sm">
                      {busy === p.id ? '…' : 'Connect'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
