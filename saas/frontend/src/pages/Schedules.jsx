// Scheduled Runs — set up a tool to run automatically on a cadence, then compare
// each period against the previous one. Recurring runs fire server-side (the
// hourly schedules cron), land in history tagged with the schedule, and show up
// here with period-over-period deltas.
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Clock, Play, Trash2, Pencil, Plus, Pause, ChevronDown, ChevronRight, TrendingUp, TrendingDown, Minus, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import {
  schedulableTools, scheduleLimits, inputsFor, CREDIT_COSTS, CATEGORIES,
} from '@shared/catalog.mjs';
import {
  FREQUENCIES, WEEKDAYS, describeSchedule, runsPerMonth, DEFAULT_TZ,
} from '@shared/schedule.mjs';

const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ; } catch { return DEFAULT_TZ; } })();
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtNum = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString() : (Math.round(n * 100) / 100).toString());

// Estimated credit cost of one fire (unit × fan-out item count).
function costPerRun(tool, inputs) {
  const unit = CREDIT_COSTS[tool.cost] ?? 0;
  if (!unit || !tool.fanout) return unit;
  const raw = inputs?.[tool.fanout];
  const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  return unit * Math.max(1, Math.min(50, arr.length));
}

const isVisible = (f, values) => !f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]);

// ── A dependency-light field renderer (mirrors ToolRunner's field types) ─────
function SchedField({ field, value, onChange }) {
  const base = 'field mt-1.5';
  const t = field.type;
  let control;
  if (t === 'tags') {
    // Hold the raw text while editing (an array seed is shown comma-joined) and
    // only split into items at submit — splitting on every keystroke fights the
    // caret and drops spaces mid-word.
    const display = Array.isArray(value) ? value.join(', ') : (value ?? '');
    control = (
      <input className={base} placeholder={field.placeholder || 'comma-separated'} value={display}
        onChange={(e) => onChange(e.target.value)} />
    );
  } else if (t === 'textarea') {
    control = <textarea rows={3} className={base} placeholder={field.placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  } else if (t === 'select' || t === 'segmented') {
    control = (
      <select className={`${base} dm-select pr-9`} value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (t === 'multiselect') {
    const arr = Array.isArray(value) ? value : [];
    control = (
      <select multiple className={`${base} h-28`} value={arr}
        onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
        {(field.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (t === 'date') {
    control = <input type="date" className={base} value={value || ''} onChange={(e) => onChange(e.target.value)} />;
  } else {
    control = <input type={t === 'number' ? 'number' : 'text'} className={base} placeholder={field.placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{field.label}{field.required && <span className="text-slate-400"> *</span>}</span>
      {control}
      {field.hint && <span className="mt-1 block whitespace-pre-line text-xs text-slate-400">{field.hint}</span>}
    </label>
  );
}

// ── Create / edit modal ──────────────────────────────────────────────────────
function ScheduleModal({ editing, prefill, limits, projects, onClose, onSaved }) {
  const tools = useMemo(() => schedulableTools(), []);
  const [toolId, setToolId] = useState(editing?.toolId || prefill?.toolId || tools[0]?.id);
  const tool = tools.find((t) => t.id === toolId) || tools[0];
  const fields = useMemo(() => (tool ? inputsFor(tool) : []), [tool]);

  const [name, setName] = useState(editing?.name || '');
  const [values, setValues] = useState({});
  const [projectId, setProjectId] = useState(editing?.projectId || '');
  const [frequency, setFrequency] = useState(editing?.frequency || limits.freqs[0] || 'weekly');
  const [dayOfWeek, setDayOfWeek] = useState(editing?.dayOfWeek ?? 1);
  const [dayOfMonth, setDayOfMonth] = useState(editing?.dayOfMonth ?? 1);
  const [hour, setHour] = useState(editing?.hour ?? 9);
  const [busy, setBusy] = useState(false);

  // Seed field values from defaults (or the schedule being edited / prefilled).
  useEffect(() => {
    const seed = editing?.inputs || prefill?.inputs || {};
    const init = {};
    for (const f of fields) init[f.name] = f.name in seed ? seed[f.name] : (f.default ?? (f.type === 'tags' || f.type === 'multiselect' ? [] : ''));
    setValues(init);
  }, [toolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const allowedFreqs = FREQUENCIES.filter((f) => limits.freqs.includes(f.id));
  const perRun = tool ? costPerRun(tool, values) : 0;
  const monthly = perRun * runsPerMonth(frequency);

  async function save() {
    // Normalise a field's value for submit — `tags` are split from their raw
    // edit string into a deduped item list here (not on every keystroke).
    const normalise = (f, v) => {
      if (f.type !== 'tags') return v;
      const arr = Array.isArray(v) ? v : String(v || '').split(/[\n,]+/);
      return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
    };
    // Required-field check (visible fields only).
    for (const f of fields) {
      if (!isVisible(f, values)) continue;
      const v = normalise(f, values[f.name]);
      const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
      if (f.required && empty) { toast(`${f.label} is required.`, 'error'); return; }
    }
    const inputs = {};
    for (const f of fields) if (isVisible(f, values)) inputs[f.name] = normalise(f, values[f.name]);
    const payload = {
      toolId, name: name || tool.name, inputs, projectId: projectId || null,
      frequency, hour: Number(hour), timezone: BROWSER_TZ,
      ...(frequency === 'weekly' ? { dayOfWeek: Number(dayOfWeek) } : {}),
      ...(frequency === 'monthly' ? { dayOfMonth: Number(dayOfMonth) } : {}),
    };
    setBusy(true);
    try {
      if (editing) await api.updateSchedule({ scheduleId: editing.scheduleId, ...payload });
      else await api.createSchedule(payload);
      toast(editing ? 'Schedule updated' : 'Schedule created', 'success');
      onSaved();
    } catch (e) {
      toast(e?.message || 'Could not save the schedule.', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="card max-h-[90vh] w-full max-w-lg overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{editing ? 'Edit schedule' : 'New schedule'}</h2>
          <button className="text-slate-400 hover:text-slate-600" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Tool</span>
            <select className="field dm-select mt-1.5 pr-9" value={toolId} disabled={!!editing}
              onChange={(e) => setToolId(e.target.value)}>
              {CATEGORIES.map((cat) => {
                const inCat = tools.filter((t) => t.category === cat);
                if (!inCat.length) return null;
                return <optgroup key={cat} label={cat}>{inCat.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</optgroup>;
              })}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Name <span className="text-slate-400">(optional)</span></span>
            <input className="field mt-1.5" placeholder={tool?.name} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          {fields.filter((f) => isVisible(f, values)).map((f) => (
            <SchedField key={f.name} field={f} value={values[f.name]} onChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} />
          ))}

          {projects?.length > 0 && (
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Project <span className="text-slate-400">(optional — feeds Performance charts)</span></span>
              <select className="field dm-select mt-1.5 pr-9" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name || p.domain}</option>)}
              </select>
            </label>
          )}

          {/* Cadence */}
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="mb-2 text-sm font-medium text-slate-700">How often</div>
            <div className="flex flex-wrap gap-2">
              {allowedFreqs.map((f) => (
                <button key={f.id} type="button" onClick={() => setFrequency(f.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm ${frequency === f.id ? 'bg-brand-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>
                  {f.label}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              {frequency === 'weekly' && (
                <label className="block">
                  <span className="text-xs text-slate-500">Day</span>
                  <select className="field dm-select mt-1 pr-9" value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
                    {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                  </select>
                </label>
              )}
              {frequency === 'monthly' && (
                <label className="block">
                  <span className="text-xs text-slate-500">Day of month</span>
                  <select className="field dm-select mt-1 pr-9" value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)}>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </label>
              )}
              <label className="block">
                <span className="text-xs text-slate-500">Time</span>
                <select className="field dm-select mt-1 pr-9" value={hour} onChange={(e) => setHour(e.target.value)}>
                  {HOURS.map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                </select>
              </label>
              <span className="pb-2 text-xs text-slate-400">{BROWSER_TZ}</span>
            </div>
          </div>

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            {perRun === 0
              ? <>Uses your connected account data — <strong>0 credits</strong> per run.</>
              : <>Est. <strong>{perRun} credit{perRun === 1 ? '' : 's'}</strong> per run · <strong>~{monthly}</strong>/month at this cadence.</>}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : (editing ? 'Save changes' : 'Create schedule')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Delta chip ───────────────────────────────────────────────────────────────
function Delta({ row }) {
  if (row.delta == null) return <span className="text-xs text-slate-400">first run</span>;
  if (row.delta === 0) return <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Minus size={12} />no change</span>;
  const good = row.improved;
  const cls = good == null ? 'text-slate-500' : good ? 'text-emerald-600' : 'text-rose-600';
  const Icon = row.delta > 0 ? TrendingUp : TrendingDown;
  const pct = row.pct == null ? '' : ` (${row.pct > 0 ? '+' : ''}${fmtNum(row.pct)}%)`;
  return <span className={`inline-flex items-center gap-1 text-xs font-medium ${cls}`}><Icon size={12} />{row.delta > 0 ? '+' : ''}{fmtNum(row.delta)}{row.unit}{pct}</span>;
}

// ── Comparison + run timeline (expanded under a schedule) ─────────────────────
function ComparePanel({ scheduleId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    api.scheduleCompare(scheduleId).then((d) => alive && setData(d)).catch((e) => alive && setErr(e?.message || 'Could not load comparison.'));
    return () => { alive = false; };
  }, [scheduleId]);

  async function openRun(runId) {
    try { const { run } = await api.run(runId); navigate(`/tool/${run.tool}`, { state: { values: run.inputs, result: run.result } }); } catch { /* ignore */ }
  }

  if (err) return <div className="border-t border-slate-100 px-4 py-3 text-sm text-rose-600">{err}</div>;
  if (!data) return <div className="border-t border-slate-100 px-4 py-3 text-sm text-slate-400">Loading comparison…</div>;

  return (
    <div className="border-t border-slate-100 px-4 py-3">
      {data.comparison?.length > 0 ? (
        <>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
            This period vs previous {data.previous ? `· ${fmtDate(data.previous.ts)}` : ''}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.comparison.map((row) => (
              <div key={row.key} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-slate-700">{row.label}</div>
                  <div className="text-lg font-semibold text-slate-900">{fmtNum(row.current)}{row.unit}</div>
                </div>
                <div className="text-right">
                  <Delta row={row} />
                  {row.previous != null && <div className="mt-0.5 text-xs text-slate-400">was {fmtNum(row.previous)}{row.unit}</div>}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-sm text-slate-500">
          {data.runs?.length ? 'This tool has no trackable headline metric — open the runs below to compare.' : 'No runs yet. Fire one with “Run now”.'}
        </div>
      )}

      {data.runs?.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">Run history</div>
          <div className="divide-y divide-slate-100">
            {data.runs.map((r) => (
              <button key={r.runId} onClick={() => openRun(r.runId)}
                className="flex w-full items-center justify-between py-2 text-left text-sm hover:text-brand-700">
                <span className="text-slate-600">{fmtDate(r.ts)}</span>
                <span className="truncate px-2 text-slate-400">{r.preview || r.target || ''}</span>
                <span className="text-xs text-slate-400">{r.creditsUsed ? `${r.creditsUsed} cr` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ s }) {
  if (!s.enabled) return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Paused</span>;
  const st = s.lastStatus;
  const map = {
    ok: ['bg-emerald-50 text-emerald-700', 'Last run OK'],
    failed: ['bg-rose-50 text-rose-700', 'Last run failed'],
    skipped_no_credits: ['bg-amber-50 text-amber-700', 'Skipped — no credits'],
  };
  const [cls, label] = map[st] || ['bg-brand-50 text-brand-700', 'Active'];
  return <span className={`rounded-full px-2 py-0.5 text-xs ${cls}`}>{label}</span>;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Schedules() {
  const { user } = useAuth();
  const { projects } = useProjects();
  const location = useLocation();
  const [schedules, setSchedules] = useState(null);
  const [limits, setLimits] = useState(() => scheduleLimits(user?.tier));
  const [modal, setModal] = useState(null); // { editing? , prefill? }
  const [expanded, setExpanded] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const { schedules, limits } = await api.schedules();
      setSchedules(schedules || []);
      if (limits) setLimits(limits);
    } catch (e) { toast(e?.message || 'Could not load schedules.', 'error'); setSchedules([]); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // A "Schedule this" hand-off from ToolRunner (router state) opens the modal prefilled.
  useEffect(() => {
    if (location.state?.scheduleCreate) setModal({ prefill: location.state.scheduleCreate });
  }, [location.state]);

  async function toggle(s) {
    setBusyId(s.scheduleId);
    try { await api.updateSchedule({ scheduleId: s.scheduleId, enabled: !s.enabled }); await load(); }
    catch (e) { toast(e?.message || 'Could not update.', 'error'); }
    finally { setBusyId(null); }
  }
  async function runNow(s) {
    setBusyId(s.scheduleId);
    try { await api.runScheduleNow(s.scheduleId); toast('Run queued — it’ll appear in history shortly.', 'success'); }
    catch (e) { toast(e?.message || 'Could not run now.', 'error'); }
    finally { setBusyId(null); }
  }
  async function remove(s) {
    if (!window.confirm(`Delete the schedule “${s.name}”? Past runs stay in your history.`)) return;
    setBusyId(s.scheduleId);
    try { await api.deleteSchedule(s.scheduleId); await load(); }
    catch (e) { toast(e?.message || 'Could not delete.', 'error'); }
    finally { setBusyId(null); }
  }

  const atLimit = schedules && schedules.length >= limits.maxSchedules;

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Scheduled Runs</h1>
          <p className="mt-1 text-sm text-slate-500">Run any tool automatically and compare each period to the last.</p>
        </div>
        {limits.enabled && (
          <button className="btn-primary inline-flex items-center gap-1.5" disabled={atLimit} onClick={() => setModal({})}>
            <Plus size={16} />New schedule
          </button>
        )}
      </div>

      {!limits.enabled && (
        <div className="card p-8 text-center">
          <Clock className="mx-auto mb-3 text-brand-500" size={28} />
          <h2 className="text-lg font-semibold text-slate-900">Automate your tool runs</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">Scheduling isn’t available on the {user?.tier} plan. Upgrade to run tools on a daily, weekly or monthly cadence and track how the numbers move.</p>
          <a href="/pricing" className="btn-primary mt-4 inline-block">See plans</a>
        </div>
      )}

      {limits.enabled && atLimit && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You’ve used all {limits.maxSchedules} schedules on your {user?.tier} plan. Delete one or upgrade to add more.
        </div>
      )}

      {limits.enabled && schedules?.length === 0 && (
        <div className="card p-8 text-center text-slate-400">No schedules yet — create one to run a tool on a cadence.</div>
      )}

      {limits.enabled && schedules === null && <p className="text-slate-400">Loading…</p>}

      <div className="space-y-3">
        {schedules?.map((s) => (
          <div key={s.scheduleId} className="card overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 p-4">
              <button className="text-slate-400 hover:text-slate-600" onClick={() => setExpanded(expanded === s.scheduleId ? null : s.scheduleId)} aria-label="Toggle details">
                {expanded === s.scheduleId ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-slate-900">{s.name}</span>
                  <StatusBadge s={s} />
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {s.toolName} · {describeSchedule(s)} · next {fmtWhen(s.nextRunAt)}
                  {s.runCount ? ` · ${s.runCount} run${s.runCount === 1 ? '' : 's'}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button className="btn-ghost !px-2 !py-1.5" title="Run now" disabled={busyId === s.scheduleId} onClick={() => runNow(s)}><Play size={15} /></button>
                <button className="btn-ghost !px-2 !py-1.5" title={s.enabled ? 'Pause' : 'Resume'} disabled={busyId === s.scheduleId} onClick={() => toggle(s)}>{s.enabled ? <Pause size={15} /> : <Play size={15} />}</button>
                <button className="btn-ghost !px-2 !py-1.5" title="Edit" onClick={() => setModal({ editing: s })}><Pencil size={15} /></button>
                <button className="btn-ghost !px-2 !py-1.5 text-rose-600" title="Delete" disabled={busyId === s.scheduleId} onClick={() => remove(s)}><Trash2 size={15} /></button>
              </div>
            </div>
            {expanded === s.scheduleId && <ComparePanel scheduleId={s.scheduleId} />}
          </div>
        ))}
      </div>

      {modal && (
        <ScheduleModal
          editing={modal.editing} prefill={modal.prefill} limits={limits} projects={projects}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}
