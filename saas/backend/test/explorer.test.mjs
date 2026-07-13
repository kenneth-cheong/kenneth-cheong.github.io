import { describe, it, expect } from 'vitest';
import { explorerProgress, EXPLORER_TASKS, EXPLORER_REWARD } from '../../shared/catalog.mjs';

// The reward endpoint trusts explorerProgress to decide whether a milestone is
// genuinely met, so these lock down its behaviour: tier-awareness, core vs full,
// and that no partial state reads as complete.

const coreIds = EXPLORER_TASKS.filter((t) => t.group === 'core').map((t) => t.toolId).filter(Boolean);

describe('explorerProgress', () => {
  it('reports nothing complete for a fresh pro user', () => {
    const p = explorerProgress({ tier: 'pro' });
    expect(p.coreComplete).toBe(false);
    expect(p.fullComplete).toBe(false);
    expect(p.core.done).toBe(0);
    expect(p.locked.length).toBe(0); // pro can run every mapped tool
  });

  it('locks pro-only tasks for a free user (never required for a reward)', () => {
    const p = explorerProgress({ tier: 'free' });
    const availableIds = p.tasks.map((t) => t.id);
    expect(availableIds).toContain('keyword-analysis'); // free tool
    expect(availableIds).not.toContain('ai-discovery'); // pro tool → locked
    expect(p.locked.some((t) => t.id === 'ai-discovery')).toBe(true);
  });

  it('marks core complete only when every available core task is done', () => {
    const ranTools = coreIds.slice(0, -1); // one short
    let p = explorerProgress({ tier: 'pro', ranTools, hasProject: true });
    expect(p.coreComplete).toBe(false);

    p = explorerProgress({ tier: 'pro', ranTools: coreIds, hasProject: true });
    expect(p.coreComplete).toBe(true);
    expect(p.fullComplete).toBe(false); // explore group still untouched
  });

  it('honours the persisted done map for non-tool tasks', () => {
    const p = explorerProgress({ tier: 'pro', ranTools: coreIds, hasProject: false, done: { 'exp-project': true } });
    expect(p.coreComplete).toBe(true);
  });

  it('reaches full only when core AND explore are all done', () => {
    const allTools = EXPLORER_TASKS.map((t) => t.toolId).filter(Boolean);
    const p = explorerProgress({ tier: 'pro', ranTools: allTools, hasProject: true, hasGoogle: true });
    expect(p.coreComplete).toBe(true);
    expect(p.fullComplete).toBe(true);
  });

  it('exposes positive reward amounts', () => {
    expect(EXPLORER_REWARD.core).toBeGreaterThan(0);
    expect(EXPLORER_REWARD.full).toBeGreaterThan(0);
  });
});
