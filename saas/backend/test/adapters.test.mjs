import { describe, it, expect } from 'vitest';
import { ADAPTERS } from '../src/metering/adapters.mjs';

describe('adapters → upstream request shapes', () => {
  it('caption builds luxury_copy + verbatim prompt', () => {
    const r = ADAPTERS.caption.request({ input: 'launch', brand: 'Acme', platform: 'Instagram', tone: 'Bold', emojis: 'No', hashtags: 'Yes' });
    expect(r.action).toBe('luxury_copy');
    expect(r.contentTypeLabel).toBe('Instagram caption');
    expect(r.fields.brandName).toBe('Acme');
    expect(r.prompt).toContain('Brand: Acme');
    expect(r.prompt).not.toContain('Include emojis in the content');
    expect(r.prompt).toContain('Include relevant hashtags');
  });
  it('sem-copy maps friendly format → slug and adds the model', () => {
    const r = ADAPTERS['sem-copy'].request({ input: 'x', format: 'Meta Carousel' });
    expect(r.type).toBe('meta-carousel-ads');
    expect(r.model).toBe('claude-haiku-4-5');
  });
  it('geo-onpage sends prompts as a raw string (not array)', () => {
    expect(typeof ADAPTERS['geo-onpage'].request({ input: 'u', prompts: 'a\nb' }).prompts).toBe('string');
  });
  it('competitors includes id + user + language', () => {
    const r = ADAPTERS.competitors.request({ input: 'a,b', _email: 'me@x.co' });
    expect(r.user).toBe('me@x.co');
    expect(r.id).toMatch(/^comp_/);
    expect(r.language).toBe('English');
  });
  it('pillars builds pillar_framework with array objectives', () => {
    const r = ADAPTERS.pillars.request({ businessModel: 'B2C', objectives: 'Brand authority' });
    expect(r.type).toBe('pillar_framework');
    expect(r.objectives).toEqual(['Brand authority']);
  });
  // A caller that sends only `input` (Monty, a schedule, the raw API) used to
  // blank every context field, and the upstream answered with a clarifying
  // question instead of a framework.
  it('pillars fills the commercial context from the form defaults', () => {
    const r = ADAPTERS.pillars.request({ input: 'Digital marketing analytics SaaS for agencies' });
    for (const k of ['business_model', 'audience_type', 'decision_complexity', 'risk_sensitivity', 'promotional_tolerance']) {
      expect(r[k], k).toBeTruthy();
    }
    expect(r.objectives.length).toBe(1);
    expect(r.platforms.length).toBe(1);
    expect(r.additional_info).toBe('Digital marketing analytics SaaS for agencies');
  });
  it('landing-audit shape', () => {
    expect(ADAPTERS['landing-audit'].request({ input: 'https://x', keyword: 'k' })).toMatchObject({ url: 'https://x', keyword: 'k', use_ai: true });
  });
});
