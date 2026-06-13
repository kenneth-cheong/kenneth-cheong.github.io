import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { toolById, inputsFor, tabsFor, exampleFor, CREDIT_COSTS, PLANS, tierMeets } from '@shared/catalog.mjs';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import UpgradeModal from '../components/UpgradeModal.jsx';
import ResultSections from '../components/ResultSections.jsx';
import SchemaResult from '../components/SchemaResult.jsx';
import SortableTable from '../components/SortableTable.jsx';
import { toast, copyText, downloadCsv, fmtNum, pushRecent, saveLastInput, loadLastInput } from '../lib/ui.js';
import { startToolTour, hasSeen, markSeen } from '../lib/tours.js';
import { Lock, Compass, Sparkles, AlertTriangle } from 'lucide-react';

const CONFIRM_AT = 25; // credits — confirm before running pricey tools

export default function ToolRunner() {
  const { toolId } = useParams();
  const { user, setCredits } = useAuth();
  const { activeId, active } = useProjects();
  const tool = toolById(toolId);
  const location = useLocation();
  const tabs = useMemo(() => tabsFor(tool), [tool]);
  const [tab, setTab] = useState(0);
  const activeTab = tabs?.[tab];
  const fields = useMemo(() => (tabs ? activeTab?.fields || [] : tool ? inputsFor(tool) : []), [tool, tabs, activeTab]);

  const seedValues = () => {
    const fromHistory = location.state?.values;
    const last = fromHistory ? {} : (loadLastInput(toolId) || {});
    return Object.fromEntries(fields.map((f) => [f.name, fromHistory?.[f.name] ?? last[f.name] ?? f.default ?? '']));
  };
  const [values, setValues] = useState(seedValues);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(location.state?.result ? { result: location.state.result } : null);
  const [modal, setModal] = useState(null);
  const shownRef = useRef([]); // latest visible fields, for the auto-started tour

  // Reset the form + result when navigating between tools (same route component).
  useEffect(() => { setTab(0); setValues(seedValues()); setOut(location.state?.result ? { result: location.state.result } : null); /* eslint-disable-next-line */ }, [toolId]);

  // First tool a user ever opens → auto-run that tool's guided tour, once.
  useEffect(() => {
    if (!tool || hasSeen('tool:any')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:any')) return;
      markSeen('tool:any');
      startToolTour(tool, shownRef.current);
    }, 700);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [toolId]);

  if (!tool) return <p>Unknown tool.</p>;
  const unlocked = tierMeets(user.tier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));
  // Switch GSC sub-tool tab: clear the previous result, seed any new fields'
  // defaults, but keep shared values (e.g. the selected property) across tabs.
  function selectTab(i) {
    setTab(i);
    setOut(null);
    setValues((v) => { const next = { ...v }; for (const f of tabs[i].fields) if (!(f.name in next)) next[f.name] = f.default ?? ''; return next; });
  }
  const isVisible = (f) => !f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]);
  const shown = fields.filter(isVisible);
  shownRef.current = shown;
  const ready = shown.every((f) => !f.required || String(values[f.name] || '').trim());
  const example = exampleFor(tool.id);

  function fillExample() {
    if (!example) return;
    setValues((s) => ({ ...s, ...example }));
    toast('Example filled in', 'info');
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
    try {
      const res = await api.runTool(tool.id, { ...vals, gscOp: activeTab?.op, url: vals.url || vals.input, projectId: activeId || undefined }, tool.slow);
      setOut(res);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining);
      if (res.creditsUsed > 0) toast(`−${res.creditsUsed} credit${res.creditsUsed > 1 ? 's' : ''} · ${res.creditsRemaining} left`, 'info');
      saveLastInput(tool.id, vals);
      pushRecent(tool.id);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 403)) {
        setModal({ reason: e.payload.error, requiredTier: e.payload.requiredTier || tool.minTier });
      } else {
        setOut({ error: e.message });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">← All tools</Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{tool.name}</h1>
        {!unlocked && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase text-amber-700"><Lock size={12} aria-hidden /> {PLANS[tool.minTier].name}</span>}
        <button
          type="button"
          onClick={() => startToolTour(tool, shown)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 hover:border-brand-300 hover:text-brand-600"
          title="Guided walkthrough with a real example"
        >
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-slate-600">{tool.desc}</p>

      {!unlocked && tool.teaser && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          <Sparkles size={16} className="shrink-0" aria-hidden /> <span>You get <strong>one free preview run</strong> on your own data. Full results unlock with {PLANS[tool.minTier].name}.</span>
        </div>
      )}

      {/* GSC sub-tool tabs (URL Inspection / Sitemaps / Indexing), like index.html. */}
      {tabs && (
        <div className="mt-5 flex flex-wrap gap-1 border-b border-slate-200">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(i)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition ${i === tab ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className={`card ${tabs ? 'mt-4' : 'mt-6'} p-5`}>
        <div className="space-y-4">
          {shown.map((f, i) => (
            <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} autoFocus={i === 0} provider={tool.integration} />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-slate-400" data-tour="tool-actions">
            <span>{cost === 0 ? 'Free to run' : `Costs ${cost} credit${cost > 1 ? 's' : ''}`}</span>
            {example && <button type="button" onClick={fillExample} className="font-medium text-brand-600 hover:text-brand-700">Try an example</button>}
          </div>
          <button className="btn-primary" disabled={busy || !ready} onClick={() => run()} data-tour="tool-run">
            {busy ? (tool.slow ? 'Generating…' : 'Running…') : unlocked ? 'Run tool' : 'Run preview'}
          </button>
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

      {busy && tool.slow && <SlowProgress tool={tool} />}
      {out && !busy && <Result out={out} tool={tool} project={active} user={user} />}

      {modal && <UpgradeModal reason={modal.reason} requiredTier={modal.requiredTier} onClose={() => setModal(null)} />}
    </div>
  );
}

function SlowProgress({ tool }) {
  const steps = ['Sending your request…', 'Reaching the data sources…', 'Crunching the numbers…', 'Compiling the results…', 'Almost there…'];
  const [sec, setSec] = useState(0);
  const [i, setI] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setSec((s) => s + 1), 1000);
    const b = setInterval(() => setI((x) => Math.min(x + 1, steps.length - 1)), 6000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  return (
    <div className="card mt-6 p-6">
      <div className="flex items-center gap-3">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        <span className="font-medium text-slate-700">{steps[i]}</span>
        <span className="ml-auto text-xs tabular-nums text-slate-400">{sec}s · ~30–150s for {tool.name}</span>
      </div>
      <div className="mt-4 space-y-2">
        {[90, 75, 82, 60].map((w, k) => <div key={k} className="h-3 animate-pulse rounded bg-slate-100" style={{ width: `${w}%` }} />)}
      </div>
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

function Result({ out, tool, project, user }) {
  if (out.error) return <p className="mt-6 flex items-center gap-1.5 text-red-600"><AlertTriangle size={16} aria-hidden /> {out.error}</p>;
  const r = out.result || {};

  if (r.needsConnect) {
    return (
      <div className="card mt-6 p-6 text-center">
        <p className="text-slate-600">{r.text || 'Connect your account to use this tool.'}</p>
        <Link to="/integrations" className="btn-primary mt-3 inline-block">Connect in Integrations →</Link>
      </div>
    );
  }

  const isSchema = tool.id === 'schema' && r.text;
  const hasContent = r.text || r.preview || r.html || (r.rows && r.rows.length) || (r.sections && r.sections.length);
  const sectionTable = r.sections && firstTable(r.sections);

  return (
    <div className="mt-6">
      <div className="dm-no-print mb-2 flex items-center gap-2">
        {r.source === 'live' && <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700"><span className="inline-block h-1.5 w-1.5 rounded-full bg-green-600" aria-hidden /> Live data</span>}
        {typeof out.creditsUsed === 'number' && out.creditsUsed > 0 && (
          <span className="text-xs text-slate-400">used {out.creditsUsed} · {out.creditsRemaining} left</span>
        )}
        {hasContent && (
          <div className="ml-auto flex gap-1.5">
            {r.rows && r.rows.length > 0 && <ResultBtn onClick={() => downloadCsv(r.rows, `${tool.id}.csv`)}>CSV</ResultBtn>}
            {sectionTable && <ResultBtn onClick={() => downloadCsv(sectionTable.rows, `${tool.id}.csv`)}>CSV</ResultBtn>}
            <ResultBtn onClick={() => copyText(copyableOf(r))}>Copy</ResultBtn>
            <ResultBtn onClick={() => window.print()}>Print</ResultBtn>
          </div>
        )}
      </div>

      <div className="card p-5">
        <PrintHeader tool={tool} project={project} user={user} />
        {out.failed && (
          <div className="dm-no-print mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            This run didn’t complete — no credits were charged.
          </div>
        )}
        {out.teaser && (
          <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            {r.teaserMessage || 'Preview only — upgrade to see everything.'}
          </div>
        )}

        {isSchema ? (
          <SchemaResult json={r.text} />
        ) : (
          <>
            {r.text && <pre className="whitespace-pre-wrap text-sm text-slate-700">{r.text}</pre>}
            {r.preview && <pre className="whitespace-pre-wrap text-sm text-slate-500">{r.preview}</pre>}
            {r.sections && r.sections.length > 0 && <ResultSections sections={r.sections} />}
            {r.html && <div className="dm-report max-w-none text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: r.html }} />}
          </>
        )}

        {r.rows && r.rows.length > 0 && <ResultTable rows={r.rows} />}

        {r.blurredCount > 0 && (
          <div className="relative mt-1">
            <div className="blur-locked">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-8 border-t border-slate-100 py-1.5 text-sm text-slate-400">
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
            <p className="text-sm text-slate-500">{r.teaserMessage}</p>
            <Link to="/pricing" className="btn-primary mt-3">Unlock full report</Link>
          </div>
        )}
      </div>
    </div>
  );
}

function ResultBtn({ children, onClick }) {
  return <button onClick={onClick} className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:border-brand-300 hover:text-brand-600">{children}</button>;
}

// Sortable table with per-column formatting + badges.
function ResultTable({ rows }) {
  const columns = Object.keys(rows[0] || {}).map((c) => ({
    key: c,
    label: c, // upstream keys are already cased (e.g. "CPC") — don't humanise
    render: (row) => cell(c, row[c]),
  }));
  return <SortableTable columns={columns} rows={rows} />;
}

const TONE = { red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-700', green: 'bg-green-100 text-green-700', blue: 'bg-blue-100 text-blue-700', slate: 'bg-slate-100 text-slate-600' };
function Badge({ t, tone }) { return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone] || TONE.slate}`}>{t}</span>; }

function cell(col, val) {
  const c = col.toLowerCase();
  const s = String(val ?? '');
  if (!s || s === '—') return <span className="text-slate-400">—</span>;
  if (c === 'priority') return <Badge t={s} tone={{ critical: 'red', high: 'amber', medium: 'blue', keep: 'slate' }[s.toLowerCase()]} />;
  if (c === 'severity') return <Badge t={s} tone={{ critical: 'red', high: 'red', medium: 'amber', low: 'green' }[s.toLowerCase()]} />;
  if (c === 'suitability') return <Badge t={s} tone={{ high: 'green', medium: 'amber', low: 'slate' }[s.toLowerCase()]} />;
  if (c === 'intent' || c === 'status' || c === 'type') return <Badge t={s} tone="slate" />;
  if (c === 'difficulty') { const n = parseFloat(s); if (Number.isFinite(n)) return <span className={n < 30 ? 'font-medium text-green-600' : n < 60 ? 'font-medium text-amber-600' : 'font-medium text-red-600'}>{n}</span>; }
  if (['volume', 'impressions', 'clicks', 'sessions', 'users', 'backlinks', 'traffic', 'conversions'].includes(c)) return <span className="tabular-nums">{fmtNum(s)}</span>;
  return s;
}

// Results-level controls for integration tools — re-pivot (range / breakdown)
// without scrolling back to the form. Mirrors index.html's dashboard selectors.
function RepivotBar({ fields, values, busy, onChange }) {
  if (!fields.length) return null;
  return (
    <div className="dm-no-print mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">View</span>
      {fields.map((f) => (
        <label key={f.name} className="flex items-center gap-1.5 text-sm text-slate-600">
          <span className="text-xs text-slate-500">{f.label}</span>
          <select
            value={values[f.name]}
            disabled={busy}
            onChange={(e) => onChange(f.name, e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm transition focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10 disabled:opacity-50"
          >
            {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      ))}
      {busy && <span className="flex items-center gap-1.5 text-xs text-slate-400"><span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />updating…</span>}
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
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 p-2 transition focus-within:border-brand-600 focus-within:ring-4 focus-within:ring-brand-600/10">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
            {t}
            <button type="button" onClick={() => remove(t)} className="text-brand-400 hover:text-brand-700">×</button>
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

      <button type="button" onClick={() => { setDraft(''); setBulk((b) => !b); }} className="mt-1.5 text-xs font-medium text-brand-600 hover:text-brand-700">
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
        <span className="mt-1 block text-xs text-slate-400">
          No connected accounts — <Link to="/integrations" className="font-medium text-brand-600 hover:text-brand-700">connect in Integrations</Link> or type an ID manually.
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
        <span className={`truncate ${label ? '' : 'text-slate-400'}`}>{accounts === null ? 'Loading accounts…' : (label || 'Select an account…')}</span>
        <span className="ml-2 shrink-0 text-slate-400">▾</span>
      </button>
      {open && accounts && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-100 p-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ID…"
              className="w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10" />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {filtered.length ? filtered.map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id); setOpen(false); }}
                className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${a.id === value ? 'font-semibold text-brand-700' : 'text-slate-700'}`}>
                {a.label}
              </button>
            )) : <div className="px-3 py-2 text-sm text-slate-400">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ field, value, onChange, autoFocus, provider }) {
  const base = 'field mt-1.5';
  return (
    <label className="block" data-tour-field={field.name}>
      <span className="text-sm font-medium text-slate-700">
        {field.label}{field.required && <span className="text-slate-400"> *</span>}
      </span>
      {field.type === 'account' ? (
        <AccountField provider={provider} value={value} onChange={onChange} placeholder={field.placeholder} />
      ) : field.type === 'tags' ? (
        <>
          <TagInput value={value} onChange={onChange} placeholder={field.placeholder} />
          <span className="mt-1 block text-xs text-slate-400">Add several — press Enter or comma between keywords.</span>
        </>
      ) : field.type === 'textarea' ? (
        <textarea autoFocus={autoFocus} rows={3} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'select' ? (
        <select autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input autoFocus={autoFocus} type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'url' ? 'url' : undefined}
          value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      )}
    </label>
  );
}
