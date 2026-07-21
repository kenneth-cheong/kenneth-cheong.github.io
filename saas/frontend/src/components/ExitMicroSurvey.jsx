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

// Tapping a reason used to only tint the chip: users read the card as Monty (it
// shares his corner) and expected the answer to start a conversation — "nothing
// happens" was the single most-reported thing about this card. So every reason
// also hands off to Monty with a prompt that asks for the help that reason
// implies, phrased in the user's voice so his reply lands as an answer to them.
const HELP_PROMPTS = {
  'Too complex': 'I’m finding this a bit complex. Give me the simplest possible starting point — one tool, what you need from me, and what I’ll get back.',
  'Not sure where to start': 'I’m not sure where to start. Ask me for my website, then recommend the first tool I should run, why it’s the right first step, and walk me through it.',
  'Missing a feature I need': 'I can’t find the feature I need. Ask me what I’m trying to achieve, then tell me whether something here already covers it and point me at the closest tool.',
  'Just browsing': 'I’m just looking around. Give me a quick tour of what this can do for a site like mine, and suggest one thing worth trying right now.',
  Pricing: 'I have questions about pricing. Explain the plans and how AI credits get spent, then help me work out which plan fits the way I’d use this.',
};

// Same event the "Explain this" menu and recommendation cards use: Layout hears
// it, opens Monty and sends the prompt. No backend change.
function ask(text) {
  window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text } }));
}

export default function ExitMicroSurvey() {
  const { user, setOnboarding } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const firedRef = useRef(false);
  const nudgeActive = useRef(false);

  const alreadyDone = !!user.onboarding?.surveyDone?.exit;
  const snoozed = sessionStorage.getItem(SNOOZE_KEY) === '1';
  // Low engagement = hasn't really used the product yet. Active users are exempt.
  const lowEngagement = getRecent().length < 2;
  const eligible = !alreadyDone && !snoozed && lowEngagement;

  // Yield to (and hide behind) a live proactive nudge — we fire on the same idle
  // window as Monty's dashboard nudge, so without this the two can stack.
  useEffect(() => {
    const onNudge = (e) => {
      nudgeActive.current = !!e.detail?.active;
      if (nudgeActive.current) setOpen(false);
    };
    window.addEventListener('dm:nudge-active', onNudge);
    return () => window.removeEventListener('dm:nudge-active', onNudge);
  }, []);

  // Idle watcher: (re)arm a timer that fires once after IDLE_MS of no interaction.
  useEffect(() => {
    if (!eligible) return undefined;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      if (firedRef.current) return;
      timer = setTimeout(() => { if (!firedRef.current && !nudgeActive.current) { firedRef.current = true; setOpen(true); } }, IDLE_MS);
    };
    const events = ['mousemove', 'keydown', 'scroll', 'click', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, arm, { passive: true }));
    arm();
    return () => { clearTimeout(timer); events.forEach((e) => window.removeEventListener(e, arm)); };
  }, [eligible]);

  if (!open) return null;

  const dismiss = () => { setOpen(false); sessionStorage.setItem(SNOOZE_KEY, '1'); };

  // One place to post an answer. The backend keys responses by kind and lets the
  // latest win, so a reason banked on tap is safely replaced by the fuller
  // reason + comment if they go on to press Send.
  async function record(answers) {
    await api.submitSurvey('exit', answers);
    setSent(true);
    setOnboarding({ surveyDone: { ...(user.onboarding?.surveyDone || {}), exit: true } });
  }

  // Tapping a reason: bank the answer straight away (they may never press Send
  // now that Monty has their attention — we must not trade the response away for
  // the hand-off) and hand the matching prompt to Monty. The card stays put so
  // they can still add a comment; it sits clear of the assistant panel.
  function pick(r) {
    if (reason === r) { setReason(''); return; }
    setReason(r);
    ask(HELP_PROMPTS[r] || r);
    record({ reason: r, comment: comment.trim() }).catch(() => { /* Send is still there to retry */ });
  }

  async function send() {
    if ((!reason && !comment.trim()) || busy) return;
    setBusy(true);
    try {
      // Nothing new since the tap already banked it — don't post (and alert) twice.
      if (!sent || comment.trim()) await record({ reason, comment: comment.trim() });
      setOpen(false);
      sessionStorage.setItem(SNOOZE_KEY, '1');
      toast('Thanks — that’s really useful to know.', 'success');
    } catch {
      toast('Couldn’t send that just now — please try again.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    // Bottom-LEFT, squared off and unbranded on purpose: in the bottom-right it
    // was mistaken for Monty (the launcher, his nudge and the plan peek all live
    // in that corner), so people expected a chip tap to start a chat. Over here
    // it reads as a form — and it stays visible when the assistant panel opens.
    <div className="fixed bottom-4 left-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-line bg-raised p-4 shadow-lg dark:shadow-black/40">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-sunken text-dim">
          <HelpCircle size={17} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Quick question</p>
          <p className="text-sm font-semibold text-heading">Before you go — what’s getting in the way?</p>
          <p className="mt-0.5 text-xs text-muted">
            {sent ? 'Thanks — noted. Monty’s picking it up in the chat.' : 'One tap helps us fix it, and Monty will help you with it.'}
          </p>
        </div>
        <button onClick={dismiss} title="Dismiss" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint hover:bg-sunken hover:text-dim">
          <X size={15} aria-hidden />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {REASONS.map((r) => (
          <button
            key={r}
            onClick={() => pick(r)}
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
