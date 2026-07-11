import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { toolById } from '@shared/catalog.mjs';
import Mascot from './Mascot.jsx';
import {
  resolveConfig, pickTrigger, recordFire, recordDismiss, buildMessage,
  daysSinceLastSeen, isFirstVisit, touchLastSeen,
} from '../lib/proactive.js';

// Headless-ish driver for the proactive Helpful Otter. It watches app activity
// (page changes, idle time, finished runs, low credits…), asks the engine
// whether a trigger should fire, and — when one does — either injects a message
// into the already-open chat or shows a small dismissible "nudge" that opens it.
//
// Delivery is decoupled from Layout via window events the chat already listens
// for: canned text → `dm:open-chat` + `dm:proactive-say`; AI-phrased → `dm:ask`
// (the same path the right-click "Explain this" menu uses, which costs credits).
export default function ProactiveEngine({ paused = false, chatOpen = false }) {
  const { user } = useAuth();
  const { projects, active } = useProjects();
  const location = useLocation();
  const path = location.pathname;

  const [nudge, setNudge] = useState(null); // { trigger, payload } | null
  const nudgeRef = useRef(null); nudgeRef.current = nudge;
  const lastActivity = useRef(Date.now());
  const openedRef = useRef(false);   // app_open handled once
  const navigatedRef = useRef(false); // skip route_enter for the very first route (app_open owns it)

  const config = resolveConfig(user?.proactive);

  // Live values messages can interpolate + conditions can read.
  const buildCtx = useCallback((extra = {}) => ({
    firstName: (user?.name || '').trim().split(/\s+/)[0] || '',
    domain: active?.domain || '',
    tier: user?.tier,
    credits: user?.credits,
    emptyProjects: (projects?.length || 0) === 0,
    profileIncomplete: !user?.profileBonusGranted, // bonus still claimable → profile not done

    toolName: toolNameFromPath(path),
    ...extra,
  }), [user, active, projects, path]);

  // Turn a winning trigger into a message and either inject it (chat open) or
  // raise a nudge (chat closed). Records the fire at the moment we present it.
  const present = useCallback((trigger, ctx) => {
    if (!trigger || nudgeRef.current) return; // one nudge at a time
    const payload = { id: trigger.id, aiPhrase: !!trigger.aiPhrase, aiPrompt: trigger.aiPrompt, message: buildMessage(trigger, ctx) };
    if (chatOpen) {
      deliver(payload);
      recordFire(trigger);
      return;
    }
    recordFire(trigger); // reaching out counts even if they ignore the nudge
    setNudge({ trigger, payload });
  }, [chatOpen]);

  // Evaluate one event against the engine and present the winner (if any).
  const evaluate = useCallback((event, situation = {}) => {
    if (paused) return;
    const ctx = buildCtx(situation.ctx);
    const trigger = pickTrigger(event, config, { ...situation, ctx });
    if (trigger) present(trigger, ctx);
  }, [paused, config, buildCtx, present]);

  // ── app_open ── once, after overlays clear + data has had a moment to load.
  useEffect(() => {
    if (paused || openedRef.current || !user) return;
    openedRef.current = true;
    const daysAway = daysSinceLastSeen();
    const firstVisit = isFirstVisit();
    touchLastSeen();
    const t = setTimeout(() => {
      evaluate('app_open', { ctx: { daysAway, firstVisit } });
    }, 1600);
    return () => clearTimeout(t);
  }, [paused, user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── route_enter ── on every navigation after the first.
  useEffect(() => {
    if (paused) return;
    if (!navigatedRef.current) { navigatedRef.current = true; return; }
    evaluate('route_enter', { path });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── low_credits ── whenever the balance changes.
  useEffect(() => {
    if (paused || user?.credits == null) return;
    evaluate('low_credits');
  }, [user?.credits]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── idle ── track activity; poll every few seconds and let the engine decide
  // (each idle trigger carries its own idleSeconds threshold vs. elapsed idle).
  useEffect(() => {
    const bump = () => { lastActivity.current = Date.now(); };
    const evs = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const id = setInterval(() => {
      if (paused || nudgeRef.current || chatOpen) return;
      const idleMs = Date.now() - lastActivity.current;
      // Cheap pre-check: only bother the engine once we're plausibly idle.
      if (idleMs < 5000) return;
      evaluate('idle', { path, ctx: { idleMs } });
    }, 5000);
    return () => { evs.forEach((e) => window.removeEventListener(e, bump)); clearInterval(id); };
  }, [path, paused, chatOpen, evaluate]);

  // ── run_finished / plan_step_done ── emitted by pages via a window event.
  useEffect(() => {
    const onEvent = (e) => {
      const d = e.detail || {};
      if (!d.event) return;
      evaluate(d.event, { detail: d, ctx: { toolName: d.toolName } });
    };
    window.addEventListener('dm:proactive-event', onEvent);
    return () => window.removeEventListener('dm:proactive-event', onEvent);
  }, [evaluate]);

  function acceptNudge() {
    if (nudge) deliver(nudge.payload);
    setNudge(null);
  }
  function dismissNudge() {
    if (nudge?.trigger) recordDismiss(nudge.trigger);
    setNudge(null);
  }

  if (!nudge) return null;

  // The nudge: a compact peek anchored under the header, near the Otter button.
  return (
    <div className="fixed right-4 top-16 z-40 w-72 motion-safe:animate-slide-in-right">
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xl">
        <div className="flex items-start gap-2.5 p-3">
          <Mascot size={36} className="mt-0.5 shrink-0" />
          <button onClick={acceptNudge} className="min-w-0 flex-1 text-left">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">Monty</div>
            <p className="mt-0.5 line-clamp-4 text-sm text-body">{stripChips(nudge.payload.message) || 'I have a tip for you.'}</p>
          </button>
          <button onClick={dismissNudge} className="shrink-0 rounded p-1 text-slate-300 hover:bg-sunken hover:text-dim" title="Dismiss" aria-label="Dismiss">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="flex border-t border-hair">
          <button onClick={acceptNudge} className="flex-1 py-2 text-sm font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10">Open</button>
          <div className="w-px bg-sunken" />
          <button onClick={dismissNudge} className="flex-1 py-2 text-sm font-medium text-faint hover:bg-raised">Not now</button>
        </div>
      </div>
    </div>
  );
}

// Deliver a proactive message to the chat. Canned text is injected for free;
// an AI-phrased trigger is sent as a prompt (costs credits, like "Explain this").
function deliver(payload) {
  if (payload.aiPhrase) {
    // Same path as the right-click "Explain this" menu — opens chat + asks the LLM.
    const prompt = (payload.aiPrompt || payload.message || '').trim();
    window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));
  } else {
    // Canned: Layout opens the chat and injects the message (free, no LLM call).
    window.dispatchEvent(new CustomEvent('dm:proactive-say', { detail: { text: payload.message } }));
  }
}

// Best-effort tool name from a /tool/:id path (for {toolName} on tool pages).
function toolNameFromPath(path) {
  const m = /^\/tool\/([^/]+)/.exec(path || '');
  if (!m) return '';
  return toolById(decodeURIComponent(m[1]))?.name || '';
}

// Drop [[chip]] tokens for the nudge preview — chips only make sense once the
// message is rendered inside the chat thread.
function stripChips(text) {
  return String(text || '').replace(/\[\[(?:tool|action|go|ask):[^\]]+\]\]/gi, '').replace(/\s{2,}/g, ' ').trim();
}
