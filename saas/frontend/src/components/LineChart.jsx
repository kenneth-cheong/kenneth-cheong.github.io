// Dependency-free SVG line chart for rank-over-time (lower position = higher on
// the chart). Uses CSS aspect-ratio so text labels never stretch.
export default function LineChart({ data, accessor = (d) => d.position, invert = true }) {
  const W = 480, H = 130;
  const LPAD = 36, RPAD = 12, TPAD = 16, BPAD = 24;
  const cW = W - LPAD - RPAD;
  const cH = H - TPAD - BPAD;

  const allData = (data || []).map((d) => ({ date: d.date, v: accessor(d) }));
  const pts = allData.filter((d) => d.v >= 1);
  if (!pts.length) return <div className="py-4 text-center text-sm text-slate-400">No ranking data yet — refresh to fetch a position.</div>;

  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const range = Math.max(1, max - min);

  // Date-proportional X so trailing unranked dates push ranked points left
  const tFirst = new Date(allData[0].date).getTime();
  const tLast  = new Date(allData[allData.length - 1].date).getTime();
  const dx = (date) =>
    tFirst === tLast ? LPAD + cW / 2
      : LPAD + ((new Date(date).getTime() - tFirst) / (tLast - tFirst)) * cW;

  const dy = (v) => {
    const t = (v - min) / range; // 0 = best rank (top) … 1 = worst (bottom)
    return invert ? TPAD + t * cH : TPAD + cH - t * cH;
  };

  const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${dx(p.date).toFixed(1)},${dy(p.v).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];

  // Close the path down to the baseline for the gradient fill
  const fillPath = `${linePath} L${dx(last.date).toFixed(1)},${(TPAD + cH).toFixed(1)} L${dx(first.date).toFixed(1)},${(TPAD + cH).toFixed(1)} Z`;

  const hasTrailingUnranked =
    allData.length > 0 && (allData[allData.length - 1].v < 1 || !allData[allData.length - 1].v);
  const trailingDate = hasTrailingUnranked ? allData[allData.length - 1].date : null;

  // Y ticks: always include best + worst; add midpoint if spread is wide enough
  const mid = Math.round((min + max) / 2);
  const rawTicks = range > 4 && mid !== min && mid !== max ? [min, mid, max] : [min, max];
  const yTicks = [...new Set(rawTicks)];

  const fmtDate = (date) => {
    if (!date) return '';
    const d = new Date(date + 'T00:00:00');
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  };

  return (
    // aspectRatio keeps proportions correct regardless of container width — no label distortion
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ aspectRatio: `${W}/${H}` }}>
      <defs>
        <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#4f46e5" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {/* Horizontal grid lines */}
      {yTicks.map((v) => (
        <line key={v} x1={LPAD} y1={dy(v)} x2={W - RPAD} y2={dy(v)} stroke="#e8eaf0" strokeWidth="0.75" />
      ))}

      {/* Y-axis rank labels */}
      {yTicks.map((v) => (
        <text key={v} x={LPAD - 5} y={dy(v) + 4} fontSize="11" fill="#94a3b8" textAnchor="end">
          #{v}
        </text>
      ))}

      {/* Gradient area fill */}
      <path d={fillPath} fill="url(#lc-fill)" />

      {/* Main line */}
      <path d={linePath} fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

      {/* Trailing unranked: dashed fade to bottom-right */}
      {hasTrailingUnranked && (
        <line
          x1={dx(last.date).toFixed(1)}   y1={dy(last.v).toFixed(1)}
          x2={dx(trailingDate).toFixed(1)} y2={(TPAD + cH).toFixed(1)}
          stroke="#4f46e5" strokeWidth="1.5" strokeDasharray="4,3" opacity="0.3"
        />
      )}

      {/* Data point markers */}
      {pts.map((p, i) => (
        <circle key={i} cx={dx(p.date)} cy={dy(p.v)} r="3" fill="#fff" stroke="#4f46e5" strokeWidth="2" />
      ))}

      {/* X-axis date labels */}
      <text x={dx(allData[0].date)}                   y={H - 5} fontSize="11" fill="#94a3b8" textAnchor="start">
        {fmtDate(allData[0].date)}
      </text>
      <text x={dx(allData[allData.length - 1].date)}  y={H - 5} fontSize="11" fill="#94a3b8" textAnchor="end">
        {fmtDate(allData[allData.length - 1].date)}
      </text>
    </svg>
  );
}
