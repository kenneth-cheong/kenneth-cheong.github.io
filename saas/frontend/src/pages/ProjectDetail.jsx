import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { BarChart2, KeyRound, History, ExternalLink } from 'lucide-react';
import { TOOLS, tierMeets, toolById } from '@shared/catalog.mjs';
import { categoryHue } from '../lib/categoryHue.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { CategoryIcon } from '../lib/icons.jsx';
import { api } from '../lib/api.js';

const TOOL_CATEGORIES = ['SEO', 'Content', 'AI Visibility', 'Strategy'];

function statusOf(r) {
  const p = (r.preview || '').toLowerCase().trim();
  if (/couldn.?t|could not|unable|fail|error|reconnect|not connected|disconnect/.test(p))
    return { label: 'Issue', cls: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  if (/^0 rows?\b|^0$/.test(p)) return { label: 'No data', cls: 'bg-sunken text-muted' };
  return { label: 'OK', cls: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300' };
}

const fmtDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function ProjectDetail() {
  const { projectId: rawId } = useParams();
  const projectId = decodeURIComponent(rawId);
  const { user } = useAuth();
  const { projects, activeId, setActive } = useProjects();
  const navigate = useNavigate();

  const [runs, setRuns] = useState(null);
  const [tracked, setTracked] = useState(null);
  const [opening, setOpening] = useState(null);

  const project = projects.find((p) => p.projectId === projectId);

  useEffect(() => {
    if (!projectId) return;
    // Filtered client-side, so a short page would hide an older project's runs.
    api.runs(500).then((d) => setRuns((d.runs || []).filter((r) => r.projectId === projectId))).catch(() => setRuns([]));
    api.tracking(projectId).then((d) => setTracked(d.tracked || [])).catch(() => setTracked([]));
  }, [projectId]);

  if (!project) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-muted">Project not found. <Link to="/projects" className="text-brand-600 dark:text-brand-400">Back to projects</Link></p>
      </div>
    );
  }

  const fromState = { fromProjectId: projectId, fromProjectName: project.name };
  const goTo = (path) => { setActive(projectId); navigate(path, { state: fromState }); };
  const isActive = activeId === projectId;

  async function openRun(runId) {
    setOpening(runId);
    try {
      const { run } = await api.run(runId);
      navigate(`/tool/${run.tool}`, { state: { values: run.inputs, result: run.result, ...fromState, runId } });
    } catch { setOpening(null); }
  }

  const posLabel = (t) => (t.lastPosition >= 1 ? `#${t.lastPosition}` : (t.history?.length ? 'Unranked' : '—'));
  const posTrend = (t) => {
    const h = t.history || [];
    if (h.length < 2) return null;
    const diff = h[h.length - 2].position - h[h.length - 1].position; // negative = rank dropped (higher number)
    if (diff === 0) return null;
    return diff > 0
      ? { label: `▲${Math.abs(diff)}`, cls: 'text-green-600 dark:text-green-400' }
      : { label: `▼${Math.abs(diff)}`, cls: 'text-red-600 dark:text-red-400' };
  };

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-faint">
            <Link to="/projects" className="hover:text-dim">Projects</Link>
            <span>/</span>
            <span className="text-dim">{project.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold">{project.name}</h1>
          {project.domain && (
            <a href={`https://${project.domain}`} target="_blank" rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted hover:text-brand-600 dark:hover:text-brand-400">
              {project.domain} <ExternalLink size={12} />
            </a>
          )}
        </div>
        {!isActive && (
          <button onClick={() => setActive(projectId)} className="btn-ghost text-sm">Set active</button>
        )}
        {isActive && <span className="rounded-full bg-brand-100 dark:bg-brand-500/15 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300">Active</span>}
      </div>

      {/* Quick links */}
      <div className="mt-5 grid grid-cols-3 gap-3">
        {[
          { icon: KeyRound, label: 'Track keywords', sub: 'Monitor Google rankings', path: '/tracking' },
          { icon: BarChart2, label: 'Performance', sub: 'Metric history over time', path: '/performance' },
          { icon: History, label: 'All runs', sub: 'Past tool runs', path: '/history' },
        ].map(({ icon: Icon, label, sub, path }) => (
          <button key={path} onClick={() => goTo(path)}
            className="card flex items-center gap-3 p-4 text-left transition-shadow hover:border-brand-300 dark:hover:border-brand-500/40 hover:shadow-sm">
            <Icon size={18} className="shrink-0 text-brand-500" />
            <div>
              <div className="text-sm font-semibold">{label}</div>
              <div className="text-xs text-faint">{sub}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Runs + Tracking side-by-side */}
      <div className="mt-7 grid gap-5 lg:grid-cols-2">

        {/* Recent runs */}
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Recent runs</h2>
            {runs?.length > 0 && (
              <button onClick={() => goTo('/history')} className="text-xs text-brand-600 dark:text-brand-400 hover:underline">View all</button>
            )}
          </div>
          {runs === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : runs.length === 0 ? (
            <div>
              <p className="text-sm text-dim">Nothing run for this site yet — results land here automatically.</p>
              <Link to="/" className="mt-2 inline-block text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Run a tool →</Link>
            </div>
          ) : (
            <div className="divide-y divide-hair">
              {runs.slice(0, 8).map((r) => {
                const s = statusOf(r);
                const toolName = toolById(r.tool)?.name || r.toolName || r.tool;
                return (
                  <button key={r.runId} onClick={() => openRun(r.runId)}
                    className="flex w-full items-center gap-3 py-2.5 text-left hover:opacity-75">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-body">{toolName}</div>
                      {r.target && <div className="truncate text-xs text-faint">{r.target}</div>}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>
                    <span className="shrink-0 text-xs text-faint">{fmtDate(r.ts)}</span>
                    <span className="shrink-0 text-xs text-brand-500">{opening === r.runId ? '…' : '→'}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Keyword tracking */}
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">Tracked keywords</h2>
            {tracked?.length > 0 && (
              <button onClick={() => goTo('/tracking')} className="text-xs text-brand-600 dark:text-brand-400 hover:underline">Manage</button>
            )}
          </div>
          {tracked === null ? (
            <p className="text-sm text-faint">Loading…</p>
          ) : tracked.length === 0 ? (
            <p className="text-sm text-faint">
              No keywords tracked yet.{' '}
              <button onClick={() => goTo('/tracking')} className="text-brand-600 dark:text-brand-400 hover:underline">Add one</button>
            </p>
          ) : (
            <div className="divide-y divide-hair">
              {tracked.slice(0, 10).map((t) => {
                const trend = posTrend(t);
                return (
                  <div key={t.trackId} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1 truncate text-sm text-body">{t.keyword}</div>
                    <span className="shrink-0 text-sm font-semibold text-strong">{posLabel(t)}</span>
                    {trend && <span className={`shrink-0 text-xs font-medium ${trend.cls}`}>{trend.label}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Tool launcher */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Run a tool</h2>
        <div className="mt-4 space-y-6">
          {TOOL_CATEGORIES.map((cat) => {
            const tools = TOOLS.filter((t) => t.category === cat);
            if (!tools.length) return null;
            const color = categoryHue(cat);
            return (
              <div key={cat}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted">{cat}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {tools.map((t) => {
                    const locked = !tierMeets(user.tier, t.minTier);
                    return (
                      <button key={t.id}
                        onClick={() => { if (!locked) { setActive(projectId); navigate(`/tool/${t.id}`, { state: fromState }); } }}
                        disabled={locked}
                        className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                          locked
                            ? 'cursor-not-allowed border-hair bg-raised opacity-50'
                            : 'border-line bg-surface hover:border-brand-300 dark:hover:border-brand-500/40 hover:bg-brand-50 dark:hover:bg-brand-500/10'
                        }`}
                      >
                        <CategoryIcon category={cat} size={16} color={locked ? '#94a3b8' : color} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-body">{t.name}</div>
                          {locked && <div className="text-xs capitalize text-faint">{t.minTier}+ plan</div>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
