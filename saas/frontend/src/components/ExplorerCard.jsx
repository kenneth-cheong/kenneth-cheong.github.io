import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, Check, ArrowRight, Lock, Gift, PartyPopper, ChevronDown, ChevronUp } from 'lucide-react';
import { explorerProgress, EXPLORER_REWARD, PLANS, toolById } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { getRecent, toast } from '../lib/ui.js';
import { stepTarget } from '../lib/planner.js';

// The Explorer breadth checklist: a guided "try one of everything" tour that
// steers trial users across every discipline so their feedback covers the whole
// platform. Completing the required `core` set pays a one-time credit reward; the
// optional `explore` set pays a second, larger one. Separate from the goal plan
// (the user's chosen north-star) — this coexists with it.
//
// Progress is auto-detected: tool tasks tick when the tool has been run (recents),
// project/Google tasks from live account state. The ticked-task + claimed-reward
// maps live under onboarding.explorer, so they follow the user across devices; the
// reward GRANT is re-verified and paid out server-side.
export default function ExplorerCard({ googleConnected = false, projects = [] }) {
  const { user, setCredits, setOnboarding } = useAuth();
  const navigate = useNavigate();

  const exp = user.onboarding?.explorer || {};
  const [claimed, setClaimed] = useState(() => exp.claimed || {});
  const [claiming, setClaiming] = useState(null); // milestone in flight
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('dm:explorerDismissed') === '1');
  const [showExplore, setShowExplore] = useState(true);

  const hasProject = projects.length > 0;
  // Recompute when the recents list, project count or Google connection changes.
  // getRecent() is read fresh (it's localStorage-backed) so a run in another tab
  // is reflected on focus-driven re-render.
  const prog = useMemo(
    () => explorerProgress({
      tier: user.tier,
      ranTools: getRecent(),
      hasProject,
      hasGoogle: googleConnected,
      done: exp.done || {},
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user.tier, hasProject, googleConnected, exp.done, user.onboarding?.explorer]
  );

  // Persist newly-ticked tasks up to the account (cross-device), without clobbering
  // the claimed-reward flags. Guarded by a signature ref so it writes only on a
  // real change — never in a render loop.
  const lastDoneSig = useRef(null);
  useEffect(() => {
    const doneIds = prog.tasks.filter((t) => t.done).map((t) => t.id).sort();
    const sig = doneIds.join(',');
    if (lastDoneSig.current === null) { lastDoneSig.current = sig; return; } // adopt baseline silently
    if (sig === lastDoneSig.current) return;
    lastDoneSig.current = sig;
    const done = Object.fromEntries(doneIds.map((id) => [id, true]));
    setOnboarding({ explorer: { done, claimed } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prog.tasks]);

  async function claim(milestone) {
    if (claiming || claimed[milestone]) return;
    setClaiming(milestone);
    try {
      const res = await api.claimExplorer(milestone);
      if (res?.granted) {
        if (typeof res.credits === 'number') setCredits(res.credits);
        toast(`🎉 ${res.amount} bonus credits added — nice exploring!`, 'success');
      } else {
        toast('Reward already claimed.', 'info');
      }
      const nextClaimed = { ...claimed, [milestone]: true };
      setClaimed(nextClaimed);
      // Mirror locally so a reload before the next /me still shows it claimed.
      setOnboarding({ explorer: { done: Object.fromEntries(prog.tasks.filter((t) => t.done).map((t) => [t.id, true])), claimed: nextClaimed } });
    } catch {
      toast('Couldn’t claim that just now — try again in a moment.', 'error');
    } finally {
      setClaiming(null);
    }
  }

  // Nothing to show once fully claimed (or the user dismissed it).
  const allClaimed = claimed.core && (prog.full.total === prog.core.total || claimed.full);
  if (dismissed || allClaimed) return null;

  const go = (t) => navigate(stepTarget(t).to);
  const coreTasks = prog.tasks.filter((t) => t.group === 'core');
  const exploreTasks = prog.tasks.filter((t) => t.group === 'explore');
  const pct = prog.full.total ? Math.round((prog.full.done / prog.full.total) * 100) : 0;

  return (
    <section className="relative mt-8 overflow-hidden rounded-2xl border border-brand-200 dark:border-brand-500/30 bg-gradient-to-br from-brand-50/80 to-surface dark:from-brand-500/10 dark:to-surface">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-600 text-white">
            <Compass size={20} aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-bold text-heading">Explore the platform</h2>
            <p className="mt-0.5 max-w-lg text-sm text-muted">
              Try one tool from each area to see the full picture — and earn bonus credits as you go.
              Your feedback on each is gold to us.
            </p>
          </div>
        </div>
        <button onClick={() => { setDismissed(true); localStorage.setItem('dm:explorerDismissed', '1'); }}
          className="text-sm font-medium text-faint hover:text-body">Hide</button>
      </div>

      {/* Overall progress */}
      <div className="px-5 pt-4">
        <div className="flex items-center justify-between text-xs font-semibold text-muted">
          <span>{prog.full.done} of {prog.full.total} explored</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-brand-100 dark:bg-brand-500/15">
          <div className="h-full rounded-full bg-brand-600 transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Core — required for the first reward */}
      <div className="px-5 pt-5">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">The essentials</h3>
          <span className="text-xs text-faint">{prog.core.done}/{prog.core.total}</span>
        </div>
        <ul className="mt-2.5 space-y-2">
          {coreTasks.map((t, i) => <TaskRow key={t.id} task={t} n={i + 1} onOpen={() => go(t)} />)}
        </ul>
        <RewardBar
          complete={prog.coreComplete}
          claimed={!!claimed.core}
          claiming={claiming === 'core'}
          amount={EXPLORER_REWARD.core}
          label="Finish the essentials"
          onClaim={() => claim('core')}
        />
      </div>

      {/* Explore — the wider sweep for the bigger reward */}
      {exploreTasks.length > 0 && (
        <div className="px-5 pt-5">
          <button onClick={() => setShowExplore((s) => !s)} className="flex w-full items-center gap-2 text-left">
            <h3 className="text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">Go deeper</h3>
            <span className="text-xs text-faint">{exploreTasks.filter((t) => t.done).length}/{exploreTasks.length}</span>
            {showExplore ? <ChevronUp size={15} className="ml-auto text-faint" aria-hidden /> : <ChevronDown size={15} className="ml-auto text-faint" aria-hidden />}
          </button>
          {showExplore && (
            <>
              <ul className="mt-2.5 space-y-2">
                {exploreTasks.map((t, i) => <TaskRow key={t.id} task={t} n={coreTasks.length + i + 1} onOpen={() => go(t)} />)}
              </ul>
              <RewardBar
                complete={prog.fullComplete}
                claimed={!!claimed.full}
                claiming={claiming === 'full'}
                amount={EXPLORER_REWARD.full}
                label="Explore everything"
                onClaim={() => claim('full')}
              />
            </>
          )}
        </div>
      )}

      {/* Tier-locked but relevant — aspirational, never required for a reward */}
      {prog.locked.length > 0 && (
        <div className="mx-5 mt-5 mb-5 rounded-xl border border-dashed border-line p-3">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-dim"><Lock size={13} aria-hidden /> More to explore on a higher plan</h4>
          <ul className="mt-1.5 space-y-1">
            {prog.locked.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-dim">{t.label}</span>
                <span className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300">{PLANS[toolById(t.toolId)?.minTier]?.name || 'Upgrade'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {prog.locked.length === 0 && <div className="pb-5" />}
    </section>
  );
}

function TaskRow({ task, n, onOpen }) {
  const done = task.done;
  return (
    <li className={`flex items-center gap-3 rounded-xl border bg-surface p-3 ${done ? 'border-green-200 dark:border-green-500/30' : 'border-line'}`}>
      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold text-white ${done ? 'bg-green-500' : 'bg-brand-600'}`}>
        {done ? <Check size={15} aria-hidden /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`font-semibold ${done ? 'text-muted line-through' : 'text-heading'}`}>{task.label}</span>
        </div>
        <p className="mt-0.5 text-sm text-muted">{task.why}</p>
      </div>
      <button
        onClick={onOpen}
        className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold ${done ? 'text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-500/10' : 'bg-brand-600 text-white hover:bg-brand-700'}`}
      >
        {done ? 'Again' : 'Open'} <ArrowRight size={14} className="inline" aria-hidden />
      </button>
    </li>
  );
}

// The reward line under a group: a subtle "reach this to earn N" nudge while
// incomplete, a prominent claim button when complete, and a done state after.
function RewardBar({ complete, claimed, claiming, amount, label, onClaim }) {
  if (claimed) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg bg-green-50 dark:bg-green-500/10 px-3 py-2 text-sm font-semibold text-green-700 dark:text-green-300">
        <PartyPopper size={15} aria-hidden /> +{amount} credits claimed — thank you!
      </div>
    );
  }
  if (complete) {
    return (
      <button
        onClick={onClaim}
        disabled={claiming}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-3 py-2.5 text-sm font-bold text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        <Gift size={16} aria-hidden /> {claiming ? 'Claiming…' : `Claim your ${amount} bonus credits`}
      </button>
    );
  }
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-dashed border-brand-200 dark:border-brand-500/30 px-3 py-2 text-sm text-dim">
      <Gift size={15} className="shrink-0 text-brand-500" aria-hidden /> {label} to earn <span className="font-bold text-brand-700 dark:text-brand-300">{amount} bonus credits</span>
    </div>
  );
}
