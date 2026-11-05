import * as z from 'zod/v4';
import { TAG, childrenOf, contentOf, readNode, readOid, type DerNode } from './der.js';
import { TIMEOUTS } from './defaults.js';
import { getJson } from './http-client.js';

/**
 * Asking a certificate authority when a certificate should be renewed.
 *
 * ACME Renewal Information (RFC 9773) is an unauthenticated GET, keyed by the
 * certificate itself, that answers with the window in which the authority wants a
 * replacement requested. A certificate still being served after that window has
 * closed is direct evidence that its automation has stopped, and that evidence
 * arrives while the certificate is still valid, before any expiry date is close.
 *
 * Only Let's Encrypt is asked. The certificate does not say which ACME server
 * issued it, so each authority needs an entry here, and this is the only one whose
 * endpoint has been verified against a live answer. Everything else reports that it
 * was not checked, which is not a clean result.
 *
 * @see https://www.rfc-editor.org/rfc/rfc9773.html
 */

/** Where each verified authority publishes renewal information, by issuer organisation. */
const RENEWAL_INFO_ENDPOINTS: Record<string, string> = {
  "Let's Encrypt": 'https://acme-v02.api.letsencrypt.org/acme/renewal-info/',
};

/** The Authority Key Identifier extension. */
const AUTHORITY_KEY_IDENTIFIER_OID = '2.5.29.35';

/** The `keyIdentifier` field inside that extension, `[0] IMPLICIT`. */
const KEY_IDENTIFIER_TAG = 0x80;

/** The `extensions` field of a certificate, `[3] EXPLICIT`. */
const EXTENSIONS_TAG = 0xa3;

/** What an authority answers. Extra fields are fine; missing ones are not an answer. */
const answerSchema = z.object({
  suggestedWindow: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }),
  explanationURL: z.string().optional(),
});

/** What was established about when a certificate should be renewed. */
export interface RenewalInfo {
  /** Whether the issuing authority gave an answer. */
  checked: boolean;
  /** When the authority wants renewal attempted from, ISO 8601 UTC. */
  windowStart: string | null;
  /** When that window closes, ISO 8601 UTC. */
  windowEnd: string | null;
  /** Why the authority moved the window, when it published a reason. */
  explanationUrl: string | null;
  /** Why this was not checked, or `null` when it was. */
  unavailableReason: string | null;
}

/** What a renewal check needs from a handshake. */
export interface RenewalMaterials {
  /** The end-entity certificate, DER encoded. */
  leafDer: Uint8Array | null;
  /** The issuer's organisation, which decides who can be asked. */
  issuerOrganization: string | null;
}

/**
 * Builds the identifier RFC 9773 §4.1 defines for a certificate.
 *
 * The serial keeps any leading zero octet: it is the DER content, not the number,
 * and dropping it asks about a different certificate.
 *
 * @param leafDer The certificate, DER encoded.
 * @returns `base64url(keyIdentifier).base64url(serial)`, or `null` when the
 *   certificate has no Authority Key Identifier to build one from.
 * @throws {DerError} When the certificate is not well-formed DER.
 */
export function renewalCertId(leafDer: Uint8Array): string | null {
  const certificate = readNode(leafDer, 0);
  const tbs = childrenOf(leafDer, certificate)[0];
  if (tbs === undefined) return null;

  const fields = childrenOf(leafDer, tbs);
  // `version` is optional and explicitly tagged, so the serial is the first
  // INTEGER rather than a fixed position.
  const serial = fields.find((field) => field.tag === TAG.integer);
  const extensions = fields.find((field) => field.tag === EXTENSIONS_TAG);
  if (serial === undefined || extensions === undefined) return null;

  const keyIdentifier = readKeyIdentifier(leafDer, extensions);
  if (keyIdentifier === null) return null;

  return `${base64url(keyIdentifier)}.${base64url(contentOf(leafDer, serial))}`;
}

/**
 * @param bytes The certificate.
 * @param extensions Its `[3]` extensions field.
 * @returns The Authority Key Identifier's `keyIdentifier`, or `null` when absent.
 * @throws {DerError} When the structure is malformed.
 */
function readKeyIdentifier(bytes: Uint8Array, extensions: DerNode): Uint8Array | null {
  const list = childrenOf(bytes, extensions)[0];
  if (list === undefined) return null;

  for (const extension of childrenOf(bytes, list)) {
    const parts = childrenOf(bytes, extension);
    const oid = parts[0];
    // `critical` is optional, so the value is the last part and not the second.
    const value = parts.at(-1);
    if (oid === undefined || value === undefined) continue;
    if (readOid(bytes, oid) !== AUTHORITY_KEY_IDENTIFIER_OID) continue;

    const inner = contentOf(bytes, value);
    const fields = childrenOf(inner, readNode(inner, 0));
    const identifier = fields.find((field) => field.tag === KEY_IDENTIFIER_TAG);
    return identifier === undefined ? null : contentOf(inner, identifier);
  }

  return null;
}

/**
 * @param bytes What to encode.
 * @returns It as unpadded base64url.
 * @throws Never.
 */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Asks the issuing authority when a certificate should be renewed.
 *
 * @param materials What the handshake yielded.
 * @param get How to fetch an answer. Injected for tests.
 * @returns The window, or why there is none. An authority that cannot be asked or
 *   will not answer leaves a reason, because this is an extra question on top of a
 *   check that has already succeeded.
 * @throws Never.
 */
export async function checkRenewalInfo(
  materials: RenewalMaterials,
  get: (url: string) => Promise<{ status: number; body: unknown }> = (url) =>
    getJson(url, TIMEOUTS.renewalInfoMs),
): Promise<RenewalInfo> {
  const unavailable = (unavailableReason: string): RenewalInfo => ({
    checked: false,
    windowStart: null,
    windowEnd: null,
    explanationUrl: null,
    unavailableReason,
  });

  const endpoint =
    materials.issuerOrganization === null
      ? undefined
      : RENEWAL_INFO_ENDPOINTS[materials.issuerOrganization];
  if (endpoint === undefined) {
    return unavailable(
      `this server only asks Let's Encrypt, and the issuer is ${materials.issuerOrganization ?? 'not named'}`,
    );
  }
  if (materials.leafDer === null) return unavailable('no certificate was served');

  try {
    const certId = renewalCertId(materials.leafDer);
    if (certId === null) {
      return unavailable('the certificate has no Authority Key Identifier to ask about');
    }

    const answer = await get(`${endpoint}${certId}`);
    if (answer.status !== 200) {
      return unavailable(`the authority answered HTTP ${String(answer.status)}`);
    }

    const parsed = answerSchema.safeParse(answer.body);
    if (!parsed.success) return unavailable('the authority answered with no renewal window');

    return {
      checked: true,
      windowStart: new Date(parsed.data.suggestedWindow.start).toISOString(),
      windowEnd: new Date(parsed.data.suggestedWindow.end).toISOString(),
      explanationUrl: parsed.data.explanationURL ?? null,
      unavailableReason: null,
    };
  } catch (cause) {
    return unavailable(cause instanceof Error ? cause.message : String(cause));
  }
}
