/**
 * Test harness for the SEO Campaign Trajectory Tracker "Keyword Basket Distribution"
 * column-background coloring (the green/yellow/red shaded regions).
 *
 * It faithfully replicates the production logic from index.html:
 *   - windowMonths build              (index.html ~25027-25030)
 *   - monthlyExpected (per-month KPI) (index.html ~25732-25745)
 *   - kpiMonthPlugin colour decision  (index.html ~25760-25773)
 *
 * Goal: explain/verify why April & May render with NO background colour.
 *
 * Run:  node scratch/test_trajectory_bg.js
 */

// ---------------------------------------------------------------------------
// 1. EXACT COPIES of the production functions
// ---------------------------------------------------------------------------

// index.html ~24884-24886 + 25027-25033  (FIXED: local YYYY-MM, no toISOString TZ shift)
function buildWindowMonths(today, monthsBack) {
  const dateTo   = new Date(today.getTime());
  const dateFrom = new Date(new Date(today.getTime()).setMonth(today.getMonth() - monthsBack));
  const windowMonths = [];
  const cur  = new Date(dateFrom.getFullYear(), dateFrom.getMonth(), 1);
  const stop = new Date(dateTo.getFullYear(),   dateTo.getMonth(),   1);
  const ymLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  while (cur <= stop) { windowMonths.push(ymLocal(cur)); cur.setMonth(cur.getMonth() + 1); }
  return windowMonths;
}

// index.html ~25732-25749  (FIXED: end date treated as end-of-day, matching monthEnd)
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

// index.html ~25762-25772  (returns the colour bucket; 'none' === no fillRect)
function colourFor({ expectedP1, totalKPI }, actualP1, tol = 0.20) {
  if (expectedP1 === 0) return 'none';            // line 25762: early return, no colour
  const lowerBound = expectedP1 - tol * totalKPI;
  if (actualP1 >= totalKPI)        return 'green';
  else if (actualP1 >= lowerBound) return 'yellow';
  else                             return 'red';
}

// Convenience: full pipeline for one scenario
function colourRow(months, campaigns, actualP1ByMonth, tol = 0.20) {
  const me = computeMonthlyExpected(months, campaigns);
  return months.map((ym, i) => ({
    ym,
    expectedP1: +me[i].expectedP1.toFixed(2),
    totalKPI:   me[i].totalKPI,
    actualP1:   actualP1ByMonth[ym] || 0,
    colour:     colourFor(me[i], actualP1ByMonth[ym] || 0, tol),
  }));
}

// ---------------------------------------------------------------------------
// 2. Tiny assert helper
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}\n      expected: ${e}\n      actual:   ${a}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ---------------------------------------------------------------------------
// 3. Reproduce the screenshot scenario
//    today = 2026-06-05, 6-month window, one campaign Nov 2025 -> Mar 2026
// ---------------------------------------------------------------------------
section('A. Window months (today=2026-06-05, 6 mo)');
const today = new Date('2026-06-05T12:00:00');
const win = buildWindowMonths(today, 6);
console.log('  windowMonths =', win.join(', '));
// FIXED: with local YYYY-MM keys the axis is the intended Dec 2025 -> Jun 2026, so the
// CURRENT month (June) is now included and the "Today" marker is on-screen.
// (Pre-fix this was Nov 2025 -> May 2026 — shifted one month early, hiding June.)
eq(win, ['2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06'],
   'window axis = Dec 2025 -> Jun 2026 (current month now visible)');

section('B. Campaign Nov 2025 -> Mar 2026, active THROUGH end of March');
// To keep March active at its 23:59:59 month-end the endDate must reach end-of-day March 31.
// (A bare "2026-03-31" parses to 00:00 and would EXCLUDE March -- see scenario D.)
const campMar = [{ name: 'Dr Gerard Leong', kpi: 6, startDate: '2025-11-01', endDate: '2026-03-31T23:59:59' }];
// Actual P1 keywords below trajectory every month (matches the red region in the screenshot)
const actualsLow = { '2025-11': 0, '2025-12': 1, '2026-01': 1, '2026-02': 1, '2026-03': 2 };
const rowB = colourRow(win, campMar, actualsLow);
console.table(rowB);
eq(rowB.find(r => r.ym === '2026-03').colour !== 'none', true, 'March  -> coloured (campaign active at month-end)');
eq(rowB.find(r => r.ym === '2026-04').colour, 'none', 'April  -> NO colour (campaign already ended)');
eq(rowB.find(r => r.ym === '2026-05').colour, 'none', 'May    -> NO colour (campaign already ended)');

section('C. Threshold buckets within an active month');
// Active campaign, March, expectedP1 ~= full kpi (6) since end==month-end
const me = computeMonthlyExpected(['2026-03'], campMar)[0];
console.log('  March expectedP1 =', me.expectedP1.toFixed(2), ' totalKPI =', me.totalKPI);
eq(colourFor(me, 6), 'green',  'actual >= totalKPI            -> green');
eq(colourFor(me, 5), 'yellow', 'actual within -20% band       -> yellow'); // lower = 6 - 0.2*6 = 4.8
eq(colourFor(me, 4), 'red',    'actual below -20% band        -> red');

// ---------------------------------------------------------------------------
// 3b. BOUNDARY BUG: a bare end-of-month date (00:00) still drops its own month
// ---------------------------------------------------------------------------
section('D0. FIXED: endDate "2026-03-31" now includes March');
// Pre-fix, monthEnd(23:59:59) > end(00:00) dropped March. With end-of-day parsing they
// match, so a campaign ending on the last day of the month keeps that final month.
const campBareEnd = [{ name: 'X', kpi: 6, startDate: '2025-11-01', endDate: '2026-03-31' }];
const meBare = computeMonthlyExpected(['2026-03'], campBareEnd)[0];
eq(colourFor(meBare, 3) !== 'none', true,
   'campaign ending "2026-03-31" now COLOURS March (end-of-day boundary)');

// ---------------------------------------------------------------------------
// 4. EDGE CASE: campaign that ends MID-month -> its final month is dropped
// ---------------------------------------------------------------------------
section('D. EDGE: campaign ends mid-March (2026-03-15)');
const campMidMar = [{ name: 'X', kpi: 6, startDate: '2025-11-01', endDate: '2026-03-15' }];
const rowD = colourRow(['2026-02','2026-03','2026-04'], campMidMar, { '2026-02': 1, '2026-03': 1 });
console.table(rowD);
// monthEnd(Mar 31) > end(Mar 15)  -> March excluded from trajectory AND colour
eq(rowD.find(r => r.ym === '2026-03').colour, 'none',
   'March uncoloured even though campaign ran 15 days into it (monthEnd > end)');
eq(rowD.find(r => r.ym === '2026-02').colour !== 'none', true,
   'February still coloured (campaign active at its month-end)');

// ---------------------------------------------------------------------------
// 5. Pre-campaign months are also uncoloured (sanity for the left side)
// ---------------------------------------------------------------------------
section('E. Months before campaign start');
const rowE = colourRow(['2025-09','2025-10','2025-11'], campMar, {});
eq(rowE.find(r => r.ym === '2025-09').colour, 'none', 'Sep before start -> none');
eq(rowE.find(r => r.ym === '2025-10').colour, 'none', 'Oct before start -> none');

// ---------------------------------------------------------------------------
// 6. What WOULD make Apr/May colour: an ongoing campaign ending later
// ---------------------------------------------------------------------------
section('F. Counter-test: campaign ending May 2026 colours Apr & May');
const campMay = [{ name: 'X', kpi: 6, startDate: '2025-11-01', endDate: '2026-05-31T23:59:59' }];
const rowF = colourRow(win, campMay, {});
console.table(rowF);
eq(rowF.find(r => r.ym === '2026-04').colour !== 'none', true, 'April coloured when campaign runs through May');
eq(rowF.find(r => r.ym === '2026-05').colour !== 'none', true, 'May coloured when campaign runs through May');

// ---------------------------------------------------------------------------
// 7. REAL DATA: Dr Gerard Leong's actual Monday.com campaigns (board 2845615047)
//    Pulled live 2026-06-05. The SG renewal (kpi=7) is what drives the trajectory.
// ---------------------------------------------------------------------------
section('G. REAL DATA — Dr Gerard Leong SEO campaigns');
const realCampaigns = [
  // SG renewal — THIS drives the chart (kpi 7 matches the "7" pill in the screenshot)
  { name: 'SEO Singapore Renewal', kpi: 7, startDate: '2025-04-04', endDate: '2026-04-03' },
  // Indonesia renewal — different SE Ranking site, ended Dec 2025
  { name: 'SEO Indonesia Renewal', kpi: 5, startDate: '2024-12-20', endDate: '2025-12-19' },
  // 2023 SG campaign — ended Apr 2025, entirely before the window
  { name: 'SEO SG 2023',           kpi: 7, startDate: '2024-04-04', endDate: '2025-04-03' },
];
// Just the SG renewal (what the visible SG scatter matches against)
const rowG = colourRow(win, [realCampaigns[0]], {});
console.table(rowG);
eq(rowG.find(r => r.ym === '2026-03').colour !== 'none', true,
   'March 2026 coloured — SG renewal active at its month-end');
eq(rowG.find(r => r.ym === '2026-04').colour, 'none',
   'April 2026 BLANK — campaign ends Apr 3, gone by Apr-30 month-end (matches screenshot)');
eq(rowG.find(r => r.ym === '2026-05').colour, 'none',
   'May 2026 BLANK — fully past the Apr 3 end date (matches screenshot)');
console.log('  March expectedP1 =', rowG.find(r => r.ym === '2026-03').expectedP1, '(≈ full KPI 7 → the "7" pill)');

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(40)}\nRESULT: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
