import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import LineChart from '../components/LineChart.jsx';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';

// Tracked keywords for the active project — rank position over time. The daily
// scheduled job appends a point automatically; "Refresh" pulls one on demand.
export default function Tracking() {
  const { user } = useAuth();
  const { active, activeId } = useProjects();
  const [tracked, setTracked] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const limit = PLANS[user.tier]?.trackedKeywords ?? 0;

  const load = () => api.tracking(activeId).then((d) => setTracked(d.tracked || [])).catch(() => {});
  useEffect(() => { setDomain(active?.domain || ''); load(); /* eslint-disable-next-line */ }, [activeId]);

  async function add(e) {
    e.preventDefault();
    if (!keyword.trim() || !domain.trim()) return;
    setBusy(true);
    try { await api.addTracked(keyword.trim(), domain.trim(), 'Singapore', activeId || undefined); setKeyword(''); toast('Keyword tracked', 'success'); load(); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function refreshAll() {
    setRefreshing(true);
    try { const { tracked } = await api.refreshTracking(activeId || undefined); setTracked(tracked || []); toast('Positions refreshed', 'success'); }
    catch (err) { toast(err.message, 'error'); }
    finally { setRefreshing(false); }
  }
  async function remove(trackId) { await api.removeTracked(trackId); load(); }

  const trend = (h) => {
    if (!h || h.length < 2) return null;
    const a = h[0].position, b = h[h.length - 1].position;
    if (!a || !b) return null;
    return b < a ? { dir: '▲', cls: 'text-green-600', n: a - b } : b > a ? { dir: '▼', cls: 'text-red-600', n: b - a } : { dir: '–', cls: 'text-slate-400', n: 0 };
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Keyword tracking</h1>
          <p className="mt-1 text-slate-600">
            {active ? <>Tracking ranks for <strong>{active.name}</strong>.</> : 'Pick a project to scope tracking.'} {tracked.length}/{limit} keywords.
          </p>
        </div>
        {tracked.length > 0 && <button onClick={refreshAll} disabled={refreshing} className="btn-ghost text-sm">{refreshing ? 'Refreshing…' : 'Refresh positions'}</button>}
      </div>

      {limit === 0 ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-slate-600">Keyword tracking is a paid feature.</p>
          <Link to="/pricing" className="btn-primary mt-3 inline-block">Upgrade to track keywords</Link>
        </div>
      ) : (
        <>
          <form onSubmit={add} className="card mt-6 flex flex-wrap items-end gap-3 p-5">
            <label className="block flex-1">
              <span className="text-sm font-medium text-slate-700">Keyword</span>
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="self storage singapore"
                className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
            </label>
            <label className="block flex-1">
              <span className="text-sm font-medium text-slate-700">Domain</span>
              <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.sg"
                className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
            </label>
            <button className="btn-primary" disabled={busy || tracked.length >= limit}>{tracked.length >= limit ? 'Limit reached' : 'Track'}</button>
          </form>

          <div className="mt-6 space-y-3">
            {tracked.length === 0 && <div className="card p-8 text-center text-slate-400">No tracked keywords yet — add one above.</div>}
            {tracked.map((t) => {
              const tr = trend(t.history);
              return (
                <div key={t.trackId} className="card p-4">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{t.keyword}</div>
                      <div className="text-xs text-slate-400">{t.domain}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-bold">{t.lastPosition ? `#${t.lastPosition}` : '—'}</div>
                      {tr && tr.n > 0 && <div className={`text-xs font-medium ${tr.cls}`}>{tr.dir} {tr.n}</div>}
                    </div>
                    <button onClick={() => remove(t.trackId)} className="text-sm text-slate-400 hover:text-red-600">Remove</button>
                  </div>
                  <div className="mt-2"><LineChart data={t.history} /></div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
