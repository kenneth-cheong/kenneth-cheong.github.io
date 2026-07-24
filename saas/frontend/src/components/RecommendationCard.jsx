import { useNavigate } from 'react-router-dom';
import { ListChecks, Sparkles, PenLine } from 'lucide-react';

const OPTIMISER_ID = 'content-writer'; // catalog id of the AI Content Optimiser

// An actionable recommendation. The data tools return prioritised "do this next"
// cards (see aiRecommendations / competitor_insights in the metering gateway),
// but a beginner reads "Fix your thin content" and stalls: they don't know HOW,
// and doing it feels like homework. So every recommendation carries one one-tap
// action:
//   • How do I do this?  → the assistant explains it as plain-English steps
// It opens Monty via the same `dm:ask` event the right-click "Explain" menu
// fires, because an explanation is a conversation you follow up on. No backend
// change.
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

// The single most-reported break in the journey: a user asks how to fix
// something like "your meta description is missing", and the assistant opens by
// asking which URL — the one they typed into the tool form two clicks ago and
// which is printed at the top of the very result they clicked from. They then
// wander off to another tool and never see the answer at all.
//
// So we state the subject explicitly and forbid re-asking for it. `target` is
// the URL/domain the run was actually about (threaded from ToolRunner), which is
// the piece that used to go missing whenever the user had no project set up.
//
// It also has to WIN against the connected data: the assistant is handed the
// Search Console property in its own context, so when the user typed a different
// address on the form the answer opened with "I'm assuming your primary domain
// is <the GSC one>…" — unsure-sounding, and wrong. What the user typed for this
// run is definitive, and there's no reason to narrate it back at them.
function subjectBlock({ target, domain } = {}) {
  const subject = target || domain;
  if (!subject) return '';
  return (
    `\n\nThe page/site in question is: ${subject}\n` +
    `That is what I entered for this run — treat it as definitive. If a connected Search Console or ` +
    `Analytics property, or any saved project, names a different domain, ignore that one and use this. ` +
    `Do NOT ask me which URL, domain, page or site this is about — you already have it above. ` +
    `Do NOT open with a preamble about what you're assuming or what you're about to do — start straight ` +
    `at the deliverable. If something else really is missing, pick the sensible default silently and put ` +
    `any note about it in one short line at the END.`
  );
}

// Fields to hand the AI Content Optimiser so the next step opens filled in.
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim()).filter(Boolean);
const isSite = (v) => !/[\s,]/.test(String(v ?? '').trim()) && /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]|$)/i.test(String(v ?? '').trim());
// A page (has a path) can be optimised in place; a bare domain can't, so that
// hand-off starts a new draft on the keyword instead.
const isPage = (v) => isSite(v) && /^(https?:\/\/)?[^/]+\/[^/\s]/.test(String(v).trim());

export function optimiserValues(context = {}) {
  const inp = context.inputs || {};
  const page = context.target || '';
  // `input` is the keyword list on keyword-style tools and a URL elsewhere.
  const kws = listOf(inp.keyword || inp.keywords || (isSite(inp.input) ? '' : inp.input));
  const optimise = isPage(page);
  const v = {
    mode: optimise ? 'Optimise existing content' : 'Write a new draft',
    ...(optimise ? { url: page } : kws[0] ? { input: kws[0] } : {}),
    ...(kws[0] ? { keyword: kws[0] } : {}),
    ...(kws.length > 1 ? { secondary: kws.slice(1, 10).join(', ') } : {}),
    ...(inp.location ? { location: inp.location } : {}),
    ...(inp.language ? { language: inp.language } : {}),
  };
  return (kws.length || optimise) ? v : null;
}

// One line per recommendation for the bulk prompts. `title` alone is often a
// bare category ("grammar", "readability"), so the body carries the substance.
const recLine = (c, i) => `${i + 1}. ${c.title || 'Recommendation'}${c.badge ? ` [${c.badge}]` : ''}${c.body ? ` — ${c.body}` : ''}`;

// Working through 20+ findings one message at a time is the thing users bounce
// off, so the section header offers "do the whole list in one go". We cap the
// list: past this the prompt bloats and the model starts skimping on the tail.
// (Same reason the per-card flow stays — it's how you redo just one.)
const BULK_MAX = 20;

export function bulkPrompts(cards, context) {
  const items = cards.slice(0, BULK_MAX);
  const where = ctxLine(context);
  const subject = subjectBlock(context);
  const list = items.map(recLine).join('\n');
  const dropped = cards.length - items.length;
  const tail = dropped > 0 ? `\n\n(There are ${dropped} more beyond these — I'll ask separately.)` : '';

  return {
    count: items.length,
    how: (
      `I got these ${items.length} recommendations${where}:\n\n${list}${tail}\n\n` +
      `I'm new to digital marketing. In plain, simple English (explain any jargon), walk me through EXACTLY how to do ` +
      `each one. Keep them in the same order and number them the same way, and under each give me numbered steps I can ` +
      `follow, where in my website or accounts I'd make the change, and roughly how long it'll take. If I can't do part ` +
      `of one myself, say so. Cover every item — don't stop early or summarise the rest.${subject}`
    ),
  };
}

// Section-level companion to the per-card actions: does the entire list in a
// single assistant message (one charge, one answer) instead of N round-trips.
export function BulkRecActions({ cards, context }) {
  const navigate = useNavigate();
  if (!cards || cards.length < 2) return null;
  // Public shared reports have no assistant and no signed-in session to run a
  // tool in — the bulk actions would either no-op (dm:ask) or bounce a visitor
  // to the login screen (the Optimiser handoff). Hide them entirely.
  if (context?.readOnly) return null;

  const { count, how } = bulkPrompts(cards, context);
  // The natural next step after "here's what to write" is writing it — and the
  // keyword, market and page are all sitting right here, so don't make the user
  // re-type them into the next tool.
  const handoff = context?.toolId === OPTIMISER_ID ? null : optimiserValues(context);

  const btn = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors';

  return (
    <div className="mb-3">
      <div className="dm-no-print flex flex-wrap items-center gap-1.5 rounded-xl border border-brand-100 dark:border-brand-500/25 bg-brand-50/60 dark:bg-brand-500/10 px-3 py-2.5">
        <Sparkles size={15} className="shrink-0 text-brand-500" aria-hidden />
        <span className="mr-1 text-sm text-body">Don’t do these one by one —</span>
        <button onClick={() => ask(how)} title="Monty explains every recommendation step by step (uses AI credits)" className={`${btn} bg-brand-600 text-white hover:bg-brand-700`}>
          <ListChecks size={14} aria-hidden /> Explain all {count}
        </button>
        {handoff && (
          <button
            onClick={() => navigate(`/tool/${OPTIMISER_ID}`, { state: { values: handoff } })}
            title={`Opens the AI Content Optimiser pre-filled${handoff.keyword ? ` with “${handoff.keyword}”` : ''} — nothing runs until you hit Run`}
            className={`${btn} bg-surface text-body hover:bg-sunken`}
          >
            <PenLine size={14} aria-hidden /> Write it in the Content Optimiser
          </button>
        )}
      </div>
    </div>
  );
}

export default function RecommendationCard({ card, sectionTitle, context }) {
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

  const btn = 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors';

  return (
    <div data-explain className="rounded-xl border border-line bg-surface p-3.5 transition-shadow hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-strong">{title}</strong>
        {card.badge && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BADGE[card.badgeTone] || BADGE.slate}`}>{card.badge}</span>}
      </div>
      {body && <p className="mt-1 text-sm leading-relaxed text-dim">{body}</p>}

      {/* Action row — the bridge from "finding" to "done". Suppressed on public
          shared reports: the button opens Monty (dm:ask), which isn't mounted
          for a signed-out visitor, so it would be a dead click. */}
      {!context?.readOnly && (
        <div className="dm-no-print mt-3 flex flex-wrap items-center gap-1.5">
          <button onClick={how} title="Monty explains it step by step (uses AI credits)" className={`${btn} bg-sunken text-body hover:bg-overlay`}>
            <ListChecks size={14} aria-hidden /> How do I do this?
          </button>
        </div>
      )}
    </div>
  );
}
