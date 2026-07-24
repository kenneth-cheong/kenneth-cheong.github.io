import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, AlertTriangle, ExternalLink, Pencil, RotateCcw } from 'lucide-react';
import { copyText, toast } from '../lib/ui.js';

// Polished JSON-LD output for the Schema Generator. Replaces the duplicated
// plain-<pre> dump with a validated, syntax-highlighted code card plus copy /
// download / "test in Google" actions.
//
// The card is also EDITABLE: the generated schema is a starting point, and the
// two things people always have to fix by hand (a logo pointing at the homepage
// instead of an image file, a missing address/phone) are faster to type here
// than in their CMS. Every keystroke is re-validated — JSON syntax first, then
// schema.org-level lint — so a broken block can't be copied out unnoticed.
//
// `json` is the raw string the backend returns as r.text. `onChange` (optional)
// lets the parent keep its own Copy/PDF actions in sync with the edited text.
export default function SchemaResult({ json, onChange }) {
  const [withTag, setWithTag] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => format(json));
  const taRef = useRef(null);

  // A new run replaces the result — drop any edit made against the old one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setDraft(format(json)); setEditing(false); onChange?.(null); }, [json]);

  const setText = (text) => { setDraft(text); onChange?.(text); };

  const { parsed, error, notes } = useMemo(() => validate(draft), [draft]);
  const valid = !error;
  const type = (parsed && !Array.isArray(parsed) && parsed['@type']) || '';
  const snippet = withTag ? `<script type="application/ld+json">\n${draft}\n</script>` : draft;
  const dirty = draft !== format(json);

  const download = () => {
    const blob = new Blob([snippet], { type: 'application/ld+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${(type || 'schema').toLowerCase()}.jsonld`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const startEdit = () => {
    setEditing(true);
    // Focus after the textarea mounts, caret at the top rather than the end.
    setTimeout(() => { const el = taRef.current; if (el) { el.focus(); el.setSelectionRange(0, 0); } }, 0);
  };

  // Tab indents instead of leaving the field — this is a code editor, however small.
  const onKeyDown = (e) => {
    if (e.key !== 'Tab' || e.shiftKey) return;
    e.preventDefault();
    const el = e.target;
    const { selectionStart: s, selectionEnd: n } = el;
    const next = `${draft.slice(0, s)}  ${draft.slice(n)}`;
    setText(next);
    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
  };

  return (
    <div>
      {/* meta row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {type && <span className="rounded-full bg-brand-50 dark:bg-brand-500/10 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:text-brand-300">{type}</span>}
        {valid
          ? <span className="inline-flex items-center gap-1 rounded-full bg-green-50 dark:bg-green-500/10 px-2.5 py-1 text-xs font-semibold text-green-700 dark:text-green-300"><Check size={13} aria-hidden /> Valid JSON-LD</span>
          : <span className="inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-700 dark:text-red-300"><AlertTriangle size={13} aria-hidden /> Invalid JSON</span>}
        {valid && notes.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
            <AlertTriangle size={13} aria-hidden /> {notes.length} to fix
          </span>
        )}
        {dirty && <span className="rounded-full bg-sunken px-2.5 py-1 text-xs font-medium text-dim">Edited</span>}
        <a href="https://search.google.com/test/rich-results" target="_blank" rel="noreferrer"
           className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:hover:text-brand-300">Test in Google Rich Results <ExternalLink size={12} aria-hidden /></a>
      </div>

      {/* code card */}
      <div className={`overflow-hidden rounded-xl border bg-slate-900 shadow-sm ${editing ? 'border-brand-500/70 ring-1 ring-brand-500/30' : 'border-slate-700'}`}>
        <div className="flex items-center gap-2 border-b border-slate-700/70 px-3 py-2">
          <span className="flex gap-1.5" aria-hidden>
            <i className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
            <i className="h-2.5 w-2.5 rounded-full bg-amber-400/70" />
            <i className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
          </span>
          <span className="ml-1 font-mono text-xs text-faint">
            {editing ? 'editing — changes are checked as you type' : (withTag ? 'index.html · <head>' : `${(type || 'schema').toLowerCase()}.jsonld`)}
          </span>
          <div className="dm-no-print ml-auto flex items-center gap-1.5">
            {editing ? (
              <>
                <CardBtn onClick={() => setText(format(draft))} disabled={!valid} title={valid ? 'Re-indent' : 'Fix the syntax error first'}>Format</CardBtn>
                {dirty && <CardBtn onClick={() => setText(format(json))} title="Discard my edits"><RotateCcw size={11} className="mr-1 inline" aria-hidden />Reset</CardBtn>}
                <CardBtn onClick={() => setEditing(false)} primary>Done</CardBtn>
              </>
            ) : (
              <>
                <CardBtn onClick={startEdit}><Pencil size={11} className="mr-1 inline" aria-hidden />Edit</CardBtn>
                <CardBtn onClick={() => setWithTag((v) => !v)}>{withTag ? 'JSON only' : 'With <script>'}</CardBtn>
                <CardBtn onClick={() => copyText(snippet).then(() => toast('Copied to clipboard', 'success'))}>Copy</CardBtn>
                <CardBtn onClick={download}>Download</CardBtn>
              </>
            )}
          </div>
        </div>
        {editing ? (
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            aria-label="Edit the JSON-LD schema"
            rows={Math.min(40, Math.max(8, draft.split('\n').length + 1))}
            className="block w-full resize-y border-0 bg-slate-900 px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-200 outline-none focus:ring-0"
          />
        ) : (
          <pre className="overflow-x-auto px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-200">{highlight(snippet)}</pre>
        )}
      </div>

      {/* live validation */}
      {error ? (
        <div className="mt-2 flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-500/10 px-3 py-2 text-sm text-red-800 dark:text-red-300">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <b>This isn’t valid JSON yet.</b> {error.message}
            {error.line != null && <> — line {error.line}, column {error.col}.</>}
            {' '}Search engines will ignore the block until it parses.
          </span>
        </div>
      ) : notes.length > 0 ? (
        <ul className="mt-2 space-y-1 rounded-lg bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {notes.map((n, i) => (
            <li key={i} className="flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span>{n.path && <code className="rounded bg-black/5 dark:bg-white/10 px-1 font-mono text-xs">{n.path}</code>} {n.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-green-700 dark:text-green-400">
          <Check size={15} aria-hidden /> Valid JSON-LD with no missing or placeholder values.
        </p>
      )}

      <p className="mt-2 text-xs text-faint">
        Paste this into your page’s <code className="rounded bg-sunken px-1 text-dim">&lt;head&gt;</code> — one block per page. It’s invisible to visitors and read by search engines.
      </p>
    </div>
  );
}

function CardBtn({ children, onClick, disabled, title, primary }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`rounded-md border px-2 py-0.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? 'border-brand-500 bg-brand-600 text-white hover:bg-brand-500'
          : 'border-slate-600 bg-slate-800 text-slate-200 hover:border-slate-500 hover:bg-slate-700'}`}>
      {children}
    </button>
  );
}

// Pretty-print when parseable, otherwise hand the text back untouched (a draft
// mid-edit is invalid far more often than not).
function format(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text || ''; }
}

const URL_KEYS = new Set(['url', 'logo', 'image', 'sameAs', 'contentUrl', 'thumbnailUrl', 'menu', 'target']);
const IMAGE_KEYS = new Set(['logo', 'image', 'thumbnailUrl', 'contentUrl']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i;
const PLACEHOLDER = /^(your |example|todo|tbd|xxx|n\/a|lorem )|example\.com/i;

// Two layers: JSON syntax (hard error — the block is dead without it) and
// schema.org lint (soft notes — Google accepts it but the rich result suffers).
function validate(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { parsed: null, error: jsonError(e, text), notes: [] };
  }
  return { parsed, error: null, notes: lint(parsed) };
}

function jsonError(e, text) {
  const raw = String(e?.message || 'Unexpected character.');
  // V8 appends "in JSON at position 42 (line 3 column 5)" — keep the human half,
  // report the location ourselves so the wording is consistent across browsers.
  const message = raw.replace(/\s*in JSON at position.*$/i, '').replace(/^JSON\.parse:\s*/i, '').trim() || 'Unexpected character.';
  const lineCol = raw.match(/line (\d+) column (\d+)/i);
  if (lineCol) return { message, line: Number(lineCol[1]), col: Number(lineCol[2]) };
  const pos = raw.match(/position (\d+)/i);
  if (pos) {
    const upto = text.slice(0, Number(pos[1]));
    const nl = upto.lastIndexOf('\n');
    return { message, line: upto.split('\n').length, col: Number(pos[1]) - nl };
  }
  return { message };
}

function lint(root) {
  const notes = [];
  const add = (path, message) => { if (notes.length < 10) notes.push({ path, message }); };

  const top = Array.isArray(root) ? root[0] : root;
  if (!top || typeof top !== 'object') {
    add('', 'Schema should be a JSON object (or an array of them).');
    return notes;
  }
  const ctx = JSON.stringify(top['@context'] || '');
  if (!top['@context']) add('@context', 'is missing — add "@context": "https://schema.org".');
  else if (!ctx.includes('schema.org')) add('@context', 'should point at https://schema.org.');
  if (!top['@type']) add('@type', 'is missing — search engines won’t know what this describes.');

  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const key = path.split('.').pop().replace(/\[\d+\]$/, '');
    if (typeof node === 'string') {
      const val = node.trim();
      if (!val) { add(path, 'is empty — fill it in or remove the field.'); return; }
      if (PLACEHOLDER.test(val)) { add(path, 'still looks like placeholder text.'); return; }
      if (URL_KEYS.has(key)) {
        if (!/^https?:\/\//i.test(val)) { add(path, 'should be a full URL starting with https://.'); return; }
        // The single most common generated-schema defect: logo/image left
        // pointing at the homepage, which Google rejects as an image.
        if (IMAGE_KEYS.has(key) && !IMAGE_EXT.test(val)) add(path, 'should point at an image file (…/logo.png), not a page.');
      }
    }
  };
  walk(root, '');

  // Empty containers read as "answered" but carry nothing.
  const emptyWalk = (node, path) => {
    if (Array.isArray(node)) {
      if (node.length === 0) add(path, 'is an empty list.');
      else node.forEach((v, i) => emptyWalk(v, `${path}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) emptyWalk(v, path ? `${path}.${k}` : k);
    }
  };
  emptyWalk(root, '');

  return notes;
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
    if (m[1]) push(m[0], 'text-muted');        // <script> wrapper
    else if (m[2]) push(m[0], 'text-sky-300');     // key:
    else if (m[3]) push(m[0], 'text-emerald-300'); // string value
    else if (m[4]) push(m[0], 'text-amber-300');   // number
    else if (m[5]) push(m[0], 'text-purple-300');  // bool / null
    last = re.lastIndex;
  }
  if (last < code.length) push(code.slice(last));
  return out;
}
