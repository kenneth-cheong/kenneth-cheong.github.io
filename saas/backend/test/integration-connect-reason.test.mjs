import { describe, it, expect } from 'vitest';
import { __test } from '../src/metering/index.mjs';

const { connectReasonOf } = __test;

// Everything this classifier misses becomes an opaque 500, and a 500 auto-opens
// the "Report a problem" panel — so a user who simply hasn't signed in gets asked
// to file a bug. These are the messages the connectors actually throw
// (lib/google.mjs, lib/meta.mjs, lib/linkedin.mjs).
describe('connectReasonOf — connection failures must never read as faults', () => {
  it('reads "pick an account" out of the missing-target throws', () => {
    for (const m of ['no site', 'no property', 'no customer id', 'no account', 'no ad account']) {
      expect(connectReasonOf(m)).toBe('account');
    }
  });

  it('reads "sign in again" out of the auth failures', () => {
    for (const m of [
      'gsc 403', 'gsc 401', 'ga4 401', 'sitemaps 403', 'ads 401',
      'token refresh 400', 'token exchange 400', 'invalid_grant',
      'Unauthorized', 'unauthorised', 'permission denied',
      'Permission denied — reconnect Google in Integrations to grant sitemap write access.',
    ]) {
      expect(connectReasonOf(m), m).toBe('reconnect');
    }
  });

  it('reads "connect" out of the not-connected throw', () => {
    expect(connectReasonOf('not connected')).toBe('connect');
  });

  it('leaves genuine faults alone so they still surface as errors', () => {
    for (const m of ['fetch failed', 'ECONNRESET', 'upstream 500', 'Unexpected token < in JSON', '', null, undefined]) {
      expect(connectReasonOf(m)).toBe(null);
    }
  });
});
