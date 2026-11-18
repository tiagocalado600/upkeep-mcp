# Security Policy

## Supported versions

`upkeep-mcp` is in early development. Fixes go to `main` and to the latest
minor release; older ones are not patched.

| Version        | Supported |
| -------------- | --------- |
| `main`         | ✅        |
| `0.7.x`        | ✅        |
| Anything older | ❌        |

## Reporting a vulnerability

Please report security issues privately, not in a public issue.

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**
(<https://github.com/tiagocalado600/upkeep-mcp/security/advisories/new>).

Include, as far as you can:

- what the issue is and why it matters,
- the steps or input needed to reproduce it,
- the affected file, tool or commit,
- any suggested fix.

You can expect an acknowledgement within 7 days and a fix or a decision within
30 days. If a report is valid you will be credited in the advisory, unless you
prefer otherwise.

## Threat model

This server is designed so that a compromise of it leaks nothing worth having.
The following are project rules, not aspirations — a feature that breaks one of
them does not get merged.

**It never handles credentials.** No API keys, no tokens, no passwords, for any
service, ever. There is nothing to steal from its configuration and nothing to
leak from its memory. A URL carrying a user name or password
(`https://user:pass@example.com`) is refused by every tool and in a portfolio,
without repeating it, and a redirect or link to one is not followed.

**It reads only public information.** Everything it inspects is what any person
with a browser or a DNS resolver could read: DNS records — including what each
of a domain's own nameservers answers about it, which is what any `dig
@ns1.example.com` does — RDAP registration data, TLS certificates presented by a
public endpoint, the revocation status their issuers publish, HTTP response
headers, and public page content. Registration data comes from RDAP only — there is no
WHOIS fallback, and
[`docs/adr/0004`](docs/adr/0004-rdap-without-whois.md) explains why.

**It tells you who else learns what you checked.** Running a check discloses the
target to whoever answers for it, which is unavoidable, so the list is short and
written down rather than left implicit:

| Contacted                        | What it learns                                | Why                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The target host itself           | That it was requested                         | `ssl_check`, `uptime_check`, `seo_audit`, `site_crawl` and `accessibility_audit` connect to it; `ssl_check` also to its `www` or bare-domain sibling when the certificate leaves that out |
| `data.iana.org`                  | Nothing about a domain                        | The RDAP bootstrap file, fetched at most once per process                                                                                                                                 |
| The registry's RDAP server       | The domain                                    | It is the registry for that domain and already holds the record                                                                                                                           |
| `cloudflare-dns.com`             | The domain                                    | `node:dns` cannot query DS or see validation, so DNSSEC is asked over DoH; also asked for CAA when the system resolver returns none                                                       |
| The certificate's OCSP responder | That certificate                              | Only its issuer can say whether it has been revoked; skipped when the server staples a current, verified answer                                                                           |
| Let's Encrypt's ACME server      | That certificate                              | Only its issuer publishes when it wants that certificate renewed; asked only for its own certificates                                                                                     |
| The domain's own nameservers     | The domain                                    | Only they can say whether they agree about the zone they are listed for; `domain_check` asks each for its SOA                                                                             |
| Whatever the audited page embeds | That the page was loaded, as from any visitor | `accessibility_audit` loads the page in a real browser, which fetches its scripts, fonts, images and analytics from wherever the page names                                               |

Nothing else is contacted, and this server sends no analytics or telemetry of
its own. The last row is the one this project does not choose: a browser audit
is only faithful if the page runs as it does for a visitor, so the third parties
the page itself calls — a tag manager, a font host, an analytics service — see
a page view from the audit. Every request, the browser's included, carries a
`User-Agent` naming this project and linking to it.

**It is not an offensive tool.** No port scanning, no subdomain
brute-forcing, no vulnerability probing, no attempt to bypass authentication or
access controls. It inspects public configuration and reports on it.

**A public instance contacts only the public internet.** Run locally, the tool
does what the person running it asks, including checking a staging box on their
own network. Run as a public endpoint it refuses any target resolving outside
public unicast space — loopback, private ranges, and the link-local address
where cloud metadata services live — and opens no port but three: 443, 80 for
the question of whether plain HTTP upgrades, and 53 for the domain's own
nameservers. That last one is not a caller's to point anywhere: the destination
is whatever the target domain's NS records name, resolved and put through the
same guard as every other target, and the question asked is the zone's SOA. Any
other port is refused, because an endpoint that connects anywhere on request is
a port scanner with someone else's name on it. The limits of that guard, including the one it does not close, are
in [`docs/adr/0012`](docs/adr/0012-public-target-guard.md).

**On a public instance, the browser is held to the same rule by a proxy, not
by trust in the page.** `accessibility_audit` runs a stranger's page, and that
page's JavaScript chooses what to connect to. Every connection the browser
opens — documents, subresources, WebSockets, from any frame or worker — goes
through a forward proxy on loopback that resolves the name once, refuses it if
any address is not public or the port is not 443 or 80, and connects to an
address it checked, so a name cannot answer differently for the browser than it
did for the check. Service workers are blocked and WebRTC may not send UDP. The
detail, and what was measured, is in
[`docs/adr/0013`](docs/adr/0013-playwright-core-and-an-optional-browser.md).

**It behaves politely on the network.** `robots.txt` is respected on any page
crawl, requests are rate-limited per host, concurrency is bounded, every network
operation has an explicit timeout, and the `User-Agent` identifies the tool with
a contact URL.

**It writes one file, and only if you ask for one.** Caching is in memory only,
with a TTL, and so is the comparison with the previous run of a portfolio file —
unless that file names a `history` path, in which case one snapshot of the last
run is written there and nowhere else. That file records which of your sites were
at which severity and the finding codes behind it, so it names your clients; it
is created readable by your account alone, replaced on every run, and ignored
once it is older than a hundred days. It also holds any baseline you saved under a
name, for up to 400 days. Under the name `sites.example.json`
documents, `upkeep-history.json`, it is in this repository's `.gitignore`
alongside `sites.json`; point `history` at a name of your own and adding it there
is yours to do. Leave the line out and nothing is written at
all. See
[`docs/adr/0018`](docs/adr/0018-opt-in-history-file.md). Sites passed inline,
which is the only way to call a hosted instance, keep no history at all, in memory
or anywhere else, so no caller is ever compared against, or shown, another
caller's run; a caller who wants a comparison holds the snapshot themselves
([`docs/adr/0022`](docs/adr/0022-baselines-chosen-for-a-quarter.md)). Beyond that
there is no database, and no record of what was checked survives the process. See
[`docs/adr/0005`](docs/adr/0005-in-memory-cache-no-database.md) and
[`docs/adr/0011`](docs/adr/0011-in-memory-run-history.md).

## Scope

In scope for a report:

- a way to make the server handle, store or transmit credentials,
- a way to make it act on a target beyond what its documented inputs allow
  (SSRF, request smuggling, unbounded redirect following),
- a crash, hang or resource exhaustion triggered by hostile input or a hostile
  remote host,
- leaking one user's data into another's results on a public HTTP instance,
  such as the hosted demo the README describes.

Out of scope:

- vulnerabilities in the sites you point the tools at — that is what they are
  for,
- missing hardening on a site reported by `uptime_check` or `seo_audit`,
- issues in third-party dependencies with no exploitable path through this
  code; report those upstream.
