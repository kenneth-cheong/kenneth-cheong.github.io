import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ArrowRight, X } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import Mascot from './Mascot.jsx';
import { stepTarget, stepLabel } from '../lib/planner.js';

// A once-per-session peek out of the closed Monty launcher: "next up in your
// plan …". It surfaces the plan through Monty WITHOUT taking any room in the
// open panel — it only appears while the panel is closed, and never more than
// once a session. This is the "make it noticeable via Monty, don't obscure
// Monty" path: presence on the launcher, not weight inside the drawer.
//
// It shares the launcher corner with ProactiveEngine's nudge, so it defers to
// that nudge (via dm:nudge-active) to avoid two bubbles stacking.
const SS_KEY = 'dm:planPeekSeen';
const DELAY_MS = 6000; // let the proactive app_open nudge (≈1.6s) settle first

export default function PlanPeek({ chatOpen }) {
  const { hasPlan, progress } = usePlan();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const seen = useRef(false);
  const nudgeActive = useRef(false);
  const next = progress.next;

  useEffect(() => {
    try { seen.current = sessionStorage.getItem(SS_KEY) === '1'; } catch { /* ignore */ }
  }, []);

  // Yield to (and hide behind) a live proactive nudge in the same corner.
  useEffect(() => {
    const onNudge = (e) => {
      nudgeActive.current = !!e.detail?.active;
      if (nudgeActive.current) setShow(false);
    };
    window.addEventListener('dm:nudge-active', onNudge);
    return () => window.removeEventListener('dm:nudge-active', onNudge);
  }, []);

  // Arm a one-shot timer once the conditions hold. Not on `/` (the dashboard
  // card already shouts the plan) and not while the panel is open.
  useEffect(() => {
    if (seen.current || chatOpen || pathname === '/' || !hasPlan || progress.complete || !next) return;
    const t = setTimeout(() => {
      if (seen.current || nudgeActive.current) return;
      setShow(true);
      seen.current = true;
      try { sessionStorage.setItem(SS_KEY, '1'); } catch { /* ignore */ }
    }, DELAY_MS);
    return () => clearTimeout(t);
    // `next` intentionally excluded — we don't want to re-arm as steps change.
  }, [chatOpen, pathname, hasPlan, progress.complete]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opening the panel supersedes the peek.
  useEffect(() => { if (chatOpen) setShow(false); }, [chatOpen]);

  if (!show || !next) return null;

  const dismiss = () => setShow(false);
  const goNext = () => { setShow(false); navigate(stepTarget(next).to); };

  return (
    <div className="fixed bottom-[100px] right-[26px] z-[70] w-72 origin-bottom-right motion-safe:animate-pop-from-corner">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
        <div className="flex items-start gap-2.5 p-3">
          <Mascot size={36} className="mt-0.5 shrink-0" />
          <button onClick={goNext} className="min-w-0 flex-1 text-left">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">Next up in your plan</div>
            <p className="mt-0.5 line-clamp-2 text-sm font-medium text-body">{stepLabel(next)}</p>
          </button>
          <button onClick={dismiss} className="shrink-0 rounded p-1 text-slate-300 hover:bg-sunken hover:text-dim" title="Dismiss" aria-label="Dismiss">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="flex border-t border-hair">
          <button onClick={goNext} className="flex flex-1 items-center justify-center gap-1 py-2 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10">
            Start <ArrowRight size={13} aria-hidden />
          </button>
          <div className="w-px bg-sunken" />
          <button onClick={dismiss} className="flex-1 py-2 text-sm font-medium text-faint hover:bg-raised">Not now</button>
        </div>
      </div>
    </div>
  );
}
