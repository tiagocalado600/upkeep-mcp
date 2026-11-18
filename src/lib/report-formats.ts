import { explainFinding } from './finding-catalog.js';
import type { Severity } from '../types.js';

/**
 * Rendering a portfolio report for a person other than the one running the check.
 *
 * Deterministic on purpose. The dates, counts and what changed are the part a client
 * must be able to trust, so they are written here and never left to a model, which
 * keeps the narrative. Everything in here is a pure function of the report.
 */

/** One finding, as a client document needs it. */
export interface RenderedFinding {
  /** The stable code. */
  code: string;
  /** Its severity. */
  severity: Severity;
  /** The maintainer-facing message, used when the catalog has nothing. */
  message: string;
}

/** One site, as a client document needs it. */
export interface RenderedSite {
  /** The site as named in the portfolio. */
  name: string;
  /** The URL that was checked. */
  url: string;
  /** The client it belongs to, when the portfolio says. */
  client: string | null;
  /** The worst severity found. */
  severity: Severity;
  /** Days until the first thing about it expires, or `null`. */
  soonestExpiryDays: number | null;
  /** Everything found, worst first. */
  findings: readonly RenderedFinding[];
}

/** What changed, as a client document needs it. */
export interface RenderedChanges {
  /** Whether anything could be compared. */
  comparedWithPreviousRun: boolean;
  /** When the compared run happened. */
  previousRunAt: string | null;
  /** Why nothing could be compared. */
  previousRunUnavailable: string | null;
  /** Findings gone since then. */
  resolvedFindings: readonly { site: string; code: string; actionable: boolean }[];
  /** Findings that appeared since then. */
  newFindings: readonly { site: string; code: string }[];
  /** Findings present both times. */
  persistingFindings: readonly { site: string; code: string }[];
  /** Findings from then that could not be measured again, so neither fixed nor confirmed. */
  unmeasuredFindings: readonly { site: string; code: string; actionable: boolean }[];
  /** Findings not measured for so long that they are no longer compared. */
  findingsPastTheWindow: readonly {
    site: string;
    code: string;
    actionable: boolean;
    lastMeasuredAt: string;
  }[];
  /** Sites checked then and not now, with what they last had worth acting on. */
  sitesDroppedSinceBaseline: readonly { site: string; findings: readonly string[] }[];
  /** Sites checked now and not then, by name, so with nothing to compare. */
  newSites: readonly string[];
}

/** The report, as far as rendering is concerned. */
export interface RenderableReport {
  /** When it was produced. */
  generatedAt: string;
  /** Every site, most urgent first. */
  sites: readonly RenderedSite[];
  /** What changed. */
  changes: RenderedChanges;
  /** Anything the report could not do. */
  notes: readonly string[];
}

/** How each severity reads in a client document. */
const STATUS: Record<Severity, string> = {
  critical: 'Needs urgent action',
  warning: 'Needs attention',
  unknown: 'Could not be fully checked',
  info: 'Fine',
  ok: 'Fine',
};

/**
 * @param code A finding's code.
 * @param message Its own message, for a code the catalog does not know.
 * @returns What to tell the client.
 * @throws Never.
 */
function plainText(code: string, message: string): string {
  return explainFinding(code)?.plain ?? message;
}

/**
 * Keeps one site's name from breaking a Markdown table.
 *
 * A portfolio entry is free text, and this document is pasted straight into a report.
 *
 * @param text Free text.
 * @returns It, safe inside a table cell.
 * @throws Never.
 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Lists findings by site in client language.
 *
 * Several codes can read the same to a client — every accessibility rule a page
 * fails is "part of the site is harder to use" — and the same sentence three
 * times under one site reads as a report padded out, so a repeated sentence is
 * said once with a count.
 *
 * @param items Findings, each naming its site and code.
 * @param messages The maintainer-facing message for each, by site and code.
 * @returns One bullet per distinct sentence per site, in first-seen order.
 * @throws Never.
 */
function bullets(
  items: readonly { site: string; code: string }[],
  messages: ReadonlyMap<string, string>,
): string[] {
  const merged = new Map<string, { site: string; plain: string; count: number }>();
  for (const item of items) {
    const plain = plainText(item.code, messages.get(`${item.site}\u0000${item.code}`) ?? item.code);
    const key = `${item.site}\u0000${plain}`;
    const existing = merged.get(key);
    if (existing === undefined) merged.set(key, { site: item.site, plain, count: 1 });
    else existing.count += 1;
  }
  return [...merged.values()].map(
    ({ site, plain, count }) =>
      `- **${site}:** ${plain}${count > 1 ? ` (${String(count)} separate issues)` : ''}`,
  );
}

/**
 * Names, per site, how many of the findings listed above are in a list.
 *
 * For "still open": every one of them is already written out above, and the same
 * sentences a second time made the section the longest in the report.
 *
 * @param items Findings, each naming its site.
 * @returns e.g. `Bakery (3), Florist (1)`.
 * @throws Never.
 */
function perSite(items: readonly { site: string }[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.site, (counts.get(item.site) ?? 0) + 1);
  return [...counts].map(([site, count]) => `${site} (${String(count)})`).join(', ');
}

/**
 * When the compared check happened, precise enough to tell it from this one.
 *
 * @param at The compared check, ISO 8601.
 * @param now This report, ISO 8601.
 * @returns The date, plus the time in UTC when both fall on the same day:
 *   "compared with the check on 2026-11-18" said nothing of a check from this
 *   morning.
 * @throws Never.
 */
function comparedOn(at: string, now: string): string {
  const day = at.slice(0, 10);
  return day === now.slice(0, 10) ? `${day} at ${at.slice(11, 16)} UTC` : day;
}

/**
 * Findings that mean a site's domain renewal date is not known. Informational on
 * their own, which keeps them out of what a client is asked to act on, and the table
 * would otherwise show the certificate's date as the site's next renewal.
 */
const DOMAIN_DATE_UNKNOWN = new Set([
  'registration_expiry_unavailable',
  'registration_lookup_failed',
  'domain_check_failed',
]);

/**
 * @param days Days until the first thing expires, or `null`.
 * @returns How that reads in a client document, including when it has already passed.
 * @throws Never.
 */
function nextRenewal(days: number | null): string {
  if (days === null) return 'Not known';
  if (days < 0) return 'Expired';
  if (days === 0) return 'Today';
  return days === 1 ? 'Tomorrow' : `In ${String(days)} days`;
}

/**
 * Renders the block of a maintenance report that can be pasted without correction.
 *
 * @param report The report.
 * @param title What the document is about: a client's name, or a portfolio.
 * @returns Markdown. Dates are ISO 8601, so the document never depends on a locale.
 * @throws Never.
 */
export function renderMarkdown(report: RenderableReport, title: string): string {
  const messages = new Map<string, string>();
  for (const site of report.sites) {
    for (const item of site.findings) messages.set(`${site.name}\u0000${item.code}`, item.message);
  }

  const urgent = report.sites.filter((site) => site.severity === 'critical').length;
  const attention = report.sites.filter((site) => site.severity === 'warning').length;
  const unknown = report.sites.filter((site) => site.severity === 'unknown').length;
  const count = report.sites.length;
  const sites = `${String(count)} site${count === 1 ? '' : 's'}`;

  const lines = [
    `# Website maintenance: ${title}`,
    '',
    `Checked on ${report.generatedAt.slice(0, 10)}.`,
    '',
  ];

  if (urgent === 0 && attention === 0 && unknown === 0) {
    lines.push(
      count === 1 ? 'The site checked is in order.' : `All ${sites} checked are in order.`,
    );
  } else {
    const parts = [
      urgent > 0 ? `${String(urgent)} need${urgent === 1 ? 's' : ''} urgent action` : null,
      attention > 0 ? `${String(attention)} need${attention === 1 ? 's' : ''} attention` : null,
      unknown > 0 ? `${String(unknown)} could not be fully checked` : null,
    ].filter((part) => part !== null);
    lines.push(`Of the ${sites} checked, ${parts.join(', ')}.`);
  }

  const actionable = report.sites.flatMap((site) =>
    site.findings
      .filter((item) => item.severity === 'critical' || item.severity === 'warning')
      .map((item) => ({ site: site.name, code: item.code, message: item.message })),
  );
  const needClient = actionable.filter((item) => explainFinding(item.code)?.needsClient === true);
  const handled = actionable.filter((item) => explainFinding(item.code)?.needsClient !== true);

  if (needClient.length > 0) {
    lines.push('', '## What needs a decision from you', '', ...bullets(needClient, messages));
  }
  if (handled.length > 0) {
    lines.push('', '## What we are dealing with', '', ...bullets(handled, messages));
  }

  // Informational findings stay out of what a client is told changed. An optional
  // header being absent, quarter after quarter, is the padding a report is read past.
  const matters = new Set(actionable.map((item) => `${item.site}\u0000${item.code}`));
  const worthSaying = (items: readonly { site: string; code: string }[]) =>
    items.filter((item) => matters.has(`${item.site}\u0000${item.code}`));

  const { changes } = report;
  const appeared = worthSaying(changes.newFindings);
  const open = worthSaying(changes.persistingFindings);
  const resolved = changes.resolvedFindings.filter((item) => item.actionable);
  const unconfirmed = changes.unmeasuredFindings.filter((item) => item.actionable);

  lines.push('', '## What changed');
  if (!changes.comparedWithPreviousRun) {
    lines.push(
      '',
      `Nothing could be compared with an earlier check${changes.previousRunUnavailable === null ? '' : `: ${changes.previousRunUnavailable}`}.`,
    );
  } else {
    lines.push(
      '',
      `Compared with the check on ${comparedOn(changes.previousRunAt ?? '', report.generatedAt)}.`,
    );
    const added = report.sites.filter((site) => changes.newSites.includes(site.name));
    if (
      resolved.length === 0 &&
      appeared.length === 0 &&
      open.length === 0 &&
      unconfirmed.length === 0 &&
      added.length === 0 &&
      changes.sitesDroppedSinceBaseline.length === 0
    ) {
      lines.push('', 'Nothing that needs attention, then or now.');
    }
    if (resolved.length > 0) {
      lines.push('', '**Resolved:**', '', ...bullets(resolved, messages));
    }
    if (appeared.length > 0) {
      lines.push('', '**New:**', '', ...bullets(appeared, messages));
    }
    if (added.length > 0) {
      // Their findings are not "new" in the comparison, which only sets like
      // against like; without this a site added since then appears nowhere here.
      lines.push(
        '',
        '**Added since then:**',
        '',
        ...added.map((site) => {
          const actionable = site.findings.filter(
            (item) => item.severity === 'critical' || item.severity === 'warning',
          ).length;
          return `- **${site.name}:** ${
            actionable === 0
              ? 'nothing that needs attention.'
              : `${String(actionable)} ${actionable === 1 ? 'issue' : 'issues'} listed above.`
          }`;
        }),
      );
    }
    if (open.length > 0) {
      lines.push('', `**Still open** (listed above): ${perSite(open)}.`);
    }
    if (unconfirmed.length > 0) {
      lines.push(
        '',
        '**Could not be checked again this time:**',
        '',
        ...bullets(unconfirmed, messages),
      );
    }
  }
  const stale = changes.findingsPastTheWindow.filter((item) => item.actionable);
  if (stale.length > 0) {
    // Said rather than dropped: a problem that simply stops being mentioned reads as fixed.
    lines.push(
      '',
      '**Not checked for too long, so to be confirmed by hand:**',
      '',
      ...bullets(stale, messages).map(
        (line, index) =>
          `${line} Last checked on ${(stale[index]?.lastMeasuredAt ?? '').slice(0, 10)}.`,
      ),
    );
  }
  if (changes.sitesDroppedSinceBaseline.length > 0) {
    // Said even when nothing else compared: a site quietly gone from the report reads
    // as a site that is fine.
    lines.push(
      '',
      '**No longer checked:**',
      '',
      ...changes.sitesDroppedSinceBaseline.map(
        (item) =>
          `- **${item.site}:** not in this report.` +
          (item.findings.length > 0
            ? ` When last checked: ${item.findings.map((code) => plainText(code, code)).join(' ')}`
            : ''),
      ),
    );
  }

  lines.push(
    '',
    '## Every site',
    '',
    '| Site | Status | Next renewal |',
    '| --- | --- | --- |',
    ...report.sites.map(
      (site) =>
        `| ${cell(site.name)} | ${STATUS[site.severity]} | ${nextRenewal(site.soonestExpiryDays)} |`,
    ),
  );

  const undated = report.sites.filter((site) =>
    site.findings.some((item) => DOMAIN_DATE_UNKNOWN.has(item.code)),
  );
  if (undated.length > 0) {
    lines.push(
      '',
      `The domain renewal date is not known for ${undated.map((site) => site.name).join(', ')}, ` +
        'so "Next renewal" above does not include it; check it with the registrar.',
    );
  }

  if (report.notes.length > 0) {
    lines.push('', '## Notes', '', ...report.notes.map((note) => `- ${note}`));
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Quotes one CSV field, and defuses it for a spreadsheet.
 *
 * A site's name, and a message quoting what a server said, are text someone else
 * chose. A spreadsheet runs a cell beginning with `=`, `+`, `-` or `@` as a formula,
 * so those get a leading apostrophe, which is the standard defence.
 *
 * @param value The field.
 * @returns It, as RFC 4180 asks.
 * @throws Never.
 */
function csvField(value: string): string {
  // A plain number is not a formula, and an apostrophe would turn `-3` into text in the
  // one column meant to be sorted, for exactly the things already expired.
  const safe = /^[=+\-@\t\r]/.test(value) && !/^-?\d+$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Renders one row per finding, plus one per site with none, so no site goes missing.
 *
 * @param report The report.
 * @returns CSV with a header row and CRLF line ends, per RFC 4180.
 * @throws Never.
 */
export function renderCsv(report: RenderableReport): string {
  const rows = [
    [
      'client',
      'site',
      'url',
      'site_status',
      'soonest_expiry_days',
      'severity',
      'code',
      'plain',
      'message',
    ],
  ];

  for (const site of report.sites) {
    const start = [
      site.client ?? '',
      site.name,
      site.url,
      site.severity,
      site.soonestExpiryDays === null ? '' : String(site.soonestExpiryDays),
    ];
    if (site.findings.length === 0) rows.push([...start, '', '', '', '']);
    for (const item of site.findings) {
      rows.push([
        ...start,
        item.severity,
        item.code,
        plainText(item.code, item.message),
        item.message,
      ]);
    }
  }

  return `${rows.map((row) => row.map(csvField).join(',')).join('\r\n')}\r\n`;
}
