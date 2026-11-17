import { describe, expect, it } from 'vitest';
import { CheckError } from '../../src/lib/errors.js';
import { runSslCheck } from '../../src/tools/ssl-check.js';
import {
  NOW,
  fakePorts,
  findingCodes,
  goodRevocation,
  healthyDns,
  inspection,
  structured,
  text,
} from '../helpers/fake-ports.js';

describe('runSslCheck', () => {
  it('reports a healthy certificate with nothing to act on', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection(), dnsRecords: healthyDns() }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      host: 'example.com',
      port: 443,
      issuer: 'R11',
      daysUntilExpiry: 91,
      severity: 'ok',
    });
    expect(findingCodes(result)).toEqual([]);
  });

  it('reports a certificate its issuer says is fine, and says who said so', async () => {
    const result = await runSslCheck({ domain: 'example.com' }, fakePorts({ tls: inspection() }));

    expect(structured(result)['chain']).toMatchObject({ revocationChecked: true });
    expect(structured(result)['revocation']).toMatchObject({ checked: true, status: 'good' });
    expect(text(result)).toContain('Not revoked, per http://ocsp.example.net');
    expect(findingCodes(result)).toEqual([]);
  });

  it('calls a stapled answer what it is, since it cost no request', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ revocation: goodRevocation({ source: 'stapled', responder: null }) }),
    );

    expect(text(result)).toContain('stapled to the handshake');
  });

  it('reports a revoked certificate as critical, with the date and the reason', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        revocation: goodRevocation({
          status: 'revoked',
          revokedAt: '2026-06-09T14:37:38.000Z',
          reason: 'keyCompromise',
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['cert_revoked']);
    expect(structured(result)['severity']).toBe('critical');
    expect(text(result)).toContain('Revoked on 2026-06-09 (keyCompromise).');
  });

  it('will not call an unverified revocation conclusive', async () => {
    // An answer nobody can trace to the issuing authority is a claim, not a
    // fact — and the obvious way to fake one is to serve it yourself. It is
    // still reported, because it is the only claim anyone has made, but it does
    // not outrank a certificate that is genuinely expiring.
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        revocation: goodRevocation({
          status: 'revoked',
          checked: false,
          signatureVerified: false,
          revokedAt: '2026-06-09T14:37:38.000Z',
          reason: null,
          unavailableReason: "the answer's signature did not verify",
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['cert_revoked_unverified']);
    expect(structured(result)['severity']).toBe('warning');
    // The summary line used to say a flat "Revoked on …" here, contradicting the
    // finding printed under it.
    expect(text(result)).not.toContain('Revoked on');
    expect(text(result)).toContain(
      "Reported as revoked on 2026-06-09, but not conclusively: the answer's signature did not verify.",
    );
  });

  it('says nothing at all when the issuer publishes no responder', async () => {
    // The ordinary state of a healthy site since 2025: the two largest issuers
    // run no responder. A finding here would land on nearly every row of a
    // portfolio report, for something nobody can act on.
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        revocation: goodRevocation({
          checked: false,
          status: null,
          source: null,
          responder: null,
          signatureVerified: false,
          producedAt: null,
          nextUpdate: null,
          unavailableReason: 'the certificate names no OCSP responder',
        }),
      }),
    );

    expect(findingCodes(result)).toEqual([]);
    expect(structured(result)['severity']).toBe('ok');
    expect(text(result)).toContain('Revocation not established: the certificate names no OCSP');
  });

  it('surfaces a staple that was examined and refused, even with no responder', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        revocation: goodRevocation({
          checked: false,
          status: null,
          source: 'stapled',
          responder: null,
          signatureVerified: false,
          producedAt: null,
          nextUpdate: null,
          unavailableReason: 'the server stapled an answer that could not be used',
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['revocation_check_failed']);
  });

  it('surfaces a responder that was asked and would not answer', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        revocation: goodRevocation({
          checked: false,
          status: null,
          source: null,
          signatureVerified: false,
          producedAt: null,
          nextUpdate: null,
          unavailableReason: 'http://ocsp.example.net could not answer: HTTP 500',
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['revocation_check_failed']);
    expect(structured(result)['severity']).toBe('unknown');
  });

  it('uses the port it was given', async () => {
    const result = await runSslCheck(
      { domain: 'example.com', port: 8443 },
      fakePorts({ tls: inspection() }),
    );
    expect(structured(result)['port']).toBe(8443);
  });

  it('reports an expired certificate', async () => {
    const result = await runSslCheck(
      { domain: 'expired.example.com' },
      fakePorts({
        tls: inspection({
          leaf: { validTo: '2015-04-12T23:59:59.000Z' },
          chain: { valid: false, error: 'CERT_HAS_EXPIRED' },
          hostMatches: { 'expired.example.com': '*.example.com' },
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(expect.arrayContaining(['cert_expired', 'chain_invalid']));
    expect(structured(result)['severity']).toBe('critical');
  });

  it('leaves a certificate 24 days out alone, because that is a normal ACME renewal', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ leaf: { validTo: '2026-09-25T00:00:00.000Z' } }),
      }),
    );

    expect(structured(result)['daysUntilExpiry']).toBe(24);
    expect(findingCodes(result)).not.toContain('cert_expires_soon');
    expect(structured(result)['severity']).toBe('ok');
  });

  it('warns once the automatic renewal should already have happened', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ leaf: { validTo: '2026-09-12T00:00:00.000Z' } }),
      }),
    );

    expect(structured(result)['daysUntilExpiry']).toBe(11);
    expect(findingCodes(result)).toContain('cert_expires_soon');
    expect(structured(result)['severity']).toBe('warning');
  });

  it('reports an unreadable expiry date as unknown rather than as nothing wrong', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection({ leaf: { validTo: null } }) }),
    );

    expect(structured(result)['daysUntilExpiry']).toBeNull();
    expect(findingCodes(result)).toContain('cert_dates_unavailable');
    expect(structured(result)['severity']).toBe('unknown');
  });

  it('names a missing intermediate for what it is', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({ chain: { valid: false, error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }),
      }),
    );

    expect(findingCodes(result)).toContain('chain_invalid');
    expect(text(result)).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('describes a hostname mismatch once, and not as a broken chain', async () => {
    const result = await runSslCheck(
      { domain: 'wrong.example.com' },
      fakePorts({
        tls: inspection({
          chain: { valid: false, error: 'ERR_TLS_CERT_ALTNAME_INVALID' },
          hostMatches: { 'wrong.example.com': null, 'example.com': null, 'www.example.com': null },
        }),
      }),
    );

    expect(findingCodes(result)).toEqual(['host_not_covered']);
    expect(text(result)).toContain('verifies, but not for this hostname');
  });

  it('reports which SAN entry matched', async () => {
    const result = await runSslCheck(
      { domain: 'shop.example.com' },
      fakePorts({
        tls: inspection({ hostMatches: { 'shop.example.com': '*.example.com' } }),
      }),
    );

    expect(structured(result)['coverage']).toMatchObject({
      coversRequestedHost: true,
      matchedVia: '*.example.com',
    });
    expect(text(result)).toContain('matched via *.example.com');
  });

  describe('the sibling the certificate does not cover', () => {
    /** An apex certificate that leaves out www, as many CDNs issue. */
    const apexOnly = inspection({
      subjectAltName: 'DNS:example.com',
      hostMatches: { 'example.com': 'example.com', 'www.example.com': null },
    });
    /** What www serves when it has a certificate of its own. */
    const wwwOwn = inspection({
      subjectAltName: 'DNS:www.example.com',
      hostMatches: { 'www.example.com': 'www.example.com' },
    });

    it('says nothing when www serves a valid certificate of its own', async () => {
      // The false positive this replaced: the apex's SANs plus a DNS lookup said
      // "www is not covered" of sites that serve www from a second certificate,
      // and the portfolio report told clients their www address was broken.
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: apexOnly,
          tlsByHost: { 'www.example.com': wwwOwn },
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual([]);
      expect(structured(result)['coverage']).toMatchObject({
        coversWww: false,
        sibling: { host: 'www.example.com', outcome: 'valid', matchedVia: 'www.example.com' },
      });
    });

    it('warns when what www serves does not cover it either', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: apexOnly,
          tlsByHost: { 'www.example.com': apexOnly },
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual(['www_not_covered']);
      expect(text(result)).toContain('does not cover it either (DNS:example.com)');
    });

    it('warns when www serves a certificate for it that browsers reject', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: apexOnly,
          tlsByHost: {
            'www.example.com': inspection({
              hostMatches: { 'www.example.com': 'www.example.com' },
              chain: { valid: false, error: 'CERT_HAS_EXPIRED' },
            }),
          },
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual(['www_not_covered']);
      expect(text(result)).toContain('does not verify (CERT_HAS_EXPIRED)');
    });

    it('tells a refused connection to www apart from an invalid certificate', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: apexOnly,
          tlsByHost: {
            'www.example.com': new CheckError(
              'network',
              'could not complete a TLS handshake with www.example.com:443: connect ECONNREFUSED',
            ),
          },
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual(['www_https_failed']);
      expect(structured(result)['severity']).toBe('warning');
    });

    it('does not blame the site for a handshake with www that timed out', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: apexOnly,
          tlsByHost: {
            'www.example.com': new CheckError('timeout', 'TLS handshake timed out after 8s'),
          },
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual(['www_coverage_unjudged']);
      expect(structured(result)['severity']).toBe('unknown');
    });

    it('contacts nothing more when www does not resolve, or the certificate covers it', async () => {
      const contacted: string[] = [];
      const counting = (tls: ReturnType<typeof inspection>, wwwResolves: boolean) => {
        const ports = fakePorts({ tls, dnsRecords: healthyDns({ wwwResolves }) });
        const inspect = ports.tls.inspect.bind(ports.tls);
        ports.tls.inspect = (host, port, names) => {
          contacted.push(host);
          return inspect(host, port, names);
        };
        return ports;
      };

      const absent = await runSslCheck({ domain: 'example.com' }, counting(apexOnly, false));
      const covered = await runSslCheck({ domain: 'example.com' }, counting(inspection(), true));

      expect(findingCodes(absent)).toEqual([]);
      expect(findingCodes(covered)).toEqual([]);
      expect(contacted).toEqual(['example.com', 'example.com']);
      expect(structured(covered)['coverage']).toMatchObject({ sibling: null });
    });

    it('checks the apex from www the same way', async () => {
      const wwwOnly = inspection({
        subjectAltName: 'DNS:www.example.com',
        hostMatches: { 'www.example.com': 'www.example.com', 'example.com': null },
      });

      const ownCertificate = await runSslCheck(
        { domain: 'www.example.com' },
        fakePorts({
          tls: wwwOnly,
          tlsByHost: { 'example.com': inspection() },
          dnsRecords: healthyDns(),
        }),
      );
      expect(findingCodes(ownCertificate)).toEqual([]);

      const uncovered = await runSslCheck(
        { domain: 'www.example.com' },
        fakePorts({ tls: wwwOnly, dnsRecords: healthyDns() }),
      );
      expect(findingCodes(uncovered)).toEqual(['apex_not_covered']);

      const noApex = await runSslCheck(
        { domain: 'www.example.com' },
        fakePorts({ tls: wwwOnly, dnsRecords: healthyDns({ apexResolves: false }) }),
      );
      expect(findingCodes(noApex)).toEqual([]);
    });

    it('does not repeat host_not_covered as apex_not_covered when the apex was asked about', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: inspection({
            chain: { valid: false, error: 'ERR_TLS_CERT_ALTNAME_INVALID' },
            hostMatches: { 'example.com': null, 'www.example.com': 'www.example.com' },
          }),
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual(['host_not_covered']);
    });

    it('judges no sibling for a host that is neither the apex nor www', async () => {
      // What shop.example.com's certificate covers says nothing about what the
      // apex or www serve; those are their own checks.
      const result = await runSslCheck(
        { domain: 'shop.example.com' },
        fakePorts({
          tls: inspection({
            hostMatches: {
              'shop.example.com': 'shop.example.com',
              'example.com': null,
              'www.example.com': null,
            },
          }),
          dnsRecords: healthyDns(),
        }),
      );

      expect(findingCodes(result)).toEqual([]);
    });
  });

  it('warns about an outdated TLS version', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection({ protocol: 'TLSv1' }) }),
    );

    expect(findingCodes(result)).toContain('tls_version_outdated');
  });

  it('accepts TLS 1.2 and 1.3 without comment', async () => {
    for (const protocol of ['TLSv1.2', 'TLSv1.3']) {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({ tls: inspection({ protocol }) }),
      );
      expect(findingCodes(result)).not.toContain('tls_version_outdated');
    }
  });

  it('fails when the handshake cannot be completed at all', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: new CheckError('timeout', 'TLS handshake with example.com:443 timed out after 8s'),
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('timed out after 8s');
  });

  it('still reports the certificate when DNS is unavailable, without claiming www is absent', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({ tls: inspection(), dnsRecords: new CheckError('timeout', 'DNS timed out') }),
    );

    expect(result.isError).toBeFalsy();
    // Null, not false: a lookup that never answered established nothing.
    expect(structured(result)['coverage']).toMatchObject({ wwwResolves: null });
  });

  it('says it could not judge www coverage rather than passing the certificate', async () => {
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        // Covers the apex only. With DNS unavailable the old code read
        // wwwResolves as false, which switched the www check off and reported
        // a clean certificate.
        tls: inspection({
          subjectAltName: 'DNS:example.com',
          hostMatches: { 'example.com': 'example.com', 'www.example.com': null },
        }),
        dnsRecords: new CheckError('timeout', 'DNS timed out'),
      }),
    );

    expect(findingCodes(result)).toContain('www_coverage_unjudged');
    expect(structured(result)['severity']).toBe('unknown');
  });

  it('does not read an unanswered www address query as www not existing', async () => {
    // The lookup answered everything else, so it is not a failed lookup — but
    // the empty www address list it returned is not an answer either.
    const result = await runSslCheck(
      { domain: 'example.com' },
      fakePorts({
        tls: inspection({
          subjectAltName: 'DNS:example.com',
          hostMatches: { 'example.com': 'example.com', 'www.example.com': null },
        }),
        dnsRecords: healthyDns({
          wwwResolves: false,
          unanswered: [{ recordSet: 'wwwA', reason: 'the resolver returned SERVFAIL (ESERVFAIL)' }],
        }),
      }),
    );

    expect(structured(result)['coverage']).toMatchObject({ wwwResolves: null });
    expect(findingCodes(result)).toContain('www_coverage_unjudged');
  });

  it('rejects input that is not a host', async () => {
    const result = await runSslCheck({ domain: '' }, fakePorts());
    expect(result.isError).toBe(true);
  });

  describe("a window from the certificate's own lifetime", () => {
    const NOW_MS = NOW.getTime();
    const at = (days: number): string => new Date(NOW_MS + days * 86_400_000).toISOString();

    it.each([
      // lifetime, days left, expected worst severity
      [6, 5, 'ok'], // a short-lived certificate is not born critical
      [6, 2, 'ok'],
      [6, 1, 'warning'],
      [6, 0, 'critical'],
      [45, 8, 'ok'],
      [45, 7, 'warning'],
      [45, 4, 'critical'],
      [90, 15, 'ok'],
      [90, 14, 'warning'],
      [90, 7, 'critical'],
    ])('a %i-day certificate with %i days left is %s', async (lifetime, left, severity) => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: inspection({
            leaf: { validFrom: at(left - lifetime), validTo: at(left) },
          }),
        }),
      );

      expect(structured(result)['severity']).toBe(severity);
    });

    it('warns thirty days ahead on a certificate renewed by hand, and says so', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: inspection({ leaf: { validFrom: at(30 - 200), validTo: at(30) } }),
        }),
      );

      expect(structured(result)).toMatchObject({ severity: 'warning', lifetimeDays: 200 });
      expect(findingCodes(result)).toEqual(
        expect.arrayContaining(['cert_expires_soon', 'cert_long_lived']),
      );
    });

    it('falls back to the 90-day windows when the issue date cannot be read', async () => {
      const result = await runSslCheck(
        { domain: 'example.com' },
        fakePorts({
          tls: inspection({ leaf: { validFrom: null, validTo: at(14) } }),
        }),
      );

      expect(structured(result)).toMatchObject({ severity: 'warning', lifetimeDays: null });
    });
  });
});
