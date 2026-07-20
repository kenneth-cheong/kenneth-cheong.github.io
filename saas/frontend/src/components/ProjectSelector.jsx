import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { toast } from '../lib/ui.js';

// Header dropdown for the active project.
//
// This used to offer exactly one non-project option — "Manage projects…" — which
// dropped you on /projects still looking at whatever project you already had.
// A user trying to START one had no visible way in: the create form is above the
// list, but nothing pointed at it, so the page just read as "here's Extra Space
// again". Two explicit options now sit under the project list:
//
//   • Start a new project…  → /projects, with the create form scrolled into view
//     and focused (see `?new=1`, handled by Projects.jsx).
//   • Just tinkering around → creates the ready-made example project in one
//     click, for someone who wants to see real output before committing a site.
//
// The example option hides once an example project exists, so it can't be
// double-created, and both hide at the plan's project limit (with a nudge).
const NEW = '__new';
const EXAMPLE = '__example';
const MANAGE = '__manage';

export const EXAMPLE_PROJECT = { name: 'Example: Extra Space Asia', domain: 'extraspaceasia.com.sg' };

export default function ProjectSelector() {
  const { user } = useAuth();
  const { projects, activeId, setActive, create } = useProjects();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const limit = PLANS[user.tier]?.projects ?? 1;
  const atLimit = projects.length >= limit;
  const hasExample = projects.some((p) => p.domain === EXAMPLE_PROJECT.domain);

  const startNew = () => {
    if (atLimit) {
      toast(`You're using all ${limit} project${limit === 1 ? '' : 's'} on your ${PLANS[user.tier].name} plan — upgrade or remove one first.`, 'info');
      navigate('/projects');
      return;
    }
    navigate('/projects?new=1');
  };

  const startExample = async () => {
    if (busy) return;
    if (atLimit) { startNew(); return; }
    setBusy(true);
    try {
      await create(EXAMPLE_PROJECT.name, EXAMPLE_PROJECT.domain);
      toast('Example project ready — tools will auto-fill its address', 'success');
      navigate('/');
    } catch (err) {
      toast(err?.message || 'Could not create the example project.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const onChange = (e) => {
    const v = e.target.value;
    if (v === MANAGE) navigate('/projects');
    else if (v === NEW) startNew();
    else if (v === EXAMPLE) startExample();
    else setActive(v);
  };

  // No projects at all → a single clear CTA rather than an empty dropdown.
  if (!projects.length) {
    return (
      <button onClick={startNew} data-tour="project-selector" className="hidden rounded-lg border border-dashed border-edge px-2.5 py-1.5 text-xs font-medium text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400 sm:inline">
        + New project
      </button>
    );
  }

  return (
    <select
      value={activeId || ''}
      onChange={onChange}
      disabled={busy}
      data-tour="project-selector"
      className="dm-select hidden max-w-[10rem] rounded-lg border border-edge py-1.5 pl-2 pr-7 text-xs font-medium text-body focus:border-brand-500 focus:outline-none disabled:opacity-60 sm:block"
      title="Active project — runs are saved to it"
    >
      <optgroup label="Your projects">
        {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
      </optgroup>
      <optgroup label="Add">
        <option value={NEW}>+ Start a new project…</option>
        {!hasExample && <option value={EXAMPLE}>Just tinkering around — use an example site</option>}
        <option value={MANAGE}>Manage projects…</option>
      </optgroup>
    </select>
  );
}
