import { describe, expect, it } from 'vitest';
import { caaAllowsIssuer } from '../../src/lib/caa.js';

const LETS_ENCRYPT = "Let's Encrypt";

describe('caaAllowsIssuer', () => {
  it('has nothing to say when no record restricts issuance', () => {
    expect(caaAllowsIssuer([], LETS_ENCRYPT, false)).toBeNull();
    expect(
      caaAllowsIssuer([{ critical: 0, iodef: 'mailto:a@example.com' }], LETS_ENCRYPT, false),
    ).toBeNull();
  });

  it('has nothing to say about an issuer it has no identifiers for', () => {
    // Saying "your next renewal will fail" on a guess would be worse than silence.
    expect(
      caaAllowsIssuer([{ critical: 0, issue: 'pki.goog' }], 'Some Other CA', false),
    ).toBeNull();
    expect(caaAllowsIssuer([{ critical: 0, issue: 'pki.goog' }], null, false)).toBeNull();
  });

  it('allows an issuer any record names', () => {
    const records = [
      { critical: 0, issue: 'pki.goog' },
      { critical: 0, issue: 'letsencrypt.org' },
    ];

    expect(caaAllowsIssuer(records, LETS_ENCRYPT, false)).toBe(true);
  });

  it('excludes an issuer no record names', () => {
    expect(caaAllowsIssuer([{ critical: 0, issue: 'pki.goog' }], LETS_ENCRYPT, false)).toBe(false);
  });

  it.each([
    ['parameters', 'letsencrypt.org; accounturi=https://example.com/acct/1', true],
    ['case and spacing', '  LetsEncrypt.ORG ', true],
    ['a record allowing nobody', ';', false],
  ])('reads %s', (_label, value, expected) => {
    expect(caaAllowsIssuer([{ critical: 0, issue: value }], LETS_ENCRYPT, false)).toBe(expected);
  });

  it('accepts any identifier an authority recognises', () => {
    expect(
      caaAllowsIssuer([{ critical: 0, issue: 'comodoca.com' }], 'Sectigo Limited', false),
    ).toBe(true);
    expect(caaAllowsIssuer([{ critical: 0, issue: 'amazontrust.com' }], 'Amazon', false)).toBe(
      true,
    );
  });

  describe('for a wildcard certificate', () => {
    it('follows issuewild when one is published', () => {
      const records = [
        { critical: 0, issue: 'letsencrypt.org' },
        { critical: 0, issuewild: 'pki.goog' },
      ];

      expect(caaAllowsIssuer(records, LETS_ENCRYPT, true)).toBe(false);
      expect(caaAllowsIssuer(records, 'Google Trust Services', true)).toBe(true);
    });

    it('falls back to issue when none is', () => {
      expect(caaAllowsIssuer([{ critical: 0, issue: 'letsencrypt.org' }], LETS_ENCRYPT, true)).toBe(
        true,
      );
    });
  });

  it('ignores issuewild for a certificate that is not a wildcard', () => {
    const records = [
      { critical: 0, issue: 'letsencrypt.org' },
      { critical: 0, issuewild: 'pki.goog' },
    ];

    expect(caaAllowsIssuer(records, LETS_ENCRYPT, false)).toBe(true);
  });
});
