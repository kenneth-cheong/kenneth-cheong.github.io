import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PLANS, CREDIT_COSTS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import LineChart from '../components/LineChart.jsx';
import ShareResult from '../components/ShareResult.jsx';
import { api } from '../lib/api.js';
import { toast, downloadCsv, markStepDone } from '../lib/ui.js';

const PERIODS = [['7', '7d'], ['28', '28d'], ['90', '90d'], ['all', 'All'], ['custom', 'Custom']];
const SHARE_TOOL = { id: 'keyword-tracking', name: 'Keyword Tracking' };
const SHARE_BTN = 'btn-ghost inline-flex items-center gap-1 text-sm';

// Tracked keywords for the active project — rank position over time. The daily
// scheduled job appends a point automatically; "Refresh" pulls one on demand.
export default function Tracking() {
  const { user, refresh } = useAuth();
  const { active, activeId } = useProjects();
  const [tracked, setTracked] = useState([]);
  const [keyword, setKeyword] = useState('');
  const [domain, setDomain] = useState('');
  const [bulk, setBulk] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [period, setPeriod] = useState('28');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const limit = PLANS[user.tier]?.trackedKeywords ?? 0;
  const backfillCost = CREDIT_COSTS.rank_backfill * tracked.length;

  const load = () => api.tracking(activeId).then((d) => setTracked(d.tracked || [])).catch(() => {});
  useEffect(() => { setDomain(active?.domain || ''); load(); /* eslint-disable-next-line */ }, [activeId]);

  async function add(e) {
    e.preventDefault();
    if (!keyword.trim() || !domain.trim()) return;
    setBusy(true);
    try { await api.addTracked(keyword.trim(), domain.trim(), 'Singapore', activeId); markStepDone('tracking'); setKeyword(''); toast('Keyword tracked', 'success'); load(); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function addBulk(e) {
    e.preventDefault();
    const kws = [...new Set(bulkText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
    if (!kws.length || !domain.trim()) return;
    setBusy(true);
    try {
      const { tracked } = await api.addTrackedBulk(kws, domain.trim(), 'Singapore', activeId);
      markStepDone('tracking');
      setTracked(tracked || []); setBulkText('');
      toast(`Added ${kws.length} keyword${kws.length > 1 ? 's' : ''} — checking positions…`, 'success');
      refreshAll(); // populate positions for the freshly-added keywords
    } catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function refreshAll() {
    setRefreshing(true);
    try { const { tracked } = await api.refreshTracking(activeId || undefined); setTracked(tracked || []); toast('Positions refreshed', 'success'); }
    catch (err) { toast(err.message, 'error'); }
    finally { setRefreshing(false); }
  }
  async function runBackfill() {
    setConfirmBackfill(false);
    setBackfilling(true);
    try {
      const { tracked, charged } = await api.backfillTracking(activeId || undefined);
      setTracked(tracked || []);
      await refresh(); // reflect the spent credits in the header balance
      setPeriod('all'); // reveal the newly filled history
      toast(charged ? `History backfilled — ${charged} credits used.` : 'History backfilled.', 'success');
    } catch (err) { toast(err.message, 'error'); }
    finally { setBackfilling(false); }
  }
  async function remove(trackId) { await api.removeTracked(trackId); load(); }

  // Most recent ranking URL for a keyword (from lastUrl or newest history point).
  const rankingUrl = (t) => t.lastUrl || [...(t.history || [])].reverse().find((h) => h.url)?.url || '';

  function exportCsv() {
    const rows = [];
    for (const t of tracked) for (const h of (t.history || [])) {
      rows.push({ Keyword: t.keyword, Domain: t.domain, Date: h.date, Position: h.position >= 1 ? h.position : 'Unranked', URL: h.url || '' });
    }
    if (!rows.length) { toast('No ranking history to export yet.', 'info'); return; }
    downloadCsv(rows, `keyword-rankings-${active?.name || 'all'}.csv`);
  }

  // Current position label: a rank, "Unranked" (checked, out of top 100), or "—".
  const posLabel = (t) => (t.lastPosition >= 1 ? `#${t.lastPosition}` : (t.history?.length ? 'Unranked' : '—'));

  // Date range filtering — supports fixed periods or a custom from/to range.
  const { fromCutoff, toCutoff } = useMemo(() => {
    if (period === 'custom') return { fromCutoff: customFrom || null, toCutoff: customTo || null };
    if (period === 'all') return { fromCutoff: null, toCutoff: null };
    const d = new Date(); d.setDate(d.getDate() - Number(period));
    return { fromCutoff: d.toISOString().slice(0, 10), toCutoff: null };
  }, [period, customFrom, customTo]);

  const inPeriod = (h) => {
    let pts = h || [];
    if (fromCutoff) pts = pts.filter((p) => p.date >= fromCutoff);
    if (toCutoff) pts = pts.filter((p) => p.date <= toCutoff);
    return pts;
  };

  const trend = (h) => {
    if (!h || h.length < 2) return null;
    const a = h[0].position, b = h[h.length - 1].position;
    if (!a || !b) return null;
    return b < a ? { dir: '▲', cls: 'text-green-600', n: a - b } : b > a ? { dir: '▼', cls: 'text-red-600', n: b - a } : { dir: '–', cls: 'text-slate-400', n: 0 };
  };

  // Aggregate summary — average position across all keywords per date, within the selected period.
  const summaryData = useMemo(() => {
    if (!tracked.length) return [];
    const dateMap = {};
    for (const t of tracked) {
      const hist = (t.history || []).filter((h) => {
        if (fromCutoff && h.date < fromCutoff) return false;
        if (toCutoff && h.date > toCutoff) return false;
        return true;
      });
      for (const h of hist) {
        if (h.position >= 1) {
          if (!dateMap[h.date]) dateMap[h.date] = { date: h.date, sum: 0, count: 0 };
          dateMap[h.date].sum += h.position;
          dateMap[h.date].count += 1;
        }
      }
    }
    return Object.values(dateMap)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, position: Math.round(d.sum / d.count) }));
  }, [tracked, fromCutoff, toCutoff]);

  const ranked = tracked.filter((t) => t.lastPosition >= 1);
  const avgPosition = ranked.length ? Math.round(ranked.reduce((s, t) => s + t.lastPosition, 0) / ranked.length) : null;
  const top10Count = ranked.filter((t) => t.lastPosition <= 10).length;
  const bestKeyword = ranked.length ? ranked.reduce((a, b) => a.lastPosition < b.lastPosition ? a : b) : null;

  // Branded share card — a hand-built stats summary (no saved run, so sharing is
  // client-side: download / copy / caption). Needs at least one ranked keyword.
  const shareOut = useMemo(() => {
    if (!ranked.length) return null;
    const items = [];
    if (avgPosition != null) items.push({ label: 'Avg. Google position', value: `#${avgPosition}`, tone: avgPosition <= 10 ? 'green' : avgPosition <= 20 ? 'amber' : null });
    items.push({ label: 'Keywords tracked', value: tracked.length.toLocaleString() });
    items.push({ label: 'In top 10', value: top10Count.toLocaleString(), tone: top10Count ? 'green' : null });
    if (bestKeyword) items.push({ label: 'Best rank', value: `#${bestKeyword.lastPosition}`, tone: 'green' });
    return { result: { sections: [{ type: 'stats', items }] } };
  }, [ranked.length, avgPosition, tracked.length, top10Count, bestKeyword]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Keyword tracking</h1>
          <p className="mt-1 text-slate-600">
            {active ? <>Tracking ranks for <strong>{active.name}</strong>.</> : 'Pick a project to scope tracking.'} {tracked.length}/{limit} keywords.
          </p>
        </div>
        {tracked.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button onClick={exportCsv} className="btn-ghost text-sm">Export CSV</button>
            <button onClick={() => setConfirmBackfill(true)} disabled={backfilling} className="btn-ghost text-sm">{backfilling ? 'Backfilling…' : 'Backfill history'}</button>
            <button onClick={refreshAll} disabled={refreshing} className="btn-ghost text-sm">{refreshing ? 'Refreshing…' : 'Refresh positions'}</button>
            <ShareResult tool={SHARE_TOOL} out={shareOut} project={active} user={user} force snapshot label="Share" className={SHARE_BTN} />
          </div>
        )}
      </div>

      {limit === 0 ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-slate-600">Keyword tracking is a paid feature.</p>
          <Link to="/pricing" className="btn-primary mt-3 inline-block">Upgrade to track keywords</Link>
        </div>
      ) : !activeId ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-slate-600">Keywords are tracked under a project. Create one to start tracking.</p>
          <Link to="/projects" className="btn-primary mt-3 inline-block">Create a project</Link>
        </div>
      ) : (
        <>
          {/* Add form — single keyword or a pasted bulk list. */}
          <form onSubmit={bulk ? addBulk : add} className="card mt-6 p-5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">{bulk ? 'Keywords (one per line)' : 'Keyword'}</span>
              <button type="button" onClick={() => setBulk((b) => !b)} className="text-xs font-medium text-brand-600 hover:text-brand-700">
                {bulk ? 'Single keyword' : '+ Add multiple'}
              </button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {bulk ? (
                <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)} rows={4} placeholder={'self storage singapore\ncheap storage\nstorage units sg'}
                  className="block w-full flex-1 rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
              ) : (
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="self storage singapore"
                  className="block flex-1 rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
              )}
              <label className="block flex-1">
                <span className="text-sm font-medium text-slate-700">Domain</span>
                <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.sg"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
              </label>
              <button className="btn-primary" disabled={busy || (!bulk && tracked.length >= limit)}>
                {busy ? 'Registering…' : bulk ? 'Track keywords' : (tracked.length >= limit ? 'Limit reached' : 'Track')}
              </button>
            </div>
            {bulk && <p className="mt-2 text-xs text-slate-400">Up to {Math.max(0, limit - tracked.length)} more. Positions are checked right after adding.</p>}
          </form>

          {/* Period selector + custom date range. */}
          {tracked.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-500">Period</span>
              {PERIODS.map(([v, label]) => (
                <button key={v} onClick={() => setPeriod(v)}
                  className={`rounded-full px-3 py-1 text-sm font-medium ${period === v ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}>
                  {label}
                </button>
              ))}
              {period === 'custom' && (
                <div className="flex items-center gap-2">
                  <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                  <span className="text-sm text-slate-400">to</span>
                  <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                </div>
              )}
            </div>
          )}

          {/* Overall performance summary card. */}
          {tracked.length > 0 && (
            <div className="card mt-4 p-4">
              <h2 className="mb-3 text-sm font-semibold text-slate-700">Overall performance</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-2xl font-bold text-slate-800">{tracked.length}</div>
                  <div className="mt-0.5 text-xs text-slate-500">tracked</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-2xl font-bold text-slate-800">{avgPosition ? `#${avgPosition}` : '—'}</div>
                  <div className="mt-0.5 text-xs text-slate-500">avg position</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-2xl font-bold text-slate-800">{top10Count}</div>
                  <div className="mt-0.5 text-xs text-slate-500">in top 10</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-2xl font-bold text-slate-800">{bestKeyword ? `#${bestKeyword.lastPosition}` : '—'}</div>
                  <div className="mt-0.5 text-xs text-slate-500">best rank</div>
                  {bestKeyword && <div className="mt-0.5 truncate text-xs text-slate-400" title={bestKeyword.keyword}>{bestKeyword.keyword}</div>}
                </div>
              </div>
              {summaryData.length >= 2 && (
                <div className="mt-4">
                  <div className="mb-1 text-xs text-slate-400">Average position over time (all keywords)</div>
                  <LineChart data={summaryData} />
                </div>
              )}
            </div>
          )}

          <div className="mt-4 space-y-3">
            {tracked.length === 0 && <div className="card p-8 text-center text-slate-400">No tracked keywords yet — add one above.</div>}
            {tracked.map((t) => {
              const hist = inPeriod(t.history);
              const tr = trend(hist);
              const unranked = t.lastPosition < 1 && t.history?.length;
              // Only plot when there are ≥2 real (ranking) points in the period;
              // otherwise the keyword stays a compact one-line row.
              const points = (hist || []).filter((p) => p.position >= 1);
              const hasChart = points.length >= 2;
              const noData = !t.history?.length;
              return (
                <div key={t.trackId} className="card p-4">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{t.keyword}</div>
                      <div className="text-xs text-slate-400">{t.domain}</div>
                      {rankingUrl(t) && !unranked && (
                        <a href={rankingUrl(t)} target="_blank" rel="noopener noreferrer"
                          className="mt-0.5 block max-w-xs truncate text-xs text-brand-600 hover:text-brand-700" title={rankingUrl(t)}>
                          {rankingUrl(t).replace(/^https?:\/\//, '')}
                        </a>
                      )}
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${unranked || noData ? 'text-slate-400' : ''}`}>{posLabel(t)}</div>
                      {tr && tr.n > 0 && <div className={`text-xs font-medium ${tr.cls}`}>{tr.dir} {tr.n}</div>}
                      {noData && <div className="text-[11px] text-slate-300">checking…</div>}
                    </div>
                    <button onClick={() => remove(t.trackId)} className="text-sm text-slate-400 hover:text-red-600">Remove</button>
                  </div>
                  {hasChart && <div className="mt-2"><LineChart data={hist} /></div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Backfill confirmation — historical SERP lookups cost extra credits. */}
      {confirmBackfill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmBackfill(false)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">Backfill ranking history</h2>
            <p className="mt-2 text-sm text-slate-600">
              We'll pull past dated Google rankings for all <strong>{tracked.length}</strong> tracked keyword{tracked.length > 1 ? 's' : ''} and fill in the gaps in your charts.
            </p>
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">Cost</span>
                <span className="font-semibold">{backfillCost} credits</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-slate-500">Your balance</span>
                <span className={(user.credits || 0) + (user.topupCredits || 0) < backfillCost ? 'font-semibold text-red-600' : 'font-semibold'}>
                  {(user.credits || 0) + (user.topupCredits || 0)} credits
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-slate-400">{CREDIT_COSTS.rank_backfill} credits per keyword. Existing checked dates are kept — only missing dates are filled.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmBackfill(false)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={runBackfill} disabled={(user.credits || 0) + (user.topupCredits || 0) < backfillCost}
                className="btn-primary text-sm">Backfill for {backfillCost} credits</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
