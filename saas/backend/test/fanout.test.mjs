import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { mapLimit, firstCalloutText, FANOUT_CONCURRENCY } = __test;

describe('mapLimit (fan-out concurrency cap)', () => {
  it('never runs more than `limit` at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([...Array(20).keys()], 5, async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBe(5);
  });

  it('preserves input order regardless of completion order', async () => {
    // Item 0 is the slowest, so completion order is the reverse of input order.
    const out = await mapLimit([30, 20, 10, 0], 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('handles an empty list without hanging', async () => {
    expect(await mapLimit([], 5, async () => 1)).toEqual([]);
  });

  it('caps workers at the item count, not the limit', async () => {
    let started = 0;
    await mapLimit([1, 2], 10, async () => { started++; });
    expect(started).toBe(2);
  });

  it('ships a sane default concurrency', () => {
    expect(FANOUT_CONCURRENCY).toBeGreaterThan(0);
    expect(FANOUT_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});

describe('firstCalloutText', () => {
  it('digs the reason out of a callout-shaped soft failure', () => {
    const r = { sections: [{ type: 'callout', text: 'Could not fetch x.com' }] };
    expect(firstCalloutText(r)).toBe('Could not fetch x.com');
  });
  it('skips sections with no text', () => {
    const r = { sections: [{ type: 'table', rows: [] }, { type: 'callout', text: 'why' }] };
    expect(firstCalloutText(r)).toBe('why');
  });
  it('returns empty string when there is nothing to report', () => {
    expect(firstCalloutText({})).toBe('');
    expect(firstCalloutText({ sections: [] })).toBe('');
    expect(firstCalloutText(null)).toBe('');
  });
});
