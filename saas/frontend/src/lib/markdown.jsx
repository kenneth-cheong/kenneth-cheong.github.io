// Renders the lightweight Markdown the assistant replies in (## headings,
// **bold**, numbered/bulleted lists, `code`, links) into React nodes.
//
// Lives here rather than inside ChatDrawer because assistant output is no
// longer chat-only: "Do it for me" streams its answer into the tool result in
// the main section (see InlineAnswer), and it has to be formatted identically
// to the drawer — one renderer, one look.
//
// We render to elements (not dangerouslySetInnerHTML) so there's no
// HTML-injection surface and the chat's chips stay real buttons.
//
// Replies may also carry our own [[tool:id]] / [[go:path|label]] /
// [[action:verb|arg]] / [[ask:label|text]] chip tokens. `chipFor` turns one
// into a node; callers with nowhere to put a chip should strip them first with
// stripChips() — an unhandled token falls back to printing its raw source.

const TOKEN_RE = /\[\[(tool|action|go|ask):([^\]]+)\]\]/gi;
// Source for the inline-emphasis matcher. A FRESH RegExp is built per call
// (below) because inlineMd recurses — a shared /g regex would clobber its own
// lastIndex across recursion levels.
const INLINE_SRC = '(\\*\\*)([^]+?)\\1|(\\*)([^]+?)\\3|`([^`]+)`|\\[([^\\]]+)\\]\\(([^)\\s]+)\\)';

/** Drop chip tokens from a reply — for surfaces that can't render them. */
export function stripChips(text) {
  return String(text ?? '').replace(TOKEN_RE, '').replace(/[ \t]{2,}/g, ' ');
}

// Inline Markdown within one text run: bold, italic, code, links.
function inlineMd(text, keyBase) {
  const re = new RegExp(INLINE_SRC, 'g');
  const out = [];
  let last = 0, m, i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyBase}i${i++}`;
    if (m[1]) out.push(<strong key={key} className="font-semibold">{inlineMd(m[2], key)}</strong>);
    else if (m[3]) out.push(<em key={key} className="italic">{inlineMd(m[4], key)}</em>);
    else if (m[5] != null) out.push(<code key={key} className="rounded bg-overlay/70 px-1 py-0.5 text-[0.85em]">{m[5]}</code>);
    else if (m[6] != null) out.push(<a key={key} href={m[7]} target="_blank" rel="noreferrer" className="text-brand-700 dark:text-brand-300 underline">{m[6]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// A single text run: split out our chip tokens, inline-Markdown the rest.
function renderInline(text, chipFor, keyBase) {
  const out = [];
  let last = 0, m, i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) inlineMd(text.slice(last, m.index), `${keyBase}t${i}`).forEach((n) => out.push(n));
    out.push(chipFor?.(m[1].toLowerCase(), m[2], `${keyBase}c${i}`) ?? m[0]);
    last = m.index + m[0].length; i++;
  }
  if (last < text.length) inlineMd(text.slice(last), `${keyBase}e`).forEach((n) => out.push(n));
  return out;
}

export function renderMessage(text, chipFor) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const para = [];
  let k = 0, i = 0;
  const flushPara = () => {
    if (!para.length) return;
    const key = `p${k++}`;
    blocks.push(<p key={key} className="whitespace-pre-wrap">{renderInline(para.join('\n'), chipFor, key)}</p>);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1].length;
      const key = `h${k++}`;
      const cls = level <= 1 ? 'mt-1 text-base font-bold' : level === 2 ? 'mt-2 text-sm font-bold' : 'mt-1.5 text-sm font-semibold';
      blocks.push(<div key={key} className={cls}>{renderInline(h[2], chipFor, key)}</div>);
      i++; continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    const bulleted = /^\s*[-*]\s+/.test(line);
    if (ordered || bulleted) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const mm = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!mm) break;
        const key = `li${k++}`;
        items.push(<li key={key}>{renderInline(mm[1], chipFor, key)}</li>);
        i++;
      }
      const key = `l${k++}`;
      blocks.push(ordered
        ? <ol key={key} className="list-decimal space-y-1 pl-5">{items}</ol>
        : <ul key={key} className="list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }
    if (line.trim() === '') { flushPara(); i++; continue; }
    para.push(line); i++;
  }
  flushPara();
  return <div className="space-y-2">{blocks}</div>;
}
