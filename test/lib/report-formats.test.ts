import { describe, expect, it } from 'vitest';
import { renderCsv, renderMarkdown, type RenderableReport } from '../../src/lib/report-formats.js';

const CHANGES: RenderableReport['changes'] = {
  comparedWithPreviousRun: true,
  previousRunAt: '2026-07-01T00:00:00.000Z',
  previousRunUnavailable: null,
  resolvedFindings: [{ site: 'Bakery', code: 'cert_expires_soon', actionable: true }],
  newFindings: [{ site: 'Bakery', code: 'domain_expires_soon' }],
  persistingFindings: [{ site: 'Bakery', code: 'hsts_missing' }],
  unmeasuredFindings: [],
  findingsPastTheWindow: [],
  sitesDroppedSinceBaseline: [],
  newSites: [],
};

const FLORIST = {
  name: 'Florist',
  url: 'https://florist.example/',
  client: null,
  severity: 'ok',
  soonestExpiryDays: null,
  findings: [],
} as const;

const REPORT: RenderableReport = {
  generatedAt: '2026-10-01T12:00:00.000Z',
  sites: [
    {
      name: 'Bakery',
      url: 'https://bakery.example/',
      client: 'Bakery Ltd',
      severity: 'warning',
      soonestExpiryDays: 20,
      findings: [
        {
          code: 'domain_expires_soon',
          severity: 'warning',
          message: 'The registration expires in 20 days.',
        },
        { code: 'hsts_missing', severity: 'warning', message: 'No HSTS.' },
      ],
    },
    FLORIST,
  ],
  changes: CHANGES,
  notes: ['A note.'],
};

describe('renderMarkdown', () => {
  const text = renderMarkdown(REPORT, 'Bakery Ltd');

  it('opens with the date and what the whole portfolio amounts to', () => {
    expect(text).toContain('# Website maintenance: Bakery Ltd');
    expect(text).toContain('Checked on 2026-10-01.');
    expect(text).toContain('Of the 2 sites checked, 1 needs attention.');
  });

  it('separates what needs the client from what the maintainer is handling', () => {
    const decision = text.indexOf('## What needs a decision from you');
    const handling = text.indexOf('## What we are dealing with');
    const renewal = text.indexOf('close to its renewal date');
    const browsers = text.indexOf('Browsers are not told');

    expect(decision).toBeGreaterThan(-1);
    expect(renewal).toBeGreaterThan(decision);
    expect(renewal).toBeLessThan(handling);
    expect(browsers).toBeGreaterThan(handling);
  });

  it('says what was resolved, what is new and what is still open', () => {
    expect(text).toContain('Compared with the check on 2026-07-01.');
    expect(text).toContain('**Resolved:**');
    expect(text).toContain('**New:**');
    expect(text).toContain('**Still open** (listed above): Bakery (1).');
  });

  it('leaves informational findings out of what it says changed', () => {
    const quiet = renderMarkdown(
      {
        ...REPORT,
        sites: [
          {
            ...FLORIST,
            severity: 'info',
            findings: [{ code: 'csp_missing', severity: 'info', message: 'No CSP.' }],
          },
        ],
        changes: {
          ...CHANGES,
          resolvedFindings: [],
          newFindings: [],
          persistingFindings: [{ site: 'Florist', code: 'csp_missing' }],
        },
      },
      'x',
    );

    expect(quiet).not.toContain('malicious scripts');
    expect(quiet).toContain('Nothing that needs attention, then or now.');
  });

  it('never implies nothing changed when nothing could be compared', () => {
    const uncompared = renderMarkdown(
      {
        ...REPORT,
        changes: {
          ...CHANGES,
          comparedWithPreviousRun: false,
          previousRunUnavailable: 'no run has been recorded yet',
        },
      },
      'Bakery Ltd',
    );

    expect(uncompared).toContain('Nothing could be compared with an earlier check: no run has');
  });

  it('lists every site, including a name that would break the table', () => {
    const piped = renderMarkdown({ ...REPORT, sites: [{ ...FLORIST, name: 'A | B' }] }, 'x');

    expect(text).toContain('| Florist | Fine | Not known |');
    expect(text).toContain('| Bakery | Needs attention | In 20 days |');
    expect(piped).toContain('| A \\| B |');
  });

  it.each([
    [-3, 'Expired'],
    [0, 'Today'],
    [1, 'Tomorrow'],
    [2, 'In 2 days'],
  ])('reads %i days to renewal as %s', (soonestExpiryDays, wording) => {
    const expiring = renderMarkdown({ ...REPORT, sites: [{ ...FLORIST, soonestExpiryDays }] }, 'x');

    expect(expiring).toContain(`| Florist | Fine | ${wording} |`);
  });

  it('leaves an informational line out of what it calls resolved', () => {
    const quiet = renderMarkdown(
      {
        ...REPORT,
        changes: {
          ...CHANGES,
          resolvedFindings: [{ site: 'Bakery', code: 'csp_missing', actionable: false }],
        },
      },
      'x',
    );

    expect(quiet).not.toContain('**Resolved:**');
  });

  it('says what could not be checked again, rather than calling it resolved', () => {
    const outage = renderMarkdown(
      {
        ...REPORT,
        changes: {
          ...CHANGES,
          resolvedFindings: [],
          unmeasuredFindings: [{ site: 'Bakery', code: 'domain_expired', actionable: true }],
        },
      },
      'x',
    );

    expect(outage).not.toContain('**Resolved:**');
    expect(outage).toContain(
      '**Could not be checked again this time:**\n\n- **Bakery:** The domain name has expired',
    );
  });

  it('says plainly when all is in order', () => {
    const fine = renderMarkdown({ ...REPORT, sites: [FLORIST] }, 'x');

    expect(fine).toContain('The site checked is in order.');
    expect(fine).not.toContain('needs a decision');
  });

  it('carries the notes through', () => {
    expect(text).toContain('- A note.');
  });
});

describe('renderCsv', () => {
  const rows = renderCsv(REPORT).split('\r\n');

  it('has one row per finding, and one for a site with none', () => {
    expect(rows[0]).toBe(
      'client,site,url,site_status,soonest_expiry_days,severity,code,plain,message',
    );
    expect(rows.filter((row) => row.includes('Bakery Ltd'))).toHaveLength(2);
    expect(rows[3]).toBe(',Florist,https://florist.example/,ok,,,,,');
  });

  it('quotes a field holding a comma or a quote', () => {
    const quoted = renderCsv({
      ...REPORT,
      sites: [{ ...FLORIST, name: 'Smith, "Bakers"' }],
    });

    expect(quoted).toContain('"Smith, ""Bakers"""');
  });

  it.each(['=HYPERLINK("http://evil.example")', '+1', '-1+1', '@sum'])(
    'defuses %s, which a spreadsheet would run',
    (name) => {
      const output = renderCsv({ ...REPORT, sites: [{ ...FLORIST, name }] });

      expect(output).toMatch(/\r\n,"?'[=+\-@]/);
    },
  );

  it('leaves a negative day count as a number, so the column still sorts', () => {
    const output = renderCsv({ ...REPORT, sites: [{ ...FLORIST, soonestExpiryDays: -3 }] });

    expect(output).toContain('https://florist.example/,ok,-3,');
  });

  it('ends every line as RFC 4180 asks', () => {
    expect(renderCsv(REPORT).endsWith('\r\n')).toBe(true);
  });
});

describe('renderMarkdown, on a report a client reads twice', () => {
  const a11y = (rule: string) => ({
    code: `a11y_${rule}`,
    severity: 'warning' as const,
    message: `Rule ${rule} fails.`,
  });
  const report: RenderableReport = {
    generatedAt: '2026-11-18T09:30:00.000Z',
    sites: [
      {
        name: 'Bakery',
        url: 'https://bakery.example/',
        client: null,
        severity: 'warning',
        soonestExpiryDays: 40,
        findings: [a11y('color_contrast'), a11y('link_name'), a11y('image_alt')],
      },
      {
        name: 'Florist',
        url: 'https://florist.example/',
        client: null,
        severity: 'critical',
        soonestExpiryDays: 40,
        findings: [
          { code: 'cert_expired', severity: 'critical', message: 'Expired.' },
          { code: 'hsts_missing', severity: 'warning', message: 'No HSTS.' },
        ],
      },
    ],
    changes: {
      ...CHANGES,
      previousRunAt: '2026-11-18T01:01:07.107Z',
      resolvedFindings: [],
      newFindings: [],
      persistingFindings: [
        { site: 'Bakery', code: 'a11y_color_contrast' },
        { site: 'Bakery', code: 'a11y_link_name' },
        { site: 'Bakery', code: 'a11y_image_alt' },
      ],
      newSites: ['Florist'],
    },
    notes: [],
  };
  const text = renderMarkdown(report, 'all sites');
  const lines = text.split('\n');

  it('says a sentence that several findings share once, with a count', () => {
    const bakery = lines.filter((line) => line.startsWith('- **Bakery:**'));

    expect(bakery).toHaveLength(1);
    expect(bakery[0]).toContain('(3 separate issues)');
  });

  it('lists what is still open by site, rather than repeating every sentence', () => {
    expect(text).toContain('**Still open** (listed above): Bakery (3).');
  });

  it('names a site added since the comparison, and what it needs', () => {
    expect(text).toContain('**Added since then:**');
    expect(text).toContain('- **Florist:** 2 issues listed above.');
  });

  it('gives the time of a comparison made the same day', () => {
    expect(text).toContain('Compared with the check on 2026-11-18 at 01:01 UTC.');
  });
});
