import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TTL } from '../../src/lib/defaults.js';
import {
  createDurableHistory,
  createMemoryHistory,
  cannotReplaceInPlace,
  historyStoreFor,
  mergeRun,
  openSnapshot,
  sealSnapshot,
  type HistoryStore,
  type RunSnapshot,
} from '../../src/lib/history.js';
import type { CheckName } from '../../src/lib/portfolio.js';
import type { Severity } from '../../src/types.js';

/**
 * Run history, and the one thing it must never do: make an empty answer look
 * like a calm one.
 *
 * Every path through this module ends in either a snapshot or a sentence
 * explaining why there is none. A first run, a file that is not there yet, a
 * file somebody else wrote, a baseline from two quarters ago and a directory
 * that cannot be written to are five different situations, and a report that
 * renders them all as "no change" is worse than one that never compared.
 */

const MEMORY: HistoryStore = { kind: 'memory', portfolio: null };
const NOW = new Date('2026-09-06T12:00:00.000Z');

/**
 * @param overrides Fields to change.
 * @returns A snapshot of one site.
 */
function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    takenAt: '2026-09-05T12:00:00.000Z',
    sites: {
      'https://example.com/': { severity: 'warning', codes: ['a'], checks: ['uptime'] },
    },
    ...overrides,
  };
}

describe('historyStoreFor', () => {
  it('is memory when the portfolio names no history file', () => {
    // The default, and the whole of the opt-in: without that line the server
    // writes nothing at all.
    expect(historyStoreFor('/Users/you/sites.json', null)).toEqual({
      kind: 'memory',
      portfolio: '/Users/you/sites.json',
    });
  });

  it('resolves a relative path against the portfolio file, not the working directory', () => {
    // A desktop client starts this server in `/`. Resolving against the working
    // directory would put a file named after the user's clients at `/`, or fail,
    // and either way "beside my sites.json" is the only reading anyone intends.
    expect(historyStoreFor('/Users/you/clients/sites.json', 'upkeep-history.json')).toEqual({
      kind: 'file',
      path: '/Users/you/clients/upkeep-history.json',
    });
  });

  it('takes an absolute path as given', () => {
    expect(historyStoreFor('/Users/you/sites.json', '/var/tmp/h.json')).toEqual({
      kind: 'file',
      path: '/var/tmp/h.json',
    });
  });

  it('is memory for an inline portfolio, which has no file to sit beside', () => {
    expect(historyStoreFor(null, 'upkeep-history.json')).toEqual(MEMORY);
  });
});

describe('createMemoryHistory', () => {
  it('says why a first run has nothing to compare against', async () => {
    const previous = await createMemoryHistory().previous(MEMORY, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/nothing survived the last restart/);
  });

  it('returns the run it was given', async () => {
    const history = createMemoryHistory();
    await history.record(MEMORY, snapshot());

    expect((await history.previous(MEMORY, NOW)).snapshot).toEqual(snapshot());
  });

  it('keeps only the most recent run', async () => {
    const history = createMemoryHistory();
    await history.record(MEMORY, snapshot({ takenAt: '2026-09-04T12:00:00.000Z' }));
    await history.record(MEMORY, snapshot({ takenAt: '2026-09-05T12:00:00.000Z' }));

    expect((await history.previous(MEMORY, NOW)).snapshot?.takenAt).toBe(
      '2026-09-05T12:00:00.000Z',
    );
  });

  it('keeps two portfolios apart', async () => {
    // One server may be asked about several portfolios. Comparing one against
    // the other would report every site of each as new, every time.
    const history = createMemoryHistory();
    const a: HistoryStore = { kind: 'file', path: '/a.json' };
    const b: HistoryStore = { kind: 'file', path: '/b.json' };

    await history.record(a, snapshot());

    expect((await history.previous(a, NOW)).snapshot).not.toBeNull();
    expect((await history.previous(b, NOW)).snapshot).toBeNull();
  });

  it('does not share state between instances', async () => {
    const first = createMemoryHistory();
    await first.record(MEMORY, snapshot());

    expect((await createMemoryHistory().previous(MEMORY, NOW)).snapshot).toBeNull();
  });
});

describe('createDurableHistory', () => {
  let directory: string;
  let store: HistoryStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'upkeep-history-'));
    store = { kind: 'file', path: join(directory, 'upkeep-history.json') };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('writes nothing at all for a memory store', async () => {
    // The default path through this code. A portfolio that did not ask for a
    // file must not get one.
    const history = createDurableHistory();
    await history.record(MEMORY, snapshot());

    await expect(readFile(join(directory, 'upkeep-history.json'), 'utf8')).rejects.toThrow();
  });

  it('survives a restart, which is the whole point', async () => {
    await createDurableHistory().record(store, snapshot());

    // A second instance stands in for a second server process: it shares no
    // memory with the first, so anything it finds came off the disk.
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toEqual(snapshot());
    expect(previous.unavailableReason).toBeNull();
  });

  it('writes a file only its owner can read', async () => {
    // It names a person's clients and says which of them were broken. On a
    // shared machine the default umask would hand that to every other account.
    await createDurableHistory().record(store, snapshot());
    const mode = (await stat((store as { path: string }).path)).mode & 0o777;

    expect(mode).toBe(0o600);
  });

  it('says the file is not there yet rather than saying nothing changed', async () => {
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(
      /no history file at .* yet, so this run creates one/,
    );
  });

  it('ignores a file it did not write, and says it will replace it', async () => {
    // Someone pointing `history` at an existing file of their own must not have
    // it read as a portfolio run — and must be told, because silence here is
    // indistinguishable from a first run.
    await writeFile((store as { path: string }).path, '{"hello":"world"}');
    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/not one this server wrote/);
  });

  it('ignores a file that is not JSON at all', async () => {
    await writeFile((store as { path: string }).path, 'not json {{{');

    expect((await createDurableHistory().previous(store, NOW)).snapshot).toBeNull();
  });

  it('leaves a corrupt file alone and says how to get past it', async () => {
    // A file that does not parse could be this server's or a hand-kept one with a
    // typo, and only one of those can be replaced without loss.
    const path = (store as { path: string }).path;
    await writeFile(path, 'not json {{{');
    const history = createDurableHistory();

    const previous = await history.previous(store, NOW);
    const recorded = await history.record(store, snapshot());

    expect(previous.unavailableReason).toContain('remove the file');
    expect(recorded.stored).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('not json {{{');
  });

  it('refuses a baseline older than the comparison window, and says how old', async () => {
    // "Improved since March" in a weekly review is noise dressed as
    // information: every certificate has renewed twice by then.
    const stale = new Date(NOW.getTime() - TTL.historyMs - 86_400_000).toISOString();
    await createDurableHistory().record(store, snapshot({ takenAt: stale }));

    const previous = await createDurableHistory().previous(store, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/101 days ago and past the 100-day window/);
  });

  it('accepts a baseline exactly at the edge of the window', async () => {
    const edge = new Date(NOW.getTime() - TTL.historyMs).toISOString();
    await createDurableHistory().record(store, snapshot({ takenAt: edge }));

    expect((await createDurableHistory().previous(store, NOW)).snapshot).not.toBeNull();
  });

  it('reports a write it could not make, rather than failing the report', async () => {
    // A report that found an expired certificate is worth having even when it
    // cannot be filed. Failing the tool over the bookkeeping throws away the
    // answer.
    const unwritable: HistoryStore = { kind: 'file', path: join(directory, 'nope', 'h.json') };
    const outcome = await createDurableHistory().record(unwritable, snapshot());

    expect(outcome.stored).toBe(false);
    expect(outcome.reason).toMatch(/could not be recorded to/);
  });

  it('reports a file it could not read for a reason other than absence', async () => {
    const asDirectory: HistoryStore = { kind: 'file', path: directory };
    const previous = await createDurableHistory().previous(asDirectory, NOW);

    expect(previous.snapshot).toBeNull();
    expect(previous.unavailableReason).toMatch(/could not be read/);
  });

  it.each([
    ['the portfolio itself', '{"version":1,"sites":[{"name":"A","url":"https://a.example"}]}'],
    ['some other JSON file', '{"name":"package"}'],
    ['something that is not JSON', 'not json'],
  ])('never overwrites %s', async (_label, content) => {
    const directory = await mkdtemp(join(tmpdir(), 'upkeep-history-'));
    const path = join(directory, 'sites.json');
    await writeFile(path, content);

    const outcome = await createDurableHistory().record(
      { kind: 'file', path },
      { takenAt: '2026-01-01T00:00:00.000Z', sites: {} },
    );

    expect(outcome.stored).toBe(false);
    expect(outcome.reason).toContain('will not be overwritten');
    expect(await readFile(path, 'utf8')).toBe(content);
    await rm(directory, { recursive: true });
  });

  it('still replaces its own earlier snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'upkeep-history-'));
    const store = { kind: 'file', path: join(directory, 'history.json') } as const;
    const history = createDurableHistory();

    await history.record(store, { takenAt: '2026-01-01T00:00:00.000Z', sites: {} });
    const second = await history.record(store, { takenAt: '2026-01-02T00:00:00.000Z', sites: {} });

    expect(second.stored).toBe(true);
    expect(await readFile(store.path, 'utf8')).toContain('2026-01-02');
    await rm(directory, { recursive: true });
  });
});

describe('mergeRun', () => {
  const FULL = ['domain', 'ssl', 'uptime'] as const;
  const outcome = (
    severity: Severity,
    checks: readonly CheckName[],
  ): RunSnapshot['sites'][string] => ({
    severity,
    codes: [],
    checks: [...checks],
  });
  const EARLIER = '2026-01-01T00:00:00.000Z';
  const LATER = '2026-03-01T00:00:00.000Z';

  it('takes the run as it is when there is nothing before it', () => {
    const current = { takenAt: LATER, sites: { a: outcome('ok', ['uptime']) } };

    expect(mergeRun(null, current, false)).toEqual(current);
  });

  it('keeps a full baseline through an uptime-only pass', () => {
    const baseline = { takenAt: EARLIER, sites: { a: outcome('warning', FULL) } };

    const merged = mergeRun(
      baseline,
      { takenAt: LATER, sites: { a: outcome('ok', ['uptime']) } },
      false,
    );

    expect(merged.sites['a']).toMatchObject({ severity: 'warning', takenAt: EARLIER });
  });

  it('moves the baseline forward when the run measured at least as much', () => {
    const merged = mergeRun(
      { takenAt: EARLIER, sites: { a: outcome('warning', ['uptime']) } },
      { takenAt: LATER, sites: { a: outcome('ok', FULL) } },
      false,
    );

    expect(merged).toEqual({ takenAt: LATER, sites: { a: outcome('ok', FULL) } });
  });

  it('leaves the sites a tag filter left out, each keeping its own date', () => {
    const merged = mergeRun(
      { takenAt: EARLIER, sites: { a: outcome('ok', FULL), b: outcome('warning', FULL) } },
      { takenAt: LATER, sites: { a: { ...outcome('critical', FULL), takenAt: LATER } } },
      true,
    );

    expect(merged.takenAt).toBe(LATER);
    expect(merged.sites['a']).toMatchObject({ severity: 'critical', takenAt: LATER });
    expect(merged.sites['b']).toMatchObject({ severity: 'warning', takenAt: EARLIER });
  });

  it('survives quarters of reports written one client at a time', () => {
    // A frozen date expired the whole snapshot every other quarter.
    const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
    const site = (at: string): RunSnapshot['sites'][string] => ({
      ...outcome('ok', FULL),
      takenAt: at,
    });

    let history: RunSnapshot | null = null;
    for (const quarter of [0, 91, 182, 273]) {
      history = mergeRun(
        history,
        { takenAt: day(quarter), sites: { a: site(day(quarter)) } },
        true,
      );
      history = mergeRun(
        history,
        { takenAt: day(quarter + 1), sites: { b: site(day(quarter + 1)) } },
        true,
      );
    }

    expect(history?.sites['a']?.takenAt).toBe(day(273));
    expect(history?.sites['b']?.takenAt).toBe(day(274));
  });

  it('drops what a filter left out once it is past the comparison window', () => {
    const merged = mergeRun(
      { takenAt: EARLIER, sites: { a: outcome('ok', FULL) } },
      {
        takenAt: new Date(new Date(EARLIER).getTime() + TTL.historyMs + 86_400_000).toISOString(),
        sites: {},
      },
      true,
    );

    expect(merged.sites).toEqual({});
  });

  it('forgets a site that left the portfolio, on a full run', () => {
    const merged = mergeRun(
      { takenAt: EARLIER, sites: { a: outcome('ok', FULL), gone: outcome('ok', FULL) } },
      { takenAt: LATER, sites: { a: outcome('ok', FULL) } },
      false,
    );

    expect(merged).toEqual({ takenAt: LATER, sites: { a: outcome('ok', FULL) } });
  });
});

describe('memory history across portfolios', () => {
  it('keeps two portfolio files apart within one process', async () => {
    const history = createMemoryHistory();
    const now = new Date('2026-01-02T00:00:00.000Z');
    const one = historyStoreFor('/portfolios/one.json', null);
    const two = historyStoreFor('/portfolios/two.json', null);
    const snapshot = { takenAt: '2026-01-01T00:00:00.000Z', sites: {} };

    await history.record(one, snapshot);

    expect((await history.previous(one, now)).snapshot).toEqual(snapshot);
    expect((await history.previous(two, now)).snapshot).toBeNull();
  });
});

describe('named baselines', () => {
  let directory: string;
  let store: HistoryStore;
  const NOW = new Date('2026-10-01T00:00:00.000Z');
  const run = (takenAt: string, code: string): RunSnapshot => ({
    takenAt,
    sites: { site: { severity: 'warning', codes: [code], checks: ['ssl'] } },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'upkeep-baselines-'));
    store = { kind: 'file', path: join(directory, 'history.json') };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true });
  });

  it('keeps a baseline through later runs, and the later runs through a save', async () => {
    const history = createDurableHistory();

    await history.record(store, run('2026-07-01T00:00:00.000Z', 'q3'));
    await history.saveBaseline(store, '2026-Q3', run('2026-07-01T00:00:00.000Z', 'q3'), false);
    await history.record(store, run('2026-09-01T00:00:00.000Z', 'later'));

    expect((await history.baseline(store, '2026-Q3', NOW)).snapshot?.sites['site']?.codes).toEqual([
      'q3',
    ]);
    expect((await history.previous(store, NOW)).snapshot?.sites['site']?.codes).toEqual(['later']);
  });

  it('names what it does hold when asked for what it does not', async () => {
    const history = createDurableHistory();
    await history.saveBaseline(store, '2026-Q3', run('2026-07-01T00:00:00.000Z', 'q3'), false);

    const missing = await history.baseline(store, '2026-Q2', NOW);

    expect(missing.snapshot).toBeNull();
    expect(missing.unavailableReason).toContain('no baseline named "2026-Q2"');
    expect(missing.unavailableReason).toContain('2026-Q3');
  });

  it('refuses a baseline past its time limit, and drops it at the next write', async () => {
    const history = createDurableHistory();
    const old = new Date(NOW.getTime() - TTL.baselineMs - 86_400_000).toISOString();
    await history.saveBaseline(store, 'old', run(old, 'x'), false);

    const refused = await history.baseline(store, 'old', NOW);
    expect(refused.snapshot).toBeNull();
    expect(refused.unavailableReason).toContain('as long as one is kept');

    await history.record(store, run(NOW.toISOString(), 'y'));
    expect(await readFile((store as { path: string }).path, 'utf8')).not.toContain('"old"');
  });

  it('reads a version 1 file, and keeps it as the previous run', async () => {
    await writeFile(
      (store as { path: string }).path,
      JSON.stringify({ version: 1, ...run('2026-09-20T00:00:00.000Z', 'v1') }),
    );
    const history = createDurableHistory();

    expect((await history.previous(store, NOW)).snapshot?.sites['site']?.codes).toEqual(['v1']);

    await history.saveBaseline(store, 'q', run(NOW.toISOString(), 'new'), false);
    expect((await history.previous(store, NOW)).snapshot?.sites['site']?.codes).toEqual(['v1']);
  });

  it('will not save a baseline over a file it did not write', async () => {
    const path = (store as { path: string }).path;
    await writeFile(path, '{"sites":[]}');

    const saved = await createDurableHistory().saveBaseline(
      store,
      'q',
      run(NOW.toISOString(), 'x'),
      false,
    );

    expect(saved.stored).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('{"sites":[]}');
  });

  it('builds one baseline from reports written one client at a time', async () => {
    const history = createDurableHistory();
    const site = (code: string): RunSnapshot['sites'][string] => ({
      severity: 'warning',
      codes: [code],
      checks: ['ssl'],
    });

    await history.saveBaseline(
      store,
      'q',
      { takenAt: '2026-09-30T00:00:00.000Z', sites: { a: site('x') } },
      true,
    );
    await history.saveBaseline(
      store,
      'q',
      { takenAt: '2026-10-01T00:00:00.000Z', sites: { b: site('y') } },
      true,
    );

    const read = await history.baseline(store, 'q', NOW);
    expect(Object.keys(read.snapshot?.sites ?? {}).sort()).toEqual(['a', 'b']);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'reads %s as a baseline that is not there, not as something inherited',
    async (name) => {
      const history = createDurableHistory();
      await history.record(store, run(NOW.toISOString(), 'x'));

      const read = await history.baseline(store, name, NOW);

      expect(read.snapshot).toBeNull();
      expect(read.unavailableReason).toContain(`no baseline named "${name}"`);
    },
  );

  it('leaves no partial file behind, and keeps a mode the user widened', async () => {
    const path = (store as { path: string }).path;
    const history = createDurableHistory();
    await history.record(store, run(NOW.toISOString(), 'x'));
    await chmod(path, 0o640);

    await history.record(store, run(NOW.toISOString(), 'y'));

    expect((await readdir(directory)).sort()).toEqual(['history.json']);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  it('writes through a symlink rather than replacing it', async () => {
    const real = join(directory, 'real.json');
    const link = (store as { path: string }).path;
    const history = createDurableHistory();
    await history.record({ kind: 'file', path: real }, run(NOW.toISOString(), 'x'));
    await symlink(real, link);

    await history.record(store, run(NOW.toISOString(), 'y'));

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toContain('"y"');
  });

  it('writes in place where a file cannot be replaced', async () => {
    const path = (store as { path: string }).path;
    const history = createDurableHistory();
    await history.record(store, run(NOW.toISOString(), 'x'));
    await chmod(directory, 0o555);

    try {
      const written = await history.record(store, run(NOW.toISOString(), 'y'));

      expect(written.stored).toBe(true);
      expect(await readFile(path, 'utf8')).toContain('"y"');
    } finally {
      await chmod(directory, 0o755);
    }
  });

  it('keeps a client in a baseline built over months, up to the baseline limit', async () => {
    const history = createDurableHistory();
    const january = '2026-01-10T00:00:00.000Z';
    const june = '2026-06-10T00:00:00.000Z';
    const site = (at: string): RunSnapshot['sites'][string] => ({
      severity: 'ok',
      codes: [],
      checks: ['ssl'],
      takenAt: at,
    });

    await history.saveBaseline(store, 'y', { takenAt: january, sites: { a: site(january) } }, true);
    await history.saveBaseline(store, 'y', { takenAt: june, sites: { b: site(june) } }, true);

    const read = await history.baseline(store, 'y', new Date('2026-07-01T00:00:00.000Z'));
    expect(Object.keys(read.snapshot?.sites ?? {}).sort()).toEqual(['a', 'b']);
  });

  it('keeps a check measured last week when the rest of the site has aged out', async () => {
    const history = createDurableHistory();
    const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
    await history.record(store, {
      takenAt: day(101),
      sites: {
        site: {
          severity: 'warning',
          codes: ['old', 'recent'],
          checks: ['ssl', 'uptime'],
          takenAt: day(101),
          byCheck: {
            ssl: { severity: 'warning', codes: ['old'], takenAt: day(0) },
            uptime: { severity: 'ok', codes: ['recent'], takenAt: day(101) },
          },
        },
      },
    });

    const read = await history.previous(store, new Date(day(102)));

    expect(read.snapshot?.sites['site']?.checks).toEqual(['uptime']);
    expect(read.snapshot?.sites['site']?.codes).toEqual(['recent']);
    expect(read.expiredSites).toEqual([]);
  });

  it('applies a baseline limit to each site it holds, not only to its newest', async () => {
    const history = createDurableHistory();
    const site = (at: string): RunSnapshot['sites'][string] => ({
      severity: 'ok',
      codes: [],
      checks: ['ssl'],
      takenAt: at,
    });
    const day = (n: number): string => new Date(Date.UTC(2025, 0, 1 + n)).toISOString();
    await history.saveBaseline(
      store,
      'q',
      { takenAt: day(390), sites: { old: site(day(0)), recent: site(day(390)) } },
      false,
    );

    const read = await history.baseline(store, 'q', new Date(day(700)));

    expect(Object.keys(read.snapshot?.sites ?? {})).toEqual(['recent']);
    expect(read.expiredSites).toEqual(['old']);
  });

  it('does not keep a site comparable past the window because another was reported on', async () => {
    const history = createDurableHistory();
    const site = (at: string): RunSnapshot['sites'][string] => ({
      severity: 'ok',
      codes: [],
      checks: ['ssl'],
      takenAt: at,
    });
    const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

    await history.record(store, {
      takenAt: day(99),
      sites: { old: site(day(0)), recent: site(day(99)) },
    });

    const read = await history.previous(store, new Date(day(150)));
    expect(Object.keys(read.snapshot?.sites ?? {})).toEqual(['recent']);
  });

  it('writes in place only where that cannot make things worse', () => {
    expect(cannotReplaceInPlace('EACCES')).toBe(true);
    expect(cannotReplaceInPlace('EBUSY')).toBe(true);
    // A full disk would truncate the only good copy and then fail.
    expect(cannotReplaceInPlace('ENOSPC')).toBe(false);
    expect(cannotReplaceInPlace('EDQUOT')).toBe(false);
    expect(cannotReplaceInPlace(undefined)).toBe(false);
  });

  it('holds no named baseline in memory, and says what to do instead', async () => {
    // One process serves every caller of a public instance.
    const history = createMemoryHistory();
    const memory: HistoryStore = { kind: 'memory', portfolio: null };

    const saved = await history.saveBaseline(memory, 'q', run(NOW.toISOString(), 'x'), false);
    const read = await history.baseline(memory, 'q', NOW);

    expect(saved.stored).toBe(false);
    expect(saved.reason).toContain('includeSnapshot');
    expect(read.snapshot).toBeNull();
  });
});

describe('a snapshot a caller holds', () => {
  const NOW = new Date('2026-10-01T00:00:00.000Z');
  const snapshot: RunSnapshot = {
    takenAt: '2026-07-01T00:00:00.000Z',
    sites: {
      b: { severity: 'ok', codes: [], checks: ['ssl'] },
      a: { severity: 'warning', codes: ['x'], checks: ['ssl'] },
    },
    serverVersion: '0.7.0',
  };

  it('comes back as it went out, even with its keys reordered in transit', () => {
    const sealed = sealSnapshot(snapshot);
    const reordered = {
      checksum: sealed.checksum,
      serverVersion: sealed.serverVersion,
      sites: { a: sealed.sites['a'], b: sealed.sites['b'] },
      takenAt: sealed.takenAt,
    };

    expect(openSnapshot(reordered, NOW)).toEqual({
      snapshot,
      unavailableReason: null,
      expiredSites: [],
    });
  });

  it.each([
    [
      'a changed severity',
      (sealed: Record<string, unknown>) => ({ ...sealed, takenAt: '2026-07-02T00:00:00.000Z' }),
    ],
    [
      'a missing checksum',
      (sealed: Record<string, unknown>) => ({ ...sealed, checksum: undefined }),
    ],
    ['something else entirely', () => ({ hello: 'world' })],
  ])('refuses %s rather than comparing against it', (_label, alter) => {
    const result = openSnapshot(alter({ ...sealSnapshot(snapshot) }), NOW);

    expect(result.snapshot).toBeNull();
    expect(result.unavailableReason).toContain('baselineSnapshot');
  });

  it('refuses one past the time limit', () => {
    const old = sealSnapshot({ ...snapshot, takenAt: '2024-01-01T00:00:00.000Z' });

    expect(openSnapshot(old, NOW).unavailableReason).toContain('as long as one is kept');
  });
});
