import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WHOLE_CHECK,
  explainFinding,
  isUnmeasured,
  unmeasuredBy,
} from '../../src/lib/finding-catalog.js';
import { CHECK_NAMES, type CheckName } from '../../src/lib/portfolio.js';

/**
 * @param file A source file.
 * @returns Every literal code it passes to `finding()`.
 */
function codesIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/finding\(\s*['`]([a-z0-9_]+)['`]/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/** Every literal code passed to `finding()` anywhere in `src/`. */
function codesInSource(): string[] {
  const codes = new Set<string>();
  for (const directory of ['src/tools', 'src/lib']) {
    for (const file of readdirSync(directory))
      codesIn(join(directory, file)).forEach((code) => codes.add(code));
  }
  // `site` is the report ranking sites through `finding`, never a real finding.
  codes.delete('site');
  return [...codes].sort();
}

/** Where each check's findings are written. */
const CHECK_SOURCES: Record<CheckName, string> = {
  domain: 'src/tools/domain-check.ts',
  ssl: 'src/tools/ssl-check.ts',
  uptime: 'src/tools/uptime-check.ts',
  seo: 'src/tools/seo-audit.ts',
  accessibility: 'src/tools/accessibility-audit.ts',
};

/** Codes built at runtime, which no literal shows: one example of each. */
const RUNTIME_CODES: Record<CheckName, readonly string[]> = {
  domain: [],
  ssl: [],
  uptime: [],
  seo: ['sitemap_loc_missing'],
  accessibility: ['a11y_color_contrast', 'robots_txt_unreachable', 'page_disallowed_by_robots'],
};

/**
 * @param check A check.
 * @returns The codes it reports.
 */
function codesOfCheck(check: CheckName): string[] {
  return [...new Set([...codesIn(CHECK_SOURCES[check]), ...RUNTIME_CODES[check]])];
}

describe('explainFinding', () => {
  it('finds enough codes for this test to mean something', () => {
    expect(codesInSource().length).toBeGreaterThan(90);
  });

  it.each(codesInSource())('explains %s', (code) => {
    expect(explainFinding(code)?.plain.length).toBeGreaterThan(10);
  });

  it('explains the codes that are built at runtime', () => {
    expect(explainFinding('a11y_color_contrast')?.plain).toContain('disabilities');
    expect(explainFinding('sitemap_lastmod')?.plain).toContain('list of pages');
    expect(explainFinding('ssl_check_failed')?.plain).toContain('could not run');
  });

  it('says what needs the client, and leaves the rest to the maintainer', () => {
    expect(explainFinding('domain_expires_soon')?.needsClient).toBe(true);
    expect(explainFinding('hsts_missing')?.needsClient).toBe(false);
  });

  it('has nothing to say about a code it does not know, or a property of Object', () => {
    expect(unmeasuredBy('domain', 'constructor')).toEqual([]);
    expect(explainFinding('no_such_code')).toBeNull();
    expect(explainFinding('constructor')).toBeNull();
  });
});

/**
 * Codes shaped like "this could not be established" that are findings in their own
 * right, each with why: they leave nothing unmeasured that a comparison could misread.
 */
const NOT_GAPS: Record<string, string> = {
  revocation_status_unknown: 'the issuer answered, and "unknown" is its answer',
  cert_revoked_unverified: 'a claim that was made, not one that could not be',
  redirect_target_unreachable: 'what a visitor following the redirect gets',
  crawl_incomplete: 'site_crawl only, which a portfolio never runs or compares',
  open_graph_incomplete: 'tags missing from a page that was read in full',
};

/**
 * Gap-shaped codes that mean the check examined nothing, which the check declares with
 * `WHOLE_CHECK` instead of a line in the table. Each check's own test holds it to that.
 */
const WHOLE_CHECK_GAPS: Partial<Record<CheckName, readonly string[]>> = {
  seo: ['page_unavailable', 'robots_txt_unreachable'],
  accessibility: ['page_unavailable', 'robots_txt_unreachable'],
};

describe('unmeasuredBy', () => {
  const gapShaped = (codes: readonly string[]): string[] =>
    codes.filter((code) =>
      /_(lookup_failed|unavailable|unknown|not_established|unjudged|unverified|not_asked|unreachable|not_checked|unchecked|truncated|incomplete)$/.test(
        code,
      ),
    );
  const perCheck = CHECK_NAMES.flatMap((check) =>
    gapShaped(codesOfCheck(check))
      .filter((code) => !Object.hasOwn(NOT_GAPS, code))
      .filter((code) => !(WHOLE_CHECK_GAPS[check] ?? []).includes(code))
      .map((code): [CheckName, string] => [check, code]),
  );

  it('finds enough of them for the next test to mean something', () => {
    expect(gapShaped(codesInSource()).length).toBeGreaterThan(10);
    expect(perCheck.length).toBeGreaterThan(10);
  });

  it.each(perCheck)('says what %s reporting %s leaves unmeasured', (check, code) => {
    expect(unmeasuredBy(check, code).length).toBeGreaterThan(0);
  });

  it('names only codes of the same check, so one check cannot hide or resolve another', () => {
    for (const check of CHECK_NAMES) {
      const own = codesOfCheck(check);
      const others = CHECK_NAMES.filter((other) => other !== check)
        .flatMap(codesOfCheck)
        .filter((code) => !own.includes(code));
      for (const code of codesInSource()) {
        for (const entry of unmeasuredBy(check, code)) {
          expect(
            own.some((other) => isUnmeasured([entry], other)),
            `${check}: ${code} names ${entry}`,
          ).toBe(true);
          expect(
            others.filter((other) => isUnmeasured([entry], other)),
            `${check}: ${code} names ${entry}`,
          ).toEqual([]);
        }
        if (unmeasuredBy(check, code).length > 0) {
          expect(own, `${check} has a line for ${code}, which it never reports`).toContain(code);
        }
      }
    }
  });

  it('never lets an seo gap stand for an accessibility finding, or the reverse', () => {
    for (const code of codesInSource()) {
      expect(isUnmeasured(unmeasuredBy('seo', code), 'a11y_color_contrast')).toBe(false);
      expect(isUnmeasured(unmeasuredBy('accessibility', code), 'title_missing')).toBe(false);
    }
  });

  it('reads WHOLE_CHECK as every code', () => {
    expect(isUnmeasured([WHOLE_CHECK], 'a11y_color_contrast')).toBe(true);
    expect(isUnmeasured([WHOLE_CHECK], 'sitemap_missing')).toBe(true);
  });

  it('reads a trailing * as every code with that prefix', () => {
    expect(isUnmeasured(['spf_*'], 'spf_not_published')).toBe(true);
    expect(isUnmeasured(['spf_*'], 'dmarc_not_published')).toBe(false);
    expect(isUnmeasured(['cert_revoked'], 'cert_revoked_unverified')).toBe(false);
  });

  it('leaves an expiring domain unmeasured when the registry could not be read', () => {
    expect(
      isUnmeasured(unmeasuredBy('domain', 'registration_lookup_failed'), 'domain_expires_soon'),
    ).toBe(true);
  });
});
