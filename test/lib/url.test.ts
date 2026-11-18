import { describe, expect, it } from 'vitest';
import { normaliseUrl, unusableUrlReason } from '../../src/lib/url.js';

describe('normaliseUrl', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['  example.com/pricing ', 'https://example.com/pricing'],
    ['http://example.com', 'http://example.com/'],
    ['HTTPS://Example.com/a', 'https://example.com/a'],
    ['example.com:8080', 'https://example.com:8080/'],
    ['localhost:3000/health', 'https://localhost:3000/health'],
  ])('reads %s as %s', (input, expected) => {
    expect(normaliseUrl(input)?.toString()).toBe(expected);
  });

  it.each([
    'ftp://example.com',
    'FTP://example.com/file',
    'file:///etc/passwd',
    'mailto:a@example.com',
    'javascript:alert(1)',
  ])('refuses a URL with a scheme it cannot fetch rather than prefixing it: %s', (input) => {
    // Prefixed, `ftp://example.com` became `https://ftp//example.com`: a
    // request to a host called `ftp`.
    expect(normaliseUrl(input)).toBeNull();
  });
});

describe('unusableUrlReason', () => {
  it('names the scheme that was refused', () => {
    expect(unusableUrlReason('ftp://example.com')).toBe(
      '"ftp://example.com" uses ftp:, and only http and https URLs can be checked',
    );
  });

  it('falls back to saying the URL is unusable', () => {
    expect(unusableUrlReason('https://')).toBe('"https://" is not a usable URL');
  });
});
