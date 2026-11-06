# portfolio_report

Call:

```json
{ "name": "portfolio_report", "arguments": { "sites": [ /* three public domains */ ] } }
```

Text returned to the conversation:

```
3 sites checked: 0 critical, 2 warning, 0 unknown, 1 fine.

Needs action:
- [warning] Example Ltd: Plain HTTP does not redirect to HTTPS.
- [warning] Example Ltd: No Strict-Transport-Security header is sent.
- [warning] Example Net: Plain HTTP does not redirect to HTTPS.
- [warning] Example Net: No Strict-Transport-Security header is sent.

No change is reported: this server has not run a report on this portfolio before, and the portfolio names no history file, so nothing survived the last restart.
History for this portfolio is kept in memory only. To compare across restarts, add a "history" path to the portfolio file.

Nothing to do: Example Foundation.
```

Structured content:

```json
{
  "generatedAt": "2026-11-06T02:21:35.520Z",
  "source": "inline",
  "file": null,
  "siteCount": 3,
  "severity": "warning",
  "summary": {
    "critical": 0,
    "warning": 2,
    "unknown": 0,
    "info": 1,
    "ok": 0
  },
  "needsAttention": [
    {
      "site": "Example Ltd",
      "url": "https://example.com/",
      "check": "uptime",
      "code": "no_https_redirect",
      "severity": "warning",
      "message": "Plain HTTP does not redirect to HTTPS.",
      "plain": "Visitors on the unencrypted address are not sent to the secure one.",
      "needsClient": false
    },
    {
      "site": "Example Ltd",
      "url": "https://example.com/",
      "check": "uptime",
      "code": "hsts_missing",
      "severity": "warning",
      "message": "No Strict-Transport-Security header is sent.",
      "plain": "Browsers are not told to always use the secure version of the site.",
      "needsClient": false
    },
    {
      "site": "Example Net",
      "url": "https://example.net/",
      "check": "uptime",
      "code": "no_https_redirect",
      "severity": "warning",
      "message": "Plain HTTP does not redirect to HTTPS.",
      "plain": "Visitors on the unencrypted address are not sent to the secure one.",
      "needsClient": false
    },
    {
      "site": "Example Net",
      "url": "https://example.net/",
      "check": "uptime",
      "code": "hsts_missing",
      "severity": "warning",
      "message": "No Strict-Transport-Security header is sent.",
      "plain": "Browsers are not told to always use the secure version of the site.",
      "needsClient": false
    }
  ],
  "changes": {
    "comparedWithPreviousRun": false,
    "previousRunAt": null,
    "previousRunUnavailable": "this server has not run a report on this portfolio before, and the portfolio names no history file, so nothing survived the last restart",
    "historyKeptIn": "memory",
    "sitesCompared": 0,
    "sitesMeasuredDifferently": 0,
    "sitesNewSincePreviousRun": 0,
    "regressed": [],
    "improved": [],
    "newFindings": [],
    "resolvedFindings": [],
    "persistingFindings": [],
    "comparedAgainst": "previous_run"
  },
  "savedBaseline": null,
  "snapshot": null,
  "notes": [],
  "sites": [
    {
      "name": "Example Ltd",
      "url": "https://example.com/",
      "domain": "example.com",
      "tags": [],
      "client": null,
      "renewals": [
        {
          "kind": "domain",
          "subject": "example.com",
          "expiresAt": "2027-08-13T04:00:00.000Z"
        },
        {
          "kind": "certificate",
          "subject": "example.com",
          "expiresAt": "2026-12-25T22:56:35.000Z"
        }
      ],
      "notes": null,
      "severity": "warning",
      "soonestExpiryDays": 49,
      "findings": [
        {
          "code": "no_https_redirect",
          "severity": "warning",
          "message": "Plain HTTP does not redirect to HTTPS.",
          "check": "uptime"
        },
        {
          "code": "hsts_missing",
          "severity": "warning",
          "message": "No Strict-Transport-Security header is sent.",
          "check": "uptime"
        },
        {
          "code": "dmarc_no_reporting_address",
          "severity": "info",
          "message": "DMARC publishes no \"rua\" address, so no reports arrive to show whether it is working.",
          "check": "domain"
        },
        {
          "code": "csp_missing",
          "severity": "info",
          "message": "No Content-Security-Policy header is sent.",
          "check": "uptime"
        },
        {
          "code": "nosniff_missing",
          "severity": "info",
          "message": "No X-Content-Type-Options: nosniff header is sent.",
          "check": "uptime"
        }
      ],
      "checks": [
        {
          "check": "domain",
          "ran": true,
          "severity": "info",
          "headline": "example.com expires 2027-08-13 (280 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.com:443 certificate expires 2026-12-25 (49 days).",
          "error": null
        },
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.com/ answered 200 in 18ms.",
          "error": null
        }
      ]
    },
    {
      "name": "Example Net",
      "url": "https://example.net/",
      "domain": "example.net",
      "tags": [],
      "client": null,
      "renewals": [],
      "notes": null,
      "severity": "warning",
      "soonestExpiryDays": null,
      "findings": [
        {
          "code": "no_https_redirect",
          "severity": "warning",
          "message": "Plain HTTP does not redirect to HTTPS.",
          "check": "uptime"
        },
        {
          "code": "hsts_missing",
          "severity": "warning",
          "message": "No Strict-Transport-Security header is sent.",
          "check": "uptime"
        },
        {
          "code": "csp_missing",
          "severity": "info",
          "message": "No Content-Security-Policy header is sent.",
          "check": "uptime"
        },
        {
          "code": "nosniff_missing",
          "severity": "info",
          "message": "No X-Content-Type-Options: nosniff header is sent.",
          "check": "uptime"
        }
      ],
      "checks": [
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.net/ answered 200 in 144ms.",
          "error": null
        }
      ]
    },
    {
      "name": "Example Foundation",
      "url": "https://example.org/",
      "domain": "example.org",
      "tags": [],
      "client": null,
      "renewals": [
        {
          "kind": "domain",
          "subject": "example.org",
          "expiresAt": "2027-08-30T04:00:00.000Z"
        },
        {
          "kind": "certificate",
          "subject": "example.org",
          "expiresAt": "2026-12-25T22:13:27.000Z"
        }
      ],
      "notes": null,
      "severity": "info",
      "soonestExpiryDays": 49,
      "findings": [
        {
          "code": "dmarc_no_reporting_address",
          "severity": "info",
          "message": "DMARC publishes no \"rua\" address, so no reports arrive to show whether it is working.",
          "check": "domain"
        }
      ],
      "checks": [
        {
          "check": "domain",
          "ran": true,
          "severity": "info",
          "headline": "example.org expires 2027-08-30 (297 days).",
          "error": null
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.org:443 certificate expires 2026-12-25 (49 days).",
          "error": null
        }
      ]
    }
  ]
}
```
