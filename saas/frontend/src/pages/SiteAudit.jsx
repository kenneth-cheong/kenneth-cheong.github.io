import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { AUDIT_TOOLS, toolById, tierMeets, tierRank, PLANS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import NextSteps from '../components/NextSteps.jsx';
import * as auditRun from '../lib/siteAuditRun.js';
import { startSiteAuditTour, SITE_AUDIT_SAMPLE, hasSeen, markSeen } from '../lib/tours.js';
import { Check, Loader2, AlertTriangle, ChevronRight, Compass } from 'lucide-react';

const SHARE_TOOL = { id: 'site-audit', name: 'Site Health Check' };
const SHARE_BTN = 'btn-ghost inline-flex items-center gap-1 text-sm';

// Distil the audit report into a branded share card (score gauge + supports).
function auditShareOut(report) {
  if (!report) return null;
  const score = Math.max(0, Math.min(100, Math.round(Number(report.score) || 0)));
  const tone = score >= 80 ? 'green' : score >= 50 ? 'amber' : 'red';
  const items = [{ label: 'Health score', value: `${score}%`, tone }];
  if (report.grade) items.push({ label: 'Grade', value: String(report.grade) });
  if (Array.isArray(report.fixes) && report.fixes.length) items.push({ label: 'Fixes to do', value: String(report.fixes.length) });
  if (Array.isArray(report.areas) && report.areas.length) items.push({ label: 'Areas checked', value: String(report.areas.length) });
  return { result: { sections: [{ type: 'stats', items }] } };
}

const SCORE_TONE = (n) => (n >= 80 ? { ring: '#16a34a', text: 'text-green-600 dark:text-green-400', label: 'Healthy' }
  : n >= 50 ? { ring: '#f59e0b', text: 'text-amber-600 dark:text-amber-400', label: 'Needs work' }
  : { ring: '#dc2626', text: 'text-red-600 dark:text-red-400', label: 'Needs attention' });

export default function SiteAudit() {
  const { user, setCredits } = useAuth();
  const { active } = useProjects();
  // The run lives outside this component so navigating away mid-check doesn't
  // discard it — see lib/siteAuditRun.js. Re-mounting re-attaches to it.
  const { url, steps, report, running } = useSyncExternalStore(auditRun.subscribe, auditRun.getSnapshot);
  const [nudge, setNudge] = useState(false); // highlight the empty URL field after an incomplete run attempt
  const reportRef = useRef(null); // the subtree the PDF export prints

  const projectUrl = () => (active?.domain ? (/^https?:\/\//.test(active.domain) ? active.domain : `https://${active.domain.replace(/^https?:\/\//, '')}`) : '');

  // Prefill the site from the active project once it loads (it may arrive after
  // mount). Never clobber a URL the user typed or one a run is already using.
  useEffect(() => {
    if (!url && !running && !report && active?.domain) auditRun.setUrl(projectUrl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, url, running, report]);

  // Which audit tools this tier can actually run; others are skipped.
  const runnable = AUDIT_TOOLS.filter((a) => { const t = toolById(a.id); return t && tierMeets(user.tier, t.minTier); });

  // Guided tour: render the finished asana.com example through the real report
  // components, then clear it (and restore the form) on any exit.
  function launchTour() {
    startSiteAuditTour({ checks: runnable.length }, {
      preview: () => auditRun.preview({
        url: SITE_AUDIT_SAMPLE.url,
        steps: runnable.map((a) => ({ id: a.id, label: a.label, name: toolById(a.id)?.name, status: 'done' })),
        report: SITE_AUDIT_SAMPLE.report,
      }),
      clear: () => auditRun.clear(projectUrl()),
    });
  }

  // First visit → auto-run the guided tour once (skipped while the page is locked).
  const canTour = runnable.length > 0;
  useEffect(() => {
    if (!canTour || running || hasSeen('tool:site-audit')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:site-audit')) return;
      markSeen('tool:site-audit');
      launchTour();
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canTour]);
  const locked = runnable.length === 0;
  // Lowest plan that unlocks any of the audit checks — what the user must reach.
  const neededTier = AUDIT_TOOLS
    .map((a) => toolById(a.id)?.minTier)
    .filter(Boolean)
    .sort((x, y) => tierRank(x) - tierRank(y))[0];
  const neededPlan = PLANS[neededTier]?.name || 'a paid';
  const currentPlan = PLANS[user.tier]?.name || user.tier;

  function run() {
    const site = url.trim();
    if (!site) { setNudge(true); document.getElementById('audit-url')?.focus(); return; }
    // Deliberately not awaited: the run belongs to the store, not to this
    // component, so it keeps going if the user navigates away mid-check.
    auditRun.start({ site, runnable, onCredits: setCredits });
  }

  if (locked) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Site Health Check</h1>
        <div className="card mt-6 p-6 text-center">
          <p className="font-medium text-strong">The Site Health Check isn’t included in your {currentPlan} plan.</p>
          <p className="mt-2 text-dim">It’s a one-click audit of your site’s SEO, page quality and AI-readiness — with a score and prioritised fixes. Upgrade to {neededPlan} or higher to run it.</p>
          <Link to="/pricing" className="btn-primary mt-4 inline-block">Upgrade to {neededPlan}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Site Health Check</h1>
        <button
          type="button"
          onClick={launchTour}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
          title="Guided walkthrough with a real example"
        >
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-dim">One click runs {runnable.length} checks and gives you a single score with the top things to fix — in plain English.</p>

      <div className="card mt-6 p-5" data-tour="sha-url">
        <label htmlFor="audit-url" className="block text-sm font-medium text-body">
          Your website<span className="text-amber-500"> *</span>
        </label>
        <div className="mt-1.5 flex flex-wrap gap-3">
          <input id="audit-url" value={url} onChange={(e) => { setNudge(false); auditRun.setUrl(e.target.value); }} placeholder="https://yoursite.com" disabled={running}
            className={`field flex-1${nudge ? ' !border-amber-400 !ring-4 !ring-amber-400/20' : ''}`} />
          <button onClick={run} disabled={running} aria-disabled={running || !url.trim()} data-tour="sha-run" className={`btn-primary ${url.trim() ? '' : 'opacity-60'}`}>
            {running ? 'Running…' : 'Run health check'}
          </button>
        </div>
        {nudge
          ? <p className="mt-2 text-xs font-semibold text-amber-600 dark:text-amber-400">Enter your website URL first to run the check.</p>
          : <p className="mt-2 text-xs text-faint">Runs: {runnable.map((a) => a.label).join(' · ')}. Takes ~1–3 minutes.</p>}
      </div>

      {/* Live progress */}
      {steps && (
        <div className="card mt-4 p-5" data-tour="sha-steps">
          <ul className="space-y-2.5">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-3 text-sm">
                {s.status === 'running' && <Loader2 size={16} className="animate-spin text-brand-500" aria-hidden />}
                {s.status === 'done' && <span className="grid h-4 w-4 place-items-center rounded-full bg-green-500 text-white"><Check size={11} aria-hidden /></span>}
                {s.status === 'fail' && <AlertTriangle size={16} className="text-amber-500" aria-hidden />}
                <span className={s.status === 'fail' ? 'text-faint' : 'text-body'}>{s.label} <span className="text-faint">· {s.name}</span></span>
                <span className="ml-auto text-xs text-faint">{s.status === 'running' ? 'checking…' : s.status === 'done' ? 'done' : 'skipped'}</span>
              </li>
            ))}
          </ul>
          {running && !report && (
            <p className="mt-3 text-xs text-faint">
              Building your report…{' '}
              {/* Said out loud because it has always been true and never looked
                  it: the run lives outside this page (lib/siteAuditRun.js), so
                  navigating away keeps it going. Without this line the only
                  safe-looking option is to sit and watch for three minutes. */}
              <span className="text-muted">Carry on using the platform if you like — this keeps running, and the report will be here when you come back.</span>
            </p>
          )}
        </div>
      )}

      {report && (
        <div ref={reportRef} data-tour="sha-report">
          <div className="dm-no-print mt-6 -mb-2 flex justify-end gap-2">
            <PdfButton targetRef={reportRef} className={SHARE_BTN} />
            <ShareResult tool={SHARE_TOOL} out={auditShareOut(report)} project={active} user={user} force snapshot label="Share result" className={SHARE_BTN} />
          </div>
          <PrintBrand title="Site Audit" project={active} user={user} />
          <Report report={report} />
        </div>
      )}
      {/* Outside `reportRef` on purpose — the PDF is the report, not the app
          chrome around it. (`dm-no-print` covers the browser print path too.) */}
      {report && (
        <NextSteps
          toolId="site-audit"
          tier={user?.tier}
          context={{ domain: url || projectUrl(), target: url || projectUrl(), inputs: { input: url || projectUrl() } }}
          exclude={AUDIT_TOOLS.map((t) => t.id)}
        />
      )}
    </div>
  );
}

function Report({ report }) {
  const score = Math.max(0, Math.min(100, Math.round(Number(report.score) || 0)));
  const tone = SCORE_TONE(score);
  const C = 2 * Math.PI * 52;
  const off = C * (1 - score / 100);
  const pri = { high: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', medium: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', low: 'bg-sunken text-muted' };
  const dot = { good: 'bg-green-500', fair: 'bg-amber-500', poor: 'bg-red-500' };

  return (
    <div className="mt-6 space-y-4">
      {/* Score + summary */}
      <div className="card flex flex-col items-center gap-5 p-6 sm:flex-row">
        <svg width="130" height="130" viewBox="0 0 130 130" className="shrink-0" role="img" aria-label={`Health score ${score} out of 100`}>
          {/* Themed, not fixed slate. The headline score was fill #0f172a — all
              but the royal canvas's own colour — so the one number the whole
              page exists to deliver was unreadable in dark and blue. */}
          <circle cx="65" cy="65" r="52" fill="none" className="stroke-line" strokeWidth="12" />
          <circle cx="65" cy="65" r="52" fill="none" stroke={tone.ring} strokeWidth="12" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 65 65)" />
          <text x="65" y="62" textAnchor="middle" className="fill-heading" style={{ fontSize: 30, fontWeight: 800 }}>{score}</text>
          <text x="65" y="84" textAnchor="middle" className="fill-muted" style={{ fontSize: 12, fontWeight: 600 }}>/ 100</text>
        </svg>
        <div className="text-center sm:text-left">
          <div className={`text-sm font-bold uppercase tracking-wide ${tone.text}`}>{report.grade ? `Grade ${report.grade} · ` : ''}{tone.label}</div>
          <p className="mt-1 text-body">{report.summary}</p>
        </div>
      </div>

      {/* Area breakdown */}
      {Array.isArray(report.areas) && report.areas.length > 0 && (
        <div className="card p-5">
          <h2 className="font-bold">How each area scored</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {report.areas.map((a, i) => (
              <div key={i} className="rounded-lg border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${dot[a.status] || 'bg-slate-400'}`} aria-hidden />
                  <span className="text-sm font-semibold text-strong">{a.name}</span>
                  {typeof a.score !== 'undefined' && <span className="ml-auto text-sm font-bold text-muted">{a.score}</span>}
                </div>
                {a.note && <p className="mt-1 text-xs text-muted">{a.note}</p>}
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
              <li key={i} className="flex items-start gap-3 rounded-lg border border-hair p-3">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-sunken text-xs font-bold text-muted">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-strong">{f.title}</span>
                    {f.priority && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${pri[f.priority] || pri.low}`}>{f.priority}</span>}
                  </div>
                  {f.why && <p className="mt-0.5 text-sm text-muted">{f.why}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="flex items-center gap-1 text-xs text-faint">
        <ChevronRight size={12} aria-hidden /> Want the full detail behind a fix? Open the matching tool from the dashboard.
      </p>
    </div>
  );
}
