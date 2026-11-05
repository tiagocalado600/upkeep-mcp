import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import * as z from 'zod/v4';
import { TTL } from './defaults.js';
import { CHECK_NAMES, type CheckName } from './portfolio.js';
import type { Severity } from '../types.js';

/**
 * What the last portfolio run found, so the next one can say what changed.
 *
 * Held in memory by default and written nowhere. A portfolio file names a
 * person's clients, and "what was wrong with which client site last Tuesday" is
 * not something this server puts on someone's disk uninvited —
 * `docs/adr/0011-in-memory-run-history.md` is the reasoning, and it ends by
 * saying that persistence, if it ever arrives, belongs behind this same
 * interface and has to be opted into.
 *
 * That is what a `history` path in the portfolio file is:
 * `docs/adr/0018-opt-in-history-file.md`. The user names a file, in the file
 * they already keep and already know the location of, and this server writes one
 * snapshot to it. Without that line nothing changes and nothing is written.
 */

/** One site's outcome, reduced to what a comparison needs. */
export interface SiteOutcome {
  /** The worst severity found for that site. */
  severity: Severity;
  /** The finding codes reported, so new problems can be named. */
  codes: string[];
  /**
   * Which checks produced it.
   *
   * Without this a comparison lies. The tool's own description recommends a
   * quick `checks: ["uptime"]` pass; comparing that against a full run would
   * report every certificate and registration finding as newly appeared, or —
   * worse, in the other order — announce that a site with a certificate
   * expiring in three days has improved from critical to ok.
   */
  checks: CheckName[];
}

/** The outcome of one whole run. */
export interface RunSnapshot {
  /** When the run happened, ISO 8601 UTC. */
  takenAt: string;
  /** Outcomes keyed by site URL. */
  sites: Record<string, SiteOutcome>;
  /**
   * The version that took it, when known. A finding absent from an older snapshot
   * may be one that version could not measure, and a reader has to be told.
   */
  serverVersion?: string | undefined;
}

/**
 * Where one portfolio's history lives.
 *
 * Per call rather than per server, because the answer comes out of the portfolio
 * file being reported on: two portfolios checked by one server keep separate
 * histories, and a report over sites passed inline keeps none at all.
 */
export type HistoryStore =
  /** This process's memory, lost on restart. The default, and what the user gets unasked. */
  | {
      kind: 'memory';
      /** The portfolio file it belongs to, or `null` for sites passed inline. */
      portfolio: string | null;
    }
  /** A file the user named in their portfolio. */
  | { kind: 'file'; path: string };

/** What there was to compare against, and why there was nothing when there was nothing. */
export interface PreviousRun {
  /** The previous run, or `null` when there is none usable. */
  snapshot: RunSnapshot | null;
  /**
   * Why there is none, worded to be read aloud — `no history file at /…/x.json
   * yet; this run creates it`. `null` when there is one.
   *
   * Never silence. An empty list of regressions must not be readable as
   * "nothing regressed", and a history file that exists but could not be read
   * must not be readable as "this is the first run".
   */
  unavailableReason: string | null;
}

/** Whether a run was recorded, and why not when it was not. */
export interface RecordOutcome {
  /** Whether the snapshot was stored. */
  stored: boolean;
  /** Why it was not, or `null` when it was. */
  reason: string | null;
}

/** Storage for the previous run. */
export interface RunHistory {
  /**
   * The last recorded run for a portfolio.
   *
   * @param store Where that portfolio's history lives.
   * @param now The moment to measure the snapshot's age against.
   */
  previous(store: HistoryStore, now: Date): Promise<PreviousRun>;
  /**
   * Records a run, replacing whatever was there. {@link mergeRun} decides what
   * that is, so a narrower run does not erase a wider one.
   *
   * @param store Where that portfolio's history lives.
   * @param snapshot What this run found.
   */
  record(store: HistoryStore, snapshot: RunSnapshot): Promise<RecordOutcome>;
  /**
   * A baseline saved under a name, for comparing against a chosen moment rather
   * than against whichever run happened to be last.
   *
   * @param store Where that portfolio's history lives.
   * @param name The name it was saved under.
   * @param now The moment to measure its age against.
   */
  baseline(store: HistoryStore, name: string, now: Date): Promise<PreviousRun>;
  /**
   * Saves a named baseline, replacing one of the same name.
   *
   * @param store Where that portfolio's history lives.
   * @param name The name to save it under.
   * @param snapshot The outcome to keep.
   */
  saveBaseline(store: HistoryStore, name: string, snapshot: RunSnapshot): Promise<RecordOutcome>;
}

/**
 * The on-disk form.
 *
 * Versioned from the first release that writes one. A file this server both
 * writes and reads back is a format, and a format with no version is one that
 * can never change without silently misreading its own past output.
 */
const snapshotFields = {
  takenAt: z.iso.datetime(),
  sites: z.record(
    z.string(),
    z.object({
      severity: z.enum(['ok', 'info', 'warning', 'critical', 'unknown']),
      codes: z.array(z.string()),
      checks: z.array(z.enum(CHECK_NAMES)),
    }),
  ),
  serverVersion: z.string().optional(),
};

/** Version 1 is one snapshot; version 2 adds named baselines beside it. */
const fileSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  ...snapshotFields,
  baselines: z.record(z.string(), z.object(snapshotFields)).optional(),
});

/**
 * Permissions for a history file this server creates.
 *
 * Owner read and write, nothing else. The file names a person's client sites and
 * says which of them were broken; on a shared machine the default umask would
 * hand that to every other account on it. Applied at creation only, which is
 * what `writeFile` supports — a file the user has since widened is theirs to
 * widen.
 */
const OWNER_ONLY = 0o600;

/**
 * Works out where a portfolio's history belongs.
 *
 * A relative path is resolved against the portfolio file's own directory, not
 * against the working directory. That is the difference between a working
 * setting and a puzzling one: a desktop MCP client starts this server in `/`,
 * which `portfolio_report`'s own input description already warns about, so
 * `"history": "upkeep-history.json"` has to mean "beside my sites.json" or it
 * means nothing anyone can predict.
 *
 * @param portfolioFile The portfolio file being reported on, or `null` when the
 *   sites were passed inline.
 * @param setting The `history` path from that file, or `null` when it names none.
 * @returns Where to keep the history. Memory whenever the user has not asked for
 *   otherwise, and memory for an inline portfolio, which has no file to sit
 *   beside and no identity to persist under.
 * @throws Never.
 */
export function historyStoreFor(
  portfolioFile: string | null,
  setting: string | null,
): HistoryStore {
  const memory: HistoryStore = {
    kind: 'memory',
    portfolio: portfolioFile === null ? null : resolve(portfolioFile),
  };
  if (setting === null) return memory;
  if (isAbsolute(setting)) return { kind: 'file', path: setting };
  if (portfolioFile === null) return memory;

  return { kind: 'file', path: resolve(dirname(resolve(portfolioFile)), setting) };
}

/** Why a name means nothing without a file, and what works instead. */
const NO_NAMED_BASELINE_IN_MEMORY =
  'a named baseline needs a portfolio file with a "history" path. Without one, ask for ' +
  '"includeSnapshot", keep the snapshot it returns, and pass it back as "baselineSnapshot"';

/**
 * Creates run history that keeps a snapshot in memory and nowhere else.
 *
 * A file store handed to this is honoured in memory: it is the fallback for a
 * server that must not write, and the implementation tests inject when they are
 * testing something other than the file itself.
 *
 * @returns History holding exactly one snapshot per store. Keeping more would be
 *   a database with extra steps, and the report only ever asks "what changed
 *   since last time".
 * @throws Never.
 */
export function createMemoryHistory(): RunHistory {
  const byStore = new Map<string, RunSnapshot>();

  return {
    previous: (store, now) => {
      const snapshot = byStore.get(keyOf(store)) ?? null;
      if (snapshot === null) {
        return Promise.resolve({
          snapshot: null,
          unavailableReason: firstRunReason(store),
        });
      }
      return Promise.resolve(withinWindow(snapshot, now, 'this server started'));
    },
    record: (store, snapshot) => {
      byStore.set(keyOf(store), snapshot);
      return Promise.resolve({ stored: true, reason: null });
    },
    // Refused rather than kept here. One process serves every caller of a public
    // instance, and a name is something another caller could guess or overwrite.
    baseline: () =>
      Promise.resolve({ snapshot: null, unavailableReason: NO_NAMED_BASELINE_IN_MEMORY }),
    saveBaseline: () =>
      Promise.resolve({
        stored: false,
        reason: `the baseline was not saved: ${NO_NAMED_BASELINE_IN_MEMORY}`,
      }),
  };
}

/**
 * Creates run history that honours a file store.
 *
 * @returns History that keeps a memory store in memory and a file store in the
 *   file the user named. Nothing is written unless a portfolio asked for it.
 * @throws Never.
 */
export function createDurableHistory(): RunHistory {
  const memory = createMemoryHistory();

  return {
    previous: async (store, now) => {
      if (store.kind === 'memory') return memory.previous(store, now);

      let text: string;
      try {
        text = await readFile(store.path, 'utf8');
      } catch (cause) {
        const code = (cause as { code?: string }).code;
        return {
          snapshot: null,
          unavailableReason:
            code === 'ENOENT'
              ? `there is no history file at ${store.path} yet, so this run creates one`
              : `the history file at ${store.path} could not be read: ${messageOf(cause)}`,
        };
      }

      const parsed = parseHistory(text);
      if (parsed === null) {
        // Saying so is required, because "unreadable" must not read as "first run".
        return {
          snapshot: null,
          unavailableReason:
            `the file at ${store.path} is not one this server wrote, so it was ignored and left ` +
            'alone; point "history" at another path, or remove the file',
        };
      }

      return withinWindow(parsed.latest, now, `the file at ${store.path} was written`);
    },

    record: async (store, snapshot) => {
      if (store.kind === 'memory') return memory.record(store, snapshot);
      return writeHistory(store.path, snapshot.takenAt, (current) => ({
        latest: snapshot,
        baselines: current?.baselines ?? {},
      }));
    },

    baseline: async (store, name, now) => {
      if (store.kind === 'memory') return memory.baseline(store, name, now);

      const state = await readHistory(store.path);
      if (state.kind === 'unreadable') return { snapshot: null, unavailableReason: state.reason };
      const snapshot = state.kind === 'ours' ? state.baselines[name] : undefined;
      if (snapshot === undefined) {
        const known = state.kind === 'ours' ? Object.keys(state.baselines).sort() : [];
        return {
          snapshot: null,
          unavailableReason:
            `${store.path} holds no baseline named "${name}"` +
            (known.length > 0 ? ` (it holds ${known.join(', ')})` : ''),
        };
      }
      return withinBaselineWindow(snapshot, now);
    },

    saveBaseline: async (store, name, snapshot) => {
      if (store.kind === 'memory') return memory.saveBaseline(store, name, snapshot);
      return writeHistory(store.path, snapshot.takenAt, (current) => ({
        latest: current?.latest ?? snapshot,
        baselines: { ...(current?.baselines ?? {}), [name]: snapshot },
      }));
    },
  };
}

/** What a history path holds. */
type HistoryState =
  | { kind: 'absent' }
  | { kind: 'ours'; latest: RunSnapshot; baselines: Record<string, RunSnapshot> }
  | { kind: 'foreign' }
  | { kind: 'unreadable'; reason: string };

/**
 * @param path The history file.
 * @returns What is there. Never throws: every outcome is something to report.
 * @throws Never.
 */
async function readHistory(path: string): Promise<HistoryState> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    return (cause as { code?: string }).code === 'ENOENT'
      ? { kind: 'absent' }
      : {
          kind: 'unreadable',
          reason: `the history file at ${path} could not be read: ${messageOf(cause)}`,
        };
  }
  const parsed = parseHistory(text);
  return parsed === null ? { kind: 'foreign' } : { kind: 'ours', ...parsed };
}

/**
 * Rewrites the history file, keeping whatever `update` keeps.
 *
 * Asked before every write, because being wrong here is not recoverable: a
 * `history` line naming the portfolio itself, or any other JSON file, would
 * otherwise replace something hand-kept and possibly not in git.
 *
 * @param path The history file.
 * @param now The moment to measure stored baselines against, so an expired one is
 *   dropped rather than kept for ever.
 * @param update What to write, given what is there.
 * @returns Whether it was written, and why not when it was not. A report that found
 *   an expired certificate is worth having even when it cannot be filed.
 * @throws Never.
 */
async function writeHistory(
  path: string,
  now: string,
  update: (current: { latest: RunSnapshot; baselines: Record<string, RunSnapshot> } | null) => {
    latest: RunSnapshot;
    baselines: Record<string, RunSnapshot>;
  },
): Promise<RecordOutcome> {
  const state = await readHistory(path);
  if (state.kind === 'unreadable') {
    return { stored: false, reason: `this run could not be recorded: ${state.reason}` };
  }
  if (state.kind === 'foreign') {
    return {
      stored: false,
      reason:
        `this run was not recorded, because ${path} is not a history file this server wrote ` +
        'and it will not be overwritten',
    };
  }

  const next = update(state.kind === 'ours' ? state : null);
  const cutoff = new Date(now).getTime() - TTL.baselineMs;
  const baselines = Object.fromEntries(
    Object.entries(next.baselines).filter(
      ([, snapshot]) => new Date(snapshot.takenAt).getTime() >= cutoff,
    ),
  );

  try {
    await writeFile(
      path,
      `${JSON.stringify({ version: 2, ...next.latest, baselines }, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: OWNER_ONLY,
      },
    );
    return { stored: true, reason: null };
  } catch (cause) {
    return {
      stored: false,
      reason: `this run could not be recorded to ${path}: ${messageOf(cause)}`,
    };
  }
}

/**
 * Wraps a snapshot for a caller to keep and hand back later.
 *
 * How a hosted instance can compare across quarters while storing nothing. The
 * checksum is there because the caller is often a model copying JSON, and a
 * snapshot quietly altered in transit would produce a confident, wrong comparison.
 *
 * @param snapshot The outcome to hand over.
 * @returns The snapshot and its checksum.
 * @throws Never.
 */
export function sealSnapshot(snapshot: RunSnapshot): RunSnapshot & { checksum: string } {
  return { ...snapshot, checksum: checksumOf(snapshot) };
}

/**
 * Reads back a snapshot a caller was holding.
 *
 * @param sealed What the caller passed.
 * @param now The moment to measure its age against.
 * @returns The snapshot, or why it cannot be compared against.
 * @throws Never.
 */
export function openSnapshot(sealed: unknown, now: Date): PreviousRun {
  const parsed = sealedSchema.safeParse(sealed);
  if (!parsed.success) {
    return {
      snapshot: null,
      unavailableReason:
        '"baselineSnapshot" is not a snapshot this server returned; pass the "snapshot" field of an earlier report unchanged',
    };
  }

  const { checksum, ...snapshot } = parsed.data;
  if (checksumOf(snapshot) !== checksum) {
    return {
      snapshot: null,
      unavailableReason:
        '"baselineSnapshot" was changed after this server returned it (its checksum no longer matches); pass it back unchanged',
    };
  }
  return withinBaselineWindow(snapshot, now);
}

/** The form a caller holds a snapshot in. */
const sealedSchema = z.object({ ...snapshotFields, checksum: z.string() });

/**
 * @param snapshot A snapshot.
 * @returns A checksum that ignores key order, which JSON does not preserve in transit.
 * @throws Never.
 */
function checksumOf(snapshot: RunSnapshot): string {
  const sites = Object.keys(snapshot.sites)
    .sort()
    .map((key) => {
      const outcome = snapshot.sites[key];
      return [key, outcome?.severity, outcome?.codes, outcome?.checks];
    });
  return createHash('sha256')
    .update(JSON.stringify([snapshot.takenAt, snapshot.serverVersion ?? null, sites]))
    .digest('hex');
}

/**
 * @param snapshot A named baseline or a snapshot a caller held on to.
 * @param now The moment to measure against.
 * @returns It, or nothing with its age explained.
 * @throws Never.
 */
function withinBaselineWindow(snapshot: RunSnapshot, now: Date): PreviousRun {
  const ageMs = now.getTime() - new Date(snapshot.takenAt).getTime();
  if (ageMs <= TTL.baselineMs) return { snapshot, unavailableReason: null };
  return {
    snapshot: null,
    unavailableReason:
      `that baseline was taken on ${snapshot.takenAt.slice(0, 10)}, more than ` +
      `${String(Math.floor(TTL.baselineMs / 86_400_000))} days ago, which is as long as one is kept`,
  };
}

/**
 * Decides what a run leaves behind for the next one to compare against.
 *
 * A narrower run must not erase a wider one. The tool itself recommends a quick
 * `checks: ["uptime"]` pass between full reports, and a tag filter reports on
 * part of a portfolio; replacing the snapshot with either wiped the baseline the
 * next quarterly comparison depends on.
 *
 * A site keeps its earlier outcome when this run measured less of it than that
 * outcome did, and whatever a tag filter left out stays. The result keeps the
 * earlier `takenAt` whenever anything was kept, so the comparison window is
 * measured from the oldest outcome it holds.
 *
 * @param previous The usable earlier snapshot, or `null` when there is none.
 * @param current What this run found.
 * @param partial Whether this run deliberately covered part of the portfolio. A
 *   full run drops sites that left it; a partial one cannot tell them apart from
 *   those it filtered out.
 * @returns The snapshot to record.
 * @throws Never.
 */
export function mergeRun(
  previous: RunSnapshot | null,
  current: RunSnapshot,
  partial: boolean,
): RunSnapshot {
  if (previous === null) return current;

  const sites: RunSnapshot['sites'] = {};
  let keptAnything = false;

  if (partial) {
    for (const [key, outcome] of Object.entries(previous.sites)) {
      if (current.sites[key] === undefined) {
        sites[key] = outcome;
        keptAnything = true;
      }
    }
  }

  for (const [key, outcome] of Object.entries(current.sites)) {
    const before = previous.sites[key];
    const narrower = before?.checks.some((check) => !outcome.checks.includes(check)) ?? false;
    sites[key] = narrower && before !== undefined ? before : outcome;
    if (narrower) keptAnything = true;
  }

  return {
    takenAt: keptAnything ? previous.takenAt : current.takenAt,
    sites,
    serverVersion: keptAnything ? previous.serverVersion : current.serverVersion,
  };
}

/**
 * Refuses a snapshot too old to be called "last time".
 *
 * A baseline from two quarters ago compares this week against a portfolio where
 * every certificate has since renewed twice. It is not wrong so much as
 * meaningless, and a report that says "improved since March" in a weekly review
 * is noise dressed as information.
 *
 * @param snapshot The snapshot that was found.
 * @param now The moment to measure against.
 * @param since How the snapshot got there, for the message.
 * @returns The snapshot, or nothing with the age explained.
 * @throws Never.
 */
function withinWindow(snapshot: RunSnapshot, now: Date, since: string): PreviousRun {
  const ageMs = now.getTime() - new Date(snapshot.takenAt).getTime();
  if (Number.isNaN(ageMs) || ageMs <= TTL.historyMs) {
    return { snapshot, unavailableReason: null };
  }

  const days = Math.floor(ageMs / 86_400_000);
  const window = Math.floor(TTL.historyMs / 86_400_000);
  return {
    snapshot: null,
    unavailableReason:
      `the last recorded run was ${snapshot.takenAt.slice(0, 10)}, ${String(days)} days ago and ` +
      `past the ${String(window)}-day window a comparison uses, so ${since} is where this ` +
      'report starts from',
  };
}

/**
 * @param store Where the history lives.
 * @returns Why a first run has nothing to compare against, said in the terms
 *   that apply to that store.
 * @throws Never.
 */
function firstRunReason(store: HistoryStore): string {
  return store.kind === 'file'
    ? `no run has been recorded to ${store.path} yet`
    : 'this server has not run a report on this portfolio before, and the portfolio names no ' +
        'history file, so nothing survived the last restart';
}

/**
 * @param text The file contents.
 * @returns The latest snapshot and its baselines, or `null` when the text is not
 *   one this server wrote.
 * @throws Never.
 */
function parseHistory(
  text: string,
): { latest: RunSnapshot; baselines: Record<string, RunSnapshot> } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return null;

  const { takenAt, sites, serverVersion, baselines } = parsed.data;
  return { latest: { takenAt, sites, serverVersion }, baselines: baselines ?? {} };
}

/**
 * @param store Where the history lives.
 * @returns A key that separates one portfolio's history from another's within
 *   one process, so a server asked about two portfolios does not compare one
 *   against the other.
 * @throws Never.
 */
function keyOf(store: HistoryStore): string {
  return store.kind === 'memory' ? `memory:${store.portfolio ?? 'inline'}` : `file:${store.path}`;
}

/**
 * @param cause Whatever was thrown.
 * @returns Its message, or its rendering when it is not an error.
 * @throws Never.
 */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
