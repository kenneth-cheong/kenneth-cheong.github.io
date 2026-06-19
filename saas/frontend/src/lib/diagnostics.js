// Background diagnostics collector for the Report-a-Fault reporter.
//
// A dependency-free singleton that quietly records what's needed to reproduce a
// bug: the JS errors thrown, the error prompts the user saw, the API calls that
// failed, and (on demand) the values currently typed into on-screen fields.
// Everything lives in small ring buffers so it never leaks memory, and nothing
// leaves the browser until the user reviews and submits a report.
//
// `init()` wires the global listeners once; `snapshot()` produces the structured
// object that gets attached to a support ticket. `dm:fault` is emitted on hard
// failures so FaultReporter can auto-open.

const MAX = 15; // ring-buffer size per channel

const state = {
  errors: [], // { message, stack, source, ts }
  apiFailures: [], // { method, path, status, message, ts }
  errorToasts: [], // { message, ts }
  user: null, // { userId, email, tier } — stamped by setUser
  started: false,
};

// Keys whose values must never be captured, even from a visible field.
const SENSITIVE_RE = /pass|pwd|token|secret|api[-_]?key|authorization|auth\b|card|cvv|cvc|ssn|otp/i;

function push(buf, item) {
  buf.push(item);
  if (buf.length > MAX) buf.shift();
}

const nowIso = () => new Date().toISOString();
const clamp = (s, n = 500) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

// Mask anything that looks like a secret value defensively (long token-ish blobs).
function redact(v) {
  if (typeof v !== 'string') return v;
  if (/^[A-Za-z0-9._-]{24,}$/.test(v.trim())) return '«redacted»';
  return clamp(v);
}

export function setUser(user) {
  state.user = user ? { userId: user.userId, email: user.email, tier: user.tier } : null;
}

export function recordError({ message, stack, source }) {
  push(state.errors, { message: clamp(String(message || 'Unknown error'), 1000), stack: clamp(stack, 2000), source, ts: nowIso() });
}

// Called from React's ErrorBoundary when a render crashes the page.
export function recordBoundaryError(error, info) {
  recordError({ message: error?.message || String(error), stack: error?.stack || info?.componentStack, source: 'react' });
}

// Optional breadcrumb for a tool run that failed (toolId + which inputs were set).
export function recordToolFailure(toolId, inputs, error) {
  const fields = inputs && typeof inputs === 'object' ? Object.keys(inputs).filter((k) => inputs[k] != null && inputs[k] !== '') : [];
  recordError({ message: `Tool "${toolId}" failed: ${error?.message || error}`, stack: error?.stack, source: `tool:${toolId}` });
  return fields;
}

// True when a failure is "hard" enough to auto-open the reporter. Expected,
// user-actionable statuses (auth refresh, out-of-credits, rate-limit, validation)
// don't count — only network errors and server faults.
function isHardStatus(status) {
  return !status || status === 0 || status >= 500;
}

// Derive a human label for a form field from its label/aria/placeholder/name.
function labelFor(el) {
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab?.textContent) return lab.textContent.trim();
  }
  const wrap = el.closest('label');
  if (wrap?.textContent) return wrap.textContent.trim();
  return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || 'field';
}

// Walk the live DOM for filled inputs the user can review before sharing.
// Skips password/hidden/file inputs and anything whose label/name looks sensitive.
export function collectFields() {
  const out = [];
  let nodes;
  try { nodes = document.querySelectorAll('input, textarea, select'); } catch { return out; }
  for (const el of nodes) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'password' || type === 'hidden' || type === 'file' || type === 'checkbox' || type === 'radio') continue;
    const value = el.value;
    if (value == null || value === '') continue;
    const label = clamp(labelFor(el), 80);
    const haystack = `${label} ${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''}`;
    if (SENSITIVE_RE.test(haystack)) continue;
    out.push({ label, value: redact(String(value)) });
    if (out.length >= 40) break;
  }
  return out;
}

function env() {
  return {
    url: location.href,
    route: location.pathname + location.search,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}×${window.innerHeight}`,
    online: navigator.onLine,
    appVersion: import.meta.env.VITE_APP_VERSION || undefined,
    timestamp: nowIso(),
  };
}

// Build the report object, honoring the per-section toggles the user picked.
export function snapshot({ includeFields = true, includeErrors = true, includeFailedActions = true, includeEnv = true } = {}) {
  const snap = { user: state.user || undefined };
  if (includeEnv) snap.env = env();
  if (includeErrors) snap.errors = state.errors.slice(-MAX);
  if (includeFailedActions) snap.apiFailures = state.apiFailures.slice(-MAX);
  snap.errorToasts = state.errorToasts.slice(-MAX);
  if (includeFields) snap.fields = collectFields();
  return snap;
}

// Quick counts so the reporter can show "what we captured" without opening details.
export function summary() {
  return {
    errors: state.errors.length,
    apiFailures: state.apiFailures.length,
    errorToasts: state.errorToasts.length,
    lastError: state.errors[state.errors.length - 1]?.message,
    lastFailure: state.apiFailures[state.apiFailures.length - 1],
  };
}

function emitFault(reason) {
  window.dispatchEvent(new CustomEvent('dm:fault', { detail: { reason } }));
}

export function init() {
  if (state.started || typeof window === 'undefined') return;
  state.started = true;

  window.addEventListener('error', (e) => {
    // Ignore resource-load errors (img/script) — only real script exceptions.
    if (!e.error && !e.message) return;
    recordError({ message: e.message, stack: e.error?.stack, source: 'window.onerror' });
    emitFault('error');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    recordError({ message: r?.message || String(r), stack: r?.stack, source: 'unhandledrejection' });
    emitFault('rejection');
  });

  // Failed API calls, dispatched by lib/api.js (kept import-free to avoid a cycle).
  window.addEventListener('dm:api-error', (e) => {
    const d = e.detail || {};
    push(state.apiFailures, { method: d.method, path: d.path, status: d.status, message: clamp(d.message, 500), ts: nowIso() });
    if (isHardStatus(d.status)) emitFault('api');
  });

  // The red error prompts the user actually saw.
  window.addEventListener('dm:toast', (e) => {
    if (e.detail?.type === 'error') push(state.errorToasts, { message: clamp(String(e.detail.msg), 500), ts: nowIso() });
  });

  // Record console.error too, then call through so devtools still shows it.
  const origErr = console.error;
  console.error = (...args) => {
    try { recordError({ message: args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : '')).filter(Boolean).join(' ').slice(0, 1000), stack: args.find((a) => a instanceof Error)?.stack, source: 'console.error' }); } catch { /* ignore */ }
    origErr.apply(console, args);
  };
}

export default { init, setUser, snapshot, summary, collectFields, recordError, recordBoundaryError, recordToolFailure };
