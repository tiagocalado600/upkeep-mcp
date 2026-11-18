import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDurableHistory,
  createMemoryHistory,
  sealSnapshot,
  type RunHistory,
  type RunSnapshot,
} from '../../src/lib/history.js';
import { CHECK_NAMES, IMPLEMENTED_CHECKS, type CheckName } from '../../src/lib/portfolio.js';
import type { Ports } from '../../src/lib/ports.js';
import { EMPTY_ROBOTS } from '../../src/lib/robots.js';
import { runPortfolioReport } from '../../src/tools/portfolio-report.js';
import type { AxeRun } from '../../src/lib/axe.js';
import {
  NOW,
  axeRun,
  fakePorts,
  goodRevocation,
  healthyDns,
  inspection,
  notAskedRenewalInfo,
  registration,
  rememberingHistory,
  structured,
  text,
} from '../helpers/fake-ports.js';

/** How one site behaves, for a portfolio-sized fake. */
interface SiteFixture {
  /** Days until the certificate expires. `'unreachable'` fails the handshake. */
  cert?: number | 'unreachable';
  /** Days until the registration expires. */
  domainDays?: number;
  /** Status the site answers with. */
  status?: number;
}

/** A date `days` from the fixed test clock. */
function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000).toISOString();
}

/**
 * Ports that answer differently per host, which is what a portfolio needs and
 * the single-site fakes deliberately do not do.
 */
function portfolioPorts(
  fixtures: Record<string, SiteFixture>,
  options: { history?: RunHistory; files?: Record<string, string>; durable?: boolean } = {},
): Ports {
  const forHost = (host: string): SiteFixture => fixtures[host.replace(/^www\./, '')] ?? {};

  return {
    dns: {
      resolveRecords: () => Promise.resolve(healthyDns()),
      hasDsRecord: () => Promise.resolve(true),
      dnssecValidation: () => Promise.resolve('validated'),
      // A portfolio does not ask the nameservers: it would pay up to eight TCP
      // connections per site, and a deployment that cannot make them would
      // grade every site `unknown` — which outranks `info` and reorders the one
      // report whose job is to say what needs doing first. Rejecting here makes
      // that a fact the suite holds rather than a default nobody notices.
      nameservers: () => Promise.reject(new Error('portfolio_report must not query nameservers')),
    },
    rdap: {
      lookupDomain: (domain) => {
        const days = forHost(domain).domainDays ?? 300;
        return Promise.resolve({
          registration: registration({ expiresAt: inDays(days), daysUntilExpiry: days }),
          delegationSigned: true,
        });
      },
    },
    tls: {
      inspect: (host) => {
        const fixture = forHost(host);
        if (fixture.cert === 'unreachable') {
          return Promise.reject(new Error('handshake refused'));
        }
        const days = fixture.cert ?? 90;
        return Promise.resolve(
          inspection({
            leaf: { validTo: inDays(days) },
            hostMatches: {
              [host]: host,
              [host.replace(/^www\./, '')]: host,
              [`www.${host.replace(/^www\./, '')}`]: host,
            },
          }),
        );
      },
      revocation: () => Promise.resolve(goodRevocation()),
      renewalInfo: () => Promise.resolve(notAskedRenewalInfo()),
    },
    http: {
      hop: (url) => {
        const target = new URL(url);
        const status = forHost(target.hostname).status ?? 200;
        // A site with nothing wrong: uptime_check reports on missing security
        // headers, so a fixture without them would never come out clean.
        const headers = new Headers({
          'strict-transport-security': 'max-age=31536000',
          'content-security-policy': "default-src 'self'",
          'x-content-type-options': 'nosniff',
        });
        // Plain HTTP always upgrades, so the only uptime finding a fixture can
        // produce is the one it asked for.
        if (target.protocol === 'http:') {
          const https = `https://${target.host}${target.pathname}`;
          headers.set('location', https);
          return Promise.resolve({ url, status: 301, headers, location: https, elapsedMs: 5 });
        }
        return Promise.resolve({ url, status, headers, location: null, elapsedMs: 5 });
      },
      bytes: () => Promise.reject(new Error('no document fixtures in this portfolio')),
      text: () => Promise.reject(new Error('no document fixture')),
    },
    robots: {
      forOrigin: (origin) =>
        Promise.resolve({
          url: new URL('/robots.txt', origin).toString(),
          availability: 'absent' as const,
          status: 404,
          problem: null,
          robots: EMPTY_ROBOTS,
        }),
    },
    browser: {
      audit: () => Promise.reject(new Error('no browser fixture')),
    },
    files: {
      readText: (path) => {
        const contents = options.files?.[path];
        return contents === undefined
          ? Promise.reject(new Error(`there is no file at ${path}`))
          : Promise.resolve(contents);
      },
    },
    history:
      options.history ??
      (options.durable === true ? createDurableHistory() : createMemoryHistory()),
    now: () => NOW,
  };
}

/** One site's row in the report, typed so the assertions stay readable. */
interface ReportedSite {
  renewals: { kind: string }[];
  name: string;
  url: string;
  severity: string;
  soonestExpiryDays: number | null;
  notes: string | null;
  findings: { code: string; severity: string; check: string }[];
  checks: { check: string; ran: boolean; severity: string }[];
}

/**
 * @param result A report result.
 * @returns Its sites, in the order the report ranked them.
 */
function sitesOf(result: Awaited<ReturnType<typeof runPortfolioReport>>): ReportedSite[] {
  return structured(result)['sites'] as ReportedSite[];
}

const ALL_THREE: CheckName[] = ['domain', 'ssl', 'uptime'];

const HEALTHY = { name: 'Healthy Ltd', url: 'https://healthy.example', checks: ALL_THREE };
const URGENT = { name: 'Urgent Ltd', url: 'https://urgent.example', checks: ALL_THREE };
const TWO_SITES = [HEALTHY, URGENT];

describe('runPortfolioReport', () => {
  it('reports a portfolio with nothing wrong', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      source: 'inline',
      file: null,
      siteCount: 2,
      severity: 'ok',
      summary: { critical: 0, warning: 0, ok: 2 },
      needsAttention: [],
    });
    expect(text(result)).toContain('Nothing to do: Healthy Ltd, Urgent Ltd.');
  });

  it('puts the most urgent site first, whatever order the file lists them in', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES] },
      portfolioPorts({
        'healthy.example': {},
        'urgent.example': { status: 500, cert: 3 },
      }),
    );

    const sites = sitesOf(result);
    expect(sites[0]).toMatchObject({ name: 'Urgent Ltd', severity: 'critical' });
    expect(sites[1]).toMatchObject({ name: 'Healthy Ltd', severity: 'ok' });
    expect(structured(result)['severity']).toBe('critical');
  });

  it('orders two equally bad sites by whichever expires first', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          { name: 'Later', url: 'https://later.example', checks: ['ssl'] as CheckName[] },
          { name: 'Sooner', url: 'https://sooner.example', checks: ['ssl'] as CheckName[] },
        ],
      },
      portfolioPorts({ 'later.example': { cert: 12 }, 'sooner.example': { cert: 9 } }),
    );

    const sites = sitesOf(result);
    expect(sites.map((site) => site.name)).toEqual(['Sooner', 'Later']);
    expect(sites[0]?.soonestExpiryDays).toBe(9);
  });

  it('lists only what needs acting on, tagged with the check that found it', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Urgent Ltd',
            url: 'https://urgent.example',
            checks: ['ssl', 'uptime'] as CheckName[],
          },
        ],
      },
      portfolioPorts({ 'urgent.example': { cert: 3 } }),
    );

    expect(structured(result)['needsAttention']).toEqual([
      {
        site: 'Urgent Ltd',
        url: 'https://urgent.example/',
        check: 'ssl',
        code: 'cert_expires_soon',
        severity: 'critical',
        message: 'The certificate expires in 3 days.',
        plain: expect.any(String) as string,
        needsClient: expect.any(Boolean) as boolean,
      },
    ]);
  });

  it('turns a check that could not run into a finding, keeping the other checks', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Partial',
            url: 'https://partial.example',
            checks: ['ssl', 'uptime'] as CheckName[],
          },
        ],
      },
      portfolioPorts({ 'partial.example': { cert: 'unreachable' } }),
    );

    expect(result.isError).toBeFalsy();
    const site = sitesOf(result)[0];
    expect(site?.checks).toEqual([
      expect.objectContaining({ check: 'ssl', ran: false, severity: 'unknown' }),
      expect.objectContaining({ check: 'uptime', ran: true }),
    ]);
    expect(site?.findings.map((item) => item.code)).toEqual(['ssl_check_failed']);
  });

  it('keeps the report when a check throws something nobody anticipated', async () => {
    const ports = portfolioPorts({});
    const broken: Ports = {
      ...ports,
      tls: {
        ...ports.tls,
        // Stands in for whichever unexpected exception comes next. A malformed
        // result is the one way to reach past every catch inside the check.
        inspect: (host, port, names) =>
          host === 'broken.example'
            ? Promise.resolve(null as never)
            : ports.tls.inspect(host, port, names),
      },
    };

    const result = await runPortfolioReport(
      {
        sites: [
          { name: 'Broken', url: 'https://broken.example', checks: ['ssl'] as CheckName[] },
          { name: 'Healthy', url: 'https://healthy.example', checks: ['ssl'] as CheckName[] },
        ],
      },
      broken,
    );

    expect(result.isError).toBeFalsy();
    const sites = sitesOf(result);
    expect(sites.find((site) => site.name === 'Healthy')?.severity).toBe('ok');
    expect(sites.find((site) => site.name === 'Broken')?.findings.map((item) => item.code)).toEqual(
      ['ssl_check_failed'],
    );
  });

  it('still compares a full run against the full run before an uptime pass', async () => {
    const history = rememberingHistory();
    const sites = [
      { name: 'Site', url: 'https://site.example', checks: ['ssl', 'uptime'] as CheckName[] },
    ];

    await runPortfolioReport({ sites }, portfolioPorts({}, { history }));
    await runPortfolioReport(
      { sites, checks: ['uptime'] as CheckName[] },
      portfolioPorts({}, { history }),
    );
    const result = await runPortfolioReport(
      { sites },
      portfolioPorts({ 'site.example': { cert: 3 } }, { history }),
    );

    expect(structured(result)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      sitesCompared: 1,
      sitesMeasuredDifferently: 0,
      regressed: [expect.objectContaining({ site: 'Site' })],
    });
  });

  describe('reporting per client', () => {
    const sites = [
      {
        name: 'Bakery',
        url: 'https://bakery.example',
        client: 'Bakery Ltd',
        checks: ['ssl'] as CheckName[],
      },
      {
        name: 'Florist',
        url: 'https://florist.example',
        client: 'Florist Ltd',
        checks: ['ssl'] as CheckName[],
      },
    ];

    it('reports on one client, whatever the case', async () => {
      const result = await runPortfolioReport({ sites, client: 'bakery ltd' }, portfolioPorts({}));

      expect(sitesOf(result).map((site) => site.name)).toEqual(['Bakery']);
    });

    it('names the clients it knows when asked for one it does not', async () => {
      const result = await runPortfolioReport({ sites, client: 'Nobody' }, portfolioPorts({}));

      expect(result.isError).toBe(true);
      expect(text(result)).toContain('Bakery Ltd, Florist Ltd');
    });

    it('leaves the other clients in the baseline', async () => {
      const history = rememberingHistory();
      await runPortfolioReport({ sites }, portfolioPorts({}, { history }));
      await runPortfolioReport({ sites, client: 'Bakery Ltd' }, portfolioPorts({}, { history }));

      const result = await runPortfolioReport({ sites }, portfolioPorts({}, { history }));

      expect(structured(result)['changes']).toMatchObject({ sitesCompared: 2 });
    });

    it('writes a document for the client, keeping the structured result whole', async () => {
      const result = await runPortfolioReport(
        { sites, client: 'bakery ltd', format: 'markdown' },
        portfolioPorts({ 'bakery.example': { cert: 10 } }),
      );

      expect(text(result)).toContain('# Website maintenance: Bakery Ltd');
      expect(text(result)).toContain('security certificate is close to expiring');
      expect(sitesOf(result)[0]?.findings).not.toEqual([]);
      expect((structured(result)['needsAttention'] as unknown[])[0]).toMatchObject({
        code: 'cert_expires_soon',
        needsClient: false,
        plain: expect.stringContaining('security certificate') as string,
      });
    });

    it('gives a renewal calendar when asked', async () => {
      const result = await runPortfolioReport(
        {
          sites: [
            {
              name: 'Bakery',
              url: 'https://bakery.example',
              client: 'Bakery Ltd',
              checks: ['domain', 'ssl'] as CheckName[],
            },
          ],
          format: 'ical',
        },
        portfolioPorts({ 'bakery.example': { cert: 10, domainDays: 200 } }),
      );

      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('UID:domain-bakery.example@upkeep-mcp');
      expect(text(result)).toContain('UID:certificate-bakery.example@upkeep-mcp');
      expect(
        sitesOf(result)[0]
          ?.renewals.map((item) => item.kind)
          .sort(),
      ).toEqual(['certificate', 'domain']);
    });

    it('leaves an expired certificate out of the calendar, and says so beside it', async () => {
      const result = await runPortfolioReport(
        {
          sites: [
            {
              name: 'Bakery',
              url: 'https://bakery.example',
              client: 'Bakery Ltd',
              checks: ['domain', 'ssl'] as CheckName[],
            },
          ],
          format: 'ical',
        },
        portfolioPorts({ 'bakery.example': { cert: -3, domainDays: 200 } }),
      );

      const [calendar, beside] = result.content.map((block) =>
        block.type === 'text' ? block.text : '',
      );
      expect(calendar).toContain('UID:domain-bakery.example@upkeep-mcp');
      expect(calendar).not.toContain('UID:certificate-');
      expect(beside).toContain('Not in the calendar: the certificate for bakery.example');
      expect(beside).toContain('expired on');
      expect(structured(result)['notes']).toEqual([
        expect.stringContaining(
          'Not in the calendar: the certificate for bakery.example',
        ) as string,
      ]);
    });

    it('tells the client, and the calendar, when the domain renewal date is not known', async () => {
      const healthy = portfolioPorts({ 'bakery.example': { cert: 60 } });
      const undated: Ports = {
        ...healthy,
        rdap: {
          lookupDomain: () =>
            Promise.resolve({
              registration: registration({
                source: 'unavailable',
                expiresAt: null,
                daysUntilExpiry: null,
                unavailableReason: 'the registry for .example publishes no RDAP service',
              }),
              delegationSigned: true,
            }),
        },
      };
      const bakery = {
        name: 'Bakery',
        url: 'https://bakery.example',
        client: 'Bakery Ltd',
        checks: ['domain', 'ssl'] as CheckName[],
      };

      const markdown = text(
        await runPortfolioReport({ sites: [bakery], format: 'markdown' }, undated),
      );
      expect(markdown).toContain('| Bakery | Fine | In 60 days |');
      expect(markdown).toContain(
        'The domain renewal date is not known for Bakery, so "Next renewal" above does not include it',
      );

      const ical = await runPortfolioReport({ sites: [bakery], format: 'ical' }, undated);
      expect(text(ical)).not.toContain('UID:domain-');
      expect(ical.content.at(-1)).toMatchObject({
        text: expect.stringContaining(
          'Not in the calendar: the renewal date of the domain bakery.example (Bakery) is not published by its registry',
        ) as string,
      });
    });

    it('gives a spreadsheet when asked', async () => {
      const result = await runPortfolioReport(
        { sites, format: 'csv' },
        portfolioPorts({ 'bakery.example': { cert: 10 } }),
      );

      expect(text(result).split('\r\n')[0]).toContain('client,site,url');
      expect(text(result)).toContain('Bakery Ltd,Bakery,');
    });

    it("leaves each site's detail out of a concise result, and the summary in", async () => {
      const full = await runPortfolioReport(
        { sites },
        portfolioPorts({ 'bakery.example': { cert: 10 } }),
      );
      const concise = await runPortfolioReport(
        { sites, format: 'concise' },
        portfolioPorts({ 'bakery.example': { cert: 10 } }),
      );

      expect(text(concise)).toBe(text(full));
      expect(sitesOf(concise)[0]?.findings).toEqual([]);
      expect(sitesOf(concise)[0]?.checks).toEqual([]);
      expect(structured(concise)['needsAttention']).toEqual(structured(full)['needsAttention']);
      expect(JSON.stringify(structured(concise)).length).toBeLessThan(
        JSON.stringify(structured(full)).length,
      );
    });
  });

  describe('comparing against a chosen moment', () => {
    const sites = [
      { name: 'Site', url: 'https://site.example', checks: ['ssl', 'uptime'] as CheckName[] },
    ];

    it('compares with a snapshot the caller kept, storing nothing, as a hosted instance must', async () => {
      const kept = structured(
        await runPortfolioReport(
          { sites, includeSnapshot: true },
          portfolioPorts({ 'site.example': { cert: 3 } }),
        ),
      )['snapshot'] as Record<string, unknown>;

      // A fresh history stands in for a restarted instance that remembers nothing.
      const later = await runPortfolioReport({ sites, baselineSnapshot: kept }, portfolioPorts({}));

      const changes = structured(later)['changes'] as Record<string, unknown>;
      expect(changes).toMatchObject({
        comparedWithPreviousRun: true,
        comparedAgainst: 'supplied_snapshot',
        improved: [expect.objectContaining({ site: 'Site' })],
        resolvedFindings: [{ site: 'Site', code: 'cert_expires_soon', actionable: true }],
      });
      expect(text(later)).toContain('resolved since the baseline — cert_expires_soon');
    });

    it('does not call a finding resolved because the check that found it failed', async () => {
      const history = rememberingHistory();
      await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 10 } }, { history }),
      );

      const failed = await runPortfolioReport(
        { sites, format: 'markdown' },
        portfolioPorts({ 'site.example': { cert: 'unreachable' } }, { history }),
      );

      expect(structured(failed)['changes']).toMatchObject({
        resolvedFindings: [],
        sitesCompared: 1,
        sitesPartlyCompared: 1,
      });
      expect(text(failed)).not.toContain('**Resolved:**');

      // And what the failed check last measured is still there to compare with.
      const recovered = await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 10 } }, { history }),
      );
      expect(structured(recovered)['changes']).toMatchObject({
        sitesPartlyCompared: 0,
        persistingFindings: [{ site: 'Site', code: 'cert_expires_soon' }],
      });
    });

    it('says a site could not be measured, not that it measured something else', async () => {
      const history = rememberingHistory();
      const certOnly = [
        { name: 'Site', url: 'https://site.example', checks: ['ssl'] as CheckName[] },
      ];
      await runPortfolioReport({ sites: certOnly }, portfolioPorts({}, { history }));

      const result = await runPortfolioReport(
        { sites: certOnly },
        portfolioPorts({ 'site.example': { cert: 'unreachable' } }, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({
        sitesNotMeasured: 1,
        sitesMeasuredDifferently: 0,
        resolvedFindings: [],
      });
    });

    it('does not call an expiring domain resolved because the registry did not answer', async () => {
      const history = rememberingHistory();
      const domainOnly = [
        {
          name: 'Site',
          url: 'https://site.example',
          client: 'Site Ltd',
          checks: ['domain'] as CheckName[],
        },
      ];
      await runPortfolioReport(
        { sites: domainOnly },
        portfolioPorts({ 'site.example': { domainDays: 5 } }, { history }),
      );

      const healthy = portfolioPorts({}, { history });
      const outage: Ports = {
        ...healthy,
        rdap: { lookupDomain: () => Promise.reject(new Error('rdap timed out after 10s')) },
      };
      const result = await runPortfolioReport({ sites: domainOnly, format: 'markdown' }, outage);

      expect(sitesOf(result)[0]?.checks[0]).toMatchObject({
        ran: true,
        unmeasured: expect.arrayContaining(['domain_expires_soon']) as string[],
      });
      expect(structured(result)['changes']).toMatchObject({
        resolvedFindings: [],
        unmeasuredFindings: [{ site: 'Site', code: 'domain_expires_soon', actionable: true }],
        improved: [],
      });
      expect(text(result)).not.toContain('**Resolved:**');
      expect(text(result)).toContain('**Could not be checked again this time:**');

      // And when the registry answers again, the expiry is still open rather than new.
      const recovered = await runPortfolioReport(
        { sites: domainOnly },
        portfolioPorts({ 'site.example': { domainDays: 4 } }, { history }),
      );
      expect(structured(recovered)['changes']).toMatchObject({
        newFindings: [],
        persistingFindings: [{ site: 'Site', code: 'domain_expires_soon' }],
      });
    });

    it('does not call an seo finding resolved because robots.txt could not be read', async () => {
      const history = rememberingHistory();
      const seoOnly = [
        { name: 'Site', url: 'https://site.example/', checks: ['seo'] as CheckName[] },
      ];
      const html = '<html><head></head><body><p>hi</p></body></html>';
      await runPortfolioReport(
        { sites: seoOnly },
        fakePorts({ history, documents: { 'https://site.example/': { status: 200, body: html } } }),
      );

      const result = await runPortfolioReport(
        { sites: seoOnly, format: 'markdown' },
        fakePorts({ history, robots: 'unreachable' }),
      );

      const changes = structured(result)['changes'] as Record<string, { code: string }[]>;
      expect(changes['resolvedFindings']).toEqual([]);
      expect(changes['unmeasuredFindings']?.map((item) => item.code)).toEqual(
        expect.arrayContaining(['title_missing', 'h1_missing', 'robots_txt_absent']) as string[],
      );
      expect(text(result)).not.toContain('**Resolved:**');
    });

    it.each([
      ['robots.txt could not be read', { robots: 'unreachable' as const }],
      ['robots.txt forbids the page', { robots: 'User-agent: *\nDisallow: /' }],
      ['the page answered an error', { axe: axeRun({ status: 500 }) }],
    ])('does not call an accessibility violation resolved because %s', async (_, options) => {
      const history = rememberingHistory();
      const a11yOnly = [
        { name: 'Site', url: 'https://site.example/', checks: ['accessibility'] as CheckName[] },
      ];
      const violation = { id: 'color-contrast', impact: 'serious', help: 'Contrast', nodeCount: 3 };
      await runPortfolioReport(
        { sites: a11yOnly },
        fakePorts({ history, axe: axeRun({ violations: [violation] as AxeRun['violations'] }) }),
      );

      const result = await runPortfolioReport(
        { sites: a11yOnly },
        fakePorts({ history, axe: axeRun(), ...options }),
      );

      expect(structured(result)['changes']).toMatchObject({
        resolvedFindings: [],
        unmeasuredFindings: [{ site: 'Site', code: 'a11y_color_contrast', actionable: true }],
      });
    });

    it('carries a finding it could not measure again at its own severity', async () => {
      const history = rememberingHistory();
      const domainOnly = [
        { name: 'Site', url: 'https://site.example', checks: ['domain'] as CheckName[] },
      ];
      const run = (n: number, domainDays: number, txtUnanswered: boolean): Ports => {
        const ports = portfolioPorts({ 'site.example': { domainDays } }, { history });
        return {
          ...ports,
          now: () => new Date(NOW.getTime() + n * 86_400_000),
          dns: {
            ...ports.dns,
            resolveRecords: () =>
              Promise.resolve(
                healthyDns({
                  txt: [],
                  unanswered: txtUnanswered
                    ? [{ recordSet: 'txt', reason: 'the resolver refused the connection' }]
                    : [],
                }),
              ),
          },
        };
      };
      // Expired (critical), and no SPF (informational).
      await runPortfolioReport({ sites: domainOnly }, run(0, -3, false));

      // Renewed, and TXT unanswered: the SPF line is carried, not the expiry's critical.
      const renewed = await runPortfolioReport(
        { sites: domainOnly, includeSnapshot: true },
        run(7, 360, true),
      );
      expect(structured(renewed)['changes']).toMatchObject({
        resolvedFindings: expect.arrayContaining([
          { site: 'Site', code: 'domain_expired', actionable: true },
        ]) as unknown[],
        unmeasuredFindings: [{ site: 'Site', code: 'spf_not_published', actionable: false }],
        improved: [{ site: 'Site', from: 'critical', to: 'unknown' }],
      });
      const kept = structured(renewed)['snapshot'] as RunSnapshot;
      expect(Object.values(kept.sites)[0]?.byCheck?.domain?.severity).toBe('unknown');

      await runPortfolioReport({ sites: domainOnly }, run(14, 353, true));
      const answered = await runPortfolioReport({ sites: domainOnly }, run(21, 346, false));
      expect(structured(answered)['changes']).toMatchObject({
        improved: [{ site: 'Site', from: 'unknown', to: 'info' }],
        persistingFindings: expect.arrayContaining([
          { site: 'Site', code: 'spf_not_published' },
        ]) as unknown[],
      });
    });

    it('dates a finding carried unmeasured from when it was found, and lets it expire', async () => {
      const history = rememberingHistory();
      const domainOnly = [
        { name: 'Site', url: 'https://site.example', checks: ['domain'] as CheckName[] },
      ];
      const day = (n: number): Date => new Date(NOW.getTime() + n * 86_400_000);
      const at = (n: number, rdapFails: boolean): Ports => {
        const ports = portfolioPorts({ 'site.example': { domainDays: 20 } }, { history });
        return {
          ...ports,
          now: () => day(n),
          ...(rdapFails
            ? {
                rdap: { lookupDomain: () => Promise.reject(new Error('rdap timed out after 10s')) },
              }
            : {}),
        };
      };
      await runPortfolioReport({ sites: domainOnly }, at(0, false));

      let result = await runPortfolioReport({ sites: domainOnly }, at(7, true));
      for (let n = 14; n <= 98; n += 7) {
        result = await runPortfolioReport({ sites: domainOnly }, at(n, true));
      }
      expect(structured(result)['changes']).toMatchObject({
        unmeasuredFindings: [{ site: 'Site', code: 'domain_expires_soon' }],
        previousRunAt: NOW.toISOString(),
        findingsPastTheWindow: [],
      });

      result = await runPortfolioReport(
        { sites: domainOnly, format: 'markdown', includeSnapshot: true },
        at(105, true),
      );
      expect(structured(result)['changes']).toMatchObject({
        unmeasuredFindings: [],
        resolvedFindings: [],
        findingsPastTheWindow: [
          {
            site: 'Site',
            code: 'domain_expires_soon',
            actionable: true,
            lastMeasuredAt: NOW.toISOString(),
          },
        ],
      });
      expect(text(result)).toContain('**Not checked for too long, so to be confirmed by hand:**');
      expect(JSON.stringify(structured(result)['snapshot'])).not.toContain('domain_expires_soon');

      const full = await runPortfolioReport({ sites: domainOnly }, at(106, true));
      expect(text(full)).not.toContain('domain_expires_soon');
    });

    it('does not call a revoked certificate resolved because revocation could not be checked', async () => {
      const history = rememberingHistory();
      const certOnly = [
        { name: 'Site', url: 'https://site.example', checks: ['ssl'] as CheckName[] },
      ];
      const revoked = portfolioPorts({}, { history });
      await runPortfolioReport(
        { sites: certOnly },
        {
          ...revoked,
          tls: {
            ...revoked.tls,
            revocation: () =>
              Promise.resolve(goodRevocation({ status: 'revoked', revokedAt: NOW.toISOString() })),
          },
        },
      );

      const silent = portfolioPorts({}, { history });
      const result = await runPortfolioReport(
        { sites: certOnly },
        {
          ...silent,
          tls: {
            ...silent.tls,
            revocation: () =>
              Promise.resolve(
                goodRevocation({
                  checked: false,
                  status: null,
                  unavailableReason: 'the responder timed out after 10s',
                }),
              ),
          },
        },
      );

      expect(structured(result)['changes']).toMatchObject({
        resolvedFindings: [],
        unmeasuredFindings: [{ site: 'Site', code: 'cert_revoked', actionable: true }],
        improved: [],
      });
    });

    it('names a site the baseline had and this run does not, with what it last had', async () => {
      const history = rememberingHistory();
      const fixtures = { 'healthy.example': {}, 'urgent.example': { domainDays: 5 } };
      await runPortfolioReport({ sites: [...TWO_SITES] }, portfolioPorts(fixtures, { history }));

      const result = await runPortfolioReport(
        { sites: [HEALTHY], format: 'markdown' },
        portfolioPorts(fixtures, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({
        sitesDroppedSinceBaseline: [
          {
            site: 'Urgent Ltd',
            url: 'https://urgent.example/',
            findings: ['domain_expires_soon'],
          },
        ],
      });
      expect(text(result)).toContain('**No longer checked:**');
      expect(text(result)).toContain('Urgent Ltd');

      const plain = await runPortfolioReport(
        { sites: [HEALTHY] },
        portfolioPorts(fixtures, { history: createMemoryHistory() }),
      );
      expect(text(plain)).not.toContain('No longer');
    });

    it('does not name the sites a client or tag filter left out as dropped', async () => {
      const history = rememberingHistory();
      const clients = [
        { ...HEALTHY, client: 'Healthy' },
        { ...URGENT, client: 'Urgent' },
      ];
      await runPortfolioReport({ sites: clients }, portfolioPorts({}, { history }));

      const result = await runPortfolioReport(
        { sites: clients, client: 'Healthy', format: 'markdown' },
        portfolioPorts({}, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({ sitesDroppedSinceBaseline: [] });
      expect(text(result)).not.toContain('Urgent');
    });

    it('calls a site never measured new, not measured too long ago', async () => {
      const history = rememberingHistory();
      const certOnly = [
        { name: 'Site', url: 'https://site.example', checks: ['ssl'] as CheckName[] },
      ];
      await runPortfolioReport(
        { sites: certOnly },
        portfolioPorts({ 'site.example': { cert: 'unreachable' } }, { history }),
      );

      const result = await runPortfolioReport({ sites: certOnly }, portfolioPorts({}, { history }));

      expect(structured(result)['changes']).toMatchObject({
        sitesPastTheWindow: 0,
        sitesNewSincePreviousRun: 1,
      });
      expect(text(result)).not.toContain('too long ago');
    });

    it('does not call a failing check resolved against a file from an older version', async () => {
      const key = 'Site\u0000https://site.example/';
      const older: RunHistory = {
        ...createMemoryHistory(),
        previous: () =>
          Promise.resolve({
            snapshot: {
              takenAt: NOW.toISOString(),
              sites: {
                [key]: {
                  severity: 'unknown',
                  codes: ['ssl_check_failed'],
                  checks: ['uptime'],
                },
              },
            },
            unavailableReason: null,
          }),
      };

      const result = await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 'unreachable' } }, { history: older }),
      );

      expect(structured(result)['changes']).toMatchObject({ resolvedFindings: [] });
    });

    it('still reports what the other checks found when one of them fails', async () => {
      // A site going down is the usual reason the rest fail, and the worst thing to omit.
      const history = rememberingHistory();
      await runPortfolioReport({ sites }, portfolioPorts({}, { history }));

      const result = await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 'unreachable', status: 500 } }, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({
        regressed: [{ site: 'Site', to: 'critical' }],
        newFindings: [{ site: 'Site', code: 'server_error' }],
        resolvedFindings: [],
      });
    });

    it('lists what is still open separately from what is new', async () => {
      const history = rememberingHistory();
      await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 10 } }, { history }),
      );

      const result = await runPortfolioReport(
        { sites },
        portfolioPorts({ 'site.example': { cert: 10, status: 500 } }, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({
        persistingFindings: [{ site: 'Site', code: 'cert_expires_soon' }],
        newFindings: [{ site: 'Site', code: 'server_error' }],
      });
      expect(text(result)).toContain('Still open from the last run:');
    });

    it('does not quietly compare with the last run when the baseline asked for is missing', async () => {
      const history = rememberingHistory();
      await runPortfolioReport({ sites }, portfolioPorts({}, { history }));

      const result = await runPortfolioReport(
        { sites, baselineName: '2026-Q3' },
        portfolioPorts({}, { history }),
      );

      expect(structured(result)['changes']).toMatchObject({
        comparedWithPreviousRun: false,
        comparedAgainst: 'named_baseline',
        previousRunUnavailable: expect.stringContaining('history') as string,
      });
    });

    it('says that a new finding may only be new to this version', async () => {
      const kept = structured(
        await runPortfolioReport({ sites, includeSnapshot: true }, portfolioPorts({})),
      )['snapshot'] as Record<string, unknown>;
      const { sites: keptSites } = kept as unknown as RunSnapshot;
      const fromAnotherVersion = {
        ...sealSnapshot({
          ...(kept as unknown as RunSnapshot),
          sites: Object.fromEntries(
            Object.entries(keptSites).map(([key, outcome]) => [
              key,
              { ...outcome, serverVersion: '0.0.1' },
            ]),
          ),
        }),
      };

      const result = await runPortfolioReport(
        { sites, baselineSnapshot: fromAnotherVersion },
        portfolioPorts({}),
      );

      expect(text(result)).toContain('version 0.0.1');
    });

    it('names no saved baseline when it could not save one, and says why', async () => {
      const result = await runPortfolioReport(
        { sites, saveBaselineAs: '2026-Q4' },
        portfolioPorts({}),
      );

      expect(structured(result)['savedBaseline']).toBeNull();
      expect(text(result)).toContain('includeSnapshot');
    });

    it('returns no snapshot unless asked', async () => {
      const result = await runPortfolioReport({ sites }, portfolioPorts({}));

      expect(structured(result)['snapshot']).toBeNull();
    });
  });

  it('calls a site browsers refuse down in an uptime-only pass', async () => {
    const healthy = portfolioPorts({});
    const expired = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    const result = await runPortfolioReport(
      { sites: [HEALTHY], checks: ['uptime'] as CheckName[] },
      {
        ...healthy,
        http: {
          ...healthy.http,
          hop: () => Promise.reject(new TypeError('fetch failed', { cause: expired })),
        },
      },
    );

    expect(structured(result)).toMatchObject({ severity: 'critical' });
    expect(sitesOf(result)[0]?.findings).toEqual([
      expect.objectContaining({ code: 'certificate_refused', severity: 'critical' }),
    ]);
  });

  it('runs only the checks the caller asked for', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], checks: ['uptime'] as CheckName[] },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }),
    );

    const sites = sitesOf(result);
    expect(sites.every((site) => site.checks.every((check) => check.check === 'uptime'))).toBe(
      true,
    );
  });

  it('reports on part of the portfolio when given tags', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Kept',
            url: 'https://kept.example',
            tags: ['Retainer'],
            checks: ['uptime'] as CheckName[],
          },
          {
            name: 'Dropped',
            url: 'https://dropped.example',
            tags: ['legacy'],
            checks: ['uptime'] as CheckName[],
          },
        ],
        tags: ['retainer'],
      },
      portfolioPorts({}),
    );

    expect(structured(result)['siteCount']).toBe(1);
    expect(sitesOf(result)[0]?.name).toBe('Kept');
  });

  it('says so when a tag matches nothing, rather than reporting an empty portfolio', async () => {
    const result = await runPortfolioReport(
      { sites: [...TWO_SITES], tags: ['nonexistent'] },
      portfolioPorts({}),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('nonexistent');
  });

  it('implements every check the portfolio format accepts', () => {
    // While these two lists agree, no site can ask for something that is
    // silently skipped. When they next diverge — a sixth check named before it
    // is built — the report says so in its notes rather than dropping it.
    expect([...IMPLEMENTED_CHECKS].sort()).toEqual([...CHECK_NAMES].sort());
  });

  it('reads the portfolio from a file when given no sites inline', async () => {
    const file = JSON.stringify({
      version: 1,
      defaults: { checks: ['uptime'] as CheckName[] },
      sites: [{ name: 'From file', url: 'https://filed.example' }],
    });

    const result = await runPortfolioReport(
      {},
      portfolioPorts({}, { files: { 'sites.json': file } }),
    );

    expect(structured(result)).toMatchObject({ source: 'file', file: 'sites.json', siteCount: 1 });
  });

  it('tells the caller how to fix a missing portfolio file', async () => {
    const result = await runPortfolioReport({}, portfolioPorts({}));

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('sites.example.json');
  });

  it('reports an unusable portfolio file as invalid input, naming the file', async () => {
    const result = await runPortfolioReport(
      { file: 'broken.json' },
      portfolioPorts({}, { files: { 'broken.json': '{ oops' } }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
    expect(text(result)).toContain('broken.json');
  });

  it('has nothing to compare against on the first run, and says so', async () => {
    const result = await runPortfolioReport(
      { file: 'sites.json' },
      portfolioPorts(
        { 'healthy.example': {}, 'urgent.example': {} },
        { files: { 'sites.json': JSON.stringify({ version: 1, sites: TWO_SITES }) } },
      ),
    );

    expect(structured(result)['changes']).toMatchObject({
      comparedWithPreviousRun: false,
      previousRunAt: null,
      historyKeptIn: 'memory',
      sitesCompared: 0,
      regressed: [],
    });
    // An empty list of regressions must never read as "nothing regressed", and
    // the reason has to be the real one rather than a shape the reader has to
    // guess at.
    expect(text(result)).toContain('nothing survived the last restart');
    expect(text(result)).toContain('add a "history" path to the portfolio file');
  });

  describe('an inline portfolio', () => {
    // One process serves every caller of a hosted instance, and nothing tells one
    // caller's inline sites from another's.
    const ALPHA = [
      {
        name: 'Alpha Clinic',
        url: 'https://alpha.example',
        client: 'Alpha',
        checks: ['domain'] as CheckName[],
      },
    ];
    const BETA = [
      {
        name: 'Beta Bakery',
        url: 'https://beta.example',
        client: 'Beta',
        checks: ['domain'] as CheckName[],
      },
    ];

    it('keeps nothing, and says how to compare instead', async () => {
      const history = createMemoryHistory();
      await runPortfolioReport({ sites: ALPHA }, portfolioPorts({}, { history }));
      const result = await runPortfolioReport({ sites: ALPHA }, portfolioPorts({}, { history }));

      expect(structured(result)['changes']).toMatchObject({
        comparedWithPreviousRun: false,
        historyKeptIn: 'nowhere',
        previousRunUnavailable: expect.stringContaining('baselineSnapshot') as string,
      });
      expect(text(result)).not.toContain('add a "history" path');
    });

    it('carries what it could not measure again from the snapshot handed back', async () => {
      const first = await runPortfolioReport(
        { sites: ALPHA, includeSnapshot: true },
        portfolioPorts({ 'alpha.example': { domainDays: 5 } }),
      );
      const kept = structured(first)['snapshot'] as Record<string, unknown>;

      const healthy = portfolioPorts({});
      const second = await runPortfolioReport(
        { sites: ALPHA, baselineSnapshot: kept, includeSnapshot: true },
        {
          ...healthy,
          rdap: { lookupDomain: () => Promise.reject(new Error('rdap timed out after 10s')) },
        },
      );

      expect(structured(second)['changes']).toMatchObject({
        unmeasuredFindings: [{ site: 'Alpha Clinic', code: 'domain_expires_soon' }],
      });
      expect(JSON.stringify(structured(second)['snapshot'])).toContain('domain_expires_soon');
    });

    it("never shows one caller anything from another caller's run", async () => {
      const history = createMemoryHistory();
      const fixtures = { 'alpha.example': { domainDays: 5 }, 'beta.example': { domainDays: 300 } };
      await runPortfolioReport({ sites: ALPHA }, portfolioPorts(fixtures, { history }));

      for (const format of ['full', 'markdown', 'csv'] as const) {
        for (const sites of [BETA, [...BETA, ...ALPHA.map((site) => ({ ...site }))]]) {
          const result = await runPortfolioReport(
            { sites, format, includeSnapshot: true },
            portfolioPorts(fixtures, { history }),
          );
          const changes = structured(result)['changes'];
          expect(changes).toMatchObject({
            comparedWithPreviousRun: false,
            previousRunAt: null,
            sitesCompared: 0,
            sitesNewSincePreviousRun: 0,
            sitesDroppedSinceBaseline: [],
            resolvedFindings: [],
            persistingFindings: [],
            unmeasuredFindings: [],
          });
          if (sites === BETA) {
            expect(JSON.stringify(structured(result))).not.toContain('alpha');
            expect(JSON.stringify(structured(result))).not.toContain('Alpha');
            expect(text(result)).not.toContain('Alpha');
          }
        }
      }
    });
  });

  it('compares across restarts when the portfolio names a history file', async () => {
    // The feature, end to end: two servers that share no memory, and the second
    // one still knows what the first found.
    const directory = await mkdtemp(join(tmpdir(), 'upkeep-report-'));
    try {
      const portfolio = join(directory, 'sites.json');
      const file = {
        version: 1,
        history: 'upkeep-history.json',
        sites: [
          { name: 'Healthy Ltd', url: 'https://healthy.example' },
          { name: 'Urgent Ltd', url: 'https://urgent.example' },
        ],
      };
      const files = { [portfolio]: JSON.stringify(file) };

      // Each call gets its own ports, so nothing is carried in memory between
      // them: whatever the second run compares against came off the disk.
      const first = await runPortfolioReport(
        { file: portfolio },
        portfolioPorts({ 'healthy.example': {}, 'urgent.example': {} }, { files, durable: true }),
      );
      expect(structured(first)['changes']).toMatchObject({
        comparedWithPreviousRun: false,
        historyKeptIn: join(directory, 'upkeep-history.json'),
      });

      const second = await runPortfolioReport(
        { file: portfolio },
        portfolioPorts(
          { 'healthy.example': {}, 'urgent.example': { cert: 3 } },
          { files, durable: true },
        ),
      );

      const changes = structured(second)['changes'] as Record<string, unknown>;
      expect(changes['comparedWithPreviousRun']).toBe(true);
      expect(changes['sitesCompared']).toBe(2);
      expect(changes['regressed']).toEqual([{ site: 'Urgent Ltd', from: 'ok', to: 'critical' }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('writes nothing when the portfolio names no history file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upkeep-report-'));
    try {
      const portfolio = join(directory, 'sites.json');
      const files = {
        [portfolio]: JSON.stringify({
          version: 1,
          sites: [{ name: 'Healthy Ltd', url: 'https://healthy.example' }],
        }),
      };

      await runPortfolioReport(
        { file: portfolio },
        portfolioPorts({ 'healthy.example': {} }, { files, durable: true }),
      );

      // The default has to stay the default: the portfolio itself is served
      // from the fake file reader, so a directory that is still empty is a
      // directory this server put nothing in.
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not invent regressions when the previous run measured different checks', async () => {
    const history = rememberingHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    // The tool's own description recommends this quick pass.
    await runPortfolioReport(
      { sites, checks: ['uptime'] as CheckName[] },
      portfolioPorts(fixtures, { history }),
    );

    const full = await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    // Compared on uptime, the one check both runs made, and nothing else: the
    // certificate this run found for the first time is not called a regression.
    expect(structured(full)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      sitesCompared: 2,
      sitesPartlyCompared: 2,
      regressed: [],
      newFindings: [],
    });
  });

  it('does not announce an improvement when the second run simply looked at less', async () => {
    const history = rememberingHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    const quick = await runPortfolioReport(
      { sites, checks: ['uptime'] as CheckName[] },
      portfolioPorts(fixtures, { history }),
    );

    // A certificate expiring in three days has not improved just because this
    // run did not look at certificates.
    expect(structured(quick)['changes']).toMatchObject({
      sitesCompared: 2,
      sitesPartlyCompared: 2,
      improved: [],
      resolvedFindings: [],
    });
  });

  it('keeps two sites that share a URL apart in the history', async () => {
    const history = rememberingHistory();
    const sites = [
      { name: 'Live', url: 'https://shared.example', checks: ['uptime'] as CheckName[] },
      { name: 'Staging entry', url: 'https://shared.example', checks: ['uptime'] as CheckName[] },
    ];

    await runPortfolioReport({ sites }, portfolioPorts({}, { history }));
    const second = await runPortfolioReport({ sites }, portfolioPorts({}, { history }));

    expect(structured(second)['changes']).toMatchObject({ sitesCompared: 2 });
  });

  it('reports what got worse and what got better since the previous run', async () => {
    const history = rememberingHistory();
    const sites = [...TWO_SITES];

    await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': {}, 'urgent.example': { cert: 3 } }, { history }),
    );

    const second = await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { status: 500 }, 'urgent.example': {} }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      previousRunAt: NOW.toISOString(),
      regressed: [{ site: 'Healthy Ltd', from: 'ok', to: 'critical' }],
      improved: [{ site: 'Urgent Ltd', from: 'critical', to: 'ok' }],
      newFindings: [{ site: 'Healthy Ltd', code: 'server_error' }],
    });
    expect(text(second)).toContain('Healthy Ltd got worse');
  });

  it('says the comparison ran and found nothing, rather than staying silent', async () => {
    const history = rememberingHistory();
    const sites = [...TWO_SITES];
    const fixtures = { 'healthy.example': {}, 'urgent.example': { cert: 3 } };

    await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));
    const second = await runPortfolioReport({ sites }, portfolioPorts(fixtures, { history }));

    expect(structured(second)['changes']).toMatchObject({
      comparedWithPreviousRun: true,
      sitesCompared: 2,
      regressed: [],
      improved: [],
      newFindings: [],
    });
    // Saying nothing is indistinguishable from never having compared.
    expect(text(second)).toContain('No change since');
    expect(text(second)).toContain('2 of 2 sites comparable');
  });

  it('says why the sites it could not compare fully were not', async () => {
    const history = rememberingHistory();
    const fixtures = { 'healthy.example': {}, 'urgent.example': {}, 'quick.example': {} };
    const quick = {
      name: 'Quick Ltd',
      url: 'https://quick.example',
      checks: ['uptime'] as CheckName[],
    };

    await runPortfolioReport(
      { sites: [...TWO_SITES, quick] },
      portfolioPorts(fixtures, { history }),
    );

    // An uptime-only pass after a full run: the two full sites are compared on uptime
    // alone, the site that asked for uptime both times fully, and a fourth site is new.
    const second = await runPortfolioReport(
      {
        sites: [
          ...TWO_SITES,
          quick,
          { name: 'New Ltd', url: 'https://new.example', checks: ['uptime'] as CheckName[] },
        ],
        checks: ['uptime'] as CheckName[],
      },
      portfolioPorts({ ...fixtures, 'new.example': {} }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      sitesCompared: 3,
      sitesPartlyCompared: 2,
      sitesMeasuredDifferently: 0,
      sitesNewSincePreviousRun: 1,
    });
    expect(text(second)).toContain('2 only on the checks both runs measured');
    expect(text(second)).toContain('1 of them was not in the previous run');
  });

  it('names a finding that appeared without the site changing severity', async () => {
    const history = rememberingHistory();
    const sites = [
      {
        name: 'Healthy Ltd',
        url: 'https://healthy.example',
        checks: ['domain', 'ssl'] as CheckName[],
      },
    ];

    await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { domainDays: 20 } }, { history }),
    );

    // The registration was already expiring, so the site stays a warning: the
    // certificate is new information the severity cannot carry.
    const second = await runPortfolioReport(
      { sites },
      portfolioPorts({ 'healthy.example': { domainDays: 20, cert: 10 } }, { history }),
    );

    expect(structured(second)['changes']).toMatchObject({
      regressed: [],
      improved: [],
      newFindings: [{ site: 'Healthy Ltd', code: 'cert_expires_soon' }],
    });
    expect(text(second)).toContain('Healthy Ltd: new since the last run');
  });

  it('orders what needs action worst first across the whole portfolio', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          { name: 'A', url: 'https://a.example', checks: ['domain', 'ssl'] as CheckName[] },
          { name: 'B', url: 'https://b.example', checks: ['ssl'] as CheckName[] },
        ],
      },
      portfolioPorts({
        'a.example': { cert: 2, domainDays: 20 },
        'b.example': { cert: 3 },
      }),
    );

    // A's 20-day registration warning must not print above B's 3-day critical
    // just because A is the more urgent site overall.
    const severities = (structured(result)['needsAttention'] as { severity: string }[]).map(
      (item) => item.severity,
    );
    expect(severities).toEqual(['critical', 'critical', 'warning']);
  });

  it('does not report a site as healthy when none of its checks could run', async () => {
    const result = await runPortfolioReport(
      {
        sites: [{ name: 'Nothing asked', url: 'https://none.example', checks: [] as CheckName[] }],
      },
      portfolioPorts({}),
    );

    const site = sitesOf(result)[0];
    expect(site?.severity).toBe('unknown');
    expect(site?.checks).toEqual([]);
    expect(site?.findings.map((item) => item.code)).toContain('no_checks_ran');
    expect(text(result)).not.toContain('Nothing to do');
  });

  it('carries the notes from the portfolio file into the report', async () => {
    const result = await runPortfolioReport(
      {
        sites: [
          {
            name: 'Noted',
            url: 'https://noted.example',
            checks: ['uptime'],
            notes: 'Renewal is slow to approve.',
          },
        ],
      },
      portfolioPorts({}),
    );

    expect(sitesOf(result)[0]?.notes).toBe('Renewal is slow to approve.');
  });

  it('spends only the link budget a site asks for', async () => {
    const requested: string[] = [];
    const ports = portfolioPorts({});
    const base = ports.http.hop.bind(ports.http);
    ports.http.hop = (url, timeoutMs, signal) => {
      requested.push(url);
      return base(url, timeoutMs, signal);
    };
    ports.http.text = (url) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        contentType: 'text/html',
        body: `<html><body>${Array.from(
          { length: 10 },
          (_, index) => `<a href="/p${String(index)}">l</a>`,
        ).join('')}</body></html>`,
        truncated: false,
      });

    await runPortfolioReport(
      {
        sites: [
          {
            name: 'Budgeted',
            url: 'https://budget.example/',
            checks: ['seo'] as CheckName[],
            maxLinks: 3,
          },
        ],
      },
      ports,
    );

    // Ten links on the page, a budget of three: exactly three requested. This
    // is the setting that decides what a portfolio run costs.
    const linkRequests = requested.filter((url) => url.includes('/p'));
    expect(linkRequests).toHaveLength(3);
  });

  it('checks no links at all when a site sets the budget to zero', async () => {
    const requested: string[] = [];
    const ports = portfolioPorts({});
    const base = ports.http.hop.bind(ports.http);
    ports.http.hop = (url, timeoutMs, signal) => {
      requested.push(url);
      return base(url, timeoutMs, signal);
    };
    ports.http.text = (url) =>
      Promise.resolve({
        url,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        contentType: 'text/html',
        body: '<html><body><a href="/a">l</a><a href="/b">l</a></body></html>',
        truncated: false,
      });

    await runPortfolioReport(
      {
        sites: [
          {
            name: 'Fast',
            url: 'https://fast.example/',
            checks: ['seo'] as CheckName[],
            maxLinks: 0,
          },
        ],
      },
      ports,
    );

    expect(requested.filter((url) => url.endsWith('/a') || url.endsWith('/b'))).toEqual([]);
  });
});
