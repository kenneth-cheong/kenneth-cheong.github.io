import { useState } from 'react';
import { copyText, toast } from '../lib/ui.js';

// Polished JSON-LD output for the Schema Generator. Replaces the duplicated
// plain-<pre> dump with a validated, syntax-highlighted code card plus copy /
// download / "test in Google" actions. Pure presentation — input is the raw
// JSON-LD string the backend already returns as r.text.
export default function SchemaResult({ json }) {
  const [withTag, setWithTag] = useState(true);

  let parsed = null, valid = false, type = '';
  try { parsed = JSON.parse(json); valid = true; type = parsed['@type'] || ''; } catch { /* invalid JSON */ }
  const pretty = valid ? JSON.stringify(parsed, null, 2) : (json || '');
  const snippet = withTag ? `<script type="application/ld+json">\n${pretty}\n</script>` : pretty;

  const download = () => {
    const blob = new Blob([snippet], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(type || 'schema').toLowerCase()}.jsonld`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* meta row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {type && <span className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700">{type}</span>}
        {valid
          ? <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700">✓ Valid JSON-LD</span>
          : <span className="rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700">⚠ Couldn’t parse</span>}
        <a href="https://search.google.com/test/rich-results" target="_blank" rel="noreferrer"
           className="ml-auto text-xs font-medium text-brand-600 hover:text-brand-700">Test in Google Rich Results ↗</a>
      </div>

      {/* code card */}
      <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-700/70 px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <i className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
            <i className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
            <i className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
          </span>
          <span className="ml-1 font-mono text-xs text-slate-400">{withTag ? 'index.html · <head>' : `${(type || 'schema').toLowerCase()}.jsonld`}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <CardBtn onClick={() => setWithTag((v) => !v)}>{withTag ? 'JSON only' : 'With <script>'}</CardBtn>
            <CardBtn onClick={() => copyText(snippet).then(() => toast('Copied to clipboard', 'success'))}>Copy</CardBtn>
            <CardBtn onClick={download}>Download</CardBtn>
          </div>
        </div>
        <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-200">{highlight(snippet)}</pre>
      </div>

      <p className="mt-2 text-xs text-slate-400">
        Paste this into your page’s <code className="rounded bg-slate-100 px-1 text-slate-600">&lt;head&gt;</code> — one block per page. It’s invisible to visitors and read by search engines.
      </p>
    </div>
  );
}

function CardBtn({ children, onClick }) {
  return (
    <button onClick={onClick}
      className="rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-700">
      {children}
    </button>
  );
}

// Lightweight JSON syntax highlighter → array of colored spans (no innerHTML).
// Tints keys, string/number/boolean values, and the surrounding <script> tag.
function highlight(code) {
  const out = [];
  let key = 0;
  const push = (text, cls) => out.push(cls ? <span key={key++} className={cls}>{text}</span> : <span key={key++}>{text}</span>);
  const re = /(<\/?script[^>]*>)|("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g;
  let last = 0, m;
  while ((m = re.exec(code))) {
    if (m.index > last) push(code.slice(last, m.index));
    if (m[1]) push(m[0], 'text-slate-500');        // <script> wrapper
    else if (m[2]) push(m[0], 'text-sky-300');     // key:
    else if (m[3]) push(m[0], 'text-emerald-300'); // string value
    else if (m[4]) push(m[0], 'text-amber-300');   // number
    else if (m[5]) push(m[0], 'text-purple-300');  // bool / null
    last = re.lastIndex;
  }
  if (last < code.length) push(code.slice(last));
  return out;
}
