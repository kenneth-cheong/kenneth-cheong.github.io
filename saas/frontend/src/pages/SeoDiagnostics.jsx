import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toolById, tierMeets, LOCATIONS } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api, ApiError } from '../lib/api.js';
import ResultSections from '../components/ResultSections.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import NextSteps from '../components/NextSteps.jsx';
import { toast } from '../lib/ui.js';
import { startSeoDiagnosticsTour, hasSeen, markSeen } from '../lib/tours.js';
import { Loader2, ArrowRight, ArrowLeft, Stethoscope, Compass, TrendingUp } from 'lucide-react';

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

// Bare keywords, because that's now all we ask for — Get rankings fetches the
// numbers. The old placeholder showed `keyword, volume, position, change`, which
// read as a requirement and left people typing figures they didn't have.
const KW_SAMPLE = 'seo services singapore\ncontent marketing agency\nlink building';

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
  const [kwNote, setKwNote] = useState(''); // feedback under the Get rankings button
  const [kwBusy, setKwBusy] = useState(false);
  const [keywords, setKeywords] = useState([]); // {keyword,volume,position,change,_sel}
  const [ga4, setGa4] = useState('');
  const [gsc, setGsc] = useState('');
  // The depth picker is gone — every diagnosis runs the full set of checks.
  const mode = 'advanced';
  const [evidence, setEvidence] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null); // {sections, summary}
  const [runId, setRunId] = useState(null);
  const resultsRef = useRef(null);

  const withBuckets = useMemo(() => keywords.map((k) => ({ ...k, bucket: bucketFor(k) })), [keywords]);
  const selectedCount = keywords.filter((k) => k._sel).length;
  // Columns only appear when there's something in them — a permanently empty Δ
  // column is what made the table look broken.
  const showKd = keywords.some((k) => k.difficulty != null);
  const showChange = keywords.some((k) => k.change != null);
  // "Use my numbers" is the offline path, so only offer it when the paste
  // actually carries numbers to use.
  const hasPastedNumbers = /,\s*-?\d/.test(kwText);

  const routeState = useLocation().state;

  function launchTour() { startSeoDiagnosticsTour(TOOL); }
  // First visit: auto-run the guided tour once.
  useEffect(() => {
    if (!unlocked || routeState?.result || hasSeen('tool:seo-diagnostics')) return;
    const t = setTimeout(() => { if (!hasSeen('tool:seo-diagnostics')) { markSeen('tool:seo-diagnostics'); startSeoDiagnosticsTour(TOOL); } }, 500);
    return () => clearTimeout(t);
  }, [unlocked]);

  // Re-opening a saved run: /runs/:runId (what the "finished" notification and
  // the History rows link at) hands off through ToolRunner, which redirects to
  // this bespoke page with { values, result, runId }. Seed the wizard from the
  // original inputs and jump straight to the diagnosis — nothing is re-run.
  useEffect(() => {
    const saved = routeState?.result;
    if (!saved) return;
    const v = routeState.values || {};
    if (v.input) setDomain(String(v.input));
    if (v.location) setLocation(String(v.location));
    if (v.language) setLanguage(String(v.language));
    if (v.evidence) setEvidence(String(v.evidence));
    if (Array.isArray(v.keywords)) setKeywords(v.keywords);
    if (v.ga4) setGa4(String(v.ga4));
    if (v.gsc) setGsc(String(v.gsc));
    if (!saved.sections) { setError("That result couldn't be re-opened — re-run the diagnosis to see it again."); return; }
    setError(''); setResult(saved); setRunId(routeState.runId || null); setStep(5);
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  }, [routeState]);

  // Auto-select the highest-opportunity buckets — those are what the diagnosis
  // is for, and the SERP lane only checks 8, so selecting everything wastes it.
  function autoSelect(rows) {
    rows.forEach((k) => { const b = bucketFor(k); k._sel = b === 'striking' || b === 'declining' || b === 'page2'; });
    // Nothing under-performing (or nothing ranked yet) — fall back to the biggest
    // volumes rather than handing step 3 an empty selection.
    if (!rows.some((k) => k._sel)) {
      [...rows].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5).forEach((k) => { k._sel = true; });
    }
    return rows;
  }

  // Offline path: use the volume/position/change the user pasted themselves.
  function loadKeywords() {
    const parsed = parseKeywordLines(kwText);
    if (!parsed.length) {
      setKwNote("Couldn't read any keywords from that — one per line, keyword first.");
      return;
    }
    setKeywords(autoSelect(parsed));
    setKwNote(`Using your numbers for ${parsed.length} keyword${parsed.length === 1 ? '' : 's'}.`);
  }

  // Metered path: look up real volume + position so the table isn't a grid of
  // dashes. An empty box means "show me what this domain ranks for".
  async function getRankings() {
    if (!domain.trim()) { setKwNote('Enter your domain in step 1 first — rankings are looked up against it.'); return; }
    const typed = parseKeywordLines(kwText).map((k) => k.keyword);
    setKwBusy(true); setKwNote(typed.length ? `Looking up ${typed.length} keyword${typed.length === 1 ? '' : 's'}…` : `Finding what ${domain.trim()} ranks for…`);
    try {
      const res = await api.runTool('seo-diagnostics', {
        fetchRankings: true, input: domain.trim(), location, language,
        keywords: typed, projectId: active?.id || undefined,
      }, /* slow */ true);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
      const d = res.result || {};
      if (d._failed || !Array.isArray(d.rows) || !d.rows.length) { setKwNote(d.text || 'No keyword data came back — try again in a moment.'); return; }
      const rows = d.rows.map((r) => ({ ...r, _sel: false }));
      setKeywords(autoSelect(rows));
      // Say how many actually rank: "12 of 20" is the number that tells them
      // whether the run will be about improving positions or winning new ones.
      const ranked = typeof d.matched === 'number' ? d.matched : rows.filter((r) => r.position != null).length;
      setKwText(rows.map((r) => r.keyword).join('\n'));
      setKwNote(`${rows.length} keyword${rows.length === 1 ? '' : 's'} loaded — ${ranked} ranking in the top 100 for ${location}.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) { setKwNote('Out of credits — top up to look up rankings.'); toast('Out of credits.', 'error'); }
      else setKwNote('Could not look up rankings: ' + ((e && e.message) || 'unknown error'));
    } finally {
      setKwBusy(false);
    }
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
          <p className="mt-1 text-sm text-dim">
            List the keywords you want diagnosed — <strong className="font-semibold text-body">one per line</strong>. Get rankings then
            looks up each one&apos;s monthly search volume, your current Google position in {location} and its difficulty,
            and sorts them into opportunity buckets: low-hanging fruit, page 2, not ranking, already strong.
          </p>
          <p className="mt-1.5 text-xs text-faint">
            Not sure what to list? Leave the box empty and Get rankings pulls the keywords {domain.trim() || 'your domain'} already
            ranks for. Already have the numbers from Search Console or a rank tracker? Paste them as
            {' '}<code>keyword, volume, position, change</code> and use “Use my numbers” to skip the lookup.
          </p>
          <textarea className="field mt-2" rows={5} value={kwText} onChange={(e) => { setKwText(e.target.value); setKwNote(''); }}
            placeholder={KW_SAMPLE} disabled={busy || kwBusy} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary text-xs" onClick={getRankings} disabled={busy || kwBusy}>
              {kwBusy ? <Loader2 size={14} className="animate-spin" /> : <TrendingUp size={14} />}
              {kwBusy ? 'Looking up…' : 'Get rankings'}
            </button>
            {hasPastedNumbers && <button type="button" className="btn-ghost text-xs" onClick={loadKeywords} disabled={busy || kwBusy}>Use my numbers</button>}
            {keywords.length > 0 && <button type="button" className="btn-ghost text-xs" onClick={diagnoseTop5} disabled={busy || kwBusy}>Diagnose top 5</button>}
            <span className="text-xs text-faint">Costs 1 credit</span>
          </div>
          {kwNote && <p className={`mt-2 text-xs ${keywords.length ? 'text-dim' : 'text-amber-600 dark:text-amber-400'}`}>{kwNote}</p>}
          {keywords.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-faint">
                    <th className="py-1 pr-2"><input type="checkbox" checked={selectedCount === keywords.length}
                      onChange={(e) => setKeywords((ks) => ks.map((k) => ({ ...k, _sel: e.target.checked })))} /></th>
                    <th className="py-1 pr-2">Keyword</th>
                    <th className="py-1 pr-2" title="Average monthly searches">Volume</th>
                    <th className="py-1 pr-2" title="Your current Google position">Position</th>
                    {showKd && <th className="py-1 pr-2" title="Keyword difficulty, 0-100">KD</th>}
                    {showChange && <th className="py-1 pr-2" title="Position change you pasted">Δ</th>}
                    <th className="py-1 pr-2">Opportunity</th>
                  </tr>
                </thead>
                <tbody>
                  {withBuckets.map((k, i) => (
                    <tr key={i} className="border-t border-hair">
                      <td className="py-1 pr-2"><input type="checkbox" checked={!!k._sel}
                        onChange={(e) => setKeywords((ks) => ks.map((x, j) => (j === i ? { ...x, _sel: e.target.checked } : x)))} /></td>
                      <td className="py-1 pr-2 text-body">{k.keyword}</td>
                      {/* An em-dash reads as "we lost your data". Say what the gap
                          actually means: no volume reported, and not in the top 100. */}
                      <td className="py-1 pr-2 text-dim">{k.volume != null ? k.volume.toLocaleString() : <span className="text-faint">No data</span>}</td>
                      <td className="py-1 pr-2 text-dim">{k.position != null ? `#${k.position}` : <span className="text-faint">Not in top 100</span>}</td>
                      {showKd && <td className="py-1 pr-2 text-dim">{k.difficulty ?? <span className="text-faint">—</span>}</td>}
                      {showChange && <td className="py-1 pr-2 text-dim">{k.change ?? <span className="text-faint">—</span>}</td>}
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
            <label className="block text-sm font-medium text-body">Extra evidence <span className="font-normal text-faint">(optional)</span></label>
            <textarea className="field mt-1" rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Paste any crawl exports, known issues or notes to fold into the diagnosis." disabled={busy} />
          </div>
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
          {result?.sections && (
            <NextSteps toolId="seo-diagnostics" tier={user?.tier} context={{ domain, target: domain, inputs: { input: domain } }} />
          )}
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
            <button type="button" className="btn-primary" onClick={() => setStep((s) => s + 1)} disabled={!canNext || busy || kwBusy}>
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
