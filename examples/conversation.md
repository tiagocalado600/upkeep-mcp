# A portfolio review, end to end

One session, captured on 2026-11-18 with version 0.7.0 against a five-site demo
portfolio. Every block marked _tool output_ is verbatim: the questions and the
replies around them are what the conversation looked like.

The portfolio is public demo infrastructure, never a client list. Two of the
sites are there because they are reliably broken, which is what makes the report
worth reading:

| Site in the report  | Actually            | Why                                         |
| ------------------- | ------------------- | ------------------------------------------- |
| Example Ltd         | `example.com`       | Reserved by IANA for documentation          |
| Example Foundation  | `example.org`       | The same, and the only site with nothing to act on |
| Example Net         | `example.net`       | The same                                    |
| Legacy Shop         | `expired.badssl.com` | A certificate that expired in 2015          |
| Campaign Microsite  | The W3C's [Before and After Demonstration](https://www.w3.org/WAI/demos/bad/before/home.html) | A page built to fail accessibility rules |

The five sites live in a portfolio file, `sites.json`:

```json
{
  "version": 1,
  "sites": [
    { "name": "Example Ltd", "url": "https://example.com", "checks": ["domain", "ssl", "uptime"], "tags": ["retainer"] },
    { "name": "Example Foundation", "url": "https://example.org", "checks": ["domain", "ssl"], "tags": ["retainer"] },
    { "name": "Example Net", "url": "https://example.net", "checks": ["uptime"], "tags": ["retainer"] },
    { "name": "Legacy Shop", "url": "https://expired.badssl.com", "checks": ["ssl", "uptime"], "tags": ["retainer"], "notes": "Old storefront, kept online for order history." },
    { "name": "Campaign Microsite", "url": "https://www.w3.org/WAI/demos/bad/before/home.html", "checks": ["uptime", "accessibility"], "tags": ["retainer"] }
  ]
}
```

A file rather than sites passed inline, because a file is what the server keeps
a history for. Sites passed inline keep none, so that one caller of a shared
server is never compared with another's run.

---

**You:** It is the first Monday of the quarter. Anything on the retainer list
that needs me this week?

**Claude:** Running the whole portfolio.

```json
{ "name": "portfolio_report", "arguments": { "file": "sites.json" } }
```

_Tool output:_

```
5 sites checked: 2 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [critical] Legacy Shop: The certificate expired 4238 days ago.
- [critical] Legacy Shop: The certificate chain does not verify: CERT_HAS_EXPIRED.
- [critical] Legacy Shop: Browsers will not open https://expired.badssl.com/: its certificate has expired. Visitors get a security warning instead of the site.
- [critical] Campaign Microsite: Images must have alternative text (33 elements, image-alt).
- [critical] Campaign Microsite: Select element must have an accessible name (1 element, select-name).
- [warning] Campaign Microsite: Links must have discernible text (7 elements, link-name).
- [warning] Campaign Microsite: Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast).
- [warning] Campaign Microsite: <html> element must have a lang attribute (1 element, html-has-lang).
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change is reported: this server has not run a report on this portfolio before, and the portfolio names no history file, so nothing survived the last restart.
History for this portfolio is kept in memory only. To compare across restarts, add a "history" path to the portfolio file.

Nothing to do: Example Foundation.
```

Two things are urgent and the rest is housekeeping.

Legacy Shop is serving a certificate that expired eleven years ago, so browsers
refuse to open the site at all: for visitors it is down. That is the one to fix
today.

Campaign Microsite fails five WCAG 2 AA rules, and 33 images with no alternative
text is the sort of thing that turns into a complaint rather than a ticket. It
is one page of work.

Example Ltd and Example Net both serve plain HTTP without redirecting to HTTPS
and send no HSTS header. Worth a line in the report, not worth an evening.

Example Foundation needs nothing.

---

**You:** What exactly is wrong with the Legacy Shop certificate?

**Claude:**

```json
{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }
```

_Tool output:_

```
expired.badssl.com:443 certificate expires 2015-04-12 (-4238 days).
Issued by COMODO RSA Domain Validation Secure Server CA.
Chain does not verify (CERT_HAS_EXPIRED). Negotiated TLSv1.2.
Host matched via *.badssl.com.
Revocation not established: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate.

Needs attention:
- [critical] The certificate expired 4238 days ago.
- [critical] The certificate chain does not verify: CERT_HAS_EXPIRED.
- [unknown] Revocation could not be checked: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate.
```

It is a wildcard certificate that does cover the host, issued by a CA that no
longer exists under that name, and it expired on 12 April 2015. Nothing is
misconfigured in a subtle way: renewal simply stopped happening. Whoever hosts
it needs to point an ACME client at it, or the site needs to come down.

---

**You:** I have asked the host to deal with it. While I wait — is anything
actually down right now?

**Claude:** That is the quick pass: uptime only, no certificates, no
registrations.

```json
{
  "name": "portfolio_report",
  "arguments": { "file": "sites.json", "checks": ["uptime"] }
}
```

_Tool output:_

```
5 sites checked: 1 critical, 3 warning, 0 unknown, 1 fine.

Needs action:
- [critical] Legacy Shop: Browsers will not open https://expired.badssl.com/: its certificate has expired. Visitors get a security warning instead of the site.
- [warning] Example Foundation: Plain HTTP does not redirect to HTTPS.
- [warning] Example Foundation: No Strict-Transport-Security header is sent.
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change since 2026-11-18T01:28:42.533Z (4 of 5 sites comparable; 1 of them measured different checks last time — run two full reports back to back to compare them; 3 only on the checks both runs measured, so what the others found is neither new nor resolved).

Still open from the last run:
- Legacy Shop: certificate_refused.
- Example Ltd: no_https_redirect, hsts_missing, csp_missing, nosniff_missing.
- Example Net: no_https_redirect, hsts_missing, csp_missing, nosniff_missing.

Nothing to do: Campaign Microsite.
```

One site is down: Legacy Shop. A certificate browsers refuse is an outage for
visitors, so even the uptime-only pass reports it as critical rather than as a
check that could not run.

The comparison line says what it did and what it could not do. This run looked
at uptime only, so most sites were compared only on the checks both runs
measured, and what the full run found about certificates and accessibility is
neither new nor resolved here. That is deliberate: comparing an uptime-only
pass against a full run would otherwise have announced that Legacy Shop's
expired certificate had been resolved, purely because this run never looked at
it.

Example Foundation picked up two warnings it did not show before. It did not
get worse — the first run never checked its uptime, which is why it is the one
site not compared at all.

---

**You:** The host says it is fixed. Run everything again before I write the
client note.

**Claude:**

```json
{ "name": "portfolio_report", "arguments": { "file": "sites.json" } }
```

_Tool output:_

```
5 sites checked: 2 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [critical] Legacy Shop: The certificate expired 4238 days ago.
- [critical] Legacy Shop: The certificate chain does not verify: CERT_HAS_EXPIRED.
- [critical] Legacy Shop: Browsers will not open https://expired.badssl.com/: its certificate has expired. Visitors get a security warning instead of the site.
- [critical] Campaign Microsite: Images must have alternative text (33 elements, image-alt).
- [critical] Campaign Microsite: Select element must have an accessible name (1 element, select-name).
- [warning] Campaign Microsite: Links must have discernible text (7 elements, link-name).
- [warning] Campaign Microsite: Elements must meet minimum color contrast ratio thresholds (2 elements, color-contrast).
- [warning] Campaign Microsite: <html> element must have a lang attribute (1 element, html-has-lang).
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change since 2026-11-18T01:28:42.533Z (5 of 5 sites comparable; 1 only on the checks both runs measured, so what the others found is neither new nor resolved).

Still open from the last run:
- Legacy Shop: cert_expired, chain_invalid, certificate_refused, revocation_check_failed.
- Campaign Microsite: a11y_image_alt, a11y_select_name, a11y_link_name, a11y_color_contrast, a11y_html_has_lang, a11y_needs_review.
- Example Ltd: no_https_redirect, hsts_missing, dmarc_no_reporting_address, csp_missing, nosniff_missing.
- Example Net: no_https_redirect, hsts_missing, csp_missing, nosniff_missing.
- Example Foundation: dmarc_no_reporting_address.

Nothing to do: Example Foundation.
```

It is not fixed. The same certificate, the same expiry date, still refused.

Note the date the comparison names: the first full run, not the uptime pass in
between. A narrower run keeps the wider results in place, so a quick pass between
two full reports does not take the full comparison away.

---

**You:** Fine. Draft the quarterly note for the client.

**Claude:** That is what the `quarterly_report` prompt is for — it runs the
portfolio and then writes the client-facing text, in a fixed order: one
paragraph up front, then what needs a decision from them with dates and
consequences, then what was found and handled, then a table of every site.
`format: "markdown"` on `portfolio_report` gives the same document without the
prompt.

In Claude Desktop or Claude Code it appears as a prompt named
**Quarterly maintenance report**, taking `period` (`"Q4 2026"`), optional `tags`
to limit it to part of the portfolio, optional `language`, and `baseline` and
`saveAs` to compare against a quarter saved under a name.

The instruction it carries is deliberately strict about one thing: write nothing
the report does not contain, and where a check could not run, say so. A report
that quietly omits Legacy Shop would read better and be worse.

---

## What this shows

- One call answers "what needs me this week?" across the whole portfolio, worst
  first, with the sites that need nothing named at the end.
- A certificate browsers refuse is reported as the outage it is, even by a pass
  that only asked whether sites are up.
- The comparison starts from nothing here because this portfolio names no
  history file, so the previous run lived in memory and would not survive a
  restart. Adding `"history": "upkeep-history.json"` to the portfolio file, and
  saving the quarter with `saveBaselineAs`, is what makes a quarter-over-quarter
  comparison possible. Without a file, `includeSnapshot` and `baselineSnapshot`
  keep the comparison on the caller's side.
- The comparison refuses to compare unlike runs, says how many sites it could
  compare and why the rest were left out, and never calls a finding resolved
  because a run did not look for it. See
  [`docs/adr/0022-baselines-chosen-for-a-quarter.md`](../docs/adr/0022-baselines-chosen-for-a-quarter.md).
- Nothing here needed a credential, and nothing was written to disk.
