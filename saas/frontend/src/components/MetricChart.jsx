// Dependency-free single-series SVG chart for a performance metric over time.
// Unlike LineChart (rank-only, drops values < 1) this plots ANY magnitude incl.
// zero, and unlike TrendChart it shows no misleading "total" — a metric like
// avg position or health score isn't additive. Good/bad polarity is conveyed by
// the caller's delta chip, not the line direction, so the plot stays literal.
const fmtNum = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n * 100) / 100}`);
const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en', { month: 'short', day: 'numeric' });
};

export default function MetricChart({ data, color = '#4f46e5' }) {
  const pts = (data || []).map((d) => ({ date: d.date, v: Number(d.value) || 0 }));
  if (pts.length < 2) return null;

  const W = 480, H = 120, LPAD = 40, RPAD = 12, TPAD = 14, BPAD = 22;
  const cW = W - LPAD - RPAD, cH = H - TPAD - BPAD;

  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const range = Math.max(1e-9, max - min);

  const tFirst = new Date(pts[0].date).getTime();
  const tLast = new Date(pts[pts.length - 1].date).getTime();
  const dx = (date) => (tFirst === tLast ? LPAD + cW / 2 : LPAD + ((new Date(date).getTime() - tFirst) / (tLast - tFirst)) * cW);
  const dy = (v) => TPAD + cH - ((v - min) / range) * cH; // higher value → nearer top

  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${dx(p.date).toFixed(1)},${dy(p.v).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];
  const fillPath = `${linePath} L${dx(last.date).toFixed(1)},${(TPAD + cH).toFixed(1)} L${dx(first.date).toFixed(1)},${(TPAD + cH).toFixed(1)} Z`;

  const mid = (min + max) / 2;
  const yTicks = max === min ? [min] : [max, mid, min];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ aspectRatio: `${W}/${H}` }}>
      <defs>
        <linearGradient id="mc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.14" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={LPAD} y1={dy(v)} x2={W - RPAD} y2={dy(v)} stroke="#e8eaf0" strokeWidth="0.75" />
          <text x={LPAD - 5} y={dy(v) + 4} fontSize="11" fill="#94a3b8" textAnchor="end">{fmtNum(v)}</text>
        </g>
      ))}

      <path d={fillPath} fill="url(#mc-fill)" />
      <path d={linePath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => (
        <circle key={i} cx={dx(p.date)} cy={dy(p.v)} r="2.5" fill="#fff" stroke={color} strokeWidth="2" />
      ))}

      <text x={dx(first.date)} y={H - 5} fontSize="11" fill="#94a3b8" textAnchor="start">{fmtDate(first.date)}</text>
      <text x={dx(last.date)} y={H - 5} fontSize="11" fill="#94a3b8" textAnchor="end">{fmtDate(last.date)}</text>
    </svg>
  );
}
