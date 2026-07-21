import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { __test } from '../src/metering/index.mjs';

const { sectionsOptimiser, reconcileCost, cwDeepCompareBrief, cwDeepComparePlan, cwMedianWordTarget, cwPublisher, cwEmptyView, cwFitAgents, OPTIMISER_AGENTS } = __test;

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
  it('produces stats, meta list, draft html, gap html and one agent accordion', () => {
    const s = sectionsOptimiser(view());
    const types = s.map((x) => x.type);
    expect(types[0]).toBe('stats');
    expect(types).toContain('callout');       // 1 failed agent notice
    expect(types).toContain('list');          // suggested meta
    expect(types.filter((t) => t === 'html').length).toBeGreaterThanOrEqual(2); // draft + gap
    const acc = s.find((x) => x.type === 'accordion');
    expect(acc.items).toHaveLength(3);
    const failed = acc.items.find((c) => c.title === 'Legal & Compliance');
    expect(failed.badge).toBe('failed');
    const fact = acc.items.find((c) => c.title === 'Fact Checking');
    expect(fact.badge).toBe('8/10');
    expect(fact.lines[0].value).toContain('→ Soften the claim');
  });

  it('carries a structure-group deliverable inside its accordion row, not a top-level section', () => {
    const s = sectionsOptimiser(view());
    const faq = s.find((x) => x.type === 'accordion').items.find((c) => c.title === 'FAQs');
    expect(faq).toBeTruthy();
    expect(faq.html).toContain('FAQs');
  });

  it('surfaces competitor research: a stat, the briefed topics, and no skip callout', () => {
    const s = sectionsOptimiser(view({
      wordTarget: 1400,
      research: {
        topics: ['Pricing tiers', 'Integrations'],
        competitors: [{ url: 'https://a.com', words: 1350, topicCount: 8 }, { url: 'https://b.com', words: 1450, topicCount: 6 }],
        skipped: '',
      },
    }));
    expect(s[0].items.find((i) => i.label === 'Competitors read').value).toBe(2);
    const topics = s.filter((x) => x.type === 'list').find((x) => /Topics your competitors cover/.test(x.title));
    expect(topics.items).toEqual(['Pricing tiers', 'Integrations']);
    expect(topics.note).toContain('target used 1,400');
    expect(s.filter((x) => x.type === 'callout').some((c) => /without competitor research/.test(c.text))).toBe(false);
  });

  it('says so plainly when the draft went out unbriefed', () => {
    const s = sectionsOptimiser(view({
      research: { topics: [], competitors: [], skipped: 'we had no target keyword to search for' },
    }));
    const note = s.filter((x) => x.type === 'callout').find((c) => /without competitor research/.test(c.text));
    expect(note.text).toContain('no target keyword');
    expect(s[0].items.find((i) => i.label === 'Competitors read')).toBeUndefined();
  });

  it('tolerates a run with no research field at all (old history rows)', () => {
    const s = sectionsOptimiser(view());
    expect(s[0].items.find((i) => i.label === 'Competitors read')).toBeUndefined();
    expect(s.filter((x) => x.type === 'callout').some((c) => /without competitor research/.test(c.text))).toBe(false);
  });

  it('lists the Deep Compare priority actions when the head-to-head ran', () => {
    const s = sectionsOptimiser(view({
      deep: {
        brief: 'PRIORITY ACTIONS…',
        plan: [
          { priority: 1, action: 'Add original pricing data', expected_outcome: 'Wins the comparison intent', effort: 'Medium' },
          { priority: 2, action: 'Add author credentials' },
        ],
        skipped: '',
      },
    }));
    const plan = s.filter((x) => x.type === 'list').find((x) => /Fix these first/.test(x.title));
    expect(plan.items[0]).toBe('[1] Add original pricing data → Wins the comparison intent (Medium effort)');
    expect(plan.items[1]).toBe('[2] Add author credentials'); // absent fields must not leave stray arrows
  });

  it('says so when Deep Compare was skipped, but stays silent when not applicable', () => {
    const skippedNote = (v) => sectionsOptimiser(v).filter((x) => x.type === 'callout')
      .find((c) => /head-to-head/.test(c.text));
    // Ran out of time → the user is told.
    expect(skippedNote(view({ deep: { brief: '', plan: [], skipped: 'there wasn’t enough time left' } })).text)
      .toContain('enough time left');
    // Write mode / pasted text → not applicable, so no scary note.
    expect(skippedNote(view({ deep: { brief: '', plan: [], skipped: '' } }))).toBeUndefined();
    expect(skippedNote(view())).toBeUndefined(); // old history rows
  });

  it('omits draft/meta/gap sections when absent', () => {
    const s = sectionsOptimiser(view({ draftHtml: '', meta: null, gapSummary: '', results: [] }));
    expect(s.find((x) => x.type === 'html')).toBeUndefined();
    expect(s.find((x) => x.type === 'list')).toBeUndefined();
    expect(s[0].type).toBe('stats');
  });
});

// The live-progress view renders through sectionsOptimiser too, so a run that is
// only PART done has to look pending, not broken.
describe('sectionsOptimiser on a half-finished run (live progress)', () => {
  const research = { topics: ['Pricing tiers'], competitors: [{ url: 'https://a.com', words: 1400, topicCount: 8 }], skipped: '' };

  it('shows the research it has and omits every not-yet-known stat', () => {
    const s = sectionsOptimiser(cwEmptyView(false, research, { brief: '', plan: [], skipped: '' }));
    const labels = s[0].items.map((i) => i.label);
    expect(labels).toEqual(['Competitors read']);        // no "Words 0", no "Readability 0", no "Checks run 0"
    expect(s.find((x) => x.type === 'accordion')).toBeUndefined(); // no empty "Quality checks — 0 agents"
    expect(s.find((x) => x.type === 'html')).toBeUndefined();      // no draft yet
    expect(s.some((x) => /Topics your competitors cover/.test(x.title || ''))).toBe(true);
  });

  it('grows into the finished shape as fields arrive', () => {
    const v = { ...cwEmptyView(false, research, { brief: '', plan: [], skipped: '' }), wordCount: 900, flesch: 61, draftHtml: '<p>x</p>' };
    const mid = sectionsOptimiser(v);
    expect(mid[0].items.map((i) => i.label)).toEqual(['Words', 'Readability', 'Competitors read']);
    expect(mid.find((x) => x.type === 'accordion')).toBeUndefined();
    v.results = [{ a: agent('factCheck', 'Fact Checking', 'verify'), parsed: { score: 8, findings: [] } }];
    const done = sectionsOptimiser(v);
    expect(done[0].items.map((i) => i.label)).toContain('Checks run');
    expect(done.find((x) => x.type === 'accordion').items).toHaveLength(1);
  });
});

describe('cwPublisher', () => {
  const view = () => cwEmptyView(false, { topics: [], competitors: [], skipped: '' }, { brief: '', plan: [], skipped: '' });

  it('is a no-op without a job id, or when several models are racing one job', () => {
    expect(cwPublisher(null)(view())).toBeUndefined();
    expect(cwPublisher('cw_1', false)(view())).toBeUndefined();
  });

  it('throttles bursts but always honours force', async () => {
    // No cache configured under test, so cwStage's write no-ops — what we're
    // asserting is the gating, i.e. that a burst does not fan out into writes.
    const pub = cwPublisher('cw_test_job');
    const first = pub(view(), { force: true });
    expect(first).toBeInstanceOf(Promise);
    await first;
    const burst = [pub(view()), pub(view()), pub(view())];
    await Promise.all(burst);
    // All three collapse onto the same in-flight promise rather than 3 writes.
    expect(new Set(burst).size).toBe(1);
    expect(pub(view(), { force: true })).toBeInstanceOf(Promise); // force bypasses the gap
  });
});

// A measured run with research + Deep Compare hit 669s of an 880s budget at the
// DEFAULT 8-agent depth; an unguarded 18-agent Full audit would be killed at the
// deadline and lose the draft with it.
describe('cwFitAgents', () => {
  const full = OPTIMISER_AGENTS;               // 18
  const verify = full.filter((a) => a.group === 'verify'); // 8

  it('never trims when there is no clock, or when time is ample', () => {
    expect(cwFitAgents(full).trimmed).toBe(0);              // no Lambda context
    expect(cwFitAgents(full, 900_000).trimmed).toBe(0);     // 3 waves fit in 900s
  });

  it('drops the Full audit to what the clock allows', () => {
    const { agents, trimmed } = cwFitAgents(full, 250_000); // one wave only
    expect(agents).toHaveLength(8);
    expect(trimmed).toBe(10);
  });

  it('keeps verify agents — accuracy and compliance survive, enrichment goes', () => {
    const { agents } = cwFitAgents(full, 250_000);
    expect(agents.every((a) => a.group === 'verify')).toBe(true);
    expect(agents.map((a) => a.key)).toEqual(expect.arrayContaining(['factCheck', 'legal']));
  });

  it('never trims below one wave, however little time is left', () => {
    const { agents, trimmed } = cwFitAgents(full, 1000);
    expect(agents).toHaveLength(8);
    expect(trimmed).toBe(10);
  });

  it('leaves a run that already fits alone', () => {
    expect(cwFitAgents(verify, 250_000)).toEqual({ agents: verify, trimmed: 0 });
  });
});

describe('sectionsOptimiser trim notice', () => {
  it('says out loud when checks were dropped to beat the clock', () => {
    const s = sectionsOptimiser({ ...cwEmptyView(false, { topics: [], competitors: [], skipped: '' }, { brief: '', plan: [], skipped: '' }), agentsTrimmed: 10 });
    const note = s.filter((x) => x.type === 'callout').find((c) => /skipped 10/.test(c.text));
    expect(note).toBeTruthy();
  });
  it('stays quiet when nothing was trimmed', () => {
    const s = sectionsOptimiser(cwEmptyView(false, { topics: [], competitors: [], skipped: '' }, { brief: '', plan: [], skipped: '' }));
    expect(s.filter((x) => x.type === 'callout').some((c) => /skipped/.test(c.text))).toBe(false);
  });
});

describe('cwMedianWordTarget', () => {
  it('takes the median, not the mean, so one outlier pillar page cannot skew it', () => {
    // mean would be 2,720 — the 8,000-word outlier dragging every draft up.
    expect(cwMedianWordTarget([900, 1200, 1400, 2100, 8000])).toBe(1400);
  });
  it('rounds to the nearest 50 and ignores zero-word reads', () => {
    expect(cwMedianWordTarget([0, 0, 1372])).toBe(1350);
    expect(cwMedianWordTarget([])).toBe(0);
    expect(cwMedianWordTarget([0, 0])).toBe(0);
  });
});

describe('cwDeepCompareBrief', () => {
  const data = {
    eeat_trust_signals: [{ issue: 'No named author', competitor_approach: 'Bylines with PMP certs', target_gap: 'author bio', fix: 'Add a credentialed byline' }],
    topical_authority: [],
    audience_targeting: [{ issue: 'Generic audience' }],
  };

  it('flattens the populated issue tables, skipping empty ones', () => {
    const b = cwDeepCompareBrief(data);
    expect(b).toContain('E-E-A-T & TRUST SIGNALS:');
    expect(b).toContain('- No named author — we lack: author bio — fix: Add a credentialed byline');
    expect(b).toContain('competitors: Bylines with PMP certs'); // what to emulate, not just our gaps
    expect(b).not.toContain('TOPICAL AUTHORITY'); // empty table omitted, not left as a bare heading
    expect(b).toContain('- Generic audience');   // partial rows survive without stray separators
  });

  it('is bounded so a huge comparison cannot crowd the draft out of the prompt', () => {
    const huge = { eeat_trust_signals: Array.from({ length: 500 }, (_, i) => ({ issue: `Issue ${i}`, fix: 'x'.repeat(200) })) };
    expect(cwDeepCompareBrief(huge).length).toBeLessThanOrEqual(12000);
  });

  it('returns empty for junk rather than throwing', () => {
    expect(cwDeepCompareBrief(null)).toBe('');
    expect(cwDeepCompareBrief({})).toBe('');
    expect(cwDeepCompareBrief({ priority_action_plan: 'not an array' })).toBe('');
  });
});

describe('cwDeepComparePlan', () => {
  it('uses the Lambda-supplied plan when there is one', () => {
    const p = cwDeepComparePlan({ priority_action_plan: [{ priority: 1, action: 'Add pricing data', effort: 'Medium' }] });
    expect(p).toHaveLength(1);
    expect(p[0].action).toBe('Add pricing data');
    expect(p[0].dimension).toBeUndefined();
  });

  // A real deepContentCompare run returned all five tables and NO plan, which
  // would have left the "Fix these first" section permanently empty.
  it('derives one when priority_action_plan is missing, breadth-first across dimensions', () => {
    const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({ issue: `${tag} issue ${i}`, fix: `${tag} fix ${i}` }));
    const p = cwDeepComparePlan({
      eeat_trust_signals: mk(4, 'eeat'),
      topical_authority: mk(4, 'topical'),
      competitive_differentiation: mk(4, 'diff'),
      technical_schema_seo: mk(4, 'tech'),
      audience_targeting: mk(4, 'aud'),
    });
    expect(p).toHaveLength(8);
    // First five are row 0 of each dimension — no single table monopolises the top.
    expect(p.slice(0, 5).map((x) => x.action)).toEqual(['eeat fix 0', 'topical fix 0', 'diff fix 0', 'tech fix 0', 'aud fix 0']);
    expect(p[5].action).toBe('eeat fix 1'); // only then does it go deeper
    expect(p[0].dimension).toBe('E-E-A-T & trust signals');
    expect(p[0].priority).toBe(1);
    // The issue must NOT be presented as the outcome of the fix.
    expect(p[0].expected_outcome).toBe('');
  });

  it('skips blank rows and copes with junk', () => {
    expect(cwDeepComparePlan({ eeat_trust_signals: [{}, { fix: 'real' }] })).toHaveLength(1);
    expect(cwDeepComparePlan(null)).toEqual([]);
    expect(cwDeepComparePlan({ eeat_trust_signals: 'nope' })).toEqual([]);
  });
});

// A REAL deepContentCompare response, recorded 2026-07-21 (projectmanager.com vs
// 3 competitors, "project management software"). Fixtures above are written from
// what the renderer in index.html implies the payload looks like; this is what
// the Lambda actually sent — and it differed, in a way that silently emptied the
// "Fix these first" section. Point DC_FIXTURE at a saved response to re-arm it.
const DC_FIXTURE = process.env.DC_FIXTURE
  || new URL('./fixtures/deep-compare-live.json', import.meta.url).pathname;
const dcLive = existsSync(DC_FIXTURE)
  ? (() => { const r = JSON.parse(readFileSync(DC_FIXTURE, 'utf8')); return typeof r.body === 'string' ? JSON.parse(r.body) : (r.body || r); })()
  : null;

describe.skipIf(!dcLive)('Deep Compare against a recorded LIVE payload', () => {
  it('produces a non-empty, bounded brief that includes what competitors do', () => {
    const b = cwDeepCompareBrief(dcLive);
    expect(b.trim().length).toBeGreaterThan(200);
    expect(b.length).toBeLessThanOrEqual(12000);
    expect(b).toContain('competitors:'); // competitor_approach must survive into the prompt
    expect(b).toContain('E-E-A-T & TRUST SIGNALS:');
  });

  it('still yields a priority list even though the live payload has no priority_action_plan', () => {
    expect(Array.isArray(dcLive.priority_action_plan)).toBe(false); // the trap this test exists for
    const plan = cwDeepComparePlan(dcLive);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((p) => String(p.action || '').trim())).toBe(true);
    // Breadth: the top of the list must not be one dimension repeated.
    expect(new Set(plan.map((p) => p.dimension)).size).toBeGreaterThan(1);
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
