import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Home, FolderKanban, HeartPulse, TrendingUp, LineChart, CalendarClock, Plug,
  Zap, Settings, UserRound, BadgeDollarSign, LifeBuoy, MessageCircle, LayoutGrid,
  Sparkles, Search, CornerDownLeft, ArrowUp, ArrowDown,
} from 'lucide-react';
import { TOOLS, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { ToolIcon } from '../lib/icons.jsx';

// ⌘K command palette — one keyboard-driven jump-to for the whole app: every
// tool, every page, your projects and the top actions. Opens on ⌘K / Ctrl-K
// (or the `dm:open-command` event, e.g. from the top-bar search button).
//
// Mounted once in Layout. Navigation and the app's existing window-event idioms
// (dm:open-chat / dm:open-tool / dm:open-tools / dm:open-plan) do the work, so
// the palette stays a thin router over what already exists.

const fire = (name, detail) => window.dispatchEvent(new CustomEvent(name, detail ? { detail } : undefined));

const PAGES = [
  { label: 'Home', hint: 'Dashboard', to: '/', icon: Home },
  { label: 'Projects', hint: 'Your sites', to: '/projects', icon: FolderKanban },
  { label: 'Site Health', hint: 'Audit', to: '/audit', icon: HeartPulse },
  { label: 'Rank Tracking', to: '/tracking', icon: TrendingUp },
  { label: 'Performance', hint: 'GSC · GA4 · Ads', to: '/performance', icon: LineChart },
  { label: 'Schedules', hint: 'Automated runs', to: '/schedules', icon: CalendarClock },
  { label: 'Connect data', hint: 'Integrations', to: '/integrations', icon: Plug },
  { label: 'Credits & usage', to: '/usage', icon: Zap },
  { label: 'Settings', hint: 'Account', to: '/account', icon: Settings },
  { label: 'Your profile', to: '/profile', icon: UserRound },
  { label: 'Plans & pricing', to: '/pricing', icon: BadgeDollarSign },
  { label: 'Support', hint: 'Get help', to: '/support', icon: LifeBuoy },
];

// Cheap subsequence + substring scorer: higher is better, 0 = no match. Favours
// exact prefixes, then word starts, then contiguous, then scattered subsequence.
function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  const idx = t.indexOf(q);
  if (idx === 0) return 700;
  if (idx > 0) return (t[idx - 1] === ' ' ? 600 : 400) - idx;
  // subsequence
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    ti = t.indexOf(q[qi], ti);
    if (ti === -1) return 0;
    ti++;
  }
  return 120 - t.length * 0.1;
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { projects, setActive } = useProjects();
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const close = useCallback(() => { setOpen(false); setQuery(''); setSel(0); }, []);

  // Build every command once per relevant input. `run` closes the palette then acts.
  const commands = useMemo(() => {
    const openTool = (t) => {
      const unlocked = tierMeets(user?.tier, t.minTier);
      if (unlocked && !t.route) fire('dm:open-tool', { id: t.id });
      else navigate(t.route || `/tool/${t.id}`);
    };
    const actions = [
      { id: 'a-chat', label: 'Ask Monty', hint: 'AI concierge', group: 'Actions', icon: MessageCircle, act: () => fire('dm:open-chat') },
      { id: 'a-tools', label: 'Browse all tools', group: 'Actions', icon: LayoutGrid, act: () => fire('dm:open-tools') },
      { id: 'a-plan', label: 'Upgrade plan', group: 'Actions', icon: Sparkles, act: () => fire('dm:open-plan') },
    ];
    const pages = PAGES.map((p) => ({ id: `p-${p.to}`, label: p.label, hint: p.hint, group: 'Go to', icon: p.icon, act: () => navigate(p.to) }));
    const tools = TOOLS.map((t) => ({
      id: `t-${t.id}`, label: t.name, hint: t.category, group: 'Tools', tool: t,
      locked: !tierMeets(user?.tier, t.minTier), act: () => openTool(t),
    }));
    const projs = (projects || []).map((p) => ({
      id: `pr-${p.projectId}`, label: p.name || p.domain || 'Project', hint: 'Project', group: 'Projects', icon: FolderKanban,
      act: () => { setActive(p.projectId); navigate('/projects'); },
    }));
    return [...actions, ...pages, ...tools, ...projs];
  }, [user?.tier, projects, navigate, setActive]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: score(query, `${c.label} ${c.hint || ''}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return (query ? scored : scored).slice(0, 40).map((x) => x.c);
  }, [commands, query]);

  // Global ⌘K / Ctrl-K, plus a dm:open-command event for the top-bar button.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('dm:open-command', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('dm:open-command', onOpen); };
  }, []);

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 20); }, [open]);
  useEffect(() => { setSel(0); }, [query]);
  // Keep the selected row in view as you arrow through.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel, results]);

  if (!open) return null;

  const run = (c) => { close(); c.act(); };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) run(results[sel]); }
  };

  let lastGroup = null;

  return (
    <div className="dm-cmdk-scrim" onMouseDown={close} role="presentation">
      <div
        className="dm-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search size={17} className="shrink-0 text-faint" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search tools, pages, projects…"
            className="w-full bg-transparent py-3.5 text-sm text-strong placeholder:text-faint focus:outline-none"
            aria-label="Search commands"
            autoComplete="off"
            spellCheck="false"
          />
          <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold text-faint sm:block">ESC</kbd>
        </div>

        <div ref={listRef} className="max-h-[min(56vh,420px)] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-faint">No matches for “{query}”.</div>
          ) : (
            results.map((c, i) => {
              const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
              const Icon = c.icon;
              return (
                <div key={c.id}>
                  {header && (
                    <div className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">{header}</div>
                  )}
                  <button
                    type="button"
                    data-sel={i === sel ? '1' : undefined}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => run(c)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left ${i === sel ? 'bg-brand-600 text-white' : 'text-body hover:bg-raised'}`}
                  >
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${i === sel ? 'bg-white/15' : 'bg-raised'}`}>
                      {c.tool
                        ? <ToolIcon tool={c.tool} className={`text-[13px] ${i === sel ? 'text-white' : 'text-dim'}`} />
                        : Icon ? <Icon size={15} className={i === sel ? 'text-white' : 'text-dim'} aria-hidden /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold">{c.label}</span>
                      {c.hint && <span className={`block truncate text-[11px] ${i === sel ? 'text-white/70' : 'text-faint'}`}>{c.hint}</span>}
                    </span>
                    {c.locked && (
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${i === sel ? 'bg-white/20 text-white' : 'bg-sunken text-muted'}`}>Locked</span>
                    )}
                    {i === sel && <CornerDownLeft size={14} className="shrink-0 text-white/80" aria-hidden />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1"><ArrowUp size={11} aria-hidden /><ArrowDown size={11} aria-hidden /> navigate</span>
          <span className="flex items-center gap-1"><CornerDownLeft size={11} aria-hidden /> open</span>
          <span className="ml-auto flex items-center gap-1"><kbd className="rounded border border-line px-1 py-0.5 font-semibold">⌘K</kbd> anytime</span>
        </div>
      </div>
    </div>
  );
}
