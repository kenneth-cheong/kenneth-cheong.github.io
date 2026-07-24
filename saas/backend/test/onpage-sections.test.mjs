import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { sectionsOnpage, onpageImages, altRationale } = __test;

const KNOWN = new Set(['heading', 'callout', 'text', 'stats', 'list', 'chart', 'cards', 'table']);
const assertShape = (sections) => {
  for (const s of sections) {
    expect(KNOWN.has(s.type)).toBe(true);
    if (s.type === 'table') { expect(Array.isArray(s.columns)).toBe(true); expect(Array.isArray(s.rows)).toBe(true); }
  }
};

const EXTRACTION = {
  meta_title: 'Award-Winning Digital Marketing Agency In Singapore | MediaOne',
  meta_description: 'Award-winning digital marketing agency in Singapore offering SEO, paid media and web design.',
  canonical_url: 'https://mediaonemarketing.com.sg',
  headings: { h1: ['Digital Marketing Agency'], h2: ['Our services', 'Why us'], h3: [] },
  image_data: [
    { 'https://mediaonemarketing.com.sg/logo.png': 'MediaOne logo' },
    { '/img/team.jpg': '' },
    { 'https://mediaonemarketing.com.sg/logo.png': 'MediaOne logo' }, // repeat
    { 'data:image/png;base64,AAA': 'inline' },
  ],
};

describe('onpageImages', () => {
  it('absolutises, de-duplicates and drops data: URIs', () => {
    const imgs = onpageImages(EXTRACTION, 'https://mediaonemarketing.com.sg');
    expect(imgs.map((i) => i.src)).toEqual([
      'https://mediaonemarketing.com.sg/logo.png',
      'https://mediaonemarketing.com.sg/img/team.jpg',
    ]);
    expect(imgs[1].alt).toBe('');
  });

  it('resolves a path-relative src against the page path, not the bare origin', () => {
    const imgs = onpageImages({ image_data: [{ 'img/rel.jpg': '' }, { '//cdn.x.com/p.png': '' }] }, 'https://x.com/blog/post/');
    expect(imgs.map((i) => i.src)).toEqual(['https://x.com/blog/post/img/rel.jpg', 'https://cdn.x.com/p.png']);
  });
});

describe('sectionsOnpage', () => {
  const recs = {
    meta_title: { current_value: EXTRACTION.meta_title, suggested_value: 'SEO Agency Singapore | MediaOne', rationale: 'Leads with the keyword.' },
    headings: { h1: [{ current_value: 'Digital Marketing Agency', suggested_value: 'SEO Agency in Singapore', rationale: 'Adds the target keyword.' }] },
  };
  const images = onpageImages(EXTRACTION, 'https://mediaonemarketing.com.sg');
  const alt = new Map([['https://mediaonemarketing.com.sg/img/team.jpg', 'The MediaOne team in their Singapore office']]);

  it('renders every section, not just the images one', () => {
    const out = sectionsOnpage('https://mediaonemarketing.com.sg', recs, EXTRACTION, [
      { Element: 'Body copy', Current: '400 words', Suggested: '900 words', Why: 'Competitors average 900.' },
    ], images, alt, ['seo agency singapore']);
    assertShape(out);
    const titles = out.filter((s) => s.type === 'table').map((s) => s.title);
    expect(titles).toEqual(['Meta & canonical', 'Headings (H1–H6)', 'Images — alt text (2)', 'Content recommendations']);
    expect(out.some((s) => s.type === 'stats')).toBe(true);
  });

  it('lists every image with its proposed alt text', () => {
    const out = sectionsOnpage('https://x.com', recs, EXTRACTION, [], images, alt, ['seo']);
    const t = out.find((s) => s.title?.startsWith('Images'));
    expect(t.columns).toContain('Proposed alt');
    expect(t.rows).toHaveLength(images.length); // no 30-row slice under a count of 52
    // The thumbnail column carries the absolute src as a plain string, so CSV
    // export and copy-to-clipboard stay readable.
    expect(t.columns[0]).toBe('Preview');
    expect(t.rows[1].Preview).toBe('https://mediaonemarketing.com.sg/img/team.jpg');
    expect(t.rows[1]['Proposed alt']).toBe('The MediaOne team in their Singapore office');
    expect(t.rows[1]['Current alt']).toBe('(missing)');
  });

  it('still reports the page inventory (and says why) when no keywords were given', () => {
    const out = sectionsOnpage('https://x.com', {}, EXTRACTION, [], images, new Map(), []);
    assertShape(out);
    expect(out.some((s) => s.type === 'callout')).toBe(true);
    const titles = out.filter((s) => s.type === 'table').map((s) => s.title);
    expect(titles).toContain('Meta & canonical');
    expect(titles).toContain('Headings (H1–H6)');
  });

  it('flags a missing H1 as its own row', () => {
    const extraction = { ...EXTRACTION, headings: { h1: [], h2: ['Our services'] } };
    const out = sectionsOnpage('https://x.com', { headings: { h1: [{ suggested_value: 'SEO Agency in Singapore', rationale: 'None present.' }] } }, extraction, [], [], new Map(), ['seo']);
    const rows = out.find((s) => s.title?.startsWith('Headings')).rows;
    expect(rows.find((r) => r.Level === 'H1')).toMatchObject({ Current: '(missing)', Suggested: 'SEO Agency in Singapore' });
  });
});

describe('altRationale', () => {
  it('explains missing, placeholder and unchanged alt text differently', () => {
    expect(altRationale('', 'A team photo')).toMatch(/no alt text/i);
    expect(altRationale('image_02', 'A team photo')).toMatch(/placeholder/i);
    expect(altRationale('A team photo', 'a team photo')).toMatch(/already appropriate/i);
  });
});
