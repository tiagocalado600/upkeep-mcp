/**
 * Turning what a caller typed into a URL this project can request.
 *
 * Shared by `uptime_check`, `seo_audit`, `accessibility_audit` and the portfolio
 * reader, which all accept "example.com" as readily as
 * "https://example.com/pricing" because that is how a person names a site out
 * loud.
 */

/**
 * A scheme written at the start of the input, such as `ftp:` or `mailto:`.
 *
 * A host with a port, `example.com:8080`, looks the same up to the colon, and
 * dots are legal in a scheme, so what follows decides: a port is digits.
 */
const EXPLICIT_SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i;

/**
 * Schemes that carry an `@` of their own, which must not be mistaken for a
 * user name in front of a host when explaining a refusal.
 */
const NAMED_SCHEMES = new Set(['mailto', 'ftp', 'ftps', 'sftp', 'ssh', 'git', 'xmpp', 'sip']);

/**
 * Accepts a URL or a bare hostname.
 *
 * A bare hostname is tried over HTTPS: defaulting to plain HTTP would make
 * every such check report an upgrade redirect as though it were the site's real
 * behaviour. A URL that names any scheme other than `http` or `https` is
 * refused rather than prefixed: `ftp://example.com` would otherwise become
 * `https://ftp//example.com`, a request to a host called `ftp`.
 *
 * @param input Whatever the caller passed.
 * @returns The URL, or `null` when nothing usable could be made of it;
 *   {@link unusableUrlReason} says why.
 * @throws Never.
 */
export function normaliseUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const scheme = EXPLICIT_SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') return null;
  const candidate = scheme === undefined ? `https://${trimmed}` : trimmed;
  try {
    const url = new URL(candidate);
    return url.hostname === '' ? null : url;
  } catch {
    return null;
  }
}

/**
 * Why {@link normaliseUrl} refused an input, in words a caller can act on.
 *
 * @param input What was passed to {@link normaliseUrl}.
 * @returns A sentence fragment naming the problem, e.g.
 *   `"ftp://example.com" uses ftp:, and only http and https URLs can be checked`.
 * @throws Never.
 */
export function unusableUrlReason(input: string): string {
  const trimmed = input.trim();
  const scheme = EXPLICIT_SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') {
    // What precedes the colon is only a guess at a scheme. `user:pass@host`
    // and `example.com:` match the same pattern, and calling `user` or
    // `example.com` a scheme describes an input nobody wrote.
    const rest = trimmed.slice(scheme.length + 1);
    if (!NAMED_SCHEMES.has(scheme) && /^[^/?#]*@/.test(rest)) {
      return `"${input}" carries a user name and password, which this server never sends; pass the address without them`;
    }
    if (scheme.includes('.') || scheme === 'localhost') {
      const port = /^[^/?#]*/.exec(rest)?.[0] ?? '';
      return `"${input}" has "${port}" where a port number should be`;
    }
    return `"${input}" uses ${scheme}:, and only http and https URLs can be checked`;
  }
  return `"${input}" is not a usable URL`;
}
