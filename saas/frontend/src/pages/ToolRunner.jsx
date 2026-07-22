import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, Link, useLocation, useNavigate, Navigate } from 'react-router-dom';
import { toolById, inputsFor, tabsFor, exampleFor, CREDIT_COSTS, costPerRun, etaLabel, etaTypical, runSteps, PLANS, tierMeets, isSchedulable, scheduleLimits, FIELD_GROUPS } from '@shared/catalog.mjs';
import { api, ApiError } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProjects } from '../context/ProjectContext.jsx';
import UpgradeModal from '../components/UpgradeModal.jsx';
import Modal from '../components/Modal.jsx';
import ResultSections from '../components/ResultSections.jsx';
import ReportHtml from '../components/ReportHtml.jsx';
import SchemaResult from '../components/SchemaResult.jsx';
import SortableTable from '../components/SortableTable.jsx';
import ShareResult from '../components/ShareResult.jsx';
import PrintBrand, { PdfButton } from '../components/PdfExport.jsx';
import ConnectPrompt, { connectReasonFor } from '../components/ConnectPrompt.jsx';
import { useIntegrationGate, IntegrationGate } from '../components/IntegrationGate.jsx';
import { suppressFault } from '../lib/diagnostics.js';
import InfoTip, { glossaryFor } from '../components/InfoTip.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import { toast, copyText, downloadCsv, fmtNum, pushRecent, saveLastInput, loadLastInput } from '../lib/ui.js';
import { startToolTour, sampleResultFor, hasSeen, markSeen } from '../lib/tours.js';
import { Lock, Compass, Sparkles, AlertTriangle, Clock, ChevronRight, Check, MessageCircleQuestion, ThumbsUp, ThumbsDown, Loader2, Plus } from 'lucide-react';

// Tell the proactive assistant a run finished. Status is a coarse read of the
// payload so triggers can distinguish "here are your results" from "nothing came
// back" without every tool needing a bespoke shape.
function runStatusOf(res) {
  const r = res?.result;
  if (r == null) {
    const meaningful = res && Object.keys(res).some((k) => !['creditsUsed', 'creditsRemaining', 'topupRemaining'].includes(k));
    return meaningful ? 'success' : 'empty';
  }
  if (Array.isArray(r)) return r.length ? 'success' : 'empty';
  if (Array.isArray(r.rows)) return r.rows.length ? 'success' : 'empty';
  if (Array.isArray(r.data)) return r.data.length ? 'success' : 'empty';
  if (typeof r === 'object') return Object.keys(r).length ? 'success' : 'empty';
  return 'success';
}
function emitRunFinished(toolName, status) {
  window.dispatchEvent(new CustomEvent('dm:proactive-event', { detail: { event: 'run_finished', status, toolName } }));
}

// Runs one tool: the config form, the (metered, streaming, job-polling) run
// engine, and the results renderer. Normally a routed PAGE, but it also mounts
// INSIDE the run modal (`embedded`) so the whole run+results experience can stay
// on the dashboard — same engine, no duplication. `embedded` mode takes its tool
// from props instead of the route and drops the page chrome (back link, h1,
// auto-tour); everything else is shared, so the page path is unchanged.
export default function ToolRunner({ toolId: toolIdProp, initialValues, embedded = false, onClose } = {}) {
  const params = useParams();
  const toolId = toolIdProp ?? params.toolId;
  const { user, setCredits } = useAuth();
  const { activeId, active } = useProjects();
  const tool = toolById(toolId);
  const location = useLocation();
  const navigate = useNavigate();
  const tabs = useMemo(() => tabsFor(tool), [tool]);
  const [tab, setTab] = useState(0);
  const activeTab = tabs?.[tab];
  const fields = useMemo(() => (tabs ? activeTab?.fields || [] : tool ? inputsFor(tool) : []), [tool, tabs, activeTab]);

  // Smart default for a tool's site/URL field: the active project's domain, so
  // beginners don't have to know/paste their own site. Returns '' for non-site
  // fields (a site field is url-typed, named domain/website/target, or a text
  // field whose placeholder is a domain example — excludes free-text like a topic).
  const siteDefault = (f) => {
    const dom = (active?.domain || '').trim();
    if (!dom) return '';
    const bare = dom.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (f.type === 'url') return /^https?:\/\//.test(dom) ? dom : `https://${bare}`;
    const looksSite = ['domain', 'website', 'target'].includes(f.name)
      || (f.type !== 'textarea' && /example\.com|yoursite|https?:\/\//i.test(f.placeholder || ''));
    return looksSite ? bare : '';
  };
  const seedValues = () => {
    const fromHistory = embedded ? initialValues : location.state?.values;
    const last = fromHistory ? {} : (loadLastInput(toolId) || {});
    // Site/URL field ALWAYS defaults to the active project's domain — never a
    // stale last-run value from a different project (which confused beginners).
    // Other fields keep their last-used value → default.
    return Object.fromEntries(fields.map((f) => {
      const p = siteDefault(f);
      if (f.name in (fromHistory || {})) return [f.name, fromHistory[f.name]];
      if (p) return [f.name, p];
      // Staff-only switches never carry over. The content optimiser's "Generate
      // with" is the reason: tick Haiku AND DeepSeek once to compare quality and
      // last-input silently re-ticked both on every run afterwards — doubling the
      // AI cost and the runtime indefinitely, with nothing on screen to say so.
      // A power-user toggle should be a per-run decision, not a sticky one.
      if (f.staffOnly) return [f.name, f.default ?? ''];
      return [f.name, last[f.name] ?? f.default ?? ''];
    }));
  };
  const [values, setValues] = useState(seedValues);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null); // live server-side progress for async-job tools
  const [reconciling, setReconciling] = useState(false); // lost the connection — checking whether the run finished anyway
  const [nudge, setNudge] = useState(false); // highlight missing required fields after an incomplete run attempt
  const [out, setOut] = useState(!embedded && location.state?.result ? { result: location.state.result, runId: location.state.runId } : null);
  const [modal, setModal] = useState(null);
  // Pending destructive Search Console op, awaiting an explicit yes.
  const [confirmOp, setConfirmOp] = useState(null);
  const [showAdv, setShowAdv] = useState(false); // reveal collapsed optional fields on long forms
  const gate = useIntegrationGate(tool.integration); // integration tools: no connection = no run
  const [suggesting, setSuggesting] = useState(null); // field name whose "AI suggest" is in flight
  const suggestCache = useRef({ key: '', data: null }); // one crawl per source URL, shared by every suggestible field
  const shownRef = useRef([]); // latest visible fields, for the auto-started tour
  // Fields the user has typed in. The project-domain effect below must not
  // overwrite these: someone auditing a different site typed their address in and
  // watched every tool re-fill itself with their existing project's domain.
  const editedRef = useRef(new Set());

  // Reset the form + result when navigating between tools (same route component).
  useEffect(() => { setTab(0); editedRef.current = new Set(); setValues(seedValues()); setNudge(false); setOut(!embedded && location.state?.result ? { result: location.state.result, runId: location.state.runId } : null); /* eslint-disable-next-line */ }, [toolId]);

  // The active project often loads AFTER first render, so the initial seed can
  // miss the domain and fall back to a stale value. Once the project's domain is
  // known (or changes), (re)apply it to the site field — but never clobber a run
  // in progress, a shown result, or a value the user has already edited.
  const projDomain = active?.domain || '';
  useEffect(() => {
    if (!projDomain || busy || out) return;
    setValues((v) => {
      const next = { ...v };
      for (const f of fields) {
        const p = siteDefault(f);
        if (p && p !== v[f.name] && !editedRef.current.has(f.name)) next[f.name] = p;
      }
      return next;
    });
    // eslint-disable-next-line
  }, [projDomain, toolId]);

  // First tool a user ever opens → auto-run that tool's guided tour, once.
  // Never inside the modal — a driver.js tour over a portalled dialog is a mess.
  useEffect(() => {
    if (embedded || !tool || hasSeen('tool:any')) return;
    const t = setTimeout(() => {
      if (hasSeen('tool:any')) return;
      markSeen('tool:any');
      launchTour(shownRef.current);
    }, 700);
    return () => clearTimeout(t);
    /* eslint-disable-next-line */
  }, [toolId]);

  if (!tool) return <p>Unknown tool.</p>;
  // Tools with a bespoke page (e.g. Social Media Audit) render at their own
  // route, not the generic runner — redirect if someone lands here directly.
  // (Embedded never gets a route tool — the card/palette navigate for those —
  // but if it somehow does, hand off to the page instead of rendering nothing.)
  if (tool.route) { if (embedded) { onClose?.(); navigate(tool.route); return null; } return <Navigate to={tool.route} replace />; }
  const unlocked = tierMeets(user.tier, tool.minTier);
  // Only the guided tour's sample result needs a number now — the form itself no
  // longer prices the run. Fan-out aware so the tour's "used N" matches what a
  // real run of rank-checker & friends (per-keyword billing) would charge.
  const cost = costPerRun(tool, values);
  const set = (name, v) => { editedRef.current.add(name); setNudge(false); setValues((s) => ({ ...s, [name]: v })); };
  // Switch GSC sub-tool tab: clear the previous result, seed any new fields'
  // defaults, but keep shared values (e.g. the selected property) across tabs.
  function selectTab(i) {
    setTab(i);
    setOut(null);
    setValues((v) => { const next = { ...v }; for (const f of tabs[i].fields) if (!(f.name in next)) next[f.name] = f.default ?? ''; return next; });
  }
  const isVisible = (f) => (!f.staffOnly || user.isAdmin) && (!f.showWhen || (f.showWhen.in || []).includes(values[f.showWhen.field]));
  const shown = fields.filter(isVisible);
  shownRef.current = shown;
  const missing = shown.filter((f) => f.required && !String(values[f.name] || '').trim());
  const ready = missing.length === 0;
  const isMissing = (f) => nudge && missing.includes(f);

  // Monty's [[tool:…]] chip hands off with `autorun` — it can't run tools itself,
  // so the chip has to finish the job rather than dropping the user on a form and
  // calling it "running it for you". Only auto-start when the form is genuinely
  // complete; otherwise leave it filled in and let them press the button, since
  // this spends credits.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!location.state?.autorun || autoRanRef.current || embedded || busy || out) return;
    if (missing.length) { setNudge(true); return; }
    autoRanRef.current = true;
    // Drop the flag from history first: a back-navigation or refresh must not
    // silently spend credits a second time.
    navigate(location.pathname, { replace: true, state: { values: location.state.values } });
    run();
    // eslint-disable-next-line
  }, [location.state, missing.length]);


  // Run was clicked without the required fields → don't disable silently. Light up
  // the empty required fields in amber and scroll to the first one (matches the
  // goal-picker's "self-teaching" nudge instead of a dead, greyed-out button).
  function attemptRun() {
    if (!ready) {
      setNudge(true);
      document.querySelector(`[data-tour-field="${missing[0]?.name}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    run();
  }

  // Long forms overwhelm beginners: keep required fields + the first couple of
  // optional ones visible, and tuck the rest behind an "Advanced options" toggle.
  // Fields flagged `advanced` in the catalog (raw GAQL, expert knobs) collapse
  // even on short forms — they should never sit in a beginner's first view.
  // `primary` is the escape hatch: a box that IS the job but isn't technically
  // required (the Optimiser takes a URL *or* pasted text *or* an upload, so none
  // of the three can be `required`) must never end up hidden behind the toggle.
  const optionalShown = shown.filter((f) => !f.required && !f.primary);
  const collapseForm = shown.length >= 8 && optionalShown.length >= 5;
  const advSet = new Set([
    ...(collapseForm ? optionalShown.slice(2) : []),
    ...optionalShown.filter((f) => f.advanced),
  ]);
  const primaryFields = shown.filter((f) => !advSet.has(f));
  const advancedFields = shown.filter((f) => advSet.has(f));
  // Boxes one "AI suggest" pass can draft. Several of them → one shared button,
  // which sits above the first of them wherever that lands (an "advanced" box
  // included — otherwise a collapsed form would hide the button entirely).
  const suggestGroup = unlocked ? shown.filter((f) => f.suggest) : [];
  const suggestAnchor = suggestGroup.length > 1
    ? (primaryFields.find((f) => f.suggest) || advancedFields.find((f) => f.suggest))
    : null;
  const example = exampleFor(tool.id);
  // Consecutive fields sharing a catalog `group` render as one titled block
  // ("How do you want to give us the content?") with "or" between them. A group
  // that ends up with a single visible field (the others hidden by `showWhen`)
  // falls back to a plain field — a one-item "pick any one of these" box lies.
  const groupRuns = (list) => list.reduce((runs, f) => {
    const last = runs[runs.length - 1];
    if (f.group && last && last.group === f.group) last.fields.push(f);
    else runs.push({ group: f.group, fields: [f] });
    return runs;
  }, []);
  // One crawl fills every suggestible box, so several buttons that all do the
  // same thing is just noise: show a single one above the first of them instead.
  // Tools with one such box keep the button on that box's own label.
  const renderField = (f, opts = {}) => (
    <>
      {f === suggestAnchor && <SuggestStrip busy={suggesting === '*'} onClick={() => suggestField(suggestAnchor, suggestGroup)} />}
      <Field field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} setValue={set} autoFocus={opts.autoFocus} provider={tool.integration} values={values}
        invalid={isMissing(f)} labelOverride={opts.grouped ? f.groupLabel : null}
        onSuggest={unlocked && f.suggest && suggestGroup.length === 1 ? () => suggestField(f) : null} suggesting={suggesting === f.name} />
    </>
  );

  function fillExample() {
    if (!example) return;
    setValues((s) => ({ ...s, ...example }));
    toast('Example filled in', 'info');
  }

  // ── "AI suggest" on a long optional box (catalog `suggest: true`) ──────────
  // A blank textarea tells a beginner nothing about what to write or what the
  // result will look like. The tool's `action:'suggest'` reads their site and
  // drafts every suggestible field in one free pass; we cache that pass per
  // source URL so the second and third buttons fill instantly, and the user is
  // always left with editable text rather than a committed run.
  // `group` (set when a tool has several suggestible boxes) makes ONE button
  // serve all of them: same single crawl, every box filled from it. `f` is then
  // just the first box — the one whose source field and options we go by.
  async function suggestField(f, group = null) {
    // `suggest` is either `true` (defaults) or `{ from, label, append }`.
    const opt = typeof f.suggest === 'object' && f.suggest ? f.suggest : {};
    const srcName = opt.from || f.suggestFrom || 'input';
    const src = String(values[srcName] || '').trim();
    if (!src) {
      setNudge(true);
      document.querySelector(`[data-tour-field="${srcName}"] input`)?.focus();
      document.querySelector(`[data-tour-field="${srcName}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Enter your website URL first, then AI suggest.', 'info');
      return;
    }
    setSuggesting(group ? '*' : f.name);
    try {
      // `append` fields (SEM keywords) feed their own current value back in as
      // seeds, so the answer changes every click — caching would defeat both the
      // expansion and the "click again for more" behaviour. Everyone else shares
      // one crawl per source URL, so the 2nd and 3rd buttons fill instantly.
      const cacheKey = `${tool.id}|${src}`;
      let data = !opt.append && suggestCache.current.key === cacheKey ? suggestCache.current.data : null;
      if (!data) {
        // Send the rest of the form too: market, language and ad format decide
        // what a good keyword even is, and the seeds are what we expand from.
        const res = await api.runTool(tool.id, { ...values, action: 'suggest', input: src }, tool.slow);
        if (typeof res?.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
        data = res.result || {};
        if (data.text && !data[f.name]) throw new Error(data.text); // soft failure (unreachable site, bad JSON)
        if (!opt.append) suggestCache.current = { key: cacheKey, data };
      }
      // One button, several boxes: fill each one the pass came back with, but
      // never overwrite something the user typed — their words win.
      if (group) {
        let filled = 0, kept = 0;
        for (const g of group) {
          const gv = data[g.name];
          const gText = (Array.isArray(gv) ? gv.join(g.type === 'tags' ? ', ' : '\n') : String(gv || '')).trim();
          if (!gText) continue;
          if (String(values[g.name] || '').trim()) { kept++; continue; }
          set(g.name, gText);
          filled++;
        }
        if (!filled && !kept) throw new Error(data.text || "Couldn't draft anything from that site.");
        toast(filled
          ? `Drafted ${filled} box${filled > 1 ? 'es' : ''} from your site${kept ? ` (kept what you'd already written)` : ''} — edit anything before you run.`
          : 'You’ve already filled these in — clear a box to draft it again.', filled ? 'success' : 'info');
        return;
      }
      const v = data[f.name];
      const joiner = f.type === 'tags' ? ', ' : '\n'; // TagInput stores a comma list
      let text = (Array.isArray(v) ? v.join(joiner) : String(v || '')).trim();
      if (!text) { toast('Nothing worth suggesting for this one — write it yourself.', 'info'); return; }
      const added = Array.isArray(v) ? v.length : 0;
      // Keep what they already typed — a suggestion adds to their list, never
      // replaces it (the backend already deduped against these seeds).
      const prior = opt.append ? String(values[f.name] || '').trim() : '';
      if (prior) text = prior.replace(/[,\s]+$/, '') + joiner + text;
      set(f.name, text);
      if (opt.append) {
        toast(added
          ? `Added ${added} keyword${added > 1 ? 's' : ''} — remove any that don’t fit.`
          : 'Keywords added — remove any that don’t fit.', 'success');
        return;
      }
      // The pass also returns whatever context fields it could infer (GEO
      // On-Page: brand / industry / audience). Fill only the ones still empty —
      // anything the user typed themselves is theirs, and stays.
      let extras = 0;
      for (const other of shown) {
        if (other.name === f.name || !data[other.name] || String(values[other.name] || '').trim()) continue;
        set(other.name, String(data[other.name]).trim());
        extras++;
      }
      toast(extras
        ? `Drafted from your page, and filled ${extras} more field${extras > 1 ? 's' : ''} — edit anything before you run.`
        : 'Drafted from your site — edit anything before you run.', 'success');
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 402
        ? 'Out of credits — top up to use AI suggest.'
        : (e?.message || 'Something went wrong.');
      toast('AI suggest failed: ' + msg, 'error');
    } finally {
      setSuggesting(null);
    }
  }

  // Guided tour: pre-fill the worked example + render its real result on the
  // page (so the walkthrough annotates a genuine run), and clear both on exit.
  function launchTour(tourFields = shown) {
    startToolTour(tool, tourFields, {
      preview: () => {
        if (example) setValues((s) => ({ ...s, ...example }));
        const sample = sampleResultFor(tool.id);
        if (sample) setOut({ creditsUsed: cost, creditsRemaining: 1860, ...sample });
      },
      clear: () => {
        setValues(Object.fromEntries(fields.map((f) => [f.name, f.default ?? ''])));
        setOut(null);
      },
    });
  }

  async function run(vals = values, { confirmed = false } = {}) {
    // Index removal and sitemap deletion act on the user's real Search Console
    // property the moment we send them, and nothing in this app can undo either.
    // Gate them behind an explicit yes that SHOWS what's about to be sent — the
    // old browser confirm() only described the action in the abstract.
    const dw = activeTab?.destructiveWhen;
    if (!confirmed && dw && (dw.in || []).includes(vals[dw.field])) {
      setConfirmOp({ vals, op: activeTab.op });
      return;
    }
    // Nothing to run against until they've signed in — re-open the connect
    // widget rather than spend a round-trip to be told the same thing.
    if (gate.blocked) { gate.reopen(); return; }
    setBusy(true);
    setOut(null);
    setJob(null);
    const startedAt = Date.now();
    try {
      let res = await api.runTool(tool.id, { ...vals, gscOp: activeTab?.op, url: vals.url || vals.input, projectId: activeId || undefined }, tool.slow);
      // Async job tools (content-writer): the first response is just a job id —
      // the run continues server-side (finishing even if this tab closes). Poll
      // for REAL stage/agent progress, then adopt the finished payload.
      if (res?.result?.jobId && res?.result?.status && !res.result.sections && !res.result.html) {
        setJob({ status: res.result.status });
        const done = await pollJob(tool.id, res.result.jobId, setJob);
        res = {
          result: done.result || {}, runId: done.runId || null,
          creditsUsed: done.creditsUsed, creditsRemaining: done.creditsRemaining, topupRemaining: done.topupRemaining,
        };
      }
      setOut(res);
      if (typeof res.creditsRemaining === 'number') setCredits(res.creditsRemaining, res.topupRemaining);
      // Failed runs are never billed server-side — reassure the user in a toast so
      // they don't have to read the result card to know their balance is intact.
      // A SUCCESSFUL run says nothing about credits: the deduction lands on the
      // sidebar meter, and announcing the price of every result reads as nagging.
      if (res.failed) toast('Run didn’t complete — no credits were charged.', 'error');
      saveLastInput(tool.id, vals);
      pushRecent(tool.id);
      // Let the proactive Otter react to a finished run (success vs. empty result).
      // A connect prompt isn't a finished run — the widget is doing the talking.
      if (!res.result?.needsConnect) emitRunFinished(tool.name, runStatusOf(res));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 402 || e.status === 403)) {
        setModal({
          reason: e.payload.error,
          requiredTier: e.payload.requiredTier || tool.minTier,
          creditsRemaining: e.payload.creditsRemaining,
          creditsNeeded: e.payload.creditsNeeded,
        });
      } else if (tool.integration && connectReasonFor(e.message)) {
        // A missing/expired connection isn't a bug — don't show an error card
        // and don't let the fault reporter ambush them. Ask them to connect.
        suppressFault();
        setOut({ result: { needsConnect: tool.integration, connectReason: connectReasonFor(e.message) } });
      } else if (connectionLost(e)) {
        // Don't declare a failure we can't actually see. The run may well have
        // finished server-side; go and look before saying anything, and keep the
        // fault reporter off the user's back while we do.
        suppressFault(RECONCILE_WINDOW_MS + 5000);
        setReconciling(true);
        let adopted = null;
        try { adopted = await reconcileRun(tool.id, startedAt, { windowMs: RECONCILE_WINDOW_MS }); }
        finally { setReconciling(false); }
        if (adopted?.result) {
          setOut({ result: adopted.result, runId: adopted.runId });
          saveLastInput(tool.id, vals);
          pushRecent(tool.id);
          toast('Your connection dropped, but the run finished — here are the results.', 'success');
          emitRunFinished(tool.name, runStatusOf({ result: adopted.result }));
        } else if (adopted) {
          // We know it completed (and was charged) but couldn't load the payload.
          setOut({ error: 'Your connection dropped mid-run. The run finished and is saved — open it from History.', billed: true });
          toast('Run finished, but we couldn’t load it here.', 'info');
        } else {
          setOut({ error: 'We lost the connection to this run and couldn’t find a finished result. If it did complete, it’ll be in History and you’ll have a notification.', billed: true });
          toast('Lost connection to this run.', 'error');
          emitRunFinished(tool.name, 'error');
        }
      } else {
        setOut({ error: e.message });
        // Most thrown runs (upstream 5xx, hard job failure) genuinely aren't
        // billed. A background job that outlived its window is the exception:
        // it may well have finished and charged after we stopped listening, so
        // claiming otherwise is a lie the user can check against their balance.
        // The server's message already explains that case — don't talk over it.
        toast(runMayHaveBeenBilled(e) ? 'Run didn’t come back in time.' : 'Run failed — no credits were charged.', 'error');
        emitRunFinished(tool.name, 'error');
      }
    } finally {
      setBusy(false);
      setJob(null);
    }
  }

  return (
    <div className={embedded ? '' : 'mx-auto max-w-3xl'}>
      {/* Page chrome (back link, title, tour) — the modal supplies its own header. */}
      {!embedded && (
        <>
          <Link to="/" className="text-sm text-muted hover:text-strong">← All tools</Link>
          <div className="mt-3 flex items-center gap-3">
            <h1 className="text-2xl font-bold">{tool.name}</h1>
            {!unlocked && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-500/15 px-2.5 py-1 text-xs font-bold uppercase text-amber-700 dark:text-amber-300"><Lock size={12} aria-hidden /> {PLANS[tool.minTier].name}</span>}
            <button
              type="button"
              onClick={() => launchTour(shown)}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-semibold text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400"
              title="Guided walkthrough with a real example"
            >
              <Compass size={14} aria-hidden /> Tour
            </button>
          </div>
          <p className="mt-1 text-dim">{tool.desc}</p>
        </>
      )}
      {/* In the modal the header carries the name; show the one-line desc + a lock hint. */}
      {embedded && (
        <div className="flex items-start gap-2">
          <p className="flex-1 text-xs leading-relaxed text-muted">{tool.desc}</p>
          {!unlocked && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-500/15 px-2.5 py-1 text-[10px] font-bold uppercase text-amber-700 dark:text-amber-300"><Lock size={11} aria-hidden /> {PLANS[tool.minTier].name}</span>}
        </div>
      )}

      {!unlocked && tool.teaser && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-4 py-3 text-sm text-brand-800 dark:text-brand-300">
          <Sparkles size={16} className="shrink-0" aria-hidden /> <span>You get <strong>one free preview run</strong> on your own data. Full results unlock with {PLANS[tool.minTier].name}.</span>
        </div>
      )}

      {/* Not connected yet: the connect widget opens over the page, and the card
          it leaves behind keeps the fix one click away. */}
      <IntegrationGate gate={gate} tool={tool} />

      {/* GSC sub-tool tabs (URL Inspection / Sitemaps / Indexing), like index.html. */}
      {tabs && (
        <div className="mt-5 flex flex-wrap gap-1 border-b border-line">
          {tabs.map((t, i) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(i)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-sm font-medium transition ${i === tab ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-muted hover:text-strong'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Blocked on a connection: hide the form outright. Leaving a Property box
          and a Run button on screen is what made people type an ID and run into
          a wall — there is nothing here they can fill in that would work. */}
      <div className={`card ${gate.blocked ? 'hidden' : ''} ${embedded ? 'mt-3' : tabs ? 'mt-4' : 'mt-6'} p-5`}>
        <div className="space-y-4">
          {groupRuns(primaryFields).map((run) => (
            run.fields.length > 1 ? (
              <FieldGroup key={run.group} meta={FIELD_GROUPS[run.group]} fields={run.fields} render={renderField} />
            ) : (
              <div key={run.fields[0].name}>{renderField(run.fields[0], { autoFocus: run.fields[0] === primaryFields[0] })}</div>
            )
          ))}
          {advancedFields.length > 0 && (
            <div className="border-t border-hair pt-3">
              <button type="button" onClick={() => setShowAdv((s) => !s)}
                className="flex items-center gap-1.5 text-sm font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
                <ChevronRight size={15} className={`transition-transform ${showAdv ? 'rotate-90' : ''}`} aria-hidden />
                {showAdv ? 'Hide' : 'Show'} advanced options
                <span className="text-xs font-normal text-faint">({advancedFields.length} optional)</span>
              </button>
              {showAdv && (
                <div className="mt-4 space-y-4">
                  {groupRuns(advancedFields).map((run) => (
                    run.fields.length > 1 ? (
                      <FieldGroup key={run.group} meta={FIELD_GROUPS[run.group]} fields={run.fields} render={renderField} />
                    ) : (
                      <div key={run.fields[0].name}>{renderField(run.fields[0])}</div>
                    )
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-faint" data-tour="tool-actions">
            {example && <button type="button" onClick={fillExample} className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Try an example</button>}
            {shown.some((f) => f.required) && <span><span className="text-amber-500">*</span> Required</span>}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!ready && (
              <span className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition ${nudge ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'text-amber-600 dark:text-amber-400'}`}>
                <AlertTriangle size={13} aria-hidden />
                {missing.length === 1 ? `“${missing[0].label}” is required` : `${missing.length} required fields left`}
              </span>
            )}
            {isSchedulable(tool) && scheduleLimits(user?.tier).enabled && !tabs && (
              <button type="button" className="btn-ghost inline-flex items-center gap-1.5"
                title="Run this automatically on a schedule"
                onClick={() => { onClose?.(); navigate('/schedules', { state: { scheduleCreate: { toolId: tool.id, inputs: values } } }); }}>
                <Clock size={15} />Schedule
              </button>
            )}
            <button className={`btn-primary ${!ready ? 'opacity-60' : ''}`} disabled={busy} aria-disabled={busy || !ready}
              onClick={attemptRun} data-tour="tool-run">
              {busy ? (tool.slow ? 'Generating…' : 'Running…') : unlocked ? 'Run tool' : 'Run preview'}
            </button>
          </div>
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

      {/* Reconciling outranks the normal progress UI: the staged checklist would
          keep implying we're in touch with the run when we've actually lost it. */}
      {busy && reconciling && (
        <div className="card mt-5 flex items-start gap-3 p-4">
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-brand-600 dark:text-brand-400" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-strong">Lost connection — checking whether your run finished</p>
            <p className="mt-1 text-sm text-muted">
              Runs complete on our servers even if your browser drops off, so this usually comes back with your results. Hang on a moment.
            </p>
          </div>
        </div>
      )}
      {busy && !reconciling && tool.slow && <SlowProgress tool={tool} job={job} />}
      {out && !busy && <Result out={out} tool={tool} project={active} user={user} inputs={values} onCredits={setCredits} onRetry={() => run()} />}

      {modal && <UpgradeModal reason={modal.reason} requiredTier={modal.requiredTier} creditsRemaining={modal.creditsRemaining} creditsNeeded={modal.creditsNeeded} onClose={() => setModal(null)} />}

      <DestructiveOpModal
        pending={confirmOp}
        onCancel={() => setConfirmOp(null)}
        onConfirm={() => { const p = confirmOp; setConfirmOp(null); run(p.vals, { confirmed: true }); }}
      />
    </div>
  );
}

// Confirmation for the two Search Console ops we can't take back. Deliberately
// lists the exact URLs being sent: "delete this sitemap" is easy to agree to
// when you've forgotten which sitemap is in the box.
function DestructiveOpModal({ pending, onCancel, onConfirm }) {
  const removing = pending?.op === 'indexing';
  const urls = String(pending?.vals?.urls || '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const sitemap = String(pending?.vals?.sitemapUrl || '').trim();
  const targets = removing ? urls : (sitemap ? [sitemap] : []);

  return (
    <Modal
      open={!!pending}
      onClose={onCancel}
      tag="CONFIRM"
      labelledBy="dm-destructive-title"
      title={removing ? 'Remove from Google’s index?' : 'Delete this sitemap?'}
      footer={
        <>
          <button type="button" onClick={onCancel} className="btn-ghost px-4 py-2 text-sm" data-autofocus>Cancel</button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn px-4 py-2 text-sm bg-red-600 text-white shadow-sm hover:bg-red-700"
          >
            {removing ? `Remove ${targets.length || ''} URL${targets.length === 1 ? '' : 's'}`.trim() : 'Delete sitemap'}
          </button>
        </>
      }
    >
      <p className="text-sm text-body">
        {removing
          ? 'Google stops showing these pages in search results. Undoing it means requesting indexing again and waiting for a recrawl — this app can’t reverse it.'
          : 'Search Console stops tracking this sitemap and the URLs it lists. You can submit the same sitemap again afterwards, but its history goes.'}
      </p>
      {targets.length > 0 && (
        <ul className="max-h-48 overflow-y-auto rounded-xl border border-line bg-sunken p-3 text-xs text-muted">
          {targets.map((t) => <li key={t} className="truncate py-0.5">{t}</li>)}
        </ul>
      )}
    </Modal>
  );
}

// A background run that outran its window (server-side deadline, or our own
// poll cap) may still have completed and been charged after we stopped
// listening — so we must not tell the user their credits are intact.
function runMayHaveBeenBilled(e) {
  return /took longer than we allow|lost track|continues in the background|taking unusually long/i.test(e?.message || '');
}

// How long to keep looking for a run whose response never came back. Comfortably
// past the slowest tool's typical window without stranding the user forever.
const RECONCILE_WINDOW_MS = 3 * 60 * 1000;

// Did we lose the CONNECTION, rather than get told the run failed? The metering
// Function URL is BUFFERED with a 900s Lambda timeout: nothing reaches the
// browser until the handler returns, and the handler saves the run + fires the
// "✅ finished" notification whether or not we're still listening. So a dropped
// socket or an edge-level 5xx says nothing about the run's fate — the answer is
// in History, not in this error.
function connectionLost(e) {
  if (e?.name === 'AbortError') return false;
  if (e instanceof ApiError) return e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504;
  // A background job that outran our poll window is the same situation: the run
  // kept going without us.
  if (runMayHaveBeenBilled(e)) return true;
  // A raw fetch rejection (offline, DNS, CORS, connection reset) is a TypeError.
  // Deliberately narrow — a bug in our own code must surface as a bug, not send
  // the user into a three-minute wait for a run that was never started.
  return e instanceof TypeError;
}

// Find the run the server completed while we weren't listening. Users hit this
// twice on Keyword Analysis: the frontend showed no response and threw up the
// Report-a-problem modal, while /history and the notification both said the run
// had finished — and it had been billed. Poll our own run list for one this tool
// started after we sent the request, then adopt it as the result.
async function reconcileRun(toolId, sinceMs, { windowMs = 3 * 60 * 1000 } = {}) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    let runs;
    // `background: true` keeps these polls out of the fault reporter — we're
    // already handling one failure and don't want to compound it.
    try { runs = (await api.runs(15))?.runs; } catch { continue; }
    // 5s of slack: the run's `ts` is stamped server-side, so a little clock skew
    // either way shouldn't lose us the very run we're looking for.
    const hit = (runs || []).find((r) => r.tool === toolId && new Date(r.ts).getTime() >= sinceMs - 5000);
    if (!hit) continue;
    // The list projection omits `result` — fetch the full record to render it.
    try {
      const { run } = await api.run(hit.runId);
      if (run) return { result: run.result || {}, runId: hit.runId, creditsUsed: hit.creditsUsed };
    } catch { /* fall through — we know it exists, just couldn't load it */ }
    return { runId: hit.runId, incomplete: true };
  }
  return null;
}

// Poll a background job until it finishes. Transient poll failures are ignored
// (the job keeps running server-side); a hard cap stops a zombie poll loop —
// the run itself still completes, lands in History and fires a notification.
async function pollJob(toolId, jobId, onTick) {
  // Must outlast the server's own deadline (MeteringFn's 900s timeout, minus
  // the finalizer's 20s self-deadline margin) — otherwise we give up first and
  // report a failure for a run that was about to report success.
  const deadline = Date.now() + 16 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3500));
    let s = null;
    try { s = (await api.runTool(toolId, { cwAction: 'status', jobId }, true))?.result; }
    catch { continue; }
    if (!s) continue;
    if (s.status === 'done') return s;
    if (s.status === 'error') throw new Error(s.error || 'The run failed. No credits were charged.');
    if (s.status === 'unknown') throw new Error('We lost track of this run — check History in a minute; it may still have finished.');
    onTick?.(s);
  }
  throw new Error('This is taking unusually long. The run continues in the background — you’ll get a notification, and the result will be in History.');
}

// Staged checklist for long runs. Tools with a background job report REAL
// progress (stage + agents done/total); everything else advances on a schedule
// scaled to the tool's typical duration (not a fixed 6s — which raced to
// "almost there" and then sat still, reading as stuck). Past the typical window
// we say so honestly instead of looping the same message.
function SlowProgress({ tool, job }) {
  const steps = runSteps(tool); // per-tool wording — a crawl-and-write tool is not "crunching numbers"
  const TYPICAL = etaTypical(tool); // seconds — this tool's measured midpoint
  const range = etaLabel(tool) || '30–150s';
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const a = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(a);
  }, []);
  const overdue = sec > (etaTypical(tool) * 2);

  // Live server-side progress (async-job tools like the Content Optimiser).
  if (job) {
    const p = job.progress;
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : null;
    // Results the server has already finished. The Optimiser produces the
    // competitor research ~100s in and the draft ~400s in, so holding them back
    // until the QA agents finish means several minutes of staring at a spinner.
    const partial = Array.isArray(job.partial) ? job.partial : [];
    return (
      <>
        <div className="card mt-6 p-6">
          <div className="flex items-center gap-3">
            <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
            <span className="font-medium text-body">{job.stage || 'Starting'}…</span>
            <span className="ml-auto text-xs tabular-nums text-faint">{sec}s</span>
          </div>
          {pct != null && (
            <div className="mt-4">
              <div className="h-2 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all" style={{ width: `${Math.max(3, pct)}%` }} />
              </div>
              <div className="mt-1.5 text-xs tabular-nums text-muted">{p.done}/{p.total} QA agents finished</div>
            </div>
          )}
          <p className="mt-4 text-sm text-dim">
            This run finishes on our servers even if you close the tab — you’ll get a notification, and the result lands in History.
          </p>
        </div>
        {partial.length > 0 && (
          <div className="mt-6">
            <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" aria-hidden />
              Results so far — still working
            </p>
            <ResultSections sections={partial} />
          </div>
        )}
      </>
    );
  }

  const i = Math.min(Math.floor((sec / TYPICAL) * steps.length), steps.length - 1);
  return (
    <div className="card mt-6 p-6">
      {/* ONE spinner only — it lives on the active row of the list below, which
          is where the eye already is. A second spinner up here ran the same
          animation at a different diameter, which reads as two things spinning
          at two speeds. A determinate bar carries the overall progress instead,
          matching the async-job card above. */}
      <div className="flex items-center gap-3">
        <span className="font-medium text-body">{steps[i]}…</span>
        <span className="ml-auto text-xs tabular-nums text-muted">{sec}s · usually {range}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-all"
          style={{ width: `${Math.max(3, Math.round(((i + 1) / steps.length) * 100))}%` }}
        />
      </div>
      <ul className="mt-4 space-y-2">
        {steps.map((s, k) => (
          <li key={s} className={`flex items-center gap-2 text-sm ${k < i ? 'text-muted' : k === i ? 'font-medium text-body' : 'text-faint'}`}>
            {k < i
              ? <Check size={15} className="shrink-0 text-green-600 dark:text-green-400" aria-hidden />
              : k === i
              ? <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-400 border-t-transparent" aria-hidden />
              : <span className="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-line" aria-hidden />}
            {s}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-sm text-dim">
        This keeps running on our servers even if you close the tab — you’ll get a notification and it lands in History. Stay on this page and the result appears below.
      </p>
      {overdue && (
        <p className="mt-2 text-sm text-dim">
          Still working — big sites and busy data sources can take a few minutes.
        </p>
      )}
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
      case 'html': {
        const d = document.createElement('div');
        d.innerHTML = s.html || '';
        out.push(d.innerText);
        break;
      }
      default: break;
    }
    out.push('');
  }
  return out.join('\n').trim();
}

// First tabular section, for the CSV button.
function firstTable(sections) { return (sections || []).find((s) => s.type === 'table' && s.rows && s.rows.length); }

// Free plain-English summary, auto-fetched for every real run (runId present —
// the guided tour's sample results skip it). Cached per run so re-renders and
// remounts never refetch. Fails silently: the raw result is still on screen.
const tldrCache = new Map();
function TldrPanel({ tool, r, runId }) {
  const [state, setState] = useState(() => tldrCache.get(runId) || { loading: true, text: '' });
  useEffect(() => {
    let alive = true;
    const hit = tldrCache.get(runId);
    if (hit) { setState(hit); return undefined; }
    setState({ loading: true, text: '' });
    api.explainResult(tool.name, copyableOf(r).slice(0, 5000))
      .then((d) => { const s = { loading: false, text: String(d.summary || '').trim() }; tldrCache.set(runId, s); if (alive) setState(s); })
      .catch(() => { const s = { loading: false, text: '' }; tldrCache.set(runId, s); if (alive) setState(s); });
    return () => { alive = false; };
    // eslint-disable-next-line
  }, [runId]);
  if (!state.loading && !state.text) return null;
  return (
    <div className="dm-no-print mb-4 rounded-xl border border-brand-200 dark:border-brand-500/30 bg-brand-50/60 dark:bg-brand-500/10 p-4">
      <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand-700 dark:text-brand-300">
        <Sparkles size={13} aria-hidden /> What this means — in plain English
      </div>
      {state.loading ? (
        <div className="mt-2.5 space-y-1.5" aria-label="Writing your summary…">
          {[92, 78, 60].map((w) => <div key={w} className="h-3 animate-pulse rounded bg-brand-100 dark:bg-brand-500/20" style={{ width: `${w}%` }} />)}
        </div>
      ) : (
        <TldrText text={state.text} />
      )}
    </div>
  );
}

// Light renderer for the explainer reply: paragraphs + the fixed labels bolded.
// (The upstream returns plain text / light markdown; we don't ship a full
// markdown renderer for a 150-word summary.)
function TldrText({ text }) {
  const lines = String(text).replace(/\*\*/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="mt-2 space-y-1 text-sm leading-relaxed text-body">
      {lines.map((l, i) => {
        const m = l.match(/^(Looking good|Needs attention|Do this next)\s*:?\s*(.*)$/i);
        if (m) return <p key={i}><strong className="font-semibold text-heading">{m[1]}:</strong> {m[2]}</p>;
        return <p key={i}>{l}</p>;
      })}
    </div>
  );
}

// Did this run actually take a website address? The three "likely causes" below
// are all URL-shaped, and a user who pasted their own copy into the Content
// Optimiser was told to check that their website address loads — advice with no
// relationship to what they did. Read the real inputs rather than assuming.
function ranAgainstUrl(inputs) {
  return Object.entries(inputs || {}).some(([k, v]) => (
    typeof v === 'string' && v.trim() && (/^(url|domain|website|site|target)$/i.test(k) || /^https?:\/\//i.test(v.trim()))
  ));
}

// Backend/exception strings are not layman copy ("fetch failed", "502"). Show a
// calm card with likely causes and ways forward instead of red raw text.
//
// `billed` means we know the run may have completed and been charged (a dropped
// connection, or a background job that outlived our window). Saying "no credits
// were wasted" there is a claim the user can disprove from their own balance.
function FriendlyError({ message, tool, inputs, billed }) {
  const urlRun = ranAgainstUrl(inputs);
  const askMonty = () => {
    window.dispatchEvent(new CustomEvent('dm:ask', {
      detail: { text: `I ran the "${tool.name}" tool and got this error: "${message}". In plain English, what does it mean and what should I try?` },
    }));
  };
  return (
    <div className="card mt-6 p-6">
      <div className="flex items-center gap-2 font-semibold text-heading">
        <AlertTriangle size={18} className="text-amber-500" aria-hidden />
        {billed ? 'We lost track of that run' : 'That run didn’t work'}
      </div>
      <p className="mt-2 text-sm text-dim">
        {billed
          ? 'It may still have finished on our servers after your browser lost contact — check the two places below before running it again, so you don’t pay twice.'
          : 'No credits were wasted on failed runs. This usually comes down to one of these:'}
      </p>
      {!billed && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-dim">
          {urlRun && <li>A typo in the website address — check it loads in a new tab.</li>}
          <li>The data source being briefly busy — trying again in a minute often fixes it.</li>
          {urlRun
            ? <li>A very new or very small site with no data yet.</li>
            : <li>Input the tool couldn’t work with — try shortening it, or removing any unusual formatting.</li>}
        </ul>
      )}
      {/* Named destinations, as links. The copy used to tell people to "check
          Notifications and History" — History has no nav entry at all and
          Notifications only lives behind the bell, so both were unfindable. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Link to="/history" className="btn-ghost inline-flex items-center gap-1.5 text-sm">
          <Clock size={15} aria-hidden /> Check History
        </Link>
        <Link to="/notifications" className="btn-ghost inline-flex items-center gap-1.5 text-sm">
          <MessageCircleQuestion size={15} aria-hidden /> Notifications
        </Link>
        <button type="button" onClick={askMonty} className="btn-ghost inline-flex items-center gap-1.5 text-sm">
          <MessageCircleQuestion size={15} aria-hidden /> Ask Monty for help
        </button>
      </div>
      <p className="mt-3 text-xs text-faint">Technical detail: {message}</p>
    </div>
  );
}

// A run that finished but returned nothing used to render a blank card — this
// panel always explains and points at the usual fix (input format).
function EmptyResult({ tool }) {
  return (
    <div className="card mt-6 p-6 text-center">
      <p className="font-semibold text-heading">No data came back</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-dim">
        The run finished, but there was nothing to show. That’s usually the website address or keyword format — try the bare domain (like <span className="font-medium">example.com</span>), or broader keywords.
      </p>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: `I ran the "${tool.name}" tool and it returned no data. What input should I try instead?` } }))}
        className="btn-ghost mt-4 inline-flex items-center gap-1.5 text-sm"
      >
        <MessageCircleQuestion size={15} aria-hidden /> Ask Monty what to try
      </button>
    </div>
  );
}

function Result({ out, tool, project, user, inputs, onCredits, onRetry }) {
  // The exact subtree the PDF export prints — the result card and nothing else.
  const printRef = useRef(null);
  // A connection that isn't set up yet reads as an error at the transport layer
  // but is really a setup step — route it to the connect widget either way.
  const errReason = out.error && tool.integration ? connectReasonFor(out.error) : null;
  if (out.error && !errReason) return <FriendlyError message={out.error} tool={tool} inputs={inputs} billed={out.billed} />;
  const r = out.result || {};

  if (r.needsConnect || errReason) {
    return (
      <ConnectPrompt
        provider={r.needsConnect || tool.integration}
        reason={r.connectReason || errReason || 'connect'}
        toolName={tool.name}
        text={r.text}
        onReady={onRetry}
      />
    );
  }

  const isSchema = tool.id === 'schema' && r.text;
  const hasContent = r.text || r.preview || r.html || (r.rows && r.rows.length) || (r.sections && r.sections.length);
  const sectionTable = r.sections && firstTable(r.sections);

  // Finished but nothing to show → explain it, don't render a blank card.
  if (!hasContent && !r.blurredCount && !r.detailsLocked && !out.failed) return <EmptyResult tool={tool} />;

  // Recommendation cards are appended after the findings (see withRecs in the
  // gateway). When a result also has a top-level data table, that table should
  // sit ABOVE the recommendations — the recs reference it. Only 'cards' sections
  // move below; intro sections (stats/heading/callout) stay above as authored.
  const hasRows = r.rows && r.rows.length > 0;
  const preRowSections = hasRows ? (r.sections || []).filter((s) => s.type !== 'cards') : (r.sections || []);
  const postRowSections = hasRows ? (r.sections || []).filter((s) => s.type === 'cards') : [];

  // Plain-English explainer: hand the result to the assistant ("what does this
  // mean + what do I do"). Reuses the dm:ask event the right-click menu fires.
  const explain = () => {
    const text = copyableOf(r).slice(0, 4000);
    const prompt = `I just ran the "${tool.name}" tool. In plain, simple English (explain any jargon), tell me: 1) what these results mean, 2) what's good and what's a problem, and 3) the top 3 things I should do next.\n\nHere are the results:\n${text}`;
    window.dispatchEvent(new CustomEvent('dm:ask', { detail: { text: prompt } }));
  };

  // Context handed to each recommendation card so the assistant answers in the
  // tool's frame ("from the X tool, for your site Y") and "Add to plan" links back.
  //
  // `target` is the URL/domain THIS RUN was actually about, and it matters more
  // than the project domain: it used to fall back to `project?.domain` alone, so
  // a user with no project (every new trial account) handed the assistant a
  // recommendation with no subject attached — which is why "do it for me" on a
  // missing meta description came back asking for the URL the user had just
  // typed into the form two clicks earlier.
  const target = (inputs?.url || inputs?.input || '').trim() || project?.domain || '';
  const recContext = {
    toolName: tool.name,
    domain: project?.domain,
    target,
    route: tool.route || `/tool/${tool.id}`,
  };

  return (
    <div className="mt-6" data-tour="tool-result">
      <div className="dm-no-print mb-2 flex items-center gap-2">
        {r.source === 'live' && <span className="inline-flex items-center gap-1.5 rounded-full bg-green-100 dark:bg-green-500/15 px-2 py-0.5 text-xs font-semibold text-green-700 dark:text-green-300"><span className="inline-block h-1.5 w-1.5 rounded-full bg-green-600" aria-hidden /> Live data</span>}
        {/* No credit tally on a result. The moment someone reads their findings
            is the wrong moment to bill-shame them; the sidebar meter and the
            Usage page already carry the balance for anyone who wants it. */}
        {hasContent && (
          <div className="ml-auto flex items-center gap-1.5">
            <button onClick={explain} title={`Discuss these results with Monty — ask follow-up questions (${CREDIT_COSTS.ai_chat ?? 2} credits per message)`}
              className="inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700">
              <Sparkles size={13} aria-hidden /> Ask Monty
            </button>
            {/* One canonical CSV: prefer the top-level rows, else the first table
                section (previously both could render → two identical "CSV" buttons).
                Keyword Analysis owns its own CSV (inside KeywordAnalysisResult) so the
                export includes any live time-to-rank column — suppress this one there. */}
            {tool.id === 'keyword-analysis' && r.rows && r.rows.length > 0
              ? null
              : r.rows && r.rows.length > 0
              ? <ResultBtn onClick={() => downloadCsv(r.rows, `${tool.id}.csv`)}>CSV</ResultBtn>
              : sectionTable && <ResultBtn onClick={() => downloadCsv(sectionTable.rows, `${tool.id}.csv`)}>CSV</ResultBtn>}
            <ResultBtn onClick={() => copyText(copyableOf(r))}>Copy</ResultBtn>
            <PdfButton targetRef={printRef} />
            <ShareResult tool={tool} out={out} project={project} user={user} />
          </div>
        )}
      </div>

      <div ref={printRef} className="card p-5">
        <PrintBrand title={tool.name} project={project} user={user} />
        {out.failed && (
          <div className="dm-no-print mb-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            This run didn’t complete — no credits were charged.
          </div>
        )}
        {out.teaser && (
          <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            {r.teaserMessage || 'Preview only — upgrade to see everything.'}
          </div>
        )}

        {out.runId && hasContent && !out.teaser && <TldrPanel tool={tool} r={r} runId={out.runId} />}

        {isSchema ? (
          <SchemaResult json={r.text} />
        ) : (
          <>
            {r.text && (VARIATION_RE.test(r.text)
              ? <CaptionCards text={r.text} />
              : <pre className="whitespace-pre-wrap text-sm text-body">{r.text}</pre>)}
            {r.preview && <pre className="whitespace-pre-wrap text-sm text-muted">{r.preview}</pre>}
            {preRowSections.length > 0 && <ResultSections sections={preRowSections} context={recContext} />}
            {r.html && <ReportHtml html={r.html} />}
          </>
        )}

        {hasRows && (tool.id === 'keyword-analysis'
          ? <KeywordAnalysisResult rows={r.rows} timeRank={r.timeRank} tool={tool} onCredits={onCredits} />
          : <ResultTable rows={r.rows} />)}
        {postRowSections.length > 0 && <ResultSections sections={postRowSections} context={recContext} />}

        {/* Summary-only teaser reveal ({ summary, detailsLocked }): surface the
            free-preview sample above the paywall. Previously `summary` matched no
            render branch, so the advertised "1 free preview" showed only the upsell. */}
        {r.summary != null && !hasContent && (
          typeof r.summary === 'string'
            ? <pre className="whitespace-pre-wrap text-sm text-body">{r.summary}</pre>
            : typeof r.summary === 'number'
            ? <p className="text-sm text-body">Score: <span className="font-semibold">{r.summary}</span></p>
            : null
        )}

        {r.blurredCount > 0 && (
          <div className="relative mt-1">
            <div className="blur-locked">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-8 border-t border-hair py-1.5 text-sm text-faint">
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
            <p className="text-sm text-muted">{r.teaserMessage}</p>
            <Link to="/pricing" className="btn-primary mt-3">Unlock full report</Link>
          </div>
        )}

        {/* Per-tool micro-feedback — a one-tap reaction anchored to a fresh result.
            Only for real, non-teaser runs (a saved runId to attach it to). */}
        {out.runId && hasContent && !out.teaser && <RunFeedback runId={out.runId} toolName={tool.name} />}
      </div>
    </div>
  );
}

// "Was this useful?" 👍/👎 with an optional one-line note. Posts to the run so the
// signal is anchored to exactly what was rated. A thumbs-down opens the note box
// (that's where the useful "why" lives); thumbs-up is a quiet one-tap. State is
// per-runId, so it resets for the next run and won't re-ask after a rating.
function RunFeedback({ runId, toolName }) {
  const [rating, setRating] = useState(null);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [sent, setSent] = useState(false);

  // Reset whenever a new run replaces this panel.
  useEffect(() => { setRating(null); setNote(''); setShowNote(false); setSent(false); }, [runId]);

  const send = (r, withNote = '') => {
    setRating(r);
    api.runFeedback(runId, r, withNote).catch(() => { /* best-effort — never block on feedback */ });
  };
  const pick = (r) => {
    if (sent) return;
    if (r === 'down') { setRating('down'); setShowNote(true); return; } // gather the "why" first
    send('up');
    setSent(true);
  };
  const submitNote = () => { send('down', note.trim()); setSent(true); setShowNote(false); };

  if (sent) {
    return (
      <div className="dm-no-print mt-5 border-t border-hair pt-3 text-sm text-muted">
        Thanks for the feedback — it helps us make {toolName} better.
      </div>
    );
  }

  return (
    <div className="dm-no-print mt-5 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-dim">Was this useful?</span>
        <button
          onClick={() => pick('up')}
          aria-pressed={rating === 'up'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${rating === 'up' ? 'border-green-300 bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-300' : 'border-line text-muted hover:border-green-300 hover:text-green-600 dark:hover:text-green-400'}`}
        >
          <ThumbsUp size={14} aria-hidden /> Yes
        </button>
        <button
          onClick={() => pick('down')}
          aria-pressed={rating === 'down'}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium transition ${rating === 'down' ? 'border-amber-300 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-line text-muted hover:border-amber-300 hover:text-amber-600 dark:hover:text-amber-400'}`}
        >
          <ThumbsDown size={14} aria-hidden /> No
        </button>
      </div>
      {showNote && (
        <div className="mt-2.5 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={`fb-${runId}`} className="text-xs font-medium text-muted">What was missing or off? <span className="font-normal text-faint">(optional)</span></label>
            <input
              id={`fb-${runId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
              maxLength={500}
              autoFocus
              placeholder="e.g. the data looked out of date"
              className="mt-1 w-full rounded-lg border border-edge px-3 py-1.5 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
          <button onClick={submitNote} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">Send</button>
        </div>
      )}
    </div>
  );
}

function ResultBtn({ children, onClick }) {
  return <button onClick={onClick} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400">{children}</button>;
}

// Sortable table with per-column formatting + badges.
function ResultTable({ rows }) {
  const columns = Object.keys(rows[0] || {}).map((c) => ({
    key: c,
    // Split camelCase boundaries so "timeToRank" reads "time To Rank" (→ header
    // "TIME TO RANK"); leaves already-cased keys ("CPC", "url", "keyword") intact.
    label: c.replace(/([a-z])([A-Z])/g, '$1 $2'),
    render: (row) => cell(c, row[c]),
  }));
  const n = rows.length;
  return (
    <div>
      <div className="mb-1.5 flex justify-end">
        <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">
          {n.toLocaleString()} {n === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <SortableTable columns={columns} rows={rows} filterable={rows.length > 8} />
    </div>
  );
}

// Run async `fn` over `items` with at most `size` in flight — powers the
// keyword-by-keyword time-to-rank fan-out so results stream in as each finishes.
async function pool(items, size, fn) {
  const q = items.map((it, i) => [it, i]);
  const worker = async () => { while (q.length) { const [it, i] = q.shift(); await fn(it, i); } };
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, worker));
}

// Keyword Analysis results: the base keyword table plus an opt-in, per-keyword
// "time to rank" step. The user ticks keywords and hits Calculate; each keyword
// is estimated via its own (billed) sub-call, and the column fills in live —
// no waiting for the whole set. Only offered when the run carries a domain to
// estimate against (always in the domain/URL modes; the optional field otherwise).
function KeywordAnalysisResult({ rows: initialRows, timeRank, tool, onCredits }) {
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState(() => new Set());
  const [pending, setPending] = useState(() => new Set());
  const [running, setRunning] = useState(false);
  const domain = (timeRank?.domain || '').trim();

  // A fresh run (new rows object) resets selection + any computed estimates.
  useEffect(() => { setRows(initialRows); setSelected(new Set()); setPending(new Set()); }, [initialRows]);

  const toggle = (kw) => setSelected((s) => { const n = new Set(s); n.has(kw) ? n.delete(kw) : n.add(kw); return n; });
  const uncomputed = (kw) => { const r = rows.find((x) => x.keyword === kw); return r && r.timeToRank == null; };
  const selectableKws = rows.filter((r) => r.timeToRank == null).map((r) => r.keyword);
  const allSel = selectableKws.length > 0 && selectableKws.every((k) => selected.has(k));
  const toggleAll = () => setSelected(allSel ? new Set() : new Set(selectableKws));
  const todo = [...selected].filter(uncomputed);

  const baseKeys = Object.keys(rows[0] || {}).filter((k) => k !== 'timeToRank');
  const columns = [
    domain && {
      key: '_sel', label: '', sortable: false,
      render: (row) => row.timeToRank != null
        ? <span className="text-slate-300" aria-hidden>✓</span>
        : <input type="checkbox" checked={selected.has(row.keyword)} onChange={() => toggle(row.keyword)}
            className="h-4 w-4 cursor-pointer rounded border-edge text-brand-600 dark:text-brand-400 focus:ring-brand-500" aria-label={`Select ${row.keyword}`} />,
    },
    ...baseKeys.map((c) => ({ key: c, label: c.replace(/([a-z])([A-Z])/g, '$1 $2'), render: (row) => cell(c, row[c]) })),
    domain && {
      key: 'timeToRank', label: 'Time to rank',
      render: (row) => pending.has(row.keyword)
        ? <span className="inline-flex items-center gap-1 text-faint"><span className="h-3 w-3 animate-spin rounded-full border-2 border-edge border-t-brand-500" aria-hidden /> estimating…</span>
        : row.timeToRank != null ? cell('timeToRank', row.timeToRank) : <span className="text-slate-300">—</span>,
    },
  ].filter(Boolean);

  async function calculate() {
    if (!todo.length || running) return;
    setRunning(true);
    setPending(new Set(todo));
    let done = 0, denied = false;
    await pool(todo, 4, async (kw) => {
      const src = rows.find((r) => r.keyword === kw) || {};
      try {
        const res = await api.runTool(tool.id, {
          timeRankOne: kw, domain, location: timeRank.location, language: timeRank.language,
          timeRankDifficulty: src.difficulty,
        }, true);
        const ttr = res.result?.timeToRank ?? 'N/A';
        setRows((rs) => rs.map((r) => r.keyword === kw ? { ...r, timeToRank: ttr } : r));
        if (typeof res.creditsRemaining === 'number') onCredits(res.creditsRemaining, res.topupRemaining);
        done++;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 402 || e.status === 403)) denied = true;
        setRows((rs) => rs.map((r) => r.keyword === kw ? { ...r, timeToRank: 'N/A' } : r));
      } finally {
        setPending((p) => { const n = new Set(p); n.delete(kw); return n; });
      }
    });
    setSelected(new Set());
    setRunning(false);
    if (done) toast(`Time to rank estimated for ${done} keyword${done > 1 ? 's' : ''}.`, 'info');
    if (denied) toast('Ran out of credits before finishing — the rest weren’t estimated.', 'error');
  }

  const n = rows.length;
  return (
    <div>
      {domain && (
        <div className="dm-no-print mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button type="button" onClick={toggleAll} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
            {allSel ? 'Clear selection' : 'Select all'}
          </button>
          <button type="button" onClick={calculate} disabled={running || todo.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40">
            {running ? 'Calculating…' : `Calculate time to rank${todo.length ? ` (${todo.length})` : ''}`}
          </button>
          {todo.length > 0 && <span className="text-xs text-faint">costs {todo.length} credit{todo.length > 1 ? 's' : ''} · estimated against {domain}</span>}
        </div>
      )}
      <div className="mb-1.5 flex justify-end">
        <span className="rounded-full bg-sunken px-2 py-0.5 text-xs font-medium tabular-nums text-muted">{n.toLocaleString()} {n === 1 ? 'row' : 'rows'}</span>
      </div>
      <SortableTable columns={columns} rows={rows} rowKey={(r) => r.keyword} filterable={rows.length > 8} exportName={tool.id} />
    </div>
  );
}

const TONE = { red: 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300', amber: 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300', green: 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300', blue: 'bg-blue-100 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300', slate: 'bg-sunken text-dim' };
function Badge({ t, tone }) { return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[tone] || TONE.slate}`}>{t}</span>; }

// Toggle-chip multi-select; value is a comma-joined string (backend splits it).
// When field.compatibility === 'ga4-metrics', options unsupported for the chosen
// breakdown dimension are fetched from GA4 and disabled (can't be selected).
function MultiSelect({ field, options, value, onChange, values }) {
  const sel = String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
  const [allowed, setAllowed] = useState(null); // null = allow all (unknown)
  const dim = values?.dimension;
  const compat = field?.compatibility === 'ga4-metrics';

  // Refetch the compatible set whenever the breakdown dimension changes.
  // Aborts on unmount/dimension-change so closing the tool cancels the in-flight
  // request rather than letting it complete (and its failure surface) after the
  // component is gone.
  useEffect(() => {
    if (!compat) return;
    const ctrl = new AbortController();
    setAllowed(null);
    api.ga4Compatibility(dim, ctrl.signal)
      .then((d) => setAllowed(Array.isArray(d.metrics) ? d.metrics.map((m) => m.toLowerCase()) : null))
      .catch(() => { if (!ctrl.signal.aborted) setAllowed(null); });
    return () => ctrl.abort();
  }, [compat, dim]);

  const isAllowed = (o) => !allowed || allowed.includes(o.toLowerCase());
  // Drop any selected option that's no longer compatible after a dimension change.
  useEffect(() => {
    if (!allowed) return;
    const pruned = sel.filter(isAllowed);
    if (pruned.length !== sel.length) onChange(pruned.join(','));
    // eslint-disable-next-line
  }, [allowed]);

  const toggle = (o) => onChange((sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o]).join(','));
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = sel.includes(o);
        const disabled = !isAllowed(o);
        return (
          <button type="button" key={o} disabled={disabled} onClick={() => toggle(o)}
            title={disabled ? 'Not available for the selected breakdown dimension' : undefined}
            className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${disabled ? 'cursor-not-allowed border-line bg-raised text-slate-300 line-through' : on ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'border-edge text-dim hover:border-brand-300 dark:hover:border-brand-500/40'}`}>
            {o}
          </button>
        );
      })}
      {compat && allowed && <span className="w-full text-xs text-faint">Greyed-out metrics aren’t supported with the “{dim}” breakdown.</span>}
    </div>
  );
}

// Caption Generator returns "━━━ Variation N ━━━\n<caption>" blocks as plain
// text. Render each as its own copyable card instead of one monospace blob.
const VARIATION_RE = /[━─-]{2,}\s*Variation\s*\d+\s*[━─-]{2,}/i;
function CaptionCards({ text }) {
  const parts = String(text).split(/[━─-]{2,}\s*Variation\s*(\d+)\s*[━─-]{2,}/i);
  const cards = [];
  for (let i = 1; i < parts.length; i += 2) {
    const body = (parts[i + 1] || '').trim();
    if (body) cards.push({ n: parts[i], body });
  }
  if (!cards.length) return <pre className="whitespace-pre-wrap text-sm text-body">{text}</pre>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {cards.map((c, i) => (
        <div key={i} className="flex flex-col rounded-xl border border-line bg-surface p-4 transition-shadow hover:shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" aria-hidden /> Variation {c.n}
            </span>
            <button
              onClick={() => copyText(c.body).then(() => toast('Caption copied', 'success'))}
              className="rounded-md border border-line px-2 py-0.5 text-xs font-medium text-muted hover:bg-raised hover:text-body"
            >
              Copy
            </button>
          </div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-body">{c.body}</p>
        </div>
      ))}
    </div>
  );
}

// Time-to-rank buckets → a fast(green)→slow(red) scale so the column is scannable
// at a glance. Anything unrecognised (e.g. "N/A") stays neutral.
function timeToRankClass(s) {
  const t = String(s).toLowerCase();
  if (t.startsWith('0-3')) return 'bg-green-100 dark:bg-green-500/15 text-green-700 dark:text-green-300';
  if (t.startsWith('3-6')) return 'bg-lime-100 dark:bg-lime-500/15 text-lime-700 dark:text-lime-300';
  if (t.startsWith('6-9')) return 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300';
  if (t.startsWith('9-12')) return 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300';
  if (t.includes('more than 12')) return 'bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300';
  return 'bg-sunken text-muted';
}

function cell(col, val) {
  const c = col.toLowerCase();
  const s = String(val ?? '');
  if (!s || s === '—') return <span className="text-faint">—</span>;
  if (c === 'timetorank') return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${timeToRankClass(s)}`}>{s}</span>;
  if (c === 'priority') return <Badge t={s} tone={{ critical: 'red', high: 'amber', medium: 'blue', keep: 'slate' }[s.toLowerCase()]} />;
  if (c === 'severity') return <Badge t={s} tone={{ critical: 'red', high: 'red', medium: 'amber', low: 'green' }[s.toLowerCase()]} />;
  if (c === 'suitability') return <Badge t={s} tone={{ high: 'green', medium: 'amber', low: 'slate' }[s.toLowerCase()]} />;
  if (c === 'intent' || c === 'status' || c === 'type') return <Badge t={s} tone="slate" />;
  if (c === 'difficulty') { const n = parseFloat(s); if (Number.isFinite(n)) return <span className={n < 30 ? 'font-medium text-green-600 dark:text-green-400' : n < 60 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium text-red-600 dark:text-red-400'}>{n}</span>; }
  if (['volume', 'impressions', 'clicks', 'sessions', 'users', 'backlinks', 'traffic', 'conversions'].includes(c)) return <span className="tabular-nums">{fmtNum(s)}</span>;
  if (c === 'url' && /^https?:\/\//i.test(s)) return <a href={s} target="_blank" rel="noreferrer" className="break-all text-brand-600 dark:text-brand-400 hover:underline">{s.replace(/^https?:\/\//i, '')}</a>;
  return s;
}

// Results-level controls for integration tools — re-pivot (range / breakdown)
// without scrolling back to the form. Mirrors index.html's dashboard selectors.
function RepivotBar({ fields, values, busy, onChange }) {
  if (!fields.length) return null;
  return (
    <div className="dm-no-print mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">View</span>
      {fields.map((f) => (
        <label key={f.name} className="flex items-center gap-1.5 text-sm text-dim">
          <span className="text-xs text-muted">{f.label}</span>
          <select
            value={values[f.name]}
            disabled={busy}
            onChange={(e) => onChange(f.name, e.target.value)}
            className="dm-select rounded-lg border border-edge bg-surface py-1 pl-2 pr-7 text-sm transition focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10 disabled:opacity-50"
          >
            {f.options.map((o) => {
              // Options are plain strings or {value,label} (e.g. GSC property,
              // GA4 account). Rendering the object directly throws React #31 and
              // crashed the whole integration page — mirror the main select.
              const v = typeof o === 'string' ? o : o.value;
              const l = typeof o === 'string' ? o : o.label;
              return <option key={v} value={v}>{l}</option>;
            })}
          </select>
        </label>
      ))}
      {busy && <span className="flex items-center gap-1.5 text-xs text-faint"><span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />updating…</span>}
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
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-edge p-2 transition focus-within:border-brand-600 focus-within:ring-4 focus-within:ring-brand-600/10">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand-50 dark:bg-brand-500/10 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300">
            {t}
            <button type="button" onClick={() => remove(t)} className="text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">×</button>
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

      <button type="button" onClick={() => { setDraft(''); setBulk((b) => !b); }} className="mt-1.5 text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
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
        <span className="mt-1 block text-xs text-faint">
          No connected accounts — <Link to="/integrations" className="font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">connect your account</Link> or type an ID manually.
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
        <span className={`truncate ${label ? '' : 'text-faint'}`}>{accounts === null ? 'Loading accounts…' : (label || 'Select an account…')}</span>
        <span className="ml-2 shrink-0 text-faint">▾</span>
      </button>
      {open && accounts && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          <div className="border-b border-hair p-2">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ID…"
              className="w-full rounded-md border border-line px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none focus:ring-4 focus:ring-brand-600/10" />
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {filtered.length ? filtered.map((a) => (
              <button key={a.id} type="button" onClick={() => { onChange(a.id); setOpen(false); }}
                className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-raised ${a.id === value ? 'font-semibold text-brand-700 dark:text-brand-300' : 'text-body'}`}>
                {a.label}
              </button>
            )) : <div className="px-3 py-2 text-sm text-faint">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// Visible mode picker: selectable cards so every option is discoverable up
// front (vs. a collapsed <select> that hides all but the default).
function Segmented({ options, optionDesc = {}, value, onChange }) {
  return (
    <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o)}
            className={`rounded-lg border p-3 text-left transition ${on ? 'border-brand-600 bg-brand-50 dark:bg-brand-500/10 ring-4 ring-brand-600/10' : 'border-line bg-surface hover:border-brand-300 dark:hover:border-brand-500/40'}`}
          >
            <span className={`block text-sm font-semibold ${on ? 'text-brand-700 dark:text-brand-300' : 'text-body'}`}>{o}</span>
            {optionDesc[o] && <span className="mt-0.5 block text-xs text-muted">{optionDesc[o]}</span>}
          </button>
        );
      })}
    </div>
  );
}

// Upload a draft that has no URL yet. The extracted text is written into the
// field named by `field.fills` (the Content box), so the run payload and the
// backend contract stay exactly as they are — the file itself never leaves the
// browser.
function FileField({ field, onFill }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');

  async function handle(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // let the same file be re-picked
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast(`That file is ${(file.size / 1048576).toFixed(1)} MB — please upload something under 15 MB.`, 'error');
      return;
    }
    setBusy(true);
    setName('');
    try {
      const { extractFileText } = await import('../lib/extractFiles.js');
      const text = await extractFileText(file);
      onFill(text);
      setName(file.name);
      toast(`Loaded ${file.name} into the content box.`, 'success');
    } catch (err) {
      toast(`Could not read that file: ${err.message || 'unsupported or corrupt file'}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5">
      <input ref={inputRef} type="file" accept={field.accept} onChange={handle} className="hidden" />
      <button type="button" disabled={busy} onClick={() => inputRef.current?.click()}
        className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-body hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-60">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {busy ? 'Reading…' : 'Upload file'}
      </button>
      {name && <span className="ml-2 text-xs font-medium text-brand-600 dark:text-brand-400">Loaded: {name}</span>}
    </div>
  );
}

// The single "AI suggest" for a form with several suggestible boxes. Sits above
// the first of them and reads as covering the group, rather than three identical
// buttons that each trigger the same one crawl.
function SuggestStrip({ busy, onClick }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint">
      <span>Not sure what to write?</span>
      <button type="button" disabled={busy} onClick={onClick}
        className="inline-flex items-center gap-1 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/20 disabled:opacity-60">
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
        {busy ? 'Drafting…' : 'AI suggest'}
      </button>
      <span>fills the boxes below from your site — free, and yours to edit.</span>
    </div>
  );
}

// Alternative inputs (link / paste / upload) drawn as ONE block: a heading that
// says only one of them is needed, and an "or" rule between each. Loose boxes
// with no framing read as three more things to fill in, so people did the first
// one — the URL — and never noticed the other two ways in.
function FieldGroup({ meta, fields, render }) {
  return (
    <fieldset className="rounded-xl border border-line bg-black/[0.02] dark:bg-white/[0.02] p-4">
      {meta?.title && (
        <legend className="px-1.5 text-sm font-semibold text-body">{meta.title}</legend>
      )}
      {meta?.hint && <p className="-mt-0.5 mb-3 text-xs text-faint">{meta.hint}</p>}
      {fields.map((f, i) => (
        <div key={f.name}>
          {i > 0 && (
            <div className="my-3 flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-line" />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-faint">or</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          )}
          {render(f, { grouped: true })}
        </div>
      ))}
    </fieldset>
  );
}

function Field({ field, value, onChange, autoFocus, provider, values, invalid, setValue, onSuggest, suggesting, labelOverride }) {
  const base = `field mt-1.5${invalid ? ' !border-amber-400 !ring-4 !ring-amber-400/20' : ''}`;
  // Plain-English help on the label itself: an explicit `help` string from the
  // catalog wins, else fall back to the glossary (same matching as result tips).
  const tip = field.help || glossaryFor(field.label);
  return (
    <label className={`block ${invalid ? '-ml-3 rounded-lg border-l-2 border-amber-400 bg-amber-50/50 dark:bg-amber-500/10 pl-3' : ''}`} data-tour-field={field.name}>
      <span className="flex items-start justify-between gap-3 text-sm font-medium text-body">
        <span>
          {labelOverride || field.label}{field.required && <span className={invalid ? 'font-bold text-amber-600 dark:text-amber-400' : 'text-amber-500'}> *</span>}
          {tip && <InfoTip text={tip} className="ml-1" />}
        </span>
        {onSuggest && (
          // Drafts this box from the user's site so they start from real text.
          // A label wraps the whole field, so stopPropagation keeps the click
          // from also focusing the textarea and scrolling the fill out of view.
          <button type="button" disabled={suggesting}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSuggest(); }}
            title="Read my site and draft this for me — you can edit it before running"
            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand-200 dark:border-brand-500/30 bg-brand-50 dark:bg-brand-500/10 px-2 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-500/20 disabled:opacity-60">
            {suggesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Sparkles className="h-3.5 w-3.5" aria-hidden />}
            {suggesting ? 'Drafting…' : (field.suggest?.label || 'AI suggest')}
          </button>
        )}
      </span>
      {field.type === 'file' ? (
        <FileField field={field} onFill={(text) => setValue(field.fills || field.name, text)} />
      ) : field.type === 'account' ? (
        <AccountField provider={provider} value={value} onChange={onChange} placeholder={field.placeholder} />
      ) : field.type === 'tags' ? (
        <>
          <TagInput value={value} onChange={onChange} placeholder={field.placeholder} />
          <span className="mt-1 block text-xs text-faint">Add several — press Enter or comma between keywords.</span>
        </>
      ) : field.type === 'date' ? (
        <input autoFocus={autoFocus} type="date" value={value || ''} max={field.max || '9999-12-31'} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'multiselect' ? (
        <MultiSelect field={field} options={field.options} value={value} onChange={onChange} values={values} />
      ) : field.type === 'segmented' ? (
        <Segmented options={field.options} optionDesc={field.optionDesc} value={value} onChange={onChange} />
      ) : field.type === 'textarea' ? (
        <textarea autoFocus={autoFocus} rows={3} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      ) : field.type === 'select' ? (
        field.options.length > 12 ? (
          <SearchableSelect options={field.options} value={value} onChange={onChange} autoFocus={autoFocus} />
        ) : (
          <select autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} className={`${base} dm-select pr-9`}>
            {field.options.map((o) => {
              // Options are plain strings, or {value,label} where the stored
              // value is a code the user shouldn't have to know (country codes).
              const v = typeof o === 'string' ? o : o.value;
              const l = typeof o === 'string' ? o : o.label;
              return <option key={v} value={v}>{l}</option>;
            })}
          </select>
        )
      ) : (
        <input autoFocus={autoFocus} type={field.type === 'number' ? 'number' : 'text'} inputMode={field.type === 'url' ? 'url' : undefined}
          value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className={base} />
      )}
      {invalid && <span className="mt-1 block text-xs font-semibold text-amber-600 dark:text-amber-400">Please fill this in to continue.</span>}
      {field.hint && <span className="mt-1 block whitespace-pre-line text-xs text-faint">{field.hint}</span>}
    </label>
  );
}
