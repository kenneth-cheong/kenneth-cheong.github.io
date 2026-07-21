import { useEffect, useRef, useState } from 'react';
import { Copy, Square, RefreshCw, MessageSquare, AlertCircle } from 'lucide-react';
import { api, ApiError, chatStream, chatStreamAvailable } from '../lib/api.js';
import { renderMessage, stripChips } from '../lib/markdown.jsx';
import { copyText, toast } from '../lib/ui.js';

// "Do it for me" used to hand off to Monty: the drawer slid open, the answer
// streamed in a 400px-wide column, and the finished copy ended up somewhere
// other than the report it belongs to. The output is the deliverable, so it
// renders HERE — in the main section, under the recommendation it came from.
//
// The drawer is still the right home for a conversation ("How do I do this?"
// keeps going there, because you ask follow-ups). This is for output you paste.
//
// Ephemeral by design: the panel clears on reload. Nothing is lost — the
// gateway persists every generation as a Monty conversation regardless, so an
// old answer is recoverable from chat history.

export default function InlineAnswer({ prompt, title, onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);
  const boxRef = useRef(null);
  // Bumping this re-runs the effect — that's the retry.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let alive = true;
    setText(''); setErr(null); setBusy(true);

    // Streaming is configured by env and is absent outside production, so this
    // mirrors the drawer: stream when we can, otherwise fall back to the
    // buffered /chat call. Without the fallback every non-prod environment
    // dead-ends here — which is exactly what the first test run did.
    const out = (e) => {
      if (!alive) return;
      setBusy(false);
      const status = e?.status ?? (e instanceof ApiError ? e.status : undefined);
      setErr(status === 402 ? 'credits' : 'failed');
    };

    (async () => {
      if (chatStreamAvailable) {
        try {
          await chatStream([{ role: 'user', content: prompt }], null, (delta) => {
            if (alive) setText((t) => t + delta);
          }, { signal: ctrl.signal });
          if (alive) setBusy(false);
          return;
        } catch (e) {
          // Stop is the user's decision — keep what streamed, don't re-charge
          // by silently re-sending through the fallback.
          if (!alive || e?.name === 'AbortError') return;
          if (e?.status === 402) { out(e); return; }
          // otherwise fall through to the buffered call
        }
      }
      try {
        const { reply } = await api.chat([{ role: 'user', content: prompt }], null);
        if (!alive) return;
        setText(reply || '');
        setBusy(false);
      } catch (e) { out(e); }
    })();

    return () => { alive = false; ctrl.abort(); };
  }, [prompt, attempt]);

  // Follow the output as it streams, but only while the user is already at the
  // bottom — otherwise scrolling up to read the top yanks them back down.
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !busy) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [text, busy]);

  const stop = () => { abortRef.current?.abort(); setBusy(false); };
  const copy = () => copyText(stripChips(text)).then(() => toast('Copied to clipboard', 'success'));
  const openInChat = () => window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));

  const btn = 'inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-xs font-medium text-dim hover:text-brand-600 dark:hover:text-brand-400';

  return (
    <div className="mt-2.5 overflow-hidden rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/40 dark:bg-brand-500/5">
      <div className="dm-no-print flex flex-wrap items-center gap-1.5 border-b border-brand-100 dark:border-brand-500/20 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-300">
          {title || 'Your draft'}
        </span>
        {busy && <span className="text-xs text-muted">writing…</span>}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {busy
            ? <button onClick={stop} className={btn}><Square size={12} aria-hidden /> Stop</button>
            : <>
                {!!text && <button onClick={copy} className={btn}><Copy size={12} aria-hidden /> Copy</button>}
                <button onClick={() => setAttempt((n) => n + 1)} className={btn}><RefreshCw size={12} aria-hidden /> Redo</button>
              </>}
          {onClose && <button onClick={onClose} className={btn}>Close</button>}
        </div>
      </div>

      <div ref={boxRef} className="max-h-[520px] overflow-auto px-3.5 py-3 text-sm leading-relaxed text-body">
        {err ? (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div>
              <p className="text-body">
                {err === 'credits' ? "You're out of AI credits, so this couldn't be written."
                  : "That didn't come back — the assistant request failed."}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {err !== 'credits' && <button onClick={() => setAttempt((n) => n + 1)} className={btn}><RefreshCw size={12} aria-hidden /> Try again</button>}
                <button onClick={openInChat} className={btn}><MessageSquare size={12} aria-hidden /> Ask Monty instead</button>
              </div>
            </div>
          </div>
        ) : text ? (
          <>
            {renderMessage(stripChips(text))}
            {busy && <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-brand-400" aria-hidden />}
          </>
        ) : (
          <p className="text-muted">Writing this for you…</p>
        )}
      </div>
    </div>
  );
}
