import { describe, expect, it } from 'vitest';
import { clientKey, createInboundLimiter } from '../../src/lib/inbound-limit.js';

const LIMITS = {
  perClientPerMinute: 60,
  burst: 3,
  maxConcurrent: 2,
  perClientConcurrent: 1,
  maxClients: 3,
};

/** A limiter with a clock the test drives. */
function limiterAt(start = 0): {
  limiter: ReturnType<typeof createInboundLimiter>;
  advance: (ms: number) => void;
} {
  let clock = start;
  const limiter = createInboundLimiter(LIMITS, () => clock);
  return {
    limiter,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('createInboundLimiter', () => {
  it('lets a client spend its burst and then refuses', () => {
    const { limiter } = limiterAt();

    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      expect(admission.ok, `attempt ${String(attempt)}`).toBe(true);
      if (admission.ok) admission.release();
    }

    const refused = limiter.admit('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.status).toBe(429);
      expect(refused.message).toContain('run it locally');
    }
  });

  it('refills over time rather than resetting on a window boundary', () => {
    const { limiter, advance } = limiterAt();
    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      if (admission.ok) admission.release();
    }
    expect(limiter.admit('a').ok).toBe(false);

    // Sixty a minute is one a second.
    advance(1000);
    const admission = limiter.admit('a');
    expect(admission.ok).toBe(true);
    if (admission.ok) admission.release();
    expect(limiter.admit('a').ok).toBe(false);
  });

  it('never refills past the burst, however long it waits', () => {
    const { limiter, advance } = limiterAt();
    advance(600_000);

    let admitted = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admission = limiter.admit('a');
      if (!admission.ok) break;
      admission.release();
      admitted += 1;
    }

    expect(admitted).toBe(LIMITS.burst);
  });

  it('counts clients separately', () => {
    const { limiter } = limiterAt();
    for (let attempt = 0; attempt < LIMITS.burst; attempt += 1) {
      const admission = limiter.admit('a');
      if (admission.ok) admission.release();
    }

    expect(limiter.admit('a').ok).toBe(false);
    expect(limiter.admit('b').ok).toBe(true);
  });

  it('caps what is in flight across every client at once', () => {
    const { limiter } = limiterAt();

    const first = limiter.admit('a');
    const second = limiter.admit('b');
    const third = limiter.admit('c');

    expect(first.ok && second.ok).toBe(true);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.status).toBe(503);
    expect(limiter.inFlight).toBe(2);

    if (first.ok) first.release();
    expect(limiter.admit('c').ok).toBe(true);
  });

  it('caps what one client has in flight, so it cannot take every slot', () => {
    // The burst is larger than the global cap, so without this one honest client
    // running long portfolio reports held every slot and everyone else got 503.
    const { limiter } = limiterAt();

    const first = limiter.admit('a');
    const second = limiter.admit('a');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.status).toBe(429);
      expect(second.message).toContain('at a time');
    }
    expect(limiter.admit('b').ok).toBe(true);

    if (first.ok) first.release();
    expect(limiter.admit('a').ok).toBe(true);
  });

  it('does not charge a token for a request refused as concurrent', () => {
    const { limiter } = limiterAt();
    const held = limiter.admit('a');
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.admit('a');
    if (held.ok) held.release();

    let admitted = 0;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const admission = limiter.admit('a');
      if (!admission.ok) break;
      admission.release();
      admitted += 1;
    }
    expect(admitted).toBe(LIMITS.burst - 1);
  });

  it('keeps counting a busy client in flight when its bucket is forgotten', () => {
    // Eviction bounds the buckets; it must not reset the in-flight count, or a
    // flood of other addresses would let a client past its concurrency cap.
    const { limiter } = limiterAt();
    const held = limiter.admit('a');
    if (held.ok) held.release();
    const busy = limiter.admit('a');
    expect(busy.ok).toBe(true);

    for (let client = 0; client < 10; client += 1) {
      const admission = limiter.admit(`other-${String(client)}`);
      if (admission.ok) admission.release();
    }

    expect(limiter.admit('a').ok).toBe(false);
    if (busy.ok) busy.release();
  });

  it('ignores a second release, which would let the cap drift upwards', () => {
    const { limiter } = limiterAt();
    const admission = limiter.admit('a');

    if (admission.ok) {
      admission.release();
      admission.release();
    }

    expect(limiter.inFlight).toBe(0);
  });

  it('bounds what it remembers, so a flood of addresses is not a leak', () => {
    const { limiter } = limiterAt();

    for (let client = 0; client < 50; client += 1) {
      const admission = limiter.admit(`client-${String(client)}`);
      if (admission.ok) admission.release();
    }

    // The earliest clients were forgotten, which costs them a fresh bucket and
    // costs this process nothing.
    const admission = limiter.admit('client-0');
    expect(admission.ok).toBe(true);
  });
});

describe('clientKey', () => {
  it('keys on the address the platform appended, not on one the caller wrote', () => {
    // A caller controls everything to the left of what the last proxy appends.
    // Keying on the first entry gave a fresh bucket to every request carrying a
    // made-up X-Forwarded-For, which made the per-client limit decorative.
    expect(clientKey('203.0.113.7, 70.41.3.18', '10.0.0.1', 0)).toBe('70.41.3.18');
    expect(clientKey('1.2.3.4, 70.41.3.18', '10.0.0.1', 0)).toBe(
      clientKey('5.6.7.8, 9.9.9.9, 70.41.3.18', '10.0.0.1', 0),
    );
  });

  it('ignores X-Forwarded-For unless a front end is trusted to write it', () => {
    // With nothing in front, the header is whatever the caller sent, and its
    // last entry was a fresh bucket per request on a plain `docker run`.
    expect(clientKey('203.0.113.7', '192.0.2.1')).toBe('192.0.2.1');
    expect(clientKey('198.51.100.9', '192.0.2.1')).toBe('192.0.2.1');
    expect(clientKey('203.0.113.7', '192.0.2.1', null)).toBe('192.0.2.1');
  });

  it('skips the hops a known proxy appends after the client', () => {
    // An Application Load Balancer appends `CLIENT_IP,LOAD_BALANCER_IP`.
    expect(clientKey('6.6.6.6, 203.0.113.7, 34.120.0.1', '10.0.0.1', 1)).toBe('203.0.113.7');
  });

  it('falls back to the socket when there is no usable entry', () => {
    expect(clientKey(undefined, '203.0.113.7', 0)).toBe('203.0.113.7');
    expect(clientKey('', '203.0.113.7', 0)).toBe('203.0.113.7');
    expect(clientKey('   ', '203.0.113.7', 0)).toBe('203.0.113.7');
    expect(clientKey('203.0.113.7', '10.0.0.1', 1)).toBe('10.0.0.1');
  });

  it('always returns something to key on', () => {
    expect(clientKey(undefined, undefined)).toBe('unknown');
  });
});
