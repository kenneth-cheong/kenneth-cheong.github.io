import { describe, it, expect } from 'vitest';
import { sourceOf } from '../src/lib/http.mjs';
import { estCostUsd, VENDOR_COST_USD, CREDIT_COSTS } from '../../shared/catalog.mjs';

// Per-product attribution: every run is labelled with the front-end surface that
// drove it (saas | index) so the shared backend can split runs + vendor spend.

describe('sourceOf', () => {
  it('reads a valid X-Source header (case-insensitive header key)', () => {
    expect(sourceOf({ headers: { 'x-source': 'saas' } })).toBe('saas');
    expect(sourceOf({ headers: { 'X-Source': 'index' } })).toBe('index');
  });

  it('normalises case + surrounding whitespace', () => {
    expect(sourceOf({ headers: { 'x-source': '  INDEX ' } })).toBe('index');
  });

  it('defaults to saas when the header is missing', () => {
    expect(sourceOf({ headers: {} })).toBe('saas');
    expect(sourceOf({})).toBe('saas');
    expect(sourceOf(undefined)).toBe('saas');
  });

  it('honours an explicit fallback for handlers that default to index', () => {
    expect(sourceOf({ headers: {} }, 'index')).toBe('index');
  });

  it('rejects an unknown/spoofed value back to the fallback (never trusted)', () => {
    expect(sourceOf({ headers: { 'x-source': 'evil' } })).toBe('saas');
    expect(sourceOf({ headers: { 'x-source': 'admin' } }, 'index')).toBe('index');
  });
});

describe('estCostUsd', () => {
  it('returns the per-class vendor estimate', () => {
    expect(estCostUsd('forensic_audit')).toBe(VENDOR_COST_USD.forensic_audit);
    expect(estCostUsd('ai_short')).toBeGreaterThan(0);
  });

  it('returns 0 for an unknown or zero-cost class', () => {
    expect(estCostUsd('nope')).toBe(0);
    expect(estCostUsd('integration_pull')).toBe(0); // user's own OAuth quota
    expect(estCostUsd(undefined)).toBe(0);
  });

  it('covers every billable CREDIT_COSTS class (no silent 0-cost gap)', () => {
    for (const [cls, credits] of Object.entries(CREDIT_COSTS)) {
      if (credits === 0) continue; // free classes legitimately cost us nothing
      expect(VENDOR_COST_USD, `missing vendor cost for ${cls}`).toHaveProperty(cls);
    }
  });
});
