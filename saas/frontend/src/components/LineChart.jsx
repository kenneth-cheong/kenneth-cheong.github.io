// Dependency-free SVG line chart for rank-over-time (lower position = higher on
// the chart). Reusable for any { date, value } series.
export default function LineChart({ data, height = 150, accessor = (d) => d.position, invert = true }) {
  const W = 480, H = height;
  const LPAD = 32; // left: Y-axis labels
  const RPAD = 8;
  const TPAD = 12; // top
  const BPAD = 20; // bottom: X-axis date labels

  const allData = (data || []).map((d) => ({ date: d.date, v: accessor(d) }));
  const pts = allData.filter((d) => d.v >= 1);
  if (!pts.length) return <div className="py-4 text-center text-sm text-slate-400">No ranking data yet — refresh to fetch a position.</div>;

  const vs = pts.map((p) => p.v);
  const min = Math.min(...vs), max = Math.max(...vs);
  const range = Math.max(1, max - min);

  const cW = W - LPAD - RPAD;
  const cH = H - TPAD - BPAD;

  // Date-based X so trailing unranked points sit at their actual date,
  // keeping ranked points proportionally placed and not forced to the right edge.
  const tFirst = new Date(allData[0].date).getTime();
  const tLast = new Date(allData[allData.length - 1].date).getTime();
  const dateToX = (date) => {
    if (tFirst === tLast) return LPAD + cW / 2;
    return LPAD + ((new Date(date).getTime() - tFirst) / (tLast - tFirst)) * cW;
  };

  const yv = (v) => {
    const t = (v - min) / range; // 0 = best rank (top) … 1 = worst rank (bottom)
    return invert ? TPAD + t * cH : TPAD + cH - t * cH;
  };

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${dateToX(p.date).toFixed(1)},${yv(p.v).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  // Trailing unranked: last overall data point has no valid position → keyword fell off rankings
  const hasTrailingUnranked =
    allData.length > 0 && (allData[allData.length - 1].v < 1 || !allData[allData.length - 1].v);
  const trailingDate = hasTrailingUnranked ? allData[allData.length - 1].date : null;

  // Y-axis ticks: best, middle (if range > 5), worst
  const rawTicks = range > 5 ? [min, Math.round((min + max) / 2), max] : [min, max];
  const yTicks = [...new Set(rawTicks)];

  const fmtDate = (date) => {
    if (!date) return '';
    const d = new Date(date + 'T00:00:00');
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {/* Faint horizontal grid lines */}
      {yTicks.map((v) => (
        <line key={v} x1={LPAD} y1={yv(v)} x2={W - RPAD} y2={yv(v)} stroke="#f1f5f9" strokeWidth="1" />
      ))}

      {/* Y-axis labels (rank numbers) */}
      {yTicks.map((v) => (
        <text key={v} x={LPAD - 4} y={yv(v) + 4} fontSize="10" fill="#94a3b8" textAnchor="end">
          #{v}
        </text>
      ))}

      {/* Main line */}
      <path d={path} fill="none" stroke="#4f46e5" strokeWidth="2" vectorEffect="non-scaling-stroke" />

      {/* Dashed extension when keyword has since dropped off rankings */}
      {hasTrailingUnranked && (
        <line
          x1={dateToX(last.date).toFixed(1)} y1={yv(last.v).toFixed(1)}
          x2={dateToX(trailingDate).toFixed(1)} y2={(TPAD + cH).toFixed(1)}
          stroke="#4f46e5" strokeWidth="1.5" strokeDasharray="4,3" opacity="0.35"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* Data point markers */}
      {pts.map((p, i) => (
        <circle key={i} cx={dateToX(p.date)} cy={yv(p.v)} r="2.5" fill="#4f46e5" />
      ))}

      {/* Inline last-rank label — hidden when trailing unranked (badge already says "Unranked") */}
      {!hasTrailingUnranked && (
        <text x={dateToX(last.date)} y={yv(last.v) - 6} fontSize="11" fill="#4f46e5" textAnchor="end">
          #{last.v}
        </text>
      )}

      {/* X-axis date labels spanning the full time range */}
      <text x={LPAD} y={H - 4} fontSize="10" fill="#94a3b8" textAnchor="start">
        {fmtDate(allData[0].date)}
      </text>
      <text x={LPAD + cW} y={H - 4} fontSize="10" fill="#94a3b8" textAnchor="end">
        {fmtDate(allData[allData.length - 1].date)}
      </text>
    </svg>
  );
}
