import type { ToolErrorCode } from '../types.js';

/**
 * A failure with a category already attached.
 *
 * Modules in `lib/` throw this rather than returning a result type, so that a
 * deep call stack does not have to thread a failure back by hand. Tool handlers
 * catch it and turn it into an MCP error result — nothing escapes to the
 * protocol, and the category survives the trip.
 */
export class CheckError extends Error {
  /** Category the tool layer reports to the caller. */
  readonly code: ToolErrorCode;

  /**
   * @param code Category of failure.
   * @param message Actionable explanation naming what failed and against what.
   * @param options Standard error options; pass `cause` to keep the original.
   */
  constructor(code: ToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CheckError';
    this.code = code;
  }
}

/**
 * Maps a DNS or socket error code onto a tool error category.
 *
 * @param code The `err.code` from `node:dns` or a socket.
 * @returns The matching category, defaulting to `network`.
 * @throws Never.
 */
export function categorise(code: string | undefined): ToolErrorCode {
  switch (code) {
    case 'ENOTFOUND':
    case 'ENODATA':
      return 'not_found';
    // ETIMEOUT is what node:dns emits; ETIMEDOUT is the socket equivalent. They
    // are different strings and both occur, which is easy to get wrong.
    case 'ETIMEOUT':
    case 'ETIMEDOUT':
    case 'ECANCELLED':
      return 'timeout';
    default:
      return 'network';
  }
}

/**
 * What a browser makes of a certificate it refuses, by the code Node gives the failure.
 *
 * Only the failures a browser shares. An incomplete chain is left out on purpose: Node
 * reports it as `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, while browsers fetch the missing
 * intermediate and open the site, and a trust store here that lacks a root is a fault
 * of this machine, not of the site.
 */
const REFUSED_CERTIFICATES: Record<string, string> = {
  CERT_HAS_EXPIRED: 'its certificate has expired',
  CERT_NOT_YET_VALID: 'its certificate is not valid yet',
  CERT_REVOKED: 'its certificate has been revoked',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is self-signed',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is not valid for {host}',
};

/**
 * Says why browsers would refuse a site, when that is why a request to it failed.
 *
 * A refused certificate is a site visitors cannot open, which is the site being down
 * for them. A timeout or a failed DNS lookup is not that: it may be the network this
 * server runs on, and stays a check that could not run.
 *
 * @param cause Whatever a request rejected with. The TLS code is looked for down its
 *   chain of causes, since `fetch` wraps it.
 * @param host The host that was asked for, for the message.
 * @returns The reason, e.g. `its certificate has expired`, or `null` when the failure
 *   was something else.
 * @throws Never.
 */
export function certificateRefusal(cause: unknown, host: string): string | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      const known = Object.hasOwn(REFUSED_CERTIFICATES, code)
        ? REFUSED_CERTIFICATES[code]
        : undefined;
      if (known !== undefined) return known.replace('{host}', host);
      // An alert is the server's own refusal; the other two are a server that will not
      // speak a TLS any browser accepts.
      if (
        /^ERR_SSL_.*ALERT/.test(code) ||
        code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
        code === 'ERR_SSL_UNSUPPORTED_PROTOCOL'
      ) {
        return `the TLS handshake failed (${code})`;
      }
    }
    current = current.cause;
  }
  return null;
}
