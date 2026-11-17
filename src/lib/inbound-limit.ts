/**
 * Admission control for a publicly reachable instance.
 *
 * Every other limit in this project protects the hosts being checked. This one
 * protects the instance doing the checking, and the person paying for its
 * egress: a public MCP endpoint that fetches URLs on request is a free proxy
 * unless something says no.
 */

/** What a caller is allowed to do right now. */
export type Admission =
  { ok: true; release: () => void } | { ok: false; status: number; message: string };

/** How much traffic one instance will take. */
export interface InboundLimits {
  /** Sustained requests per minute, per client. */
  perClientPerMinute: number;
  /** How many a client may spend at once before the sustained rate applies. */
  burst: number;
  /** Requests in flight across all clients. */
  maxConcurrent: number;
  /**
   * Requests in flight for one client. Below `maxConcurrent`, or a single
   * client running long tool calls can hold every slot and shut everyone else
   * out without ever exceeding its rate.
   */
  perClientConcurrent: number;
  /** Clients tracked at once, so the bookkeeping cannot grow without limit. */
  maxClients: number;
}

/** One client's token bucket. */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Creates an inbound limiter: a token bucket and a concurrency cap per client,
 * and one global concurrency cap.
 *
 * A bucket rather than a fixed window because the honest shape of demo traffic
 * is a burst — a client connects, lists tools, calls two of them — followed by
 * nothing. A fixed window either refuses that burst or permits a flood.
 *
 * @param limits How much traffic to take.
 * @param now Injected clock, so the refill can be tested without waiting.
 * @returns A limiter. Every successful admission **must** be released, or the
 *   concurrency slot leaks.
 * @throws Never.
 */
export function createInboundLimiter(
  limits: InboundLimits,
  now: () => number = Date.now,
): { admit(client: string): Admission; readonly inFlight: number } {
  const buckets = new Map<string, Bucket>();
  // Kept apart from the buckets because those are evicted to bound memory, and
  // forgetting what a client has in flight would let it past its cap. Entries
  // are deleted at zero, so this holds at most `maxConcurrent` keys.
  const clientInFlight = new Map<string, number>();
  let inFlight = 0;

  const refill = (bucket: Bucket): void => {
    const elapsed = now() - bucket.lastRefill;
    const earned = (elapsed / 60_000) * limits.perClientPerMinute;
    if (earned <= 0) return;
    bucket.tokens = Math.min(limits.burst, bucket.tokens + earned);
    bucket.lastRefill = now();
  };

  return {
    get inFlight() {
      return inFlight;
    },

    admit(client) {
      if (inFlight >= limits.maxConcurrent) {
        return {
          ok: false,
          status: 503,
          message: 'this demo instance is busy; try again in a moment',
        };
      }

      const running = clientInFlight.get(client) ?? 0;
      if (running >= limits.perClientConcurrent) {
        // Checked before the bucket so that waiting costs no token.
        return {
          ok: false,
          status: 429,
          message: `this demo instance runs ${String(limits.perClientConcurrent)} requests at a time per caller; wait for one to finish, or run it locally`,
        };
      }

      let bucket = buckets.get(client);
      if (bucket === undefined) {
        bucket = { tokens: limits.burst, lastRefill: now() };
        // Map iterates in insertion order, so the first key is the least
        // recently created. A flood of distinct addresses must not become a
        // memory leak.
        if (buckets.size >= limits.maxClients) {
          const oldest = buckets.keys().next();
          if (oldest.done !== true) buckets.delete(oldest.value);
        }
      } else {
        refill(bucket);
      }
      buckets.set(client, bucket);

      if (bucket.tokens < 1) {
        return {
          ok: false,
          status: 429,
          message: `this demo instance allows ${String(limits.perClientPerMinute)} requests a minute; run it locally for more`,
        };
      }

      bucket.tokens -= 1;
      inFlight += 1;
      clientInFlight.set(client, running + 1);
      let released = false;
      return {
        ok: true,
        release: () => {
          // Guarded because a double release would let the cap drift upwards
          // until it stopped capping anything.
          if (released) return;
          released = true;
          inFlight -= 1;
          const left = (clientInFlight.get(client) ?? 1) - 1;
          if (left <= 0) clientInFlight.delete(client);
          else clientInFlight.set(client, left);
        },
      };
    },
  };
}

/**
 * Identifies the client behind a request.
 *
 * Every proxy *appends* to `X-Forwarded-For`, so a caller controls everything
 * to the left of what the last trusted proxy wrote and nothing to the right of
 * it. Keying on the first entry — the textbook "original client" — handed a
 * fresh token bucket to every request carrying a made-up header, which made the
 * per-client limit decorative. The right end is the only part a caller cannot
 * choose.
 *
 * On Cloud Run reached directly at its `run.app` URL, Google's front end
 * appends the address it accepted the connection from as the **last** entry,
 * and adds no address of its own after it: `proxyHops` 0. Google does not
 * document this for Cloud Run — the container contract
 * (https://docs.cloud.google.com/run/docs/container-contract) says nothing
 * about the header — so it rests on observed behaviour
 * (https://discuss.google.dev/t/cloud-run-which-client-ip-can-i-safely-use-for-rate-limiting/409611),
 * and `docs/deploying.md` makes confirming it a step of every deploy. Behind an
 * external Application Load Balancer the header ends `CLIENT_IP,LOAD_BALANCER_IP`
 * (https://docs.cloud.google.com/load-balancing/docs/https), which is
 * `proxyHops` 1. Getting it wrong in that direction is loud rather than unsafe:
 * every caller would share the load balancer's one bucket.
 *
 * @param forwardedFor The `X-Forwarded-For` header, repeats joined with commas.
 * @param socketAddress The peer address, used when the header has no entry at
 *   the expected position — which is the case with no proxy in front at all.
 * @param proxyHops How many entries trusted proxies append after the client's.
 *   Defaults to 0: the last entry is the client.
 * @returns A key to rate limit on.
 * @throws Never.
 */
export function clientKey(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
  proxyHops = 0,
): string {
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const appended = entries[entries.length - 1 - proxyHops];
  if (appended !== undefined) return appended;
  return socketAddress ?? 'unknown';
}
