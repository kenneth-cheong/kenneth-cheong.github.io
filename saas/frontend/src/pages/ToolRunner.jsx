import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toolById, inputsFor, CREDIT_COSTS, PLANS, tierMeets } from '@shared/catalog.mjs';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import UpgradeModal from '../components/UpgradeModal.jsx';

export default function ToolRunner() {
  const { toolId } = useParams();
  const { user, setCredits } = useAuth();
  const tool = toolById(toolId);
  const fields = useMemo(() => (tool ? inputsFor(tool) : []), [tool]);
  // Seed form state with each field's default.
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.default || '']))
  );
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState(null);
  const [modal, setModal] = useState(null);

  if (!tool) return <p>Unknown tool.</p>;
  const unlocked = tierMeets(user.tier, tool.minTier);
  const cost = CREDIT_COSTS[tool.cost] ?? 0;
  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));
  // Every required field must be filled before the run button enables.
  const ready = fields.every((f) => !f.required || String(values[f.name] || '').trim());

  async function run() {
    setBusy(true);
    setOut(null);
    try {
      // `url` mirror kept for adapters/tools that read body.url.
      const res = await api.runTool(tool.id, { ...values, url: values.url || values.input });
      setOut(res);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining);
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
        {!unlocked && (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold uppercase text-amber-700">
            🔒 {PLANS[tool.minTier].name}
          </span>
        )}
      </div>
      <p className="mt-1 text-slate-600">{tool.desc}</p>

      {!unlocked && tool.teaser && (
        <div className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-800">
          ✨ You get <strong>one free preview run</strong> on your own data. Full results unlock with {PLANS[tool.minTier].name}.
        </div>
      )}

      <div className="card mt-6 p-5">
        <div className="space-y-4">
          {fields.map((f) => (
            <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {cost === 0 ? 'Free to run' : `Costs ${cost} credit${cost > 1 ? 's' : ''}`}
          </span>
          <button className="btn-primary" disabled={busy || !ready} onClick={run}>
            {busy ? 'Running…' : unlocked ? 'Run tool' : 'Run preview'}
          </button>
        </div>
      </div>

      {out && <Result out={out} tool={tool} />}

      {modal && (
        <UpgradeModal reason={modal.reason} requiredTier={modal.requiredTier} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function TagInput({ value, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const [bulk, setBulk] = useState(false);
  const tags = String(value || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  // Merge any delimited blob (commas OR newlines) into the existing chips, deduped.
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
            // Pasting a comma/newline list adds each item as its own chip.
            onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[\n,]/.test(t)) { e.preventDefault(); merge(t); } }}
            className="min-w-[140px] flex-1 bg-transparent text-sm outline-none"
          />
        )}
      </div>

      {bulk && (
        <div className="mt-2">
          <textarea
            autoFocus
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'Paste or type one keyword per line…\nrunning shoes\ntrail shoes\nmarathon gear'}
            className="w-full rounded-lg border border-slate-300 p-2.5 text-sm focus:border-brand-500 focus:outline-none"
          />
          <div className="mt-1.5 flex gap-2">
            <button type="button" className="btn-primary px-3 py-1.5 text-xs" onClick={() => { merge(draft); setBulk(false); }}>
              Add keywords
            </button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setDraft(''); setBulk(false); }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => { setDraft(''); setBulk((b) => !b); }}
        className="mt-1.5 text-xs font-medium text-brand-600 hover:text-brand-700"
      >
        {bulk ? '← Back to quick add' : '+ Paste a list (one keyword per line)'}
      </button>
    </div>
  );
}

function Field({ field, value, onChange }) {
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
        <textarea rows={3} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'select' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          inputMode={field.type === 'url' ? 'url' : undefined}
          value={value}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={base}
        />
      )}
    </label>
  );
}

function Result({ out, tool }) {
  if (out.error) return <p className="mt-6 text-red-600">⚠ {out.error}</p>;
  const r = out.result || {};

  return (
    <div className="mt-6">
      {typeof out.creditsUsed === 'number' && out.creditsUsed > 0 && (
        <p className="mb-2 text-right text-xs text-slate-400">
          This run used {out.creditsUsed} credit{out.creditsUsed > 1 ? 's' : ''} · {out.creditsRemaining} remaining
        </p>
      )}
      <div className="card p-5">
        {out.teaser && (
          <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
            {r.teaserMessage || 'Preview only — upgrade to see everything.'}
          </div>
        )}

        {r.text && <pre className="whitespace-pre-wrap text-sm text-slate-700">{r.text}</pre>}
        {r.preview && <pre className="whitespace-pre-wrap text-sm text-slate-500">{r.preview}</pre>}
        {r.html && (
          <div className="max-w-none text-sm text-slate-700" dangerouslySetInnerHTML={{ __html: r.html }} />
        )}

        {r.rows && (
          <>
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400">
                <tr>{Object.keys(r.rows[0] || {}).map((k) => <th key={k} className="pb-2 capitalize">{k}</th>)}</tr>
              </thead>
              <tbody>
                {r.rows.map((row, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    {Object.values(row).map((v, j) => <td key={j} className="py-1.5">{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
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
          </>
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
