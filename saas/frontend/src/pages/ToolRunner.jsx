import { useState, useMemo, useEffect } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { toolById, inputsFor, exampleFor, CREDIT_COSTS, PLANS, tierMeets } from '@shared/catalog.mjs';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import UpgradeModal from '../components/UpgradeModal.jsx';
import ResultSections from '../components/ResultSections.jsx';
import { toast, copyText, downloadCsv, fmtNum, pushRecent, saveLastInput, loadLastInput } from '../lib/ui.js';

const CONFIRM_AT = 25; // credits — confirm before running pricey tools

export default function ToolRunner() {
  const { toolId } = useParams();
  const { user, setCredits } = useAuth();
  const { activeId, active } = useProjects();
  const tool = toolById(toolId);
  const location = useLocation();
  const fields = useMemo(() => (tool ? inputsFor(tool) : []), [tool]);

  const seedValues = () => {
    const fromHistory = location.state?.values;
    const last = fromHistory ? {} : (loadLastInput(toolId) || {});
    return Object.fromEntries(fields.map((f) => [f.name, fromHistory?.[f.name] ?? last[f.name] ?? f.default ?? '']));
  };
  const [values, setValues] = useState(seedValues);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(location.state?.result ? { result: location.state.result } : null);
  const [modal, setModal] = useState(null);

  // Reset the form + result when navigating between tools (same route component).
  useEffect(() => { setValues(seedValues()); setOut(location.state?.result ? { result: location.state.result } : null); /* eslint-disable-next-line */ }, [toolId]);

  if (!tool) return <p>Unknown tool.</p>;
  const unlocked = tierMeets(user.tier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));
  const isVisible = (f) => !f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]);
  const shown = fields.filter(isVisible);
  const ready = shown.every((f) => !f.required || String(values[f.name] || '').trim());
  const example = exampleFor(tool.id);

  function fillExample() {
    if (!example) return;
    setValues((s) => ({ ...s, ...example }));
    toast('Example filled in', 'info');
  }

  async function run() {
    if (unlocked && cost >= CONFIRM_AT && !window.confirm(`This run costs ${cost} credits. Continue?`)) return;
    setBusy(true);
    setOut(null);
    try {
      const res = await api.runTool(tool.id, { ...values, url: values.url || values.input, projectId: activeId || undefined }, tool.slow);
      setOut(res);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining);
      if (res.creditsUsed > 0) toast(`−${res.creditsUsed} credit${res.creditsUsed > 1 ? 's' : ''} · ${res.creditsRemaining} left`, 'info');
      saveLastInput(tool.id, values);
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
        {!unlocked && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase text-amber-700">🔒 {PLANS[tool.minTier].name}</span>}
      </div>
      <p className="mt-1 text-slate-600">{tool.desc}</p>

      {!unlocked && tool.teaser && (
        <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          ✨ You get <strong>one free preview run</strong> on your own data. Full results unlock with {PLANS[tool.minTier].name}.
        </div>
      )}

      <div className="card mt-6 p-5">
        <div className="space-y-4">
          {shown.map((f, i) => (
            <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} autoFocus={i === 0} />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>{cost === 0 ? 'Free to run' : `Costs ${cost} credit${cost > 1 ? 's' : ''}`}</span>
            {example && <button type="button" onClick={fillExample} className="font-medium text-brand-600 hover:text-brand-700">Try an example</button>}
          </div>
          <button className="btn-primary" disabled={busy || !ready} onClick={run}>
            {busy ? (tool.slow ? 'Generating…' : 'Running…') : unlocked ? 'Run tool' : 'Run preview'}
          </button>
        </div>
      </div>

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
  if (out.error) return <p className="mt-6 text-red-600">⚠ {out.error}</p>;
  const r = out.result || {};

  if (r.needsConnect) {
    return (
      <div className="card mt-6 p-6 text-center">
        <p className="text-slate-600">{r.text || 'Connect your account to use this tool.'}</p>
        <Link to="/integrations" className="btn-primary mt-3 inline-block">Connect in Integrations →</Link>
      </div>
    );
  }

  const hasContent = r.text || r.preview || r.html || (r.rows && r.rows.length) || (r.sections && r.sections.length);
  const sectionTable = r.sections && firstTable(r.sections);

  return (
    <div className="mt-6">
      <div className="dm-no-print mb-2 flex items-center gap-2">
        {r.source === 'live' && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">● Live data</span>}
        {r.source === 'demo' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">● Demo data</span>}
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
        {out.teaser && (
          <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            {r.teaserMessage || 'Preview only — upgrade to see everything.'}
          </div>
        )}

        {r.text && <pre className="whitespace-pre-wrap text-sm text-slate-700">{r.text}</pre>}
        {r.preview && <pre className="whitespace-pre-wrap text-sm text-slate-500">{r.preview}</pre>}
        {r.sections && r.sections.length > 0 && <ResultSections sections={r.sections} />}
        {r.html && <div className="dm-report max-w-none text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: r.html }} />}

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
  const cols = Object.keys(rows[0] || {});
  const [sort, setSort] = useState({ col: null, dir: 1 });
  const numericCol = (c) => rows.every((r) => r[c] === '' || r[c] == null || /^[\d.,$%\sSA-]+$/.test(String(r[c])) === false ? false : !Number.isNaN(parseFloat(String(r[c]).replace(/[^0-9.-]/g, ''))));

  const sorted = useMemo(() => {
    if (!sort.col) return rows;
    const num = numericCol(sort.col);
    return [...rows].sort((a, b) => {
      const av = a[sort.col], bv = b[sort.col];
      const cmp = num ? (parseFloat(String(av).replace(/[^0-9.-]/g, '')) || 0) - (parseFloat(String(bv).replace(/[^0-9.-]/g, '')) || 0) : String(av).localeCompare(String(bv));
      return cmp * sort.dir;
    });
  }, [rows, sort]);

  const onSort = (c) => setSort((s) => ({ col: c, dir: s.col === c ? -s.dir : 1 }));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-slate-400">
          <tr>
            {cols.map((c) => (
              <th key={c} onClick={() => onSort(c)} className="cursor-pointer select-none pb-2 pr-4 capitalize hover:text-slate-600">
                {c}{sort.col === c && <span> {sort.dir > 0 ? '▲' : '▼'}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i} className={`border-t border-slate-100 ${i % 2 ? 'bg-slate-50/50' : ''}`}>
              {cols.map((c) => <td key={c} className="py-1.5 pr-4">{cell(c, row[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 p-2 focus-within:border-brand-500">
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
            className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
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

function Field({ field, value, onChange, autoFocus }) {
  const base = 'mt-1.5 w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none';
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">
        {field.label}{field.required && <span className="text-slate-400"> *</span>}
      </span>
      {field.type === 'tags' ? (
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
