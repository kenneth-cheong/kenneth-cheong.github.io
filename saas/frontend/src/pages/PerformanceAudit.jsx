import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toolById, tierMeets } from '@shared/catalog.mjs';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import { api, ApiError } from '../lib/api.js';
import ShareResult from '../components/ShareResult.jsx';
import ReportHtml from '../components/ReportHtml.jsx';
import { toast } from '../lib/ui.js';
import { Loader2, Wand2, Microscope, ScanSearch, X, Plus, Pencil, Check, PlugZap, Compass } from 'lucide-react';
import { renderPerfMarketing, renderPerfMarketingPro, installPmGlobals, pmApplyInteractive, PM_CURRENCIES } from '../lib/pmRender.js';
import { extractFiles } from '../lib/extractFiles.js';
import { startPerfMarketingTour, hasSeen, markSeen } from '../lib/tours.js';
import '@fortawesome/fontawesome-free/css/all.min.css';

const TOOL = toolById('perf-marketing');
const SHARE_TOOL = { id: 'perf-marketing', name: 'Performance Marketing Audit' };
const SHARE_BTN = 'btn-ghost inline-flex items-center gap-1 text-sm';

// Exact platform names the upstream prompt expects (do not shorten — the model
// chooses ONLY from this list).
const PLATFORMS = [
  'Google Search Ads', 'Google Demand Gen / Display', 'Meta Ads (Facebook/Instagram)',
  'TikTok Ads', 'LinkedIn Ads', 'YouTube Ads',
];

// Pro-mode account data fields; the three export fields also accept file uploads.
const PRO_FIELDS = [
  { id: 'conversionTracking', label: 'Conversion tracking status', ph: 'e.g. GA4 + Google Ads conversions imported; Meta pixel + CAPI live' },
  { id: 'cpl', label: 'Current CPL (cost per lead)', ph: 'e.g. S$45' },
  { id: 'cpa', label: 'Current CPA (cost per acquisition)', ph: 'e.g. S$220' },
  { id: 'roas', label: 'Current ROAS', ph: 'e.g. 3.2x' },
  { id: 'landingPages', label: 'Landing page URLs', ph: 'One per line' },
  { id: 'audienceData', label: 'Audience / targeting setup', ph: 'Audiences, exclusions, geo, devices…' },
  { id: 'historical', label: 'Historical performance / trends', ph: 'Last 3–6 months trend, seasonality…' },
  { id: 'creatives', label: 'Current creatives (describe or paste)', ph: 'Formats, hooks, angles running now…' },
];
const PRO_EXPORT_FIELDS = [
  { id: 'googleAds', label: 'Google Ads export', ph: 'Paste campaign/keyword data — or upload the export' },
  { id: 'metaAds', label: 'Meta Ads export', ph: 'Paste ad-set/ad data — or upload the export' },
  { id: 'ga4', label: 'GA4 data', ph: 'Paste channel/conversion data — or upload the export' },
];
const CONNECT_MAP = { googleAds: 'google-ads', ga4: 'ga4', metaAds: 'meta-ads' };

export default function PerformanceAudit() {
  const { user, setCredits } = useAuth();
  const { active } = useProjects();
  const unlocked = TOOL && tierMeets(user.tier, TOOL.minTier);

  const [mode, setMode] = useState('starter');
  // Starter inputs
  const [website, setWebsite] = useState(active?.domain || '');
  const [category, setCategory] = useState('');
  const [country, setCountry] = useState('Singapore');
  const [products, setProducts] = useState('');
  const [audience, setAudience] = useState('');
  const [currency, setCurrency] = useState(PM_CURRENCIES[0]);
  const [budget, setBudget] = useState('');
  const [objectives, setObjectives] = useState('');
  const [platforms, setPlatforms] = useState(() => Object.fromEntries(PLATFORMS.map((p) => [p, false])));
  const [competitors, setCompetitors] = useState('');
  const [rfqNotes, setRfqNotes] = useState('');
  const [aiInstructions, setAiInstructions] = useState('');
  const [files, setFiles] = useState([]);
  // Pro inputs
  const [pro, setPro] = useState(() => Object.fromEntries([...PRO_FIELDS, ...PRO_EXPORT_FIELDS].map((f) => [f.id, ''])));
  const [proFiles, setProFiles] = useState({ googleAds: [], metaAds: [], ga4: [] });

  const [busy, setBusy] = useState(false);
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [autofillMsg, setAutofillMsg] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const [error, setError] = useState('');
  const [resultHtml, setResultHtml] = useState(null);
  const [ranMode, setRanMode] = useState(null);
  const [editing, setEditing] = useState(false);
  const [lastRun, setLastRun] = useState(null); // {runId, out} for share
  const resultsRef = useRef(null);

  useEffect(() => { installPmGlobals(); }, []);
  useEffect(() => { if (resultHtml) pmApplyInteractive(); }, [resultHtml]);

  function launchTour() { startPerfMarketingTour(TOOL); }
  // First visit: auto-run the guided tour once.
  useEffect(() => {
    if (!unlocked || hasSeen('tool:perf-marketing')) return;
    const t = setTimeout(() => { if (!hasSeen('tool:perf-marketing')) { markSeen('tool:perf-marketing'); startPerfMarketingTour(TOOL); } }, 500);
    return () => clearTimeout(t);
  }, [unlocked]);

  const setProField = (id, v) => setPro((s) => ({ ...s, [id]: v }));
  const onCredits = (res) => { if (typeof res?.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining); };

  async function callPm(payload) {
    return api.runTool('perf-marketing', payload, /* slow */ true);
  }

  async function autofill() {
    if (!website.trim()) { setError('Enter the website URL first.'); return; }
    setError(''); setAutofillBusy(true); setAutofillMsg('Reading the website…');
    try {
      const res = await callPm({ action: 'autofill', input: website.trim(), country });
      const d = res.result || {};
      if (d._failed) { setError(d.text || 'Auto-fill failed.'); return; }
      if (d.category && !category.trim()) setCategory(d.category);
      if (d.audience && !audience.trim()) setAudience(d.audience);
      if (d.objectives && !objectives.trim()) setObjectives(d.objectives);
      if (d.marketContext && !rfqNotes.trim()) setRfqNotes('Market context: ' + d.marketContext);
      if (Array.isArray(d.competitors) && d.competitors.length) setCompetitors(d.competitors.join('\n'));
      setAutofillMsg('Done — review the fields below, then run.');
    } catch (e) {
      setError('Auto-fill failed: ' + gateError(e));
    } finally {
      setAutofillBusy(false);
    }
  }

  async function pullConnectors() {
    setError(''); setConnectBusy(true);
    try {
      const res = await callPm({ action: 'connectors_summary', providers: ['google-ads', 'ga4', 'meta-ads'] });
      const d = res.result || {};
      const conn = d.connected || {};
      if (!conn['google-ads'] && !conn.ga4 && !conn['meta-ads']) {
        toast('No ad/analytics accounts connected yet.', 'error');
        return;
      }
      let filled = 0;
      for (const [field, provider] of Object.entries(CONNECT_MAP)) {
        if (d[field]) { setProField(field, d[field]); filled++; }
      }
      toast(filled ? `Pulled live data into ${filled} field${filled > 1 ? 's' : ''}.` : 'Connected, but no recent data to pull.', filled ? 'success' : 'info');
    } catch (e) {
      toast('Could not pull from connected accounts: ' + gateError(e), 'error');
    } finally {
      setConnectBusy(false);
    }
  }

  function gateError(e) {
    if (e instanceof ApiError && e.status === 402) return 'Out of credits — top up to run the audit.';
    return (e && e.message) || 'Something went wrong.';
  }

  async function run() {
    const isPro = mode === 'pro';
    if (!website.trim() || !category.trim() || !audience.trim() || !objectives.trim()) {
      setError('Please fill in Website, Business category, Target audience, and Objectives.');
      return;
    }
    setError(''); setBusy(true); setResultHtml(null); setEditing(false);
    try {
      // Extract any attached context files in the browser (reuses the shared
      // pdf.js / mammoth / XLSX extractor).
      let attachments_context = '';
      if (files.length) attachments_context = await extractFiles(files, 12000, 40000);

      const payload = {
        mode,
        input: website.trim(), category: category.trim(), country: country.trim() || 'Singapore',
        products: products.trim(), audience: audience.trim(), currency,
        budget: budget.trim(), objectives: objectives.trim(),
        platforms: PLATFORMS.filter((p) => platforms[p]),
        competitors: competitors.trim(), rfqNotes: rfqNotes.trim(), aiInstructions: aiInstructions.trim(),
        attachments_context,
        projectId: active?.id || undefined,
      };
      if (isPro) {
        for (const f of PRO_FIELDS) payload[f.id] = pro[f.id].trim();
        for (const f of PRO_EXPORT_FIELDS) {
          const typed = (pro[f.id] || '').trim();
          const fromFiles = await extractFiles(proFiles[f.id] || [], 12000, 30000);
          payload[f.id] = [typed, fromFiles && `FROM UPLOADED FILE(S):\n${fromFiles}`].filter(Boolean).join('\n\n');
        }
      }

      const res = await callPm(payload);
      onCredits(res);
      const d = res.result || {};
      if (d._failed || (!d.pm && !d.sections)) { setError(d.text || 'The audit did not return a usable result. Please try again.'); return; }
      installPmGlobals();
      setResultHtml(isPro ? renderPerfMarketingPro(d.pm || {}) : renderPerfMarketing(d.pm || {}));
      setRanMode(isPro ? 'pro' : 'starter');
      setLastRun({ runId: res.runId || null, out: d });
      if (res.creditsUsed > 0) toast(`−${res.creditsUsed} credit${res.creditsUsed > 1 ? 's' : ''} · ${res.creditsRemaining} left`, 'info');
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (e) {
      setError('Could not generate the analysis: ' + gateError(e));
      if (e instanceof ApiError && e.status === 402) toast('Out of credits — top up to run.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold">Performance Marketing Audit</h1>
        <div className="card mt-6 p-6 text-center">
          <p className="text-dim">{TOOL?.desc}</p>
          <Link to="/pricing" className="btn-primary mt-4 inline-block">Upgrade to run a Performance Marketing Audit</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl pb-12">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">Performance Marketing Audit</h1>
        <button type="button" onClick={launchTour}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
          title="Guided walkthrough">
          <Compass size={14} aria-hidden /> Tour
        </button>
      </div>
      <p className="mt-1 text-dim">
        A paid-media opportunity analysis for a prospect (Starter), or a full account-level 9-area
        diagnosis from your exported/connected data (Pro).
      </p>

      {/* Mode toggle */}
      <div className="card mt-5 p-5" data-tour="pm-mode">
        <div className="inline-flex overflow-hidden rounded-lg border border-brand-200 dark:border-brand-500/30">
          {['starter', 'pro'].map((m) => (
            <button key={m} type="button" onClick={() => setMode(m)} disabled={busy}
              className={`px-4 py-2 text-sm font-bold ${mode === m ? 'bg-brand-600 text-white' : 'bg-surface text-brand-700 dark:text-brand-300'}`}>
              {m === 'starter' ? 'Starter' : 'Pro'}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">
          {mode === 'pro'
            ? 'Account-level diagnosis across tracking, structure, targeting, creative, budget, landing pages & more — from the data you export or pull from connected accounts.'
            : 'Directional opportunity analysis from first-call inputs — channel mix, budget split and paid-media opportunities. No ad-account data needed.'}
        </p>
      </div>

      {/* Business basics */}
      <div className="card mt-4 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Business</h2>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Website URL <span className="text-red-500">*</span></label>
          <div className="mt-1 flex flex-wrap gap-2">
            <input className="field flex-1" style={{ minWidth: 220 }} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://example.com" disabled={busy} />
            <button type="button" onClick={autofill} disabled={busy || autofillBusy} data-tour="pm-autofill" className="btn-ghost text-xs text-brand-700 dark:text-brand-300">
              {autofillBusy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Analyse &amp; auto-fill
            </button>
          </div>
          {autofillMsg && <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{autofillMsg}</p>}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-body">Business category <span className="text-red-500">*</span></label>
            <input className="field mt-1" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. B2B SaaS, dental clinic, e-commerce" disabled={busy} />
          </div>
          <div>
            <label className="block text-sm font-medium text-body">Target country / market</label>
            <input className="field mt-1" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Singapore" disabled={busy} />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Products &amp; services</label>
          <textarea className="field mt-1" rows={2} value={products} onChange={(e) => setProducts(e.target.value)} placeholder="Comma-separated list of what they sell" disabled={busy} />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Target audience <span className="text-red-500">*</span></label>
          <textarea className="field mt-1" rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Who are they trying to reach?" disabled={busy} />
        </div>
      </div>

      {/* Budget & objectives */}
      <div className="card mt-4 p-5" data-tour="pm-budget">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Budget &amp; objectives</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-body">Output currency</label>
            <select className="field mt-1 cursor-pointer" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={busy}>
              {PM_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-body">Monthly budget</label>
            <input className="field mt-1" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="optional — we'll suggest a range" disabled={busy} />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Objectives / goals <span className="text-red-500">*</span></label>
          <textarea className="field mt-1" rows={2} value={objectives} onChange={(e) => setObjectives(e.target.value)} placeholder="e.g. lead generation, online sales, awareness" disabled={busy} />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Platforms to consider</label>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {PLATFORMS.map((p) => (
              <label key={p} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                <input type="checkbox" checked={!!platforms[p]} disabled={busy}
                  onChange={(e) => setPlatforms((s) => ({ ...s, [p]: e.target.checked }))} /> {p}
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* Competitors */}
      <div className="card mt-4 p-5" data-tour="pm-competitors">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Competitors <span className="font-normal normal-case text-faint">(optional)</span></h2>
        <p className="mt-1 text-xs text-faint">One domain per line. We fetch each competitor's Google paid keywords &amp; Meta Ad Library activity and feed it into the analysis.</p>
        <textarea className="field mt-2" rows={3} value={competitors} onChange={(e) => setCompetitors(e.target.value)} placeholder={'competitor-a.com\ncompetitor-b.com'} disabled={busy} />
      </div>

      {/* Context */}
      <div className="card mt-4 p-5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-body">Context <span className="font-normal normal-case text-faint">(optional)</span></h2>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">RFQ / discussion notes</label>
          <textarea className="field mt-1" rows={2} value={rfqNotes} onChange={(e) => setRfqNotes(e.target.value)} placeholder="Pain points, priorities, constraints the prospect mentioned…" disabled={busy} />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Priority instructions to the AI</label>
          <textarea className="field mt-1" rows={2} value={aiInstructions} onChange={(e) => setAiInstructions(e.target.value)} placeholder="Anything the analysis must emphasise or avoid" disabled={busy} />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-medium text-body">Attach briefs / documents</label>
          <FileField files={files} setFiles={setFiles} disabled={busy} accept=".pdf,.docx,.txt,.csv,.md,.xlsx"
            hint="PDF, DOCX, TXT, CSV or XLSX. Text is extracted in your browser and fed to the analysis." />
        </div>
      </div>

      {/* Pro fields */}
      {mode === 'pro' && (
        <div className="card mt-4 p-5" data-tour="pm-pro">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-body">Account data (Pro)</h2>
            <button type="button" onClick={pullConnectors} disabled={busy || connectBusy} className="btn-ghost text-xs text-brand-700 dark:text-brand-300">
              {connectBusy ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />} Pull from connected accounts
            </button>
          </div>
          <p className="mt-1 text-xs text-faint">Paste what you have or upload exports; leave the rest blank. Or pull live data from your <Link to="/integrations" className="text-brand-600 dark:text-brand-400 underline">connected Google Ads / GA4 / Meta</Link> accounts.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {PRO_FIELDS.map((f) => (
              <div key={f.id}>
                <label className="block text-sm font-medium text-body">{f.label}</label>
                <textarea className="field mt-1" rows={2} value={pro[f.id]} disabled={busy}
                  onChange={(e) => setProField(f.id, e.target.value)} placeholder={f.ph} />
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-3">
            {PRO_EXPORT_FIELDS.map((f) => (
              <div key={f.id}>
                <label className="block text-sm font-medium text-body">{f.label}</label>
                <textarea className="field mt-1" rows={2} value={pro[f.id]} disabled={busy}
                  onChange={(e) => setProField(f.id, e.target.value)} placeholder={f.ph} />
                <FileField compact files={proFiles[f.id]} disabled={busy} accept=".pdf,.docx,.txt,.csv,.xlsx"
                  setFiles={(updater) => setProFiles((s) => ({ ...s, [f.id]: typeof updater === 'function' ? updater(s[f.id]) : updater }))}
                  hint="Upload exports — PDF, DOCX, TXT, CSV or XLSX" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run */}
      <div className="mt-5 flex flex-wrap items-center gap-3" data-tour="pm-run">
        <button onClick={run} disabled={busy} className="btn-primary">
          {busy ? <Loader2 size={16} className="animate-spin" /> : (mode === 'pro' ? <Microscope size={16} /> : <ScanSearch size={16} />)}
          {busy ? (mode === 'pro' ? 'Diagnosing…' : 'Analysing…') : (mode === 'pro' ? 'Run Pro Audit' : 'Generate Opportunity Analysis')}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Results */}
      <div ref={resultsRef} className="mt-6 space-y-4">
        {resultHtml && lastRun && (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing((v) => !v)} className={SHARE_BTN}>
              {editing ? <><Check size={14} /> Done editing</> : <><Pencil size={14} /> Edit result</>}
            </button>
            {lastRun.runId && (
              <ShareResult tool={SHARE_TOOL} out={lastRun.out} project={active} user={user} force snapshot label="Share result" className={SHARE_BTN} />
            )}
          </div>
        )}
        {resultHtml && (
          <div contentEditable={editing} suppressContentEditableWarning
            className={editing ? 'rounded-lg outline outline-2 outline-brand-400 outline-offset-4' : ''}>
            <ReportHtml html={resultHtml} className="" />
          </div>
        )}
      </div>
    </div>
  );
}

// File picker + removable chips. `setFiles` accepts a value or an updater fn.
function FileField({ files, setFiles, disabled, accept, hint, compact }) {
  const onPick = (e) => {
    const picked = Array.from(e.target.files || []);
    if (!picked.length) return;
    setFiles((prev) => {
      const existing = new Set((prev || []).map((f) => f.name));
      return [...(prev || []), ...picked.filter((f) => !existing.has(f.name))];
    });
    e.target.value = '';
  };
  return (
    <div className={compact ? 'mt-1.5' : 'mt-2'}>
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-dashed border-brand-300 dark:border-brand-500/40 px-3 py-1.5 text-xs font-semibold text-brand-700 dark:text-brand-300">
        <Plus size={13} /> Add file
        <input type="file" multiple accept={accept} onChange={onPick} disabled={disabled} className="hidden" />
      </label>
      {(files || []).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs">
              <span className="max-w-[180px] truncate" title={f.name}>{f.name}</span>
              <button type="button" className="text-faint hover:text-red-500" disabled={disabled}
                onClick={() => setFiles((prev) => (prev || []).filter((_, j) => j !== i))} aria-label="Remove file"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      {hint && <p className="mt-1 text-[11px] text-faint">{hint}</p>}
    </div>
  );
}
