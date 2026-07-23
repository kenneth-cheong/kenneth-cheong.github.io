import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { setProject as setDiagnosticsProject } from '../lib/diagnostics.js';

const Ctx = createContext(null);

const ACTIVE_KEY = 'dm_active_project';
// Sentinel for an explicit "no project". Stored rather than removed, because a
// removed key is indistinguishable from a first-time visitor — and those two
// cases need opposite behaviour on reload.
const NONE = '__none__';
export const useProjects = () => useContext(Ctx);

// Holds the user's projects + the currently-active one (persisted). Tool runs
// are tagged with the active project so History/results group by site.
export function ProjectProvider({ children }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  // "" is a REAL choice ("no project — just exploring"), distinct from a missing
  // key (never chosen anything). Without that distinction there was no way to
  // work without a project: every reload silently re-selected projects[0], so a
  // user who once clicked the Extra Space example had every tool on every page
  // prefilled with it and no way out.
  const [activeId, setActiveId] = useState(() => {
    const stored = localStorage.getItem(ACTIVE_KEY);
    return stored === NONE ? null : (stored || null);
  });

  const reload = useCallback(async () => {
    try {
      const { projects } = await api.projects();
      setProjects(projects || []);
      setActiveId((cur) => {
        if (projects?.some((p) => p.projectId === cur)) return cur;
        // Deliberately working without a project — don't drag them back into one.
        if (localStorage.getItem(ACTIVE_KEY) === NONE) return null;
        return projects?.[0]?.projectId || null;
      });
    } catch { /* ignore */ }
  }, []);
  // A locked account (expired trial / unpaid invoice) gets a 403 on /projects by
  // design, and this provider mounts above the locked screen — firing it anyway
  // would report a fault for a refusal we already know about and are showing the
  // user a proper explanation for. The projects themselves are untouched and
  // load normally the moment access returns.
  useEffect(() => {
    if (user && !user.access?.locked) reload();
    else setProjects([]);
  }, [user, reload]);

  // Passing null means "none, on purpose" — persist that so it survives reload.
  const setActive = useCallback((id) => {
    setActiveId(id || null);
    localStorage.setItem(ACTIVE_KEY, id || NONE);
  }, []);

  const create = useCallback(async (name, domain) => {
    const { project } = await api.createProject(name, domain);
    setProjects((p) => [...p, project]);
    setActive(project.projectId);
    return project;
  }, [setActive]);

  const remove = useCallback(async (projectId) => {
    await api.deleteProject(projectId);
    setProjects((p) => p.filter((x) => x.projectId !== projectId));
    setActiveId((cur) => (cur === projectId ? null : cur));
  }, []);

  const active = projects.find((p) => p.projectId === activeId) || null;
  useEffect(() => { setDiagnosticsProject(active); }, [active]);

  return <Ctx.Provider value={{ projects, active, activeId: active?.projectId || null, setActive, create, remove, reload }}>{children}</Ctx.Provider>;
}
