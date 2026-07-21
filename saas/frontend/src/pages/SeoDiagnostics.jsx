import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toolById, tierMeets, LOCATIONS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api, ApiError } from '../lib/api.js';
import ResultSections from '../components/ResultSections.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import { toast } from '../lib/ui.js';
import { startSeoDiagnosticsTour, hasSeen, markSeen } from '../lib/tours.js';
import { Loader2, ArrowRight, ArrowLeft, Stethoscope, Compass } from 'lucide-react';

// Locations come from the shared catalog rather than a list of this page's own.
// The local list carried 14 markets and no European country except the UK, so
// anyone targeting Europe had to pick "Global" — which is not the same audience.
// The catalog list is the one that's been smoke-tested against the upstreams.
const SDX_LANGUAGES = ['English', 'Chinese', 'Malay', 'Indonesian', 'Thai', 'Vietnamese', 'Tagalog', 'Hindi'];

const TOOL = toolById('seo-diagnostics');
const SHARE_TOOL = { id: 'seo-diagnostics', name: 'SEO Diagnostics' };

// Keyword opportunity buckets — mirrors the backend sdxBucketFor().
const BUCKETS = {
  striking:  { label: 'Low-hanging fruit', hint: 'Pos 4-15', tone: 'text-emerald-600 dark:text-emerald-400', order: 1 },
  declining: { label: 'Declining', hint: 'Dropped 3+', tone: 'text-red-600 dark:text-red-400', order: 2 },
  page2:     { label: 'Page 2+', hint: 'Pos 16-30', tone: 'text-amber-600 dark:text-amber-400', order: 3 },
  missing:   { label: 'Not ranking', hint: 'Has volume', tone: 'text-indigo-600 dark:text-indigo-400', order: 4 },
  strong:    { label: 'Already strong', hint: 'Pos 1-3', tone: 'text-dim', order: 5 },
  other:     { label: 'Other', hint: 'Low volume', tone: 'text-faint', order: 6 },
};
function bucketFor(k) {
  const pos = k.position, ch = k.change || 0, vol = k.volume || 0;
  if (pos != null && pos >= 1 && pos <= 3) return 'strong';
  if (ch <= -3 && pos != null && pos <= 30) return 'declining';
  if (pos != null && pos >= 4 && pos <= 15) return 'striking';
  if (pos != null && pos >= 16 && pos <= 30) return 'page2';
  if ((pos == null || pos > 30) && vol > 0) return 'missing';
  return 'other';
}
// Parse "keyword, volume, position, change" lines (numbers optional & positional).
function parseKeywordLines(text) {
  return String(text || '').split('\n').map((line) => {
    const raw = line.trim();
    if (!raw) return null;
    const parts = raw.split(',').map((s) => s.trim());
    const keyword = parts[0];
    if (!keyword) return null;
    const nums = parts.slice(1).map((p) => (p === '' ? null : Number(p))).filter((n) => n === null || !Number.isNaN(n));
    const [volume = null, position = null, change = null] = nums;
    return { keyword, volume, position, change, _sel: false };
  }).filter(Boolean);
}

const STEPS = ['Target', 'Keywords', 'GA4 & GSC', 'Checks', 'Diagnosis'];

export default function SeoDiagnostics() {
  const { user, setCredits } = useAuth();
  const { active } = useProjects();
  const unlocked = TOOL && tierMeets(user.tier, TOOL.minTier);

  const [step, setStep] = useState(1);
  const [domain, setDomain] = useState(active?.domain || '');
  const [location, setLocation] = useState('Singapore');
  const [language, setLanguage] = useState('English');
  const [kwText, setKwText] = useState('');
  const [keywords, setKeywords] = useState([]); // {keyword,volume,position,change,_sel}
  const [ga4, setGa4] = useState('');
  const [gsc, setGsc] = useState('');
  const [mode, setMode] = useState('starter');
  const [evidence, setEvidence] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // {sections, summary}
  const [runId, setRunId] = useState(null);
  const resultsRef = useRef(null);

  const withBuckets = useMemo(() => keywords.map((k) => ({ ...k, bucket: bucketFor(k) })), [keywords]);
  const selectedCount = keywords.filter((k) => k._sel).length;

  function launchTour() { startSeoDiagnosticsTour(TOOL); }
  // First visit: auto-run the guided tour once.
  useEffect(() => {
    if (!unlocked || hasSeen('tool:seo-diagnostics')) return;
    const t = setTimeout(() => { if (!hasSeen('tool:seo-diagnostics')) { markSeen('tool:seo-diagnostics'); startSeoDiagnosticsTour(TOOL); } }, 500);
    return () => clearTimeout(t);
  }, [unlocked]);

  function loadKeywords() {
    const parsed = parseKeywordLines(kwText);
    // Auto-select the highest-opportunity buckets by default.
    parsed.forEach((k) => { const b = bucketFor(k); k._sel = b === 'striking' || b === 'declining' || b === 'page2'; });
    setKeywords(parsed);
  }
  function diagnoseTop5() {
    const ranked = [...withBuckets].sort((a, b) => (BUCKETS[a.bucket].order - BUCKETS[b.bucket].order) || ((b.volume || 0) - (a.volume || 0)));
    const top5 = new Set(ranked.slice(0, 5).map((k) => k.keyword));
    setKeywords((ks) => ks.map((k) => ({ ...k, _sel: top5.has(k.keyword) })));
  }

  async function run() {
    if (!domain.trim()) { setError('Enter a domain first.'); setStep(1); return; }
    setError(''); setBusy(true); setResult(null);
    try {
      const res = await api.runTool('seo-diagnostics', {
        input: domain.trim(), location, language,
        keywords: withBuckets, ga4: ga4.trim(), gsc: gsc.trim(),
        mode, evidence: evidence.trim(), projectId: active?.id || undefined,
      }, /* slow */ true);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
      const d = res.result || {};
      if (d._failed || !d.sections) { setError(d.text || 'The diagnosis did not return a usable result. Please try again.'); return; }
      setResult(d); setRunId(res.runId || null); setStep(5);
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) { setError('Out of credits — top up to run the diagnosis.'); toast('Out of credits.', 'error'); }
      else setError('Could not run the diagnosis: ' + ((e && e.message) || 'unknown error'));
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">SEO Diagnostics</h1>
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">{TOOL?.desc}</p>
          <Link to="/pricing" className="btn-primary mt-4 inline-block">Upgrade to run SEO Diagnostics</Link>
        </div>
      </div>
    );
  }

  const canNext = step === 1 ? domain.trim() : step === 2 ? keywords.length > 0 : true;

  return (
    <div className="mx-auto max-w-3xl pb-12">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">SEO Diagnostics</h1>
        <button type="button" onClick={launchTour}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
          title="Guided walkthrough">
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-dim">A guided keyword-to-fix audit: flag under-performing keywords, layer in your GA4/Search Console context and technical checks, and get a prioritised diagnosis.</p>

      {/* Stepper */}
      <ol data-tour="sdx-stepper" className="mt-5 flex flex-wrap gap-2 text-xs font-semibold">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = n < step, current = n === step;
          return (
            <li key={label}>
              <button type="button" onClick={() => n <= step && setStep(n)} disabled={n > step}
                className={`rounded-full px-3 py-1.5 ${current ? 'bg-brand-600 text-white' : done ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300' : 'bg-surface text-faint'}`}>
                {n}. {label}
              </button>
            </li>
          );
        })}
      </ol>

      {/* Step 1 — Target */}
      {step === 1 && (
        <div className="card mt-4 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Choose your target</h2>
          <div className="mt-3" data-tour="sdx-domain">
            <label className="block text-sm font-medium text-body">Domain <span className="text-red-500">*</span></label>
            <input className="field mt-1" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" disabled={busy} />
            {active?.domain && <button type="button" className="mt-1.5 text-xs text-brand-600 dark:text-brand-400" onClick={() => setDomain(active.domain)}>Use current project ({active.domain})</button>}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-body">Location</label>
              <SearchableSelect options={LOCATIONS} value={location} onChange={setLocation} />
            </div>
            <div>
              <label className="block text-sm font-medium text-body">Language</label>
              <select className="field mt-1 cursor-pointer" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {SDX_LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Step 2 — Keywords */}
      {step === 2 && (
        <div className="card mt-4 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Flag under-performing keywords</h2>
          <p className="mt-1 text-xs text-faint">Paste your keywords — one per line, as <code>keyword, volume, position, change</code> (numbers optional). We bucket them by opportunity.</p>
          <textarea className="field mt-2" rows={5} value={kwText} onChange={(e) => setKwText(e.target.value)}
            placeholder={'seo services singapore, 480, 8, -2\ncontent marketing agency, 320, 18\nlink building, 210, 45'} disabled={busy} />
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost text-xs" onClick={loadKeywords} disabled={busy}>Load keywords</button>
            {keywords.length > 0 && <button type="button" className="btn-ghost text-xs" onClick={diagnoseTop5} disabled={busy}>Diagnose top 5</button>}
          </div>
          {keywords.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-faint">
                    <th className="py-1 pr-2"><input type="checkbox" checked={selectedCount === keywords.length}
                      onChange={(e) => setKeywords((ks) => ks.map((k) => ({ ...k, _sel: e.target.checked })))} /></th>
                    <th className="py-1 pr-2">Keyword</th><th className="py-1 pr-2">Vol</th><th className="py-1 pr-2">Pos</th><th className="py-1 pr-2">Δ</th><th className="py-1 pr-2">Opportunity</th>
                  </tr>
                </thead>
                <tbody>
                  {withBuckets.map((k, i) => (
                    <tr key={i} className="border-t border-hair">
                      <td className="py-1 pr-2"><input type="checkbox" checked={!!k._sel}
                        onChange={(e) => setKeywords((ks) => ks.map((x, j) => (j === i ? { ...x, _sel: e.target.checked } : x)))} /></td>
                      <td className="py-1 pr-2 text-body">{k.keyword}</td>
                      <td className="py-1 pr-2 text-dim">{k.volume ?? '—'}</td>
                      <td className="py-1 pr-2 text-dim">{k.position ?? '—'}</td>
                      <td className="py-1 pr-2 text-dim">{k.change ?? '—'}</td>
                      <td className={`py-1 pr-2 font-semibold ${BUCKETS[k.bucket].tone}`}>{BUCKETS[k.bucket].label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-faint">{selectedCount} selected · the live SERP landscape checks up to 8 selected keywords.</p>
            </div>
          )}
        </div>
      )}

      {/* Step 3 — GA4 & GSC */}
      {step === 3 && (
        <div className="card mt-4 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">GA4 &amp; Search Console context <span className="font-normal normal-case text-faint">(optional)</span></h2>
          <p className="mt-1 text-xs text-faint">Paste an export or summary from GA4 and/or Search Console. It sharpens the diagnosis and the AI action plan. Leave blank to skip.</p>
          <div className="mt-3">
            <label className="block text-sm font-medium text-body">GA4 data</label>
            <textarea className="field mt-1" rows={4} value={ga4} onChange={(e) => setGa4(e.target.value)} placeholder="Sessions, engagement, conversions by channel / landing page…" disabled={busy} />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium text-body">Search Console data</label>
            <textarea className="field mt-1" rows={4} value={gsc} onChange={(e) => setGsc(e.target.value)} placeholder="Top queries / pages with clicks, impressions, CTR, position…" disabled={busy} />
          </div>
        </div>
      )}

      {/* Step 4 — Checks */}
      {step === 4 && (
        <div className="card mt-4 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-body">Technical checks</h2>
          <p className="mt-1 text-xs text-faint">We run page speed, performance grade, SSL, on-page (schema/meta/headings), robots/llms.txt, backlinks and a live SERP landscape against your domain, then diagnose.</p>
          <div className="mt-3">
            <label className="block text-sm font-medium text-body">Depth</label>
            <div className="mt-1 inline-flex overflow-hidden rounded-lg border border-brand-200 dark:border-brand-500/30">
              {['starter', 'pro', 'advanced'].map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)} disabled={busy}
                  className={`px-4 py-2 text-sm font-bold capitalize ${mode === m ? 'bg-brand-600 text-white' : 'bg-surface text-brand-700 dark:text-brand-300'}`}>{m}</button>
              ))}
            </div>
          </div>
          {mode !== 'starter' && (
            <div className="mt-3">
              <label className="block text-sm font-medium text-body">Extra evidence <span className="font-normal text-faint">(optional)</span></label>
              <textarea className="field mt-1" rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Paste any crawl exports, known issues or notes to fold into the diagnosis." disabled={busy} />
            </div>
          )}
          <div className="mt-4 flex items-center gap-3">
            <button onClick={run} disabled={busy} className="btn-primary">
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Stethoscope size={16} />}
              {busy ? 'Diagnosing…' : 'Run diagnosis'}
            </button>
          </div>
        </div>
      )}

      {/* Step 5 — Diagnosis */}
      {step === 5 && (
        <div ref={resultsRef} className="mt-4 space-y-4">
          {runId && (
            <div className="dm-no-print flex justify-end gap-2">
              <PdfButton targetRef={resultsRef} className="btn-ghost inline-flex items-center gap-1 text-sm" />
              {/* `out` is a result ENVELOPE ({ result }), not the raw payload —
                  passing the payload bare leaves the card blank and makes the
                  public-link mint post an empty snapshot (rejected as invalid). */}
              <ShareResult tool={SHARE_TOOL} out={{ result }} project={active} user={user} force snapshot label="Share result" className="btn-ghost inline-flex items-center gap-1 text-sm" />
            </div>
          )}
          {result?.sections && <PrintBrand title="SEO Diagnostics" subtitle={domain} project={active} user={user} />}
          {result?.sections ? <ResultSections sections={result.sections} context={{ toolName: 'SEO Diagnostics', domain, target: domain }} /> : <p className="text-dim">No diagnosis yet.</p>}
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Nav */}
      {step < 5 && (
        <div className="mt-5 flex items-center justify-between">
          <button type="button" className="btn-ghost text-sm" onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1 || busy}>
            <ArrowLeft size={14} /> Back
          </button>
          {step < 4 && (
            <button type="button" className="btn-primary" onClick={() => { if (step === 2 && !keywords.length) loadKeywords(); setStep((s) => s + 1); }} disabled={!canNext || busy}>
              Next <ArrowRight size={14} />
            </button>
          )}
        </div>
      )}
      {step === 5 && (
        <div className="mt-5">
          <button type="button" className="btn-ghost text-sm" onClick={() => { setStep(4); }}>
            <ArrowLeft size={14} /> Adjust &amp; re-run
          </button>
        </div>
      )}
    </div>
  );
}
