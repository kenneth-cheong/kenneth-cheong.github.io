import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, RefreshCw, ShieldCheck, ShieldAlert, Gauge as GaugeIcon, Link2, Bot, LineChart } from 'lucide-react';
import { CREDIT_COSTS, toolById } from '@shared/catalog.mjs';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useLatestRuns, ago } from '../lib/latestRuns.js';
import Modal from './Modal.jsx';
import ResultSections from './ResultSections.jsx';
import ReportHtml from './ReportHtml.jsx';
import { DetailLink } from './CardDetails.jsx';

// The approved design's Tracking & Results wall, driven by each tool's LATEST
// STORED RUN (see lib/latestRuns.js). Every number is one the tool actually
// produced — nothing here is invented, and no card triggers a run.
//
// A tool that's never been run renders an empty state with a Run button rather
// than a placeholder figure, so the wall is honest on a fresh account.

// The tools these cards read.
export const RESULT_TOOLS = ['forensic-audit', 'ai-discovery', 'ga4', 'page-speed'];

export default function ResultCards() {
  const { loading, byTool } = useLatestRuns(RESULT_TOOLS);
  const audit = byTool['forensic-audit'];
  const geo = byTool['ai-discovery'];
  const ga4 = byTool['ga4'];
  const s = audit?.result?.summary || null;

  // Only show the Authority score when the stored run was produced by our own
  // authorityScore(). Audits run before 2026-07-20 hold a third-party suite's
  // authority figure in the same field — showing it under our label would be
  // presenting vendor data as ours. Re-run the audit and it returns.
  const hasAuthority = !!(s && s.authoritySource && s.domainAuthority != null);

  // Page speed comes from whichever reading is NEWEST: the standalone Page Speed
  // Check when one has been run since the last audit, otherwise the audit's own
  // figures. `speed` holds an in-session refresh so the rings move immediately;
  // on the next load the stored page-speed run takes over. Without that second
  // half a refresh silently reverted to the older audit number on reload, which
  // reads as the refresh having done nothing.
  const [speed, setSpeed] = useState(null);
  const psRun = byTool['page-speed'];
  const psSum = psRun?.result?.summary;
  const psStored = psSum && psSum.pageSpeedMobile != null && (!audit || String(psRun.ts) > String(audit.ts))
    ? { mobile: psSum.pageSpeedMobile, desktop: psSum.pageSpeedDesktop, ts: psRun.ts, target: psRun.target }
    : null;
  const ps = speed || psStored || (s && s.pageSpeedMobile != null
    ? { mobile: s.pageSpeedMobile, desktop: s.pageSpeedDesktop }
    : null);
  // The card's freshness line should track the reading on screen, not the audit
  // the numbers used to come from.
  const speedRun = !audit ? audit
    : speed ? { ...audit, ts: Date.now() }
    : psStored ? { ...audit, ts: psStored.ts, target: psStored.target || audit.target }
    : audit;

  if (loading) {
    return (
      <div className="dm-result-grid mt-4">
        {[0, 1, 2].map((i) => <div key={i} className="card h-52 animate-pulse opacity-60" />)}
      </div>
    );
  }

  return (
    <div className="dm-result-grid mt-4">
      {/* ── Site health ─────────────────────────────────────────────────── */}
      <Card title="Site health" toolId="forensic-audit" run={audit} chip={s && `${s.pagesCrawled} pages`}>
        {s && (
          <>
            <div className="grid place-items-center py-1">
              <Ring value={s.healthScore} max={100} label="/ 100" hue={hueFor(s.healthScore)} />
            </div>
            <div className="mt-3 flex flex-col gap-2">
              <IssueBar label="Critical" n={s.critical} total={s.issues} hue="var(--c-neg)" />
              <IssueBar label="Warnings" n={s.warning} total={s.issues} hue="var(--c-warn)" />
              <IssueBar label="Opportunities" n={s.opportunity} total={s.issues} hue="var(--c-peri)" />
            </div>
          </>
        )}
      </Card>

      {/* ── Page speed ──────────────────────────────────────────────────────
          The one card with a REFRESH: page speed is the metric people re-check
          most, and it's cheap to re-measure on its own. `refresh` makes the
          card's "Re-run" call the 1-credit Page Speed Check and patch these two
          numbers in place — it used to redirect to the 50-credit, ~2-minute
          forensic audit, which recomputed thirty unrelated probes to update two
          rings the user was already looking at. */}
      <Card title="Page speed" toolId="forensic-audit" run={speedRun} icon={<GaugeIcon size={15} aria-hidden />}
        chip={ps && `${Math.round((ps.mobile + ps.desktop) / 2)} avg`}
        refresh={{
          toolId: 'page-speed',
          label: 'Refresh speed',
          apply: (result) => {
            const sum = result?.summary || {};
            if (sum.pageSpeedMobile == null && sum.pageSpeedDesktop == null) return null;
            return { mobile: sum.pageSpeedMobile, desktop: sum.pageSpeedDesktop };
          },
        }}
        onRefreshed={setSpeed}
      >
        {ps && (
          <>
            <div className="flex flex-wrap items-center justify-around gap-2 py-2">
              <Ring value={ps.mobile} max={100} label="Mobile" hue={hueFor(ps.mobile)} size={92} />
              <Ring value={ps.desktop} max={100} label="Desktop" hue={hueFor(ps.desktop)} size={92} />
            </div>
            <p className="mt-1 text-[10.5px] text-muted">
              Google PageSpeed scores. (Field Core Web Vitals — LCP/INP/CLS — aren't collected by this tool.)
            </p>
          </>
        )}
      </Card>

      {/* ── Authority & backlinks ───────────────────────────────────────── */}
      <Card title="Authority" toolId="forensic-audit" run={audit} icon={<Link2 size={15} aria-hidden />}
        chip={hasAuthority && `Authority ${s.domainAuthority}`}>
        {s && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[clamp(1.5rem,7cqw,2.25rem)] font-extrabold leading-none tracking-tight tabular-nums text-heading">
                {Number(s.backlinks).toLocaleString()}
              </span>
              <span className="text-xs font-semibold text-muted">backlinks</span>
            </div>
            <div className="mt-4 flex flex-col gap-2.5">
              {hasAuthority && (
                <Meter label="Authority score" n={s.domainAuthority} max={100} hue="var(--c-pos)" suffix={`${s.domainAuthority}/100`} />
              )}
              {/* Spam score inverts: lower is better, so the bar stays green until it isn't. */}
              <Meter label="Spam score" n={s.spamScore} max={100} hue={s.spamScore <= 10 ? 'var(--c-pos)' : s.spamScore <= 30 ? 'var(--c-warn)' : 'var(--c-neg)'} suffix={`${s.spamScore}%`} />
            </div>
            {!hasAuthority && (
              <p className="mt-3 text-[10.5px] text-muted">
                Authority score isn’t shown for this run — how we calculate it changed. Re-run the audit to get it.
              </p>
            )}
          </>
        )}
      </Card>

      {/* ── AI visibility ───────────────────────────────────────────────── */}
      <Card title="AI visibility" toolId="ai-discovery" run={geo} icon={<Bot size={15} aria-hidden />}
        chip={geo?.result?.summary && `${geo.result.summary.checksPassed}/${geo.result.summary.checksTotal} checks`}>
        {geo?.result?.summary && (
          <>
            <div className="grid place-items-center py-1">
              <Ring value={geo.result.summary.geoReadiness} max={100} label="GEO ready" hue={hueFor(geo.result.summary.geoReadiness)} />
            </div>
            <p className="mt-3 text-[10.5px] text-muted">
              How ready this site is to be quoted by AI answer engines — {geo.result.summary.checksPassed} of{' '}
              {geo.result.summary.checksTotal} readiness checks passing.
            </p>
          </>
        )}
      </Card>

      {/* ── Technical signals ───────────────────────────────────────────── */}
      <Card title="Technical signals" toolId="forensic-audit" run={audit} icon={<ShieldCheck size={15} aria-hidden />}>
        {s && (
          <div className="flex flex-col gap-2.5 py-1">
            <Signal label="SSL certificate" ok={String(s.ssl).toLowerCase() === 'pass'} value={s.ssl} />
            <Signal label="Structured data" ok={String(s.structuredData).toLowerCase() === 'yes'} value={s.structuredData} />
            <Signal label="llms.txt" ok={String(s.llmsTxt).toLowerCase() !== 'missing'} value={s.llmsTxt} />
          </div>
        )}
      </Card>

      {/* ── Traffic ─────────────────────────────────────────────────────── */}
      <Card title="Traffic" toolId="ga4" run={ga4} icon={<LineChart size={15} aria-hidden />} chip="GA4">
        {ga4?.result?.summary && (
          <div className="grid grid-cols-2 gap-3 py-1">
            {[
              ['Sessions', ga4.result.summary.sessions],
              ['Users', ga4.result.summary.users],
              ['Engaged', ga4.result.summary.engagedSessions],
              ['Conversions', ga4.result.summary.conversions],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl border border-line bg-raised p-3">
                <div className="text-xl font-extrabold tabular-nums text-heading">{Number(v || 0).toLocaleString()}</div>
                <div className="mt-0.5 break-words text-[10px] font-semibold leading-tight text-muted">{k}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// Shell: title, freshness, and — when there's no stored run — an honest empty
// state pointing at the tool instead of a fake number.
//
// `refresh` opts a card into an INLINE update: { toolId, label, apply }. The
// footer button then runs that (small, cheap) tool against this card's target
// and hands the result to `apply`, which returns the patch for `onRefreshed`.
// Without it the footer button just opens the card's own tool, which is right
// for the heavyweight ones — but was badly wrong for Page speed, where it meant
// a 50-credit forensic audit to refresh two numbers.
function Card({ title, toolId, run, chip, icon, refresh, onRefreshed, children }) {
  const has = !!run?.result;
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const { setCredits } = useAuth();
  // With a stored run → clicking the card opens a detail modal with the full run
  // (sections / report), plus a footer link to open the tool and re-run. With no
  // run yet → the card goes straight to the tool to run it the first time.
  const openTool = () => navigate(`/tool/${toolId}`);
  const openDetail = () => setShow(true);
  const act = has ? openDetail : openTool;
  const toolName = toolById(toolId)?.name || title;
  const sections = run?.result?.sections;
  const html = run?.result?.html;

  const refreshTool = refresh && toolById(refresh.toolId);
  const refreshCost = refreshTool ? (CREDIT_COSTS[refreshTool.cost] ?? 0) : 0;

  // Re-measure just this card. Stays on the page — no navigation, no tool form,
  // no re-running everything else the original audit happened to cover.
  async function doRefresh(e) {
    e.stopPropagation();
    if (busy || !run?.target) return;
    setBusy(true);
    try {
      const res = await api.runTool(refreshTool.id, { input: run.target, url: run.target }, refreshTool.slow);
      if (typeof res?.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
      if (res?.failed) { toast('Couldn’t get a fresh reading — no credits were charged.', 'error'); return; }
      const patch = refresh.apply(res?.result ?? res);
      if (!patch) { toast('Couldn’t get a fresh reading just now.', 'error'); return; }
      onRefreshed?.(patch);
      toast(`${title} updated`, 'success');
    } catch (err) {
      toast(err?.message || 'Refresh failed — no credits were charged.', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <section
      role="button"
      tabIndex={0}
      onClick={act}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } }}
      className="card card-hover group flex cursor-pointer flex-col p-[18px]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-faint">
          {icon}{title}
        </span>
        {has && chip && (
          <span className="shrink-0 rounded-full bg-sunken px-2.5 py-1 text-[10.5px] font-bold text-muted">{chip}</span>
        )}
      </div>

      {has ? (
        <>
          <div className="flex-1">{children}</div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-hair pt-2.5">
            <span className="truncate text-[10px] text-faint" title={run.target}>{run.target} · {ago(run.ts)}</span>
            {refreshTool ? (
              <button
                type="button"
                onClick={doRefresh}
                disabled={busy}
                title={`Re-measure ${run.target} without leaving this page — ${refreshCost} credit${refreshCost === 1 ? '' : 's'}`}
                className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold text-peri hover:underline disabled:cursor-wait disabled:opacity-60 disabled:no-underline"
              >
                <RefreshCw size={11} className={busy ? 'animate-spin' : undefined} aria-hidden />
                {busy ? 'Checking…' : (refresh.label || 'Refresh')}
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); openTool(); }}
                className="shrink-0 text-[10px] font-bold text-peri hover:underline"
              >
                Re-run
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-6 text-center">
          <ShieldAlert size={20} className="text-faint" aria-hidden />
          <p className="text-[11px] text-muted">No run yet — run this once and it stays here.</p>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openTool(); }}
            className="btn-primary px-3 py-1.5 text-xs"
          >
            <Play size={12} aria-hidden /> Run it
          </button>
        </div>
      )}
    </section>

    {has && (
      <Modal
        open={show}
        onClose={() => setShow(false)}
        wide
        tag="DETAILS"
        title={title}
        titleNote={run.target}
        labelledBy="dm-result-detail"
        footer={<DetailLink to={`/tool/${toolId}`} primary onClick={() => setShow(false)}>Open {toolName}</DetailLink>}
      >
        {Array.isArray(sections) && sections.length
          ? <ResultSections sections={sections} context={{ toolName, target: run.target, route: `/tool/${toolId}` }} />
          : html
            ? <ReportHtml html={html} />
            : <div className="dm-result-detail-fallback">{children}</div>}
      </Modal>
    )}
    </>
  );
}

const hueFor = (n) => (n >= 90 ? 'var(--c-pos)' : n >= 50 ? 'var(--c-warn)' : 'var(--c-neg)');

// Arc gauge — same construction as the credits ring: an SVG stroke so both ends
// cap identically, rotated so the gap sits at the bottom.
function Ring({ value, max, label, hue, size = 118 }) {
  const r = size * 0.4;
  const circ = 2 * Math.PI * r;
  const span = circ * 0.72;
  const pct = Math.max(0, Math.min(1, max ? value / max : 0));
  const c = size / 2;
  return (
    <div className="relative grid place-items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${value} of ${max}`}>
        <g transform={`rotate(126 ${c} ${c})`}>
          <circle cx={c} cy={c} r={r} fill="none" stroke="rgb(var(--c-canvas))" strokeWidth="9"
            strokeLinecap="round" strokeDasharray={`${span} ${circ}`} />
          <circle cx={c} cy={c} r={r} fill="none" stroke={`rgb(${hue})`} strokeWidth="9"
            strokeLinecap="round" strokeDasharray={`${span * pct} ${circ}`} />
        </g>
      </svg>
      <div className="absolute grid place-items-center">
        <div className="text-2xl font-extrabold tabular-nums leading-none text-heading">{value}</div>
        <div className="mt-0.5 text-[9.5px] font-semibold text-muted">{label}</div>
      </div>
    </div>
  );
}

function IssueBar({ label, n, total, hue }) {
  const pct = total ? (n / total) * 100 : 0;
  return (
    <span className="flex items-center gap-2.5">
      <span className="w-[86px] shrink-0 text-[11px] font-medium text-muted">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded bg-sunken">
        <i className="block h-full rounded" style={{ width: `${pct}%`, background: `rgb(${hue})` }} />
      </span>
      <b className="w-4 shrink-0 text-right text-[11px] tabular-nums text-heading">{n}</b>
    </span>
  );
}

function Meter({ label, n, max, hue, suffix }) {
  return (
    <span className="block">
      <span className="flex justify-between text-[11px]">
        <span className="font-medium text-muted">{label}</span>
        <b className="tabular-nums text-heading">{suffix}</b>
      </span>
      <span className="mt-1 block h-2 overflow-hidden rounded bg-sunken">
        <i className="block h-full rounded" style={{ width: `${Math.min(100, (n / max) * 100)}%`, background: `rgb(${hue})` }} />
      </span>
    </span>
  );
}

function Signal({ label, ok, value }) {
  return (
    <span className="flex items-center justify-between gap-2 rounded-xl border border-line bg-raised px-3 py-2.5">
      <span className="text-[11px] font-medium text-body">{label}</span>
      <span className="flex items-center gap-1.5 text-[10.5px] font-bold" style={{ color: `rgb(${ok ? 'var(--c-pos)' : 'var(--c-warn)'})` }}>
        <i className="h-1.5 w-1.5 rounded-full" style={{ background: `rgb(${ok ? 'var(--c-pos)' : 'var(--c-warn)'})` }} />
        {String(value)}
      </span>
    </span>
  );
}
