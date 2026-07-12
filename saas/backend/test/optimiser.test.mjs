import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { sectionsOptimiser, reconcileCost } = __test;

const agent = (key, label, group) => ({ key, label, group });

function view(overrides = {}) {
  return {
    writing: false,
    draftHtml: '<h2>Improved</h2><p>Better copy.</p>',
    wordCount: 420,
    flesch: 62,
    meta: { title: 'A great title', desc: 'A useful description.' },
    gapSummary: 'Add a pricing section.\nCover integrations.',
    linkCount: 3,
    results: [
      { a: agent('factCheck', 'Fact Checking', 'verify'), parsed: { score: 8, summary: 'Mostly accurate', findings: [{ severity: 'high', issue: 'Unverifiable superlative', fix: 'Soften the claim' }] } },
      { a: agent('legal', 'Legal & Compliance', 'verify'), parsed: { error: 'upstream 502' } },
      { a: agent('faqs', 'FAQs', 'structure'), parsed: { score: null, summary: 'FAQs written', findings: [], content: '## FAQs\n\n**Q:** What is it?\n\nA long enough deliverable body to pass the eighty character minimum for a section.' } },
    ],
    usage: { in: 1000, out: 2000, calls: 3 },
    ...overrides,
  };
}

describe('sectionsOptimiser', () => {
  it('produces stats, meta list, draft html, gap html and agent cards', () => {
    const s = sectionsOptimiser(view());
    const types = s.map((x) => x.type);
    expect(types[0]).toBe('stats');
    expect(types).toContain('callout');       // 1 failed agent notice
    expect(types).toContain('list');          // suggested meta
    expect(types.filter((t) => t === 'html').length).toBeGreaterThanOrEqual(2); // draft + gap (+ FAQ deliverable)
    const cards = s.find((x) => x.type === 'cards');
    expect(cards.items).toHaveLength(3);
    const failed = cards.items.find((c) => c.title === 'Legal & Compliance');
    expect(failed.badge).toBe('failed');
    const fact = cards.items.find((c) => c.title === 'Fact Checking');
    expect(fact.badge).toBe('8/10');
    expect(fact.lines[0].value).toContain('→ Soften the claim');
  });

  it('renders structure-group deliverable content as its own html section', () => {
    const s = sectionsOptimiser(view());
    const faq = s.filter((x) => x.type === 'html').find((x) => x.title === 'FAQs');
    expect(faq).toBeTruthy();
    expect(faq.html).toContain('FAQs');
  });

  it('omits draft/meta/gap sections when absent', () => {
    const s = sectionsOptimiser(view({ draftHtml: '', meta: null, gapSummary: '', results: [] }));
    expect(s.find((x) => x.type === 'html')).toBeUndefined();
    expect(s.find((x) => x.type === 'list')).toBeUndefined();
    expect(s[0].type).toBe('stats');
  });
});

describe('reconcileCost (content-writer rate)', () => {
  const cw = { id: 'content-writer', cost: 'ai_long' };
  const caption = { id: 'caption', cost: 'ai_short' };

  it('keeps the flat floor for a normal run', () => {
    // ~45k tokens at 10k/credit → 5 ≤ flat 5 → charge 5.
    expect(reconcileCost(cw, { usage: { input_tokens: 30000, output_tokens: 15000 } }, 5)).toBe(5);
  });

  it('scales a Full-audit-sized run above the floor, gently', () => {
    // 120k tokens → 12 credits, not the 120 the generic 1k rate would give.
    expect(reconcileCost(cw, { usage: { input_tokens: 90000, output_tokens: 30000 } }, 5)).toBe(12);
  });

  it('leaves other AI tools on the generic 1k-token rate', () => {
    expect(reconcileCost(caption, { usage: { input_tokens: 1500, output_tokens: 1500 } }, 1)).toBe(3);
  });

  it('falls back to flat cost when no usage is attached', () => {
    expect(reconcileCost(cw, { html: 'x' }, 5)).toBe(5);
  });
});
