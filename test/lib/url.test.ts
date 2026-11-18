import { describe, expect, it } from 'vitest';
import {
  CREDENTIALS_REFUSAL,
  carriesCredentials,
  normaliseUrl,
  unusableUrlReason,
} from '../../src/lib/url.js';

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

describe('credentials in a URL', () => {
  const carrying = [
    'https://user:pass@example.com',
    'http://user@example.com/path',
    'https://:secret@example.com',
    'user:pass@example.com',
    'user@example.com',
    'ftp://user:pass@example.com',
    'https://user:pass@example.com\\@other.example',
  ];

  it.each(carrying)('refuses %s without echoing it', (input) => {
    expect(carriesCredentials(input)).toBe(true);
    expect(normaliseUrl(input)).toBeNull();
    expect(unusableUrlReason(input)).toBe(CREDENTIALS_REFUSAL);
  });

  it('does not take an @ in a path, a query or a mailto: address for credentials', () => {
    expect(normaliseUrl('https://example.com/@team')?.toString()).toBe('https://example.com/@team');
    expect(normaliseUrl('example.com/?by=a@b.example')).not.toBeNull();
    expect(carriesCredentials('mailto:someone@example.com')).toBe(false);
  });
});

describe('unusableUrlReason', () => {
  it('names the scheme that was refused', () => {
    expect(unusableUrlReason('ftp://example.com')).toBe(
      '"ftp://example.com" uses ftp:, and only http and https URLs can be checked',
    );
  });

  it('does not call a user name, or a host with a broken port, a scheme', () => {
    // All three read as "uses user:", "uses example.com:" and "uses a.b:",
    // naming a scheme nobody wrote.
    expect(unusableUrlReason('user:pass@example.com')).toBe(CREDENTIALS_REFUSAL);
    expect(unusableUrlReason('example.com:')).toBe(
      '"example.com:" has "" where a port number should be',
    );
    expect(unusableUrlReason('a.b:1.2')).toBe('"a.b:1.2" has "1.2" where a port number should be');
    expect(unusableUrlReason('localhost:abc/x')).toBe(
      '"localhost:abc/x" has "abc" where a port number should be',
    );
  });

  it('still names a real scheme, even one with an @ in it', () => {
    expect(unusableUrlReason('mailto:someone@example.com')).toBe(
      '"mailto:someone@example.com" uses mailto:, and only http and https URLs can be checked',
    );
  });

  it('falls back to saying the URL is unusable', () => {
    expect(unusableUrlReason('https://')).toBe('"https://" is not a usable URL');
  });
});
