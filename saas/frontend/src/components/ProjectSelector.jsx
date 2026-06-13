import { useNavigate } from 'react-router-dom';
import { useProjects } from '../context/ProjectContext.jsx';

// Header dropdown for the active project. "Manage projects…" jumps to the page.
export default function ProjectSelector() {
  const { projects, activeId, setActive } = useProjects();
  const navigate = useNavigate();
  if (!projects.length) {
    return (
      <button onClick={() => navigate('/projects')} className="hidden rounded-lg border border-dashed border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:border-brand-300 hover:text-brand-600 sm:inline">
        + Project
      </button>
    );
  }
  return (
    <select
      value={activeId || ''}
      onChange={(e) => { if (e.target.value === '__manage') navigate('/projects'); else setActive(e.target.value); }}
      className="hidden max-w-[10rem] rounded-lg border border-slate-300 px-2 py-1.5 text-xs font-medium text-slate-700 focus:border-brand-500 focus:outline-none sm:block"
      title="Active project — runs are saved to it"
    >
      {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
      <option value="__manage">⚙ Manage projects…</option>
    </select>
  );
}
