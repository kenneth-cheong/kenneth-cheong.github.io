import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import LineChart from '../components/LineChart.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import { api, ApiError } from '../lib/api.js';
import { toast, downloadCsv, markStepDone, confirmDialog } from '../lib/ui.js';
import { startTrackingTour, TRACKING_SAMPLE, hasSeen, markSeen } from '../lib/tours.js';

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
  const [nudge, setNudge] = useState(false); // highlight empty keyword/domain after an incomplete add attempt
  const limit = PLANS[user.tier]?.trackedKeywords ?? 0;

  // While a tour previews sample data, an in-flight load() must not clobber it.
  const tourActiveRef = useRef(false);
  const load = () => api.tracking(activeId).then((d) => { if (!tourActiveRef.current) setTracked(d.tracked || []); }).catch(() => {});
  useEffect(() => { setDomain(active?.domain || ''); load(); /* eslint-disable-next-line */ }, [activeId]);

  // Guided tour: swap in the asana.com sample so the summary + keyword cards
  // render, then re-load the real list on any exit.
  function launchTour() {
    startTrackingTour({ limit }, {
      preview: () => { tourActiveRef.current = true; setTracked(TRACKING_SAMPLE); },
      clear: () => { tourActiveRef.current = false; setTracked([]); load(); },
    });
  }

  // First visit → auto-run the guided tour once (needs the feature unlocked + a project).
  useEffect(() => {
    if (!limit || !activeId || hasSeen('tool:tracking')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:tracking')) return;
      markSeen('tool:tracking');
      launchTour();
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, activeId]);

  async function add(e) {
    e.preventDefault();
    if (!keyword.trim() || !domain.trim()) { setNudge(true); return; }
    setBusy(true);
    try { await api.addTracked(keyword.trim(), domain.trim(), 'Singapore', activeId); markStepDone('tracking'); setKeyword(''); toast('Keyword tracked', 'success'); load(); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }
  async function addBulk(e) {
    e.preventDefault();
    const kws = [...new Set(bulkText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
    if (!kws.length || !domain.trim()) { setNudge(true); return; }
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
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 402
        ? 'Not enough credits to backfill every keyword — top up, or remove a few from tracking.'
        : err.message;
      toast(msg, 'error');
    }
    finally { setBackfilling(false); }
  }
  // Removing a keyword throws away its whole position history, which no amount
  // of re-adding brings back — the ranks were sampled on days that have passed.
  // Too destructive to fire off a single stray click.
  async function remove(t) {
    const points = (t.history || []).length;
    const ok = await confirmDialog({
      title: 'Remove keyword',
      message: points > 1
        ? `Stop tracking “${t.keyword}”? Its ${points} days of position history will be deleted and can't be recovered.`
        : `Stop tracking “${t.keyword}”?`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await api.removeTracked(t.trackId);
    load();
  }

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

  // A bare <input type="date"> takes a six-digit year — "04.04.56645" was typed
  // straight into the audit — and browsers happily hand that back as a valid
  // value. min/max stop the picker offering it; this clamp stops a typed or
  // pasted one reaching the filter, where it silently matches nothing.
  const TODAY = new Date().toISOString().slice(0, 10);
  const EARLIEST = '2020-01-01'; // no ranking history predates the product
  const clampDate = (d) => {
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
    if (d < EARLIEST) return EARLIEST;
    if (d > TODAY) return TODAY;
    return d;
  };

  // Date range filtering — supports fixed periods or a custom from/to range.
  const { fromCutoff, toCutoff } = useMemo(() => {
    if (period === 'custom') {
      const from = clampDate(customFrom);
      const to = clampDate(customTo);
      // Reversed range would show nothing at all with no hint why — read it the
      // way it was obviously meant.
      if (from && to && from > to) return { fromCutoff: to, toCutoff: from };
      return { fromCutoff: from, toCutoff: to };
    }
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
    return b < a ? { dir: '▲', cls: 'text-green-600 dark:text-green-400', n: a - b } : b > a ? { dir: '▼', cls: 'text-red-600 dark:text-red-400', n: b - a } : { dir: '–', cls: 'text-faint', n: 0 };
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
      <div className="dm-no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Keyword tracking</h1>
          <p className="mt-1 text-dim">
            {active ? <>Tracking ranks for <strong>{active.name}</strong>.</> : 'Pick a project to scope tracking.'} {tracked.length}/{limit} keywords.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-tour="trk-actions">
          {tracked.length > 0 && (
            <>
              <button onClick={exportCsv} className="btn-ghost text-sm">Export CSV</button>
              <PdfButton className={SHARE_BTN} />
              <button onClick={() => setConfirmBackfill(true)} disabled={backfilling} className="btn-ghost text-sm">{backfilling ? 'Backfilling…' : 'Backfill history'}</button>
              <button onClick={refreshAll} disabled={refreshing} className="btn-ghost text-sm">{refreshing ? 'Refreshing…' : 'Refresh positions'}</button>
              <ShareResult tool={SHARE_TOOL} out={shareOut} project={active} user={user} force snapshot label="Share" className={SHARE_BTN} />
            </>
          )}
          {limit > 0 && activeId && (
            <button
              type="button"
              onClick={launchTour}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
              title="Guided walkthrough with a real example"
            >
              <Compass size={14} aria-hidden /> Tour
            </button>
          )}
        </div>
      </div>

      {tracked.length > 0 && <PrintBrand title="Keyword Tracking" project={active} user={user} />}

      {limit === 0 ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">Keyword tracking is a paid feature.</p>
          <Link to="/pricing" className="btn-primary mt-3 inline-block">Upgrade to track keywords</Link>
        </div>
      ) : !activeId ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">Keywords are tracked under a project. Create one to start tracking.</p>
          <Link to="/projects" className="btn-primary mt-3 inline-block">Create a project</Link>
        </div>
      ) : (
        <>
          {/* Add form — single keyword or a pasted bulk list. */}
          <form onSubmit={bulk ? addBulk : add} className="card mt-6 p-5" data-tour="trk-add">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-body">{bulk ? 'Keywords (one per line)' : 'Keyword'}<span className="text-amber-500"> *</span></span>
              <button type="button" onClick={() => setBulk((b) => !b)} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
                {bulk ? 'Single keyword' : '+ Add multiple'}
              </button>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              {bulk ? (
                <textarea value={bulkText} onChange={(e) => { setNudge(false); setBulkText(e.target.value); }} rows={4} placeholder={'self storage singapore\ncheap storage\nstorage units sg'}
                  className={`block w-full flex-1 rounded-lg border p-2.5 text-sm focus:outline-none ${nudge && !bulkText.trim() ? 'border-amber-400 ring-4 ring-amber-400/20' : 'border-edge focus:border-brand-500'}`} />
              ) : (
                <input value={keyword} onChange={(e) => { setNudge(false); setKeyword(e.target.value); }} placeholder="self storage singapore"
                  className={`block flex-1 rounded-lg border p-2.5 text-sm focus:outline-none ${nudge && !keyword.trim() ? 'border-amber-400 ring-4 ring-amber-400/20' : 'border-edge focus:border-brand-500'}`} />
              )}
              <label className="block flex-1">
                <span className="text-sm font-medium text-body">Domain<span className="text-amber-500"> *</span></span>
                <input value={domain} onChange={(e) => { setNudge(false); setDomain(e.target.value); }} placeholder="acme.sg"
                  className={`mt-1.5 w-full rounded-lg border p-2.5 text-sm focus:outline-none ${nudge && !domain.trim() ? 'border-amber-400 ring-4 ring-amber-400/20' : 'border-edge focus:border-brand-500'}`} />
              </label>
              <button className="btn-primary" disabled={busy || (!bulk && tracked.length >= limit)}>
                {busy ? 'Registering…' : bulk ? 'Track keywords' : (tracked.length >= limit ? 'Limit reached' : 'Track')}
              </button>
            </div>
            {nudge
              ? <p className="mt-2 text-xs font-semibold text-amber-600 dark:text-amber-400">Enter {bulk ? 'at least one keyword' : 'a keyword'} and a domain to start tracking.</p>
              : bulk && <p className="mt-2 text-xs text-faint">Up to {Math.max(0, limit - tracked.length)} more. Positions are checked right after adding.</p>}
          </form>

          {/* Period selector + custom date range. */}
          {tracked.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2" data-tour="trk-period">
              <span className="text-sm text-muted">Period</span>
              {PERIODS.map(([v, label]) => (
                <button key={v} onClick={() => setPeriod(v)}
                  className={`rounded-full px-3 py-1 text-sm font-medium ${period === v ? 'bg-slate-800 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
                  {label}
                </button>
              ))}
              {period === 'custom' && (
                <div className="flex items-center gap-2">
                  <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                    min={EARLIEST} max={customTo || TODAY} aria-label="From date"
                    className="rounded-lg border border-edge px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                  <span className="text-sm text-faint">to</span>
                  <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                    min={customFrom || EARLIEST} max={TODAY} aria-label="To date"
                    className="rounded-lg border border-edge px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                </div>
              )}
            </div>
          )}

          {/* Overall performance summary card. */}
          {tracked.length > 0 && (
            <div className="card mt-4 p-4" data-tour="trk-summary">
              <h2 className="mb-3 text-sm font-semibold text-body">Overall performance</h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-lg bg-raised p-3 text-center">
                  <div className="text-2xl font-bold text-strong">{tracked.length}</div>
                  <div className="mt-0.5 text-xs text-muted">tracked</div>
                </div>
                <div className="rounded-lg bg-raised p-3 text-center">
                  <div className="text-2xl font-bold text-strong">{avgPosition ? `#${avgPosition}` : '—'}</div>
                  <div className="mt-0.5 text-xs text-muted">avg position</div>
                </div>
                <div className="rounded-lg bg-raised p-3 text-center">
                  <div className="text-2xl font-bold text-strong">{top10Count}</div>
                  <div className="mt-0.5 text-xs text-muted">in top 10</div>
                </div>
                <div className="rounded-lg bg-raised p-3 text-center">
                  <div className="text-2xl font-bold text-strong">{bestKeyword ? `#${bestKeyword.lastPosition}` : '—'}</div>
                  <div className="mt-0.5 text-xs text-muted">best rank</div>
                  {bestKeyword && <div className="mt-0.5 truncate text-xs text-faint" title={bestKeyword.keyword}>{bestKeyword.keyword}</div>}
                </div>
              </div>
              {summaryData.length >= 2 && (
                <div className="mt-4">
                  <div className="mb-1 text-xs text-faint">Average position over time (all keywords)</div>
                  <LineChart data={summaryData} />
                </div>
              )}
            </div>
          )}

          <div className="mt-4 space-y-3" data-tour="trk-list">
            {tracked.length === 0 && <div className="card p-8 text-center text-faint">No tracked keywords yet — add one above.</div>}
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
                      <div className="text-xs text-faint">{t.domain}</div>
                      {rankingUrl(t) && !unranked && (
                        <a href={rankingUrl(t)} target="_blank" rel="noopener noreferrer"
                          className="mt-0.5 block max-w-xs truncate text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300" title={rankingUrl(t)}>
                          {rankingUrl(t).replace(/^https?:\/\//, '')}
                        </a>
                      )}
                    </div>
                    <div className="text-right">
                      <div className={`text-lg font-bold ${unranked || noData ? 'text-faint' : ''}`}>{posLabel(t)}</div>
                      {tr && tr.n > 0 && <div className={`text-xs font-medium ${tr.cls}`}>{tr.dir} {tr.n}</div>}
                      {noData && <div className="text-[11px] text-slate-300">checking…</div>}
                    </div>
                    <button onClick={() => remove(t)} className="text-sm text-faint hover:text-red-600 dark:hover:text-red-400">Remove</button>
                  </div>
                  {hasChart && <div className="mt-2"><LineChart data={hist} /></div>}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Backfill confirmation. It stays a confirmation because it fans out over
          every tracked keyword at once — but it states the scope, not a price;
          /credit-guide is the one place that quotes one. */}
      {confirmBackfill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setConfirmBackfill(false)}>
          <div className="w-full max-w-md rounded-xl bg-surface p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">Backfill ranking history</h2>
            <p className="mt-2 text-sm text-dim">
              We'll pull past dated Google rankings for all <strong>{tracked.length}</strong> tracked keyword{tracked.length > 1 ? 's' : ''} and fill in the gaps in your charts.
            </p>
            <p className="mt-2 text-xs text-faint">Existing checked dates are kept — only missing dates are filled.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmBackfill(false)} className="btn-ghost text-sm">Cancel</button>
              <button onClick={runBackfill} className="btn-primary text-sm">Backfill history</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
