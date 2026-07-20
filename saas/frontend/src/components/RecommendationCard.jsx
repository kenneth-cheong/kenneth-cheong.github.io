import { useState } from 'react';
import { ListChecks, Wand2, Target, Check } from 'lucide-react';
import { usePlan } from '../context/PlanContext.jsx';
import { recStep } from '../lib/planner.js';
import { toast } from '../lib/ui.js';

// An actionable recommendation. The data tools return prioritised "do this next"
// cards (see aiRecommendations / competitor_insights in the metering gateway),
// but a beginner reads "Fix your thin content" and stalls: they don't know HOW,
// and doing it feels like homework. This card closes that gap with three one-tap
// actions on every recommendation:
//   • How do I do this?  → the assistant explains it as plain-English steps
//   • Do it for me       → the assistant drafts the actual fix/output (credits)
//   • Add to plan        → drops it into the sticky cross-device checklist
// The first two reuse the same `dm:ask` event the right-click "Explain" menu
// fires (Layout listens → opens Monty → sends the prompt). No backend change.
//
// Rendered by ResultSections for `cards` items that carry a `body` (real
// recommendations / insights); barePct "opportunity" cards keep the plain look.

const BADGE = {
  red: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', amber: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', green: 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  blue: 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300', orange: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300', slate: 'bg-sunken text-dim',
};

function ask(text) {
  window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text } }));
}

// Compact "where did this come from" line so the assistant answers in context
// without us having to thread the whole result through.
function ctxLine({ toolName, target, domain } = {}) {
  const bits = [];
  if (toolName) bits.push(`from the "${toolName}" tool`);
  const subject = target || domain;
  if (subject) bits.push(`for ${subject}`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

// The single most-reported break in the journey: a user hits "Do it for me" on
// something like "your meta description is missing", and the assistant opens by
// asking which URL — the one they typed into the tool form two clicks ago and
// which is printed at the top of the very result they clicked from. They then
// wander off to another tool and never see the generated text at all.
//
// So we state the subject explicitly and forbid re-asking for it. `target` is
// the URL/domain the run was actually about (threaded from ToolRunner), which is
// the piece that used to go missing whenever the user had no project set up.
function subjectBlock({ target, domain } = {}) {
  const subject = target || domain;
  if (!subject) return '';
  return (
    `\n\nThe page/site in question is: ${subject}\n` +
    `Do NOT ask me which URL, domain, page or site this is about — you already have it above. ` +
    `If you genuinely cannot proceed without something else, make your best assumption, state the ` +
    `assumption in one short line, and give me the finished result anyway.`
  );
}

export default function RecommendationCard({ card, sectionTitle, context }) {
  const plan = usePlan();
  const [added, setAdded] = useState(false);

  const title = card.title || 'Recommendation';
  const body = card.body || '';
  const where = ctxLine(context);

  const subject = subjectBlock(context);

  const how = () => ask(
    `I got this recommendation${where}: "${title}${body ? ` — ${body}` : ''}".\n\n` +
    `I'm new to digital marketing. In plain, simple English (explain any jargon), walk me through EXACTLY how to do this — ` +
    `numbered steps I can follow, where in my website or accounts I'd make each change, and roughly how long it'll take. ` +
    `If I can't do part of it myself, say so.${subject}`,
  );

  const doIt = () => ask(
    `Please help me actually DO this recommendation${where}: "${title}${body ? ` — ${body}` : ''}".${subject}\n\n` +
    `Produce the FINISHED thing in this reply — the actual copy, meta title/description, outline or message, ` +
    `ready for me to paste in. Do not ask me clarifying questions first, do not describe what you would write, ` +
    `and do not tell me you'll come back with it: write it out now. Put the finished text on its own, clearly ` +
    `separated from any explanation, then add one short line on where to paste it.`,
  );

  const addToPlan = () => {
    if (added || !plan?.addStep) return;
    plan.addStep(recStep({ title, why: body, to: context?.route }));
    setAdded(true);
    toast('Added to your plan', 'success');
  };

  const btn = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors';

  return (
    <div data-explain className="rounded-xl border border-line bg-surface p-3.5 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-strong">{title}</strong>
        {card.badge && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[card.badgeTone] || BADGE.slate}`}>{card.badge}</span>}
      </div>
      {body && <p className="mt-1 text-sm leading-relaxed text-dim">{body}</p>}

      {/* Action row — the bridge from "finding" to "done". */}
      <div className="dm-no-print mt-3 flex flex-wrap items-center gap-1.5">
        <button onClick={how} title="Monty explains it step by step (uses AI credits)" className={`${btn} bg-sunken text-body hover:bg-overlay`}>
          <ListChecks size={14} aria-hidden /> How do I do this?
        </button>
        <button onClick={doIt} title="The assistant drafts it for you (uses AI credits)" className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>
          <Wand2 size={14} aria-hidden /> Do it for me
        </button>
        <button
          onClick={addToPlan}
          disabled={added}
          className={`${btn} ${added ? 'cursor-default bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'text-muted hover:bg-sunken'}`}
        >
          {added ? <><Check size={14} aria-hidden /> Added to plan</> : <><Target size={14} aria-hidden /> Add to plan</>}
        </button>
      </div>
    </div>
  );
}
