// Proactive-assistant engine (client side).
//
// The Helpful Otter can *initiate* a message based on what the user is doing.
// Admins define TRIGGERS (Admin → Assistant) that bind an app EVENT
// (opened a page, went idle, finished a run…) + optional CONDITIONS to a
// message. This module is the pure decision layer: given an event + the current
// context + the admin config, it decides whether a trigger should fire, honours
// cooldowns / per-session caps / a global cap / user dismissals, and records
// what fired. The React wiring lives in components/ProactiveEngine.jsx.
//
// Nothing here touches React or the DOM beyond localStorage/sessionStorage, so
// it's trivially testable and side-effect-light.

import { DEFAULT_PROACTIVE } from '@shared/catalog.mjs';

// Persistent across sessions: cooldown timestamps + dismissal counts + the
// last-seen time (drives the "returning after N days" trigger).
const PKEY = 'dm:proactive:v1';
// Per-tab session: how many nudges have fired (global + per trigger) so we can
// enforce "at most N per session" without them resetting on every navigation.
const SKEY = 'dm:proactive:session';
// Simple on/off the user controls from the assistant's Settings (mirrors the
// dm:mascot / dm:chatAutoOpen flags). '0' = the user muted proactive nudges.
const OPT_KEY = 'dm:proactive';

const HOUR = 3600 * 1000;

export function proactiveMuted() {
  try { return localStorage.getItem(OPT_KEY) === '0'; } catch { return false; }
}
export function setProactiveMuted(muted) {
  try { localStorage.setItem(OPT_KEY, muted ? '0' : '1'); } catch { /* ignore */ }
}

function loadP() { try { return JSON.parse(localStorage.getItem(PKEY)) || {}; } catch { return {}; } }
function saveP(o) { try { localStorage.setItem(PKEY, JSON.stringify(o)); } catch { /* ignore */ } }
function loadS() { try { return JSON.parse(sessionStorage.getItem(SKEY)) || { count: 0, per: {} }; } catch { return { count: 0, per: {} }; } }
function saveS(o) { try { sessionStorage.setItem(SKEY, JSON.stringify(o)); } catch { /* ignore */ } }

/** ISO timestamp of the previous app open (before this one), or null. */
export function readLastSeen() { return loadP().lastSeenAt || null; }
/** Whole days since the previous app open (0 if first ever). */
export function daysSinceLastSeen() {
  const prev = readLastSeen();
  if (!prev) return 0;
  const ms = Date.now() - new Date(prev).getTime();
  return ms > 0 ? Math.floor(ms / (24 * HOUR)) : 0;
}
/** Whether this is the very first time we've seen this browser. */
export function isFirstVisit() { return !readLastSeen(); }
/** Stamp "now" as the last-seen time. Call once per app open, AFTER reading. */
export function touchLastSeen() { const p = loadP(); p.lastSeenAt = new Date().toISOString(); saveP(p); }

// Glob match for a route pattern. Supports a trailing '*' wildcard; otherwise
// an exact match. '/' therefore matches only the dashboard, not every subpath.
export function matchRoute(pattern, path) {
  if (!pattern) return true;
  if (pattern === path) return true;
  if (pattern.endsWith('*')) return String(path).startsWith(pattern.slice(0, -1));
  return false;
}

// Replace {tokens} in a message body with live values. Chip tokens
// ([[tool:id]] / [[go:/path|Label]] / [[action:verb|arg]]) are left intact —
// ChatDrawer's existing renderer turns those into clickable chips.
export function interpolate(text, ctx = {}) {
  return String(text || '')
    .replace(/\{firstName\}/g, ctx.firstName || 'there')
    .replace(/\{domain\}/g, ctx.domain || 'your site')
    .replace(/\{toolName\}/g, ctx.toolName || 'this tool')
    .replace(/\{credits\}/g, ctx.credits == null ? '0' : String(ctx.credits));
}

/** The active config, defaulted. Pass `user.proactive` from /me. */
export function resolveConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.triggers)) return DEFAULT_PROACTIVE;
  return cfg;
}

// Does trigger `t` satisfy this event's conditions given the live context?
function conditionsMet(t, event, { path, ctx = {}, detail = {} }) {
  // Universal gate: a trigger flagged profileIncomplete only fires while the
  // user still has the profile-completion bonus to claim (works on any event).
  if (t.profileIncomplete && !ctx.profileIncomplete) return false;
  switch (event) {
    case 'route_enter':
    case 'idle':
      return matchRoute(t.route, path);
    case 'run_finished':
      return t.runStatus === 'any' || t.runStatus === detail.status;
    case 'low_credits':
      return Number(ctx.credits ?? Infinity) < Number(t.creditsBelow);
    case 'app_open':
      if (t.emptyProjects && !ctx.emptyProjects) return false;
      if (t.firstVisitOnly && !ctx.firstVisit) return false;
      if (Number(t.minDaysAway) > 0 && Number(ctx.daysAway || 0) < Number(t.minDaysAway)) return false;
      return true;
    case 'plan_step_done':
      return true;
    default:
      return false;
  }
}

// Decide which (if any) trigger should fire for `event`. Returns the winning
// trigger object, or null. Does NOT record the fire — call recordFire() once the
// message is actually delivered (so a suppressed/paused delivery doesn't burn
// the cooldown).
export function pickTrigger(event, rawCfg, situation = {}) {
  if (proactiveMuted()) return null;
  const cfg = resolveConfig(rawCfg);
  if (cfg.enabled === false) return null;

  const s = loadS();
  // Global per-session cap. 0 = unlimited (the master switch is the real off).
  if (cfg.maxPerSession > 0 && s.count >= cfg.maxPerSession) return null;

  const p = loadP();
  const now = Date.now();
  const ctx = situation.ctx || {};

  const candidates = (cfg.triggers || [])
    .filter((t) => t && t.enabled !== false && t.event === event)
    .filter((t) => !(Array.isArray(t.tiers) && t.tiers.length && ctx.tier && !t.tiers.includes(ctx.tier)))
    .filter((t) => (p.dismissed?.[t.id] || 0) < 2)               // muted after 2 dismissals
    .filter((t) => (s.per?.[t.id] || 0) < (t.maxPerSession || 1)) // per-trigger session cap
    .filter((t) => {
      const last = p.fired?.[t.id];
      const cd = (t.cooldownHours ?? cfg.defaultCooldownHours ?? 24) * HOUR;
      return !(last && cd > 0 && now - new Date(last).getTime() < cd);
    })
    .filter((t) => conditionsMet(t, event, situation));

  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return candidates[0];
}

/** Record that a trigger's message was delivered (bumps caps + cooldown). */
export function recordFire(trigger) {
  if (!trigger?.id) return;
  const s = loadS();
  s.count = (s.count || 0) + 1;
  s.per = s.per || {}; s.per[trigger.id] = (s.per[trigger.id] || 0) + 1;
  saveS(s);
  const p = loadP();
  p.fired = p.fired || {}; p.fired[trigger.id] = new Date().toISOString();
  saveP(p);
}

/** Record a dismissal — after 2, that trigger stops firing entirely. */
export function recordDismiss(trigger) {
  if (!trigger?.id) return;
  const p = loadP();
  p.dismissed = p.dismissed || {}; p.dismissed[trigger.id] = (p.dismissed[trigger.id] || 0) + 1;
  saveP(p);
}

/** Build the ready-to-show message text for a trigger + context. */
export function buildMessage(trigger, ctx) {
  return interpolate(trigger?.message || '', ctx);
}
