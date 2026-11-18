import { CheckError, certificateRefusal } from './errors.js';

/**
 * Deciding whether a link that was requested is broken, or merely could not be
 * checked from here.
 *
 * Shared by `seo_audit` and `site_crawl` so that one link is never broken in
 * one tool and fine in the other. The line is drawn at what the site itself
 * said: a broken link goes into a client report as the site's defect, so only
 * an answer from the site, or a name or certificate that no visitor gets past,
 * may produce one. Everything that may be this side's fault — a deadline, a
 * dropped connection, a response the HTTP client would not parse — says
 * nothing about the link.
 */

/** What one requested link turned out to be. */
export type LinkVerdict =
  { kind: 'ok' } | { kind: 'broken'; reason: string } | { kind: 'unchecked'; reason: string };

/**
 * Socket codes that mean the name is gone for everyone, not just for this
 * server. `EAI_AGAIN` is a resolver that did not answer, and stays unchecked.
 */
const NAME_DOES_NOT_RESOLVE = new Set(['ENOTFOUND']);

/**
 * Judges a link by the status it answered with.
 *
 * @param status The HTTP status of the link's own response, redirects not followed.
 * @returns `broken` for an error status; `unchecked` for 408 and 429, which are
 *   the server declining to answer this client right now rather than the page
 *   being missing; `ok` otherwise.
 * @throws Never.
 */
export function judgeStatus(status: number): LinkVerdict {
  if (status === 408 || status === 429) {
    return { kind: 'unchecked', reason: `it answered ${String(status)}, asking to be asked later` };
  }
  return status >= 400
    ? { kind: 'broken', reason: `it answered ${String(status)}` }
    : { kind: 'ok' };
}

/**
 * Judges a link whose request failed before any status arrived.
 *
 * @param cause Whatever the request rejected with. Codes are looked for down its
 *   chain of causes, since `fetch` wraps them.
 * @param host The link's host, for the message.
 * @returns `broken` when the name does not resolve (a socket's `ENOTFOUND`, or
 *   a `not_found` {@link CheckError}) or browsers refuse the certificate; `unchecked`, with the failure's own message, for anything else.
 * @throws Never.
 */
export function judgeFailure(cause: unknown, host: string): LinkVerdict {
  const refusal = certificateRefusal(cause, host);
  if (refusal !== null) return { kind: 'broken', reason: `browsers will not open it: ${refusal}` };

  // The target guard resolves a name before anything is sent, and says so
  // with this code rather than with a socket's.
  if (cause instanceof CheckError && cause.code === 'not_found') {
    return { kind: 'broken', reason: cause.message };
  }

  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && NAME_DOES_NOT_RESOLVE.has(code)) {
      return { kind: 'broken', reason: `${host} does not resolve` };
    }
    current = current.cause;
  }

  return { kind: 'unchecked', reason: cause instanceof Error ? cause.message : String(cause) };
}
