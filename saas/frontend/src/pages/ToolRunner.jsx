import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { toolById, inputsFor, tabsFor, exampleFor, CREDIT_COSTS, PLANS, tierMeets, isSchedulable, scheduleLimits } from '@shared/catalog.mjs';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import UpgradeModal from '../components/UpgradeModal.jsx';
import ResultSections from '../components/ResultSections.jsx';
import ReportHtml from '../components/ReportHtml.jsx';
import SchemaResult from '../components/SchemaResult.jsx';
import SortableTable from '../components/SortableTable.jsx';
import ShareResult from '../components/ShareResult.jsx';
import InfoTip, { glossaryFor } from '../components/InfoTip.jsx';
import { toast, copyText, downloadCsv, fmtNum, pushRecent, saveLastInput, loadLastInput } from '../lib/ui.js';
import { startToolTour, sampleResultFor, hasSeen, markSeen } from '../lib/tours.js';
import { Lock, Compass, Sparkles, AlertTriangle, Clock, ChevronRight, Check, MessageCircleQuestion, ThumbsUp, ThumbsDown } from 'lucide-react';

const CONFIRM_AT = 25; // credits — confirm before running pricey tools

// Tell the proactive assistant a run finished. Status is a coarse read of the
// payload so triggers can distinguish "here are your results" from "nothing came
// back" without every tool needing a bespoke shape.
function runStatusOf(res) {
  const r = res?.result;
  if (r == null) {
    const meaningful = res && Object.keys(res).some((k) => !['creditsUsed', 'creditsRemaining', 'topupRemaining'].includes(k));
    return meaningful ? 'success' : 'empty';
  }
  if (Array.isArray(r)) return r.length ? 'success' : 'empty';
  if (Array.isArray(r.rows)) return r.rows.length ? 'success' : 'empty';
  if (Array.isArray(r.data)) return r.data.length ? 'success' : 'empty';
  if (typeof r === 'object') return Object.keys(r).length ? 'success' : 'empty';
  return 'success';
}
function emitRunFinished(toolName, status) {
  window.dispatchEvent(new CustomEvent('dm:proactive-event', { detail: { event: 'run_finished', status, toolName } }));
}

export default function ToolRunner() {
  const { toolId } = useParams();
  const { user, setCredits } = useAuth();
  const { activeId, active } = useProjects();
  const tool = toolById(toolId);
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useMemo(() => tabsFor(tool), [tool]);
  const [tab, setTab] = useState(0);
  const activeTab = tabs?.[tab];
  const fields = useMemo(() => (tabs ? activeTab?.fields || [] : tool ? inputsFor(tool) : []), [tool, tabs, activeTab]);

  // Smart default for a tool's site/URL field: the active project's domain, so
  // beginners don't have to know/paste their own site. Returns '' for non-site
  // fields (a site field is url-typed, named domain/website/target, or a text
  // field whose placeholder is a domain example — excludes free-text like a topic).
  const siteDefault = (f) => {
    const dom = (active?.domain || '').trim();
    if (!dom) return '';
    const bare = dom.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (f.type === 'url') return /^https?:\/\//.test(dom) ? dom : `https://${bare}`;
    const looksSite = ['domain', 'website', 'target'].includes(f.name)
      || (f.type !== 'textarea' && /example\.com|yoursite|https?:\/\//i.test(f.placeholder || ''));
    return looksSite ? bare : '';
  };
  const seedValues = () => {
    const fromHistory = location.state?.values;
    const last = fromHistory ? {} : (loadLastInput(toolId) || {});
    // Site/URL field ALWAYS defaults to the active project's domain — never a
    // stale last-run value from a different project (which confused beginners).
    // Other fields keep their last-used value → default.
    return Object.fromEntries(fields.map((f) => {
      const p = siteDefault(f);
      if (f.name in (fromHistory || {})) return [f.name, fromHistory[f.name]];
      if (p) return [f.name, p];
      return [f.name, last[f.name] ?? f.default ?? ''];
    }));
  };
  const [values, setValues] = useState(seedValues);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null); // live server-side progress for async-job tools
  const [nudge, setNudge] = useState(false); // highlight missing required fields after an incomplete run attempt
  const [out, setOut] = useState(location.state?.result ? { result: location.state.result, runId: location.state.runId } : null);
  const [modal, setModal] = useState(null);
  const [showAdv, setShowAdv] = useState(false); // reveal collapsed optional fields on long forms
  const shownRef = useRef([]); // latest visible fields, for the auto-started tour

  // Reset the form + result when navigating between tools (same route component).
  useEffect(() => { setTab(0); setValues(seedValues()); setNudge(false); setOut(location.state?.result ? { result: location.state.result, runId: location.state.runId } : null); /* eslint-disable-next-line */ }, [toolId]);

  // The active project often loads AFTER first render, so the initial seed can
  // miss the domain and fall back to a stale value. Once the project's domain is
  // known (or changes), (re)apply it to the site field — but never clobber a run
  // in progress, a shown result, or a value the user has already edited.
  const projDomain = active?.domain || '';
  useEffect(() => {
    if (!projDomain || busy || out) return;
    setValues((v) => {
      const next = { ...v };
      for (const f of fields) {
        const p = siteDefault(f);
        if (p && p !== v[f.name]) next[f.name] = p;
      }
      return next;
    });
    // eslint-disable-next-line
  }, [projDomain, toolId]);

  // First tool a user ever opens → auto-run that tool's guided tour, once.
  useEffect(() => {
    if (!tool || hasSeen('tool:any')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:any')) return;
      markSeen('tool:any');
      launchTour(shownRef.current);
    }, 700);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [toolId]);

  if (!tool) return <p>Unknown tool.</p>;
  // Tools with a bespoke page (e.g. Social Media Audit) render at their own
  // route, not the generic runner — redirect if someone lands here directly.
  if (tool.route) return <Navigate to={tool.route} replace />;
  const unlocked = tierMeets(user.tier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const set = (name, v) => { setNudge(false); setValues((s) => ({ ...s, [name]: v })); };
  // Switch GSC sub-tool tab: clear the previous result, seed any new fields'
  // defaults, but keep shared values (e.g. the selected property) across tabs.
  function selectTab(i) {
    setTab(i);
    setOut(null);
    setValues((v) => { const next = { ...v }; for (const f of tabs[i].fields) if (!(f.name in next)) next[f.name] = f.default ?? ''; return next; });
  }
  const isVisible = (f) => (!f.staffOnly || user.isAdmin) && (!f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]));
  const shown = fields.filter(isVisible);
  shownRef.current = shown;
  const missing = shown.filter((f) => f.required && !String(values[f.name] || '').trim());
  const ready = missing.length === 0;
  const isMissing = (f) => nudge && missing.includes(f);

  // Run was clicked without the required fields → don't disable silently. Light up
  // the empty required fields in amber and scroll to the first one (matches the
  // goal-picker's "self-teaching" nudge instead of a dead, greyed-out button).
  function attemptRun() {
    if (!ready) {
      setNudge(true);
      document.querySelector(`[data-tour-field="${missing[0]?.name}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    run();
  }

  // Long forms overwhelm beginners: keep required fields + the first couple of
  // optional ones visible, and tuck the rest behind an "Advanced options" toggle.
  // Fields flagged `advanced` in the catalog (raw GAQL, expert knobs) collapse
  // even on short forms — they should never sit in a beginner's first view.
  const optionalShown = shown.filter((f) => !f.required);
  const collapseForm = shown.length >= 8 && optionalShown.length >= 5;
  const advSet = new Set([
    ...(collapseForm ? optionalShown.slice(2) : []),
    ...optionalShown.filter((f) => f.advanced),
  ]);
  const primaryFields = shown.filter((f) => !advSet.has(f));
  const advancedFields = shown.filter((f) => advSet.has(f));
  const example = exampleFor(tool.id);

  function fillExample() {
    if (!example) return;
    setValues((s) => ({ ...s, ...example }));
    toast('Example filled in', 'info');
  }

  // Guided tour: pre-fill the worked example + render its real result on the
  // page (so the walkthrough annotates a genuine run), and clear both on exit.
  function launchTour(tourFields = shown) {
    startToolTour(tool, tourFields, {
      preview: () => {
        if (example) setValues((s) => ({ ...s, ...example }));
        const sample = sampleResultFor(tool.id);
        if (sample) setOut({ creditsUsed: cost, creditsRemaining: 1860, ...sample });
      },
      clear: () => {
        setValues(Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])));
        setOut(null);
      },
    });
  }

  async function run(vals = values) {
    // Confirm destructive GSC ops (index removal / sitemap delete) before sending.
    const dw = activeTab?.destructiveWhen;
    if (dw && (dw.in || []).includes(vals[dw.field])) {
      const what = activeTab.op === 'indexing' ? 'request removal of these URLs from Google’s index' : 'delete this sitemap from Search Console';
      if (!window.confirm(`This will ${what}. Continue?`)) return;
    }
    if (unlocked && cost >= CONFIRM_AT && !window.confirm(`This run costs ${cost} credits. Continue?`)) return;
    setBusy(true);
    setOut(null);
    setJob(null);
    try {
      let res = await api.runTool(tool.id, { ...vals, gscOp: activeTab?.op, url: vals.url || vals.input, projectId: activeId || undefined }, tool.slow);
      // Async job tools (content-writer): the first response is just a job id —
      // the run continues server-side (finishing even if this tab closes). Poll
      // for REAL stage/agent progress, then adopt the finished payload.
      if (res?.result?.jobId && res?.result?.status && !res.result.sections && !res.result.html) {
        setJob({ status: res.result.status });
        const done = await pollJob(tool.id, res.result.jobId, setJob);
        res = {
          result: done.result || {}, runId: done.runId || null,
          creditsUsed: done.creditsUsed, creditsRemaining: done.creditsRemaining, topupRemaining: done.topupRemaining,
        };
      }
      setOut(res);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
      if (res.creditsUsed > 0) toast(`−${res.creditsUsed} credit${res.creditsUsed > 1 ? 's' : ''} · ${res.creditsRemaining} left`, 'info');
      saveLastInput(tool.id, vals);
      pushRecent(tool.id);
      // Let the proactive Otter react to a finished run (success vs. empty result).
      emitRunFinished(tool.name, runStatusOf(res));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 403)) {
        setModal({
          reason: e.payload.error,
          requiredTier: e.payload.requiredTier || tool.minTier,
          creditsRemaining: e.payload.creditsRemaining,
          creditsNeeded: e.payload.creditsNeeded,
        });
      } else {
        setOut({ error: e.message });
        emitRunFinished(tool.name, 'error');
      }
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="text-sm text-muted hover:text-strong">← All tools</Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{tool.name}</h1>
        {!unlocked && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-500/15 px-2.5 py-1 text-xs font-bold uppercase text-amber-700 dark:text-amber-300"><Lock size={12} aria-hidden /> {PLANS[tool.minTier].name}</span>}
        <button
          type="button"
          onClick={() => launchTour(shown)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
          title="Guided walkthrough with a real example"
        >
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-dim">{tool.desc}</p>

      {!unlocked && tool.teaser && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-4 py-3 text-sm text-brand-800 dark:text-brand-300">
          <Sparkles size={16} className="shrink-0" aria-hidden /> <span>You get <strong>one free preview run</strong> on your own data. Full results unlock with {PLANS[tool.minTier].name}.</span>
        </div>
      )}

      {/* GSC sub-tool tabs (URL Inspection / Sitemaps / Indexing), like index.html. */}
      {tabs && (
        <div className="mt-5 flex flex-wrap gap-1 border-b border-line">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(i)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition ${i === tab ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-muted hover:text-strong'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className={`card ${tabs ? 'mt-4' : 'mt-6'} p-5`}>
        <div className="space-y-4">
          {primaryFields.map((f, i) => (
            <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} autoFocus={i === 0} provider={tool.integration} values={values} invalid={isMissing(f)} />
          ))}
          {advancedFields.length > 0 && (
            <div className="border-t border-hair pt-3">
              <button type="button" onClick={() => setShowAdv((s) => !s)}
                className="flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
                <ChevronRight size={15} className={`transition-transform ${showAdv ? 'rotate-90' : ''}`} aria-hidden />
                {showAdv ? 'Hide' : 'Show'} advanced options
                <span className="text-xs font-normal text-faint">({advancedFields.length} optional)</span>
              </button>
              {showAdv && (
                <div className="mt-4 space-y-4">
                  {advancedFields.map((f) => (
                    <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} provider={tool.integration} values={values} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-faint" data-tour="tool-actions">
            <span title={tool.costVaries ? 'Base cost — longer content and deeper QA (up to 18 agents) can cost more.' : undefined}>{cost === 0 ? 'Free to run' : `Costs ${cost}${tool.costVaries ? '+' : ''} credit${(cost > 1 || tool.costVaries) ? 's' : ''}`}</span>
            {example && <button type="button" onClick={fillExample} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Try an example</button>}
            {shown.some((f) => f.required) && <span><span className="text-amber-500">*</span> Required</span>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!ready && (
              <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${nudge ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'text-amber-600 dark:text-amber-400'}`}>
                <AlertTriangle size={13} aria-hidden />
                {missing.length === 1 ? `“${missing[0].label}” is required` : `${missing.length} required fields left`}
              </span>
            )}
            {isSchedulable(tool) && scheduleLimits(user?.tier).enabled && !tabs && (
              <button type="button" className="btn-ghost inline-flex items-center gap-1.5"
                title="Run this automatically on a schedule"
                onClick={() => navigate('/schedules', { state: { scheduleCreate: { toolId: tool.id, inputs: values } } })}>
                <Clock size={15} />Schedule
              </button>
            )}
            <button className={`btn-primary ${!ready ? 'opacity-60' : ''}`} disabled={busy} aria-disabled={busy || !ready}
              onClick={attemptRun} data-tour="tool-run">
              {busy ? (tool.slow ? 'Generating…' : 'Running…') : unlocked ? 'Run tool' : 'Run preview'}
            </button>
          </div>
        </div>
      </div>

      {/* Live re-pivot for integration dashboards — change range/breakdown and
          re-pull in place (integration pulls are free), like index.html. */}
      {tool.integration && unlocked && (out || busy) && (!tabs || activeTab?.op === 'insights') && (
        <RepivotBar
          fields={shown.filter((f) => f.type === 'select')}
          values={values}
          busy={busy}
          onChange={(name, v) => { const nv = { ...values, [name]: v }; setValues(nv); run(nv); }}
        />
      )}

      {busy && tool.slow && <SlowProgress tool={tool} job={job} />}
      {out && !busy && <Result out={out} tool={tool} project={active} user={user} onCredits={setCredits} />}

      {modal && <UpgradeModal reason={modal.reason} requiredTier={modal.requiredTier} creditsRemaining={modal.creditsRemaining} creditsNeeded={modal.creditsNeeded} onClose={() => setModal(null)} />}
    </div>
  );
}

// Poll a background job until it finishes. Transient poll failures are ignored
// (the job keeps running server-side); a hard cap stops a zombie poll loop —
// the run itself still completes, lands in History and fires a notification.
async function pollJob(toolId, jobId, onTick) {
  const deadline = Date.now() + 12 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3500));
    let s = null;
    try { s = (await api.runTool(toolId, { cwAction: 'status', jobId }, true))?.result; }
    catch { continue; }
    if (!s) continue;
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || 'The run failed. No credits were charged.');
    if (s.status === 'unknown') throw new Error('We lost track of this run — check History in a minute; it may still have finished.');
    onTick?.(s);
  }
  throw new Error('This is taking unusually long. The run continues in the background — you’ll get a notification, and the result will be in History.');
}

// Staged checklist for long runs. Tools with a background job report REAL
// progress (stage + agents done/total); everything else advances on a schedule
// scaled to the tool's typical duration (not a fixed 6s — which raced to
// "almost there" and then sat still, reading as stuck). Past the typical window
// we say so honestly instead of looping the same message.
function SlowProgress({ tool, job }) {
  const steps = ['Sending your request', 'Reaching the data sources', 'Crunching the numbers', 'Compiling the results'];
  const TYPICAL = 90; // seconds — middle of the ~30–150s band for slow tools
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(a);
  }, []);
  const overdue = sec > 150;

  // Live server-side progress (async-job tools like the Content Optimiser).
  if (job) {
    const p = job.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
    return (
      <div className="card mt-6 p-6">
        <div className="flex items-center gap-3">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          <span className="font-medium text-body">{job.stage || 'Starting'}…</span>
          <span className="ml-auto text-xs tabular-nums text-faint">{sec}s</span>
        </div>
        {pct != null && (
          <div className="mt-4">
            <div className="h-2 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all" style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <div className="mt-1.5 text-xs tabular-nums text-muted">{p.done}/{p.total} QA agents finished</div>
          </div>
        )}
        <p className="mt-4 text-sm text-dim">
          This run finishes on our servers even if you close the tab — you’ll get a notification, and the result lands in History.
        </p>
      </div>
    );
  }

  const i = Math.min(Math.floor((sec / TYPICAL) * steps.length), steps.length - 1);
  return (
    <div className="card mt-6 p-6">
      <div className="flex items-center gap-3">
        <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        <span className="font-medium text-body">{steps[i]}…</span>
        <span className="ml-auto text-xs tabular-nums text-faint">{sec}s · usually 30–150s</span>
      </div>
      <ul className="mt-4 space-y-2">
        {steps.map((s, k) => (
          <li key={s} className={`flex items-center gap-2 text-sm ${k < i ? 'text-muted' : k === i ? 'font-medium text-body' : 'text-faint'}`}>
            {k < i
              ? <Check size={15} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden />
              : k === i
              ? <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-400 border-t-transparent" aria-hidden />
              : <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line" aria-hidden />}
            {s}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-dim">
        This keeps running on our servers even if you close the tab — you’ll get a notification and it lands in History. Stay on this page and the result appears below.
      </p>
      {overdue && (
        <p className="mt-2 text-sm text-dim">
          Still working — big sites and busy data sources can take a few minutes.
        </p>
      )}
    </div>
  );
}

// ── Result ────────────────────────────────────────────────────────────────────
function copyableOf(r) {
  if (r.text) return r.text;
  if (r.sections) return sectionsToText(r.sections);
  if (r.rows) { const cols = Object.keys(r.rows[0] || {}); return [cols.join('\t'), ...r.rows.map((row) => cols.map((c) => row[c]).join('\t'))].join('\n'); }
  if (r.html) { const d = document.createElement('div'); d.innerHTML = r.html; return d.innerText; }
  return JSON.stringify(r, null, 2);
}

// Flatten the structured `sections` format into plain text for Copy.
function sectionsToText(sections) {
  const out = [];
  for (const s of sections || []) {
    if (s.title) out.push(s.title);
    switch (s.type) {
      case 'heading': out.push(s.text); break;
      case 'callout': case 'text': out.push(s.text); break;
      case 'stats': out.push((s.items || []).map((it) => `${it.label}: ${it.value}`).join('  ·  ')); break;
      case 'list': for (const x of s.items || []) out.push(`• ${x}`); break;
      case 'cards':
        for (const c of s.items || []) {
          out.push(`${c.title}${c.badge ? ` [${c.badge}]` : ''}${c.meta ? ` — ${c.meta}` : ''}`);
          for (const l of c.lines || []) out.push(`  ${l.label ? `${l.label}: ` : ''}${l.value}`);
          if (c.body) out.push(`  ${c.body}`);
        }
        break;
      case 'table':
        out.push((s.columns || []).join('\t'));
        for (const row of s.rows || []) out.push((s.columns || []).map((c) => row[c] ?? '').join('\t'));
        break;
      case 'code':
        out.push(s.content || '');
        break;
      case 'html': {
        const d = document.createElement('div');
        d.innerHTML = s.html || '';
        out.push(d.innerText);
        break;
      }
      default: break;
    }
    out.push('');
  }
  return out.join('\n').trim();
}

// First tabular section, for the CSV button.
function firstTable(sections) { return (sections || []).find((s) => s.type === 'table' && s.rows && s.rows.length); }

function PrintHeader({ tool, project, user }) {
  const brand = project?.name || (user?.email ? user.email.split('@')[0] : 'Digimetrics');
  const target = project?.domain;
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="dm-print-header">
      <div className="dm-ph-brand">{brand}</div>
      <div className="dm-ph-title">{tool.name}{target ? ` · ${target}` : ''}</div>
      <div className="dm-ph-meta">Generated {date} · Digimetrics</div>
    </div>
  );
}

// Free plain-English summary, auto-fetched for every real run (runId present —
// the guided tour's sample results skip it). Cached per run so re-renders and
// remounts never refetch. Fails silently: the raw result is still on screen.
const tldrCache = new Map();
function TldrPanel({ tool, r, runId }) {
  const [state, setState] = useState(() => tldrCache.get(runId) || { loading: true, text: '' });
  useEffect(() => {
    let alive = true;
    const hit = tldrCache.get(runId);
    if (hit) { setState(hit); return undefined; }
    setState({ loading: true, text: '' });
    api.explainResult(tool.name, copyableOf(r).slice(0, 5000))
      .then((d) => { const s = { loading: false, text: String(d.summary || '').trim() }; tldrCache.set(runId, s); if (alive) setState(s); })
      .catch(() => { const s = { loading: false, text: '' }; tldrCache.set(runId, s); if (alive) setState(s); });
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [runId]);
  if (!state.loading && !state.text) return null;
  return (
    <div className="dm-no-print mb-4 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 dark:bg-brand-500/10 p-4">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">
        <Sparkles size={13} aria-hidden /> What this means — in plain English
      </div>
      {state.loading ? (
        <div className="mt-2.5 space-y-1.5" aria-label="Writing your summary…">
          {[92, 78, 60].map((w) => <div key={w} className="h-3 animate-pulse rounded bg-brand-100 dark:bg-brand-500/20" style={{ width: `${w}%` }} />)}
        </div>
      ) : (
        <TldrText text={state.text} />
      )}
    </div>
  );
}

// Light renderer for the explainer reply: paragraphs + the fixed labels bolded.
// (The upstream returns plain text / light markdown; we don't ship a full
// markdown renderer for a 150-word summary.)
function TldrText({ text }) {
  const lines = String(text).replace(/\*\*/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="mt-2 space-y-1 text-sm leading-relaxed text-body">
      {lines.map((l, i) => {
        const m = l.match(/^(Looking good|Needs attention|Do this next)\s*:?\s*(.*)$/i);
        if (m) return <p key={i}><strong className="font-semibold text-heading">{m[1]}:</strong> {m[2]}</p>;
        return <p key={i}>{l}</p>;
      })}
    </div>
  );
}

// Backend/exception strings are not layman copy ("fetch failed", "502"). Show a
// calm card with likely causes and ways forward instead of red raw text.
function FriendlyError({ message, tool }) {
  const askMonty = () => {
    window.dispatchEvent(new CustomEvent('dm:ask', {
      detail: { text: `I ran the "${tool.name}" tool and got this error: "${message}". In plain English, what does it mean and what should I try?` },
    }));
  };
  return (
    <div className="card mt-6 p-6">
      <div className="flex items-center gap-2 font-semibold text-heading">
        <AlertTriangle size={18} className="text-amber-500" aria-hidden /> That run didn’t work
      </div>
      <p className="mt-2 text-sm text-dim">
        No credits were wasted on failed runs. This usually comes down to one of these:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-dim">
        <li>A typo in the website address — check it loads in a new tab.</li>
        <li>The data source being briefly busy — trying again in a minute often fixes it.</li>
        <li>A very new or very small site with no data yet.</li>
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" onClick={askMonty} className="btn-ghost inline-flex items-center gap-1.5 text-sm">
          <MessageCircleQuestion size={15} aria-hidden /> Ask Monty for help
        </button>
        <span className="text-xs text-faint">Technical detail: {message}</span>
      </div>
    </div>
  );
}

// A run that finished but returned nothing used to render a blank card — this
// panel always explains and points at the usual fix (input format).
function EmptyResult({ tool }) {
  return (
    <div className="card mt-6 p-6 text-center">
      <p className="font-semibold text-heading">No data came back</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-dim">
        The run finished, but there was nothing to show. That’s usually the website address or keyword format — try the bare domain (like <span className="font-medium">example.com</span>), or broader keywords.
      </p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: `I ran the "${tool.name}" tool and it returned no data. What input should I try instead?` } }))}
        className="btn-ghost mt-4 inline-flex items-center gap-1.5 text-sm"
      >
        <MessageCircleQuestion size={15} aria-hidden /> Ask Monty what to try
      </button>
    </div>
  );
}

function Result({ out, tool, project, user, onCredits }) {
  if (out.error) return <FriendlyError message={out.error} tool={tool} />;
  const r = out.result || {};

  if (r.needsConnect) {
    return (
      <div className="card mt-6 p-6 text-center">
        <p className="text-dim">{r.text || 'Connect your account to use this tool.'}</p>
        <Link to="/integrations" className="btn-primary mt-3 inline-block">Connect your account →</Link>
      </div>
    );
  }

  const isSchema = tool.id === 'schema' && r.text;
  const hasContent = r.text || r.preview || r.html || (r.rows && r.rows.length) || (r.sections && r.sections.length);
  const sectionTable = r.sections && firstTable(r.sections);

  // Finished but nothing to show → explain it, don't render a blank card.
  if (!hasContent && !r.blurredCount && !r.detailsLocked && !out.failed) return <EmptyResult tool={tool} />;

  // Recommendation cards are appended after the findings (see withRecs in the
  // gateway). When a result also has a top-level data table, that table should
  // sit ABOVE the recommendations — the recs reference it. Only 'cards' sections
  // move below; intro sections (stats/heading/callout) stay above as authored.
  const hasRows = r.rows && r.rows.length > 0;
  const preRowSections = hasRows ? (r.sections || []).filter((s) => s.type !== 'cards') : (r.sections || []);
  const postRowSections = hasRows ? (r.sections || []).filter((s) => s.type === 'cards') : [];

  // Plain-English explainer: hand the result to the assistant ("what does this
  // mean + what do I do"). Reuses the dm:ask event the right-click menu fires.
  const explain = () => {
    const text = copyableOf(r).slice(0, 4000);
    const prompt = `I just ran the "${tool.name}" tool. In plain, simple English (explain any jargon), tell me: 1) what these results mean, 2) what's good and what's a problem, and 3) the top 3 things I should do next.\n\nHere are the results:\n${text}`;
    window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));
  };

  // Context handed to each recommendation card so the assistant answers in the
  // tool's frame ("from the X tool, for your site Y") and "Add to plan" links back.
  const recContext = { toolName: tool.name, domain: project?.domain, route: tool.route || `/tool/${tool.id}` };

  return (
    <div className="mt-6" data-tour="tool-result">
      <div className="dm-no-print mb-2 flex items-center gap-2">
        {r.source === 'live' && <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-300"><span className="inline-block h-1.5 w-1.5 rounded-full bg-green-600" aria-hidden /> Live data</span>}
        {typeof out.creditsUsed === 'number' && out.creditsUsed > 0 && (
          <span className="text-xs text-faint">used {out.creditsUsed} · {out.creditsRemaining} left</span>
        )}
        {hasContent && (
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={explain} title={`Discuss these results with Monty — ask follow-up questions (${CREDIT_COSTS.ai_chat ?? 2} credits per message)`}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
              <Sparkles size={13} aria-hidden /> Ask Monty
            </button>
            {/* One canonical CSV: prefer the top-level rows, else the first table
                section (previously both could render → two identical "CSV" buttons).
                Keyword Analysis owns its own CSV (inside KeywordAnalysisResult) so the
                export includes any live time-to-rank column — suppress this one there. */}
            {tool.id === 'keyword-analysis' && r.rows && r.rows.length > 0
              ? null
              : r.rows && r.rows.length > 0
              ? <ResultBtn onClick={() => downloadCsv(r.rows, `${tool.id}.csv`)}>CSV</ResultBtn>
              : sectionTable && <ResultBtn onClick={() => downloadCsv(sectionTable.rows, `${tool.id}.csv`)}>CSV</ResultBtn>}
            <ResultBtn onClick={() => copyText(copyableOf(r))}>Copy</ResultBtn>
            <ResultBtn onClick={() => window.print()}>Print</ResultBtn>
            <ShareResult tool={tool} out={out} project={project} user={user} />
          </div>
        )}
      </div>

      <div className="card p-5">
        <PrintHeader tool={tool} project={project} user={user} />
        {out.failed && (
          <div className="dm-no-print mb-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            This run didn’t complete — no credits were charged.
          </div>
        )}
        {out.teaser && (
          <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            {r.teaserMessage || 'Preview only — upgrade to see everything.'}
          </div>
        )}

        {out.runId && hasContent && !out.teaser && <TldrPanel tool={tool} r={r} runId={out.runId} />}

        {isSchema ? (
          <SchemaResult json={r.text} />
        ) : (
          <>
            {r.text && (VARIATION_RE.test(r.text)
              ? <CaptionCards text={r.text} />
              : <pre className="whitespace-pre-wrap text-sm text-body">{r.text}</pre>)}
            {r.preview && <pre className="whitespace-pre-wrap text-sm text-muted">{r.preview}</pre>}
            {preRowSections.length > 0 && <ResultSections sections={preRowSections} context={recContext} />}
            {r.html && <ReportHtml html={r.html} />}
          </>
        )}

        {hasRows && (tool.id === 'keyword-analysis'
          ? <KeywordAnalysisResult rows={r.rows} timeRank={r.timeRank} tool={tool} onCredits={onCredits} />
          : <ResultTable rows={r.rows} />)}
        {postRowSections.length > 0 && <ResultSections sections={postRowSections} context={recContext} />}

        {/* Summary-only teaser reveal ({ summary, detailsLocked }): surface the
            free-preview sample above the paywall. Previously `summary` matched no
            render branch, so the advertised "1 free preview" showed only the upsell. */}
        {r.summary != null && !hasContent && (
          typeof r.summary === 'string'
            ? <pre className="whitespace-pre-wrap text-sm text-body">{r.summary}</pre>
            : typeof r.summary === 'number'
            ? <p className="text-sm text-body">Score: <span className="font-semibold">{r.summary}</span></p>
            : null
        )}

        {r.blurredCount > 0 && (
          <div className="relative mt-1">
            <div className="blur-locked">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-8 border-t border-hair py-1.5 text-sm text-faint">
                  <span>locked keyword {i + 1}</span><span>4,200</span><span>34</span><span>S$2.40</span><span>Commercial</span>
                </div>
              ))}
            </div>
            <div className="absolute inset-0 grid place-items-center">
              <Link to="/pricing" className="btn-primary">{r.capMessage} →</Link>
            </div>
          </div>
        )}

        {r.detailsLocked && (
          <div className="text-center">
            <p className="text-sm text-muted">{r.teaserMessage}</p>
            <Link to="/pricing" className="btn-primary mt-3">Unlock full report</Link>
          </div>
        )}

        {/* Per-tool micro-feedback — a one-tap reaction anchored to a fresh result.
            Only for real, non-teaser runs (a saved runId to attach it to). */}
        {out.runId && hasContent && !out.teaser && <RunFeedback runId={out.runId} toolName={tool.name} />}
      </div>
    </div>
  );
}

// "Was this useful?" 👍/👎 with an optional one-line note. Posts to the run so the
// signal is anchored to exactly what was rated. A thumbs-down opens the note box
// (that's where the useful "why" lives); thumbs-up is a quiet one-tap. State is
// per-runId, so it resets for the next run and won't re-ask after a rating.
function RunFeedback({ runId, toolName }) {
  const [rating, setRating] = useState(null);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [sent, setSent] = useState(false);

  // Reset whenever a new run replaces this panel.
  useEffect(() => { setRating(null); setNote(''); setShowNote(false); setSent(false); }, [runId]);

  const send = (r, withNote = '') => {
    setRating(r);
    api.runFeedback(runId, r, withNote).catch(() => { /* best-effort — never block on feedback */ });
  };
  const pick = (r) => {
    if (sent) return;
    if (r === 'down') { setRating('down'); setShowNote(true); return; } // gather the "why" first
    send('up');
    setSent(true);
  };
  const submitNote = () => { send('down', note.trim()); setSent(true); setShowNote(false); };

  if (sent) {
    return (
      <div className="dm-no-print mt-5 border-t border-hair pt-3 text-sm text-muted">
        Thanks for the feedback — it helps us make {toolName} better.
      </div>
    );
  }

  return (
    <div className="dm-no-print mt-5 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-dim">Was this useful?</span>
        <button
          onClick={() => pick('up')}
          aria-pressed={rating === 'up'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${rating === 'up' ? 'border-green-300 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300' : 'border-line text-muted hover:border-green-300 hover:text-green-600 dark:hover:text-green-400'}`}
        >
          <ThumbsUp size={14} aria-hidden /> Yes
        </button>
        <button
          onClick={() => pick('down')}
          aria-pressed={rating === 'down'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${rating === 'down' ? 'border-amber-300 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-line text-muted hover:border-amber-300 hover:text-amber-600 dark:hover:text-amber-400'}`}
        >
          <ThumbsDown size={14} aria-hidden /> No
        </button>
      </div>
      {showNote && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={`fb-${runId}`} className="text-xs font-medium text-muted">What was missing or off? <span className="font-normal text-faint">(optional)</span></label>
            <input
              id={`fb-${runId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
              maxLength={500}
              autoFocus
              placeholder="e.g. the data looked out of date"
              className="mt-1 w-full rounded-lg border border-edge px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <button onClick={submitNote} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Send</button>
        </div>
      )}
    </div>
  );
}

function ResultBtn({ children, onClick }) {
  return <button onClick={onClick} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400">{children}</button>;
}

// Sortable table with per-column formatting + badges.
function ResultTable({ rows }) {
  const columns = Object.keys(rows[0] || {}).map((c) => ({
    key: c,
    // Split camelCase boundaries so "timeToRank" reads "time To Rank" (→ header
    // "TIME TO RANK"); leaves already-cased keys ("CPC", "url", "keyword") intact.
    label: c.replace(/([a-z])([A-Z])/g, '$1 $2'),
    render: (row) => cell(c, row[c]),
  }));
  const n = rows.length;
  return (
    <div>
      <div className="mb-1.5 flex justify-end">
        <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">
          {n.toLocaleString()} {n === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <SortableTable columns={columns} rows={rows} filterable={rows.length > 8} />
    </div>
  );
}

// Run async `fn` over `items` with at most `size` in flight — powers the
// keyword-by-keyword time-to-rank fan-out so results stream in as each finishes.
async function pool(items, size, fn) {
  const q = items.map((it, i) => [it, i]);
  const worker = async () => { while (q.length) { const [it, i] = q.shift(); await fn(it, i); } };
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, worker));
}

// Keyword Analysis results: the base keyword table plus an opt-in, per-keyword
// "time to rank" step. The user ticks keywords and hits Calculate; each keyword
// is estimated via its own (billed) sub-call, and the column fills in live —
// no waiting for the whole set. Only offered when the run carries a domain to
// estimate against (always in the domain/URL modes; the optional field otherwise).
function KeywordAnalysisResult({ rows: initialRows, timeRank, tool, onCredits }) {
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState(() => new Set());
  const [pending, setPending] = useState(() => new Set());
  const [running, setRunning] = useState(false);
  const domain = (timeRank?.domain || '').trim();

  // A fresh run (new rows object) resets selection + any computed estimates.
  useEffect(() => { setRows(initialRows); setSelected(new Set()); setPending(new Set()); }, [initialRows]);

  const toggle = (kw) => setSelected((s) => { const n = new Set(s); n.has(kw) ? n.delete(kw) : n.add(kw); return n; });
  const uncomputed = (kw) => { const r = rows.find((x) => x.keyword === kw); return r && r.timeToRank == null; };
  const selectableKws = rows.filter((r) => r.timeToRank == null).map((r) => r.keyword);
  const allSel = selectableKws.length > 0 && selectableKws.every((k) => selected.has(k));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(selectableKws));
  const todo = [...selected].filter(uncomputed);

  const baseKeys = Object.keys(rows[0] || {}).filter((k) => k !== 'timeToRank');
  const columns = [
    domain && {
      key: '_sel', label: '', sortable: false,
      render: (row) => row.timeToRank != null
        ? <span className="text-slate-300" aria-hidden>✓</span>
        : <input type="checkbox" checked={selected.has(row.keyword)} onChange={() => toggle(row.keyword)}
            className="h-4 w-4 cursor-pointer rounded border-edge text-brand-600 dark:text-brand-400 focus:ring-brand-500" aria-label={`Select ${row.keyword}`} />,
    },
    ...baseKeys.map((c) => ({ key: c, label: c.replace(/([a-z])([A-Z])/g, '$1 $2'), render: (row) => cell(c, row[c]) })),
    domain && {
      key: 'timeToRank', label: 'Time to rank',
      render: (row) => pending.has(row.keyword)
        ? <span className="inline-flex items-center gap-1 text-faint"><span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-brand-500" aria-hidden /> estimating…</span>
        : row.timeToRank != null ? cell('timeToRank', row.timeToRank) : <span className="text-slate-300">—</span>,
    },
  ].filter(Boolean);

  async function calculate() {
    if (!todo.length || running) return;
    setRunning(true);
    setPending(new Set(todo));
    let used = 0, denied = false;
    await pool(todo, 4, async (kw) => {
      const src = rows.find((r) => r.keyword === kw) || {};
      try {
        const res = await api.runTool(tool.id, {
          timeRankOne: kw, domain, location: timeRank.location, language: timeRank.language,
          timeRankDifficulty: src.difficulty,
        }, true);
        const ttr = res.result?.timeToRank ?? 'N/A';
        setRows((rs) => rs.map((r) => r.keyword === kw ? { ...r, timeToRank: ttr } : r));
        if (typeof res.creditsRemaining === 'number') onCredits(res.creditsRemaining, res.topupRemaining);
        used += res.creditsUsed || 0;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 402 || e.status === 403)) denied = true;
        setRows((rs) => rs.map((r) => r.keyword === kw ? { ...r, timeToRank: 'N/A' } : r));
      } finally {
        setPending((p) => { const n = new Set(p); n.delete(kw); return n; });
      }
    });
    setSelected(new Set());
    setRunning(false);
    if (used) toast(`−${used} credit${used > 1 ? 's' : ''} · time to rank for ${todo.length} keyword${todo.length > 1 ? 's' : ''}`, 'info');
    if (denied) toast('Ran out of credits before finishing — the rest weren’t estimated.', 'error');
  }

  const n = rows.length;
  return (
    <div>
      {domain && (
        <div className="dm-no-print mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button type="button" onClick={toggleAll} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
            {allSel ? 'Clear selection' : 'Select all'}
          </button>
          <button type="button" onClick={calculate} disabled={running || todo.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40">
            {running ? 'Calculating…' : `Calculate time to rank${todo.length ? ` (${todo.length})` : ''}`}
          </button>
          {todo.length > 0 && <span className="text-xs text-faint">costs {todo.length} credit{todo.length > 1 ? 's' : ''} · estimated against {domain}</span>}
        </div>
      )}
      <div className="mb-1.5 flex justify-end">
        <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">{n.toLocaleString()} {n === 1 ? 'row' : 'rows'}</span>
      </div>
      <SortableTable columns={columns} rows={rows} rowKey={(r) => r.keyword} filterable={rows.length > 8} exportName={tool.id} />
    </div>
  );
}

const TONE = { red: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', amber: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', green: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300', blue: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300', slate: 'bg-sunken text-dim' };
function Badge({ t, tone }) { return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone] || TONE.slate}`}>{t}</span>; }

// Toggle-chip multi-select; value is a comma-joined string (backend splits it).
// When field.compatibility === 'ga4-metrics', options unsupported for the chosen
// breakdown dimension are fetched from GA4 and disabled (can't be selected).
function MultiSelect({ field, options, value, onChange, values }) {
  const sel = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const [allowed, setAllowed] = useState(null); // null = allow all (unknown)
  const dim = values?.dimension;
  const compat = field?.compatibility === 'ga4-metrics';

  // Refetch the compatible set whenever the breakdown dimension changes.
  useEffect(() => {
    if (!compat) return;
    let cancelled = false;
    setAllowed(null);
    api.ga4Compatibility(dim)
      .then((d) => { if (!cancelled) setAllowed(Array.isArray(d.metrics) ? d.metrics.map((m) => m.toLowerCase()) : null); })
      .catch(() => { if (!cancelled) setAllowed(null); });
    return () => { cancelled = true; };
  }, [compat, dim]);

  const isAllowed = (o) => !allowed || allowed.includes(o.toLowerCase());
  // Drop any selected option that's no longer compatible after a dimension change.
  useEffect(() => {
    if (!allowed) return;
    const pruned = sel.filter(isAllowed);
    if (pruned.length !== sel.length) onChange(pruned.join(','));
    // eslint-disable-next-line
  }, [allowed]);

  const toggle = (o) => onChange((sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o]).join(','));
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = sel.includes(o);
        const disabled = !isAllowed(o);
        return (
          <button type="button" key={o} disabled={disabled} onClick={() => toggle(o)}
            title={disabled ? 'Not available for the selected breakdown dimension' : undefined}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${disabled ? 'cursor-not-allowed border-line bg-raised text-slate-300 line-through' : on ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-edge text-dim hover:border-brand-300 dark:hover:border-brand-500/40'}`}>
            {o}
          </button>
        );
      })}
      {compat && allowed && <span className="w-full text-xs text-faint">Greyed-out metrics aren’t supported with the “{dim}” breakdown.</span>}
    </div>
  );
}

// Caption Generator returns "━━━ Variation N ━━━\n<caption>" blocks as plain
// text. Render each as its own copyable card instead of one monospace blob.
const VARIATION_RE = /[━─-]{2,}\s*Variation\s*\d+\s*[━─-]{2,}/i;
function CaptionCards({ text }) {
  const parts = String(text).split(/[━─-]{2,}\s*Variation\s*(\d+)\s*[━─-]{2,}/i);
  const cards = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = (parts[i + 1] || '').trim();
    if (body) cards.push({ n: parts[i], body });
  }
  if (!cards.length) return <pre className="whitespace-pre-wrap text-sm text-body">{text}</pre>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((c, i) => (
        <div key={i} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden /> Variation {c.n}
            </span>
            <button
              onClick={() => copyText(c.body).then(() => toast('Caption copied', 'success'))}
              className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-muted hover:bg-raised hover:text-body"
            >
              Copy
            </button>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-body">{c.body}</p>
        </div>
      ))}
    </div>
  );
}

// Time-to-rank buckets → a fast(green)→slow(red) scale so the column is scannable
// at a glance. Anything unrecognised (e.g. "N/A") stays neutral.
function timeToRankClass(s) {
  const t = String(s).toLowerCase();
  if (t.startsWith('0-3')) return 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300';
  if (t.startsWith('3-6')) return 'bg-lime-100 dark:bg-lime-500/15 text-lime-700 dark:text-lime-300';
  if (t.startsWith('6-9')) return 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (t.startsWith('9-12')) return 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300';
  if (t.includes('more than 12')) return 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300';
  return 'bg-sunken text-muted';
}

function cell(col, val) {
  const c = col.toLowerCase();
  const s = String(val ?? '');
  if (!s || s === '—') return <span className="text-faint">—</span>;
  if (c === 'timetorank') return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${timeToRankClass(s)}`}>{s}</span>;
  if (c === 'priority') return <Badge t={s} tone={{ critical: 'red', high: 'amber', medium: 'blue', keep: 'slate' }[s.toLowerCase()]} />;
  if (c === 'severity') return <Badge t={s} tone={{ critical: 'red', high: 'red', medium: 'amber', low: 'green' }[s.toLowerCase()]} />;
  if (c === 'suitability') return <Badge t={s} tone={{ high: 'green', medium: 'amber', low: 'slate' }[s.toLowerCase()]} />;
  if (c === 'intent' || c === 'status' || c === 'type') return <Badge t={s} tone="slate" />;
  if (c === 'difficulty') { const n = parseFloat(s); if (Number.isFinite(n)) return <span className={n < 30 ? 'font-medium text-green-600 dark:text-green-400' : n < 60 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-red-600 dark:text-red-400'}>{n}</span>; }
  if (['volume', 'impressions', 'clicks', 'sessions', 'users', 'backlinks', 'traffic', 'conversions'].includes(c)) return <span className="tabular-nums">{fmtNum(s)}</span>;
  if (c === 'url' && /^https?:\/\//i.test(s)) return <a href={s} target="_blank" rel="noreferrer" className="break-all text-brand-600 dark:text-brand-400 hover:underline">{s.replace(/^https?:\/\//i, '')}</a>;
  return s;
}

// Results-level controls for integration tools — re-pivot (range / breakdown)
// without scrolling back to the form. Mirrors index.html's dashboard selectors.
function RepivotBar({ fields, values, busy, onChange }) {
  if (!fields.length) return null;
  return (
    <div className="dm-no-print mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">View</span>
      {fields.map((f) => (
        <label key={f.name} className="flex items-center gap-1.5 text-sm text-dim">
          <span className="text-xs text-muted">{f.label}</span>
          <select
            value={values[f.name]}
            disabled={busy}
            onChange={(e) => onChange(f.name, e.target.value)}
            className="dm-select rounded-lg border border-edge bg-surface py-1 pl-2 pr-7 text-sm transition focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10 disabled:opacity-50"
          >
            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ))}
      {busy && <span className="flex items-center gap-1.5 text-xs text-faint"><span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />updating…</span>}
    </div>
  );
}

// ── Form fields ───────────────────────────────────────────────────────────────
function TagInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const [bulk, setBulk] = useState(false);
  const tags = String(value || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const merge = (raw) => {
    const add = String(raw).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    if (add.length) onChange([...tags, ...add.filter((a) => !tags.includes(a))].join(', '));
    setDraft('');
  };
  const remove = (t) => onChange(tags.filter((x) => x !== t).join(', '));

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-edge p-2 transition focus-within:border-brand-600 focus-within:ring-4 focus-within:ring-brand-600/10">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand-50 dark:bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300">
            {t}
            <button type="button" onClick={() => remove(t)} className="text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">×</button>
          </span>
        ))}
        {!bulk && (
          <input
            value={draft}
            placeholder={tags.length ? '' : placeholder || 'Type a keyword and press Enter'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); merge(draft); }
              else if (e.key === 'Backspace' && !draft && tags.length) remove(tags[tags.length - 1]);
            }}
            onBlur={() => draft && merge(draft)}
            onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\n,]/.test(t)) { e.preventDefault(); merge(t); } }}
            className="min-w-[140px] flex-1 bg-transparent text-sm outline-none"
          />
        )}
      </div>

      {bulk && (
        <div className="mt-2">
          <textarea autoFocus rows={5} value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder={'Paste or type one keyword per line…\nrunning shoes\ntrail shoes\nmarathon gear'}
            className="field" />
          <div className="mt-1.5 flex gap-2">
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => { merge(draft); setBulk(false); }}>Add keywords</button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setDraft(''); setBulk(false); }}>Cancel</button>
          </div>
        </div>
      )}

      <button type="button" onClick={() => { setDraft(''); setBulk((b) => !b); }} className="mt-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
        {bulk ? '← Back to quick add' : '+ Paste a list (one keyword per line)'}
      </button>
    </div>
  );
}

// Searchable account picker for the Google integration tools — lists the
// connected user's accessible properties/accounts (type to filter by name/ID),
// defaulting to their saved selection. Mirrors index.html's account dropdown.
// Falls back to a plain text box when nothing is connected.
function AccountField({ provider, value, onChange, placeholder }) {
  const [accounts, setAccounts] = useState(null); // null = loading, [] = none
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!provider) { setAccounts([]); return; }
    let alive = true;
    Promise.all([
      api.integrationAccounts(provider).then((d) => d.accounts || []).catch(() => []),
      api.integrations().then((d) => d.connected?.[provider]?.account || '').catch(() => ''),
    ]).then(([list, def]) => {
      if (!alive) return;
      setAccounts(list);
      if (!value && (def || list[0])) onChange(def || list[0].id); // seed a sensible default
    });
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [provider]);

  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Nothing connected → let them type an ID/URL and point them to Integrations.
  if (accounts !== null && accounts.length === 0) {
    return (
      <>
        <input className="field mt-1.5" value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        <span className="mt-1 block text-xs text-faint">
          No connected accounts — <Link to="/integrations" className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">connect your account</Link> or type an ID manually.
        </span>
      </>
    );
  }

  const selected = (accounts || []).find((a) => a.id === value);
  const label = selected ? selected.label : value || '';
  const s = q.trim().toLowerCase();
  const filtered = (accounts || []).filter((a) => !s || a.label.toLowerCase().includes(s) || String(a.id).toLowerCase().includes(s));

  return (
    <div className="relative mt-1.5" ref={boxRef}>
      <button type="button" onClick={() => { setOpen((o) => !o); setQ(''); }} className="field flex w-full items-center justify-between text-left">
        <span className={`truncate ${label ? '' : 'text-faint'}`}>{accounts === null ? 'Loading accounts…' : (label || 'Select an account…')}</span>
        <span className="ml-2 shrink-0 text-faint">▾</span>
      </button>
      {open && accounts && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <div className="border-b border-hair p-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ID…"
              className="w-full rounded-md border border-line px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10" />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {filtered.length ? filtered.map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id); setOpen(false); }}
                className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-raised ${a.id === value ? 'font-semibold text-brand-700 dark:text-brand-300' : 'text-body'}`}>
                {a.label}
              </button>
            )) : <div className="px-3 py-2 text-sm text-faint">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// A <select> replacement with a type-to-filter search box, for long option
// lists (locations, languages, schema types). Keyboard: ↑/↓ to move, Enter to
// pick, Esc to close. Falls back to the same look as native `.field` selects.
function SearchableSelect({ options, value, onChange, autoFocus }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  // Accept plain strings or {value,label} pairs (labels searched, values stored).
  const norm = useMemo(() => options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o)), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? norm.filter((o) => o.label.toLowerCase().includes(q)) : norm;
  }, [norm, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // When opening, focus the search box and reset to the current selection.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const i = norm.findIndex((o) => o.value === value);
    setActive(i >= 0 ? i : 0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, norm, value]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (opt) => { onChange(opt.value); setOpen(false); };
  const selectedLabel = norm.find((o) => o.value === value)?.label || value;

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[active]) pick(filtered[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  return (
    <div ref={rootRef} className="relative mt-1.5">
      <button
        type="button" autoFocus={autoFocus}
        onClick={() => setOpen((o) => !o)}
        className="field dm-select flex w-full items-center pr-9 text-left"
      >
        <span className="truncate">{selectedLabel || 'Select…'}</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lift">
          <div className="border-b border-hair p-1.5">
            <input
              ref={searchRef} type="text" value={query}
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              placeholder="Search…"
              className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/10"
            />
          </div>
          <ul ref={listRef} className="max-h-60 overflow-y-auto py-1" role="listbox">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-faint">No matches</li>
            ) : filtered.map((opt, i) => (
              <li key={opt.value}>
                <button
                  type="button" data-active={i === active}
                  onMouseEnter={() => setActive(i)} onClick={() => pick(opt)}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
                    i === active ? 'bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-body'
                  }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {opt.value === value && <span className="text-brand-600 dark:text-brand-400">✓</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Visible mode picker: selectable cards so every option is discoverable up
// front (vs. a collapsed <select> that hides all but the default).
function Segmented({ options, optionDesc = {}, value, onChange }) {
  return (
    <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o)}
            className={`rounded-lg border p-3 text-left transition ${on ? 'border-brand-600 bg-brand-50 dark:bg-brand-500/10 ring-4 ring-brand-600/10' : 'border-line bg-surface hover:border-brand-300 dark:hover:border-brand-500/40'}`}
          >
            <span className={`block text-sm font-semibold ${on ? 'text-brand-700 dark:text-brand-300' : 'text-body'}`}>{o}</span>
            {optionDesc[o] && <span className="mt-0.5 block text-xs text-muted">{optionDesc[o]}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Field({ field, value, onChange, autoFocus, provider, values, invalid }) {
  const base = `field mt-1.5${invalid ? ' !border-amber-400 !ring-4 !ring-amber-400/20' : ''}`;
  // Plain-English help on the label itself: an explicit `help` string from the
  // catalog wins, else fall back to the glossary (same matching as result tips).
  const tip = field.help || glossaryFor(field.label);
  return (
    <label className={`block ${invalid ? '-ml-3 rounded-lg border-l-2 border-amber-400 bg-amber-50/50 dark:bg-amber-500/10 pl-3' : ''}`} data-tour-field={field.name}>
      <span className="text-sm font-medium text-body">
        {field.label}{field.required && <span className={invalid ? 'font-bold text-amber-600 dark:text-amber-400' : 'text-amber-500'}> *</span>}
        {tip && <InfoTip text={tip} className="ml-1" />}
      </span>
      {field.type === 'account' ? (
        <AccountField provider={provider} value={value} onChange={onChange} placeholder={field.placeholder} />
      ) : field.type === 'tags' ? (
        <>
          <TagInput value={value} onChange={onChange} placeholder={field.placeholder} />
          <span className="mt-1 block text-xs text-faint">Add several — press Enter or comma between keywords.</span>
        </>
      ) : field.type === 'date' ? (
        <input autoFocus={autoFocus} type="date" value={value || ''} max={field.max || '9999-12-31'} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'multiselect' ? (
        <MultiSelect field={field} options={field.options} value={value} onChange={onChange} values={values} />
      ) : field.type === 'segmented' ? (
        <Segmented options={field.options} optionDesc={field.optionDesc} value={value} onChange={onChange} />
      ) : field.type === 'textarea' ? (
        <textarea autoFocus={autoFocus} rows={3} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'select' ? (
        field.options.length > 12 ? (
          <SearchableSelect options={field.options} value={value} onChange={onChange} autoFocus={autoFocus} />
        ) : (
          <select autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} className={`${base} dm-select pr-9`}>
            {field.options.map((o) => {
              // Options are plain strings, or {value,label} where the stored
              // value is a code the user shouldn't have to know (country codes).
              const v = typeof o === 'string' ? o : o.value;
              const l = typeof o === 'string' ? o : o.label;
              return <option key={v} value={v}>{l}</option>;
            })}
          </select>
        )
      ) : (
        <input autoFocus={autoFocus} type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'url' ? 'url' : undefined}
          value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      )}
      {invalid && <span className="mt-1 block text-xs font-semibold text-amber-600 dark:text-amber-400">Please fill this in to continue.</span>}
      {field.hint && <span className="mt-1 block whitespace-pre-line text-xs text-faint">{field.hint}</span>}
    </label>
  );
}
