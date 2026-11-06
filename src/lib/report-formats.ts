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
  resolvedFindings: readonly { site: string; code: string }[];
  /** Findings that appeared since then. */
  newFindings: readonly { site: string; code: string }[];
  /** Findings present both times. */
  persistingFindings: readonly { site: string; code: string }[];
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
 * @param items Findings, each naming its site and code.
 * @param messages The maintainer-facing message for each, by site and code.
 * @returns One bullet per finding.
 * @throws Never.
 */
function bullets(
  items: readonly { site: string; code: string }[],
  messages: ReadonlyMap<string, string>,
): string[] {
  return items.map(
    (item) =>
      `- **${item.site}:** ${plainText(item.code, messages.get(`${item.site}\u0000${item.code}`) ?? item.code)}`,
  );
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

  const { changes } = report;
  lines.push('', '## What changed');
  if (!changes.comparedWithPreviousRun) {
    lines.push(
      '',
      `Nothing could be compared with an earlier check${changes.previousRunUnavailable === null ? '' : `: ${changes.previousRunUnavailable}`}.`,
    );
  } else {
    lines.push('', `Compared with the check on ${(changes.previousRunAt ?? '').slice(0, 10)}.`);
    if (
      changes.resolvedFindings.length === 0 &&
      changes.newFindings.length === 0 &&
      changes.persistingFindings.length === 0
    ) {
      lines.push('', 'No issues then or now.');
    }
    if (changes.resolvedFindings.length > 0) {
      lines.push('', '**Resolved:**', '', ...bullets(changes.resolvedFindings, messages));
    }
    if (changes.newFindings.length > 0) {
      lines.push('', '**New:**', '', ...bullets(changes.newFindings, messages));
    }
    if (changes.persistingFindings.length > 0) {
      lines.push('', '**Still open:**', '', ...bullets(changes.persistingFindings, messages));
    }
  }

  lines.push(
    '',
    '## Every site',
    '',
    '| Site | Status | Next renewal |',
    '| --- | --- | --- |',
    ...report.sites.map(
      (site) =>
        `| ${cell(site.name)} | ${STATUS[site.severity]} | ${site.soonestExpiryDays === null ? 'Not known' : `In ${String(site.soonestExpiryDays)} days`} |`,
    ),
  );

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
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
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
