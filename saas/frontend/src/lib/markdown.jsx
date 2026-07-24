// Renders the Markdown the assistant replies in (## headings, **bold**,
// numbered/bulleted lists, `code`, links, tables, rules, fenced code and
// blockquotes) into React nodes.
//
// Lives here rather than inside ChatDrawer so any surface that shows assistant
// output formats it identically to the drawer — one renderer, one look.
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

// --- Tables -----------------------------------------------------------------
// The answers Monty produces lean on pipe tables and `---` rules constantly. Unrendered, a link-flow audit lands as
// a wall of `| Page | Purpose |` — technically the content, visibly a mess. So
// the block grammar below covers what the model actually writes.

const ROW_RE = /^\s*\|.*\|?\s*$/;                       // a pipe row
const SEP_RE = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/;        // |---|:--:| under the header
const isSep = (l) => l != null && SEP_RE.test(l) && l.includes('-') && l.includes('|');

// Split a row on unescaped pipes, dropping the optional outer ones.
function cells(line) {
  const s = line.trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  const out = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (s[j] === '|') { out.push(cur.trim()); cur = ''; continue; }
    cur += s[j];
  }
  out.push(cur.trim());
  return out;
}

const alignOf = (spec) => (/^:.*:$/.test(spec) ? 'center' : /:$/.test(spec) ? 'right' : undefined);

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

    // Fenced code — take it verbatim, including any pipes or #s inside.
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const close = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(close)) buf.push(lines[i++]);
      i++; // past the closing fence (or off the end, on an unterminated block)
      blocks.push(
        <pre key={`c${k++}`} className="overflow-x-auto rounded-lg border border-line bg-sunken p-3 text-[0.85em] leading-relaxed">
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Table — a pipe row followed by the |---|---| separator.
    if (ROW_RE.test(line) && line.includes('|') && isSep(lines[i + 1])) {
      flushPara();
      const head = cells(line);
      const aligns = cells(lines[i + 1]).map(alignOf);
      i += 2;
      const body = [];
      while (i < lines.length && ROW_RE.test(lines[i]) && lines[i].includes('|')) body.push(cells(lines[i++]));
      const key = `tb${k++}`;
      blocks.push(
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[0.92em]">
            <thead>
              <tr className="border-b border-line">
                {head.map((c, x) => (
                  <th key={x} style={{ textAlign: aligns[x] }} className="py-1.5 pr-3 text-xs font-semibold uppercase tracking-wide text-dim">
                    {renderInline(c, chipFor, `${key}h${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, y) => (
                <tr key={y} className="border-b border-line/60 align-top last:border-0">
                  {head.map((_, x) => (
                    <td key={x} style={{ textAlign: aligns[x] }} className="py-1.5 pr-3">
                      {renderInline(row[x] ?? '', chipFor, `${key}r${y}c${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Thematic break. Bullets need a space after the dash, so `---` can't be one.
    // Directly under a one-line paragraph it's a Setext heading instead, which is
    // how the model underlines section titles.
    const setext = /^\s{0,3}(-{3,}|={3,})\s*$/.exec(line);
    if (setext && para.length === 1) {
      const key = `h${k++}`;
      const heading = para.pop();
      blocks.push(
        <div key={key} className={setext[1][0] === '=' ? 'mt-1 text-base font-bold' : 'mt-2 text-sm font-bold'}>
          {renderInline(heading, chipFor, key)}
        </div>,
      );
      i++; continue;
    }
    if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushPara();
      blocks.push(<hr key={`hr${k++}`} className="border-line" />);
      i++; continue;
    }

    // Blockquote — the model uses it for the copy you're meant to paste.
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const key = `q${k++}`;
      blocks.push(
        <blockquote key={key} className="border-l-2 border-brand-300 dark:border-brand-500/40 pl-3 text-dim">
          <p className="whitespace-pre-wrap">{renderInline(buf.join('\n'), chipFor, key)}</p>
        </blockquote>,
      );
      continue;
    }

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
