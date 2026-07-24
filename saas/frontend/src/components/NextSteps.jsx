import { useNavigate } from 'react-router-dom';
import { ArrowRight, Lock, Compass } from 'lucide-react';
import { nextStepsFor, PLANS, etaLabel } from '@shared/catalog.mjs';
import { ToolIcon } from '../lib/icons.jsx';
import { categoryHue } from '../lib/categoryHue.js';
import { carryValues } from '../lib/carryValues.js';

// "Where to go next" — the strip that closes the loop under every result.
//
// A finished report is where the journey used to STOP. The user reads their
// keyword table, learns something, and then… nothing: the only exits are the
// browser back button and a nav rail of 35 tool names none of which announces
// itself as the sequel. Monty's `run_done` nudge helps, but it's a chat message
// you have to answer, and it fires at most once every couple of hours.
//
// So each result now ends with 2–3 concrete follow-ups, each stating the PAYOFF
// ("see where you actually rank for these") rather than the tool's job
// description, and each opening the next tool PRE-FILLED with this run's subject
// (lib/carryValues.js). The pairings live in the catalog (`NEXT_STEPS`), so the
// backend and the frontend read one map and adding a tool means editing one
// place.
//
// Nothing here spends a credit: the button navigates to a filled-in form and the
// user still presses Run. Locked tools stay visible with a tier pill and route
// to /pricing — a relevant locked follow-up is a far better upgrade prompt than
// a pricing page banner, and hiding it just makes the product look smaller.
export default function NextSteps({ toolId, tier = 'free', context, exclude, title = 'Where to go next', className = '' }) {
  const navigate = useNavigate();
  const steps = nextStepsFor(toolId, { tier, exclude });
  if (!steps.length) return null;

  return (
    <div className={`dm-no-print mt-6 border-t border-hair pt-5 ${className}`}>
      <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-body">
        <Compass size={15} className="text-brand-500" aria-hidden /> {title}
      </h4>
      <p className="mb-3 text-sm text-muted">
        Keep going — each one picks up where this report leaves off, already filled in.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map(({ tool, why, locked }) => (
          <StepCard
            key={tool.id}
            tool={tool}
            why={why}
            locked={locked}
            onGo={() => (locked
              ? navigate('/pricing')
              : navigate(tool.route || `/tool/${tool.id}`, { state: { values: carryValues(tool, context) } }))}
          />
        ))}
      </div>
    </div>
  );
}

function StepCard({ tool, why, locked, onGo }) {
  const eta = etaLabel(tool);
  return (
    <button
      type="button"
      onClick={onGo}
      style={{ '--tc': categoryHue(tool.category) }}
      className={`group flex h-full flex-col gap-1.5 rounded-xl border bg-surface p-3.5 text-left transition hover:-translate-y-0.5 hover:border-brand-300 dark:hover:border-brand-500/40 hover:shadow-sm ${locked ? 'border-dashed border-line' : 'border-line'}`}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white"
          style={{ background: 'var(--tc)' }}
          aria-hidden
        >
          <ToolIcon tool={tool} className="text-[13px] text-white" />
        </span>
        <strong className="min-w-0 flex-1 truncate text-sm text-strong">{tool.name}</strong>
        {locked && (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-sunken px-1.5 py-0.5 text-[10px] font-bold uppercase text-muted">
            <Lock size={9} aria-hidden /> {PLANS[tool.minTier].name}
          </span>
        )}
      </div>
      <p className="flex-1 text-[13px] leading-relaxed text-muted">{why}</p>
      <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 dark:text-brand-400">
        {locked ? `Unlock with ${PLANS[tool.minTier].name}` : 'Open this tool'}
        {/* The runtime sits INSIDE the affordance, before the arrow — trailing it
            after the arrow read as a separate, orphaned label. */}
        {!locked && eta && <span className="font-normal text-faint">· {eta}</span>}
        <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}
