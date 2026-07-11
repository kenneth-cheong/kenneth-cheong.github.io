import { useNavigate } from 'react-router-dom';
import { useProjects } from '../context/ProjectContext.jsx';

// Header dropdown for the active project. "Manage projects…" jumps to the page.
export default function ProjectSelector() {
  const { projects, activeId, setActive } = useProjects();
  const navigate = useNavigate();
  if (!projects.length) {
    return (
      <button onClick={() => navigate('/projects')} data-tour="project-selector" className="hidden rounded-lg border border-dashed border-edge px-2.5 py-1.5 text-xs font-medium text-muted hover:border-brand-300 hover:text-brand-600 sm:inline">
        + Project
      </button>
    );
  }
  return (
    <select
      value={activeId || ''}
      onChange={(e) => { if (e.target.value === '__manage') navigate('/projects'); else setActive(e.target.value); }}
      data-tour="project-selector"
      className="dm-select hidden max-w-[10rem] rounded-lg border border-edge py-1.5 pl-2 pr-7 text-xs font-medium text-body focus:border-brand-500 focus:outline-none sm:block"
      title="Active project — runs are saved to it"
    >
      {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
      <option value="__manage">Manage projects…</option>
    </select>
  );
}
