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

No change is reported: sites passed inline keep no history, because nothing tells one caller's sites from another's and one server can serve many callers. To compare, ask for "includeSnapshot", keep the snapshot it returns, and pass it back as "baselineSnapshot"; or keep the portfolio in a file.

Nothing to do: Example Foundation.
```

Structured content:

```json
{
  "generatedAt": "2026-11-18T01:28:16.504Z",
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
    "previousRunUnavailable": "sites passed inline keep no history, because nothing tells one caller's sites from another's and one server can serve many callers. To compare, ask for \"includeSnapshot\", keep the snapshot it returns, and pass it back as \"baselineSnapshot\"; or keep the portfolio in a file",
    "historyKeptIn": "nowhere",
    "sitesCompared": 0,
    "sitesMeasuredDifferently": 0,
    "sitesPartlyCompared": 0,
    "sitesNotMeasured": 0,
    "sitesPastTheWindow": 0,
    "sitesNewSincePreviousRun": 0,
    "newSites": [],
    "regressed": [],
    "improved": [],
    "newFindings": [],
    "resolvedFindings": [],
    "persistingFindings": [],
    "unmeasuredFindings": [],
    "findingsPastTheWindow": [],
    "sitesDroppedSinceBaseline": [],
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
          "expiresAt": "2027-08-13T04:00:00.000Z",
          "remindDaysBefore": 30
        },
        {
          "kind": "certificate",
          "subject": "example.com",
          "expiresAt": "2026-12-25T22:56:35.000Z",
          "remindDaysBefore": 7
        }
      ],
      "notes": null,
      "severity": "warning",
      "soonestExpiryDays": 37,
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
          "headline": "example.com expires 2027-08-13 (268 days).",
          "error": null,
          "unmeasured": []
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.com:443 certificate expires 2026-12-25 (37 days).",
          "error": null,
          "unmeasured": [
            "cert_renewal_overdue",
            "caa_excludes_issuer"
          ]
        },
        {
          "check": "uptime",
          "ran": true,
          "severity": "warning",
          "headline": "https://example.com/ answered 200 in 31ms.",
          "error": null,
          "unmeasured": []
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
          "headline": "https://example.net/ answered 200 in 95ms.",
          "error": null,
          "unmeasured": []
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
          "expiresAt": "2027-08-30T04:00:00.000Z",
          "remindDaysBefore": 30
        },
        {
          "kind": "certificate",
          "subject": "example.org",
          "expiresAt": "2026-12-25T22:13:27.000Z",
          "remindDaysBefore": 7
        }
      ],
      "notes": null,
      "severity": "info",
      "soonestExpiryDays": 37,
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
          "headline": "example.org expires 2027-08-30 (285 days).",
          "error": null,
          "unmeasured": []
        },
        {
          "check": "ssl",
          "ran": true,
          "severity": "ok",
          "headline": "example.org:443 certificate expires 2026-12-25 (37 days).",
          "error": null,
          "unmeasured": [
            "cert_renewal_overdue",
            "caa_excludes_issuer"
          ]
        }
      ]
    }
  ]
}
```
