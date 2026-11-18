import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { judgeFailure, judgeStatus } from '../../src/lib/link-health.js';

/**
 * @param code A socket or TLS error code.
 * @returns The error `fetch` would reject with: the code sits on its cause.
 */
function fetchFailure(code: string): Error {
  return new CheckError('network', 'could not reach https://example.com/x', {
    cause: new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) }),
  });
}

describe('judgeStatus', () => {
  it.each([404, 410, 500, 503])('calls %i broken', (status) => {
    expect(judgeStatus(status).kind).toBe('broken');
  });

  it.each([408, 429])('calls %i unchecked: the server declined to answer now', (status) => {
    expect(judgeStatus(status).kind).toBe('unchecked');
  });

  it.each([200, 204, 301, 308])('calls %i fine', (status) => {
    expect(judgeStatus(status).kind).toBe('ok');
  });
});

describe('judgeFailure', () => {
  it('calls a name that does not resolve, or a refused certificate, broken', () => {
    expect(judgeFailure(fetchFailure('ENOTFOUND'), 'example.com')).toEqual({
      kind: 'broken',
      reason: 'example.com does not resolve',
    });
    expect(judgeFailure(fetchFailure('CERT_HAS_EXPIRED'), 'example.com').kind).toBe('broken');
    expect(judgeFailure(new CheckError('not_found', 'x does not resolve'), 'x').kind).toBe(
      'broken',
    );
  });

  it.each(['UND_ERR_HEADERS_OVERFLOW', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'])(
    'calls %s unchecked: it may be this side',
    (code) => {
      expect(judgeFailure(fetchFailure(code), 'example.com').kind).toBe('unchecked');
    },
  );

  it('calls a timeout unchecked', () => {
    expect(judgeFailure(new CheckError('timeout', 'did not respond'), 'example.com').kind).toBe(
      'unchecked',
    );
  });
});
