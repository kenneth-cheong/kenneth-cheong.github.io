import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError, chatStream, chatStreamAvailable } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { CREDIT_COSTS, toolById } from '@shared/catalog.mjs';
import { toast } from '../lib/ui.js';
import { X, Plus, History, Trash2, ArrowLeft, ArrowRight, Settings } from 'lucide-react';

const COST = CREDIT_COSTS.ai_chat ?? 2;
const GREETING = { role: 'assistant', content: "Hi! I'm your Digimetrics assistant. Ask me about any tool, how to get started, or your connected Search Console / GA4 / Ads numbers." };

// Render an assistant message, turning [[tool:id]] / [[go:path|label]] /
// [[action:verb|arg]] tokens into clickable chips (chipFor builds each one).
const TOKEN_RE = /\[\[(tool|action|go):([^\]]+)\]\]/gi;
function renderMessage(text, chipFor) {
  const out = [];
  let last = 0, m, k = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(chipFor(m[1].toLowerCase(), m[2], k++) ?? m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Animated "assistant is typing" indicator — three bouncing dots.
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" role="status" aria-label="Assistant is typing">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
    </span>
  );
}

// Relative "time ago" for the history list.
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Docked assistant panel — rendered beside the page (Layout shifts content left
// when open). Each reply costs `ai_chat` credits and the bot can answer about
// the user's connected GSC / GA4 / Google Ads data. Conversations persist
// server-side: start a new one or reopen past ones from the history list.
export default function ChatDrawer({ open, onClose, width = 384, onResize, ask }) {
  const { user, setCredits } = useAuth();
  const { active, activeId } = useProjects();
  const navigate = useNavigate();
  const location = useLocation();
  const go = (path) => { onClose?.(); navigate(path); };

  async function trackKeyword(kw) {
    if (!activeId || !active?.domain) { toast('Create a project with a domain first to track keywords.', 'info'); go('/projects'); return; }
    if (!window.confirm(`Track “${kw}” for ${active.domain}?`)) return;
    try { await api.addTracked(kw, active.domain, 'Singapore', activeId); toast(`Now tracking “${kw}”`, 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }

  // Build a clickable chip for an assistant token (tool / go / action).
  function chipFor(type, raw, key) {
    const chip = (label, onClick) => (
      <button key={`c${key}`} onClick={onClick}
        className="mx-0.5 my-0.5 inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 align-middle text-xs font-semibold text-white hover:bg-brand-700">
        {label} <ArrowRight size={12} aria-hidden />
      </button>
    );
    if (type === 'tool') { const t = toolById(raw.trim()); return t ? chip(t.name, () => go(`/tool/${t.id}`)) : null; }
    if (type === 'go') { const [path, label] = raw.split('|'); return chip(label?.trim() || path.trim(), () => go(path.trim())); }
    if (type === 'action') {
      const [verb, ...rest] = raw.split('|');
      const arg = rest.join('|').trim();
      if (verb.trim() === 'track' && arg) return chip(`Track “${arg}”`, () => trackKeyword(arg));
      if (verb.trim() === 'ticket') return chip('Open a support ticket', () => go('/support'));
    }
    return null;
  }

  // Starter prompts shown on a fresh chat — adapt to where the user is.
  const suggestions = useMemo(() => {
    const p = location.pathname;
    if (p.startsWith('/tool/')) return ['How do I use this tool?', 'What will the results tell me?', 'Is there a cheaper way to do this?'];
    if (p === '/' || p === '') return ['How do I get more visitors?', 'What should I work on first?', 'Audit my website', 'Which tool fits my goal?'];
    return ['How do I get more visitors?', 'Explain my latest result', "What's included in my plan?"];
  }, [location.pathname]);
  const [msgs, setMsgs] = useState([GREETING]);
  const [conversationId, setConversationId] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('chat'); // 'chat' | 'history' | 'settings'
  // Whether the panel auto-opens on every app load (Layout reads this key on
  // entry). Default on; users toggle it off here so reloads stay quiet.
  const [autoOpen, setAutoOpen] = useState(() => localStorage.getItem('dm:chatAutoOpen') !== '0');
  const toggleAutoOpen = () => setAutoOpen((on) => { const next = !on; localStorage.setItem('dm:chatAutoOpen', next ? '1' : '0'); return next; });
  const [convos, setConvos] = useState([]);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const threadRef = useRef(null);
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const askedRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);          // AbortController for the in-flight stream
  const stickRef = useRef(true);          // is the thread scrolled near the bottom?

  const OUT_OF_CREDITS = "You're out of credits — top up or upgrade to keep chatting.";

  async function submit(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    const next = [...msgsRef.current, { role: 'user', content: text }];
    setMsgs(next);
    setDraft('');
    setBusy(true);

    // ── Streaming path (token-by-token) — falls back to buffered chat on error. ──
    if (chatStreamAvailable) {
      setMsgs((m) => [...m, { role: 'assistant', content: '' }]); // bubble we stream into
      const ac = new AbortController();
      abortRef.current = ac;
      let acc = '';
      try {
        const { conversationId: cid } = await chatStream(next, conversationId, (delta) => {
          acc += delta;
          setMsgs((m) => { const c = m.slice(); c[c.length - 1] = { role: 'assistant', content: acc }; return c; });
        }, { signal: ac.signal });
        if (cid) setConversationId(cid);
        setCredits(Math.max(0, (user?.credits || 0) - COST)); // stream can't return the balance; correct on next /me
        abortRef.current = null;
        setBusy(false);
        return;
      } catch (err) {
        abortRef.current = null;
        // Drop the empty placeholder so we don't leave a blank bubble behind.
        const dropEmpty = (m) => (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m);
        // User hit Stop: keep whatever streamed in, don't re-send via the fallback.
        if (err?.name === 'AbortError') {
          setMsgs(dropEmpty);
          setCredits(Math.max(0, (user?.credits || 0) - COST)); // message was sent; correct on next /me
          setBusy(false);
          return;
        }
        setMsgs(dropEmpty);
        if (err instanceof ApiError && err.status === 402) {
          setMsgs((m) => [...m, { role: 'assistant', content: OUT_OF_CREDITS, error: true }]);
          setBusy(false);
          return;
        }
        // otherwise fall through to the non-streaming fallback below
      }
    }

    // ── Buffered fallback (also the path when streaming isn't configured) ──
    try {
      const { reply, creditsRemaining, topupRemaining, conversationId: cid } = await api.chat(next, conversationId);
      setMsgs((m) => [...m, { role: 'assistant', content: reply }]);
      if (cid) setConversationId(cid);
      if (typeof creditsRemaining === 'number') setCredits(creditsRemaining, topupRemaining);
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 402 ? OUT_OF_CREDITS : `Error: ${err.message}`;
      setMsgs((m) => [...m, { role: 'assistant', content: msg, error: true }]);
    } finally {
      setBusy(false);
    }
  }
  const send = (e) => { e.preventDefault(); submit(draft); };

  function newChat() {
    setConversationId(null);
    setMsgs([GREETING]);
    setDraft('');
    setView('chat');
    stickRef.current = true;
  }

  const loadConvos = useCallback(async () => {
    setLoadingConvos(true);
    try { const { conversations } = await api.conversations(); setConvos(conversations || []); }
    catch { /* ignore — show empty */ }
    finally { setLoadingConvos(false); }
  }, []);

  function openHistory() { setView('history'); loadConvos(); }

  async function openConversation(id) {
    setView('chat');
    setBusy(true);
    stickRef.current = true;
    try {
      const { conversation } = await api.conversation(id);
      setMsgs(conversation?.messages?.length ? conversation.messages : [GREETING]);
      setConversationId(id);
    } catch { /* ignore */ }
    finally { setBusy(false); }
  }

  async function removeConversation(e, id) {
    e.stopPropagation();
    setConvos((c) => c.filter((x) => x.conversationId !== id));
    try { await api.deleteConversation(id); } catch { loadConvos(); }
    if (id === conversationId) newChat();
  }

  // Auto-scroll to the newest message — but only if the user is already near the
  // bottom, so streaming tokens don't yank them back while they read history.
  useEffect(() => {
    if (view === 'chat' && threadRef.current && stickRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, open, busy, view]);

  // Track whether the thread is pinned to the bottom (within ~80px).
  function onThreadScroll() {
    const el = threadRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Focus the input when the panel opens, when returning to the chat view, and
  // after a reply finishes — so you can keep typing without reaching for the mouse.
  useEffect(() => {
    if (open && view === 'chat' && !busy) inputRef.current?.focus();
  }, [open, view, busy]);

  // Auto-send a question forwarded from the right-click "Explain this" menu.
  useEffect(() => {
    if (ask?.text && ask.id !== askedRef.current) { askedRef.current = ask.id; setView('chat'); submit(ask.text); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  // Drag the left edge to resize. The panel is fixed to the right, so the new
  // width is simply the distance from the cursor to the right edge of the
  // viewport. Layout owns/clamps/persists the actual value via onResize.
  function startResize(e) {
    if (!onResize) return;
    e.preventDefault();
    const move = (ev) => {
      const x = ev.touches ? ev.touches[0].clientX : ev.clientX;
      onResize(window.innerWidth - x);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', stop);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', stop);
  }

  if (!open) return null;

  return (
    <aside
      className="fixed right-0 top-0 z-30 flex h-screen flex-col border-l border-slate-200 bg-white shadow-xl motion-safe:animate-slide-in-right"
      style={{ width }}
    >
      {onResize && (
        <div
          onMouseDown={startResize}
          onTouchStart={startResize}
          title="Drag to resize"
          aria-label="Resize assistant panel"
          role="separator"
          aria-orientation="vertical"
          className="group absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize"
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-brand-400" />
        </div>
      )}
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3 text-white">
        <span className="font-semibold">Assistant</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{COST} credits / message</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={newChat} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="New chat" aria-label="New chat"><Plus size={18} aria-hidden /></button>
          <button onClick={() => (view === 'history' ? setView('chat') : openHistory())} className={`rounded p-1 hover:bg-white/10 hover:text-white ${view === 'history' ? 'text-white' : 'text-slate-300'}`} title="History" aria-label="History"><History size={18} aria-hidden /></button>
          <button onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))} className={`rounded p-1 hover:bg-white/10 hover:text-white ${view === 'settings' ? 'text-white' : 'text-slate-300'}`} title="Settings" aria-label="Settings"><Settings size={18} aria-hidden /></button>
          <button onClick={onClose} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="Close" aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
      </div>

      {view === 'settings' ? (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex items-center gap-2 px-1 py-2">
            <button onClick={() => setView('chat')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={15} aria-hidden /> Back</button>
            <span className="ml-auto text-xs font-medium text-slate-400">Settings</span>
          </div>
          <div className="px-1 py-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800">Open automatically</div>
                <p className="mt-0.5 text-xs text-slate-500">Launch the assistant every time you load the app. Turn off to keep it closed until you open it.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoOpen}
                onClick={toggleAutoOpen}
                title="Open the assistant automatically on load"
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${autoOpen ? 'bg-brand-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${autoOpen ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
        </div>
      ) : view === 'history' ? (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex items-center gap-2 px-1 py-2">
            <button onClick={() => setView('chat')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft size={15} aria-hidden /> Back</button>
            <span className="ml-auto text-xs text-slate-400">{convos.length} conversation{convos.length === 1 ? '' : 's'}</span>
          </div>
          {loadingConvos ? (
            <div className="p-6 text-center text-sm text-slate-400">Loading…</div>
          ) : convos.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">No past conversations yet.</div>
          ) : (
            <ul className="space-y-1">
              {convos.map((c) => (
                <li key={c.conversationId}>
                  <button
                    onClick={() => openConversation(c.conversationId)}
                    className={`group flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-50 ${c.conversationId === conversationId ? 'bg-brand-50' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-slate-800">{c.title || 'Conversation'}</div>
                      <div className="truncate text-xs text-slate-400">{c.preview || `${c.msgCount} messages`}</div>
                      <div className="mt-0.5 text-[11px] text-slate-300">{ago(c.updatedAt)}</div>
                    </div>
                    <span onClick={(e) => removeConversation(e, c.conversationId)} className="shrink-0 rounded p-1 text-slate-300 opacity-0 hover:text-red-600 group-hover:opacity-100" title="Delete" role="button" aria-label="Delete conversation"><Trash2 size={15} aria-hidden /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div ref={threadRef} onScroll={onThreadScroll} className="flex-1 space-y-3 overflow-y-auto p-3">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'ml-auto rounded-br-sm bg-brand-600 text-white'
                    : m.error
                      ? 'rounded-bl-sm border border-red-200 bg-red-50 text-red-700'
                      : 'rounded-bl-sm bg-slate-100 text-slate-800'
                }`}
              >
                {m.role === 'assistant' ? (m.content ? renderMessage(m.content, chipFor) : <TypingDots />) : m.content}
              </div>
            ))}
            {busy && msgs[msgs.length - 1]?.role === 'user' && <div className="w-fit rounded-2xl rounded-bl-sm bg-slate-100 px-3 py-2"><TypingDots /></div>}
            {msgs.length <= 1 && !busy && (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => submit(s)}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-700">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={send} className="flex items-center gap-2 border-t border-slate-100 p-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask anything…"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            {busy && chatStreamAvailable ? (
              <button type="button" onClick={() => abortRef.current?.abort()}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Stop
              </button>
            ) : (
              <button disabled={busy} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Send
              </button>
            )}
          </form>
          <div className="px-3 pb-2 text-center text-[11px] text-slate-400">
            Out of credits? <Link to="/account" className="text-brand-600">Top up</Link> or <Link to="/pricing" className="text-brand-600">upgrade</Link>
          </div>
        </>
      )}
    </aside>
  );
}
