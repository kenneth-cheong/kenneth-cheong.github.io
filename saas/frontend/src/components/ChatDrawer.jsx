import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api, ApiError, chatStream, chatStreamAvailable } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { CREDIT_COSTS, toolById } from '@shared/catalog.mjs';
import { toast } from '../lib/ui.js';
import { X, Plus, History, Trash2, ArrowLeft, ArrowRight, Settings, Bell, BellOff } from 'lucide-react';
import PlanPanelCard from './PlanPanelCard.jsx';
import Mascot from './Mascot.jsx';
import { proactiveMuted, setProactiveMuted } from '../lib/proactive.js';

const COST = CREDIT_COSTS.ai_chat ?? 2;
const GREETING = { role: 'assistant', content: "Hi! I'm Monty, your Digimetrics assistant. Ask me about any tool, how to get started, or your connected Search Console / GA4 / Ads numbers." };

// Assistant replies arrive as lightweight Markdown (## headings, **bold**,
// numbered/bulleted lists, `code`, links) interleaved with our own
// [[tool:id]] / [[go:path|label]] / [[action:verb|arg]] / [[ask:label|text]]
// chip tokens. renderMessage turns all of it into React nodes so nothing shows
// up as raw markup. We render to elements (not dangerouslySetInnerHTML) so
// there's no HTML-injection surface and the chips stay real buttons.
const TOKEN_RE = /\[\[(tool|action|go|ask):([^\]]+)\]\]/gi;
// Source for the inline-emphasis matcher. A FRESH RegExp is built per call
// (below) because inlineMd recurses — a shared /g regex would clobber its own
// lastIndex across recursion levels.
const INLINE_SRC = '(\\*\\*)([^]+?)\\1|(\\*)([^]+?)\\3|`([^`]+)`|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)';

// Inline Markdown within one text run: bold, italic, code, links.
function inlineMd(text, keyBase) {
  const re = new RegExp(INLINE_SRC, 'g');
  const out = [];
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}i${i++}`;
    if (m[1]) out.push(<strong key={key} className="font-semibold">{inlineMd(m[2], key)}</strong>);
    else if (m[3]) out.push(<em key={key} className="italic">{inlineMd(m[4], key)}</em>);
    else if (m[5] != null) out.push(<code key={key} className="rounded bg-overlay/70 px-1 py-0.5 text-[0.85em]">{m[5]}</code>);
    else if (m[6] != null) out.push(<a key={key} href={m[7]} target="_blank" rel="noreferrer" className="text-brand-700 dark:text-brand-300 underline">{m[6]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// A single text run: split out our chip tokens, inline-Markdown the rest.
function renderInline(text, chipFor, keyBase) {
  const out = [];
  let last = 0, m, i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) inlineMd(text.slice(last, m.index), `${keyBase}t${i}`).forEach((n) => out.push(n));
    out.push(chipFor(m[1].toLowerCase(), m[2], `${keyBase}c${i}`) ?? m[0]);
    last = m.index + m[0].length; i++;
  }
  if (last < text.length) inlineMd(text.slice(last), `${keyBase}e`).forEach((n) => out.push(n));
  return out;
}

function renderMessage(text, chipFor) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const para = [];
  let k = 0, i = 0;
  const flushPara = () => {
    if (!para.length) return;
    const key = `p${k++}`;
    blocks.push(<p key={key} className="whitespace-pre-wrap">{renderInline(para.join('\n'), chipFor, key)}</p>);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const key = `h${k++}`;
      const cls = level <= 1 ? 'mt-1 text-base font-bold' : level === 2 ? 'mt-2 text-sm font-bold' : 'mt-1.5 text-sm font-semibold';
      blocks.push(<div key={key} className={cls}>{renderInline(h[2], chipFor, key)}</div>);
      i++; continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    const bulleted = /^\s*[-*]\s+/.test(line);
    if (ordered || bulleted) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const mm = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!mm) break;
        const key = `li${k++}`;
        items.push(<li key={key}>{renderInline(mm[1], chipFor, key)}</li>);
        i++;
      }
      const key = `l${k++}`;
      blocks.push(ordered
        ? <ol key={key} className="list-decimal space-y-1 pl-5">{items}</ol>
        : <ul key={key} className="list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line); i++;
  }
  flushPara();
  return <div className="space-y-2">{blocks}</div>;
}

// Animated "assistant is typing" indicator — three bouncing dots.
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1" role="status" aria-label="Assistant is typing">
      <span className="dm-mc-dot h-1.5 w-1.5 rounded-full" />
      <span className="dm-mc-dot h-1.5 w-1.5 rounded-full" />
      <span className="dm-mc-dot h-1.5 w-1.5 rounded-full" />
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
export default function ChatDrawer({ open, onClose, ask, say }) {
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

  // Build a clickable chip for an assistant token (tool / go / action / ask).
  function chipFor(type, raw, key) {
    const chip = (label, onClick) => (
      <button key={`c${key}`} onClick={onClick}
        className="mx-0.5 my-0.5 inline-flex items-center gap-1 rounded-full bg-brand-600 px-2.5 py-0.5 align-middle text-xs font-semibold text-white hover:bg-brand-700">
        {label} <ArrowRight size={12} aria-hidden />
      </button>
    );
    // Quick-reply chip: clicking sends `text` to Monty (a follow-up question)
    // rather than navigating. Outlined so it reads as "ask this", not "go there".
    const replyChip = (label, text) => (
      <button key={`c${key}`} onClick={() => submit(text)} disabled={busy}
        className="mx-0.5 my-0.5 inline-flex items-center gap-1 rounded-full border border-brand-300 dark:border-brand-500/40 bg-brand-50 dark:bg-brand-500/10 px-2.5 py-0.5 align-middle text-xs font-semibold text-brand-700 dark:text-brand-300 hover:border-brand-400 hover:bg-brand-100 dark:hover:bg-brand-500/15 disabled:opacity-50">
        {label}
      </button>
    );
    if (type === 'tool') { const t = toolById(raw.trim()); return t ? chip(t.name, () => go(`/tool/${t.id}`)) : null; }
    if (type === 'go') { const [path, label] = raw.split('|'); return chip(label?.trim() || path.trim(), () => go(path.trim())); }
    if (type === 'ask') {
      // [[ask:Label]] sends "Label"; [[ask:Label|the text to send]] sends the text.
      const [label, ...rest] = raw.split('|');
      const text = (rest.join('|') || label).trim();
      return label.trim() ? replyChip(label.trim(), text) : null;
    }
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
  // Show the assistant's mascot face ("Helpful Otter"). On by default; a prototype flag so
  // it's trivially reversible from Settings (and we can eyeball it before art lands).
  const [mascot, setMascot] = useState(() => localStorage.getItem('dm:mascot') !== '0');
  const toggleMascot = () => setMascot((on) => { const next = !on; localStorage.setItem('dm:mascot', next ? '1' : '0'); return next; });
  // Whether the Otter may start a conversation on its own (proactive nudges).
  // Mirrors the global flag the ProactiveEngine reads; off = purely reactive.
  const [proTips, setProTips] = useState(() => !proactiveMuted());
  const toggleProTips = () => setProTips((on) => { const next = !on; setProactiveMuted(!next); return next; });
  const [convos, setConvos] = useState([]);
  const [loadingConvos, setLoadingConvos] = useState(false);
  const threadRef = useRef(null);
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const askedRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);          // AbortController for the in-flight stream
  const stickRef = useRef(true);          // is the thread scrolled near the bottom?

  const OUT_OF_CREDITS = "You're out of credits — top up or upgrade to keep chatting.";

  // Where the user is right now, so Monty can answer vague questions ("what does
  // this do", "what goes in each field") about the tool/page they're looking at.
  function pageContext() {
    const path = location.pathname;
    const m = /^\/tool\/([^/]+)/.exec(path);
    return { path, toolId: m ? decodeURIComponent(m[1]) : null };
  }

  async function submit(text) {
    text = String(text || '').trim();
    if (!text || busy) return;
    const ctx = pageContext();
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
        }, { signal: ac.signal, context: ctx });
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
      const { reply, creditsRemaining, topupRemaining, conversationId: cid } = await api.chat(next, conversationId, ctx);
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

  // Inject a proactive Otter message (canned, admin-authored). Unlike `ask` this
  // doesn't call the LLM or cost credits — it just drops an assistant bubble the
  // user can reply to. `proactive: true` marks it (styling / future analytics).
  const saidRef = useRef(null);
  useEffect(() => {
    if (say?.text && say.id !== saidRef.current) {
      saidRef.current = say.id;
      setView('chat');
      stickRef.current = true;
      setMsgs((m) => [...m, { role: 'assistant', content: say.text, proactive: true }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [say]);

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

  // Mount → next frame → open, so the popover has a start state to grow FROM.
  // Kept mounted through the close transition (260ms per .dm-monty-chat).
  const [shown, setShown] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(r);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 260);
    return () => clearTimeout(t);
  }, [open]);

  // Anchor the panel's top edge just below the sticky top nav so it uses the
  // full height of the window beneath the header — the header's height varies
  // (the plan breadcrumb adds a row off-dashboard), so we measure it live rather
  // than hard-code an offset. CSS reads the result via --dm-monty-top. Runs once
  // the panel is actually in the DOM (mounted), and tracks header size changes.
  const asideRef = useRef(null);
  useEffect(() => {
    if (!mounted) return;
    const header = document.querySelector('header');
    const el = asideRef.current;
    if (!header || !el) return;
    const apply = () => {
      const bottom = Math.round(header.getBoundingClientRect().bottom);
      el.style.setProperty('--dm-monty-top', `${Math.max(bottom + 8, 12)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(header);
    window.addEventListener('resize', apply);
    return () => { ro.disconnect(); window.removeEventListener('resize', apply); };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <aside
      ref={asideRef}
      className={`dm-monty-chat ${shown ? 'dm-monty-chat-open' : ''}`}
      role="dialog"
      aria-label="Monty the assistant"
    >
      {/* Header — the mockup's .mc-head: avatar, name, and a live status line.
          The panel is a fixed 384px now, so the old `width >= 460` gate on the
          cost pill could never be true; it moved into the status line instead. */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5 text-white">
        {mascot && <Mascot size={40} className="shrink-0" title="Monty, your assistant" />}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold leading-tight">Monty</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold text-muted">
            <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-pos" style={{ boxShadow: '0 0 0 3px rgb(var(--c-pos) / .22)' }} aria-hidden />
            AI concierge · {COST} credit{COST === 1 ? '' : 's'} / message
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {/* One-tap switch for Monty's proactive prompts (Monty starting a chat
              on its own). On by default; off = reactive-only. Mirrors the fuller
              "Proactive tips" toggle in Settings. */}
          <button
            onClick={toggleProTips}
            role="switch"
            aria-checked={proTips}
            className={`rounded p-1 hover:bg-white/10 hover:text-white ${proTips ? 'text-slate-300' : 'text-amber-300'}`}
            title={proTips ? 'Monty prompts are ON — click to stop Monty starting chats' : 'Monty prompts are OFF — click to let Monty offer tips'}
            aria-label={proTips ? 'Turn off Monty prompts' : 'Turn on Monty prompts'}
          >
            {proTips ? <Bell size={18} aria-hidden /> : <BellOff size={18} aria-hidden />}
          </button>
          <button onClick={newChat} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="New chat" aria-label="New chat"><Plus size={18} aria-hidden /></button>
          <button onClick={() => (view === 'history' ? setView('chat') : openHistory())} className={`rounded p-1 hover:bg-white/10 hover:text-white ${view === 'history' ? 'text-white' : 'text-slate-300'}`} title="History" aria-label="History"><History size={18} aria-hidden /></button>
          <button onClick={() => setView((v) => (v === 'settings' ? 'chat' : 'settings'))} className={`rounded p-1 hover:bg-white/10 hover:text-white ${view === 'settings' ? 'text-white' : 'text-slate-300'}`} title="Settings" aria-label="Settings"><Settings size={18} aria-hidden /></button>
          <button onClick={onClose} className="rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" title="Close" aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
      </div>

      {view === 'settings' ? (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex items-center gap-2 px-1 py-2">
            <button onClick={() => setView('chat')} className="flex items-center gap-1 text-sm text-muted hover:text-strong"><ArrowLeft size={15} aria-hidden /> Back</button>
            <span className="ml-auto text-xs font-medium text-faint">Settings</span>
          </div>
          <div className="px-1 py-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-strong">Open automatically</div>
                <p className="mt-0.5 text-xs text-muted">Launch the assistant every time you load the app. Turn off to keep it closed until you open it.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoOpen}
                onClick={toggleAutoOpen}
                title="Open the assistant automatically on load"
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${autoOpen ? 'bg-brand-600' : 'bg-overlay'}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${autoOpen ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
          <div className="px-1 pb-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-strong"><Mascot size={20} /> Show Monty</div>
                <p className="mt-0.5 text-xs text-muted">Show the friendly assistant character in the panel. Turn off for a plain, text-only look.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={mascot}
                onClick={toggleMascot}
                title="Show the assistant mascot"
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${mascot ? 'bg-brand-600' : 'bg-overlay'}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${mascot ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
          <div className="px-1 pb-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-strong">Proactive tips</div>
                <p className="mt-0.5 text-xs text-muted">Let Monty start a chat when it spots something useful — a finished run, low credits, a page you seem stuck on. Turn off to keep it reactive only.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={proTips}
                onClick={toggleProTips}
                title="Let the assistant reach out proactively"
                className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${proTips ? 'bg-brand-600' : 'bg-overlay'}`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${proTips ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
        </div>
      ) : view === 'history' ? (
        <div className="flex-1 overflow-y-auto p-2">
          <div className="flex items-center gap-2 px-1 py-2">
            <button onClick={() => setView('chat')} className="flex items-center gap-1 text-sm text-muted hover:text-strong"><ArrowLeft size={15} aria-hidden /> Back</button>
            <span className="ml-auto text-xs text-faint">{convos.length} conversation{convos.length === 1 ? '' : 's'}</span>
          </div>
          {loadingConvos ? (
            <div className="p-6 text-center text-sm text-faint">Loading…</div>
          ) : convos.length === 0 ? (
            <div className="p-6 text-center text-sm text-faint">No past conversations yet.</div>
          ) : (
            <ul className="space-y-1">
              {convos.map((c) => (
                <li key={c.conversationId}>
                  <button
                    onClick={() => openConversation(c.conversationId)}
                    className={`group flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-raised ${c.conversationId === conversationId ? 'bg-brand-50 dark:bg-brand-500/10' : ''}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-strong">{c.title || 'Conversation'}</div>
                      <div className="truncate text-xs text-faint">{c.preview || `${c.msgCount} messages`}</div>
                      <div className="mt-0.5 text-[11px] text-slate-300">{ago(c.updatedAt)}</div>
                    </div>
                    <span onClick={(e) => removeConversation(e, c.conversationId)} className="shrink-0 rounded p-1 text-slate-300 opacity-0 hover:text-red-600 dark:hover:text-red-400 group-hover:opacity-100" title="Delete" role="button" aria-label="Delete conversation"><Trash2 size={15} aria-hidden /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <PlanPanelCard />
          <div ref={threadRef} onScroll={onThreadScroll} className="flex-1 space-y-3 overflow-y-auto p-3">
            {msgs.map((m, i) => {
              const isUser = m.role === 'user';
              const bubble = (
                <div
                  className={`max-w-[86%] whitespace-pre-wrap px-3.5 py-2.5 text-[12.5px] leading-relaxed ${
                    isUser
                      ? 'dm-mc-me ml-auto'
                      : m.error
                        ? 'rounded-2xl rounded-bl-sm border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-300'
                        : 'dm-mc-bot text-strong'
                  }`}
                >
                  {m.role === 'assistant' ? (m.content ? renderMessage(m.content, chipFor) : <TypingDots />) : m.content}
                </div>
              );
              if (isUser) return <div key={i}>{bubble}</div>;
              // Assistant reply — front it with the mascot so guidance reads as
              // coming from one character (skip on error bubbles: no face on failures).
              return (
                <div key={i} className="flex items-end gap-2">
                  {mascot && !m.error && <Mascot size={40} className="mb-0.5 shrink-0" />}
                  {bubble}
                </div>
              );
            })}
            {busy && msgs[msgs.length - 1]?.role === 'user' && (
              <div className="flex items-end gap-2">
                {mascot && <Mascot size={40} className="mb-0.5 shrink-0" />}
                <div className="dm-mc-bot w-fit px-3.5 py-3"><TypingDots /></div>
              </div>
            )}
            {msgs.length <= 1 && !busy && (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => submit(s)}
                    className="rounded-full border border-line bg-surface px-3 py-1.5 text-left text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-700 dark:hover:text-brand-300">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          <form onSubmit={send} className="flex items-center gap-2 border-t border-hair p-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask anything…"
              className="flex-1 rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
            {busy && chatStreamAvailable ? (
              <button type="button" onClick={() => abortRef.current?.abort()}
                className="rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-dim hover:bg-raised">
                Stop
              </button>
            ) : (
              <button disabled={busy} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
                Send
              </button>
            )}
          </form>
          <div className="px-3 pb-2 text-center text-[11px] text-faint">
            Out of credits? <Link to="/account" className="text-brand-600 dark:text-brand-400">Top up</Link> or <Link to="/pricing" className="text-brand-600 dark:text-brand-400">upgrade</Link>
          </div>
        </>
      )}
    </aside>
  );
}
