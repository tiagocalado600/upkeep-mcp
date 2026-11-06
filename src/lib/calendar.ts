import { SERVER_NAME, SERVER_VERSION } from './constants.js';

/**
 * A renewal calendar, as an iCalendar file.
 *
 * Generated here rather than left to a model, because the format is unforgiving in
 * ways a model gets wrong: lines end in CRLF, long lines fold at 75 octets rather than
 * 75 characters, and text has its own escaping. A calendar that fails to import is
 * worse than none.
 *
 * @see https://www.rfc-editor.org/rfc/rfc5545
 */

/** One thing that expires. */
export interface Renewal {
  /** What it is. */
  kind: 'domain' | 'certificate';
  /** The domain or host it belongs to. */
  subject: string;
  /** When it expires, ISO 8601. */
  expiresAt: string;
  /** The site it was found on, as named in the portfolio. */
  site: string;
  /** The client that site belongs to, when the portfolio says. */
  client: string | null;
}

/**
 * How long before a renewal each kind of event reminds, and when a certificate earns
 * an event at all.
 *
 * A domain is renewed by a person, so it gets the lead time that takes. A certificate
 * usually renews itself every few weeks, and an event for each would bury the domains,
 * so one only appears when it is close enough to be worth a person's attention.
 */
const REMINDER = { domain: 'P30D', certificate: 'P7D' } as const;

/** How close a certificate's expiry must be to earn an event. */
const CERTIFICATE_HORIZON_DAYS = 30;

/** The longest line RFC 5545 §3.1 allows, in octets, line break excluded. */
const MAX_LINE_OCTETS = 75;

/**
 * Renders renewals as an iCalendar file.
 *
 * Importing it again updates the same events rather than adding copies, because each
 * event's `UID` comes from what is being renewed. Two sites on one domain therefore
 * share one event, which names them both.
 *
 * @param renewals Everything found that expires.
 * @param now When the report was produced.
 * @returns The file, with CRLF line ends. Valid and empty when nothing qualifies.
 * @throws Never.
 */
export function renderCalendar(renewals: readonly Renewal[], now: Date): string {
  const events = new Map<string, Renewal & { sites: string[] }>();

  for (const renewal of renewals) {
    if (Number.isNaN(new Date(renewal.expiresAt).getTime())) continue;
    if (renewal.kind === 'certificate' && !withinHorizon(renewal.expiresAt, now)) continue;

    const uid = `${renewal.kind}-${renewal.subject}@${SERVER_NAME}`;
    const existing = events.get(uid);
    if (existing === undefined) events.set(uid, { ...renewal, sites: [renewal.site] });
    else if (!existing.sites.includes(renewal.site)) existing.sites.push(renewal.site);
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${SERVER_NAME}//${SERVER_VERSION}//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  for (const [uid, event] of [...events].sort(([left], [right]) => left.localeCompare(right))) {
    const label = event.kind === 'domain' ? 'Domain renewal' : 'Certificate expiry';
    const start = new Date(event.expiresAt);
    const description = [
      event.client === null ? null : `Client: ${event.client}`,
      `Sites: ${event.sites.join(', ')}`,
      `Expires: ${event.expiresAt}`,
    ].filter((line) => line !== null);

    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(uid)}`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${dateOnly(start)}`,
      `DTEND;VALUE=DATE:${dateOnly(new Date(start.getTime() + 86_400_000))}`,
      `SUMMARY:${escapeText(`${label}: ${event.subject}`)}`,
      `DESCRIPTION:${escapeText(description.join('\n'))}`,
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(`${label}: ${event.subject}`)}`,
      `TRIGGER:-${REMINDER[event.kind]}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.flatMap(fold).join('\r\n')}\r\n`;
}

/**
 * @param expiresAt An expiry, ISO 8601.
 * @param now The moment to measure from.
 * @returns Whether it is close enough to be worth an event, including already past.
 * @throws Never.
 */
function withinHorizon(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() - now.getTime() <= CERTIFICATE_HORIZON_DAYS * 86_400_000;
}

/**
 * @param date A moment.
 * @returns Its UTC date, as `YYYYMMDD`. Days until expiry are computed in UTC.
 * @throws Never.
 */
function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * @param date A moment.
 * @returns It as a UTC `DATE-TIME`, e.g. `20261001T120000Z`.
 * @throws Never.
 */
function stamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/**
 * @param text Free text.
 * @returns It, escaped as RFC 5545 §3.3.11 asks. A site's name can hold any of these.
 * @throws Never.
 */
function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Folds a line at 75 octets, without cutting a character in two.
 *
 * Octets rather than characters is the part that goes wrong: a client's name with
 * accents, as any Portuguese one has, otherwise produces a line too long, or a
 * character split across two.
 *
 * @param line One content line.
 * @returns It as one or more physical lines, continuations starting with a space.
 * @throws Never.
 */
function fold(line: string): string[] {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = '';
  let octets = 0;

  for (const character of line) {
    const size = encoder.encode(character).byteLength;
    if (octets + size > MAX_LINE_OCTETS) {
      lines.push(current);
      // The leading space counts towards the next line's allowance.
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  lines.push(current);

  return lines;
}
