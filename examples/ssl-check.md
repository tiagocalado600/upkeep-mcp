# ssl_check

Call:

```json
{ "name": "ssl_check", "arguments": { "domain": "expired.badssl.com" } }
```

Text returned to the conversation:

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

Structured content:

```json
{
  "host": "expired.badssl.com",
  "port": 443,
  "checkedAt": "2026-11-18T01:28:10.735Z",
  "severity": "critical",
  "findings": [
    {
      "code": "cert_expired",
      "severity": "critical",
      "message": "The certificate expired 4238 days ago."
    },
    {
      "code": "chain_invalid",
      "severity": "critical",
      "message": "The certificate chain does not verify: CERT_HAS_EXPIRED."
    },
    {
      "code": "revocation_check_failed",
      "severity": "unknown",
      "message": "Revocation could not be checked: http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate."
    }
  ],
  "expiresAt": "2015-04-12T23:59:59.000Z",
  "daysUntilExpiry": -4238,
  "issuedAt": "2015-04-09T00:00:00.000Z",
  "lifetimeDays": 3,
  "issuer": "COMODO RSA Domain Validation Secure Server CA",
  "subject": "*.badssl.com",
  "serialNumber": "4AE79549FA9ABE3F100F17A478E16909",
  "fingerprintSha256": "BA:10:5C:E0:2B:AC:76:88:8E:CE:E4:7C:D4:EB:79:41:65:3E:9A:C9:93:B6:1B:2E:B3:DC:C8:20:14:D2:1B:4F",
  "chain": {
    "valid": false,
    "error": "CERT_HAS_EXPIRED",
    "length": 3,
    "issuers": [
      "COMODO RSA Domain Validation Secure Server CA",
      "COMODO RSA Certification Authority",
      "AddTrust External CA Root"
    ],
    "revocationChecked": false
  },
  "revocation": {
    "checked": false,
    "status": null,
    "source": null,
    "responder": "http://ocsp.comodoca.com",
    "signatureVerified": false,
    "revokedAt": null,
    "reason": null,
    "producedAt": null,
    "nextUpdate": null,
    "unavailableReason": "http://ocsp.comodoca.com could not answer: the responder is not authorised to answer for this certificate"
  },
  "renewalInfo": {
    "checked": false,
    "windowStart": null,
    "windowEnd": null,
    "explanationUrl": null,
    "unavailableReason": "this server only asks Let's Encrypt, and the issuer is COMODO CA Limited"
  },
  "caaAllowsThisIssuer": null,
  "coverage": {
    "subjectAltName": "DNS:*.badssl.com, DNS:badssl.com",
    "coversRequestedHost": true,
    "matchedVia": "*.badssl.com",
    "coversApex": true,
    "coversWww": true,
    "wwwResolves": true,
    "sibling": null
  },
  "tls": {
    "protocol": "TLSv1.2",
    "cipher": "ECDHE-RSA-AES128-GCM-SHA256",
    "alpn": "http/1.1"
  }
}
```

# ssl_check on a revoked certificate whose chain still verifies

Call:

```json
{ "name": "ssl_check", "arguments": { "domain": "revoked-ecc-dv.ssl.com" } }
```

Text returned to the conversation:

```
revoked-ecc-dv.ssl.com:443 certificate expires 2026-12-24 (36 days).
Issued by SSL.com TLS Issuing ECC CA R2.
Chain verifies. Negotiated TLSv1.3.
Host matched via revoked-ecc-dv.ssl.com.
Revoked on 2026-06-09.

Needs attention:
- [critical] The certificate was revoked on 2026-06-09; browsers that check revocation will refuse the site.
- [info] This certificate is valid for 198 days, so it is probably renewed by hand. New public certificates are limited to 200 days, 100 from 2027-03-15 and 47 from 2029-03-15, so that renewal is worth automating.
```

Structured content:

```json
{
  "host": "revoked-ecc-dv.ssl.com",
  "port": 443,
  "checkedAt": "2026-11-18T01:28:13.366Z",
  "severity": "critical",
  "findings": [
    {
      "code": "cert_revoked",
      "severity": "critical",
      "message": "The certificate was revoked on 2026-06-09; browsers that check revocation will refuse the site."
    },
    {
      "code": "cert_long_lived",
      "severity": "info",
      "message": "This certificate is valid for 198 days, so it is probably renewed by hand. New public certificates are limited to 200 days, 100 from 2027-03-15 and 47 from 2029-03-15, so that renewal is worth automating."
    }
  ],
  "expiresAt": "2026-12-24T13:52:38.000Z",
  "daysUntilExpiry": 36,
  "issuedAt": "2026-06-09T13:52:38.000Z",
  "lifetimeDays": 198,
  "issuer": "SSL.com TLS Issuing ECC CA R2",
  "subject": "revoked-ecc-dv.ssl.com",
  "serialNumber": "2ECCEF07203B38C0A73A86B9E7C270AB",
  "fingerprintSha256": "38:D9:D1:25:40:8E:71:84:13:88:23:0D:02:7E:21:7E:08:5C:41:33:3C:28:5D:A0:0E:90:40:A1:35:3B:F8:56",
  "chain": {
    "valid": true,
    "error": null,
    "length": 4,
    "issuers": [
      "SSL.com TLS Issuing ECC CA R2",
      "SSL.com TLS ECC Root CA 2022",
      "SSL.com Root Certification Authority ECC",
      "SSL.com Root Certification Authority ECC"
    ],
    "revocationChecked": true
  },
  "revocation": {
    "checked": true,
    "status": "revoked",
    "source": "responder",
    "responder": "http://ocsps.ssl.com",
    "signatureVerified": true,
    "revokedAt": "2026-06-09T14:37:33.000Z",
    "reason": null,
    "producedAt": "2026-11-17T10:19:00.000Z",
    "nextUpdate": "2026-11-24T10:19:00.000Z",
    "unavailableReason": null
  },
  "renewalInfo": {
    "checked": false,
    "windowStart": null,
    "windowEnd": null,
    "explanationUrl": null,
    "unavailableReason": "this server only asks Let's Encrypt, and the issuer is SSL Corporation"
  },
  "caaAllowsThisIssuer": null,
  "coverage": {
    "subjectAltName": "DNS:revoked-ecc-dv.ssl.com, DNS:www.revoked-ecc-dv.ssl.com",
    "coversRequestedHost": true,
    "matchedVia": "revoked-ecc-dv.ssl.com",
    "coversApex": false,
    "coversWww": false,
    "wwwResolves": true,
    "sibling": null
  },
  "tls": {
    "protocol": "TLSv1.3",
    "cipher": "TLS_AES_128_GCM_SHA256",
    "alpn": "h2"
  }
}
```
