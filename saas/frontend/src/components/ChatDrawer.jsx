import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { CREDIT_COSTS, toolById } from '@shared/catalog.mjs';
import { X, Plus, History, Trash2, ArrowLeft, ArrowRight } from 'lucide-react';

const COST = CREDIT_COSTS.ai_chat ?? 2;
const GREETING = { role: 'assistant', content: "Hi! I'm your Digimetrics assistant. Ask me about any tool, how to get started, or your connected Search Console / GA4 / Ads numbers." };

// Render an assistant message, turning [[tool:<id>]] tokens into clickable
// "open tool" chips that navigate to the tool (and close the drawer).
function renderMessage(text, onToolClick) {
  const re = /\[\[tool:([a-z0-9-]+)\]\]/gi;
  const out = [];
  let last = 0, m, k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tool = toolById(m[1]);
    if (tool) {
      out.push(
        <button key={`t${k++}`} onClick={() => onToolClick(tool.id)}
          className="mx-0.5 my-0.5 inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 align-middle text-xs font-semibold text-white hover:bg-brand-700">
          {tool.name} <ArrowRight size={12} aria-hidden />
        </button>
      );
    } else {
      out.push(m[0]); // unknown id — leave as-is
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
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
export default function ChatDrawer({ open, onClose, width = 384, ask }) {
  const { setCredits } = useAuth();
  const navigate = useNavigate();
  const openTool = (id) => { onClose?.(); navigate(`/tool/${id}`); };
  const [msgs, setMsgs] = useState([GREETING]);
  const [conversationId, setConversationId] = useState(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('chat'); // 'chat' | 'history'
  const [convos, setConvos] = useState([]);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const threadRef = useRef(null);
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const askedRef = useRef(null);

  async function submit(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    const next = [...msgsRef.current, { role: 'user', content: text }];
    setMsgs(next);
    setDraft('');
    setBusy(true);
    try {
      const { reply, creditsRemaining, conversationId: cid } = await api.chat(next, conversationId);
      setMsgs((m) => [...m, { role: 'assistant', content: reply }]);
      if (cid) setConversationId(cid);
      if (typeof creditsRemaining === 'number') setCredits(creditsRemaining);
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 402
        ? "You're out of credits — top up or upgrade to keep chatting."
        : `Error: ${err.message}`;
      setMsgs((m) => [...m, { role: 'assistant', content: msg }]);
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

  useEffect(() => {
    if (view === 'chat' && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [msgs, open, busy, view]);

  // Auto-send a question forwarded from the right-click "Explain this" menu.
  useEffect(() => {
    if (ask?.text && ask.id !== askedRef.current) { askedRef.current = ask.id; setView('chat'); submit(ask.text); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  if (!open) return null;

  return (
    <aside
      className="fixed right-0 top-0 z-30 flex h-screen flex-col border-l border-slate-200 bg-white shadow-xl"
      style={{ width }}
    >
      <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-900 px-4 py-3 text-white">
        <span className="font-semibold">Assistant</span>
        <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{COST} credits / message</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={newChat} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="New chat" aria-label="New chat"><Plus size={18} aria-hidden /></button>
          <button onClick={() => (view === 'history' ? setView('chat') : openHistory())} className={`rounded p-1 hover:bg-white/10 hover:text-white ${view === 'history' ? 'text-white' : 'text-slate-300'}`} title="History" aria-label="History"><History size={18} aria-hidden /></button>
          <button onClick={onClose} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="Close" aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
      </div>

      {view === 'history' ? (
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
          <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto p-3">
            {msgs.map((m, i) => (
              <div
                key={i}
                className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'ml-auto rounded-br-sm bg-brand-600 text-white'
                    : 'rounded-bl-sm bg-slate-100 text-slate-800'
                }`}
              >
                {m.role === 'assistant' ? renderMessage(m.content, openTool) : m.content}
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
        </>
      )}
    </aside>
  );
}
