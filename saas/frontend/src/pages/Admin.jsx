import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { FileText, MonitorPlay, RefreshCw, Info, Plus, Pencil, Trash2, X } from 'lucide-react';
import TrendChart from '../components/TrendChart.jsx';
import { PLANS, TIER_ORDER, CURRENCY, PROACTIVE_EVENTS, PROACTIVE_TOKENS, DEFAULT_PROACTIVE } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useSupportTickets } from '../context/SupportTicketsContext.jsx';
import { api } from '../lib/api.js';
import { confirmDialog, promptDialog } from '../lib/ui.js';
import { interpolate } from '../lib/proactive.js';
import SortableTable from '../components/SortableTable.jsx';
import TrialNdaGate from '../components/TrialNdaGate.jsx';
import DiagnosticsPanel from '../components/DiagnosticsPanel.jsx';
import { Attachments } from '../components/Attachments.jsx';
import { TicketComposer } from '../components/TicketComposer.jsx';

// Admin-only console: manage users (tier + credits) and the support inbox
// (view / reply / close every user's ticket). Gated client-side here AND
// server-side (ADMIN_EMAILS) — the UI is a convenience over the gated API.
export default function Admin() {
  const { user } = useAuth();
  const { unanswered } = useSupportTickets();
  const [tab, setTab] = useState('users');
  if (!user.isAdmin) return <Navigate to="/" replace />;

  return (
    <div>
      <h1 className="text-2xl font-bold">Admin</h1>
      <div className="mt-3 flex gap-1 border-b border-line">
        {[['users', 'Users'], ['agreements', 'Agreements'], ['notifications', 'Notifications'], ['assistant', 'Assistant'], ['tickets', 'Support tickets'], ['promos', 'Promo codes'], ['finances', 'Finances'], ['platform', 'Platform'], ['settings', 'Settings']].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === k ? 'border-brand-500 text-brand-700 dark:text-brand-300' : 'border-transparent text-muted hover:text-strong'}`}
          >
            {label}
            {k === 'tickets' && unanswered > 0 && (
              <span className="ml-1.5 inline-grid h-4 min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white align-middle" title={`${unanswered} ticket${unanswered === 1 ? '' : 's'} awaiting a reply`}>
                {unanswered > 9 ? '9+' : unanswered}
              </span>
            )}
          </button>
        ))}
      </div>
      {tab === 'users' ? <AdminUsers /> : tab === 'agreements' ? <AdminAgreements /> : tab === 'notifications' ? <AdminNotifications /> : tab === 'assistant' ? <AdminAssistant /> : tab === 'tickets' ? <AdminTickets /> : tab === 'promos' ? <AdminPromos /> : tab === 'finances' ? <AdminFinances /> : tab === 'platform' ? <AdminPlatform /> : <AdminSettings />}
    </div>
  );
}

// ── Assistant (proactive Helpful Otter triggers) ─────────────────────────────
// CRUD over the trigger set the Otter uses to *initiate* messages. Each trigger
// binds an app event (+ optional conditions) to a canned message (free) or an
// AI-phrased one (costs the user credits). Saved to the settings singleton and
// served to every client via /me. Only a primary admin can save (server-gated).
const EVENT_BY_KEY = Object.fromEntries(PROACTIVE_EVENTS.map((e) => [e.key, e]));
const RUN_STATUS_OPTS = [['any', 'Any result'], ['success', 'Has results'], ['empty', 'Empty result'], ['error', 'Errored']];
const SAMPLE_CTX = { firstName: 'Alex', domain: 'example.com', toolName: 'Keyword Analysis', credits: 12 };

function blankTrigger() {
  return {
    id: 'trg_' + Math.random().toString(36).slice(2, 9),
    label: 'New trigger', enabled: true, event: 'route_enter',
    route: '/', idleSeconds: 25, runStatus: 'any', creditsBelow: 15,
    emptyProjects: false, firstVisitOnly: false, minDaysAway: 0, tiers: [],
    message: '', aiPhrase: false, aiPrompt: '',
    cooldownHours: 24, maxPerSession: 1, priority: 0,
  };
}

function AdminAssistant() {
  const [cfg, setCfg] = useState(null); // { enabled, maxPerSession, defaultCooldownHours, triggers: [] }
  const [dirty, setDirty] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.adminSettings()
      .then(({ settings }) => setCfg(settings.proactive || DEFAULT_PROACTIVE))
      .catch(() => setError('Could not load assistant settings.'));
  }, []);

  const patch = (p) => { setCfg((c) => ({ ...c, ...p })); setDirty(true); };
  const patchTrigger = (id, p) => { setCfg((c) => ({ ...c, triggers: c.triggers.map((t) => (t.id === id ? { ...t, ...p } : t)) })); setDirty(true); };
  const removeTrigger = (id) => { setCfg((c) => ({ ...c, triggers: c.triggers.filter((t) => t.id !== id) })); setDirty(true); };
  const addTrigger = () => { const t = blankTrigger(); setCfg((c) => ({ ...c, triggers: [...c.triggers, t] })); setDirty(true); setOpenId(t.id); };
  const move = (id, dir) => setCfg((c) => {
    const i = c.triggers.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.triggers.length) return c;
    const next = c.triggers.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setDirty(true);
    return { ...c, triggers: next };
  });
  const restoreDefaults = async () => { if (await confirmDialog({ title: 'Restore default triggers', message: 'Replace the current triggers with the built-in defaults? Unsaved edits will be lost.', confirmText: 'Restore defaults' })) { setCfg(DEFAULT_PROACTIVE); setDirty(true); setOpenId(null); } };

  async function save() {
    // Client-side guard: server drops canned triggers with no message, so flag them here first.
    const bad = cfg.triggers.find((t) => !t.aiPhrase && !t.message.trim());
    if (bad) { setError(`“${bad.label}” needs a message (or switch it to AI-phrased).`); setOpenId(bad.id); return; }
    setBusy(true); setError(''); setMsg('');
    try {
      const { settings } = await api.adminSetSettings({ proactive: cfg });
      setCfg(settings.proactive); setDirty(false); setMsg('Saved — live for all users.'); setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setError(e?.payload?.error === 'admin_only' ? 'Only a primary admin can change assistant settings.' : (e?.message || 'Could not save. Please try again.'));
    } finally { setBusy(false); }
  }

  if (!cfg && !error) return <p className="mt-6 text-sm text-muted">Loading…</p>;
  if (!cfg) return <p className="mt-6 text-sm text-rose-600 dark:text-rose-400">{error}</p>;

  return (
    <div className="mt-4 space-y-4">
      {/* Global controls */}
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Proactive assistant</h2>
            <p className="mt-1 text-sm text-muted">Master switch for Monty reaching out on its own. When off, Monty only responds when a user messages it. Users can also mute proactive tips for themselves.</p>
          </div>
          <Toggle checked={cfg.enabled} onChange={(v) => patch({ enabled: v })} title="Enable proactive messages" />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Max nudges per session</span>
            <input type="number" min="0" max="20" className="field mt-1 w-24" value={cfg.maxPerSession}
              onChange={(e) => patch({ maxPerSession: Number(e.target.value) })} />
            <p className="mt-1 text-[11px] text-faint">Global cap across all triggers per app visit. 0 = no cap.</p>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Default cooldown (hours)</span>
            <input type="number" min="0" max="8760" className="field mt-1 w-24" value={cfg.defaultCooldownHours}
              onChange={(e) => patch({ defaultCooldownHours: Number(e.target.value) })} />
            <p className="mt-1 text-[11px] text-faint">Used when a trigger doesn't set its own.</p>
          </label>
        </div>
      </div>

      {/* Trigger list */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-body">Triggers <span className="font-normal text-faint">· {cfg.triggers.length}</span></h3>
        <div className="flex items-center gap-2">
          <button onClick={restoreDefaults} className="btn-ghost px-2.5 py-1.5 text-xs">Restore defaults</button>
          <button onClick={addTrigger} className="btn-primary px-3 py-1.5 text-sm">+ New trigger</button>
        </div>
      </div>

      {cfg.triggers.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-faint">No triggers yet. Add one to let Monty reach out.</p>
      ) : (
        <div className="space-y-2">
          {cfg.triggers.map((t, i) => (
            <TriggerRow
              key={t.id} t={t} index={i} total={cfg.triggers.length}
              open={openId === t.id} onToggleOpen={() => setOpenId((o) => (o === t.id ? null : t.id))}
              onPatch={(p) => patchTrigger(t.id, p)} onRemove={() => removeTrigger(t.id)}
              onMove={(dir) => move(t.id, dir)}
            />
          ))}
        </div>
      )}

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-line bg-surface/95 px-1 py-3 backdrop-blur">
        <button onClick={save} disabled={busy || !dirty} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}</button>
        {dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
        {msg && <span className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</span>}
        {error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
      </div>
    </div>
  );
}

// One trigger: a summary row that expands into a full editor. `fields` from the
// event catalog decides which condition inputs show, so the form always matches
// the chosen event.
function TriggerRow({ t, index, total, open, onToggleOpen, onPatch, onRemove, onMove }) {
  const ev = EVENT_BY_KEY[t.event] || PROACTIVE_EVENTS[0];
  const fields = new Set(ev.fields || []);
  const preview = interpolate(t.message, SAMPLE_CTX) || (t.aiPhrase ? '(AI-phrased at send time)' : '(no message)');
  const testInChat = () => window.dispatchEvent(new CustomEvent('dm:proactive-say', { detail: { text: interpolate(t.message, SAMPLE_CTX) } }));

  return (
    <div className={`rounded-xl border ${open ? 'border-brand-300 dark:border-brand-500/40 bg-brand-50/20 dark:bg-brand-500/10' : 'border-line'} `}>
      {/* Summary */}
      <div className="flex items-center gap-3 p-3">
        <Toggle small checked={t.enabled} onChange={(v) => onPatch({ enabled: v })} title={t.enabled ? 'Enabled' : 'Disabled'} />
        <button onClick={onToggleOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-strong">{t.label || '(untitled)'}</span>
            <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{ev.label}</span>
            {t.aiPhrase && <span className="shrink-0 rounded-full bg-violet-100 dark:bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300">AI · costs credits</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-faint">{preview}</div>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <button onClick={() => onMove(-1)} disabled={index === 0} className="rounded p-1 text-faint hover:bg-sunken disabled:opacity-30" title="Move up" aria-label="Move up">↑</button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="rounded p-1 text-faint hover:bg-sunken disabled:opacity-30" title="Move down" aria-label="Move down">↓</button>
          <button onClick={onToggleOpen} className="rounded px-2 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10">{open ? 'Close' : 'Edit'}</button>
        </div>
      </div>

      {/* Editor */}
      {open && (
        <div className="space-y-4 border-t border-line p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">Label</span>
              <input className="field mt-1 w-full" value={t.label} onChange={(e) => onPatch({ label: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">When (event)</span>
              <select className="dm-select mt-1 w-full rounded border border-edge py-2 pl-2 pr-7 text-sm" value={t.event} onChange={(e) => onPatch({ event: e.target.value })}>
                {PROACTIVE_EVENTS.map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-faint">{ev.help}</p>
            </label>
          </div>

          {/* Conditions — only those relevant to the chosen event */}
          {fields.size > 0 && (
            <div className="rounded-lg border border-line bg-surface p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-faint">Conditions</div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {fields.has('route') && (
                  <label className="block">
                    <span className="text-sm">Page path</span>
                    <input className="field mt-1 w-full" value={t.route} placeholder="/  ·  /tool/*  ·  /projects" onChange={(e) => onPatch({ route: e.target.value })} />
                    <p className="mt-1 text-[11px] text-faint">Exact path, or end with * to match a prefix (e.g. /tool/*).</p>
                  </label>
                )}
                {fields.has('idleSeconds') && (
                  <label className="block">
                    <span className="text-sm">Idle for (seconds)</span>
                    <input type="number" min="5" max="600" className="field mt-1 w-28" value={t.idleSeconds} onChange={(e) => onPatch({ idleSeconds: Number(e.target.value) })} />
                  </label>
                )}
                {fields.has('runStatus') && (
                  <label className="block">
                    <span className="text-sm">Run result</span>
                    <select className="dm-select mt-1 w-full rounded border border-edge py-2 pl-2 pr-7 text-sm" value={t.runStatus} onChange={(e) => onPatch({ runStatus: e.target.value })}>
                      {RUN_STATUS_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                )}
                {fields.has('creditsBelow') && (
                  <label className="block">
                    <span className="text-sm">Credits below</span>
                    <input type="number" min="0" className="field mt-1 w-28" value={t.creditsBelow} onChange={(e) => onPatch({ creditsBelow: Number(e.target.value) })} />
                  </label>
                )}
                {fields.has('minDaysAway') && (
                  <label className="block">
                    <span className="text-sm">Away at least (days)</span>
                    <input type="number" min="0" max="365" className="field mt-1 w-28" value={t.minDaysAway} onChange={(e) => onPatch({ minDaysAway: Number(e.target.value) })} />
                    <p className="mt-1 text-[11px] text-faint">0 = fires on any app open.</p>
                  </label>
                )}
                {fields.has('emptyProjects') && (
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input type="checkbox" className="h-4 w-4" checked={t.emptyProjects} onChange={(e) => onPatch({ emptyProjects: e.target.checked })} />
                    Only when the user has no projects yet
                  </label>
                )}
                {fields.has('firstVisitOnly') && (
                  <label className="flex items-center gap-2 text-sm sm:col-span-2">
                    <input type="checkbox" className="h-4 w-4" checked={t.firstVisitOnly} onChange={(e) => onPatch({ firstVisitOnly: e.target.checked })} />
                    Only on the very first visit
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Message */}
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-faint">Message</span>
            <textarea rows={3} className="field mt-1 w-full" value={t.message} placeholder="Hi {firstName}! …" onChange={(e) => onPatch({ message: e.target.value })} />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PROACTIVE_TOKENS.map((tk) => (
                <button key={tk.token} type="button" title={tk.help} onClick={() => onPatch({ message: `${t.message}${tk.token}` })}
                  className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-700 dark:hover:text-brand-300">{tk.token}</button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-faint">Add clickable chips with tokens like <code>[[go:/pricing|Upgrade]]</code>, <code>[[tool:keyword-analysis]]</code>, <code>[[action:ticket]]</code>, <code>[[ask:What do I put in each field?]]</code> (a quick-reply button that asks Monty that question).</p>
          </div>

          {/* AI phrasing */}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={t.aiPhrase} onChange={(e) => onPatch({ aiPhrase: e.target.checked })} />
            Let Monty phrase this with AI <span className="text-xs text-violet-600 dark:text-violet-400">· costs the user credits each time it fires</span>
          </label>
          {t.aiPhrase && (
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-faint">AI instruction</span>
              <textarea rows={2} className="field mt-1 w-full" value={t.aiPrompt} placeholder="e.g. Summarise the user's latest run and suggest one next step." onChange={(e) => onPatch({ aiPrompt: e.target.value })} />
              <p className="mt-1 text-[11px] text-faint">Sent to the assistant as the user's message. Falls back to the message text above if blank.</p>
            </label>
          )}

          {/* Pacing + audience */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-sm">Cooldown (hrs)</span>
              <input type="number" min="0" max="8760" className="field mt-1 w-full" value={t.cooldownHours} onChange={(e) => onPatch({ cooldownHours: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-sm">Max / session</span>
              <input type="number" min="1" max="20" className="field mt-1 w-full" value={t.maxPerSession} onChange={(e) => onPatch({ maxPerSession: Number(e.target.value) })} />
            </label>
            <label className="block">
              <span className="text-sm">Priority</span>
              <input type="number" min="-100" max="100" className="field mt-1 w-full" value={t.priority} onChange={(e) => onPatch({ priority: Number(e.target.value) })} />
            </label>
          </div>
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-faint">Only for tiers <span className="font-normal normal-case text-faint">(none = all)</span></span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TIER_ORDER.map((tier) => {
                const on = t.tiers.includes(tier);
                return (
                  <button key={tier} type="button" onClick={() => onPatch({ tiers: on ? t.tiers.filter((x) => x !== tier) : [...t.tiers, tier] })}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium ${on ? 'border-brand-500 bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300' : 'border-line text-muted hover:border-edge'}`}>{PLANS[tier].name}</button>
                );
              })}
            </div>
          </div>

          {/* Preview + actions */}
          <div className="rounded-lg border border-line bg-raised p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-faint">Preview</div>
            <div className="mt-1.5 rounded-2xl rounded-bl-sm bg-sunken px-3 py-2 text-sm text-strong">{preview}</div>
            <p className="mt-1 text-[11px] text-faint">Sample values: {SAMPLE_CTX.firstName} · {SAMPLE_CTX.domain} · {SAMPLE_CTX.credits} credits.</p>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={testInChat} className="btn-ghost px-3 py-1.5 text-xs" title="Drop this message into your own chat panel now">Preview in my chat</button>
            <button onClick={onRemove} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">Delete trigger</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Reusable pill switch (matches the toggles used elsewhere in Admin).
function Toggle({ checked, onChange, title, small }) {
  const w = small ? 'h-5 w-9' : 'h-6 w-11';
  const dot = small ? 'h-4 w-4' : 'h-5 w-5';
  return (
    <button type="button" role="switch" aria-checked={checked} title={title} onClick={() => onChange(!checked)}
      className={`relative inline-flex ${w} shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-brand-600' : 'bg-overlay'}`}>
      <span className={`inline-block ${dot} transform rounded-full bg-white shadow transition-transform ${checked ? (small ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0.5'}`} />
    </button>
  );
}

// ── Agreements (Free Trial + NDA acceptances) ────────────────────────────────
function AdminAgreements() {
  const [rows, setRows] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');
  const [previewGate, setPreviewGate] = useState(false);
  const [sampling, setSampling] = useState(false);

  useEffect(() => {
    api.adminAgreements()
      .then(({ agreements }) => setRows(agreements || []))
      .catch((e) => { setError(e?.message || 'Failed to load agreements.'); setRows([]); });
  }, []);

  const fmt = (iso) => {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return iso; }
  };

  const download = async (r) => {
    setDownloading(r.userId);
    try {
      const { filename, base64 } = await api.adminAgreementPdf(r.userId);
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'agreement.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e?.message || 'Could not generate the PDF.');
    } finally {
      setDownloading('');
    }
  };

  // Open a sample of the generated Acceptance Record PDF in a new tab so staff
  // can see the document an acceptance produces (placeholder data, current version).
  const openSample = async () => {
    setSampling(true);
    setError('');
    try {
      const { base64 } = await api.adminAgreementSamplePdf();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      setError(e?.message || 'Could not generate the sample PDF.');
    } finally {
      setSampling(false);
    }
  };

  if (rows === null) return <p className="mt-6 text-sm text-faint">Loading…</p>;

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <p className="text-sm text-muted">
          {rows.length} {rows.length === 1 ? 'trial user has' : 'trial users have'} accepted the Free Trial &amp; NDA.
        </p>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => setPreviewGate(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-xs font-semibold text-body hover:bg-raised"
          >
            <MonitorPlay size={14} aria-hidden /> Preview gate
          </button>
          <button
            onClick={openSample}
            disabled={sampling}
            className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-xs font-semibold text-body hover:bg-raised disabled:opacity-50"
          >
            <FileText size={14} aria-hidden /> {sampling ? 'Preparing…' : 'Sample PDF'}
          </button>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-faint">
          No agreements yet. They&rsquo;ll appear here as trial users accept.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-raised text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {['Name', 'Organisation', 'UEN', 'Telephone', 'Email', 'Accepted', 'Ver.', 'IP', ''].map((h) => (
                  <th key={h} className="whitespace-nowrap px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-hair">
              {rows.map((r) => (
                <tr key={r.userId} className="align-top hover:bg-raised">
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-heading">{r.name || '—'}</td>
                  <td className="px-3 py-2 text-body">{r.organisation || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-body">{r.uen || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-body">{r.telephone || '—'}</td>
                  <td className="px-3 py-2 text-body">
                    {r.email || '—'}
                    {r.accountEmail && r.accountEmail !== r.email && (
                      <span className="block text-xs text-faint">acct: {r.accountEmail}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-dim">{fmt(r.acceptedAt)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{r.version || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted">{r.ip || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">
                    <button
                      onClick={() => download(r)}
                      disabled={downloading === r.userId}
                      className="rounded-lg border border-edge px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-500/10 disabled:opacity-50"
                    >
                      {downloading === r.userId ? 'Preparing…' : 'PDF'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* `withTerms` matches what a genuinely NEW user faces: they have accepted
          neither the NDA nor the base Terms, so their gate carries both
          checkboxes. Without it staff were previewing a dialog nobody actually
          sees — the NDA-only variant only appears for an existing user whose
          Terms consent is already on file. */}
      {previewGate && <TrialNdaGate preview withTerms onClose={() => setPreviewGate(false)} />}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────
// Platform-wide toggles. Currently: whether email/password sign-in is allowed
// (Google sign-in is always on). Saving is restricted to ADMIN_EMAILS admins
// server-side; staff without that role get a 403.
function AdminSettings() {
  const [settings, setSettings] = useState(null); // null = loading
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  // Editable copy of the ticket-lifecycle numbers (strings while typing).
  const [tForm, setTForm] = useState({ ticketReminderDays: '', ticketAutoCloseDays: '' });

  useEffect(() => {
    let live = true;
    api.adminSettings()
      .then(({ settings }) => {
        if (!live) return;
        setSettings(settings);
        setTForm({
          ticketReminderDays: String(settings.ticketReminderDays ?? 3),
          ticketAutoCloseDays: String(settings.ticketAutoCloseDays ?? 7),
        });
      })
      .catch(() => live && setError('Could not load settings.'));
    return () => { live = false; };
  }, []);

  async function toggle(key, value) {
    setBusy(true); setError(''); setMsg('');
    try {
      const { settings } = await api.adminSetSettings({ [key]: value });
      setSettings(settings);
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setError(e?.payload?.error === 'admin_only'
        ? 'Only a primary admin can change this setting.'
        : (e?.message || 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  async function saveTickets(e) {
    e.preventDefault();
    const reminder = Number(tForm.ticketReminderDays);
    const close = Number(tForm.ticketAutoCloseDays);
    if (![reminder, close].every((n) => Number.isInteger(n) && n >= 0 && n <= 365)) {
      setError('Enter whole numbers of days between 0 and 365.');
      return;
    }
    setBusy(true); setError(''); setMsg('');
    try {
      const { settings } = await api.adminSetSettings({ ticketReminderDays: reminder, ticketAutoCloseDays: close });
      setSettings(settings);
      setTForm({ ticketReminderDays: String(settings.ticketReminderDays), ticketAutoCloseDays: String(settings.ticketAutoCloseDays) });
      setMsg('Saved.');
      setTimeout(() => setMsg(''), 2500);
    } catch (e) {
      setError(e?.payload?.error === 'admin_only'
        ? 'Only a primary admin can change these settings.'
        : (e?.payload?.error || e?.message || 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  }

  if (settings === null && !error) return <p className="mt-6 text-sm text-muted">Loading…</p>;

  return (
    <div className="mt-4 max-w-2xl">
      <div className="card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Email &amp; password sign-in</h2>
            <p className="mt-1 text-sm text-muted">
              When off, new sign-ups and existing email/password logins are blocked and the login page
              shows only “Sign in with Google”. Google sign-in is always available.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!settings?.passwordAuthEnabled}
            disabled={busy || !settings}
            onClick={() => toggle('passwordAuthEnabled', !settings.passwordAuthEnabled)}
            className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${settings?.passwordAuthEnabled ? 'bg-brand-600' : 'bg-overlay'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${settings?.passwordAuthEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="mt-3 text-sm font-medium">
          Status:{' '}
          <span className={settings?.passwordAuthEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}>
            {settings?.passwordAuthEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </p>
      </div>

      {/* Username sign-in is a password login, so it does nothing on its own —
          the card stays visible but reads as inactive while the switch above is
          off, rather than hiding and leaving the state a mystery. */}
      <div className="card mt-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Username sign-in</h2>
            <p className="mt-1 text-sm text-muted">
              When on, users can sign in with either their email or a username. Usernames are opt-in —
              each user claims one from their profile, and anyone who hasn’t simply keeps using their email.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!settings?.usernameAuthEnabled}
            disabled={busy || !settings}
            onClick={() => toggle('usernameAuthEnabled', !settings.usernameAuthEnabled)}
            className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${settings?.usernameAuthEnabled ? 'bg-brand-600' : 'bg-overlay'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${settings?.usernameAuthEnabled ? 'translate-x-5' : 'translate-x-1'}`} />
          </button>
        </div>
        <p className="mt-3 text-sm font-medium">
          Status:{' '}
          {settings?.usernameAuthEnabled && !settings?.passwordAuthEnabled ? (
            <span className="text-amber-600 dark:text-amber-400">
              On, but inactive — turn on “Email &amp; password sign-in” above for it to take effect
            </span>
          ) : (
            <span className={settings?.usernameAuthEnabled ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}>
              {settings?.usernameAuthEnabled ? 'Enabled' : 'Disabled'}
            </span>
          )}
        </p>
      </div>

      <form className="card mt-4 p-5" onSubmit={saveTickets}>
        <h2 className="text-base font-semibold">Support ticket reminders &amp; auto-close</h2>
        <p className="mt-1 text-sm text-muted">
          When support has replied and is waiting on the client, send a reminder email every so many days,
          and automatically close the ticket if there&apos;s still no response. Applies to the daily
          maintenance job. Set a value to <span className="font-medium">0</span> to turn that behaviour off.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium">Remind the client every</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number" min="0" max="365" step="1" inputMode="numeric"
                className="field w-24" disabled={busy || !settings}
                value={tForm.ticketReminderDays}
                onChange={(e) => setTForm((f) => ({ ...f, ticketReminderDays: e.target.value }))}
              />
              <span className="text-sm text-muted">days</span>
            </div>
          </label>
          <label className="block">
            <span className="text-sm font-medium">Auto-close after</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number" min="0" max="365" step="1" inputMode="numeric"
                className="field w-24" disabled={busy || !settings}
                value={tForm.ticketAutoCloseDays}
                onChange={(e) => setTForm((f) => ({ ...f, ticketAutoCloseDays: e.target.value }))}
              />
              <span className="text-sm text-muted">days of no reply</span>
            </div>
          </label>
        </div>
        {Number(tForm.ticketReminderDays) > 0 && Number(tForm.ticketAutoCloseDays) > 0
          && Number(tForm.ticketReminderDays) >= Number(tForm.ticketAutoCloseDays) && (
          <p className="mt-3 text-sm text-amber-600 dark:text-amber-400">
            Heads up: the reminder interval is longer than the auto-close window, so the ticket will close
            before any reminder is sent.
          </p>
        )}
        <button type="submit" className="btn-primary mt-4" disabled={busy || !settings}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>

      {msg && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

// ── Broadcast notifications ──────────────────────────────────────────────────
// Build a target audience from sign-up / last-login / last-tool-use date filters
// (+ optional tier/status narrowing), preview who it reaches, then send an
// in-app and/or email broadcast. Server enforces staff-only + the audience cap.
const CLAUSES = [
  { key: 'signup', label: 'Signed up', help: 'when the account was created' },
  { key: 'lastLogin', label: 'Last login', help: 'tracked from when this shipped' },
  { key: 'lastToolUse', label: 'Last tool use', help: 'backfilled from run history' },
];
const BROADCAST_STATUSES = ['active', 'paused', 'inactive'];

function AdminNotifications() {
  // Audience filter state.
  const [clauses, setClauses] = useState({
    signup: { enabled: false, type: 'after', days: 7 },
    lastLogin: { enabled: false, type: 'before', days: 30 },
    lastToolUse: { enabled: false, type: 'before', days: 14 },
  });
  const [match, setMatch] = useState('all');
  const [tiers, setTiers] = useState(new Set());
  const [statuses, setStatuses] = useState(new Set(['active']));

  // Composer state.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [channels, setChannels] = useState({ inApp: true, email: false });

  // Async + result state.
  const [preview, setPreview] = useState(null); // { count, sample, capped, maxAudience }
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);
  const [backfilling, setBackfilling] = useState(false);

  const loadHistory = () => api.adminBroadcastHistory().then((d) => setHistory(d.broadcasts || [])).catch(() => setHistory([]));
  useEffect(() => { loadHistory(); }, []);

  function setClause(key, patch) {
    setClauses((c) => ({ ...c, [key]: { ...c[key], ...patch } }));
    setPreview(null); // any audience change invalidates a prior preview
  }
  function toggleIn(set, setter, value) {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    setter(next); setPreview(null);
  }

  function buildFilter() {
    const f = { match };
    for (const { key } of CLAUSES) {
      const cl = clauses[key];
      if (cl.enabled && Number.isFinite(Number(cl.days))) f[key] = { type: cl.type, days: Number(cl.days) };
    }
    if (tiers.size) f.tiers = [...tiers];
    if (statuses.size) f.statuses = [...statuses];
    return f;
  }

  async function doPreview() {
    setPreviewing(true); setError(''); setMsg('');
    try { setPreview(await api.adminBroadcastPreview(buildFilter())); }
    catch (e) { setError(e?.payload?.error || 'Could not preview the audience.'); }
    finally { setPreviewing(false); }
  }

  async function doSend() {
    setError(''); setMsg('');
    if (!title.trim()) { setError('Add a title.'); return; }
    if (!body.trim()) { setError('Add a message.'); return; }
    if (!channels.inApp && !channels.email) { setError('Pick at least one channel.'); return; }
    if (link && !link.startsWith('/')) { setError('Link must be an in-app path starting with “/”.'); return; }
    const count = preview?.count;
    const who = count != null ? `${count} user${count === 1 ? '' : 's'}` : 'the matching users';
    const via = [channels.inApp && 'in-app', channels.email && 'email'].filter(Boolean).join(' + ');
    if (!(await confirmDialog({ title: 'Send broadcast', message: `Send "${title.trim()}" to ${who} via ${via}? This can't be undone.`, confirmText: 'Send' }))) return;
    setSending(true);
    try {
      const { broadcast } = await api.adminBroadcastSend({
        filter: buildFilter(), title: title.trim(), body: body.trim(),
        link: link.trim() || undefined, channels,
      });
      const parts = [`${broadcast.inAppSent || 0} in-app`];
      if (channels.email) parts.push(`${broadcast.emailSent || 0} email${broadcast.emailSkippedOptOut ? `, ${broadcast.emailSkippedOptOut} opted out` : ''}`);
      setMsg(`Sent to ${broadcast.audienceCount} user${broadcast.audienceCount === 1 ? '' : 's'} (${parts.join(' · ')}).`);
      setTitle(''); setBody(''); setLink(''); setPreview(null);
      loadHistory();
    } catch (e) { setError(e?.payload?.error || 'Could not send the broadcast.'); }
    finally { setSending(false); }
  }

  async function doBackfill() {
    if (!(await confirmDialog({ title: 'Backfill activity', message: 'Seed last-login and last-tool-use from existing sessions + run history? Safe to run anytime — it only fills missing values.', confirmText: 'Run backfill' }))) return;
    setBackfilling(true); setError(''); setMsg('');
    try {
      const r = await api.adminBackfillActivity();
      setMsg(`Backfill done — scanned ${r.scanned} users, filled ${r.loginFilled} logins + ${r.toolFilled} tool-use dates.`);
    } catch (e) { setError(e?.payload?.error || 'Backfill failed.'); }
    finally { setBackfilling(false); }
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      {/* ── Audience builder ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Audience</h2>
          <select value={match} onChange={(e) => { setMatch(e.target.value); setPreview(null); }}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-xs">
            <option value="all">Match ALL date rules</option>
            <option value="any">Match ANY date rule</option>
          </select>
        </div>
        <p className="mt-1 text-xs text-muted">Leave all date rules off to target everyone (after the tier/status narrowing below).</p>

        <div className="mt-3 space-y-2">
          {CLAUSES.map(({ key, label, help }) => {
            const cl = clauses[key];
            return (
              <div key={key} className={`rounded-lg border p-2.5 ${cl.enabled ? 'border-brand-200 dark:border-brand-500/30 bg-brand-50/40 dark:bg-brand-500/10' : 'border-line'}`}>
                <label className="flex items-center gap-2 text-sm font-medium text-body">
                  <input type="checkbox" checked={cl.enabled} onChange={(e) => setClause(key, { enabled: e.target.checked })} className="h-4 w-4" />
                  {label}
                  <span className="font-normal text-xs text-faint">· {help}</span>
                </label>
                {cl.enabled && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 pl-6 text-sm">
                    <select value={cl.type} onChange={(e) => setClause(key, { type: e.target.value })}
                      className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
                      <option value="before">more than</option>
                      <option value="after">within the last</option>
                    </select>
                    <input type="number" min="0" value={cl.days} onChange={(e) => setClause(key, { days: e.target.value })}
                      className="w-20 rounded border border-edge px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
                    <span className="text-muted">days ago</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Tiers</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {TIER_ORDER.map((t) => (
                <button key={t} type="button" onClick={() => toggleIn(tiers, setTiers, t)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${tiers.has(t) ? 'border-brand-500 bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300' : 'border-line text-muted hover:border-edge'}`}>
                  {PLANS[t].name}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-faint">{tiers.size ? '' : 'All tiers'}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Status</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {BROADCAST_STATUSES.map((s) => (
                <button key={s} type="button" onClick={() => toggleIn(statuses, setStatuses, s)}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${statuses.has(s) ? 'border-brand-500 bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300' : 'border-line text-muted hover:border-edge'}`}>
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] text-faint">{statuses.size ? '' : 'Any status'}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button onClick={doPreview} disabled={previewing} className="btn-ghost px-3 py-2 text-sm disabled:opacity-50">
            {previewing ? 'Previewing…' : 'Preview audience'}
          </button>
          {preview && (
            <span className="text-sm font-semibold text-body">
              {preview.count.toLocaleString()} user{preview.count === 1 ? '' : 's'}
              {preview.capped && <span className="ml-1 text-red-600 dark:text-red-400">· exceeds cap of {preview.maxAudience}</span>}
            </span>
          )}
        </div>

        {preview?.sample?.length > 0 && (
          <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-hair">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-raised text-left text-faint">
                <tr><th className="px-2 py-1 font-medium">User</th><th className="px-2 py-1 font-medium">Tier</th><th className="px-2 py-1 font-medium">Last login</th><th className="px-2 py-1 font-medium">Last tool</th></tr>
              </thead>
              <tbody>
                {preview.sample.map((u) => (
                  <tr key={u.userId} className="border-t border-hair">
                    <td className="px-2 py-1"><div className="font-medium text-dim">{u.email}</div></td>
                    <td className="px-2 py-1 text-muted">{u.tier}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-faint">{u.lastLoginAt ? fmtWhen(u.lastLoginAt) : '—'}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-faint">{u.lastToolUseAt ? fmtWhen(u.lastToolUseAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {preview && preview.count > preview.sample.length && <p className="mt-1.5 text-[11px] text-faint">Showing first {preview.sample.length} of {preview.count.toLocaleString()}.</p>}

        <div className="mt-4 border-t border-hair pt-3">
          <button onClick={doBackfill} disabled={backfilling} className="text-xs text-muted underline hover:text-body disabled:opacity-50">
            {backfilling ? 'Backfilling…' : 'Backfill last-login / last-tool-use from history'}
          </button>
          <p className="mt-1 text-[11px] text-faint">Run once so the date filters reflect activity from before this feature shipped.</p>
        </div>
      </div>

      {/* ── Composer ── */}
      <div className="card flex flex-col p-5">
        <h2 className="text-base font-semibold">Message</h2>

        <label className="mt-3 block text-sm font-medium text-body">Title</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="What's new in Digimetrics"
          className="mt-1 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-body">Message</label>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={5} placeholder="Write your update… (blank lines start a new paragraph in the email)"
          className="mt-1 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-body">In-app link <span className="font-normal text-faint">(optional)</span></label>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/pricing"
          className="mt-1 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
        <p className="mt-1 text-[11px] text-faint">A path inside the app (e.g. /pricing). Clicking the notification opens it.</p>

        <div className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">Channels</h3>
          <div className="mt-2 space-y-2">
            <label className="flex items-center gap-2 text-sm text-body">
              <input type="checkbox" checked={channels.inApp} onChange={(e) => setChannels((c) => ({ ...c, inApp: e.target.checked }))} className="h-4 w-4" />
              In-app notification <span className="text-xs text-faint">· shows in the bell</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-body">
              <input type="checkbox" checked={channels.email} onChange={(e) => setChannels((c) => ({ ...c, email: e.target.checked }))} className="h-4 w-4" />
              Email <span className="text-xs text-faint">· skips opted-out users; includes an unsubscribe link</span>
            </label>
          </div>
        </div>

        {msg && <div className="mt-4 rounded-lg bg-green-50 dark:bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-300">{msg}</div>}
        {error && <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-faint">{preview ? `Will reach ${preview.count.toLocaleString()} user${preview.count === 1 ? '' : 's'}.` : 'Preview the audience first.'}</span>
          <button onClick={doSend} disabled={sending} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{sending ? 'Sending…' : 'Send broadcast'}</button>
        </div>
      </div>

      {/* ── History ── */}
      <div className="card p-5 lg:col-span-2">
        <h2 className="text-base font-semibold">Recent broadcasts</h2>
        {history === null ? <p className="mt-3 text-sm text-faint">Loading…</p>
          : history.length === 0 ? <p className="mt-3 text-sm text-faint">No broadcasts sent yet.</p>
          : (
            <div className="mt-3 divide-y divide-hair">
              {history.map((b) => (
                <div key={b.broadcastId} className="flex items-start justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-strong">{b.title}</div>
                    <div className="truncate text-xs text-muted">{b.body}</div>
                    <div className="mt-0.5 text-[11px] text-faint">
                      by {b.sentBy} · {fmtWhen(b.ts)}
                      {b.channels?.inApp && ` · ${b.inAppSent || 0} in-app`}
                      {b.channels?.email && ` · ${b.emailSent || 0} email`}
                    </div>
                  </div>
                  <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-xs font-semibold text-dim">{(b.audienceCount || 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ── Users ────────────────────────────────────────────────────────────────────
// Date fields the range filter can target, keyed to the user projection.
const DATE_FIELDS = [
  { key: 'lastLoginAt', label: 'Last login' },
  { key: 'lastToolUseAt', label: 'Last tool use' },
  { key: 'createdAt', label: 'Signed up' },
];

function AdminUsers() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');     // all | client | staff
  const [statusFilter, setStatusFilter] = useState('all');  // all | active | paused | inactive | invited
  const [dateField, setDateField] = useState('lastLoginAt');
  const [fromDate, setFromDate] = useState('');             // YYYY-MM-DD (inclusive)
  const [toDate, setToDate] = useState('');                 // YYYY-MM-DD (inclusive, end of day)
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [activityUser, setActivityUser] = useState(null);
  const [selected, setSelected] = useState(new Set()); // bulk-action selection, keyed by userId
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setError('');
    try { const { users } = await api.adminUsers(); setUsers(users || []); }
    catch (e) { setUsers([]); setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load users — reload and try again.'); }
  }
  async function setTier(u, tier) { await api.adminTier(u.userId, tier); flash(`${u.email} → ${PLANS[tier].name}`); load(); }
  async function setRole(u, role) {
    if (role === (u.role || 'client')) return;
    if (role === 'staff' && !(await confirmDialog({ title: 'Grant staff access', message: `Grant ${u.email} staff (admin panel) access?`, confirmText: 'Grant access' }))) { load(); return; }
    if (role === 'client' && !(await confirmDialog({ title: 'Remove staff access', message: `Remove staff access from ${u.email}?`, confirmText: 'Remove access', danger: true }))) { load(); return; }
    try { await api.adminRole(u.userId, role); flash(`${u.email} → ${role === 'staff' ? 'Staff' : 'Client'}`); }
    catch (e) { setError(e?.payload?.message || e?.payload?.error || 'Could not update role.'); }
    load();
  }
  async function setStatus(u, status) {
    if (status === (u.status || 'active')) return;
    if (status !== 'active' && !(await confirmDialog({ title: `Set account to “${status}”`, message: `Set ${u.email} to "${status}"? They'll be signed out and blocked from signing in or using the app until you reactivate them.`, confirmText: `Set ${status}`, danger: true }))) { load(); return; }
    try { await api.adminStatus(u.userId, status); flash(`${u.email} → ${status}`); }
    catch (e) { setError(e?.payload?.error || 'Could not update status.'); }
    load();
  }
  async function adjust(u, bucket) {
    const raw = await promptDialog({ title: `Adjust ${bucket} credits`, message: `Adjust ${bucket} credits for ${u.email} (use a negative number to deduct):`, label: 'Amount', defaultValue: '100' });
    if (raw === null) return;
    const amt = parseInt(raw, 10);
    if (Number.isNaN(amt)) return;
    const reason = (await promptDialog({ title: 'Reason', message: 'Reason (optional, logged to the ledger):', label: 'Reason', defaultValue: '' })) || '';
    await api.adminCredits(u.userId, bucket === 'monthly' ? amt : 0, bucket === 'topup' ? amt : 0, reason);
    flash(`${amt >= 0 ? '+' : ''}${amt} ${bucket} credits → ${u.email}`);
    load();
  }
  function flash(t) { setMsg(t); setTimeout(() => setMsg(''), 2500); }

  function toggleOne(id) { setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSelected((s) => (rows.length > 0 && rows.every((u) => s.has(u.userId))) ? new Set() : new Set(rows.map((u) => u.userId))); }

  // Runs `fn` for every id sequentially (existing single-user endpoints, no bulk API) and
  // reports how many succeeded/failed rather than aborting the whole batch on one error.
  async function bulkRun(ids, fn) {
    setBulkBusy(true);
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await fn(id); ok++; } catch { fail++; }
    }
    setBulkBusy(false);
    return { ok, fail };
  }
  async function bulkStatus(status) {
    const targets = users.filter((u) => selected.has(u.userId) && u.role !== 'staff' && u.status !== 'invited');
    if (!targets.length) return;
    if (status !== 'active' && !(await confirmDialog({ title: `Set ${targets.length} account${targets.length === 1 ? '' : 's'} to “${status}”`, message: `Set ${targets.length} user${targets.length === 1 ? '' : 's'} to "${status}"? They'll be signed out and blocked from signing in or using the app until you reactivate them.`, confirmText: `Set ${status}`, danger: true }))) return;
    const { ok, fail } = await bulkRun(targets.map((u) => u.userId), (id) => api.adminStatus(id, status));
    flash(`Status → ${status}: ${ok} updated${fail ? `, ${fail} failed` : ''}`);
    setSelected(new Set()); load();
  }
  async function bulkTier(tier) {
    const targets = users.filter((u) => selected.has(u.userId));
    if (!targets.length) return;
    if (!(await confirmDialog({ title: 'Change plan', message: `Change plan to ${PLANS[tier].name} for ${targets.length} user${targets.length === 1 ? '' : 's'}? This resets each user's monthly allowance.`, confirmText: 'Change plan' }))) return;
    const { ok, fail } = await bulkRun(targets.map((u) => u.userId), (id) => api.adminTier(id, tier));
    flash(`Tier → ${PLANS[tier].name}: ${ok} updated${fail ? `, ${fail} failed` : ''}`);
    setSelected(new Set()); load();
  }
  async function bulkRole(role) {
    if (role === 'staff' && !me.isSuperAdmin) { setError('Only an admin can grant staff access.'); return; }
    const targets = users.filter((u) => selected.has(u.userId) && u.userId !== me.userId && (u.role || 'client') !== role);
    if (!targets.length) return;
    if (!(await confirmDialog({ title: role === 'staff' ? 'Grant staff access' : 'Remove staff access', message: `${role === 'staff' ? 'Grant staff access to' : 'Remove staff access from'} ${targets.length} user${targets.length === 1 ? '' : 's'}?`, confirmText: role === 'staff' ? 'Grant access' : 'Remove access', danger: role !== 'staff' }))) return;
    const { ok, fail } = await bulkRun(targets.map((u) => u.userId), (id) => api.adminRole(id, role));
    flash(`Role → ${role}: ${ok} updated${fail ? `, ${fail} failed` : ''}`);
    setSelected(new Set()); load();
  }
  async function bulkAdjust(bucket) {
    const targets = users.filter((u) => selected.has(u.userId));
    if (!targets.length) return;
    const raw = await promptDialog({ title: `Adjust ${bucket} credits`, message: `Adjust ${bucket} credits for ${targets.length} selected user${targets.length === 1 ? '' : 's'} (use a negative number to deduct):`, label: 'Amount', defaultValue: '100' });
    if (raw === null) return;
    const amt = parseInt(raw, 10);
    if (Number.isNaN(amt)) return;
    const reason = (await promptDialog({ title: 'Reason', message: 'Reason (optional, logged to the ledger):', label: 'Reason', defaultValue: '' })) || '';
    const { ok, fail } = await bulkRun(targets.map((u) => u.userId), (id) => api.adminCredits(id, bucket === 'monthly' ? amt : 0, bucket === 'topup' ? amt : 0, reason));
    flash(`${amt >= 0 ? '+' : ''}${amt} ${bucket} credits → ${ok} user${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}`);
    setSelected(new Set()); load();
  }

  // Range is inclusive on both ends; `toDate` covers the whole selected day.
  const fromMs = fromDate ? Date.parse(fromDate) : null;
  const toMs = toDate ? Date.parse(toDate) + 86399999 : null;
  const rows = (users || []).filter((u) => {
    if (q && !((u.email || '') + (u.name || '')).toLowerCase().includes(q.toLowerCase())) return false;
    if (roleFilter !== 'all' && (u.role || 'client') !== roleFilter) return false;
    if (statusFilter !== 'all' && (u.status || 'active') !== statusFilter) return false;
    if (fromMs != null || toMs != null) {
      const ms = u[dateField] ? Date.parse(u[dateField]) : NaN;
      if (Number.isNaN(ms)) return false; // no activity on this field → out of range
      if (fromMs != null && ms < fromMs) return false;
      if (toMs != null && ms > toMs) return false;
    }
    return true;
  });
  const filtersActive = roleFilter !== 'all' || statusFilter !== 'all' || fromDate || toDate;
  function clearFilters() { setRoleFilter('all'); setStatusFilter('all'); setFromDate(''); setToDate(''); }

  return (
    <div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button onClick={() => setCreating(true)} className="btn-primary px-3 py-2 text-sm">+ New user</button>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email / name…"
          className="w-64 rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
      </div>

      {/* Filters: role / status pickers + a date range over a chosen activity field. */}
      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-line bg-raised/60 px-3 py-2.5">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Role
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            <option value="all">All</option>
            <option value="client">Client</option>
            <option value="staff">Staff</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Status
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="inactive">Inactive</option>
            <option value="invited">Invited</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Date range on
          <select value={dateField} onChange={(e) => setDateField(e.target.value)}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            {DATE_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          From
          <input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)}
            className="rounded border border-edge px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          To
          <input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)}
            className="rounded border border-edge px-2 py-1 text-sm focus:border-brand-500 focus:outline-none" />
        </label>
        {filtersActive && (
          <button onClick={clearFilters} className="btn-ghost px-2.5 py-1.5 text-xs">Clear filters</button>
        )}
        {users && (
          <span className="ml-auto self-center text-xs text-faint">
            {rows.length} of {users.length} user{users.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} onCreated={(u) => { setCreating(false); flash(`Created ${u.email} (${u.role})`); load(); }} />}
      {msg && <div className="mt-3 rounded-lg bg-green-50 dark:bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-300">{msg}</div>}
      {error && <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}

      {selected.size > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-3 py-2.5">
          <span className="text-sm font-medium text-brand-800 dark:text-brand-300">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} className="btn-ghost px-2 py-1 text-xs">Clear</button>
          <div className="mx-1 h-5 w-px bg-brand-200" />
          <select disabled={bulkBusy} defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) bulkStatus(v); }}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            <option value="" disabled>Set status…</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="inactive">Inactive</option>
          </select>
          <select disabled={bulkBusy} defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) bulkTier(v); }}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            <option value="" disabled>Set tier…</option>
            {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name}</option>)}
          </select>
          <select disabled={bulkBusy} defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) bulkRole(v); }}
            className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
            <option value="" disabled>Set role…</option>
            <option value="client">Client</option>
            <option value="staff" disabled={!me.isSuperAdmin}>Staff{!me.isSuperAdmin ? ' (admin only)' : ''}</option>
          </select>
          <button disabled={bulkBusy} onClick={() => bulkAdjust('monthly')} className="btn-ghost px-2 py-1 text-xs">± Monthly credits</button>
          <button disabled={bulkBusy} onClick={() => bulkAdjust('topup')} className="btn-ghost px-2 py-1 text-xs">± Top-up credits</button>
          {bulkBusy && <span className="text-xs text-brand-600 dark:text-brand-400">Applying…</span>}
        </div>
      )}

      <div className="card mt-3">
        <SortableTable
          rows={rows}
          rowKey={(u) => u.userId}
          stickyFirstCol
          emptyText={users === null ? 'Loading…' : 'No matching users.'}
          columns={[
            { key: '_select', label: (
                <input type="checkbox" className="h-4 w-4" aria-label="Select all"
                  checked={rows.length > 0 && rows.every((u) => selected.has(u.userId))}
                  onChange={toggleAll} />
              ), sortable: false, render: (u) => (
                <input type="checkbox" className="h-4 w-4" aria-label={`Select ${u.email}`}
                  checked={selected.has(u.userId)} onChange={() => toggleOne(u.userId)} />
              ) },
            { key: 'user', label: 'User', accessor: (u) => u.name || u.email || '',
              render: (u) => (<><div className="font-medium">{u.name || '—'}</div><div className="text-xs text-faint">{u.email}</div></>) },
            { key: 'role', label: 'Role', accessor: (u) => u.role || 'client',
              render: (u) => (u.userId === me.userId
                ? (u.role === 'staff'
                    ? <span className="rounded-full bg-brand-100 dark:bg-brand-500/15 px-2 py-0.5 text-xs font-semibold text-brand-700 dark:text-brand-300">Staff (you)</span>
                    : <span className="text-xs text-muted">Client (you)</span>)
                : <RoleSelect u={u} canGrantStaff={!!me.isSuperAdmin} onChange={(r) => setRole(u, r)} />) },
            { key: 'status', label: 'Status', accessor: (u) => u.status || 'active',
              render: (u) => (
                u.status === 'invited'
                  ? <span className="rounded-full bg-amber-100 dark:bg-amber-500/15 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-300">Invited</span>
                  : u.role === 'staff'
                    ? <span className="rounded-full bg-green-100 dark:bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-300">Active</span>
                    : <StatusSelect u={u} onChange={(s) => setStatus(u, s)} />) },
            { key: 'tier', label: 'Tier', accessor: (u) => TIER_ORDER.indexOf(u.tier),
              render: (u) => (
                <select value={u.tier} onChange={(e) => setTier(u, e.target.value)} className="dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm">
                  {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name}</option>)}
                </select>) },
            { key: 'monthlyCredits', label: 'Monthly', align: 'right', numeric: true, render: (u) => (u.monthlyCredits ?? 0).toLocaleString() },
            { key: 'topupCredits', label: 'Top-up', align: 'right', numeric: true, render: (u) => <span className="text-brand-600 dark:text-brand-400">{(u.topupCredits ?? 0).toLocaleString()}</span> },
            { key: 'credits', label: 'Total', align: 'right', numeric: true, render: (u) => <span className="font-semibold">{(u.credits ?? 0).toLocaleString()}</span> },
            { key: 'creditsSpent', label: 'Used', align: 'right', numeric: true, tip: 'Lifetime credits this user has spent on tool runs.',
              render: (u) => <span className="text-muted tabular-nums">{(u.creditsSpent ?? 0).toLocaleString()}</span> },
            { key: 'lastLoginAt', label: 'Last login', numeric: false, accessor: (u) => u.lastLoginAt || '',
              render: (u) => <span className="whitespace-nowrap text-xs text-muted">{u.lastLoginAt ? fmtWhen(u.lastLoginAt) : '—'}</span> },
            { key: 'lastToolUseAt', label: 'Last tool use', numeric: false, accessor: (u) => u.lastToolUseAt || '',
              render: (u) => <span className="whitespace-nowrap text-xs text-muted">{u.lastToolUseAt ? fmtWhen(u.lastToolUseAt) : '—'}</span> },
            { key: 'adjust', label: 'Adjust credits', sortable: false, render: (u) => (
                <div className="flex gap-1">
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'monthly')}>± Monthly</button>
                  <button className="btn-ghost px-2 py-1 text-xs" onClick={() => adjust(u, 'topup')}>± Top-up</button>
                </div>) },
            { key: 'activity', label: 'Activity', sortable: false, render: (u) => (
                u.status === 'invited'
                  ? <span className="text-xs text-slate-300">—</span>
                  : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setActivityUser(u)}>View</button>) },
          ]}
        />
      </div>
      <p className="mt-3 text-xs text-faint">
        Tier changes reset the monthly allowance to that plan's amount; top-up credits are untouched. Setting a user to <strong>Paused</strong> or <strong>Inactive</strong> blocks sign-in and all app/tool access until you set them back to Active. Staff accounts can't be blocked. Any staff can revoke another staff member's access, but only an admin can grant it; you can't change your own role. All changes are written to the credit ledger. Check the boxes on the left to select multiple users and apply a status, tier, role, or credit change to all of them at once.
      </p>
      {activityUser && <AdminUserActivity user={activityUser} onClose={() => setActivityUser(null)} />}
    </div>
  );
}

// Active / Paused / Inactive picker for the Users table. Colour-codes the
// current state; 'paused'/'inactive' lock the account out everywhere (enforced
// server-side). Invited + staff rows render a plain pill instead (see above).
function StatusSelect({ u, onChange }) {
  const status = u.status || 'active';
  const tone = status === 'active' ? 'text-green-700 dark:text-green-300' : status === 'paused' ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300';
  return (
    <select
      value={status}
      onChange={(e) => onChange(e.target.value)}
      className={`dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm font-semibold ${tone}`}
    >
      <option value="active">Active</option>
      <option value="paused">Paused</option>
      <option value="inactive">Inactive</option>
    </select>
  );
}

// Client / Staff picker for the Users table. Granting staff access is disabled
// (greyed "Staff" option) for staff who aren't a true admin — server-side
// enforces the same rule, this just avoids a round-trip 403.
function RoleSelect({ u, canGrantStaff, onChange }) {
  const role = u.role || 'client';
  return (
    <select
      value={role}
      onChange={(e) => onChange(e.target.value)}
      className={`dm-select rounded border border-edge py-1 pl-2 pr-7 text-sm font-semibold ${role === 'staff' ? 'text-brand-700 dark:text-brand-300' : 'text-dim'}`}
    >
      <option value="client">Client</option>
      <option value="staff" disabled={role !== 'staff' && !canGrantStaff}>Staff{role !== 'staff' && !canGrantStaff ? ' (admin only)' : ''}</option>
    </select>
  );
}

// ── Consent-gated activity viewer ─────────────────────────────────────────────
// Staff can only see a user's runs + conversations while that user has an ACTIVE
// grant (they approve it under Account → Data access). Until then we show the
// request flow. The server enforces this too — the UI just mirrors the gate.
function AdminUserActivity({ user, onClose }) {
  const [grants, setGrants] = useState(null);   // null = loading
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [runs, setRuns] = useState(null);
  const [convos, setConvos] = useState(null);
  const [openConvo, setOpenConvo] = useState(null);
  const [usage, setUsage] = useState(null);   // per-tool counts (ungated)

  const active = (grants || []).find((g) => g.status === 'granted' && (!g.expiresAt || new Date(g.expiresAt) > new Date()));
  const pending = (grants || []).find((g) => g.status === 'pending');

  async function loadGrants() {
    setErr('');
    try { const { grants } = await api.adminAccessStatus(user.userId); setGrants(grants || []); }
    catch (e) { setGrants([]); setErr(e?.payload?.error || 'Could not load access status.'); }
  }
  useEffect(() => { loadGrants(); }, [user.userId]);

  // Tool-usage counts are operational metadata — load them regardless of consent.
  useEffect(() => {
    let live = true;
    api.adminUsage(user.userId).then((d) => live && setUsage(d)).catch(() => live && setUsage({ tools: [], totalRuns: 0 }));
    return () => { live = false; };
  }, [user.userId]);

  // Once a grant is active, pull the user's activity.
  useEffect(() => {
    if (!active) return;
    let live = true;
    api.adminActivity(user.userId, 'runs').then((d) => live && setRuns(d.runs || [])).catch(() => live && setRuns([]));
    api.adminActivity(user.userId, 'conversations').then((d) => live && setConvos(d.conversations || [])).catch(() => live && setConvos([]));
    return () => { live = false; };
  }, [active, user.userId]);

  async function request() {
    setBusy(true); setErr('');
    try { await api.adminRequestAccess(user.userId, reason.trim()); await loadGrants(); }
    catch (e) { setErr(e?.payload?.error || 'Could not send the request.'); }
    finally { setBusy(false); }
  }

  async function openConversation(id) {
    setOpenConvo({ id, loading: true });
    try { const { conversation } = await api.adminActivity(user.userId, 'conversation', id); setOpenConvo({ id, conversation }); }
    catch { setOpenConvo({ id, error: true }); }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-line bg-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-hair p-4">
          <div>
            <h3 className="text-base font-bold">Activity · {user.name || user.email}</h3>
            <p className="text-xs text-faint">{user.email}</p>
          </div>
          <button onClick={onClose} className="text-faint hover:text-body" aria-label="Close">✕</button>
        </div>

        <div className="overflow-y-auto p-4">
          {err && <div className="mb-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{err}</div>}

          {/* Tool-usage counts — always visible (operational metadata, no content). */}
          {!openConvo && (
            <section className="mb-5">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-body">Tool usage</h4>
                {usage && <span className="text-xs text-faint">{(usage.totalRuns || 0).toLocaleString()} runs · {(usage.totalCreditsSpent || 0).toLocaleString()} credits</span>}
              </div>
              {usage === null ? <p className="mt-2 text-sm text-faint">Loading…</p>
                : usage.tools.length === 0 ? <p className="mt-2 text-sm text-faint">No tool runs yet.</p>
                : (
                  <table className="mt-2 w-full text-sm">
                    <thead>
                      <tr className="border-b border-hair text-left text-xs text-faint">
                        <th className="pb-1 font-medium">Tool</th>
                        <th className="pb-1 text-right font-medium">Runs</th>
                        <th className="pb-1 text-right font-medium">Credits</th>
                        <th className="pb-1 text-right font-medium">Last used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.tools.map((t) => (
                        <tr key={t.tool} className="border-b border-hair">
                          <td className="py-1.5 font-medium text-body">{t.toolName || t.tool}</td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">{(t.count || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right text-muted tabular-nums">{(t.credits || 0).toLocaleString()}</td>
                          <td className="py-1.5 text-right whitespace-nowrap text-xs text-faint">{t.lastUsed ? fmtWhen(t.lastUsed) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              <p className="mt-2 text-[11px] text-faint">Usage counts are always visible. Opening run details or conversations below requires the user’s consent.</p>
            </section>
          )}

          {grants === null && <p className="text-sm text-faint">Loading…</p>}

          {/* No active grant → request flow. */}
          {grants !== null && !active && (
            <div className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4">
              <div className="flex items-start gap-2">
                <span className="text-lg">🔒</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Consent required for details</p>
                  <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
                    Run details and conversation contents need the user’s permission. Send a request and they’ll
                    approve it under <span className="font-medium">Account → Data access</span>. Grants last 7 days.
                  </p>
                  {pending
                    ? <p className="mt-3 rounded-lg bg-surface/70 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">
                        ⏳ Request pending since {fmtWhen(pending.requestedAt)} — waiting for the user to allow it.
                      </p>
                    : (
                      <div className="mt-3">
                        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (shown to the user, optional)"
                          className="w-full rounded-lg border border-amber-300 dark:border-amber-500/40 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none" />
                        <button onClick={request} disabled={busy} className="btn-primary mt-2 px-3 py-2 text-sm disabled:opacity-50">
                          {busy ? 'Sending…' : 'Request access'}
                        </button>
                      </div>
                    )}
                </div>
              </div>
            </div>
          )}

          {/* Active grant → show runs + conversations. */}
          {active && !openConvo && (
            <div className="space-y-5">
              <p className="rounded-lg bg-green-50 dark:bg-green-500/10 px-3 py-2 text-xs text-green-800 dark:text-green-300">
                ✓ Access granted{active.expiresAt ? ` until ${fmtWhen(active.expiresAt)}` : ''}. Every view is logged.
              </p>

              <section>
                <h4 className="text-sm font-semibold text-body">Recent tool runs</h4>
                {runs === null ? <p className="mt-2 text-sm text-faint">Loading…</p>
                  : runs.length === 0 ? <p className="mt-2 text-sm text-faint">No runs yet.</p>
                  : (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                      {runs.map((r) => (
                        <div key={r.runId} className="flex items-center justify-between rounded-lg border border-hair px-3 py-1.5 text-sm">
                          <span className="font-medium text-body">{r.toolName || r.tool}</span>
                          <span className="whitespace-nowrap text-xs text-faint">{fmtWhen(r.ts)}</span>
                        </div>
                      ))}
                    </div>
                  )}
              </section>

              <section>
                <h4 className="text-sm font-semibold text-body">Assistant conversations</h4>
                {convos === null ? <p className="mt-2 text-sm text-faint">Loading…</p>
                  : convos.length === 0 ? <p className="mt-2 text-sm text-faint">No conversations yet.</p>
                  : (
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                      {convos.map((c) => (
                        <button key={c.conversationId} onClick={() => openConversation(c.conversationId)}
                          className="flex w-full items-center justify-between rounded-lg border border-hair px-3 py-1.5 text-left text-sm hover:bg-raised">
                          <span className="truncate font-medium text-body">{c.title || '(untitled)'}</span>
                          <span className="ml-2 whitespace-nowrap text-xs text-faint">{fmtWhen(c.updatedAt || c.createdAt)}</span>
                        </button>
                      ))}
                    </div>
                  )}
              </section>
            </div>
          )}

          {/* Conversation drill-down. */}
          {active && openConvo && (
            <div>
              <button onClick={() => setOpenConvo(null)} className="text-sm text-muted hover:text-strong">← Conversations</button>
              {openConvo.loading && <p className="mt-3 text-sm text-faint">Loading…</p>}
              {openConvo.error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">Could not load this conversation.</p>}
              {openConvo.conversation && (
                <div className="mt-3 space-y-3">
                  {(openConvo.conversation.messages || []).map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${m.role === 'user' ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-sunken text-strong'}`}>
                        <div className={`mb-0.5 text-[11px] ${m.role === 'user' ? 'text-white/70' : 'text-faint'}`}>{m.role === 'user' ? 'User' : 'Assistant'}</div>
                        <div className="whitespace-pre-wrap">{typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('')}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Support tickets ──────────────────────────────────────────────────────────
function statusPill(status) {
  const map = { open: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', answered: 'bg-brand-100 dark:bg-brand-500/15 text-brand-700 dark:text-brand-300', closed: 'bg-sunken text-muted' };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${map[status] || 'bg-sunken text-muted'}`}>{status || '—'}</span>;
}

const DAY_MS = 86_400_000;
// Days remaining until the next reminder nudge and until auto-close, computed the
// same way the daily CloseFn job decides (saas/backend/src/close/index.mjs):
//   • auto-close fires when a ticket has been inactive >= ticketAutoCloseDays.
//   • a reminder fires every ticketReminderDays, but ONLY while we're awaiting the
//     customer (status 'answered'), measured from the last nudge (or last activity).
// Returns { label, sort, tip } per metric; `sort` is the numeric days remaining so
// the column sorts sensibly (non-applicable rows sink to the bottom via Infinity).
function ticketLifecycle(t, settings) {
  const off = (label, tip) => ({ label, sort: Infinity, tip });
  if (!settings) return { remind: off('…'), close: off('…') };
  if (t.status === 'closed') return { remind: off('—'), close: off('—') };

  const now = Date.now();
  const closeDays = Number(settings.ticketAutoCloseDays);
  const remindDays = Number(settings.ticketReminderDays);
  const countdown = (days) => (days <= 0 ? { label: 'Due', sort: 0 } : { label: `${Math.ceil(days)}d`, sort: days });

  const inactiveDays = (now - new Date(t.lastActivityAt || t.ts).getTime()) / DAY_MS;
  const close = closeDays > 0 ? countdown(closeDays - inactiveDays) : off('Off', 'Auto-close is turned off in Settings');

  let remind;
  if (!(remindDays > 0)) remind = off('Off', 'Reminders are turned off in Settings');
  else if (t.status !== 'answered') remind = off('—', 'Reminders fire only while awaiting the customer’s reply');
  else {
    const sinceNudge = (now - new Date(t.lastReminderAt || t.lastActivityAt || t.ts).getTime()) / DAY_MS;
    remind = countdown(remindDays - sinceNudge);
  }
  return { remind, close };
}

// Render a lifecycle countdown: amber+bold when it's due on the next daily run,
// muted for off/not-applicable, plain otherwise.
function countdownCell(c) {
  const muted = c.label === 'Off' || c.label === '—' || c.label === '…';
  const due = c.label === 'Due';
  return (
    <span title={c.tip || undefined}
      className={`whitespace-nowrap ${due ? 'font-semibold text-amber-700 dark:text-amber-300' : muted ? 'text-faint' : 'text-dim'}`}>
      {c.label}
    </span>
  );
}

function AdminTickets() {
  const { refresh: refreshBadge } = useSupportTickets();
  const [tickets, setTickets] = useState(null);
  const [settings, setSettings] = useState(null);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState('');

  const load = () => { setError(''); api.adminTickets().then((d) => setTickets(d.tickets || [])).catch((e) => { setTickets([]); setError(e?.status === 403 ? 'Your account is not an admin.' : 'Could not load tickets.'); }); };
  // Keep the shared menu/tab badge in step with what this console shows —
  // replying to or closing a ticket drops it out of the unanswered count.
  useEffect(() => { load(); refreshBadge(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The lifecycle windows drive the reminder/auto-close countdowns below.
  useEffect(() => { api.adminSettings().then(({ settings }) => setSettings(settings)).catch(() => {}); }, []);

  if (sel) return <AdminTicketDetail summary={sel} onBack={() => { setSel(null); load(); refreshBadge(); }} />;

  const open = (tickets || []).filter((t) => t.status !== 'closed').length;
  return (
    <div>
      {error && <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {tickets && (
        <p className="mt-4 text-sm text-muted">
          {tickets.length} ticket{tickets.length === 1 ? '' : 's'} · <span className="font-semibold text-amber-700 dark:text-amber-300">{open} open</span>
          {settings && (
            <span className="text-faint">
              {' · '}reminders {Number(settings.ticketReminderDays) > 0 ? `every ${settings.ticketReminderDays}d` : 'off'}, auto-close {Number(settings.ticketAutoCloseDays) > 0 ? `after ${settings.ticketAutoCloseDays}d` : 'off'}
            </span>
          )}
        </p>
      )}
      <div className="card mt-3">
        <SortableTable
          rows={tickets || []}
          rowKey={(t) => t.userId + t.ticketId}
          emptyText={tickets === null ? 'Loading…' : 'No tickets yet.'}
          columns={[
            { key: 'id', label: 'Ticket', accessor: (t) => t.id,
              render: (t) => <button className="font-mono text-xs font-semibold text-brand-600 dark:text-brand-400 hover:underline" onClick={() => setSel(t)}>{t.id}</button> },
            { key: 'userEmail', label: 'User', accessor: (t) => t.userEmail || t.userId, render: (t) => <span className="text-dim">{t.userEmail || t.userId}</span> },
            { key: 'subject', label: 'Subject', accessor: (t) => t.subject || '',
              render: (t) => <button className="max-w-xs truncate text-left font-medium text-strong hover:underline" onClick={() => setSel(t)}>{t.subject || '(no subject)'}</button> },
            { key: 'category', label: 'Category', render: (t) => <span className="text-muted">{t.category || '—'}</span> },
            { key: 'status', label: 'Status', accessor: (t) => t.status, render: (t) => statusPill(t.status) },
            { key: 'remind', label: 'Next reminder', numeric: true, tip: 'Days until the next “please reply” nudge is emailed to the customer (only while awaiting their reply).',
              accessor: (t) => ticketLifecycle(t, settings).remind.sort, render: (t) => countdownCell(ticketLifecycle(t, settings).remind) },
            { key: 'close', label: 'Auto-close', numeric: true, tip: 'Days until the ticket auto-closes from inactivity.',
              accessor: (t) => ticketLifecycle(t, settings).close.sort, render: (t) => countdownCell(ticketLifecycle(t, settings).close) },
            { key: 'lastActivityAt', label: 'Last activity', accessor: (t) => t.lastActivityAt || t.ts || '',
              render: (t) => <span className="whitespace-nowrap text-muted">{fmtWhen(t.lastActivityAt || t.ts)}</span> },
          ]}
        />
      </div>
    </div>
  );
}

// Fill placeholder tokens in a canned reply with this ticket's details, so a
// saved template reads personally. Unknown tokens are left as-is.
function fillTemplateTokens(text, ticket) {
  const email = ticket?.userEmail || '';
  const name = ticket?.userName || (email ? email.split('@')[0] : '') || 'there';
  return String(text || '')
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*email\s*\}\}/gi, email)
    .replace(/\{\{\s*subject\s*\}\}/gi, ticket?.subject || '')
    .replace(/\{\{\s*id\s*\}\}/gi, ticket?.id || '');
}

// Staff-shared canned replies: pick one to drop into the reply box, and
// create / edit / delete the library inline. Templates live on the platform
// settings singleton, so every staff member sees the same set.
function ReplyTemplates({ ticket, onInsert }) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState(null); // null = not yet loaded
  const [editing, setEditing] = useState(null);      // null | {} (new) | template (edit)
  const [form, setForm] = useState({ title: '', body: '' });
  const [confirmId, setConfirmId] = useState(null);  // template id pending inline delete-confirm
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wrapRef = useRef(null);

  const load = () => api.ticketTemplates().then((d) => setTemplates(d.templates || [])).catch(() => setTemplates([]));
  // Load once the menu is first opened (staff-only endpoint; cheap, rarely changes).
  useEffect(() => { if (open && templates === null) load(); }, [open]);
  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const reset = () => { setOpen(false); setEditing(null); setConfirmId(null); };
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) reset(); };
    const onKey = (e) => { if (e.key === 'Escape') reset(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  function startNew() { setForm({ title: '', body: '' }); setEditing({}); setErr(''); setConfirmId(null); }
  function startEdit(t) { setForm({ title: t.title, body: t.body }); setEditing(t); setErr(''); setConfirmId(null); }

  async function save(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) { setErr('Give the template a name and a message.'); return; }
    setBusy(true); setErr('');
    try {
      const { templates: list } = await api.saveTicketTemplate({ id: editing?.id, title: form.title.trim(), body: form.body.trim() });
      setTemplates(list); setEditing(null);
    } catch (e2) { setErr(e2?.payload?.error || 'Could not save the template.'); }
    finally { setBusy(false); }
  }
  async function remove(t) {
    setBusy(true);
    try { const { templates: list } = await api.deleteTicketTemplate(t.id); setTemplates(list); setConfirmId(null); }
    catch { /* leave the list as-is on failure */ } finally { setBusy(false); }
  }
  function insert(t) { onInsert(fillTemplateTokens(t.body, ticket)); setOpen(false); }

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 font-medium text-muted hover:bg-raised hover:text-body"
      ><FileText size={13} aria-hidden /> Templates</button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1.5 w-80 rounded-xl border border-line bg-surface p-2 shadow-xl">
          {editing ? (
            <form onSubmit={save} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold text-body">{editing.id ? 'Edit template' : 'New template'}</span>
                <button type="button" onClick={() => setEditing(null)} className="text-faint hover:text-body" aria-label="Cancel"><X size={14} /></button>
              </div>
              <input
                value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Template name (e.g. Billing — how credits work)"
                className="w-full rounded-lg border border-edge px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
              <textarea
                value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={5} placeholder="Message… use {{name}}, {{email}}, {{subject}} or {{id}} to personalise."
                className="w-full resize-y rounded-lg border border-edge px-2.5 py-1.5 text-sm focus:border-brand-500 focus:outline-none" />
              <p className="px-1 text-[11px] text-faint">Tokens: <code>{'{{name}}'}</code> <code>{'{{email}}'}</code> <code>{'{{subject}}'}</code> <code>{'{{id}}'}</code></p>
              {err && <p className="px-1 text-[11px] text-red-600 dark:text-red-400">{err}</p>}
              <div className="flex justify-end gap-2 px-1">
                <button type="button" onClick={() => setEditing(null)} className="rounded-lg px-2.5 py-1 text-xs font-medium text-muted hover:bg-raised">Cancel</button>
                <button type="submit" disabled={busy} className="btn-primary px-2.5 py-1 text-xs disabled:opacity-50">{busy ? 'Saving…' : 'Save template'}</button>
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between px-1 py-0.5">
                <span className="text-xs font-semibold text-body">Insert a saved reply</span>
                <button type="button" onClick={startNew} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-brand-600 dark:text-brand-400 hover:bg-raised"><Plus size={12} /> New</button>
              </div>
              <div className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
                {templates === null && <div className="px-2 py-3 text-center text-xs text-faint">Loading…</div>}
                {templates?.length === 0 && <div className="px-2 py-4 text-center text-xs text-faint">No templates yet. Create one to reuse it across the team.</div>}
                {templates?.map((t) => (
                  <div key={t.id} className="group flex items-start gap-1 rounded-lg px-1 py-1 hover:bg-raised">
                    <button type="button" onClick={() => insert(t)} className="min-w-0 flex-1 text-left" title="Insert into reply">
                      <div className="truncate text-sm font-medium text-body">{t.title}</div>
                      <div className="truncate text-[11px] text-faint">{t.body}</div>
                    </button>
                    {confirmId === t.id ? (
                      // Inline confirm — replaces a native confirm() so the whole
                      // flow stays in-app. Always visible (not hover-gated) while armed.
                      <div className="flex shrink-0 items-center gap-1 text-[11px]">
                        <span className="text-faint">Delete?</span>
                        <button type="button" onClick={() => remove(t)} disabled={busy} className="rounded px-1.5 py-0.5 font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50">{busy ? '…' : 'Yes'}</button>
                        <button type="button" onClick={() => setConfirmId(null)} className="rounded px-1.5 py-0.5 font-medium text-muted hover:bg-raised">No</button>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
                        <button type="button" onClick={() => startEdit(t)} className="rounded p-1 text-faint hover:text-body" aria-label="Edit"><Pencil size={13} /></button>
                        <button type="button" onClick={() => setConfirmId(t.id)} className="rounded p-1 text-faint hover:text-red-600 dark:hover:text-red-400" aria-label="Delete"><Trash2 size={13} /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AdminTicketDetail({ summary, onBack }) {
  const { user: me } = useAuth();
  const [ticket, setTicket] = useState(null);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState('');
  // Per-message re-email status: messageId → 'sending' | 'ok' | 'fail'.
  const [resent, setResent] = useState({});
  // Identity the customer sees on this reply: the "Monty" persona (default) or
  // the staff member's own name/email.
  const [asMonty, setAsMonty] = useState(true);
  const myName = me?.name || me?.email || 'me';
  const threadRef = useRef(null);

  const load = () => api.adminTicket(summary.userId, summary.ticketId).then((d) => setTicket(d.ticket)).catch(() => setTicket(false));
  useEffect(() => { load(); }, [summary.ticketId]);
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [ticket]);

  async function send() {
    if (!reply.trim() && !attachments.length) return;
    setBusy(true); setWarn('');
    try {
      const { ticket: t, email } = await api.adminReplyTicket(summary.userId, summary.ticketId, reply.trim(), attachments, asMonty);
      setTicket(t); setReply(''); setAttachments([]);
      // The customer always gets an in-app notification; warn only when the
      // EMAIL didn't reach them, so staff can follow up another way.
      if (email && email.delivered === false) {
        setWarn(`Your reply was saved and the customer was notified in-app, but the email to ${email.recipients?.join(', ') || 'the customer'} could not be delivered — they were NOT emailed. SES may still be in the sandbox, or the address bounced. Follow up another way if it's urgent.`);
      } else if (email && email.delivered === null) {
        setWarn('Your reply was saved and posted in-app, but this customer has no email address on file, so no email was sent.');
      }
    }
    catch { /* surfaced by the disabled state resetting */ } finally { setBusy(false); }
  }
  // Re-send the email for a past staff reply (customer says they never got it).
  // Posts no new message — email delivery only. Reuses the amber banner on
  // failure and marks the bubble ✓/✗ inline.
  async function resendReply(m) {
    setResent((r) => ({ ...r, [m.id]: 'sending' })); setWarn('');
    try {
      const { email } = await api.adminResendReply(summary.userId, summary.ticketId, m.id);
      if (email && email.delivered === false) {
        setResent((r) => ({ ...r, [m.id]: 'fail' }));
        setWarn(`Re-send failed — the email to ${email.recipients?.join(', ') || 'the customer'} could not be delivered. SES may still be in the sandbox, or the address bounced.`);
      } else if (email && email.delivered === null) {
        setResent((r) => ({ ...r, [m.id]: 'fail' }));
        setWarn('Nothing to re-send to — this customer has no email address on file.');
      } else {
        setResent((r) => ({ ...r, [m.id]: 'ok' }));
      }
    } catch {
      setResent((r) => ({ ...r, [m.id]: 'fail' }));
      setWarn('Could not re-send the email. Please try again.');
    }
  }
  async function close() {
    if (!(await confirmDialog({ title: 'Close ticket', message: 'Close this ticket?', confirmText: 'Close ticket' }))) return;
    setBusy(true);
    try { await api.adminCloseTicket(summary.userId, summary.ticketId); setTicket((t) => ({ ...t, status: 'closed' })); } finally { setBusy(false); }
  }

  if (ticket === false) return <div className="mt-5"><button onClick={onBack} className="text-sm text-muted hover:text-strong">← All tickets</button><p className="mt-4 text-red-600 dark:text-red-400">Ticket not found.</p></div>;
  if (!ticket) return <p className="mt-5 text-faint">Loading…</p>;

  return (
    <div className="mt-4">
      <button onClick={onBack} className="text-sm text-muted hover:text-strong">← All tickets</button>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-bold">{ticket.subject}</h2>
        {statusPill(ticket.status)}
        {ticket.category && <span className="rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">{ticket.category}</span>}
        <span className="font-mono text-xs text-faint">{ticket.id}</span>
        {ticket.status !== 'closed' && (
          <button onClick={close} disabled={busy} className="ml-auto rounded-lg border border-line px-2.5 py-1 text-sm font-medium text-dim hover:bg-raised">Close ticket</button>
        )}
      </div>
      <p className="mt-1 text-xs text-faint">
        From <strong className="text-muted">{ticket.userEmail || summary.userId}</strong>
        {ticket.additionalEmails?.length ? ` · CC ${ticket.additionalEmails.join(', ')}` : ''}
      </p>

      <DiagnosticsPanel diagnostics={ticket.diagnostics} />

      {/* Conversation — staff (agent) bubbles on the right, customer on the left. */}
      <div ref={threadRef} className="mt-3 max-h-[55vh] space-y-3 overflow-y-auto rounded-xl border border-line bg-raised p-4">
        {(ticket.messages || []).map((m) => {
          const staff = m.author === 'agent';
          return (
            <div key={m.id} className={`flex ${staff ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${staff ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-surface text-strong shadow-sm ring-1 ring-line'}`}>
                <div className={`mb-0.5 text-[11px] ${staff ? 'text-white/70' : 'text-faint'}`}>
                  {staff
                    ? `${m.authorName || 'Support'}${m.agentEmail && m.agentEmail !== m.authorEmail ? ` · sent by ${m.agentEmail}` : ''}`
                    : (m.authorEmail || 'Customer')} · {new Date(m.ts).toLocaleString()}
                </div>
                {m.body && <div className="whitespace-pre-wrap text-sm">{m.body}</div>}
                <Attachments items={m.attachments} light={staff} />
                {staff && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/70">
                    <button
                      type="button"
                      onClick={() => resendReply(m)}
                      disabled={resent[m.id] === 'sending'}
                      className="rounded px-1.5 py-0.5 font-medium text-white/80 underline decoration-white/30 underline-offset-2 hover:text-white disabled:opacity-60"
                    >{resent[m.id] === 'sending' ? 'Re-sending…' : 'Re-email'}</button>
                    {resent[m.id] === 'ok' && <span aria-live="polite">✓ Sent</span>}
                    {resent[m.id] === 'fail' && <span aria-live="polite">✗ Failed</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {warn && (
        <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-800 dark:text-amber-300">
          <span aria-hidden="true">⚠️</span>
          <span>{warn}</span>
          <button onClick={() => setWarn('')} className="ml-auto text-amber-500 hover:text-amber-700 dark:hover:text-amber-300" aria-label="Dismiss">✕</button>
        </div>
      )}

      {/* Reply as the support agent. */}
      <div className="mt-3 rounded-xl border border-line bg-surface p-3">
        <TicketComposer
          value={reply}
          onChange={setReply}
          attachments={attachments}
          setAttachments={setAttachments}
          onSubmit={send}
          placeholder={`Reply to the customer as ${asMonty ? 'Monty' : myName}…  (⌘/Ctrl + Enter to send)`}
          header={(
            /* Choose the identity the customer sees, and pull in a saved reply. */
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-faint">Reply as</span>
              <div className="inline-flex rounded-lg border border-line p-0.5">
                <button
                  type="button"
                  onClick={() => setAsMonty(true)}
                  className={`rounded-md px-2.5 py-1 font-medium ${asMonty ? 'bg-brand-600 text-white' : 'text-muted hover:text-body'}`}
                >Monty</button>
                <button
                  type="button"
                  onClick={() => setAsMonty(false)}
                  className={`rounded-md px-2.5 py-1 font-medium ${!asMonty ? 'bg-brand-600 text-white' : 'text-muted hover:text-body'}`}
                >{myName}</button>
              </div>
              <span className="ml-auto" />
              <ReplyTemplates
                ticket={ticket}
                onInsert={(text) => setReply((r) => (r.trim() ? `${r.replace(/\s*$/, '')}\n\n${text}` : text))}
              />
            </div>
          )}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-faint">Emails + notifies {ticket.userEmail || 'the customer'} as <strong className="text-muted">{asMonty ? 'Monty' : myName}</strong>.</span>
          <button onClick={send} disabled={busy || (!reply.trim() && !attachments.length)} className="btn-primary disabled:opacity-50">{busy ? 'Sending…' : 'Send reply'}</button>
        </div>
      </div>
    </div>
  );
}

// Provision a client or staff account by email (they link on first Google login).
function CreateUserDialog({ onClose, onCreated }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('client');
  const [tier, setTier] = useState('free');
  const [credits, setCredits] = useState('');
  const [sendInvite, setSendInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!email.trim()) { setErr('Email is required.'); return; }
    setBusy(true);
    try {
      const { user } = await api.adminCreateUser({
        email: email.trim(), name: name.trim(), role, tier,
        credits: credits === '' ? undefined : Number(credits), sendInvite,
      });
      onCreated(user);
    } catch (e2) { setErr(e2?.payload?.error || 'Could not create the user.'); }
    finally { setBusy(false); }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="w-full max-w-md rounded-xl border border-line bg-surface p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold">Create user</h3>
          <button type="button" onClick={onClose} className="text-faint hover:text-body" aria-label="Close">✕</button>
        </div>
        <p className="mt-1 text-sm text-muted">They sign in with Google using this email and link automatically.</p>
        {err && <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">{err}</div>}

        <label className="mt-3 block text-sm font-medium text-body">Email <span className="text-red-500">*</span></label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="person@company.com"
          className="mt-1 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-body">Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />

        <label className="mt-3 block text-sm font-medium text-body">Role</label>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {[['client', 'Client', 'Uses tools, billed by plan'], ['staff', 'Staff', 'Full admin + support']].map(([v, t, d]) => (
            <button type="button" key={v} onClick={() => setRole(v)}
              className={`rounded-lg border p-2.5 text-left ${role === v ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line hover:border-edge'}`}>
              <div className="text-sm font-medium">{t}</div>
              <div className="text-xs text-muted">{d}</div>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-body">Plan</label>
            <select value={tier} onChange={(e) => setTier(e.target.value)} className="dm-select mt-1 w-full rounded-lg border border-edge py-2 pl-2 pr-8 text-sm">
              {TIER_ORDER.map((t) => <option key={t} value={t}>{PLANS[t].name} — {PLANS[t].monthlyCredits.toLocaleString()} cr</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-body">Starting credits</label>
            <input type="number" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder={String(PLANS[tier]?.monthlyCredits ?? 0)}
              className="mt-1 w-full rounded-lg border border-edge px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-dim">
          <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} className="h-4 w-4" /> Send invite email
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost px-3 py-2 text-sm">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary px-3 py-2 text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create user'}</button>
        </div>
      </form>
    </div>
  );
}

function fmtWhen(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// ── Platform (Amplify Hosting) usage ──────────────────────────────────────────
const RANGE_PRESETS = [['1', '24h'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];

// ── Finances (balance sheet: cost vs revenue) ────────────────────────────────
// SaaS-product P&L for a window: Stripe revenue vs AWS spend + an ESTIMATED AI/data
// COGS line, all in USD (revenue, AWS and COGS are natively USD, so nothing is
// FX-converted). Revenue is authoritative (Stripe); AWS is authoritative
// (Cost Explorer); COGS is an estimate from credits consumed, labelled as such.
// The Airwallex switch is staged but NOT live (see shared/catalog.mjs) — the
// processor behind these figures is Stripe, so the copy below must say Stripe.
// ── Promo codes ──────────────────────────────────────────────────────────────
// Create and retire discount codes without a Stripe dashboard login. Stripe owns
// the objects (see backend/src/lib/promos.mjs), which is what keeps the discount
// on the invoice and therefore honest in the Finances tab.
//
// Codes are IMMUTABLE once created — Stripe's rule, not ours. The only edit is
// the on/off switch; changing the money means retiring a code and issuing a new
// one, which the empty-form copy says out loud so nobody hunts for an edit
// button that can't exist.
const PROMO_SCOPES = [['all', 'Everything'], ['plans', 'Plans only'], ['topups', 'Credit top-ups only']];

function blankPromo() {
  return {
    code: '', name: '', kind: 'percent', value: '',
    duration: 'once', durationInMonths: '3', scope: 'all',
    maxRedemptions: '', expiresAt: '', firstTimeOnly: false, minimumAmount: '',
    trialDays: '',
  };
}

function AdminPromos() {
  const [promos, setPromos] = useState(null);   // null = loading, undefined = errored
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState(blankPromo());
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError('');
    api.adminPromos()
      .then((r) => setPromos(r.promos || []))
      .catch((e) => { setError(e.message || 'Could not load promo codes.'); setPromos(undefined); });
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function create(e) {
    e.preventDefault();
    setSaving(true); setError(''); setMsg('');
    try {
      const { promo } = await api.adminCreatePromo({
        code: form.code.trim().toUpperCase(),
        name: form.name.trim(),
        // Stripe takes fixed amounts in minor units; the form asks for dollars.
        percentOff: form.kind === 'percent' ? Number(form.value) : null,
        amountOff: form.kind === 'amount' ? Math.round(Number(form.value) * 100) : null,
        duration: form.duration,
        durationInMonths: form.duration === 'repeating' ? Number(form.durationInMonths) : null,
        scope: form.scope,
        maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
        // A code should die at the END of its last day, not at midnight opening it.
        expiresAt: form.expiresAt ? Math.floor(new Date(`${form.expiresAt}T23:59:59`).getTime() / 1000) : null,
        firstTimeOnly: form.firstTimeOnly,
        minimumAmount: form.minimumAmount ? Math.round(Number(form.minimumAmount) * 100) : null,
        trialDays: form.trialDays ? Number(form.trialDays) : null,
      });
      setPromos((list) => [promo, ...(list || [])]);
      setForm(blankPromo());
      setOpen(false);
      setMsg(`${promo.code} is live.`);
    } catch (err) {
      setError(err.message || 'Could not create the promo code.');
    } finally {
      setSaving(false);
    }
  }

  async function toggle(promo) {
    const reactivating = !promo.active;
    if (!reactivating && !(await confirmDialog({
      title: `Deactivate ${promo.code}`,
      message: 'New redemptions stop immediately. Anyone already subscribed on this code keeps their discount — deactivating never raises a price someone has already been quoted.',
      confirmText: 'Deactivate',
    }))) return;
    setError('');
    try {
      const { promo: updated } = await api.adminSetPromoActive(promo.id, reactivating);
      setPromos((list) => list.map((p) => (p.id === updated.id ? updated : p)));
      setMsg(`${updated.code} ${updated.active ? 'reactivated' : 'deactivated'}.`);
    } catch (err) {
      setError(err.message || 'Could not update the code.');
    }
  }

  const discountOf = (p) => (p.percentOff != null ? `${p.percentOff}%` : fmtMoney((p.amountOff || 0) / 100, p.currency || CURRENCY.code))
    + (p.duration === 'repeating' ? ` × ${p.durationInMonths} mo` : p.duration === 'forever' ? ', forever' : ', once');
  const scopeLabel = (s) => (PROMO_SCOPES.find(([v]) => v === s)?.[1] || 'Custom (Stripe dashboard)');
  const expiredLabel = (p) => (p.expiresAt ? new Date(p.expiresAt * 1000).toLocaleDateString() : '—');

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setOpen((v) => !v)} className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-sm">
          <Plus size={14} /> New code
        </button>
        <button onClick={load} title="Refresh" className="btn-ghost ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          Codes are redeemable by anyone who has the string, at checkout and when an existing subscriber switches plans. Stripe holds them, so the discount shows on the invoice and in <b>Finances</b>. A code’s discount can’t be edited after it’s created — retire it and issue a new one.
        </span>
      </p>

      {error && <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {msg && <div className="mt-4 rounded-lg bg-green-50 dark:bg-green-500/10 px-4 py-3 text-sm text-green-700 dark:text-green-300">{msg}</div>}

      {open && (
        <form onSubmit={create} className="card mt-4 grid gap-4 p-5 sm:grid-cols-2">
          <label className="text-sm">
            <span className="font-medium">Code</span>
            <input value={form.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })}
              placeholder="LAUNCH20" required autoComplete="off" spellCheck={false}
              className="field mt-1 uppercase tracking-wide" />
            <span className="mt-1 block text-xs text-muted">What the customer types. A–Z, 0–9, hyphen or underscore.</span>
          </label>
          <label className="text-sm">
            <span className="font-medium">Internal name <span className="font-normal text-muted">(optional)</span></span>
            <input value={form.name} onChange={(e) => set({ name: e.target.value })}
              placeholder="July newsletter" className="field mt-1" />
            <span className="mt-1 block text-xs text-muted">Shown on the Stripe invoice line. Defaults to the code.</span>
          </label>

          <label className="text-sm">
            <span className="font-medium">Discount</span>
            <div className="mt-1 flex gap-2">
              <select value={form.kind} onChange={(e) => set({ kind: e.target.value })} className="field dm-select w-32">
                <option value="percent">Percent</option>
                <option value="amount">Fixed</option>
              </select>
              <input type="number" min="0" step={form.kind === 'percent' ? '1' : '0.01'}
                max={form.kind === 'percent' ? '100' : undefined}
                value={form.value} onChange={(e) => set({ value: e.target.value })}
                placeholder={form.kind === 'percent' ? '20' : '10.00'} required className="field flex-1" />
              <span className="self-center text-sm text-muted">{form.kind === 'percent' ? '%' : CURRENCY.code}</span>
            </div>
          </label>
          <label className="text-sm">
            <span className="font-medium">Lasts</span>
            <div className="mt-1 flex gap-2">
              <select value={form.duration} onChange={(e) => set({ duration: e.target.value })} className="field dm-select flex-1">
                <option value="once">One invoice</option>
                <option value="repeating">A number of months</option>
                <option value="forever">For as long as they subscribe</option>
              </select>
              {form.duration === 'repeating' && (
                <input type="number" min="1" step="1" value={form.durationInMonths}
                  onChange={(e) => set({ durationInMonths: e.target.value })} required className="field w-24" />
              )}
            </div>
            <span className="mt-1 block text-xs text-muted">Top-ups are one-off purchases, so anything past the first invoice only affects subscriptions.</span>
          </label>

          <label className="text-sm">
            <span className="font-medium">Applies to</span>
            <select value={form.scope} onChange={(e) => set({ scope: e.target.value })} className="field dm-select mt-1">
              {PROMO_SCOPES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="font-medium">Max redemptions <span className="font-normal text-muted">(optional)</span></span>
            <input type="number" min="1" step="1" value={form.maxRedemptions}
              onChange={(e) => set({ maxRedemptions: e.target.value })} placeholder="Unlimited" className="field mt-1" />
          </label>

          <label className="text-sm">
            <span className="font-medium">Expires <span className="font-normal text-muted">(optional)</span></span>
            <input type="date" value={form.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} className="field mt-1" />
            <span className="mt-1 block text-xs text-muted">Valid through the end of this day.</span>
          </label>
          <label className="text-sm">
            <span className="font-medium">Minimum spend <span className="font-normal text-muted">(optional)</span></span>
            <input type="number" min="0" step="0.01" value={form.minimumAmount}
              onChange={(e) => set({ minimumAmount: e.target.value })} placeholder={`${CURRENCY.symbol}0.00`} className="field mt-1" />
          </label>

          <label className="text-sm">
            <span className="font-medium">Free trial <span className="font-normal text-muted">(optional)</span></span>
            <div className="mt-1 flex gap-2">
              <input type="number" min="1" step="1" max="365" value={form.trialDays}
                onChange={(e) => set({ trialDays: e.target.value })}
                placeholder="No trial" disabled={form.scope === 'topups'}
                className="field flex-1 disabled:opacity-60" />
              <span className="self-center text-sm text-muted">days</span>
            </div>
            <span className="mt-1 block text-xs text-muted">
              {form.scope === 'topups'
                ? 'Top-ups are one-off purchases — there’s no subscription to put a trial on.'
                : 'Card collected up front, first charge deferred. Applies to a NEW subscription only: an existing subscriber redeeming this on a plan switch gets the discount, not the trial.'}
            </span>
          </label>
          <div className="hidden sm:block" aria-hidden />

          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.firstTimeOnly} onChange={(e) => set({ firstTimeOnly: e.target.checked })} className="mt-0.5" />
            <span>
              <span className="font-medium">New customers only</span>
              <span className="block text-xs text-muted">Blocks anyone who has ever paid us — including existing subscribers trying to use it on a plan switch.</span>
            </span>
          </label>

          <div className="flex items-center gap-2 sm:col-span-2">
            <button type="submit" disabled={saving} className="btn-primary disabled:opacity-60">{saving ? 'Creating…' : 'Create code'}</button>
            <button type="button" onClick={() => { setOpen(false); setForm(blankPromo()); }} className="btn-ghost">Cancel</button>
          </div>
        </form>
      )}

      {promos === null && <div className="mt-6 text-sm text-muted">Loading promo codes…</div>}
      {promos?.length === 0 && <div className="mt-6 text-sm text-muted">No promo codes yet.</div>}
      {promos?.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3">Code</th>
                <th className="py-2 pr-3">Discount</th>
                <th className="py-2 pr-3">Applies to</th>
                <th className="py-2 pr-3">Redeemed</th>
                <th className="py-2 pr-3">Expires</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {promos.map((p) => (
                <tr key={p.id} className="border-b border-line/60">
                  <td className="py-2 pr-3 font-mono font-semibold">
                    {p.code}
                    {p.firstTimeOnly && <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-[10px] font-sans font-medium text-muted">NEW ONLY</span>}
                    {p.minimumAmount ? <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-[10px] font-sans font-medium text-muted">MIN {fmtMoney(p.minimumAmount / 100, p.currency || CURRENCY.code)}</span> : null}
                    {p.trialDays ? <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-sans font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{p.trialDays}-DAY TRIAL</span> : null}
                  </td>
                  <td className="py-2 pr-3">{discountOf(p)}</td>
                  <td className="py-2 pr-3 text-muted">{scopeLabel(p.scope)}</td>
                  <td className="py-2 pr-3">{p.timesRedeemed}{p.maxRedemptions ? ` / ${p.maxRedemptions}` : ''}</td>
                  <td className="py-2 pr-3 text-muted">{expiredLabel(p)}</td>
                  <td className="py-2 pr-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.active ? 'bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-300' : 'bg-sunken text-muted'}`}>
                      {p.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    <button onClick={() => toggle(p)} className="btn-ghost px-2.5 py-1 text-xs">
                      {p.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AdminFinances() {
  const [days, setDays] = useState('30');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [data, setData] = useState(null); // null = loading, undefined = errored
  const [error, setError] = useState('');

  const rangeArgs = () => {
    if (custom.from && custom.to) return { from: `${custom.from}T00:00:00Z`, to: `${custom.to}T23:59:59Z` };
    const to = new Date();
    const from = new Date(to.getTime() - Number(days) * 86400000);
    return { from: from.toISOString(), to: to.toISOString() };
  };

  const load = () => {
    setData(null); setError('');
    api.adminFinances(rangeArgs())
      .then(setData)
      .catch((e) => { setError(e.message || 'Could not load finances.'); setData(undefined); });
  };
  useEffect(load, [days, custom.from, custom.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const ccy = data?.currency || CURRENCY.code;
  const rev = data?.revenue;
  const cost = data?.cost;
  const profit = data?.profit;
  const revErr = rev?.error;
  const money = (n) => fmtMoney(n, ccy);
  // Credits burned by SaaS accounts but driven from the internal index.html
  // cockpit — surfaced for transparency, deliberately not in the SaaS cost base.
  const excludedCredits = Object.values(cost?.cogs?.excluded || {}).reduce((a, b) => a + (Number(b) || 0), 0);

  return (
    <div className="mt-4">
      {/* Range toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-edge p-0.5">
          {RANGE_PRESETS.filter(([v]) => v !== '1').map(([v, label]) => (
            <button key={v}
              onClick={() => { setCustom({ from: '', to: '' }); setDays(v); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${!(custom.from && custom.to) && days === v ? 'bg-brand-600 text-white' : 'text-dim hover:bg-sunken'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted">
          <input type="date" value={custom.from} max={custom.to || undefined}
            onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            className="rounded-lg border border-edge px-2 py-1.5 text-sm" />
          <span>→</span>
          <input type="date" value={custom.to} min={custom.from || undefined}
            onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            className="rounded-lg border border-edge px-2 py-1.5 text-sm" />
        </div>
        <button onClick={load} title="Refresh" className="btn-ghost ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          SaaS product only — the internal cockpit's AWS and tool spend is excluded (see notes). Each load runs one or two <b>AWS Cost Explorer</b> queries (~US$0.01 each) plus a few read-only Stripe calls. Revenue and AWS spend are actual figures; the <b>AI &amp; data COGS</b> line is an estimate (see notes below).
        </span>
      </p>

      {error && <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {data === null && <div className="mt-6 text-sm text-muted">Loading finances…</div>}

      {data && cost && (
        <>
          {/* Headline stat tiles */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Net revenue" value={revErr ? '—' : money(rev.net)} sub={revErr ? '' : `${money(rev.gross)} gross`} />
            <Stat label="Total cost" value={money(cost.totalSgd)} sub="AWS + est. COGS" />
            <Stat label="Gross profit" value={money(profit?.grossProfitSgd)} tone={profit?.grossProfitSgd >= 0 ? 'ok' : 'warn'} sub="net revenue − cost" />
            <Stat label="Gross margin" value={profit?.marginPct == null ? '—' : fmtPct(profit.marginPct)} tone={profit?.marginPct == null ? undefined : profit.marginPct >= 0.5 ? 'ok' : profit.marginPct >= 0 ? undefined : 'warn'} />
            <Stat label="Run-rate MRR" value={money(data.mrr?.total)} sub={`${data.mrr?.byPlan?.reduce((a, p) => a + p.count, 0) || 0} paid subs`} />
          </div>

          {revErr && (
            <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Revenue unavailable: {revErr}. Costs are still shown below.
            </div>
          )}

          {/* Balance sheet: revenue vs cost, side by side */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title={`Revenue (${rev?.currency || ccy})`}>
              {revErr ? <Empty>Revenue unavailable.</Empty> : (
                <table className="w-full text-sm">
                  <tbody>
                    <LedgerRow label="Subscriptions" value={money(rev.subscriptions)} />
                    <LedgerRow label="Top-ups" value={money(rev.topups)} />
                    <LedgerRow label="Gross revenue" value={money(rev.gross)} strong border />
                    {/* Fees come from Stripe's balance-transaction list, a separate
                        call that can fail on its own. `feesAvailable: false` means
                        "we don't know", NOT zero — say so rather than quietly
                        understating cost. */}
                    <LedgerRow
                      label="Processing fees"
                      value={rev.feesAvailable === false ? '—' : `− ${money(rev.fees)}`}
                      sub={rev.feesAvailable === false ? 'Unavailable — net revenue excludes fees' : ''}
                      muted
                    />
                    <LedgerRow label="Refunds" value={`− ${money(rev.refunds)}`} muted />
                    <LedgerRow label="Net revenue" value={money(rev.net)} strong border />
                  </tbody>
                </table>
              )}
            </Panel>

            <Panel title={`Costs (${ccy})`}>
              <table className="w-full text-sm">
                <tbody>
                  <LedgerRow
                    label="AWS infrastructure"
                    value={cost.aws?.error ? '—' : money(cost.aws?.usd)}
                    tag={cost.aws?.scope && cost.aws.scope !== 'saas' ? 'all products' : undefined}
                    // `scope` is absent when the frontend is newer than the backend —
                    // never claim SaaS-only scoping we can't see evidence for.
                    sub={cost.aws?.error ? cost.aws.error
                      : cost.aws?.scope === 'saas' ? `Cost Explorer, ${cost.aws.tag || 'SaaS'} resources only`
                      : cost.aws?.scope === 'account' ? 'Cost Explorer, WHOLE ACCOUNT (see note)'
                      : 'Cost Explorer, all services'}
                  />
                  <LedgerRow
                    label="AI & data COGS"
                    value={money(cost.cogs?.usd)}
                    tag="est."
                    sub={`${fmtNum(cost.cogs?.credits)} credits × US$${cost.cogs?.usdPerCredit}/credit`}
                  />
                  <LedgerRow label="Total cost" value={money(cost.total)} strong border />
                </tbody>
              </table>
              {cost.aws?.note && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{cost.aws.note}</p>
              )}
              {excludedCredits > 0 && (
                <p className="mt-2 text-xs text-faint">
                  Excluded from this sheet: {fmtNum(excludedCredits)} credits
                  ({money(round2(excludedCredits * cost.cogs.usdPerCredit))}) consumed from the internal
                  cockpit — not SaaS product cost.
                </p>
              )}
            </Panel>
          </div>

          {/* Bottom line */}
          <section className="mt-4 rounded-xl border border-line bg-slate-900 p-4 text-white">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-faint">Gross profit ({ccy})</div>
                <div className={`mt-0.5 text-3xl font-bold tabular-nums ${profit?.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {money(profit?.grossProfit)}
                </div>
              </div>
              <div className="text-right text-sm text-slate-300">
                <div>Net revenue {revErr ? '—' : money(rev.net)}</div>
                <div>− Total cost {money(cost.total)}</div>
                <div className="mt-1 font-semibold text-white">Margin {profit?.marginPct == null ? '—' : fmtPct(profit.marginPct)}</div>
              </div>
            </div>
          </section>

          {/* Breakdowns */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* MRR by plan */}
            <Panel title="Run-rate MRR by plan">
              {data.mrr?.byPlan?.length ? (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className="py-1.5 font-semibold">Plan</th>
                    <th className="py-1.5 text-right font-semibold">Subs</th>
                    <th className="py-1.5 text-right font-semibold">MRR</th>
                  </tr></thead>
                  <tbody>
                    {data.mrr.byPlan.map((p) => (
                      <tr key={p.tier} className="border-b border-hair">
                        <td className="py-1.5">{p.name}</td>
                        <td className="py-1.5 text-right tabular-nums">{p.count}</td>
                        <td className="py-1.5 text-right tabular-nums">{money(p.mrr)}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold"><td className="py-1.5">Total</td>
                      <td className="py-1.5 text-right tabular-nums">{data.mrr.byPlan.reduce((a, p) => a + p.count, 0)}</td>
                      <td className="py-1.5 text-right tabular-nums">{money(data.mrr.total)}</td></tr>
                  </tbody>
                </table>
              ) : <Empty>No active paid subscriptions.</Empty>}
            </Panel>

            {/* AWS cost by service */}
            <Panel title="AWS cost by service (USD)">
              {cost.aws?.error ? <Empty>Cost data unavailable: {cost.aws.error}</Empty>
                : cost.aws?.byService?.length ? (
                <table className="w-full text-sm">
                  <tbody>
                    {cost.aws.byService.slice(0, 12).map((r) => (
                      <tr key={r.service} className="border-b border-hair">
                        <td className="py-1.5">{r.service}</td>
                        <td className="py-1.5 text-right tabular-nums">{fmtMoney(r.usd, 'USD')}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold"><td className="py-1.5">Total</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtMoney(cost.aws.usd, 'USD')}</td></tr>
                  </tbody>
                </table>
              ) : <Empty>No AWS spend recorded for this window.</Empty>}
            </Panel>
          </div>

          {/* COGS by tool */}
          {cost.cogs?.byTool?.length > 0 && (
            <Panel title="Credits consumed by tool (drives estimated COGS)">
              <table className="w-full text-sm">
                <tbody>
                  {cost.cogs.byTool.slice(0, 15).map((r) => (
                    <tr key={r.tool} className="border-b border-hair">
                      <td className="py-1.5 font-mono text-xs">{r.tool}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted">{fmtNum(r.credits)} credits</td>
                      <td className="py-1.5 text-right tabular-nums">{money(round2(r.credits * cost.cogs.usdPerCredit))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {cost.cogs.truncated && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Ledger scan truncated — COGS may be understated for very long windows.</p>}
            </Panel>
          )}

          {/* Method notes */}
          <div className="mt-4 rounded-xl border border-line bg-raised p-4 text-xs text-muted">
            <p className="font-semibold text-dim">How these numbers are built</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4">
              <li><b>Revenue</b> — actual, from Stripe: paid invoices = subscriptions; succeeded charges with no invoice = top-ups. Processing fees and refunds come from balance transactions. Settled in {rev?.currency || CURRENCY.code}.</li>
              <li>
                <b>Scope</b> — this is a <b>SaaS-product P&amp;L</b>. The internal cockpit (index.html / chatbot.html)
                shares this AWS account but earns no revenue, so its tool spend is excluded from COGS and its
                infrastructure is excluded from the AWS line{cost.aws?.scope === 'saas' ? '' : ' (except where noted below)'}.
                For the cockpit's own usage, see <b>Admin → Platform</b>.
              </li>
              <li>
                <b>AWS</b> — actual, from Cost Explorer{cost.aws?.scope === 'saas'
                  ? <>, filtered to resources tagged <code>{cost.aws.tag}</code> (the SaaS CloudFormation stack + the Amplify app)</>
                  : ' (all services)'}, natively in {ccy} so no FX conversion{cost.aws?.estimated ? '; latest days are AWS estimates' : ''}.
                {cost.aws?.scope === 'account' && <> <b>This window is unfiltered</b> — AWS records tags against cost data only from the day the tag was activated and never backfills, so it shows whole-account spend and understates SaaS margin.</>}
              </li>
              <li><b>AI &amp; data COGS</b> — <b>estimated</b>: {fmtNum(cost.cogs?.credits)} credits consumed × US${cost.cogs?.usdPerCredit}/credit (upstream vendor spend), counting only runs driven from the SaaS app. Not a billed figure.</li>
              <li><b>Run-rate MRR</b> — a snapshot of active paid subscribers × plan price, not windowed.</li>
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function LedgerRow({ label, value, sub, strong, border, muted, tag }) {
  return (
    <tr className={border ? 'border-t border-line' : ''}>
      <td className={`py-1.5 ${strong ? 'font-semibold text-strong' : muted ? 'text-muted' : ''}`}>
        {label}
        {tag && <span className="ml-1.5 rounded bg-amber-100 dark:bg-amber-500/15 px-1 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 align-middle">{tag}</span>}
        {sub && <div className="text-[11px] font-normal text-faint">{sub}</div>}
      </td>
      <td className={`py-1.5 text-right tabular-nums ${strong ? 'font-semibold text-heading' : muted ? 'text-muted' : 'text-body'}`}>{value}</td>
    </tr>
  );
}

// Per-product tool runs + estimated vendor spend: the SaaS dashboard vs the
// legacy index.html tools, side by side. Both surfaces emit the same
// Digimetrics/Usage CloudWatch metric; this reads it back per Source. The metric
// is forward-only (runs before it shipped were never attributed), so the panel
// says so rather than implying a complete history.
const USD = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const PRODUCTS = [
  { key: 'saas', label: 'SaaS dashboard', hint: 'app.digimetrics.ai' },
  { key: 'index', label: 'Agency tools', hint: 'index.html' },
];

function ProductSpendCard({ label, hint, row, share }) {
  const runs = row?.runs || 0;
  const cost = row?.estCostUSD || 0;
  return (
    <div className="rounded-xl border border-edge p-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-sm font-semibold text-strong">{label}</div>
          <div className="text-xs text-faint">{hint}</div>
        </div>
        <div className="text-xs text-muted">{share != null ? `${Math.round(share * 100)}% of spend` : ''}</div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <div className="text-lg font-semibold text-strong">{fmtNum(runs)}</div>
          <div className="text-xs text-muted">runs</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-strong">{USD(cost)}</div>
          <div className="text-xs text-muted">est. vendor spend</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-strong">{runs ? USD(cost / runs) : '—'}</div>
          <div className="text-xs text-muted">avg / run</div>
        </div>
      </div>
    </div>
  );
}

function ToolSpendByProduct({ spend }) {
  const totalCost = spend?.combined?.estCostUSD || 0;
  return (
    <Panel title="Runs & spend by product">
      {spend === null && <div className="text-sm text-muted">Loading per-product usage…</div>}
      {spend === undefined && <Empty>Per-product usage metric unavailable yet — it starts accruing once tool runs flow through the tagged backend.</Empty>}
      {spend && spend.bySource && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {PRODUCTS.map((p) => (
              <ProductSpendCard key={p.key} label={p.label} hint={p.hint}
                row={spend.bySource[p.key]}
                share={totalCost ? (spend.bySource[p.key]?.estCostUSD || 0) / totalCost : null} />
            ))}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-faint">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Combined: <b>{fmtNum(spend.combined?.runs)}</b> runs · <b>{USD(totalCost)}</b> estimated vendor cost.
              Spend is estimated from per-tool vendor rates (DataForSEO / Anthropic / SE Ranking …), not a billed figure,
              and only counts runs since attribution shipped — there’s no historical backfill.
            </span>
          </p>
        </>
      )}
    </Panel>
  );
}

// Per-provider LLM usage: Claude vs DeepSeek (vs OpenAI) token counts + estimated
// $, from the fleet-wide Digimetrics/LLM metric. Token-based estimate — the
// provider consoles remain the authoritative bill. Forward-only per Lambda.
const LLM_META = {
  claude: { label: 'Claude', hint: 'Anthropic', color: '#d97757' },
  deepseek: { label: 'DeepSeek', hint: 'deepseek.com', color: '#4d6bfe' },
  openai: { label: 'OpenAI', hint: 'GPT', color: '#10a37f' },
};
const fmtTokens = (n) => {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
};

const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '0%');
// chatbot.html is folded into 'index' — it shares the agency backend.
const SOURCE_LABEL = { saas: 'SaaS dashboard', index: 'Agency tools (index + chatbot)', unknown: 'Unattributed' };

function LlmProviderCard({ pkey, row, share }) {
  const meta = LLM_META[pkey] || { label: pkey, hint: '', color: '#64748b' };
  const cached = row?.cacheReadTokens || 0;
  const totalIn = (row?.inputTokens || 0) + cached; // billed input + cached reads
  return (
    <div className="rounded-xl border border-edge p-4">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
          <div>
            <div className="text-sm font-semibold text-strong">{meta.label}</div>
            <div className="text-xs text-faint">{meta.hint}</div>
          </div>
        </div>
        <div className="text-xs text-muted">{share != null ? `${Math.round(share * 100)}% of est. $` : ''}</div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <div className="text-lg font-semibold text-strong">{USD(row?.estCostUSD)}</div>
          <div className="text-xs text-muted">est. spend</div>
        </div>
        <div>
          <div className="text-lg font-semibold text-strong">{fmtNum(row?.calls)}</div>
          <div className="text-xs text-muted">calls</div>
        </div>
        <div>
          <div className="text-sm font-medium text-dim">{fmtTokens(row?.inputTokens)}<span className="text-faint"> / {fmtTokens(row?.outputTokens)}</span></div>
          <div className="text-xs text-muted">tokens in / out</div>
        </div>
        <div>
          <div className="text-sm font-medium text-dim">{cached ? pct(cached, totalIn) : '—'}</div>
          <div className="text-xs text-muted">cached{row?.webSearchRequests ? ` · ${fmtNum(row.webSearchRequests)} web` : ''}</div>
        </div>
      </div>
    </div>
  );
}

function LlmUsageByProvider({ llm }) {
  const totalCost = llm?.combined?.estCostUSD || 0;
  const providers = llm?.byProvider ? Object.keys(llm.byProvider) : [];
  const auth = llm?.authoritative;
  const usage = llm?.anthropicUsage;
  const ds = llm?.deepseek;
  // Prefer Anthropic's own per-model token counts: they cover the FULL window,
  // whereas our metric is forward-only and only sees instrumented calls.
  const authModels = (usage?.configured && !usage?.error && usage.byModel?.length) ? usage.byModel : null;
  const costItems = (auth?.configured && !auth?.error) ? (auth.byModel || []) : [];
  const topModels = (llm?.byModel || []).slice(0, 8);
  // Per-front-end split; biggest spender first, zero-traffic sources dropped.
  const sourceRows = Object.entries(llm?.bySource || {})
    .filter(([, r]) => r.calls > 0)
    .sort((a, b) => b[1].estCostUSD - a[1].estCostUSD);
  const sourceTotal = sourceRows.reduce((a, [, r]) => a + (r.estCostUSD || 0), 0);
  // Provider-side data is worth showing even with zero instrumented calls.
  const hasAny = providers.length > 0 || authModels || costItems.length > 0 || ds?.configured;
  return (
    <Panel title="LLM usage by provider">
      {llm === null && <div className="text-sm text-muted">Loading LLM usage…</div>}
      {llm === undefined && <Empty>LLM usage metric unavailable yet — it starts accruing as model calls flow through the instrumented Lambdas.</Empty>}
      {llm && !hasAny && <Empty>No model calls recorded in this window yet.</Empty>}
      {llm && hasAny && (
        <>
          {/* Authoritative bill vs our estimate, when an Anthropic admin key is configured. */}
          {auth?.configured && auth.totalCostUSD != null && (
            <div className="mb-3 rounded-lg bg-sunken px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-muted">Anthropic actual bill (this window): <b className="text-strong">{USD(auth.totalCostUSD)}</b></span>
                <span className="text-faint">our Claude estimate {USD(llm.byProvider?.claude?.estCostUSD || 0)}</span>
              </div>
              {/* These two measure different things — say so, or the gap reads as a bug. */}
              <p className="mt-1 text-xs text-faint">
                Not a like-for-like check: the bill is your <b>whole Anthropic organisation</b> for this window, while the
                estimate counts only calls recorded since each Lambda was instrumented. They converge as the metric
                accumulates, but org usage outside this fleet stays in the bill only.
                {auth.truncated ? ' (Bill truncated — window too long to page fully.)' : ''}
              </p>
            </div>
          )}
          {/* DeepSeek exposes a real remaining-credit balance (Anthropic doesn't),
              so show it even when DeepSeek had no calls this window. */}
          {ds?.configured && !ds.error && (ds.balances || []).length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-sunken px-3 py-2 text-sm">
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: LLM_META.deepseek.color }} />
                <span className="text-muted">DeepSeek credit remaining:</span>
              </span>
              {ds.balances.map((b) => (
                <b key={b.currency} className="text-strong">{b.currency} {b.total.toFixed(2)}</b>
              ))}
              {!ds.isAvailable && <span className="text-amber-700 dark:text-amber-300">account unavailable</span>}
              <span className="text-xs text-faint">balance, not spend — Anthropic exposes no equivalent</span>
            </div>
          )}
          {ds?.error && <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">DeepSeek balance unavailable: {ds.error}</p>}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {providers.map((p) => (
              <LlmProviderCard key={p} pkey={p} row={llm.byProvider[p]}
                share={totalCost ? (llm.byProvider[p]?.estCostUSD || 0) / totalCost : null} />
            ))}
          </div>

          {/* Which front-end drove the model spend. 'unknown' = calls that reached
              a Lambda without a _source tag (e.g. crons, or an untagged caller). */}
          {sourceRows.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium text-muted">LLM spend by product</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="py-1 pr-3 font-medium">Product</th>
                      <th className="py-1 pr-3 font-medium">Calls</th>
                      <th className="py-1 pr-3 font-medium">In / Out</th>
                      <th className="py-1 pr-3 font-medium">Share</th>
                      <th className="py-1 font-medium">Est. $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourceRows.map(([key, r]) => (
                      <tr key={key} className="border-t border-edge">
                        <td className="py-1 pr-3 text-dim">{SOURCE_LABEL[key] || key}</td>
                        <td className="py-1 pr-3 text-dim">{fmtNum(r.calls)}</td>
                        <td className="py-1 pr-3 text-dim">{fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}</td>
                        <td className="py-1 pr-3 text-dim">{sourceTotal ? pct(r.estCostUSD, sourceTotal) : '—'}</td>
                        <td className="py-1 font-medium text-strong">{USD(r.estCostUSD)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {/* Per-model breakdown. Anthropic's own token counts win when available
              (full window); otherwise fall back to what our metric has seen. */}
          {authModels ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-medium text-muted">Anthropic — actual tokens by model ({usage.byModel.length === 1 ? '1 model' : `${usage.byModel.length} models`})</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted">
                      <th className="py-1 pr-3 font-medium">Model</th>
                      <th className="py-1 pr-3 font-medium">Output</th>
                      <th className="py-1 pr-3 font-medium">Input</th>
                      <th className="py-1 pr-3 font-medium">Cache rd / wr</th>
                      <th className="py-1 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authModels.map((m) => (
                      <tr key={m.model} className="border-t border-edge">
                        <td className="py-1 pr-3 font-mono text-xs text-dim">{m.model}</td>
                        <td className="py-1 pr-3 font-medium text-strong">{fmtTokens(m.outputTokens)}</td>
                        <td className="py-1 pr-3 text-dim">{fmtTokens(m.inputTokens)}</td>
                        <td className="py-1 pr-3 text-dim">{fmtTokens(m.cacheReadTokens)} / {fmtTokens(m.cacheWriteTokens)}</td>
                        <td className="py-1 font-medium text-strong">{USD(m.estCostUSD)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Where the money actually splits (output vs input vs cache vs tools). */}
              {costItems.length > 0 && (
                <p className="mt-2 text-xs text-faint">
                  Cost split: {costItems.slice(0, 7).map((c, i) => (
                    <span key={c.model}>{i > 0 ? ' · ' : ''}{String(c.model).replace(/^Claude\s+/, '').replace(/\s*Usage\s*-\s*/, ' ')} <b>{USD(c.costUSD)}</b></span>
                  ))}
                </p>
              )}
            </div>
          ) : topModels.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <div className="mb-1 text-xs font-medium text-muted">From our metric (instrumented calls only)</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 pr-3 font-medium">Model</th>
                    <th className="py-1 pr-3 font-medium">Calls</th>
                    <th className="py-1 pr-3 font-medium">In / Out</th>
                    <th className="py-1 pr-3 font-medium">Cached</th>
                    <th className="py-1 font-medium">Est. $</th>
                  </tr>
                </thead>
                <tbody>
                  {topModels.map((m) => (
                    <tr key={`${m.provider}/${m.model}`} className="border-t border-edge">
                      <td className="py-1 pr-3 font-mono text-xs text-dim">{m.model}</td>
                      <td className="py-1 pr-3 text-dim">{fmtNum(m.calls)}</td>
                      <td className="py-1 pr-3 text-dim">{fmtTokens(m.inputTokens)} / {fmtTokens(m.outputTokens)}</td>
                      <td className="py-1 pr-3 text-dim">{m.cacheReadTokens ? pct(m.cacheReadTokens, m.inputTokens + m.cacheReadTokens) : '—'}</td>
                      <td className="py-1 font-medium text-strong">{USD(m.estCostUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {usage?.error && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Anthropic usage report unavailable: {usage.error}</p>}
          <p className="mt-3 flex items-start gap-1.5 text-xs text-faint">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Combined: <b>{fmtNum(llm.combined?.calls)}</b> calls · <b>{fmtTokens(llm.combined?.inputTokens)}</b> in / <b>{fmtTokens(llm.combined?.outputTokens)}</b> out · <b>{USD(totalCost)}</b> estimated.
              Cost is computed from per-model token rates including cache-read/write and web-search pricing.
              {auth?.configured ? '' : ' Add an Anthropic admin key to show the authoritative bill alongside.'} Forward-only (no backfill).
            </span>
          </p>
        </>
      )}
    </Panel>
  );
}

// Per-tool cost, split by platform. Backed by a Logs Insights scan rather than a
// metric dimension (Tool x Source would add hundreds of custom metrics costing
// more per month than the spend they measure), so it is on-demand.
function ToolCostByPlatform({ rangeArgs }) {
  const [data, setData] = useState(null); // null = idle
  const [busy, setBusy] = useState(false);
  const load = () => {
    setBusy(true);
    api.adminToolCost(rangeArgs())
      .then(setData)
      .catch((e) => setData({ error: e.message || 'Query failed' }))
      .finally(() => setBusy(false));
  };
  const rows = data?.rows || [];
  const total = data?.totals?.estCostUSD || 0;
  return (
    <Panel title="Cost per tool, by platform">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={load} disabled={busy} className="btn-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm disabled:opacity-50">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> {busy ? 'Scanning logs…' : data ? 'Re-run' : 'Run breakdown'}
        </button>
        <span className="text-xs text-faint">Scans the model-call logs on demand — a few seconds, ~$0.005/GB.</span>
      </div>
      {data?.error && <p className="mt-3 text-sm text-red-700 dark:text-red-300">{data.error}</p>}
      {data && !data.error && rows.length === 0 && <Empty>No model calls with a tool tag in this window yet.</Empty>}
      {data && !data.error && rows.length > 0 && (
        <>
          {data.complete === false && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Partial results — the scan was still running when the request timed out. Re-run or narrow the window.</p>
          )}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-3 font-medium">Platform</th>
                  <th className="py-1 pr-3 font-medium">Tool</th>
                  <th className="py-1 pr-3 font-medium">Calls</th>
                  <th className="py-1 pr-3 font-medium">In / Out</th>
                  <th className="py-1 pr-3 font-medium">Share</th>
                  <th className="py-1 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.source}/${r.tool}`} className="border-t border-edge">
                    <td className="py-1 pr-3 text-dim">{SOURCE_LABEL[r.source] || r.source}</td>
                    <td className="py-1 pr-3 font-mono text-xs text-dim">{r.tool}</td>
                    <td className="py-1 pr-3 text-dim">{fmtNum(r.calls)}</td>
                    <td className="py-1 pr-3 text-dim">{fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}</td>
                    <td className="py-1 pr-3 text-dim">{total ? pct(r.estCostUSD, total) : '—'}</td>
                    <td className="py-1 font-medium text-strong">{USD(r.estCostUSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-faint">
            Total <b>{USD(total)}</b> across <b>{fmtNum(data.totals?.calls)}</b> model calls.
            Tools sharing one Lambda are separated by the tool tag; calls made before tagging shipped fall back to the Lambda name.
          </p>
        </>
      )}
    </Panel>
  );
}

function AdminPlatform() {
  const [days, setDays] = useState('30');
  const [custom, setCustom] = useState({ from: '', to: '' }); // YYYY-MM-DD; overrides preset when both set
  const [data, setData] = useState(null); // null = loading
  const [spend, setSpend] = useState(null); // per-product tool spend; null = loading
  const [llm, setLlm] = useState(null); // per-provider LLM usage; null = loading
  const [error, setError] = useState('');

  // Resolve the active window into ISO from/to the API accepts. A complete
  // custom range wins; otherwise it's a `days` lookback from now.
  const rangeArgs = () => {
    if (custom.from && custom.to) return { from: `${custom.from}T00:00:00Z`, to: `${custom.to}T23:59:59Z` };
    const to = new Date();
    const from = new Date(to.getTime() - Number(days) * 86400000);
    return { from: from.toISOString(), to: to.toISOString() };
  };

  const load = () => {
    setData(null); setSpend(null); setLlm(null); setError('');
    api.adminPlatformUsage(rangeArgs())
      .then(setData)
      .catch((e) => { setError(e.message || 'Could not load usage.'); setData(undefined); });
    // Independent (free CloudWatch reads) — each has its own error state so a
    // metric gap never blanks the whole panel.
    api.adminToolSpend(rangeArgs())
      .then(setSpend)
      .catch(() => setSpend(undefined));
    api.adminLlmUsage(rangeArgs())
      .then(setLlm)
      .catch(() => setLlm(undefined));
  };
  // Reload whenever the window changes.
  useEffect(load, [days, custom.from, custom.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.totals, d = data?.derived;
  const chartSeries = data?.series?.length ? [
    { label: 'Requests', color: '#2563eb', points: data.series.map((p) => ({ date: p.t, value: p.requests || 0 })) },
    { label: 'Data out (MB)', color: '#7c3aed', points: data.series.map((p) => ({ date: p.t, value: (p.bytesDownloaded || 0) / 1e6 })) },
  ] : [];

  return (
    <div className="mt-4">
      {/* Range toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-edge p-0.5">
          {RANGE_PRESETS.map(([v, label]) => (
            <button key={v}
              onClick={() => { setCustom({ from: '', to: '' }); setDays(v); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${!(custom.from && custom.to) && days === v ? 'bg-brand-600 text-white' : 'text-dim hover:bg-sunken'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-sm text-muted">
          <input type="date" value={custom.from} max={custom.to || undefined}
            onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            className="rounded-lg border border-edge px-2 py-1.5 text-sm" />
          <span>→</span>
          <input type="date" value={custom.to} min={custom.from || undefined}
            onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            className="rounded-lg border border-edge px-2 py-1.5 text-sm" />
        </div>
        <button onClick={load} title="Refresh" className="btn-ghost ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span>
          Heads up on cost: each load or refresh runs one <b>AWS Cost Explorer</b> query (~US$0.01 per call), so changing the range or hitting Refresh costs about a cent. Traffic metrics, builds and the access-log detail are effectively free.
        </span>
      </p>
      {data?.app && (
        <p className="mt-1 text-xs text-faint">
          {data.app.domain} · branch {data.app.branch}
        </p>
      )}

      {error && <div className="mt-4 rounded-lg bg-red-50 dark:bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</div>}
      {data === null && <div className="mt-6 text-sm text-muted">Loading Amplify usage…</div>}

      {data && t && (
        <>
          {/* Headline stat tiles */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Requests" value={fmtNum(t.requests)} />
            <Stat label="Data transfer out" value={fmtBytes(t.bytesDownloaded)} />
            <Stat label="Error rate" value={fmtPct(d.errorRate)} sub={`${fmtNum(t.errors4xx)} × 4xx · ${fmtNum(t.errors5xx)} × 5xx`} tone={d.errorRate > 0.05 ? 'warn' : 'ok'} />
            <Stat label="Avg latency" value={`${Math.round(d.avgLatency * 1000)} ms`} sub={`p90 ${Math.round(d.peakLatencyP90 * 1000)} ms`} />
            <Stat label="Est. spend" value={data.cost?.totalCost != null ? `$${data.cost.totalCost.toFixed(2)}` : '—'} sub={data.cost?.estimated ? 'incl. estimated' : ''} />
          </div>

          {/* Runs & estimated vendor spend, split by front-end product. */}
          <ToolSpendByProduct spend={spend} />

          {/* LLM token usage + estimated spend, split by provider (Claude/DeepSeek). */}
          <LlmUsageByProvider llm={llm} />

          {/* Per-tool cost split by platform (on-demand log scan). */}
          <ToolCostByPlatform rangeArgs={rangeArgs} />

          {/* Traffic chart */}
          <Panel title="Traffic">
            {chartSeries.length ? <TrendChart series={chartSeries} /> : <Empty>No traffic in this window.</Empty>}
            <p className="mt-2 text-xs text-faint">Avg page weight {fmtBytes(d.avgPageWeight)} · uploaded {fmtBytes(t.bytesUploaded)}</p>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Cost breakdown */}
            <Panel title="Cost (Cost Explorer)">
              {data.cost?.error ? <Empty>Cost data unavailable: {data.cost.error}</Empty>
                : data.cost?.byType?.length ? (
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-xs uppercase tracking-wide" style={{ background: '#1e293b', color: '#f1f5f9' }}>
                    <th className="rounded-l px-2 py-1.5 font-semibold">Usage type</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Quantity</th>
                    <th className="rounded-r px-2 py-1.5 text-right font-semibold">Cost</th>
                  </tr></thead>
                  <tbody>
                    {data.cost.byType.map((r) => (
                      <tr key={r.usageType} className="border-b border-hair">
                        <td className="px-2 py-1.5">{r.usageType}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.quantity.toFixed(3)} {r.unit === 'GigaBytes' ? 'GB' : r.unit}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">${r.cost.toFixed(4)}</td>
                      </tr>
                    ))}
                    <tr className="font-semibold"><td className="px-2 py-1.5">Total</td><td /><td className="px-2 py-1.5 text-right tabular-nums">${data.cost.totalCost.toFixed(2)}</td></tr>
                  </tbody>
                </table>
              ) : <Empty>No Amplify spend recorded for this window.</Empty>}
              {data.cost?.granularity && <p className="mt-2 text-xs text-faint">{data.cost.granularity.toLowerCase()} granularity{data.cost.estimated ? ' · latest days estimated' : ''}</p>}
            </Panel>

            {/* Build / deploy activity */}
            <Panel title="Builds & deploys">
              {data.builds?.error ? <Empty>Build data unavailable: {data.builds.error}</Empty> : (
                <>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <MiniStat label="Builds" value={fmtNum(data.builds?.count || 0)} />
                    <MiniStat label="Succeeded" value={fmtNum(data.builds?.succeeded || 0)} tone="ok" />
                    <MiniStat label="Failed" value={fmtNum(data.builds?.failed || 0)} tone={data.builds?.failed ? 'warn' : undefined} />
                    <MiniStat label="Build min" value={fmtNum(data.builds?.buildMinutes || 0)} />
                  </div>
                  {data.builds?.recent?.length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs text-muted">
                      {data.builds.recent.map((j) => (
                        <li key={j.id} className="flex justify-between">
                          <span className={j.status === 'FAILED' ? 'text-red-600 dark:text-red-400' : j.status === 'SUCCEED' ? 'text-emerald-600 dark:text-emerald-400' : ''}>{j.status}</span>
                          <span>{j.startTime ? fmtWhen(j.startTime) : '—'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </Panel>
          </div>

          {/* Access-log breakdowns (on demand) */}
          <AccessLogPanel rangeArgs={rangeArgs} rangeKey={`${days}|${custom.from}|${custom.to}`} />
        </>
      )}
    </div>
  );
}

// Heavy, on-demand: fetches + parses the per-request access log only when opened.
function AccessLogPanel({ rangeArgs, rangeKey }) {
  const [state, setState] = useState('idle'); // idle | loading | done | error
  const [logs, setLogs] = useState(null);
  const [error, setError] = useState('');

  // A range change invalidates any loaded logs (they belonged to the old window).
  useEffect(() => { setState('idle'); setLogs(null); setError(''); }, [rangeKey]);

  const load = () => {
    setState('loading'); setError('');
    api.adminPlatformAccessLogs(rangeArgs())
      .then((d) => { setLogs(d); setState('done'); })
      .catch((e) => { setError(e.message || 'Could not load access logs.'); setState('error'); });
  };

  return (
    <Panel title="Traffic detail (access logs)">
      {state === 'idle' && (
        <div className="text-sm text-muted">
          <p>Per-request breakdown — top pages, referrers, devices, edge geography and cache-hit ratio. This exports and parses the raw access log, so it takes a few seconds.</p>
          <button onClick={load} className="btn-primary mt-3 px-3 py-2 text-sm">Load traffic detail</button>
        </div>
      )}
      {state === 'loading' && <div className="text-sm text-muted">Exporting &amp; parsing access log…</div>}
      {state === 'error' && (
        <div className="text-sm text-red-700 dark:text-red-300">{error} <button onClick={load} className="ml-2 underline">Retry</button></div>
      )}
      {state === 'done' && logs && (
        <div>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-dim">
            <span><b>{fmtNum(logs.rows)}</b> requests parsed</span>
            <span>Cache hit ratio <b>{fmtPct(logs.cacheHitRatio)}</b></span>
            <span>{fmtBytes(logs.bytes)} served</span>
            <span className="text-faint">{logs.status['2xx']} · 2xx / {logs.status['4xx']} · 4xx / {logs.status['5xx']} · 5xx</span>
            {logs.truncated && <span className="text-amber-600 dark:text-amber-400">sampled (window truncated)</span>}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <RankList title="Top pages" rows={logs.topPages} />
            <RankList title="Top referrers" rows={logs.topReferrers} empty="Direct / no referrer data" />
            <RankList title="Edge geography" rows={logs.edgeGeo} />
            <RankList title="Devices" rows={logs.devices} />
            <RankList title="Browsers" rows={logs.browsers} />
          </div>
          <button onClick={load} className="btn-ghost mt-3 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm"><RefreshCw size={14} /> Reload</button>
        </div>
      )}
    </Panel>
  );
}

function RankList({ title, rows, empty = 'No data' }) {
  const max = Math.max(1, ...(rows || []).map((r) => r.count));
  return (
    <div>
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h4>
      {rows?.length ? (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.name} className="relative flex items-center justify-between overflow-hidden rounded px-2 py-1 text-sm">
              <span className="absolute inset-y-0 left-0 bg-brand-50 dark:bg-brand-500/10" style={{ width: `${(r.count / max) * 100}%` }} aria-hidden />
              <span className="relative z-10 mr-2 truncate text-body" title={r.name}>{r.name}</span>
              <span className="relative z-10 shrink-0 tabular-nums text-muted">{fmtNum(r.count)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-faint">{empty}</p>}
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="mt-4 rounded-xl border border-line bg-surface p-4">
      <h3 className="mb-3 text-sm font-semibold text-strong">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-heading';
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, tone }) {
  const color = tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-strong';
  return (
    <div className="rounded-lg bg-raised py-2">
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

const Empty = ({ children }) => <p className="py-3 text-sm text-faint">{children}</p>;

function fmtNum(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function fmtPct(f) { return `${((Number(f) || 0) * 100).toFixed(1)}%`; }
// Currency with a sign-aware negative (−US$5.00, not US$-5.00). Known codes get
// their symbol, anything else falls back to the bare code.
function fmtMoney(n, ccy = CURRENCY.code) {
  const v = Number(n) || 0;
  const sym = ccy === 'SGD' ? 'S$' : ccy === 'USD' ? 'US$' : `${ccy} `;
  const body = `${sym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `−${body}` : body;
}
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
function fmtBytes(n) {
  let v = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
