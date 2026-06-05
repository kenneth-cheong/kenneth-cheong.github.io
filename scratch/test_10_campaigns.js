/**
 * Background-coloring coverage test across 10 REAL campaigns from Monday board
 * 2845615047 ("Integrated Campaign Info Repository"), pulled live 2026-06-05.
 *
 * Replicates the FIXED production logic (index.html ~25027 + ~25738) and checks,
 * for each campaign, WHICH month columns get a trajectory background ("coloured")
 * across the live 6-month window. A month is coloured iff a KPI campaign is active
 * at that month's end (expectedP1 > 0) — the exact rule the Apr/May question was about.
 *
 * The 10 were chosen to hit every branch + both fixes:
 *   - full-span / multi-year                  (all months coloured)
 *   - ends on the LAST day of a month         (fix #1: that month must stay coloured)
 *   - starts mid-window / on a month boundary (pre-start months blank)
 *   - starts at "today" in June               (fix #2: current month must be visible)
 *   - cluster KPI campaigns                   (clusterKpi column)
 *   - fully-past campaign                     (all blank — control)
 *
 * NOTE: green/yellow/red WITHIN a coloured month depends on per-month P1 counts from
 * live SE Ranking data, which isn't in Monday — so this test verifies month COVERAGE
 * (coloured vs blank + the expected target), which is what the two fixes affect.
 *
 * Run:  node scratch/test_10_campaigns.js
 */

// ---- FIXED production functions (copied from index.html) -------------------
function buildWindowMonths(today, monthsBack) {
  const dateTo   = new Date(today.getTime());
  const dateFrom = new Date(new Date(today.getTime()).setMonth(today.getMonth() - monthsBack));
  const out = [];
  const cur  = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), 1);
  const stop = new Date(dateTo.getFullYear(),   dateTo.getMonth(),   1);
  const ymLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  while (cur <= stop) { out.push(ymLocal(cur)); cur.setMonth(cur.getMonth() + 1); }
  return out;
}
function computeMonthlyExpected(months, kpiCampaigns) {
  return months.map(ym => {
    const [y, mo] = ym.split('-').map(Number);
    const monthEnd = new Date(y, mo, 0, 23, 59, 59).getTime();
    let expectedP1 = 0, totalKPI = 0;
    kpiCampaigns.forEach(c => {
      const start = new Date(c.startDate).getTime();
      const end   = new Date(`${String(c.endDate).slice(0, 10)}T23:59:59`).getTime();
      if (monthEnd < start || monthEnd > end || end <= start) return;
      expectedP1 += c.kpi * ((monthEnd - start) / (end - start));
      totalKPI   += c.kpi;
    });
    return { expectedP1, totalKPI };
  });
}

// ---- assert helper --------------------------------------------------------
let pass = 0, fail = 0;
function ok(cond, msg) { cond ? (pass++, console.log(`    ✓ ${msg}`)) : (fail++, console.log(`    ✗ ${msg}`)); }

// ---- the 10 real campaigns ------------------------------------------------
// kpi = numbers3 for Standard/Internal-KPI, numeric_mksrz985 for Cluster.
const CAMPAIGNS = [
  { name: 'CLA Global TS',          type: 'Standard', kpi: 10, startDate: '2025-11-01', endDate: '2026-10-31', note: 'full-span (Nov→Oct)' },
  { name: 'HiMetal',                type: 'Standard', kpi: 12, startDate: '2025-11-09', endDate: '2028-11-08', note: 'multi-year span' },
  { name: 'Silk Road Equipment',   type: 'Standard', kpi:  2, startDate: '2025-06-01', endDate: '2026-05-31', note: 'FIX#1 ends last day of May' },
  { name: 'Lifelong Learning SG',  type: 'InternalKPI', kpi: 24, startDate: '2025-12-01', endDate: '2026-04-30', note: 'FIX#1 ends last day of Apr' },
  { name: 'Asiarecs Malaysia',     type: 'Standard', kpi:  3, startDate: '2025-09-01', endDate: '2026-02-28', note: 'FIX#1 ends last day of Feb' },
  { name: 'Andrew Yap',            type: 'Standard', kpi:  5, startDate: '2026-02-16', endDate: '2027-02-15', note: 'starts mid-Feb' },
  { name: 'Sage and Fawn',         type: 'Standard', kpi:  5, startDate: '2026-03-31', endDate: '2027-03-30', note: 'starts last day of Mar' },
  { name: 'Bizlink',               type: 'Cluster',  kpi:  4, startDate: '2026-03-10', endDate: '2026-09-09', note: 'cluster, starts Mar' },
  { name: 'Sata CommHealth GEO',   type: 'Cluster',  kpi:  7, startDate: '2026-06-03', endDate: '2027-06-02', note: 'FIX#2 starts Jun 3 (current month)' },
  { name: 'Spectrum Surgery',      type: 'Standard', kpi:  8, startDate: '2024-07-01', endDate: '2024-12-31', note: 'fully past (control)' },
];

// ---- run ------------------------------------------------------------------
const today = new Date('2026-06-05T12:00:00');
const win = buildWindowMonths(today, 6);
const shortLabels = win.map(ym => {
  const [y, m] = ym.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
});
console.log(`Window (${win.length} cols): ${win.join(', ')}`);
console.log(`Labels        : ${shortLabels.join('  ')}\n`);

const coverage = c => {
  const me = computeMonthlyExpected(win, [c]);
  return me.map(m => m.expectedP1 > 0);
};
const mapStr = bools => bools.map(b => b ? '■' : '·').join('  ');

console.log('Per-campaign month coverage  (■ = coloured background, · = blank)\n');
console.log(`  ${'campaign'.padEnd(22)} ${shortLabels.map(s => s.padStart(3)).join(' ')}   timeline`);
console.log(`  ${'-'.repeat(22)} ${'-'.repeat(shortLabels.length * 4)}`);
const cov = {};
CAMPAIGNS.forEach(c => {
  const b = coverage(c);
  cov[c.name] = b;
  const cells = b.map(x => (x ? ' ■ ' : ' · ')).join(' ');
  console.log(`  ${c.name.padEnd(22)} ${cells}   ${c.startDate}→${c.endDate}`);
});

// idx helper for a YYYY-MM in the window
const ix = ym => win.indexOf(ym);

console.log('\nAssertions:\n');

console.log('  CLA Global TS — full span:');
ok(cov['CLA Global TS'].every(Boolean), 'every month Dec→Jun coloured');

console.log('  HiMetal — multi-year span:');
ok(cov['HiMetal'].every(Boolean), 'every month Dec→Jun coloured');

console.log('  Silk Road Equipment — FIX #1 (ends 2026-05-31):');
ok(cov['Silk Road Equipment'][ix('2026-05')] === true,  'May coloured (last-day end no longer dropped)');
ok(cov['Silk Road Equipment'][ix('2026-06')] === false, 'June blank (past end)');

console.log('  Lifelong Learning SG — FIX #1 (ends 2026-04-30):');
ok(cov['Lifelong Learning SG'][ix('2026-04')] === true,  'April coloured (last-day end kept)');
ok(cov['Lifelong Learning SG'][ix('2026-05')] === false, 'May blank (past end)');

console.log('  Asiarecs Malaysia — FIX #1 (ends 2026-02-28):');
ok(cov['Asiarecs Malaysia'][ix('2026-02')] === true,  'Feb coloured (last-day end kept)');
ok(cov['Asiarecs Malaysia'][ix('2026-03')] === false, 'Mar blank (past end)');

console.log('  Andrew Yap — starts 2026-02-16:');
ok(cov['Andrew Yap'][ix('2026-01')] === false, 'Jan blank (before start)');
ok(cov['Andrew Yap'][ix('2026-02')] === true,  'Feb coloured (active at month-end)');
ok(cov['Andrew Yap'][ix('2026-06')] === true,  'Jun coloured (still running)');

console.log('  Sage and Fawn — starts 2026-03-31 (last day):');
ok(cov['Sage and Fawn'][ix('2026-02')] === false, 'Feb blank (before start)');
ok(cov['Sage and Fawn'][ix('2026-03')] === true,  'Mar coloured (active by its month-end)');

console.log('  Bizlink — cluster, 2026-03-10→2026-09-09:');
ok(cov['Bizlink'][ix('2026-02')] === false, 'Feb blank (before start)');
ok(cov['Bizlink'][ix('2026-03')] === true,  'Mar coloured');
ok(cov['Bizlink'][ix('2026-06')] === true,  'Jun coloured (ends Sep, after window)');

console.log('  Sata CommHealth GEO — FIX #2 (starts 2026-06-03):');
ok(win.includes('2026-06'), 'June column EXISTS in window (fix #2 — current month visible)');
ok(cov['Sata CommHealth GEO'][ix('2026-06')] === true,  'June coloured (campaign just started)');
ok(cov['Sata CommHealth GEO'].slice(0, ix('2026-06')).every(x => x === false), 'all months before June blank');

console.log('  Spectrum Surgery — fully past (control):');
ok(cov['Spectrum Surgery'].every(x => x === false), 'no month coloured (ended Dec 2024)');

console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
