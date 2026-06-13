import LineChart from './LineChart.jsx';
import TrendChart from './TrendChart.jsx';
import { copyText, toast } from '../lib/ui.js';

// Themed renderer for the structured `sections` result format. Replaces the
// inline-styled HTML strings composites used to return — consistent theme,
// print-friendly, and extends to charts.
const TONE = { red: 'bg-red-100 text-red-700', amber: 'bg-amber-100 text-amber-700', green: 'bg-green-100 text-green-700', blue: 'bg-blue-100 text-blue-700', orange: 'bg-orange-100 text-orange-700', slate: 'bg-slate-100 text-slate-600' };
const BORDER = { green: '#16a34a', blue: '#2563eb', orange: '#ea580c', red: '#dc2626', amber: '#d97706', slate: '#64748b' };

export default function ResultSections({ sections }) {
  return <div className="space-y-5">{sections.map((s, i) => <Section key={i} s={s} />)}</div>;
}

function H({ children }) { return <h4 className="mb-2 font-semibold text-slate-800">{children}</h4>; }

function Section({ s }) {
  switch (s.type) {
    case 'heading': return <h3 className="text-lg font-bold">{s.text}</h3>;
    case 'callout': return <div className="rounded-lg border-l-4 border-brand-500 bg-slate-50 px-4 py-2.5 text-sm text-slate-700">{s.text}</div>;
    case 'text': return <p className="text-sm text-slate-500">{s.text}</p>;
    case 'stats': return (
      <div>{s.title && <H>{s.title}</H>}
        <div className="flex flex-wrap gap-2">{s.items.map((it, i) => (
          <div key={i} className="min-w-[120px] rounded-lg border border-slate-200 p-2.5" style={it.tone ? { borderTopWidth: 3, borderTopColor: BORDER[it.tone] } : undefined}>
            <div className="text-[11px] uppercase tracking-wide text-slate-500">{it.label}</div>
            <div className={`text-lg font-bold ${it.tone === 'red' ? 'text-red-600' : it.tone === 'amber' ? 'text-amber-600' : 'text-slate-900'}`}>{it.value}</div>
          </div>))}
        </div>
      </div>
    );
    case 'list': return (
      <div>{s.title && <H>{s.title}</H>}
        <ul className="ml-5 list-disc space-y-1 text-sm" style={{ color: s.tone === 'green' ? '#166534' : s.tone === 'red' ? '#991b1b' : '#334155' }}>
          {s.items.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      </div>
    );
    // `series` → multi-line trend (integrations); legacy `data` → rank LineChart.
    case 'chart': return <div>{s.title && <H>{s.title}</H>}{Array.isArray(s.series) ? <TrendChart series={s.series} /> : <LineChart data={s.data} />}</div>;
    case 'cards': return <div>{s.title && <H>{s.title}</H>}<div className="space-y-2">{s.items.map((c, i) => <Card key={i} c={c} />)}</div></div>;
    case 'table': return <div>{s.title && <H>{s.title}</H>}<Table columns={s.columns} rows={s.rows} /></div>;
    case 'code': return <CodeBlock title={s.title} filename={s.filename} content={s.content} />;
    default: return null;
  }
}

function Card({ c }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <strong>{c.title}</strong>
        {c.badge && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE[c.badgeTone] || TONE.slate}`}>{c.badge}</span>}
        {c.meta && <span className="ml-auto font-bold">{c.meta}</span>}
      </div>
      {c.barPct != null && <div className="my-2 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-brand-600" style={{ width: `${c.barPct}%` }} /></div>}
      {(c.lines || []).map((l, i) => <div key={i} className="text-[13px] text-slate-600">{l.label && <strong>{l.label}: </strong>}{l.value}</div>)}
      {c.body && <p className="mt-1 text-sm text-slate-600">{c.body}</p>}
    </div>
  );
}

// Downloadable code/text card (llms.txt, etc.) — copy + download a plain file.
function CodeBlock({ title, filename, content }) {
  const download = () => {
    const blob = new Blob([content || ''], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'file.txt';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };
  const btn = 'rounded-md border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-200 hover:bg-slate-700';
  return (
    <div>{title && <H>{title}</H>}
      <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-sm">
        <div className="flex items-center gap-2 border-b border-slate-700/70 px-3 py-2">
          <span className="font-mono text-xs text-slate-400">{filename || 'file.txt'}</span>
          <div className="ml-auto flex gap-1.5">
            <button onClick={() => copyText(content).then(() => toast('Copied to clipboard', 'success'))} className={btn}>Copy</button>
            <button onClick={download} className={btn}>Download</button>
          </div>
        </div>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[13px] leading-relaxed text-slate-200">{content}</pre>
      </div>
    </div>
  );
}

function Table({ columns, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-slate-400"><tr>{columns.map((c) => <th key={c} className="pb-2 pr-4 capitalize">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i} className={`border-t border-slate-100 ${i % 2 ? 'bg-slate-50/50' : ''}`}>
            {columns.map((c) => <td key={c} className="py-1.5 pr-4">{String(r[c] ?? '—')}</td>)}
          </tr>))}
        </tbody>
      </table>
    </div>
  );
}
