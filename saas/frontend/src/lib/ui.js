import { useEffect, useState } from 'react';
import { TERMS_VERSION, NDA_VERSION } from '@shared/catalog.mjs';

// ── Toasts ───────────────────────────────────────────────────────────────────
export function toast(msg, type = 'info') {
  window.dispatchEvent(new CustomEvent('dm:toast', { detail: { msg, type, id: Math.random().toString(36).slice(2) } }));
}

// ── In-app confirm / prompt ──────────────────────────────────────────────────
// Promise-based replacements for the browser's blocking window.confirm/prompt,
// rendered as our own <Modal> by <DialogHost> (mounted once in Layout). Keeping
// the imperative call shape (like toast) means call sites just `await` them
// instead of wiring a hook through every component:
//   if (!(await confirmDialog('Delete this?'))) return;
//   const name = await promptDialog({ message: 'New name?', defaultValue: cur });
// confirmDialog resolves true/false; promptDialog resolves the string or null
// (cancelled). Until the host mounts we fall back to the native dialog so a call
// can never hang.
let _dialogHandler = null;
export function _registerDialogHandler(fn) { _dialogHandler = fn; }
export function confirmDialog(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  if (!_dialogHandler) return Promise.resolve(window.confirm(o.message || 'Are you sure?'));
  return _dialogHandler({ kind: 'confirm', ...o });
}
export function promptDialog(opts) {
  const o = typeof opts === 'string' ? { message: opts } : (opts || {});
  if (!_dialogHandler) { const v = window.prompt(o.message || '', o.defaultValue ?? ''); return Promise.resolve(v); }
  return _dialogHandler({ kind: 'prompt', ...o });
}

// ── Clipboard + downloads ────────────────────────────────────────────────────
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard', 'success'); }
  catch { toast('Copy failed', 'error'); }
}

export function downloadCsv(rows, filename = 'export.csv') {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast('CSV downloaded', 'success');
}

// ── Misc ─────────────────────────────────────────────────────────────────────
export function useMediaQuery(query) {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = (e) => setMatch(e.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [query]);
  return match;
}

export function fmtNum(v) {
  if (v == null || v === '') return '—';
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && /^[\d.,-]+$/.test(String(v).trim()) ? n.toLocaleString() : v;
}

// ── Onboarding ───────────────────────────────────────────────────────────────
// Local mirror of the server's onboarding flags.
//
// Every "don't ask me again" flag lives server-side (durable, cross-device) and
// is written by AuthContext.setOnboarding — which is deliberately fire-and-forget
// and SWALLOWS failures. That's fine for the happy path, but when the write fails
// (offline, a 5xx, the CORS outage we hit in July) the flag never lands, and the
// user is dragged through the whole welcome → tour → profile gauntlet again on
// every single login. That's the "onboarding loop" bug.
//
// So we mirror each flag into localStorage the moment it's set and merge the two
// on read: server wins where it has an answer, the mirror covers the gap while a
// write is in flight or has failed. Worst case (cleared storage AND a failed
// write) the user is asked once more — never repeatedly.
const ONBOARD_MIRROR_KEY = 'dm_onboarding_mirror';

function readMirror() {
  try { return JSON.parse(localStorage.getItem(ONBOARD_MIRROR_KEY) || '{}') || {}; }
  catch { return {}; }
}

/** Merge a patch into the local onboarding mirror. Called by setOnboarding. */
export function mirrorOnboarding(patch) {
  if (!patch || typeof patch !== 'object') return;
  try {
    localStorage.setItem(ONBOARD_MIRROR_KEY, JSON.stringify({ ...readMirror(), ...patch }));
  } catch { /* storage full or unavailable — server state is still authoritative */ }
}

/** The user's onboarding flags, with the local mirror filling any server gaps. */
export function onboardingOf(user) {
  return { ...readMirror(), ...(user?.onboarding || {}) };
}

// Show the first-run welcome only to genuinely new accounts that haven't been
// welcomed yet. Gating on account age (server `createdAt`) cleanly excludes all
// existing users — they never created onboarding state, so without this they'd
// all see the welcome on next load. 24h window catches a real first session.
const NEW_ACCOUNT_MS = 24 * 60 * 60 * 1000;
export function needsWelcome(user) {
  if (!user || onboardingOf(user).welcomed) return false;
  if (!user.createdAt) return false; // legacy account with no timestamp → never new
  const age = Date.now() - new Date(user.createdAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < NEW_ACCOUNT_MS;
}

// Has the user accepted the CURRENT version of the Terms/Privacy? A version bump
// (TERMS_VERSION) makes this false again so the consent gate re-prompts. Applies
// to everyone — existing accounts that never accepted are gated on next login.
export function hasAcceptedTerms(user) {
  return !!user
    && user.onboarding?.acceptedTerms === true
    && user.onboarding?.acceptedTermsVersion === TERMS_VERSION;
}

// Has the user accepted the current soft-launch Free Trial + NDA? Bumping
// NDA_VERSION re-prompts everyone (same pattern as hasAcceptedTerms).
export function hasAcceptedNda(user) {
  return !!user
    && user.onboarding?.acceptedNda === true
    && user.onboarding?.acceptedNdaVersion === NDA_VERSION;
}

// Recently-used tools (most recent first, capped).
const RECENT_KEY = 'dm_recent_tools';
export function pushRecent(toolId) {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== toolId);
    localStorage.setItem(RECENT_KEY, JSON.stringify([toolId, ...cur].slice(0, 6)));
  } catch { /* ignore */ }
}
export function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

// Onboarding-step completion markers for actions that aren't plain tool runs
// (the Site Health Check and Rank Tracking don't go through ToolRunner, so they
// never hit `pushRecent`). The setup checklist reads these for accurate ticks.
export function markStepDone(key) {
  try { localStorage.setItem(`dm_step_${key}`, '1'); } catch { /* ignore */ }
}
export function isStepDone(key) {
  try { return localStorage.getItem(`dm_step_${key}`) === '1'; } catch { return false; }
}

// Per-tool last-used inputs.
export function saveLastInput(toolId, values) {
  try { localStorage.setItem(`dm_lastinput_${toolId}`, JSON.stringify(values)); } catch { /* ignore */ }
}
export function loadLastInput(toolId) {
  try { return JSON.parse(localStorage.getItem(`dm_lastinput_${toolId}`) || 'null'); } catch { return null; }
}
