import { describe, expect, it } from 'vitest';
import { TAG, encode, encodeSequence } from '../../src/lib/der.js';
import { checkRenewalInfo, renewalCertId } from '../../src/lib/renewal-info.js';

const AKI_OID = new Uint8Array([0x55, 0x1d, 0x23]);
const OTHER_OID = new Uint8Array([0x55, 0x1d, 0x0e]);
const KEY_ID = new Uint8Array([0x69, 0x88, 0x5b, 0x6b, 0x87, 0x46, 0x40, 0x41]);
const SERIAL = new Uint8Array([0x00, 0x87, 0x65, 0x43, 0x21]);

/** The shape of a certificate, holding only what the identifier reads. */
function certificate(options: { aki?: boolean } = {}): Uint8Array {
  const aki = encodeSequence(
    encode(TAG.oid, AKI_OID),
    encode(TAG.octetString, encodeSequence(encode(0x80, KEY_ID))),
  );
  const other = encodeSequence(
    encode(TAG.oid, OTHER_OID),
    encode(TAG.octetString, encode(TAG.octetString, new Uint8Array([1]))),
  );
  const extensions = encode(
    0xa3,
    encodeSequence(...(options.aki === false ? [other] : [other, aki])),
  );
  const tbs = encodeSequence(
    encode(0xa0, encode(TAG.integer, new Uint8Array([2]))),
    encode(TAG.integer, SERIAL),
    extensions,
  );
  return encodeSequence(tbs);
}

describe('renewalCertId', () => {
  it('builds the identifier from the key identifier and the serial', () => {
    // The serial's leading zero is kept: it is the DER content, not the number.
    expect(renewalCertId(certificate())).toBe('aYhba4dGQEE.AIdlQyE');
  });

  it('is null for a certificate with no Authority Key Identifier', () => {
    expect(renewalCertId(certificate({ aki: false }))).toBeNull();
  });
});

describe('checkRenewalInfo', () => {
  const materials = { leafDer: certificate(), issuerOrganization: "Let's Encrypt" };
  const window = { start: '2026-11-01T00:00:00Z', end: '2026-11-03T00:00:00Z' };

  it('asks the authority about that certificate, and reports its window', async () => {
    const asked: string[] = [];

    const info = await checkRenewalInfo(materials, (url) => {
      asked.push(url);
      return Promise.resolve({
        status: 200,
        body: { suggestedWindow: window, explanationURL: 'https://example.com/why' },
      });
    });

    expect(asked).toEqual([
      'https://acme-v02.api.letsencrypt.org/acme/renewal-info/aYhba4dGQEE.AIdlQyE',
    ]);
    expect(info).toEqual({
      checked: true,
      windowStart: '2026-11-01T00:00:00.000Z',
      windowEnd: '2026-11-03T00:00:00.000Z',
      explanationUrl: 'https://example.com/why',
      unavailableReason: null,
    });
  });

  it('contacts nobody about an issuer it has no verified endpoint for', async () => {
    const info = await checkRenewalInfo(
      { leafDer: certificate(), issuerOrganization: 'Some Other CA' },
      () => Promise.reject(new Error('must not be asked')),
    );

    expect(info.checked).toBe(false);
    expect(info.unavailableReason).toContain('Some Other CA');
  });

  it.each([
    ['an error status', { status: 404, body: null }, 'HTTP 404'],
    ['no window', { status: 200, body: {} }, 'no renewal window'],
    [
      'a window that is not dates',
      { status: 200, body: { suggestedWindow: { start: 'soon', end: 'later' } } },
      'no renewal window',
    ],
  ])('reports %s as not checked', async (_label, answer, reason) => {
    const info = await checkRenewalInfo(materials, () => Promise.resolve(answer));

    expect(info.checked).toBe(false);
    expect(info.unavailableReason).toContain(reason);
  });

  it('never throws, whatever the certificate or the network does', async () => {
    const down = await checkRenewalInfo(materials, () => Promise.reject(new Error('refused')));
    const garbage = await checkRenewalInfo(
      { leafDer: new Uint8Array([0xff, 0xff]), issuerOrganization: "Let's Encrypt" },
      () => Promise.reject(new Error('must not be asked')),
    );

    expect(down.unavailableReason).toContain('refused');
    expect(garbage.checked).toBe(false);
  });
});
