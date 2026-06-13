// Dependency-free multi-series SVG trend chart for integration dashboards
// (GSC clicks/impressions, GA4 sessions/users, Ads cost/clicks). Each series is
// normalised to its OWN range so lines on very different scales (e.g. clicks vs
// impressions) stay readable — a true dual-axis trend: series 1 reads off the
// LEFT axis, series 2 off the RIGHT axis (both colour-matched to their line).
const fmt = (n) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n * 100) / 100}`);
const shortDate = (d) => (typeof d === 'string' && d.length >= 10 ? d.slice(5) : d); // MM-DD

export default function TrendChart({ series = [], height = 160 }) {
  const valid = (series || []).filter((s) => s.points && s.points.length);
  if (!valid.length) return <div className="py-4 text-center text-sm text-slate-400">No trend data for this range.</div>;

  const W = 560, H = height, padX = 6, padY = 10;
  const len = Math.max(...valid.map((s) => s.points.length));
  const x = (i) => (len === 1 ? W / 2 : padX + (i / (len - 1)) * (W - padX * 2));
  const rangeOf = (pts) => {
    const vs = pts.map((p) => Number(p.value) || 0);
    return { min: Math.min(...vs), max: Math.max(...vs) };
  };
  // Per-series y-scale (own min/max) so disparate magnitudes stay visible.
  const scaleFor = ({ min, max }) => {
    const range = Math.max(1e-9, max - min);
    return (v) => padY + (1 - (v - min) / range) * (H - padY * 2); // higher value → nearer top
  };
  const dates = valid[0].points.map((p) => p.date);
  const total = (s) => s.points.reduce((a, p) => a + (Number(p.value) || 0), 0);
  const ranges = valid.map((s) => rangeOf(s.points));

  // y-axis tick column (max / mid / min) aligned to the plot's top/middle/bottom.
  const Axis = ({ r, color, side }) => (
    <div
      className={`flex shrink-0 flex-col justify-between text-[10px] font-semibold tabular-nums ${side === 'right' ? 'items-start' : 'items-end'}`}
      style={{ height: H, paddingTop: padY, paddingBottom: padY, color }}
    >
      <span>{fmt(r.max)}</span>
      <span className="text-slate-400">{fmt((r.max + r.min) / 2)}</span>
      <span>{fmt(r.min)}</span>
    </div>
  );

  const leftColor = valid[0].color || '#2563eb';
  const rightColor = valid[1]?.color || '#7c3aed';
  const midIdx = Math.floor((dates.length - 1) / 2);

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
      <div className="flex items-stretch gap-2">
        <Axis r={ranges[0]} color={leftColor} side="left" />
        <div className="relative min-w-0 flex-1">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height: H }} role="img" aria-label="Trend chart">
            {/* horizontal gridlines (top / middle / bottom) */}
            {[0, 0.5, 1].map((f) => {
              const gy = padY + f * (H - padY * 2);
              return <line key={f} x1="0" x2={W} y1={gy} y2={gy} stroke="#eef2f7" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
            })}
            {valid.map((s, si) => {
              const c = s.color || '#2563eb';
              const pts = s.points;
              const y = scaleFor(ranges[si]);
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
            {dates.length > 2 && <span>{shortDate(dates[midIdx])}</span>}
            <span>{shortDate(dates[dates.length - 1])}</span>
          </div>
        </div>
        {valid[1] && <Axis r={ranges[1]} color={rightColor} side="right" />}
      </div>
    </div>
  );
}
