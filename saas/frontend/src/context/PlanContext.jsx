import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { savePlan as cachePlan, loadPlan as loadCache, clearPlan as clearCache, localStepDone } from '../lib/planner.js';

// The beginner "north-star" plan: a single goal pathway + checklist progress.
// This context is the ONE source of truth. It hydrates once (from the account
// record synced across devices, falling back to the localStorage cache), then
// every mutation writes the cache instantly and debounces a save to the account.
const PlanCtx = createContext(null);
export const usePlan = () => useContext(PlanCtx);

const SYNC_DEBOUNCE_MS = 1200;

export function PlanProvider({ children }) {
  const { user, setOnboarding } = useAuth();
  const [plan, setPlanState] = useState(null);
  const inited = useRef(false);
  const timer = useRef(null);

  // Hydrate once, as soon as the user is known: prefer the server copy (follows
  // the user across devices), else the local cache. Adopt-and-push migrates a
  // cache-only plan up to the account so a second device can see it.
  useEffect(() => {
    if (inited.current || !user) return;
    inited.current = true;
    const server = user.onboarding?.plan || null;
    const cached = loadCache();
    const initial = server || cached || null;
    setPlanState(initial);
    if (initial) cachePlan(initial);
    if (!server && cached) queueSync(cached);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const queueSync = useCallback((next) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setOnboarding({ plan: next }); }, SYNC_DEBOUNCE_MS);
  }, [setOnboarding]);

  // Replace the plan everywhere: state + instant cache + debounced account sync.
  const setPlan = useCallback((next) => {
    setPlanState(next);
    if (next) cachePlan(next); else clearCache();
    queueSync(next); // `null` clears it server-side too
  }, [queueSync]);

  const clear = useCallback(() => setPlan(null), [setPlan]);

  // Mark a step complete (cross-device). No-op if there's no plan or it's already
  // recorded, so it's safe to call from a reconcile loop.
  const markDone = useCallback((toolId) => {
    setPlanState((p) => {
      if (!p || p.done?.[toolId]) return p;
      const next = { ...p, done: { ...(p.done || {}), [toolId]: true } };
      cachePlan(next); queueSync(next);
      return next;
    });
  }, [queueSync]);

  // Reconcile with locally-observed tool runs: when a plan step's tool has been
  // run on this device, tick it (and persist, so other devices see it too).
  // Runs on mount and whenever the tab regains focus (a run may have happened in
  // a tool tab meanwhile).
  useEffect(() => {
    if (!plan?.steps?.length) return;
    const reconcile = () => plan.steps.forEach((s) => { if (s.toolId && !plan.done?.[s.toolId] && localStepDone(s.toolId)) markDone(s.toolId); });
    reconcile();
    window.addEventListener('focus', reconcile);
    return () => window.removeEventListener('focus', reconcile);
  }, [plan, markDone]);

  const value = useMemo(() => {
    const steps = plan?.steps || [];
    const isDone = (s) => !!(plan?.done?.[s.toolId] || (s.toolId && localStepDone(s.toolId)));
    const doneCount = steps.filter(isDone).length;
    const next = steps.find((s) => !isDone(s)) || null;
    return {
      plan,
      hasPlan: !!plan?.steps?.length,
      setPlan,
      clearPlan: clear,
      markDone,
      isStepDone: isDone,
      progress: {
        done: doneCount,
        total: steps.length,
        pct: steps.length ? Math.round((doneCount / steps.length) * 100) : 0,
        complete: steps.length > 0 && doneCount === steps.length,
        next,
      },
    };
  }, [plan, setPlan, clear, markDone]);

  return <PlanCtx.Provider value={value}>{children}</PlanCtx.Provider>;
}
