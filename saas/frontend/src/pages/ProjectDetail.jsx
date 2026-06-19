import { useNavigate, useParams, Link } from 'react-router-dom';
import { BarChart2, KeyRound, History, ExternalLink } from 'lucide-react';
import { TOOLS, CATEGORY_META, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { CategoryIcon } from '../lib/icons.jsx';

const TOOL_CATEGORIES = ['SEO', 'Content', 'AI Visibility', 'Strategy'];

export default function ProjectDetail() {
  const { projectId } = useParams();
  const { user } = useAuth();
  const { projects, activeId, setActive } = useProjects();
  const navigate = useNavigate();

  const project = projects.find((p) => p.projectId === projectId);
  if (!project) {
    return (
      <div className="mx-auto max-w-3xl">
        <p className="text-slate-500">Project not found. <Link to="/projects" className="text-brand-600">Back to projects</Link></p>
      </div>
    );
  }

  const runTool = (toolId) => {
    setActive(projectId);
    navigate(`/tool/${toolId}`);
  };

  const isActive = activeId === projectId;

  return (
    <div className="mx-auto max-w-4xl">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Link to="/projects" className="text-sm text-slate-400 hover:text-slate-600">Projects</Link>
            <span className="text-slate-300">/</span>
            <span className="text-sm font-medium text-slate-700">{project.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold">{project.name}</h1>
          {project.domain && (
            <a href={`https://${project.domain}`} target="_blank" rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600">
              {project.domain} <ExternalLink size={12} />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isActive && (
            <button onClick={() => setActive(projectId)} className="btn-ghost text-sm">Set active</button>
          )}
          {isActive && <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-700">Active</span>}
        </div>
      </div>

      {/* Quick links */}
      <div className="mt-5 grid grid-cols-3 gap-3">
        <button onClick={() => { setActive(projectId); navigate('/tracking'); }}
          className="card flex items-center gap-3 p-4 text-left hover:border-brand-300 hover:shadow-sm transition-shadow">
          <KeyRound size={18} className="shrink-0 text-brand-500" />
          <div>
            <div className="text-sm font-semibold">Track keywords</div>
            <div className="text-xs text-slate-400">Monitor Google rankings</div>
          </div>
        </button>
        <button onClick={() => { setActive(projectId); navigate('/performance'); }}
          className="card flex items-center gap-3 p-4 text-left hover:border-brand-300 hover:shadow-sm transition-shadow">
          <BarChart2 size={18} className="shrink-0 text-brand-500" />
          <div>
            <div className="text-sm font-semibold">Performance</div>
            <div className="text-xs text-slate-400">Metric history over time</div>
          </div>
        </button>
        <button onClick={() => { setActive(projectId); navigate('/history'); }}
          className="card flex items-center gap-3 p-4 text-left hover:border-brand-300 hover:shadow-sm transition-shadow">
          <History size={18} className="shrink-0 text-brand-500" />
          <div>
            <div className="text-sm font-semibold">Runs</div>
            <div className="text-xs text-slate-400">Past tool runs</div>
          </div>
        </button>
      </div>

      {/* Tool launcher */}
      <div className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Run a tool</h2>
        <div className="mt-4 space-y-6">
          {TOOL_CATEGORIES.map((cat) => {
            const tools = TOOLS.filter((t) => t.category === cat);
            if (!tools.length) return null;
            const color = CATEGORY_META[cat]?.color || '#4f46e5';
            return (
              <div key={cat}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: color }} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{cat}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {tools.map((t) => {
                    const locked = !tierMeets(user.tier, t.minTier);
                    return (
                      <button
                        key={t.id}
                        onClick={() => !locked && runTool(t.id)}
                        disabled={locked}
                        className={`flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                          locked
                            ? 'border-slate-100 bg-slate-50 opacity-50 cursor-not-allowed'
                            : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50'
                        }`}
                      >
                        <CategoryIcon category={cat} size={16} color={locked ? '#94a3b8' : color} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-slate-700">{t.name}</div>
                          {locked && <div className="text-xs text-slate-400 capitalize">{t.minTier}+ plan</div>}
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
