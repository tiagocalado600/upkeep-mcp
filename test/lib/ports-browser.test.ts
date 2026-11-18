import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AxeRun } from '../../src/lib/axe.js';
import { createDefaultPorts } from '../../src/lib/ports.js';

/**
 * Which target policy the browser is handed, with the browser itself replaced.
 *
 * A file of its own because replacing a module applies to the whole file, and
 * the rest of the ports suite wants the real one.
 */

const runAxe = vi.hoisted(() =>
  vi.fn<
    (
      url: string,
      tags: readonly string[],
      timeoutMs?: number,
      allow?: (target: URL) => Promise<void>,
    ) => Promise<AxeRun>
  >(),
);
vi.mock('../../src/lib/axe.js', () => ({ runAxe }));

const RUN: AxeRun = {
  url: 'http://app.localhost:8080/',
  title: 'App',
  violations: [],
  passCount: 1,
  incompleteCount: 0,
  axeVersion: '4.0.0',
  status: 200,
};

beforeEach(() => {
  runAxe.mockReset();
  runAxe.mockResolvedValue(RUN);
});

describe('browser.audit', () => {
  it('hands the browser no policy locally, so the system resolver finds the name', async () => {
    // A policy that allows everything still started the guarded proxy, which
    // resolves through DNS alone and so cannot see /etc/hosts, mDNS or a VPN's
    // resolver: a local site every browser on the machine opens answered 403.
    await createDefaultPorts().browser.audit('http://app.localhost:8080/', ['wcag2a']);

    expect(runAxe).toHaveBeenCalledOnce();
    expect(runAxe.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('hands the browser the public-target policy on a public instance', async () => {
    runAxe.mockResolvedValue({ ...RUN, url: 'https://192.0.2.1/' });
    await createDefaultPorts({ publicTargetsOnly: true }).browser.audit('https://192.0.2.1/', [
      'wcag2a',
    ]);

    const policy = runAxe.mock.calls[0]?.[3];
    expect(policy).toBeTypeOf('function');
    await expect(policy?.(new URL('http://127.0.0.1/'))).rejects.toThrow(/public internet/);
  });
});
