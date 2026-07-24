// Site Health Check — run state that outlives the page component.
//
// The check fans out to several metered tools and then synthesises a report,
// which together take 1–3 minutes. All of that used to live in SiteAudit.jsx's
// useState, so routing away unmounted the component and threw the run away —
// after the credits had already been charged. The user paid and got nothing.
//
// Holding the state here (module scope) means navigating away and back re-attaches
// to the run in progress: the fetches were never tied to the component, only their
// bookkeeping was. A full page reload still kills the in-flight requests — the
// browser cancels them — but every individual tool run is saved server-side by the
// gateway, so nothing is lost from history, and the finished report is mirrored to
// sessionStorage so a reload after completion still shows it.

import { toolById } from '@shared/catalog.mjs';
import { api, ApiError } from './api.js';
import { toast, markStepDone } from './ui.js';

const RUN_URL = import.meta.env.VITE_RUN_URL || '';
const CACHE_KEY = 'dm_site_audit';

const EMPTY = { url: '', steps: null, report: null, running: false };

let state = EMPTY;
const subscribers = new Set();

// Replace the snapshot wholesale — useSyncExternalStore compares by reference,
// so mutating in place would render nothing.
function set(patch) {
  state = { ...state, ...patch };
  subscribers.forEach((fn) => fn());
  save();
}

// Only a settled run is worth restoring; `running` can never be resumed after a
// reload, so it is never persisted as true.
function save() {
  try {
    if (state.running || (!state.report && !state.steps)) sessionStorage.removeItem(CACHE_KEY);
    else sessionStorage.setItem(CACHE_KEY, JSON.stringify({ url: state.url, steps: state.steps, report: state.report }));
  } catch { /* storage unavailable — in-memory state still works for this session */ }
}

try {
  const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
  if (cached && typeof cached === 'object') state = { ...EMPTY, ...cached, running: false };
} catch { /* malformed cache — start clean */ }

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export const getSnapshot = () => state;

export const setUrl = (url) => set({ url });

// Tour hooks: paint a finished sample through the real report components, then
// put the form back the way it was.
export const preview = ({ url, steps, report }) => set({ url, steps, report });
export const clear = (url = '') => set({ url, steps: null, report: null, running: false });

// Compact text summary of a heterogeneous tool result, for the AI synthesiser.
function summarize(result) {
  if (!result) return '';
  if (result.text) return String(result.text).slice(0, 3000);
  if (Array.isArray(result.sections)) {
    return result.sections.map((s) => {
      const head = s.title ? `${s.title}: ` : '';
      const body = JSON.stringify(s.items ?? s.rows ?? s.value ?? s.text ?? s).slice(0, 500);
      return head + body;
    }).join('\n').slice(0, 4000);
  }
  if (Array.isArray(result.rows)) return JSON.stringify(result.rows.slice(0, 15)).slice(0, 3000);
  return JSON.stringify(result).slice(0, 2000);
}

/**
 * Kick off a health check. Safe to call from a component that then unmounts.
 * @param {object}   opts
 * @param {string}   opts.site      the URL to audit
 * @param {Array}    opts.runnable  audit tools this tier can run
 * @param {Function} opts.onCredits called with (creditsRemaining, topupRemaining)
 */
export async function start({ site, runnable, onCredits }) {
  if (state.running) return;

  const init = runnable.map((a) => ({ id: a.id, label: a.label, name: toolById(a.id)?.name, status: 'running' }));
  set({ url: site, steps: init, report: null, running: true });

  const setStatus = (id, status) => set({ steps: state.steps.map((x) => (x.id === id ? { ...x, status } : x)) });
  const credits = (r) => { if (typeof r?.creditsRemaining === 'number') onCredits?.(r.creditsRemaining, r.topupRemaining); };

  // Run the checks in parallel; each charges its own credits + may be slow.
  const results = await Promise.all(runnable.map(async (a) => {
    try {
      // Always prefer the Function URL (180s) for audit checks — several take
      // longer than the 30s API-Gateway cap, which would 504 the browser while
      // the Lambda finishes (and still charges). RUN_URL routes around that.
      const resp = await api.runTool(a.id, a.input(site), !!RUN_URL);
      credits(resp);
      const r = resp.result || {};
      if (r.error || r.needsConnect) { setStatus(a.id, 'fail'); return null; }
      setStatus(a.id, 'done');
      return { tool: a.id, name: toolById(a.id).name, text: summarize(r) };
    } catch { setStatus(a.id, 'fail'); return null; }
  }));

  const good = results.filter(Boolean);
  if (!good.length) {
    toast('All checks failed — please try again.', 'error');
    set({ running: false });
    return;
  }

  try {
    const { report, creditsRemaining, topupRemaining } = await api.auditSynthesize(site, good);
    if (typeof creditsRemaining === 'number') onCredits?.(creditsRemaining, topupRemaining);
    set({ report, running: false });
    markStepDone('audit'); // ticks the "Run a site health check" setup step
  } catch (e) {
    set({ running: false });
    toast(e instanceof ApiError && e.status === 402
      ? 'Out of credits for the summary — top up to finish.'
      : (e.message || 'Could not build the report.'), 'error');
  }
}
