import { useEffect, useRef, useState } from 'react';
import { Bug, X, Paperclip, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { snapshot, summary } from '../lib/diagnostics.js';
import { Attachments, uploadFile } from './Attachments.jsx';

const MUTE_KEY = 'dm_fault_muted'; // session: user asked not to auto-popup again
const PENDING_KEY = 'dm_fault_pending'; // session: ErrorBoundary asked us to open after reload
const CATEGORY = 'Tool not working / bug';

// What sections of the captured diagnostics to include — user-controllable.
const DEFAULT_TOGGLES = { includeFields: true, includeErrors: true, includeFailedActions: true, includeEnv: true };

function Section({ title, count, open, onToggle, children }) {
  return (
    <div className="rounded-lg border border-line">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-body">
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {title}
        {count != null && <span className="ml-auto rounded-full bg-sunken px-2 py-0.5 text-xs text-muted">{count}</span>}
      </button>
      {open && <div className="border-t border-hair px-3 py-2.5">{children}</div>}
    </div>
  );
}

export default function FaultReporter() {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [toggles, setToggles] = useState(DEFAULT_TOGGLES);
  const [includeTech, setIncludeTech] = useState(true);
  const [removedFields, setRemovedFields] = useState(() => new Set()); // labels the user pulled out
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [captured, setCaptured] = useState(null); // diagnostics snapshot frozen at open time
  const fileRef = useRef(null);

  // Freeze a diagnostics snapshot the moment the panel opens, so the captured
  // fields reflect what was on screen at the time of the fault — and prefill the
  // subject from the most recent error.
  function openPanel() {
    const snap = snapshot(DEFAULT_TOGGLES);
    const sum = summary();
    setCaptured(snap);
    setRemovedFields(new Set());
    setSubject((s) => s || sum.lastError || (sum.lastFailure ? `Error on ${sum.lastFailure.path}` : `Problem on ${location.pathname}`));
    setOpen(true);
  }

  function close() {
    setOpen(false);
  }

  function reset() {
    setSubject(''); setDesc(''); setAttachments([]); setCaptured(null);
    setToggles(DEFAULT_TOGGLES); setIncludeTech(true); setRemovedFields(new Set());
  }

  // Auto-open on hard failures, unless the user muted it this session. Debounced
  // so a burst of errors opens the panel once.
  useEffect(() => {
    let t;
    const onFault = () => {
      if (open || sessionStorage.getItem(MUTE_KEY)) return;
      clearTimeout(t);
      t = setTimeout(() => { if (!sessionStorage.getItem(MUTE_KEY)) openPanel(); }, 400);
    };
    window.addEventListener('dm:fault', onFault);
    window.addEventListener('dm:report-fault', openPanel); // manual trigger from elsewhere
    // ErrorBoundary handed us off across a reload.
    if (sessionStorage.getItem(PENDING_KEY)) { sessionStorage.removeItem(PENDING_KEY); openPanel(); }
    return () => { clearTimeout(t); window.removeEventListener('dm:fault', onFault); window.removeEventListener('dm:report-fault', openPanel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function addFiles(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    setUploading(true);
    try { const up = await Promise.all(list.map(uploadFile)); setAttachments((a) => [...a, ...up]); }
    catch { toast('Upload failed — try a smaller file.', 'error'); }
    finally { setUploading(false); }
  }
  function onPaste(e) {
    const imgs = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile());
    if (imgs.length) { e.preventDefault(); addFiles(imgs); }
  }

  // Build the diagnostics payload to send, honoring the master + per-section
  // toggles and any fields the user removed.
  function buildDiagnostics() {
    if (!includeTech) return undefined;
    const snap = snapshot(toggles);
    if (snap.fields) snap.fields = snap.fields.filter((f) => !removedFields.has(f.label));
    return snap;
  }

  async function submit(e) {
    e?.preventDefault();
    if (!subject.trim() && !desc.trim()) { toast('Add a short description of the problem.', 'info'); return; }
    setBusy(true);
    try {
      await api.createTicket(
        (subject.trim() || 'Problem report').slice(0, 200),
        desc.trim() || '(No description provided)',
        { category: CATEGORY, attachments, diagnostics: buildDiagnostics() },
      );
      // Stay put — the user was in the middle of using a tool when the fault
      // happened; don't yank them away to the ticket. They can find it under
      // Support or the notification bell later.
      toast('Thanks — your problem report was sent.', 'success');
      reset(); setOpen(false);
    } catch (err) {
      toast(err.message || 'Could not send the report.', 'error');
    } finally { setBusy(false); }
  }

  function muteAndClose() {
    sessionStorage.setItem(MUTE_KEY, '1');
    close();
  }

  // Live field list for the diagnostics preview (re-collected from the frozen snapshot).
  const fields = (captured?.fields || []).filter((f) => !removedFields.has(f.label));
  const errs = captured?.errors || [];
  const fails = captured?.apiFailures || [];

  return (
    <>
      {/* Launcher tab — pinned to the right edge, hidden while the panel is open. */}
      {!open && (
        <button
          onClick={openPanel}
          title="Report a problem"
          aria-label="Report a problem"
          className="fixed right-0 top-1/2 z-20 flex -translate-y-1/2 items-center gap-1.5 rounded-l-lg bg-slate-800 px-2 py-3 text-xs font-semibold text-white shadow-lg hover:bg-slate-900"
          style={{ writingMode: 'vertical-rl' }}
        >
          <Bug size={15} aria-hidden style={{ writingMode: 'horizontal-tb' }} />
          Report a problem
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Report a problem">
          <div className="absolute inset-0 bg-slate-900/40" onClick={close} />
          <div className="relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-surface shadow-xl sm:rounded-2xl">
            <div className="flex items-center gap-2 border-b border-hair bg-slate-800 px-4 py-3 text-white">
              <Bug size={18} aria-hidden />
              <span className="font-semibold">Report a problem</span>
              <button onClick={close} className="ml-auto rounded p-1 text-slate-300 hover:bg-white/10 hover:text-white" aria-label="Close"><X size={18} aria-hidden /></button>
            </div>

            <form onSubmit={submit} className="flex-1 space-y-3 overflow-y-auto p-4">
              <p className="text-sm text-muted">Tell us what went wrong. We'll automatically include technical details to help us fix it — you can review exactly what's shared below.</p>

              <label className="block">
                <span className="text-sm font-medium text-body">What happened?</span>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary"
                  className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-body">More detail</span>
                <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} onPaste={onPaste}
                  placeholder="What were you trying to do? Paste a screenshot if it helps."
                  className="mt-1.5 w-full rounded-lg border border-edge p-2.5 text-sm focus:border-brand-500 focus:outline-none" />
              </label>

              <Attachments items={attachments} onRemove={(i) => setAttachments((a) => a.filter((_, j) => j !== i))} />
              <div className="flex items-center gap-3 text-xs text-muted">
                <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300"><Paperclip size={13} aria-hidden /> Attach files</button>
                <span>or paste a screenshot</span>
                {uploading && <span>uploading…</span>}
                <input ref={fileRef} type="file" multiple accept="image/*,.pdf,.txt,.log,.json" className="hidden" onChange={(e) => addFiles(e.target.files)} />
              </div>

              {/* Diagnostics — master toggle + reviewable breakdown */}
              <div className="rounded-xl border border-line bg-raised p-3">
                <label className="flex items-center gap-2 text-sm font-medium text-body">
                  <input type="checkbox" checked={includeTech} onChange={(e) => setIncludeTech(e.target.checked)} className="h-4 w-4 rounded border-edge text-brand-600 dark:text-brand-400" />
                  Include technical details
                </label>
                {includeTech && (
                  <>
                    <button type="button" onClick={() => setDetailsOpen((o) => !o)} className="mt-2 flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">
                      {detailsOpen ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
                      Review what's shared ({fields.length} field{fields.length === 1 ? '' : 's'}, {errs.length} error{errs.length === 1 ? '' : 's'}, {fails.length} failed call{fails.length === 1 ? '' : 's'})
                    </button>
                    {detailsOpen && (
                      <div className="mt-2 space-y-2">
                        {/* Per-section master toggles */}
                        <div className="flex flex-wrap gap-3 text-xs text-dim">
                          {[['includeFields', 'Form fields'], ['includeErrors', 'Errors'], ['includeFailedActions', 'Failed actions'], ['includeEnv', 'Browser/page']].map(([k, label]) => (
                            <label key={k} className="flex items-center gap-1.5">
                              <input type="checkbox" checked={toggles[k]} onChange={(e) => setToggles((t) => ({ ...t, [k]: e.target.checked }))} className="h-3.5 w-3.5 rounded border-edge text-brand-600 dark:text-brand-400" />
                              {label}
                            </label>
                          ))}
                        </div>

                        {toggles.includeFields && (
                          <Section title="Form fields you filled in" count={fields.length} open={fieldsOpen} onToggle={() => setFieldsOpen((o) => !o)}>
                            {fields.length === 0 ? <p className="text-xs text-faint">No filled fields detected.</p> : (
                              <ul className="space-y-1">
                                {fields.map((f) => (
                                  <li key={f.label} className="flex items-start gap-2 text-xs">
                                    <span className="min-w-0 flex-1"><span className="font-medium text-dim">{f.label}:</span> <span className="break-words text-muted">{f.value}</span></span>
                                    <button type="button" onClick={() => setRemovedFields((s) => new Set(s).add(f.label))} className="shrink-0 rounded px-1 text-faint hover:text-red-600 dark:hover:text-red-400" aria-label={`Remove ${f.label}`}>×</button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </Section>
                        )}

                        {toggles.includeFailedActions && fails.length > 0 && (
                          <div className="rounded-lg border border-line px-3 py-2 text-xs text-muted">
                            <div className="mb-1 font-medium text-dim">Recent failed actions</div>
                            {fails.slice(-5).map((f, i) => <div key={i} className="truncate">{f.method} {f.path} → {f.status || 'network'}</div>)}
                          </div>
                        )}
                        {toggles.includeErrors && errs.length > 0 && (
                          <div className="rounded-lg border border-line px-3 py-2 text-xs text-muted">
                            <div className="mb-1 font-medium text-dim">Recent errors</div>
                            {errs.slice(-5).map((e, i) => <div key={i} className="truncate">{e.message}</div>)}
                          </div>
                        )}
                        {toggles.includeEnv && captured?.env && (
                          <p className="text-[11px] text-faint">Also shared: page URL, screen size, and browser version.</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button type="button" onClick={muteAndClose} className="text-xs text-faint hover:text-dim">Don't show again this session</button>
                <button type="submit" disabled={busy} className="btn-primary ml-auto" >{busy ? 'Sending…' : 'Send report'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
