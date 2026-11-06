import { describe, expect, it } from 'vitest';
import { renderCalendar, type Renewal } from '../../src/lib/calendar.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');

const DOMAIN: Renewal = {
  kind: 'domain',
  subject: 'example.com',
  expiresAt: '2027-03-15T09:30:00.000Z',
  site: 'Example',
  client: 'Example Ltd',
};

/** Undoes line folding, as a calendar application would. */
function unfolded(text: string): string[] {
  return text.replace(/\r\n /g, '').split('\r\n');
}

describe('renderCalendar', () => {
  it('is a valid calendar even with nothing in it', () => {
    expect(renderCalendar([], NOW).split('\r\n')).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      expect.stringMatching(/^PRODID:-\/\/upkeep-mcp\/\//) as string,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'END:VCALENDAR',
      '',
    ]);
  });

  it('writes an all-day event on the UTC date, with a stable id and a reminder', () => {
    const lines = unfolded(renderCalendar([DOMAIN], NOW));

    expect(lines).toEqual(
      expect.arrayContaining([
        'UID:domain-example.com@upkeep-mcp',
        'DTSTAMP:20261001T120000Z',
        'DTSTART;VALUE=DATE:20270315',
        'DTEND;VALUE=DATE:20270316',
        'SUMMARY:Domain renewal: example.com',
        'TRIGGER:-P30D',
      ]),
    );
  });

  it('keeps the same id across runs, so importing again updates the event', () => {
    const uid = (text: string): string | undefined =>
      unfolded(text).find((line) => line.startsWith('UID:'));

    expect(uid(renderCalendar([DOMAIN], NOW))).toBe(
      uid(renderCalendar([{ ...DOMAIN, expiresAt: '2028-03-15T09:30:00.000Z' }], new Date())),
    );
  });

  it('gives two sites on one domain one event, naming both', () => {
    const lines = unfolded(renderCalendar([DOMAIN, { ...DOMAIN, site: 'Shop' }], NOW));

    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.find((line) => line.startsWith('DESCRIPTION:Client'))).toContain(
      'Sites: Example\\, Shop',
    );
  });

  it('adds a certificate only when it is close', () => {
    const certificate = (expiresAt: string): Renewal => ({
      ...DOMAIN,
      kind: 'certificate',
      expiresAt,
    });

    expect(renderCalendar([certificate('2027-01-01T00:00:00.000Z')], NOW)).not.toContain(
      'BEGIN:VEVENT',
    );
    const near = renderCalendar([certificate('2026-10-20T00:00:00.000Z')], NOW);
    expect(near).toContain('SUMMARY:Certificate expiry: example.com');
    expect(near).toContain('TRIGGER:-P7D');
  });

  it('escapes what a site name can hold', () => {
    const text = unfolded(
      renderCalendar([{ ...DOMAIN, site: 'A; B, C\\D', client: 'Line\nbreak' }], NOW),
    ).join('\n');

    expect(text).toContain('Client: Line\\nbreak\\nSites: A\\; B\\, C\\\\D');
  });

  it('skips an expiry it cannot read rather than writing a broken event', () => {
    expect(renderCalendar([{ ...DOMAIN, expiresAt: 'soon' }], NOW)).not.toContain('BEGIN:VEVENT');
  });

  it('folds at 75 octets, and never through the middle of a character', () => {
    const client = 'Pastelaria São João da Conceição, Ação & Coração, '.repeat(6);
    const text = renderCalendar([{ ...DOMAIN, client }], NOW);

    for (const line of text.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
    expect(text).not.toContain('�');
    expect(unfolded(text).join('\n')).toContain('São João da Conceição\\, Ação');
    expect(text.split('\r\n').some((line) => line.startsWith(' '))).toBe(true);
  });

  it('ends every line in CRLF, including the last', () => {
    const text = renderCalendar([DOMAIN], NOW);

    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });
});
