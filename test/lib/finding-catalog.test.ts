import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainFinding } from '../../src/lib/finding-catalog.js';

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
    expect(explainFinding('no_such_code')).toBeNull();
    expect(explainFinding('constructor')).toBeNull();
  });
});
