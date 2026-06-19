import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { toast } from '../lib/ui.js';

// A project groups a site's runs + connected data. Tier-limited.
export default function Projects() {
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
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Projects</h1>
      <p className="mt-1 text-slate-600">Group a site's runs and connected data. {projects.length}/{limit} used on your {PLANS[user.tier].name} plan.</p>

      <form onSubmit={add} className="card mt-6 flex flex-wrap items-end gap-3 p-5">
        <label className="block flex-1">
          <span className="text-sm font-medium text-slate-700">Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Storage"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <label className="block flex-1">
          <span className="text-sm font-medium text-slate-700">Domain</span>
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.sg"
            className="mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <button className="btn-primary" disabled={busy || atLimit}>{atLimit ? 'Limit reached' : 'Add project'}</button>
      </form>
      {atLimit && (
        <p className="mt-2 text-sm text-slate-500">You've hit your project limit. <Link to="/pricing" className="text-brand-600">Upgrade</Link> for more.</p>
      )}

      <div className="mt-6 space-y-2">
        {projects.length === 0 && <div className="card p-8 text-center text-slate-400">No projects yet — add one above to start grouping your work.</div>}
        {projects.map((p) => (
          <div key={p.projectId} className={`card flex items-center gap-3 p-4 ${p.projectId === activeId ? 'ring-2 ring-brand-400' : ''}`}>
            <div className="min-w-0 flex-1">
              <Link to={`/projects/${encodeURIComponent(p.projectId)}`} className="font-semibold hover:text-brand-600">{p.name}</Link>
              <div className="text-xs text-slate-400">{p.domain || '—'} · {p.projectId}</div>
            </div>
            {p.projectId === activeId
              ? <span className="rounded-full bg-brand-100 px-2.5 py-1 text-xs font-semibold text-brand-700">Active</span>
              : <button onClick={() => setActive(p.projectId)} className="text-sm font-medium text-brand-600 hover:text-brand-700">Set active</button>}
            <button onClick={() => track(p.projectId)} className="text-sm font-medium text-brand-600 hover:text-brand-700">Track</button>
            <Link to={`/projects/${encodeURIComponent(p.projectId)}`} className="text-sm font-medium text-brand-600 hover:text-brand-700">Open</Link>
            <button onClick={() => remove(p.projectId)} className="text-sm text-slate-400 hover:text-red-600">Delete</button>
          </div>
        ))}
      </div>
    </div>
  );
}
