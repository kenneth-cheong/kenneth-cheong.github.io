import { useMemo, useState } from 'react';
import { MessageSquareHeart, X, Check } from 'lucide-react';
import { toolById } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { getRecent, toast } from '../lib/ui.js';

// Post-usage NPS questionnaire. Held back until the user has earned an opinion
// (finished the Explorer essentials, or run a few tools), then asks once. Snooze
// hides it for the session; submit or "surveyDone.nps" hides it for good. Kept
// short — five questions, mostly one-tap scales — so it actually gets answered.
const SNOOZE_KEY = 'dm:npsSnoozed';

export default function PostUsageSurvey({ coreComplete = false }) {
  const { user, setOnboarding } = useAuth();
  const [snoozed, setSnoozed] = useState(() => sessionStorage.getItem(SNOOZE_KEY) === '1');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const [score, setScore] = useState(null);
  const [ease, setEase] = useState(null);
  const [trust, setTrust] = useState(null);
  const [mostUseful, setMostUseful] = useState('');
  const [comment, setComment] = useState('');

  // Tools they've actually run — the "most useful" picklist is grounded in real
  // experience, not the whole catalog.
  const ranTools = useMemo(() => getRecent().map(toolById).filter(Boolean), []);
  const alreadyDone = !!user.onboarding?.surveyDone?.nps;
  // Earned-an-opinion gate: finished the essentials, or ran ≥3 distinct tools.
  const earned = coreComplete || ranTools.length >= 3;

  if (done || alreadyDone || snoozed || !earned) return null;

  const snooze = () => { setSnoozed(true); sessionStorage.setItem(SNOOZE_KEY, '1'); };

  async function submit() {
    if (score === null || busy) return;
    setBusy(true);
    try {
      await api.submitSurvey('nps', { score, ease, trust, mostUseful, comment: comment.trim() });
      setDone(true);
      // Persist the "answered" marker locally so it doesn't reappear next load.
      setOnboarding({ surveyDone: { ...(user.onboarding?.surveyDone || {}), nps: true } });
      toast('Thank you — this genuinely shapes what we build next.', 'success');
    } catch {
      toast('Couldn’t send that just now — please try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 rounded-2xl border border-brand-200 dark:border-brand-500/30 bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-600 text-white">
            <MessageSquareHeart size={20} aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-bold text-heading">Quick feedback — 30 seconds?</h2>
            <p className="mt-0.5 text-sm text-muted">You’ve had a proper look around. Your honest take helps us more than almost anything.</p>
          </div>
        </div>
        <button onClick={snooze} title="Maybe later" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-dim">
          <X size={16} aria-hidden />
        </button>
      </div>

      <div className="mt-5 space-y-5">
        {/* NPS 0–10 */}
        <Question label="How likely are you to recommend Digimetrics to a colleague?" required>
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                key={n}
                onClick={() => setScore(n)}
                aria-pressed={score === n}
                className={`h-9 w-9 rounded-lg text-sm font-semibold tabular-nums transition ${score === n ? 'bg-brand-600 text-white' : 'bg-sunken text-dim hover:bg-raised'}`}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-xs text-faint"><span>Not likely</span><span>Very likely</span></div>
        </Question>

        <div className="grid gap-5 sm:grid-cols-2">
          <Scale label="How easy was it to get a useful result?" value={ease} onPick={setEase} lo="Hard" hi="Effortless" />
          <Scale label="How much did you trust the data & recommendations?" value={trust} onPick={setTrust} lo="Not much" hi="Fully" />
        </div>

        {ranTools.length > 0 && (
          <Question label="Which tool was most useful to you?">
            <div className="flex flex-wrap gap-1.5">
              {ranTools.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setMostUseful((m) => (m === t.name ? '' : t.name))}
                  aria-pressed={mostUseful === t.name}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ring-1 transition ${mostUseful === t.name ? 'bg-brand-600 text-white ring-brand-600' : 'bg-surface text-dim ring-line hover:bg-raised'}`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </Question>
        )}

        <Question label="What’s the one thing that would make you pay for this — or that’s missing?">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="The single most useful thing you could tell us…"
            className="w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </Question>
      </div>

      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={submit}
          disabled={score === null || busy}
          className={`btn-primary inline-flex items-center gap-2 ${score === null ? 'opacity-60' : ''}`}
        >
          <Check size={16} aria-hidden /> {busy ? 'Sending…' : 'Send feedback'}
        </button>
        {score === null && <span className="text-sm text-amber-600 dark:text-amber-400">Pick a score above to send.</span>}
        <button onClick={snooze} className="ml-auto text-sm font-medium text-muted hover:text-body">Maybe later</button>
      </div>
    </section>
  );
}

function Question({ label, required, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-body">
        {label} {required && <span className="text-amber-500">*</span>}
      </h3>
      <div className="mt-2">{children}</div>
    </div>
  );
}

// 1–5 rating row with anchored end labels.
function Scale({ label, value, onPick, lo, hi }) {
  return (
    <Question label={label}>
      <div className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            onClick={() => onPick(n)}
            aria-pressed={value === n}
            className={`h-9 flex-1 rounded-lg text-sm font-semibold tabular-nums transition ${value === n ? 'bg-brand-600 text-white' : 'bg-sunken text-dim hover:bg-raised'}`}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-faint"><span>{lo}</span><span>{hi}</span></div>
    </Question>
  );
}
