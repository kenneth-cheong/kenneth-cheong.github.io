import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { METRIC_GROUPS } from '@shared/metrics.mjs';
import { CATEGORY_META } from '@shared/catalog.mjs';
import { useProjects } from '../context/ProjectContext.jsx';
import MetricChart from '../components/MetricChart.jsx';
import InfoTip, { glossaryFor } from '../components/InfoTip.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import { api } from '../lib/api.js';
import { toast, downloadCsv } from '../lib/ui.js';
import { startPerformanceTour, PERFORMANCE_SAMPLE, hasSeen, markSeen } from '../lib/tours.js';

const PERIODS = [['7', '7d'], ['28', '28d'], ['90', '90d'], ['all', 'All']];
const SHARE_TOOL = { id: 'performance', name: 'SEO Performance' };
const SHARE_BTN = 'btn-ghost inline-flex items-center gap-1 text-sm';

// Accent colour per metric group (reuses the dashboard category palette).
const GROUP_COLOR = {
  'Google integrations': CATEGORY_META.Integrations.color,
  'Site health': CATEGORY_META.SEO.color,
  Authority: CATEGORY_META.Strategy.color,
  'AI visibility': CATEGORY_META['AI Visibility'].color,
};
const GROUP_ORDER = ['Google integrations', 'Site health', 'Authority', 'AI visibility'];

const fmtVal = (v, unit) => {
  if (v == null) return '—';
  const n = Number(v);
  const num = Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : `${Math.round(n * 100) / 100}`;
  if (unit === '%') return `${num}%`;
  if (unit === 'S$') return `S$${num}`;
  return num;
};

// Performance history for the active project — every metric-bearing tool run
// snapshots its headline number here, so you can compare points in time. The
// daily cron also re-pulls connected Google integrations to keep them current.
export default function Performance() {
  const { active, activeId } = useProjects();
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('28');

  // While a tour previews sample data, an in-flight load() must not clobber it.
  const tourActiveRef = useRef(false);
  const load = () => {
    setLoading(true);
    api.metrics(activeId).then((d) => { if (!tourActiveRef.current) setMetrics(d.metrics || []); }).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [activeId]);

  // Guided tour: swap in the asana.com sample so the full grouped layout renders,
  // then re-load the real data on any exit.
  function launchTour() {
    startPerformanceTour({
      preview: () => { tourActiveRef.current = true; setLoading(false); setMetrics(PERFORMANCE_SAMPLE); },
      clear: () => { tourActiveRef.current = false; setMetrics([]); load(); },
    });
  }

  // First visit → auto-run the guided tour once (needs a project for the page to render).
  useEffect(() => {
    if (!activeId || hasSeen('tool:performance')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:performance')) return;
      markSeen('tool:performance');
      launchTour();
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const cutoff = useMemo(() => {
    if (period === 'all') return null;
    const d = new Date(); d.setDate(d.getDate() - Number(period));
    return d.toISOString().slice(0, 10);
  }, [period]);
  const inPeriod = (h) => (!cutoff ? (h || []) : (h || []).filter((p) => p.date >= cutoff));

  // Group metric rows by tool, then by the tool's metric group, for display.
  const groups = useMemo(() => {
    const byTool = new Map();
    for (const m of metrics) {
      if (!byTool.has(m.tool)) byTool.set(m.tool, { tool: m.tool, toolName: m.toolName, group: METRIC_GROUPS[m.tool] || 'Other', target: m.target, items: [] });
      byTool.get(m.tool).items.push(m);
    }
    const out = new Map();
    for (const t of byTool.values()) {
      if (!out.has(t.group)) out.set(t.group, []);
      out.get(t.group).push(t);
    }
    return out;
  }, [metrics]);

  const orderedGroups = GROUP_ORDER.filter((g) => groups.has(g));

  // Branded share card — the four most significant metrics (ranked by magnitude
  // so a real number leads instead of an all-zero GA4 metric), tone-coded by
  // trend polarity. Client-side share (no saved run).
  const shareOut = useMemo(() => {
    const withVal = metrics
      .filter((m) => m.lastValue != null)
      .slice()
      .sort((a, b) => Math.abs(Number(b.lastValue) || 0) - Math.abs(Number(a.lastValue) || 0));
    if (!withVal.length) return null;
    const items = withVal.slice(0, 4).map((m) => {
      const hist = m.history || [];
      let tone = null;
      if (hist.length >= 2 && m.dir !== 'neutral') {
        const a = hist[0].value, b = hist[hist.length - 1].value;
        if (a !== b) { const up = b > a; tone = (m.dir === 'up' ? up : !up) ? 'green' : 'red'; }
      }
      return { label: m.label, value: fmtVal(m.lastValue, m.unit), tone };
    });
    return { result: { sections: [{ type: 'stats', items }] } };
  }, [metrics]);

  function exportCsv() {
    const rows = [];
    for (const m of metrics) for (const h of (m.history || [])) {
      rows.push({ Tool: m.toolName, Metric: m.label, Target: m.target || '', Date: h.date, Value: h.value });
    }
    if (!rows.length) { toast('No performance history to export yet.', 'info'); return; }
    downloadCsv(rows, `performance-${active?.name || 'all'}.csv`);
  }

  // Trend chip vs the first in-period point, coloured by the metric's polarity.
  const trend = (m, hist) => {
    if (!hist || hist.length < 2) return null;
    const a = hist[0].value, b = hist[hist.length - 1].value;
    if (a === b) return { arrow: '–', cls: 'text-faint', label: 'no change' };
    const up = b > a;
    const pct = a !== 0 ? Math.abs((b - a) / a) * 100 : null;
    const good = m.dir === 'neutral' ? null : (m.dir === 'up' ? up : !up);
    const cls = good == null ? 'text-muted' : good ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    const label = pct != null ? `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10}%` : `${Math.round(Math.abs(b - a) * 100) / 100}`;
    return { arrow: up ? '▲' : '▼', cls, label };
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="dm-no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Performance</h1>
          <p className="mt-1 text-dim">
            {active ? <>Tool metrics over time for <strong>{active.name}</strong>.</> : 'Pick a project to see its performance.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-tour="perf-actions">
          {metrics.length > 0 && (
            <>
              <button onClick={exportCsv} className="btn-ghost text-sm">Export CSV</button>
              <PdfButton className={SHARE_BTN} />
              <ShareResult tool={SHARE_TOOL} out={shareOut} project={active} user={null} force snapshot label="Share" className={SHARE_BTN} />
            </>
          )}
          {activeId && (
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

      {metrics.length > 0 && <PrintBrand title="Performance" project={active} user={null} />}

      {!activeId ? (
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">Performance is tracked under a project. Create or select one to start.</p>
          <Link to="/projects" className="btn-primary mt-3 inline-block">Go to projects</Link>
        </div>
      ) : loading ? (
        <div className="card mt-6 p-8 text-center text-faint">Loading…</div>
      ) : metrics.length === 0 ? (
        <div className="card mt-6 p-8 text-center">
          <p className="text-dim">No performance history yet.</p>
          <p className="mt-1 text-sm text-muted">
            Run a tool under this project — Search Console, GA4, Ads, a site audit, Backlinks Explorer or AI Visibility — and
            its headline numbers get snapshotted here for comparison over time.
          </p>
          <Link to="/tools" className="btn-primary mt-4 inline-block">Run a tool</Link>
        </div>
      ) : (
        <>
          <div className="mt-5 flex items-center gap-2" data-tour="perf-period">
            <span className="text-sm text-muted">Period</span>
            {PERIODS.map(([v, label]) => (
              <button key={v} onClick={() => setPeriod(v)}
                className={`rounded-full px-3 py-1 text-sm font-medium ${period === v ? 'bg-slate-800 text-white' : 'bg-surface text-dim ring-1 ring-line hover:bg-raised'}`}>
                {label}
              </button>
            ))}
          </div>

          {orderedGroups.map((group, gi) => {
            const color = GROUP_COLOR[group] || '#4f46e5';
            return (
              <section key={group} className="mt-7" data-tour={gi === 0 ? 'perf-group' : undefined}>
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{group}</h2>
                </div>
                <div className="space-y-4">
                  {groups.get(group).map((t) => (
                    <div key={t.tool} className="card p-5">
                      <div className="mb-3 flex items-baseline justify-between gap-2">
                        <h3 className="font-semibold">{t.toolName}</h3>
                        {t.target && <span className="truncate text-xs text-faint" title={t.target}>{t.target.replace(/^https?:\/\//, '')}</span>}
                      </div>
                      <div className="grid gap-5 sm:grid-cols-2">
                        {t.items.map((m) => {
                          const hist = inPeriod(m.history);
                          const tr = trend(m, hist);
                          const latestPoint = hist.length ? hist[hist.length - 1] : null;
                          const latest = latestPoint ? latestPoint.value : m.lastValue;
                          const latestDate = latestPoint?.date
                            ? new Date(latestPoint.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                            : null;
                          return (
                            <div key={m.metricId} className="rounded-lg border border-hair p-3">
                              <div className="flex items-baseline justify-between">
                                <span className="flex items-center gap-1 text-xs font-medium text-muted">
                                  {m.label}
                                  {glossaryFor(m.label) && <InfoTip text={glossaryFor(m.label)} size={12} />}
                                </span>
                                {tr && <span className={`text-xs font-semibold ${tr.cls}`}>{tr.arrow} {tr.label}</span>}
                              </div>
                              <div className="mt-0.5 text-xl font-bold">{fmtVal(latest, m.unit)}</div>
                              {latestDate && <div className="text-xs text-faint">{latestDate}</div>}
                              {hist.length >= 2
                                ? <div className="mt-2"><MetricChart data={hist} color={color} /></div>
                                : <div className="mt-2 text-xs text-slate-300">One data point so far — run again to build a trend.</div>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
