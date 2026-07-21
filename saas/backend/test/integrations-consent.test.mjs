import { describe, it, expect } from 'vitest';
import { consentTargets, providersInFamilyOf } from '../src/lib/integrations.mjs';

// Which sources an OAuth consent is allowed to switch on. The rule that matters:
// disconnecting one source must stick, even after the user re-consents for a
// sibling — otherwise "Disconnect" is a lie the next sign-in undoes.
const GOOGLE = ['gsc', 'ga4', 'google-ads'];
const on = (...ids) => Object.fromEntries(ids.map((id) => [id, { connected: true, account: `acct-${id}` }]));

describe('consentTargets', () => {
  it('connects the whole family on a first sign-in', () => {
    expect(consentTargets({ provider: 'gsc', scope: 'family', existing: {} })).toEqual(GOOGLE);
    expect(consentTargets({ provider: 'ga4', existing: {} })).toEqual(GOOGLE);
  });

  it('never resurrects a source the user disconnected', () => {
    const existing = on('ga4', 'google-ads'); // gsc disconnected on purpose
    // Family card "Reconnect" refreshes only what is still connected.
    expect(consentTargets({ provider: 'gsc', scope: 'family', existing })).toEqual(['ga4', 'google-ads']);
    // A consent started from the GA4 tool likewise leaves gsc off.
    expect(consentTargets({ provider: 'ga4', existing })).toEqual(['ga4', 'google-ads']);
  });

  it('lets the disconnected source connect itself again', () => {
    const existing = on('ga4', 'google-ads');
    // The GSC tool's connect prompt names gsc, so gsc comes back — with its
    // siblings refreshed by the same consent, not dropped.
    expect(consentTargets({ provider: 'gsc', existing }).sort()).toEqual(GOOGLE.slice().sort());
  });

  it('scopes a "different account" re-auth to the one source', () => {
    const existing = on(...GOOGLE);
    expect(consentTargets({ provider: 'gsc', single: true, existing })).toEqual(['gsc']);
    // …even when that source is the only one left connected.
    expect(consentTargets({ provider: 'gsc', single: true, existing: on('gsc') })).toEqual(['gsc']);
  });

  it('treats single-source families (Meta, LinkedIn) the same way', () => {
    for (const p of ['meta-ads', 'linkedin-ads']) {
      expect(providersInFamilyOf(p)).toEqual([p]);
      expect(consentTargets({ provider: p, existing: {} })).toEqual([p]);
      expect(consentTargets({ provider: p, scope: 'family', existing: {} })).toEqual([p]);
      // Disconnected then reconnected from its own card — comes back.
      expect(consentTargets({ provider: p, existing: on('gsc') })).toEqual([p]);
      // A connected Meta account is untouched by a Google consent, and vice versa.
      expect(consentTargets({ provider: 'gsc', scope: 'family', existing: on(...GOOGLE, p) })).toEqual(GOOGLE);
    }
  });

  it('keeps families independent — disconnecting Meta leaves Google alone', () => {
    const existing = on(...GOOGLE); // meta-ads disconnected
    expect(consentTargets({ provider: 'meta-ads', existing })).toEqual(['meta-ads']);
    expect(consentTargets({ provider: 'gsc', scope: 'family', existing })).toEqual(GOOGLE);
  });
});
