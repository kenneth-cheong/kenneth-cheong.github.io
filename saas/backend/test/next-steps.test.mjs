import { describe, it, expect } from 'vitest';
import { NEXT_STEPS, nextStepsFor, TOOLS, toolById, tierMeets } from '../../shared/catalog.mjs';

// The journey map is hand-authored prose keyed on tool ids, which is exactly the
// shape that rots silently: rename or drop a tool and the follow-up becomes a
// button to nowhere with no error anywhere. These lock the referential integrity
// down so a catalog edit that breaks a pairing fails here instead of in the UI.

const REAL_IDS = new Set(TOOLS.map((t) => t.id));
// The one key that is deliberately NOT a catalog tool: the /audit page's
// one-click Site Health Check, which is a composite of AUDIT_TOOLS.
const NON_TOOL_KEYS = new Set(['site-audit']);

describe('NEXT_STEPS integrity', () => {
  it('is keyed on real tools (or a known non-tool surface)', () => {
    for (const key of Object.keys(NEXT_STEPS)) {
      expect(REAL_IDS.has(key) || NON_TOOL_KEYS.has(key), `unknown NEXT_STEPS key: ${key}`).toBe(true);
    }
  });

  it('only ever points at real tools', () => {
    for (const [key, steps] of Object.entries(NEXT_STEPS)) {
      for (const s of steps) {
        expect(REAL_IDS.has(s.id), `${key} → unknown tool "${s.id}"`).toBe(true);
      }
    }
  });

  it('never suggests the tool you are already in, and never repeats one', () => {
    for (const [key, steps] of Object.entries(NEXT_STEPS)) {
      const ids = steps.map((s) => s.id);
      expect(ids, `${key} suggests itself`).not.toContain(key);
      expect(new Set(ids).size, `${key} has duplicate suggestions`).toBe(ids.length);
    }
  });

  it('gives every suggestion a reason to click', () => {
    for (const [key, steps] of Object.entries(NEXT_STEPS)) {
      expect(steps.length, `${key} has no follow-ups`).toBeGreaterThan(0);
      for (const s of steps) {
        // The payoff line IS the feature — a bare tool name is the dead end we
        // are removing. Long enough to say something, short enough to scan.
        expect(typeof s.why).toBe('string');
        expect(s.why.length, `${key} → ${s.id}: why is too short`).toBeGreaterThan(20);
        expect(s.why.length, `${key} → ${s.id}: why is too long`).toBeLessThan(90);
      }
    }
  });

  it('covers every runnable tool — no result is a dead end', () => {
    // Schema Generator is an interactive builder with no data run behind it, but
    // it still hands off; if a tool is genuinely terminal, add it here on purpose.
    const missing = TOOLS.filter((t) => !NEXT_STEPS[t.id]).map((t) => t.id);
    expect(missing).toEqual([]);
  });
});

describe('nextStepsFor', () => {
  it('resolves to tools with a why and a lock flag', () => {
    const steps = nextStepsFor('keyword-analysis', { tier: 'pro' });
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s.tool).toBeTruthy();
      expect(toolById(s.tool.id)).toBeTruthy();
      expect(typeof s.why).toBe('string');
      expect(s.locked).toBe(false);      // pro unlocks everything suggested here
    }
  });

  it('marks locked follow-ups honestly against the tier', () => {
    const steps = nextStepsFor('competitors', { tier: 'free' });
    for (const s of steps) {
      expect(s.locked).toBe(!tierMeets('free', s.tool.minTier));
    }
  });

  it('keeps at most ONE locked suggestion, so a free user still sees a way forward', () => {
    for (const key of Object.keys(NEXT_STEPS)) {
      for (const tier of ['free', 'starter', 'pro', 'expert']) {
        const locked = nextStepsFor(key, { tier }).filter((s) => s.locked);
        expect(locked.length, `${key} @ ${tier} showed ${locked.length} locked`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('puts unlocked suggestions first', () => {
    for (const key of Object.keys(NEXT_STEPS)) {
      const steps = nextStepsFor(key, { tier: 'starter' });
      const firstLocked = steps.findIndex((s) => s.locked);
      if (firstLocked !== -1) {
        expect(steps.slice(firstLocked).every((s) => s.locked)).toBe(true);
      }
    }
  });

  it('honours exclude and limit', () => {
    const all = nextStepsFor('technical-seo', { tier: 'expert' });
    const dropped = nextStepsFor('technical-seo', { tier: 'expert', exclude: [all[0].tool.id] });
    expect(dropped.map((s) => s.tool.id)).not.toContain(all[0].tool.id);
    expect(nextStepsFor('technical-seo', { tier: 'expert', limit: 1 })).toHaveLength(1);
  });

  it('returns nothing for an unmapped id rather than throwing', () => {
    expect(nextStepsFor('does-not-exist', { tier: 'pro' })).toEqual([]);
  });
});
