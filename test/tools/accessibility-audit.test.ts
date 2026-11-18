import { WHOLE_CHECK } from '../../src/lib/finding-catalog.js';
import { describe, expect, it } from 'vitest';
import type { AxeViolation } from '../../src/lib/axe.js';
import { CheckError } from '../../src/lib/errors.js';
import {
  checkAccessibilityForPortfolio,
  runAccessibilityAudit,
} from '../../src/tools/accessibility-audit.js';
import { axeRun, fakePorts, findingCodes, structured, text } from '../helpers/fake-ports.js';

const PAGE = 'https://example.com/';

/** One axe violation, as a base for cases to override. */
function violation(overrides: Partial<AxeViolation> = {}): AxeViolation {
  return {
    id: 'color-contrast',
    impact: 'serious',
    help: 'Elements must have sufficient colour contrast',
    helpUrl: 'https://dequeuniversity.com/rules/axe/4.13/color-contrast',
    tags: ['wcag2aa', 'wcag143'],
    nodeCount: 3,
    selectors: ['.banner > p', 'footer a'],
    ...overrides,
  };
}

describe('runAccessibilityAudit', () => {
  it('reports a target the guard refused as invalid_input, not as a server fault', async () => {
    // robots.txt is the first outbound call, so on a public instance it is where
    // the guard refuses. The refusal used to escape a function whose contract
    // says it never throws, and the outer wrapper reported it as `unexpected` —
    // which tells a caller the server broke, when what happened is that they
    // asked for something the server will not contact. The category is what a
    // client branches on; the message alone is not enough.
    const refused = new CheckError(
      'invalid_input',
      'this server only contacts the public internet, and 127.0.0.1 is not on it (loopback)',
    );

    const result = await runAccessibilityAudit(
      { url: 'http://127.0.0.1:8080' },
      fakePorts({ robots: refused }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^invalid_input: /);
    expect(text(result)).toContain('not on it (loopback)');
  });

  it('reports a page that fails nothing, without calling it accessible', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: axeRun({ passCount: 42 }) }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({
      audited: true,
      standard: 'wcag2aa',
      violationCount: 0,
      passCount: 42,
    });
    // Automated rules find about a third of the problems, and the wording has
    // to carry that or the report overstates itself.
    expect(findingCodes(result)).toContain('a11y_automated_checks_passed');
    expect(text(result)).toContain('roughly a third');
  });

  it('counts in the singular when there is one of something', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: [violation({ id: 'html-has-lang', impact: 'serious', nodeCount: 1 })],
          incompleteCount: 1,
        }),
      }),
    );

    expect(text(result)).toContain('1 wcag2aa rule failed across 1 element,');
    expect(text(result)).toContain('1 needs a person.');
    expect(text(result)).toContain('1 rule could not be decided automatically and needs a person');
  });

  it('maps axe impacts onto the severities this project reports', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: [
            violation({ id: 'image-alt', impact: 'critical', nodeCount: 2 }),
            violation({ id: 'color-contrast', impact: 'serious', nodeCount: 5 }),
            violation({ id: 'region', impact: 'moderate', nodeCount: 1 }),
            violation({ id: 'landmark-one-main', impact: 'minor', nodeCount: 1 }),
          ],
        }),
      }),
    );

    const findings = structured(result)['findings'] as { code: string; severity: string }[];
    expect(findings.map((item) => item.severity)).toEqual([
      'critical',
      'warning',
      'warning',
      'info',
    ]);
    expect(structured(result)['severity']).toBe('critical');
    expect(structured(result)['affectedElements']).toBe(9);
  });

  it('puts the worst impact first, then the one affecting most elements', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: [
            violation({ id: 'minor-rule', impact: 'minor', nodeCount: 40 }),
            violation({ id: 'critical-few', impact: 'critical', nodeCount: 1 }),
            violation({ id: 'critical-many', impact: 'critical', nodeCount: 9 }),
          ],
        }),
      }),
    );

    const violations = structured(result)['violations'] as { id: string }[];
    expect(violations.map((item) => item.id)).toEqual([
      'critical-many',
      'critical-few',
      'minor-rule',
    ]);
  });

  it('reports rules it could not decide, without putting the site in the unknown column', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: axeRun({ incompleteCount: 4 }) }),
    );

    const findings = structured(result)['findings'] as { code: string; severity: string }[];
    const review = findings.find((item) => item.code === 'a11y_needs_review');

    // Said out loud, because they are the rules needing a person — but `info`,
    // not `unknown`: contrast against a background image is incomplete on most
    // real pages, and `unknown` is the column a portfolio reserves for checks
    // that could not run at all.
    expect(review?.severity).toBe('info');
    expect(structured(result)['severity']).not.toBe('unknown');
    expect(structured(result)['incompleteCount']).toBe(4);
  });

  it('keeps the error category the failure carried, rather than re-reading its prose', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      // What the public instance's target guard raises for a redirect into
      // private space. Classifying it by message would report it as `network`.
      fakePorts({
        axe: new CheckError('invalid_input', 'this server only contacts the public internet'),
      }),
    );

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
  });

  it('passes a timeout through as a timeout', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: new CheckError('timeout', 'auditing did not finish within 45s') }),
    );

    expect(text(result)).toContain('timeout');
  });

  it('summarises the tail rather than emitting a finding per rule', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: axeRun({
          violations: Array.from({ length: 14 }, (_, index) =>
            violation({ id: `rule-${String(index)}`, impact: 'minor' }),
          ),
        }),
      }),
    );

    expect(findingCodes(result)).toContain('a11y_further_violations');
    expect(structured(result)['violationCount']).toBe(14);
    // All fourteen are still in the structured output; only the findings list
    // is trimmed, because a person reads that one.
    expect((structured(result)['violations'] as unknown[]).length).toBe(14);
  });

  it('names the command that installs a browser when none is there', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({
        axe: new CheckError(
          'not_found',
          'no browser is installed for this check; run `npx playwright install chromium` once, or use the other tools, which need none',
        ),
      }),
    );

    // The whole point of scheduling this tool last: it degrades to an
    // actionable message and takes nothing else down with it.
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('npx playwright install chromium');
    expect(text(result)).toContain('not_found');
  });

  it('does not open a page robots.txt forbids', async () => {
    const result = await runAccessibilityAudit(
      { url: 'https://example.com/private' },
      // No axe fixture: opening the page would reject and fail this test.
      fakePorts({ robots: 'User-agent: *\nDisallow: /private' }),
    );

    expect(result.isError).toBeFalsy();
    expect(structured(result)['audited']).toBe(false);
    expect(findingCodes(result)).toEqual(['page_disallowed_by_robots']);
  });

  it('says why robots.txt could not be read', async () => {
    // Without the reason, an expired certificate reads like a site that hides itself.
    const result = await runAccessibilityAudit(
      { url: 'https://example.com/' },
      fakePorts({ robots: 'unreachable' }),
    );

    expect(structured(result)['audited']).toBe(false);
    expect(findingCodes(result)).toEqual(['robots_txt_unreachable']);
    expect(text(result)).toContain('certificate has expired');
  });

  it.each([404, 500, 503])(
    'does not report an HTTP %i error page as the audit of the page',
    async (status) => {
      // The page's response used to be ignored, so axe audited a 404 page — which
      // is usually small and tidy — and the result came back `audited: true` with
      // few or no violations: a clean bill for a page that does not exist.
      const result = await runAccessibilityAudit(
        { url: PAGE },
        fakePorts({ axe: axeRun({ status, violations: [], passCount: 30 }) }),
      );

      expect(result.isError).toBeFalsy();
      expect(structured(result)).toMatchObject({
        audited: false,
        severity: 'critical',
        violationCount: 0,
        passCount: 0,
        axeVersion: null,
      });
      expect(findingCodes(result)).toEqual(['page_unavailable']);
      expect(text(result)).toContain(`answered HTTP ${String(status)}`);
      expect(text(result)).toContain('the error page was not audited');
    },
  );

  it('does not report a page the browser got no response for as audited', async () => {
    const result = await runAccessibilityAudit(
      { url: PAGE },
      fakePorts({ axe: axeRun({ status: null }) }),
    );

    expect(structured(result)).toMatchObject({ audited: false, severity: 'unknown' });
    expect(findingCodes(result)).toEqual(['page_unavailable']);
  });

  it('puts an error page in the portfolio as a problem, not as a clean result', async () => {
    const outcome = await checkAccessibilityForPortfolio(
      PAGE,
      fakePorts({ axe: axeRun({ status: 404 }) }),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary.severity).toBe('critical');
      expect(outcome.summary.findings.map((item) => item.code)).toEqual(['page_unavailable']);
      expect(outcome.summary.headline).toContain('404');
    }
  });

  it.each([
    ['robots.txt could not be read', { robots: 'unreachable', axe: axeRun() }],
    ['robots.txt forbids the page', { robots: 'User-agent: *\nDisallow: /', axe: axeRun() }],
    ['the page answers an error', { axe: axeRun({ status: 404 }) }],
    ['the browser got no response', { axe: axeRun({ status: null }) }],
  ] as const)('declares the whole check unmeasured in a portfolio when %s', async (_, options) => {
    // Otherwise every violation found last quarter reads as resolved.
    const outcome = await checkAccessibilityForPortfolio(PAGE, fakePorts(options));

    expect(outcome.ok && outcome.summary.unmeasured).toEqual([WHOLE_CHECK]);
  });

  it('declares nothing unmeasured for a page it audited', async () => {
    const outcome = await checkAccessibilityForPortfolio(PAGE, fakePorts({ axe: axeRun() }));

    expect(outcome.ok && outcome.summary.unmeasured).toEqual([]);
  });

  it('selects cumulative rule sets, so asking for AA still reports A failures', async () => {
    const seen: string[][] = [];
    const ports = fakePorts({ axe: axeRun() });
    ports.browser.audit = (_url, tags) => {
      seen.push([...tags]);
      return Promise.resolve(axeRun());
    };

    await runAccessibilityAudit({ url: PAGE, standard: 'wcag22aa' }, ports);

    expect(seen[0]).toEqual(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  });

  it('rejects a URL it cannot make sense of', async () => {
    const result = await runAccessibilityAudit({ url: '  ' }, fakePorts());

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('invalid_input');
  });
});
