import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { renderStrategy } = __test;

// The three strategies are alternatives to pick between, so the report leads
// with a comparison table and collapses each one — see renderStrategy. These
// tests pin that shape: stacking every keyword table open again would put the
// choice back behind a long scroll.
const STRATEGIES = [
  {
    name: 'SME Growth Trigger Capture',
    focus_area: 'Singaporean SMEs scaling post-recovery.',
    content_approach: 'Case studies and ROI calculators.',
    expected_impact: 'High',
    time_to_rank: 4,
    recommended: true,
    target_keywords: ['digital marketing for SMEs Singapore', 'B2B lead generation Singapore'],
  },
  {
    name: 'Enterprise Authority Play',
    focus_area: 'Own the head terms.',
    expected_impact: 'Medium',
    time_to_rank: '9 months',
    target_keywords: ['digital marketing agency Singapore', 'seo agency singapore'],
  },
];
const METRICS = {
  'digital marketing for smes singapore': { vol: 0, diff: 0 },
  'b2b lead generation singapore': { vol: 10, diff: 26 },
  'digital marketing agency singapore': { vol: 2400, diff: 61 },
  'seo agency singapore': { vol: 880, diff: 55 },
};
const RANKS = { 'seo agency singapore': 7, 'digital marketing agency singapore': 42 };
const EMPTY_RECS = { strengths: [], recommendations: [] };

const render = (strategies, recs = EMPTY_RECS) =>
  renderStrategy(strategies, strategies.find((s) => s.recommended) || strategies[0], recs, METRICS, RANKS);

describe('renderStrategy — strategy cards', () => {
  it('gives each strategy its own collapsible card, with only the recommended one open', () => {
    const html = render(STRATEGIES);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html.match(/<details open/g)).toHaveLength(1);
    // The open one is the recommended one.
    expect(html).toMatch(/<details open[\s\S]*?SME Growth Trigger Capture/);
    expect(html).toContain('RECOMMENDED');
  });

  it('summarises each strategy without repeating the comparison columns', () => {
    const html = render(STRATEGIES);
    const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'));
    expect(summary).toContain('Singaporean SMEs scaling post-recovery.'); // the theme, in words
    expect(summary).not.toContain('Est. time to rank'); // lives in the compare table
  });

  it('compares the strategies up front, with volume and difficulty aggregated per strategy', () => {
    const html = render(STRATEGIES);
    const table = html.slice(0, html.indexOf('<details'));
    expect(table).toContain('Time to rank');
    expect(table).toContain('Avg KD');
    expect(table).toContain('9 months');
    expect(table).toContain('4 months'); // bare number gets the unit
    expect(table).toContain('3.3k'); // 2400 + 880 across the second strategy
    expect(table).toContain('58'); // mean of KD 61 and 55
  });

  it('flags keywords already in the top 10 — the one stat the table omits', () => {
    const html = render(STRATEGIES);
    expect(html).toContain('already top 10'); // rank 7 on the second strategy
    expect(html.match(/already top 10/g)).toHaveLength(1); // rank 42 doesn't count
  });

  it('skips the comparison table when there is nothing to compare', () => {
    const html = render([STRATEGIES[0]]);
    expect(html).not.toContain('Avg KD');
    expect(html).toContain('<details open');
  });

  it('renders a strategy with no keywords rather than dropping it', () => {
    const html = render([...STRATEGIES, { name: 'Long-tail Sprint', target_keywords: [] }]);
    expect(html.match(/<details/g)).toHaveLength(3);
    expect(html).toContain('Long-tail Sprint');
    expect(html).toContain('No target keywords.');
  });
});
