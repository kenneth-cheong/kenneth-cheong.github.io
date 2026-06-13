// Dependency-free SVG line chart for rank-over-time (lower position = higher on
// the chart). Reusable for any { date, value } series.
export default function LineChart({ data, height = 120, accessor = (d) => d.position, invert = true }) {
  const W = 480, H = height, pad = 12;
  const pts = (data || []).map((d) => ({ date: d.date, v: accessor(d) })).filter((d) => d.v > 0);
  if (!pts.length) return <div className="py-4 text-center text-sm text-slate-400">No ranking data yet — refresh to fetch a position.</div>;

  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const range = Math.max(1, max - min);
  const x = (i) => (pts.length === 1 ? W / 2 : pad + (i / (pts.length - 1)) * (W - pad * 2));
  // invert: smaller value (better rank) nearer the top.
  const y = (v) => {
    const t = (v - min) / range; // 0 best … 1 worst
    return invert ? pad + t * (H - pad * 2) : H - pad - t * (H - pad * 2);
  };
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <path d={path} fill="none" stroke="#4f46e5" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.v)} r="2.5" fill="#4f46e5" />)}
      <text x={x(pts.length - 1)} y={y(last.v) - 6} fontSize="11" fill="#4f46e5" textAnchor="end">#{last.v}</text>
    </svg>
  );
}
