import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';
import { setProject as setDiagnosticsProject } from '../lib/diagnostics.js';

const Ctx = createContext(null);
export const useProjects = () => useContext(Ctx);

// Holds the user's projects + the currently-active one (persisted). Tool runs
// are tagged with the active project so History/results group by site.
export function ProjectProvider({ children }) {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(() => localStorage.getItem('dm_active_project') || null);

  const reload = useCallback(async () => {
    try {
      const { projects } = await api.projects();
      setProjects(projects || []);
      setActiveId((cur) => (projects?.some((p) => p.projectId === cur) ? cur : (projects?.[0]?.projectId || null)));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { if (user) reload(); else setProjects([]); }, [user, reload]);

  const setActive = useCallback((id) => {
    setActiveId(id);
    if (id) localStorage.setItem('dm_active_project', id); else localStorage.removeItem('dm_active_project');
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
