import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AUDIT_TOOLS, toolById, tierMeets, CREDIT_COSTS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api, ApiError } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { Check, Loader2, AlertTriangle, ChevronRight } from 'lucide-react';

const RUN_URL = import.meta.env.VITE_RUN_URL || '';

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

const SCORE_TONE = (n) => (n >= 80 ? { ring: '#16a34a', text: 'text-green-600', label: 'Healthy' }
  : n >= 50 ? { ring: '#f59e0b', text: 'text-amber-600', label: 'Needs work' }
  : { ring: '#dc2626', text: 'text-red-600', label: 'Needs attention' });

export default function SiteAudit() {
  const { user, setCredits } = useAuth();
  const { active } = useProjects();
  const [url, setUrl] = useState(active?.domain ? (/^https?:\/\//.test(active.domain) ? active.domain : `https://${active.domain.replace(/^https?:\/\//, '')}`) : '');
  const [steps, setSteps] = useState(null); // [{id,label,status}]
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);

  // Which audit tools this tier can actually run; others are skipped.
  const runnable = AUDIT_TOOLS.filter((a) => { const t = toolById(a.id); return t && tierMeets(user.tier, t.minTier); });
  const cost = runnable.reduce((sum, a) => sum + (CREDIT_COSTS[toolById(a.id)?.cost] ?? 0), 0) + (CREDIT_COSTS.ai_short ?? 1);
  const locked = runnable.length === 0;

  async function run() {
    const site = url.trim();
    if (!site) { toast('Enter your website URL first.', 'error'); return; }
    if (!window.confirm(`This runs ${runnable.length} checks on ${site} and builds one report — about ${cost} credits. Continue?`)) return;

    setReport(null);
    setRunning(true);
    const init = runnable.map((a) => ({ id: a.id, label: a.label, name: toolById(a.id)?.name, status: 'running' }));
    setSteps(init);
    const setStatus = (id, status) => setSteps((s) => s.map((x) => (x.id === id ? { ...x, status } : x)));

    // Run the checks in parallel; each charges its own credits + may be slow.
    const results = await Promise.all(runnable.map(async (a) => {
      const t = toolById(a.id);
      try {
        const resp = await api.runTool(a.id, a.input(site), !!t.slow && !!RUN_URL);
        if (typeof resp.creditsRemaining === 'number') setCredits(resp.creditsRemaining);
        const r = resp.result || {};
        if (r.error || r.needsConnect) { setStatus(a.id, 'fail'); return null; }
        setStatus(a.id, 'done');
        return { tool: a.id, name: t.name, text: summarize(r) };
      } catch { setStatus(a.id, 'fail'); return null; }
    }));

    const good = results.filter(Boolean);
    if (!good.length) { toast('All checks failed — please try again.', 'error'); setRunning(false); return; }

    try {
      const { report, creditsRemaining } = await api.auditSynthesize(site, good);
      if (typeof creditsRemaining === 'number') setCredits(creditsRemaining);
      setReport(report);
    } catch (e) {
      toast(e instanceof ApiError && e.status === 402 ? 'Out of credits for the summary — top up to finish.' : (e.message || 'Could not build the report.'), 'error');
    } finally {
      setRunning(false);
    }
  }

  if (locked) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Site Health Check</h1>
        <div className="card mt-6 p-6 text-center">
          <p className="text-slate-600">A one-click audit of your site’s SEO, page quality and AI-readiness — with a score and prioritised fixes.</p>
          <Link to="/pricing" className="btn-primary mt-4 inline-block">Upgrade to run a health check</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Site Health Check</h1>
      <p className="mt-1 text-slate-600">One click runs {runnable.length} checks and gives you a single score with the top things to fix — in plain English.</p>

      <div className="card mt-6 p-5">
        <label className="block text-sm font-medium text-slate-700">Your website</label>
        <div className="mt-1.5 flex flex-wrap gap-3">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yoursite.com" disabled={running}
            className="field flex-1" />
          <button onClick={run} disabled={running} className="btn-primary">
            {running ? 'Running…' : `Run health check · ${cost} cr`}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-400">Runs: {runnable.map((a) => a.label).join(' · ')}. Takes ~1–3 minutes.</p>
      </div>

      {/* Live progress */}
      {steps && (
        <div className="card mt-4 p-5">
          <ul className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-3 text-sm">
                {s.status === 'running' && <Loader2 size={16} className="animate-spin text-brand-500" aria-hidden />}
                {s.status === 'done' && <span className="grid h-4 w-4 place-items-center rounded-full bg-green-500 text-white"><Check size={11} aria-hidden /></span>}
                {s.status === 'fail' && <AlertTriangle size={16} className="text-amber-500" aria-hidden />}
                <span className={s.status === 'fail' ? 'text-slate-400' : 'text-slate-700'}>{s.label} <span className="text-slate-400">· {s.name}</span></span>
                <span className="ml-auto text-xs text-slate-400">{s.status === 'running' ? 'checking…' : s.status === 'done' ? 'done' : 'skipped'}</span>
              </li>
            ))}
          </ul>
          {running && !report && <p className="mt-3 text-xs text-slate-400">Building your report…</p>}
        </div>
      )}

      {report && <Report report={report} />}
    </div>
  );
}

function Report({ report }) {
  const score = Math.max(0, Math.min(100, Math.round(Number(report.score) || 0)));
  const tone = SCORE_TONE(score);
  const C = 2 * Math.PI * 52;
  const off = C * (1 - score / 100);
  const pri = { high: 'bg-red-100 text-red-700', medium: 'bg-amber-100 text-amber-700', low: 'bg-slate-100 text-slate-500' };
  const dot = { good: 'bg-green-500', fair: 'bg-amber-500', poor: 'bg-red-500' };

  return (
    <div className="mt-6 space-y-4">
      {/* Score + summary */}
      <div className="card flex flex-col items-center gap-5 p-6 sm:flex-row">
        <svg width="130" height="130" viewBox="0 0 130 130" className="shrink-0" role="img" aria-label={`Health score ${score} out of 100`}>
          <circle cx="65" cy="65" r="52" fill="none" stroke="#e2e8f0" strokeWidth="12" />
          <circle cx="65" cy="65" r="52" fill="none" stroke={tone.ring} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 65 65)" />
          <text x="65" y="62" textAnchor="middle" fill="#0f172a" style={{ fontSize: 30, fontWeight: 800 }}>{score}</text>
          <text x="65" y="84" textAnchor="middle" fill="#94a3b8" style={{ fontSize: 12, fontWeight: 600 }}>/ 100</text>
        </svg>
        <div className="text-center sm:text-left">
          <div className={`text-sm font-bold uppercase tracking-wide ${tone.text}`}>{report.grade ? `Grade ${report.grade} · ` : ''}{tone.label}</div>
          <p className="mt-1 text-slate-700">{report.summary}</p>
        </div>
      </div>

      {/* Area breakdown */}
      {Array.isArray(report.areas) && report.areas.length > 0 && (
        <div className="card p-5">
          <h2 className="font-bold">How each area scored</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {report.areas.map((a, i) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dot[a.status] || 'bg-slate-400'}`} aria-hidden />
                  <span className="text-sm font-semibold text-slate-800">{a.name}</span>
                  {typeof a.score !== 'undefined' && <span className="ml-auto text-sm font-bold text-slate-500">{a.score}</span>}
                </div>
                {a.note && <p className="mt-1 text-xs text-slate-500">{a.note}</p>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Prioritised fixes */}
      {Array.isArray(report.fixes) && report.fixes.length > 0 && (
        <div className="card p-5">
          <h2 className="font-bold">Do these next</h2>
          <ol className="mt-3 space-y-2.5">
            {report.fixes.map((f, i) => (
              <li key={i} className="flex items-start gap-3 rounded-lg border border-slate-100 p-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-500">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{f.title}</span>
                    {f.priority && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${pri[f.priority] || pri.low}`}>{f.priority}</span>}
                  </div>
                  {f.why && <p className="mt-0.5 text-sm text-slate-500">{f.why}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="flex items-center gap-1 text-xs text-slate-400">
        <ChevronRight size={12} aria-hidden /> Want the full detail behind a fix? Open the matching tool from the dashboard.
      </p>
    </div>
  );
}
