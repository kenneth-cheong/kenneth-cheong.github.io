// One branded "Download PDF" for every tool result in the platform.
//
// There is no PDF library here on purpose. The browser's own print-to-PDF
// already renders our real CSS — web fonts, tables, charts, the injected
// landscape flip in ReportHtml — whereas jsPDF/html2canvas would rasterise a
// screenshot and throw away selectable text and every one of the print rules
// that were tuned in index.css. So this exports by printing, and the work is in
// making sure what lands on the page is JUST the report, wearing our branding.
//
// Two pieces, used together:
//   <PdfButton targetRef={ref} />   — the toolbar button
//   <PrintBrand … />               — header + running footer, print-only
// and the report container carries `dm-print-root` (or is handed in via ref).
import { useRef } from 'react';
import { FileDown } from 'lucide-react';
import { getPreference, setPreference, isDarkTheme } from '../lib/theme.js';

export const BRAND = 'Digimetrics';
export const BRAND_HOST = 'platform.digimetrics.ai';

// Everything outside the report has to disappear, and "hide the chrome" by
// selector doesn't hold: each bespoke audit page lays its inputs out
// differently, and half of them never use a <form>, so a form-based rule
// printed the whole questionnaire above the findings. Instead we mark the
// ancestor chain of the report and let CSS hide every element hanging off that
// path — which works for any page shape, including ones not written yet.
function markPath(el) {
  const marked = [];
  // Start at the PARENT: marking the report itself as a path element would make
  // its own children match the hide rule, and the export came out blank.
  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    n.classList.add('dm-print-path');
    marked.push(n);
  }
  el.classList.add('dm-print-root');
  document.body.classList.add('dm-printing');
  return marked;
}

function unmarkPath(marked, el) {
  marked.forEach((n) => n.classList.remove('dm-print-path'));
  el.classList.remove('dm-print-root');
  document.body.classList.remove('dm-printing');
}

// Print the given element (or the first .dm-print-root on the page) as a PDF.
//
// The theme flip is not cosmetic. Report HTML arrives light-themed with colours
// baked into inline style="", and on a dark canvas lib/reportTheme.js rewrites
// those inline values to dark ones — which the print stylesheet cannot undo,
// because you can't out-specify an inline style. Royal is the default theme, so
// without this the typical user's PDF is pale grey ink on white paper. Flipping
// the real preference makes reportTheme restore the originals (it stashes them
// in data-dm-orig), and the preference is put back the moment printing ends.
export function printReport(el) {
  const root = el || document.querySelector('.dm-print-root');
  const pref = getPreference();
  const flipped = isDarkTheme(pref);
  if (flipped) setPreference('light');

  const marked = root ? markPath(root) : [];
  let cleaned = false;
  const done = () => {
    if (cleaned) return;
    cleaned = true;
    if (root) unmarkPath(marked, root);
    if (flipped) setPreference(pref);
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  // Safari has shipped versions that never fire afterprint; a timer is the
  // safety net so a missed event can't strand the app light and half-hidden.
  setTimeout(() => { if (!cleaned) done(); }, 60000);

  // Two frames: setPreference re-renders React and reportTheme rewrites the
  // report's inline styles in a layout effect. print() is synchronous and would
  // otherwise snapshot the document mid-flip. rAF is raced against a timer
  // because a throttled/hidden tab can stall frames indefinitely — there the
  // export would simply never open.
  let fired = false;
  const go = () => { if (fired) return; fired = true; window.print(); };
  requestAnimationFrame(() => requestAnimationFrame(go));
  setTimeout(go, 120);
}

export function PdfButton({ targetRef, className = '', label = 'Download PDF' }) {
  const fallback = useRef(null);
  return (
    <button
      type="button"
      ref={fallback}
      title="Save this report as a branded PDF (choose “Save as PDF” in the print dialog)"
      onClick={() => printReport(targetRef?.current)}
      className={className || 'inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-dim hover:border-brand-300 dark:hover:border-brand-500/40 hover:text-brand-600 dark:hover:text-brand-400'}
    >
      <FileDown size={13} aria-hidden /> {label}
    </button>
  );
}

// White-label header + running footer. Invisible on screen; the print
// stylesheet is what reveals it, so it costs nothing until someone exports.
//
// `client` leads because these reports get forwarded to the client whose site
// they describe — their name at the top, ours in the footer.
export default function PrintBrand({ title, subtitle, project, user }) {
  const client = project?.name || (user?.email ? user.email.split('@')[0] : BRAND);
  const target = subtitle || project?.domain || '';
  const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <>
      <div className="dm-print-header" aria-hidden="true">
        <div className="dm-ph-main">
          <div className="dm-ph-brand">{client}</div>
          <div className="dm-ph-title">{title}{target ? ` · ${target}` : ''}</div>
        </div>
        <img src="/digimetrics-logo-on-light.png" alt="" className="dm-ph-logo" />
      </div>
      <div className="dm-print-footer" aria-hidden="true">
        <span>{title}{target ? ` · ${target}` : ''}</span>
        <span>Generated {date} · {BRAND} · {BRAND_HOST}</span>
      </div>
    </>
  );
}
