import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { CREDIT_COSTS } from '@shared/catalog.mjs';

const COST = CREDIT_COSTS.ai_chat ?? 2;

// Always-available assistant. Each reply costs `ai_chat` credits and the bot can
// answer questions about the user's connected GSC / GA4 / Google Ads data.
export default function ChatDrawer() {
  const { setCredits } = useAuth();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([
    { role: 'assistant', content: "Hi! I'm your Digimetrics assistant. Ask me about any tool, how to get started, or your connected Search Console / GA4 / Ads numbers." },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const threadRef = useRef(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, open, busy]);

  async function send(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next = [...msgs, { role: 'user', content: text }];
    setMsgs(next);
    setDraft('');
    setBusy(true);
    try {
      const { reply, creditsRemaining } = await api.chat(next);
      setMsgs((m) => [...m, { role: 'assistant', content: reply }]);
      if (typeof creditsRemaining === 'number') setCredits(creditsRemaining);
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 402
        ? "You're out of credits — top up or upgrade to keep chatting."
        : `⚠ ${err.message}`;
      setMsgs((m) => [...m, { role: 'assistant', content: msg }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600 text-2xl text-white shadow-lg transition hover:bg-brand-700"
        title="Assistant"
      >
        {open ? '✕' : '💬'}
      </button>

      {open && (
        <div className="fixed bottom-24 right-5 z-30 flex h-[32rem] w-[22rem] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3 text-white">
            <span className="font-semibold">Assistant</span>
            <span className="ml-auto rounded-full bg-white/10 px-2 py-0.5 text-xs">{COST} credits / message</span>
          </div>

          <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto p-3">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'ml-auto rounded-br-sm bg-brand-600 text-white'
                    : 'rounded-bl-sm bg-slate-100 text-slate-800'
                }`}
              >
                {m.content}
              </div>
            ))}
            {busy && <div className="w-16 rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2 text-sm text-slate-400">…</div>}
          </div>

          <form onSubmit={send} className="flex items-center gap-2 border-t border-slate-100 p-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask anything…"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            <button disabled={busy} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Send
            </button>
          </form>
          <div className="px-3 pb-2 text-center text-[11px] text-slate-400">
            Out of credits? <Link to="/pricing" className="text-brand-600">Upgrade</Link>
          </div>
        </div>
      )}
    </>
  );
}
