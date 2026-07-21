// Agentic pathway helpers for Simple mode.
//
// `buildPathway` (in @shared/catalog.mjs) is the deterministic, always-works
// backbone. This module adds the browser-only bits: an opt-in AI layer that
// personalises the plan from the user's free text, navigation targets that
// deep-link each step into its tool, and localStorage persistence.

import { api } from './api.js';
import { toolById, tierMeets, SIMPLE_NAMES } from '@shared/catalog.mjs';
import { getRecent, isStepDone } from './ui.js';

// ── Navigation ───────────────────────────────────────────────────────────────
// Non-tool suggestions (gaps we nudge the user to close) route to a page.
const ACTION_ROUTES = {
  'connect-google': '/integrations',
};

// The dashboard is mounted at "/" (App.jsx). "/dashboard" is NOT a route — it
// falls through to NotFound, so every fallback below must use this constant.
// A previous fix for the "/tool/rec:…" dead link sent users to "/dashboard"
// instead, which was just a different dead end.
const HOME = '/';

/**
 * Where a plan step should navigate. Tools open their runner (honouring a
 * bespoke `route` like /social-audit); ToolRunner then auto-prefills the site
 * URL from the active project, so we don't need to thread values through here.
 * @returns {{ to:string }}
 */
export function stepTarget({ toolId, action, to }) {
  if (to) return { to };                 // ad-hoc steps carry an explicit route
  if (action) return { to: ACTION_ROUTES[action] || HOME };
  const t = toolById(toolId);
  // Ad-hoc recommendation steps have a synthetic id ("rec:…") and any unknown id
  // isn't a real tool — never build `/tool/rec:…`, which is a dead NotFound route
  // (a user hit exactly this when the step's `to` was lost across a plan sync).
  return { to: t ? (t.route || `/tool/${toolId}`) : HOME };
}

/**
 * Act on a plan step. Navigation alone isn't enough: a recommendation step
 * ("rec:…") resolves to the page it came from — often the one you're already on,
 * and for the docked plan panel that's the dashboard nearly every time. Users
 * reported "Start → doesn't go anywhere" and "the arrow doesn't start anything",
 * which is precisely a navigate() to the current route.
 *
 * So when the target is where we already are, hand the step to Monty instead —
 * that's the actual "start this" action for something with no tool behind it.
 */
export function startStep(item, { navigate, pathname }) {
  const { to } = stepTarget(item);
  if (to && to !== pathname) { navigate(to); return; }

  const label = stepLabel(item);
  const why = item?.why ? ` The reason it's on my plan: "${item.why}".` : '';
  window.dispatchEvent(new CustomEvent('dm:ask', {
    detail: {
      text: `Let's do this step from my plan: "${label}".${why}\n\n`
        + `Walk me through it in plain English, and where you can produce the actual thing I need `
        + `(the copy, the list, the settings to change), write it out in full in this reply.`,
    },
  }));
}

// ── Ad-hoc "recommendation" steps ─────────────────────────────────────────────
// A recommendation added from a tool result isn't a tool run, so it needs its own
// id (never a real toolId — that would collide with run-detection and auto-tick).
// The id is derived from the title so re-adding the same recommendation is
// idempotent (dedupe in addStep). `manual: true` means it's ticked by hand
// (localStepDone can't detect it); `to` deep-links back to where it came from.
export function recStep({ title, why, to }) {
  const slug = String(title || 'note').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return {
    toolId: `rec:${slug || 'note'}`,
    label: String(title || 'Recommendation').slice(0, 80),
    why: String(why || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    manual: true,
    to: to || HOME,
  };
}

/** Beginner-friendly label for a plan item (tool or action). */
export function stepLabel({ toolId, action, label }) {
  if (label) return label;
  if (action) return 'Get set up';
  return SIMPLE_NAMES[toolId]?.name || toolById(toolId)?.name || toolId;
}

// ── Progress detection ───────────────────────────────────────────────────────
// A step is "done" once its tool has actually been run. Most tools land in the
// recents list; the two that don't run through ToolRunner (Site Health Check →
// /audit, Rank Tracking → /tracking) drop their own completion markers instead.
const STEP_DONE_KEY = { 'forensic-audit': 'audit', 'page-analysis': 'audit', 'rank-checker': 'tracking' };
export function localStepDone(toolId) {
  if (getRecent().includes(toolId)) return true;
  const k = STEP_DONE_KEY[toolId];
  return k ? isStepDone(k) : false;
}

// ── Local persistence (offline cache) ────────────────────────────────────────
// PlanContext owns the durable, cross-device copy (on the user's account); this
// localStorage cache gives an instant first paint and an offline fallback.
// v2: flat record { goals, have, freeText, steps, locked, extras, quickWin, done }.
const PLAN_KEY = 'dm_plan_v2';

export function savePlan(plan) {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch { /* quota / private mode */ }
}
export function loadPlan() {
  try { const raw = localStorage.getItem(PLAN_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function clearPlan() {
  try { localStorage.removeItem(PLAN_KEY); } catch { /* ignore */ }
}

// ── AI enrichment ────────────────────────────────────────────────────────────
// Best-effort personalisation over the rules output. NEVER the source of truth:
// any failure (parse, invalid ids, network, out of credits) returns `base`
// untouched, so the user always keeps a working plan.

const clampWhy = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);

// Pull the first balanced {…} block out of a plain-text reply (the chat endpoint
// is conversational and may wrap the JSON in prose despite our instruction).
function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function buildPrompt(base, { freeText, user }) {
  const stepIds = base.steps.map((s) => s.toolId);
  const candidates = [...base.steps, ...base.locked].map((s) => `${s.toolId} — ${toolById(s.toolId)?.name}`);
  const p = user?.profile || {};
  const context = [
    p.industry && `industry: ${p.industry}`,
    p.targetAudience && `audience: ${p.targetAudience}`,
    p.seoExperience && `experience: ${p.seoExperience}`,
  ].filter(Boolean).join('; ');

  return [
    'You are a marketing planner. Personalise a recommended plan for this user.',
    context && `User context — ${context}.`,
    freeText && `They said: "${String(freeText).slice(0, 300)}".`,
    `Current ordered plan steps (toolIds): ${stepIds.join(', ')}.`,
    `Tools available to reference: ${candidates.join(' | ')}.`,
    'Return ONLY minified JSON, no prose, in exactly this shape:',
    '{"steps":[{"toolId":"<one of the plan steps>","why":"<= 14 words, tie to what they said>"}],"extras":[{"toolId":"<any available tool>","why":"<= 14 words>"}]}',
    'Rules: keep every current step (you may reorder), rewrite each "why" to reference their goal, and add at most 2 extras. Use only the toolIds listed above.',
  ].filter(Boolean).join('\n');
}

/**
 * @param {object} base   output of buildPathway()
 * @param {object} opts    { freeText, user, onCredits? }
 * @returns {Promise<object>} an enriched plan, or `base` on any failure
 */
export async function enrichPathway(base, { freeText, user, onCredits } = {}) {
  try {
    const prompt = buildPrompt(base, { freeText, user });
    const { reply, creditsRemaining, topupRemaining } = await api.chat([{ role: 'user', content: prompt }]);
    if (typeof creditsRemaining === 'number') onCredits?.(creditsRemaining, topupRemaining);

    const parsed = extractJson(reply || '');
    if (!parsed || !Array.isArray(parsed.steps)) return base;

    const tier = user?.tier || 'free';
    const baseIds = new Set(base.steps.map((s) => s.toolId));

    // Reorder/reword: honour only the AI entries that map to real plan steps;
    // append any base steps the AI dropped so nothing is lost.
    const whyById = new Map();
    const order = [];
    for (const e of parsed.steps) {
      if (e && baseIds.has(e.toolId) && !whyById.has(e.toolId)) {
        whyById.set(e.toolId, clampWhy(e.why) || base.steps.find((s) => s.toolId === e.toolId).why);
        order.push(e.toolId);
      }
    }
    for (const s of base.steps) if (!whyById.has(s.toolId)) { whyById.set(s.toolId, s.why); order.push(s.toolId); }
    const steps = order.map((id) => {
      const orig = base.steps.find((s) => s.toolId === id);
      return { ...orig, why: whyById.get(id) };
    });

    // Extras: keep base extras, then fold in up to 2 valid AI suggestions.
    const taken = new Set([...baseIds, ...base.locked.map((s) => s.toolId), ...base.extras.map((e) => e.toolId).filter(Boolean)]);
    const aiExtras = [];
    for (const e of (Array.isArray(parsed.extras) ? parsed.extras : [])) {
      const t = e && toolById(e.toolId);
      if (!t || taken.has(e.toolId) || aiExtras.length >= 2) continue;
      taken.add(e.toolId);
      aiExtras.push({ toolId: e.toolId, why: clampWhy(e.why) || t.desc, locked: !tierMeets(tier, t.minTier) });
    }
    const extras = [...base.extras, ...aiExtras].slice(0, 5);

    const quickWin = steps[0]?.toolId || base.quickWin;
    if (steps[0]) steps.forEach((s, i) => { s.quickWin = i === 0; });
    return { ...base, steps, extras, quickWin, aiRefined: true };
  } catch {
    return base; // out of credits, offline, bad JSON — the rules plan still stands
  }
}
