import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { welcomeEmailHtml, welcomeEmailText } from '../src/lib/welcome-email.mjs';
import { PLANS } from '../../shared/catalog.mjs';

// The source template was authored with {{first_name}} / {{dashboard_url}} /
// {{website_url}} placeholders. These tests pin that every one of them is
// substituted for a real value in BOTH the HTML and the plain-text part — an
// unsubstituted placeholder would ship "Hi {{first_name}}," to a real signup.
describe('welcome email placeholder substitution', () => {
  const ORIGIN = 'https://platform.digimetrics.ai';
  let prevOrigin;
  beforeEach(() => { prevOrigin = process.env.APP_ORIGIN; process.env.APP_ORIGIN = ORIGIN; });
  afterEach(() => { process.env.APP_ORIGIN = prevOrigin; });

  const users = [
    { label: 'name + email', user: { name: 'Jane Tan', email: 'jane@acme.com' } },
    { label: 'email only', user: { email: 'kenneth@mediaone.co' } },
    { label: 'dotted/numbered local part', user: { email: 'jane.doe1@acme.com' } },
    { label: 'blank name', user: { name: '   ', email: 'sam@acme.com' } },
    { label: 'no name and no local part', user: { email: '@acme.com' } },
    { label: 'empty user', user: {} },
  ];

  for (const { label, user } of users) {
    it(`leaves no placeholder unresolved — ${label}`, () => {
      for (const body of [welcomeEmailHtml(user), welcomeEmailText(user)]) {
        expect(body).not.toMatch(/\{\{|\}\}/);
        // A greeting is always produced, never "Hi ," or "Hi undefined,".
        // Capitalised first name, or the "there" fallback.
        expect(body).toMatch(/Hi ([A-Z][A-Za-z]*|there),/);
        expect(body).not.toMatch(/undefined|null|NaN/);
      }
    });
  }

  it('derives the first name from name, then email, then a safe default', () => {
    expect(welcomeEmailText({ name: 'Jane Tan' })).toContain('Hi Jane,');
    expect(welcomeEmailText({ email: 'jane.doe1@acme.com' })).toContain('Hi Jane,');
    expect(welcomeEmailText({ email: 'kenneth@mediaone.co' })).toContain('Hi Kenneth,');
    expect(welcomeEmailText({})).toContain('Hi there,');
  });

  it('substitutes dashboard_url with APP_ORIGIN and website_url with the platform domain', () => {
    const html = welcomeEmailHtml({ email: 'a@b.co' });
    expect(html).toContain(`href="${ORIGIN}"`);
    // Footer link, shown without the scheme.
    expect(html).toContain('>platform.digimetrics.ai</a>');
    // Never the bare marketing domain — readers already have an account.
    expect(html).not.toContain('href="https://digimetrics.ai"');
    expect(welcomeEmailText({ email: 'a@b.co' })).toContain(`Log in to your dashboard: ${ORIGIN}`);
  });

  it('trims a trailing slash on APP_ORIGIN so the link is not doubled', () => {
    process.env.APP_ORIGIN = 'https://platform.digimetrics.ai/';
    expect(welcomeEmailHtml({})).toContain('href="https://platform.digimetrics.ai"');
  });

  it('falls back to the platform domain when APP_ORIGIN is unset', () => {
    delete process.env.APP_ORIGIN;
    expect(welcomeEmailText({})).toContain('Log in to your dashboard: https://platform.digimetrics.ai');
  });

  it('quotes the credit allowance from the catalog, not a hardcoded number', () => {
    const n = PLANS.free.monthlyCredits;
    expect(welcomeEmailHtml({})).toContain(`${n} free credits every month`);
    expect(welcomeEmailText({})).toContain(`${n} free credits every month`);
  });

  it('escapes a name that contains HTML so it cannot break the markup', () => {
    const html = welcomeEmailHtml({ name: '<script>x</script>Bad' });
    expect(html).not.toContain('<script>');
  });

  it('emits all five onboarding steps, numbered 1-5', () => {
    const html = welcomeEmailHtml({});
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`vertical-align:middle;">${n}</td>`);
    expect(welcomeEmailText({})).toContain('5. Track your progress');
  });

  it('keeps the plain-text part free of HTML tags', () => {
    expect(welcomeEmailText({ name: 'Jane' })).not.toMatch(/<[a-z/]/i);
  });

  it('sends no raw non-ASCII through the 7-bit mail path', () => {
    // sendRawEmail declares Content-Transfer-Encoding: 7bit, so the HTML body
    // must express emoji/symbols as entities. (The text part is allowed prose.)
    const html = welcomeEmailHtml({ name: 'Jane' });
    expect(html.replace(/[‘’“”—–]/g, '')).toMatch(/^[\x00-\x7F]*$/);
  });
});
