import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { toast } from '../lib/ui.js';
import History from './History.jsx';

// The workspace page: projects on top, run history below — one place to manage a
// site's projects and revisit everything you've run for them. (Reachable at both
// /projects and the legacy /history path.)
export default function Projects() {
  return (
    <div className="mx-auto max-w-5xl space-y-12">
      <ProjectsSection />
      <History embedded />
    </div>
  );
}

// A project groups a site's runs + connected data. Tier-limited.
function ProjectsSection() {
  const { user } = useAuth();
  const { projects, activeId, setActive, create, remove } = useProjects();
  const navigate = useNavigate();
  const track = (projectId) => { setActive(projectId); navigate('/tracking'); };
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const limit = PLANS[user.tier]?.projects ?? 1;
  const atLimit = projects.length >= limit;

  async function add(e) {
    e.preventDefault();
    if (!name.trim() && !domain.trim()) return;
    setBusy(true);
    try { await create(name.trim(), domain.trim()); setName(''); setDomain(''); toast('Project created', 'success'); }
    catch (err) { toast(err.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <h1 className="text-2xl font-bold">Projects</h1>
      <p className="mt-1 text-dim">Group a site's runs and connected data. {projects.length}/{limit} used on your {PLANS[user.tier].name} plan.</p>

      <form onSubmit={add} className="card mt-6 flex flex-wrap items-end gap-3 p-5">
        <label className="block flex-1">
          <span className="text-sm font-medium text-body">Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Storage"
            className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <label className="block flex-1">
          <span className="text-sm font-medium text-body">Domain</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.sg"
            className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <button className="btn-primary" disabled={busy || atLimit}>{atLimit ? 'Limit reached' : 'Add project'}</button>
      </form>
      {atLimit && (
        <p className="mt-2 text-sm text-muted">You've hit your project limit. <Link to="/pricing" className="text-brand-600 dark:text-brand-400">Upgrade</Link> for more.</p>
      )}

      <div className="mt-6 space-y-2">
        {projects.length === 0 && <div className="card p-8 text-center text-faint">No projects yet — add one above to start grouping your work.</div>}
        {projects.map((p) => (
          <div key={p.projectId} className={`card flex items-center gap-3 p-4 ${p.projectId === activeId ? 'ring-2 ring-brand-400' : ''}`}>
            <div className="min-w-0 flex-1">
              <Link to={`/projects/${encodeURIComponent(p.projectId)}`} className="font-semibold hover:text-brand-600 dark:hover:text-brand-400">{p.name}</Link>
              <div className="text-xs text-faint">{p.domain || '—'} · {p.projectId}</div>
            </div>
            {p.projectId === activeId
              ? <span className="rounded-full bg-brand-100 dark:bg-brand-500/15 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300">Active</span>
              : <button onClick={() => setActive(p.projectId)} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Set active</button>}
            <button onClick={() => track(p.projectId)} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Track</button>
            <Link to={`/projects/${encodeURIComponent(p.projectId)}`} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Open</Link>
            <button onClick={() => remove(p.projectId)} className="text-sm text-faint hover:text-red-600 dark:hover:text-red-400">Delete</button>
          </div>
        ))}
      </div>
    </section>
  );
}
