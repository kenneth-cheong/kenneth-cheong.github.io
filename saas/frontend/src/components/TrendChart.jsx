// Dependency-free multi-series SVG trend chart for integration dashboards
// (GSC clicks/impressions, GA4 sessions/users, Ads cost/clicks). Each series is
// normalised to its OWN range so lines on very different scales (e.g. clicks vs
// impressions) stay readable — like index.html's dual-axis trend.
const fmt = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n * 100) / 100}`);
const shortDate = (d) => (typeof d === 'string' && d.length >= 10 ? d.slice(5) : d); // MM-DD

export default function TrendChart({ series = [], height = 150 }) {
  const valid = (series || []).filter((s) => s.points && s.points.length);
  if (!valid.length) return <div className="py-4 text-center text-sm text-slate-400">No trend data for this range.</div>;

  const W = 560, H = height, padX = 14, padY = 16;
  const len = Math.max(...valid.map((s) => s.points.length));
  const x = (i) => (len === 1 ? W / 2 : padX + (i / (len - 1)) * (W - padX * 2));
  // Per-series y-scale (own min/max) so disparate magnitudes stay visible.
  const scaleFor = (pts) => {
    const vs = pts.map((p) => Number(p.value) || 0);
    const min = Math.min(...vs), max = Math.max(...vs), range = Math.max(1e-9, max - min);
    return (v) => padY + (1 - (v - min) / range) * (H - padY * 2); // higher value → nearer top
  };
  const dates = valid[0].points.map((p) => p.date);
  const total = (s) => s.points.reduce((a, p) => a + (Number(p.value) || 0), 0);

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        {valid.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color || '#2563eb' }} />
            {s.label}<span className="text-slate-400">· {fmt(total(s))}</span>
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} role="img" aria-label="Trend chart">
        {valid.map((s) => {
          const c = s.color || '#2563eb';
          const pts = s.points;
          const y = scaleFor(pts);
          const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(Number(p.value) || 0).toFixed(1)}`).join(' ');
          const last = pts[pts.length - 1];
          return (
            <g key={s.label}>
              <path d={path} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
              <circle cx={x(pts.length - 1)} cy={y(Number(last.value) || 0)} r="2.5" fill={c} />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-400">
        <span>{shortDate(dates[0])}</span>
        <span>{shortDate(dates[dates.length - 1])}</span>
      </div>
    </div>
  );
}
