import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api, ApiError } from '../lib/api.js';
import { CTA_URL, CTA_HOST } from '../lib/shareCard.js';
import Logo from '../components/Logo.jsx';
import ResultSections from '../components/ResultSections.jsx';
import ReportHtml from '../components/ReportHtml.jsx';
import ResultTable from '../components/ResultTable.jsx';

// Plain-English summary, formatted like the in-app panel (bold the "Looking
// good / Needs attention / Do this next" leads; one line per paragraph).
function TldrText({ text }) {
  const lines = String(text).replace(/\*\*/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="mt-2 space-y-1 text-sm leading-relaxed text-body">
      {lines.map((l, i) => {
        const m = l.match(/^(Looking good|Needs attention|Do this next)\s*:?\s*(.*)$/i);
        return m
          ? <p key={i}><strong className="font-semibold text-heading">{m[1]}:</strong> {m[2]}</p>
          : <p key={i}>{l}</p>;
      })}
    </div>
  );
}

// Signals to the shared section renderers that there's no signed-in session or
// assistant behind this view, so they drop controls that would no-op or bounce
// a visitor to login (recommendation "How"/bulk actions). `select` sections are
// already inert without an `onAction`.
const READ_ONLY = { readOnly: true };

// Public, read-only view of a shared tool run: /share/:shareId.
//
// Rendered for signed-OUT visitors (the route sits above the auth gate in
// App.jsx), so it carries its own minimal chrome instead of the app shell. The
// result body reuses the SAME leaf renderers as ToolRunner (ReportHtml /
// ResultSections / ResultTable) so a shared link looks identical to the app —
// but with no `context` handed to ResultSections, every "select"/recommendation
// section renders read-only (no re-run, nothing billable). Nothing here can
// reach an authed endpoint; the body comes from the public /s/:id/run.json.

function Frame({ children }) {
  return (
    <div className="min-h-screen bg-sunken text-body">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <a href={CTA_URL}><Logo width={150} /></a>
          <a href={CTA_URL} className="btn-primary text-sm">Run your own free audit →</a>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      <footer className="mx-auto max-w-4xl px-4 pb-10 pt-2 text-center text-xs text-faint">
        Report generated with Digimetrics — SEO, GEO &amp; AI-visibility tools · {CTA_HOST}
      </footer>
    </div>
  );
}

export default function PublicRun() {
  const { shareId } = useParams();
  const [run, setRun] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | gone | error

  useEffect(() => {
    let alive = true;
    setState('loading');
    api.publicRun(shareId)
      .then(({ run: r }) => { if (alive) { setRun(r); setState('ready'); } })
      .catch((e) => {
        if (!alive) return;
        // 404 = link revoked, expired (TTL), or never existed. Anything else is
        // an unexpected failure the visitor can retry.
        setState(e instanceof ApiError && e.status === 404 ? 'gone' : 'error');
      });
    return () => { alive = false; };
  }, [shareId]);

  useEffect(() => {
    if (run?.toolName) document.title = `${run.toolName} · Digimetrics`;
    return () => { document.title = 'Digimetrics'; };
  }, [run]);

  // Defence-in-depth against indexing (the primary guard is the X-Robots-Tag
  // header on /share/* — see public/customHttp.yml): a shared report is
  // unlisted-by-token and must not turn up in search.
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { document.head.removeChild(m); };
  }, []);

  if (state === 'loading') return <Frame><p className="mt-10 text-center text-faint">Loading report…</p></Frame>;

  if (state === 'gone' || state === 'error') {
    return (
      <Frame>
        <div className="card mx-auto mt-6 max-w-lg p-8 text-center">
          <p className="font-semibold text-heading">
            {state === 'gone' ? 'This report isn’t available' : 'Something went wrong'}
          </p>
          <p className="mt-1.5 text-sm text-dim">
            {state === 'gone'
              ? 'The share link may have been revoked by its owner, or it has expired.'
              : 'We couldn’t load this report. Please try again in a moment.'}
          </p>
          <a href={CTA_URL} className="btn-primary mt-4 inline-block text-sm">Run your own free audit →</a>
        </div>
      </Frame>
    );
  }

  const r = run?.result || {};
  const hasRows = r.rows && r.rows.length > 0;
  // Mirror ToolRunner's ordering: 'cards' (recommendations) drop below a data
  // table that they reference; everything else stays above as authored.
  const preRowSections = hasRows ? (r.sections || []).filter((s) => s.type !== 'cards') : (r.sections || []);
  const postRowSections = hasRows ? (r.sections || []).filter((s) => s.type === 'cards') : [];
  const empty = !(r.text || r.html || hasRows || (r.sections && r.sections.length));

  return (
    <Frame>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-heading">{run.toolName}</h1>
        {run.target && <p className="mt-0.5 text-sm text-dim">{run.target}</p>}
      </div>

      {run.tldr && (
        <div className="mb-4 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 dark:bg-brand-500/10 p-4">
          <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">
            <Sparkles size={13} aria-hidden /> What this means — in plain English
          </div>
          <TldrText text={run.tldr} />
        </div>
      )}

      <div className="card p-5">
        {empty ? (
          <p className="text-sm text-muted">This report has no content to display.</p>
        ) : (
          <>
            {r.text && <pre className="whitespace-pre-wrap text-sm text-body">{r.text}</pre>}
            {preRowSections.length > 0 && <ResultSections sections={preRowSections} context={READ_ONLY} />}
            {r.html && <ReportHtml html={r.html} />}
            {hasRows && <ResultTable rows={r.rows} defaultColumns={r.defaultColumns} />}
            {postRowSections.length > 0 && <ResultSections sections={postRowSections} context={READ_ONLY} />}
          </>
        )}
      </div>
    </Frame>
  );
}
