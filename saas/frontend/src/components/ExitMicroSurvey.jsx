import { useEffect, useRef, useState } from 'react';
import { HelpCircle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { api } from '../lib/api.js';
import { getRecent, toast } from '../lib/ui.js';

// Exit micro-survey: a single, low-friction "what's getting in the way?" for the
// user who lands, stalls, and would otherwise churn silently — the segment the
// post-usage NPS never reaches (they never engaged enough to be asked). Clarity
// shows us they went idle; this asks them why, in one tap.
//
// Trigger: a stretch of inactivity, ONCE per session, only for low-engagement
// users who haven't already answered. Deliberately conservative so it never
// nags an active user.
const IDLE_MS = 45_000;
const SNOOZE_KEY = 'dm:exitSurveySnoozed';

const REASONS = [
  'Too complex',
  'Not sure where to start',
  'Missing a feature I need',
  'Just browsing',
  'Pricing',
];

export default function ExitMicroSurvey() {
  const { user, setOnboarding } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const firedRef = useRef(false);

  const alreadyDone = !!user.onboarding?.surveyDone?.exit;
  const snoozed = sessionStorage.getItem(SNOOZE_KEY) === '1';
  // Low engagement = hasn't really used the product yet. Active users are exempt.
  const lowEngagement = getRecent().length < 2;
  const eligible = !alreadyDone && !snoozed && lowEngagement;

  // Idle watcher: (re)arm a timer that fires once after IDLE_MS of no interaction.
  useEffect(() => {
    if (!eligible) return undefined;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      if (firedRef.current) return;
      timer = setTimeout(() => { if (!firedRef.current) { firedRef.current = true; setOpen(true); } }, IDLE_MS);
    };
    const events = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [eligible]);

  if (!open) return null;

  const dismiss = () => { setOpen(false); sessionStorage.setItem(SNOOZE_KEY, '1'); };

  async function send() {
    if ((!reason && !comment.trim()) || busy) return;
    setBusy(true);
    try {
      await api.submitSurvey('exit', { reason, comment: comment.trim() });
      setOpen(false);
      sessionStorage.setItem(SNOOZE_KEY, '1');
      setOnboarding({ surveyDone: { ...(user.onboarding?.surveyDone || {}), exit: true } });
      toast('Thanks — that’s really useful to know.', 'success');
    } catch {
      toast('Couldn’t send that just now — please try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-line bg-surface p-4 shadow-xl dark:shadow-black/40">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 dark:bg-brand-500/10 text-brand-600 dark:text-brand-400">
          <HelpCircle size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-heading">Before you go — what’s getting in the way?</p>
          <p className="mt-0.5 text-xs text-muted">One tap helps us fix it. No wrong answers.</p>
        </div>
        <button onClick={dismiss} title="Dismiss" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-dim">
          <X size={15} aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button
            key={r}
            onClick={() => setReason((cur) => (cur === r ? '' : r))}
            aria-pressed={reason === r}
            className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition ${reason === r ? 'bg-brand-600 text-white ring-brand-600' : 'bg-surface text-dim ring-line hover:bg-raised'}`}
          >
            {r}
          </button>
        ))}
      </div>

      <input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        maxLength={1000}
        placeholder="Anything else? (optional)"
        className="mt-2.5 w-full rounded-lg border border-edge px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
      />

      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button onClick={dismiss} className="text-xs font-medium text-muted hover:text-body">No thanks</button>
        <button
          onClick={send}
          disabled={(!reason && !comment.trim()) || busy}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
