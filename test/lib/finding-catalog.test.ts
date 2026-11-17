import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainFinding, isUnmeasured, unmeasuredBy } from '../../src/lib/finding-catalog.js';

/** Every literal code passed to `finding()` anywhere in `src/`. */
function codesInSource(): string[] {
  const codes = new Set<string>();
  for (const directory of ['src/tools', 'src/lib']) {
    for (const file of readdirSync(directory)) {
      const text = readFileSync(join(directory, file), 'utf8');
      for (const match of text.matchAll(/finding\(\s*['`]([a-z0-9_]+)['`]/g)) {
        if (match[1] !== undefined) codes.add(match[1]);
      }
    }
  }
  // `site` is the report ranking sites through `finding`, never a real finding.
  codes.delete('site');
  return [...codes].sort();
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
    expect(unmeasuredBy('constructor')).toEqual([]);
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

describe('unmeasuredBy', () => {
  const gapShaped = codesInSource().filter((code) =>
    /_(lookup_failed|unavailable|unknown|not_established|unjudged|unverified|not_asked|unreachable|not_checked|unchecked|truncated|incomplete)$/.test(
      code,
    ),
  );

  it('finds enough of them for the next test to mean something', () => {
    expect(gapShaped.length).toBeGreaterThan(10);
  });

  it.each(gapShaped.filter((code) => !Object.hasOwn(NOT_GAPS, code)))(
    'says what %s leaves unmeasured',
    (code) => {
      expect(unmeasuredBy(code).length).toBeGreaterThan(0);
    },
  );

  it('names only codes that exist, so a renamed one cannot quietly drop out', () => {
    const known = codesInSource();
    for (const code of known) {
      for (const entry of unmeasuredBy(code)) {
        expect(
          known.some((other) => isUnmeasured([entry], other)),
          `${code} names ${entry}`,
        ).toBe(true);
      }
    }
  });

  it('reads a trailing * as every code with that prefix', () => {
    expect(isUnmeasured(['spf_*'], 'spf_not_published')).toBe(true);
    expect(isUnmeasured(['spf_*'], 'dmarc_not_published')).toBe(false);
    expect(isUnmeasured(['cert_revoked'], 'cert_revoked_unverified')).toBe(false);
  });

  it('leaves an expiring domain unmeasured when the registry could not be read', () => {
    expect(isUnmeasured(unmeasuredBy('registration_lookup_failed'), 'domain_expires_soon')).toBe(
      true,
    );
  });
});
