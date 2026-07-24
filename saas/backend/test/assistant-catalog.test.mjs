import { describe, it, expect } from 'vitest';
import { toolCatalog, CHAT_RULES } from '../src/lib/assistant.mjs';

// The assistant lists every catalog tool as something it may recommend, and a
// recommendation renders as a button that STARTS THE RUN. So a connector that
// isn't wired up on this deployment (Meta and LinkedIn are pending platform
// approval — the Integrations page shows them as "Coming soon") must be marked
// unavailable, or the assistant sends users to a dead end.
const lineFor = (id) => toolCatalog().split('\n').find((l) => l.startsWith(`${id} —`));

describe('toolCatalog', () => {
  it('flags connectors whose OAuth is not configured', () => {
    expect(lineFor('meta-ads')).toContain('NOT AVAILABLE YET');
    expect(lineFor('linkedin-ads')).toContain('NOT AVAILABLE YET');
  });

  it('leaves working tools unflagged', () => {
    for (const id of ['gsc', 'ga4', 'google-ads', 'keyword-analysis']) {
      expect(lineFor(id)).not.toContain('NOT AVAILABLE YET');
    }
  });

  it('tells the assistant what to do with a flagged tool', () => {
    expect(CHAT_RULES).toContain('NOT AVAILABLE YET');
  });
});
