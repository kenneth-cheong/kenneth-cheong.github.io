import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ShieldCheck, ShieldAlert, Gauge as GaugeIcon, Link2, Bot, LineChart } from 'lucide-react';
import { toolById } from '@shared/catalog.mjs';
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
export const RESULT_TOOLS = ['forensic-audit', 'ai-discovery', 'ga4'];

export default function ResultCards() {
  const { loading, byTool } = useLatestRuns(RESULT_TOOLS);
  const audit = byTool['forensic-audit'];
  const geo = byTool['ai-discovery'];
  const ga4 = byTool['ga4'];
  const s = audit?.result?.summary || null;

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

      {/* ── Page speed ──────────────────────────────────────────────────── */}
      <Card title="Page speed" toolId="forensic-audit" run={audit} icon={<GaugeIcon size={15} aria-hidden />}
        chip={s && `${Math.round((s.pageSpeedMobile + s.pageSpeedDesktop) / 2)} avg`}>
        {s && (
          <>
            <div className="flex flex-wrap items-center justify-around gap-2 py-2">
              <Ring value={s.pageSpeedMobile} max={100} label="Mobile" hue={hueFor(s.pageSpeedMobile)} size={92} />
              <Ring value={s.pageSpeedDesktop} max={100} label="Desktop" hue={hueFor(s.pageSpeedDesktop)} size={92} />
            </div>
            <p className="mt-1 text-[10.5px] text-muted">
              Google PageSpeed scores. (Field Core Web Vitals — LCP/INP/CLS — aren't collected by this tool.)
            </p>
          </>
        )}
      </Card>

      {/* ── Authority & backlinks ───────────────────────────────────────── */}
      <Card title="Authority" toolId="forensic-audit" run={audit} icon={<Link2 size={15} aria-hidden />}
        chip={s && `DA ${s.domainAuthority}`}>
        {s && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[clamp(1.5rem,7cqw,2.25rem)] font-extrabold leading-none tracking-tight tabular-nums text-heading">
                {Number(s.backlinks).toLocaleString()}
              </span>
              <span className="text-xs font-semibold text-muted">backlinks</span>
            </div>
            <div className="mt-4 flex flex-col gap-2.5">
              <Meter label="Domain authority" n={s.domainAuthority} max={100} hue="var(--c-pos)" suffix={`${s.domainAuthority}/100`} />
              {/* Spam score inverts: lower is better, so the bar stays green until it isn't. */}
              <Meter label="Spam score" n={s.spamScore} max={100} hue={s.spamScore <= 10 ? 'var(--c-pos)' : s.spamScore <= 30 ? 'var(--c-warn)' : 'var(--c-neg)'} suffix={`${s.spamScore}%`} />
            </div>
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
function Card({ title, toolId, run, chip, icon, children }) {
  const has = !!run?.result;
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  // With a stored run → clicking the card opens a detail modal with the full run
  // (sections / report), plus a footer link to open the tool and re-run. With no
  // run yet → the card goes straight to the tool to run it the first time.
  const openTool = () => navigate(`/tool/${toolId}`);
  const openDetail = () => setShow(true);
  const act = has ? openDetail : openTool;
  const toolName = toolById(toolId)?.name || title;
  const sections = run?.result?.sections;
  const html = run?.result?.html;

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
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); openTool(); }}
              className="shrink-0 text-[10px] font-bold text-peri hover:underline"
            >
              Re-run
            </button>
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
          ? <ResultSections sections={sections} />
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
