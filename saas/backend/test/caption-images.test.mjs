import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { captionImages, publicInputs } = __test;
const png = (n = 8) => `data:image/png;base64,${'A'.repeat(n)}`;

describe('caption reference images', () => {
  it('unwraps the frontend {dataUrl} shape and accepts bare strings', () => {
    expect(captionImages({ _images: [{ name: 'a.png', dataUrl: png() }] })).toEqual([png()]);
    expect(captionImages({ _images: [png()] })).toEqual([png()]);
  });

  it('is absent-safe — no images means no `images` key for the upstream', () => {
    expect(captionImages({})).toEqual([]);
    expect(captionImages({ _images: null })).toEqual([]);
    expect(captionImages({ _images: 'not-an-array' })).toEqual([]);
  });

  it('drops anything that is not an inline image data URL', () => {
    // A remote URL would make the upstream fetch on our behalf; a PDF or a bare
    // base64 blob would reach the vision model as an unreadable image block.
    const out = captionImages({
      _images: [
        'https://example.com/real.png',
        'data:application/pdf;base64,AAAA',
        'AAAA',
        { dataUrl: png() },
      ],
    });
    expect(out).toEqual([png()]);
  });

  it('caps at 3 — each image is re-sent on every variation', () => {
    const many = Array.from({ length: 6 }, (_, i) => png(i + 4));
    expect(captionImages({ _images: many })).toHaveLength(3);
  });

  // The reason the field is `_images` and not `images`: run history is written to
  // a DynamoDB item capped at 400KB, and saveRun is best-effort — base64 landing
  // there loses the user their run silently.
  it('never reaches the saved run record', () => {
    const saved = publicInputs({ input: 'launch day', _images: [{ dataUrl: png(4096) }] });
    expect(saved).toEqual({ input: 'launch day' });
  });
});
