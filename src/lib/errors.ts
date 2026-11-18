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
 * Only the failures a browser shares, and only verification of the certificate itself.
 * An incomplete chain is left out on purpose: Node reports it as
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, while browsers fetch the missing intermediate and
 * open the site. So is an untrusted root (`SELF_SIGNED_CERT_IN_CHAIN`,
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`): a trust store here that lacks a root is a fault
 * of this machine, and a proxy on this side that intercepts TLS produces exactly that.
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
 * server runs on, and stays a check that could not run. Nor is a handshake that ended
 * in an alert or a protocol error, which {@link handshakeFailure} describes: a firewall
 * refusing this server's address and a proxy on this side end a handshake the same way
 * a broken server does, and only the last is the site being down.
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
    }
    current = current.cause;
  }
  return null;
}

/**
 * Says what to do about a TLS handshake that failed before any certificate was judged.
 *
 * Kept apart from {@link certificateRefusal} because it does not say the site is down. An
 * alert is whoever answered refusing the handshake, and a wrong version number is
 * something that is not speaking TLS: a server misconfigured, or a firewall blocking this
 * server's address, or a captive or intercepting proxy on this side. Only a look from
 * another network tells them apart.
 *
 * @param cause Whatever a request rejected with. The code is looked for down its chain of
 *   causes, since `fetch` wraps it.
 * @param url The address that was asked for, for the message.
 * @returns An actionable message naming the code, or `null` when the failure was
 *   something else.
 * @throws Never.
 */
export function handshakeFailure(cause: unknown, url: string): string | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      (/^ERR_SSL_.*ALERT/.test(code) ||
        code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
        code === 'ERR_SSL_UNSUPPORTED_PROTOCOL')
    ) {
      return (
        `the TLS handshake with ${url} failed (${code}), so whether visitors can open it is not ` +
        'known: the server may refuse it, or a firewall may be blocking this server, or a proxy ' +
        'on this side may be intercepting TLS. Open it in a browser on another network'
      );
    }
    current = current.cause;
  }
  return null;
}

/** What a socket error code means, for a reader who has not memorised them. */
export const CONNECTION_FAILURES: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'the connection was reset',
  ETIMEDOUT: 'the connection timed out',
  EHOSTUNREACH: 'the host is unreachable',
  ENETUNREACH: 'the network is unreachable',
  ENOTFOUND: 'the domain does not resolve',
  EAI_AGAIN: 'the domain could not be resolved right now',
  EPIPE: 'the connection was closed while sending',
};

/**
 * Says why a connection failed, from whatever the socket layer threw.
 *
 * Shared by every path that opens a connection, so that `uptime_check` and
 * `ssl_check` describe one dead domain in the same words.
 *
 * Not just `message`: a name with both an IPv6 and an IPv4 address, both
 * refusing, fails with an `AggregateError` whose message is empty and whose
 * reasons are in `errors` — which reported `could not reach <url>: ` and
 * nothing after it.
 *
 * @param detail The underlying error.
 * @returns A non-empty reason, e.g. `connection refused (ECONNREFUSED: connect
 *   ECONNREFUSED ::1:3000; connect ECONNREFUSED 127.0.0.1:3000)`.
 * @throws Never.
 */
export function describeConnectionFailure(detail: unknown): string {
  if (!(detail instanceof Error)) return String(detail);

  const code = 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined;
  const nested =
    detail instanceof AggregateError
      ? detail.errors
          .map((inner: unknown) => (inner instanceof Error ? inner.message : String(inner)))
          .filter((message) => message !== '')
      : [];
  const specifics = [detail.message, ...nested].filter((message) => message !== '').join('; ');
  const meaning = code === undefined ? undefined : CONNECTION_FAILURES[code];

  if (meaning !== undefined) {
    return specifics === '' ? `${meaning} (${code ?? ''})` : `${meaning} (${specifics})`;
  }
  if (specifics !== '') return code === undefined ? specifics : `${code}: ${specifics}`;
  return code ?? `${detail.name} with no further detail`;
}
