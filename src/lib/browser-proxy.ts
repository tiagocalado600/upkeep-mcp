import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { TIMEOUTS } from './defaults.js';
import { resolveAddresses } from './dns.js';
import { CheckError } from './errors.js';

/**
 * A forward proxy that every connection a headless browser makes goes through.
 *
 * Request routing in Playwright is not a network boundary. `context.route`
 * never sees a WebSocket; `context.routeWebSocket` replaces the `WebSocket`
 * constructor in the page's own JavaScript, so a socket opened from a worker
 * is not seen either — both measured with a real Chromium, both reaching a
 * server on loopback. And Chromium resolves names itself, after the guard
 * did, so a name answering with a public address for the guard and
 * `169.254.169.254` for the browser walked past every check.
 *
 * A proxy is the one place all of it passes, from any frame, worker or
 * protocol: Chromium sends plain HTTP to it as requests and everything else —
 * HTTPS, `ws:`, `wss:` — as `CONNECT` tunnels, and it does not resolve a
 * proxied name at all. So this proxy resolves the name, puts **each address**
 * through the target policy as a literal, and connects to an address it
 * checked. That is the pinning `docs/adr/0012` describes as the right fix, for
 * the one client in this project that runs code a stranger wrote.
 *
 * When the proxy itself refuses or fails a connection it answers with no HTTP
 * status at all, and remembers why. A synthesised `403` or `502` reached the
 * page as if the site had sent it, and the audit graded the site for an error
 * it never served; the browser now sees a failed load, and the caller asks
 * {@link GuardedProxy.failureFor} what really happened.
 */

/** A running proxy. */
export interface GuardedProxy {
  /** The address to hand Chromium, e.g. `http://127.0.0.1:53124`. */
  server: string;
  /** Stops accepting and destroys every open connection. */
  close(): Promise<void>;
  /**
   * Why the proxy last refused or failed a connection to a URL's host and
   * port, if it did and has not connected there since.
   *
   * @param target The URL a request was made to, any scheme the browser uses.
   * @returns The refusal exactly as the target policy worded it, a resolution
   *   failure as the resolver worded it, or a `network` error for an address
   *   that would not connect or answer; `null` when the proxy has nothing
   *   against that host and port.
   */
  failureFor(target: URL): CheckError | null;
}

/** What the proxy needs to decide and connect. */
export interface GuardedProxyOptions {
  /**
   * Throws when a target may not be contacted. Always called with an address
   * literal for a host, never a name, so the answer is about the address that
   * will be connected to.
   */
  allow: (target: URL) => Promise<void>;
  /** Finds a name's addresses. Injected so the pinning can be tested offline. */
  resolve?: (hostname: string) => Promise<string[]>;
}

/**
 * How long a tunnel may sit with nothing crossing it. A page holding a socket
 * open past this is not something an accessibility audit is waiting for, and
 * the audit's own deadline closes the proxy long before it matters otherwise.
 */
const IDLE_MS = 30_000;

/**
 * Addresses tried for one connection before giving up. A name with a dozen
 * addresses is a load balancer, and the first few are as good as the rest;
 * each attempt can take a hop's whole deadline, which the audit's own does
 * not have room for many of.
 */
const MAX_DIAL_ATTEMPTS = 3;

/**
 * Connections the browser may hold open through one proxy at a time. Chromium
 * keeps at most 32 per proxy on its own, so this is only reached by something
 * that is not behaving like a browser, and each connection can hold an
 * upstream socket of its own.
 */
const MAX_CONNECTIONS = 64;

/** Default ports for the schemes a browser sends through a proxy. */
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'ws:': 80,
  'https:': 443,
  'wss:': 443,
};

/**
 * Starts a guarded forward proxy on loopback.
 *
 * @param options The policy and the resolver.
 * @returns The running proxy. It must be closed, or its sockets outlive the audit.
 * @throws Whatever binding a loopback port throws, which is nothing in practice.
 */
export async function startGuardedProxy(options: GuardedProxyOptions): Promise<GuardedProxy> {
  const resolve = options.resolve ?? ((hostname: string) => resolveAddresses(hostname));
  const open = new Set<Duplex>();
  let closed = false;
  const track = (socket: Duplex): void => {
    // A connection that finishes opening after the proxy closed would otherwise
    // be the one socket nothing ever destroys.
    if (closed) {
      socket.destroy();
      return;
    }
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  };

  // Keyed by host and port as the browser asked for them, which is what the
  // caller knows: it has a URL, not the address the proxy picked.
  const failures = new Map<string, CheckError>();

  /**
   * @param hostname The host as the browser asked for it.
   * @param port The port it asked for.
   * @returns The addresses that may be connected to, every one of them
   *   checked, or `null` when any was refused or the name did not resolve,
   *   with the reason recorded.
   */
  const checkedAddresses = async (hostname: string, port: number): Promise<string[] | null> => {
    const key = authority(hostname, port);
    const bare = hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(bare) === 0 ? await resolve(bare) : [bare];
    } catch (cause) {
      failures.set(key, asCheckError(cause, `${bare} could not be resolved`));
      return null;
    }
    if (addresses.length === 0) {
      failures.set(key, new CheckError('not_found', `${bare} does not resolve to any address`));
      return null;
    }

    // Every address, as the guard does with names: one public and one private
    // answer is the standard way past a check that stops at the first.
    const verdicts = await Promise.all(
      addresses.map((address) =>
        options.allow(targetFor(address, port)).then(
          () => null,
          (cause: unknown) => asCheckError(cause, `${bare} was refused`),
        ),
      ),
    );
    const refusal = verdicts.find((verdict) => verdict !== null);
    if (refusal !== undefined) {
      failures.set(key, refusal);
      return null;
    }
    return addresses;
  };

  /**
   * Connects to a checked address, recording why when none would.
   *
   * @param hostname The host as the browser asked for it.
   * @param addresses Checked addresses, in the resolver's order.
   * @param port The port.
   * @returns The connected socket, already tracked, or `null`.
   */
  const connectTo = async (
    hostname: string,
    addresses: readonly string[],
    port: number,
  ): Promise<Socket | null> => {
    const key = authority(hostname, port);
    const dialled = await dial(addresses.slice(0, MAX_DIAL_ATTEMPTS), port, track);
    if (typeof dialled === 'string') {
      if (!closed) {
        failures.set(
          key,
          new CheckError(
            'network',
            `${hostname} did not accept a connection on port ${String(port)} (${dialled})`,
          ),
        );
      }
      return null;
    }
    return dialled;
  };

  // Neither handler may reject unobserved: an unhandled rejection takes the
  // whole server down, and the input here is a stranger's page.
  const server = createServer((request, response) => {
    forward(request, response).catch(() => response.destroy());
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.on('connection', track);
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    tunnel(request, client, head).catch(() => client.destroy());
  });
  // Nothing but `CONNECT` should ask to upgrade through a proxy; anything else
  // is closed rather than relayed unjudged.
  server.on('upgrade', (_request: IncomingMessage, client: Duplex) => client.destroy());

  /**
   * Relays a plain HTTP request, which Chromium sends in absolute form.
   *
   * @param request What the browser sent.
   * @param response Where the answer goes.
   */
  async function forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = URL.canParse(request.url ?? '') ? new URL(request.url ?? '') : null;
    if (target?.protocol !== 'http:') {
      refuse(response, 400);
      return;
    }

    const port = target.port === '' ? 80 : Number(target.port);
    const key = authority(target.hostname, port);
    const addresses = await checkedAddresses(target.hostname, port);
    // No status is made up: the browser sees a load that failed, never an
    // error page the site did not send. Why is in `failures`.
    if (addresses === null) {
      response.destroy();
      return;
    }
    const socket = await connectTo(target.hostname, addresses, port);
    if (socket === null) {
      response.destroy();
      return;
    }
    if (closed || response.destroyed) {
      socket.destroy();
      return;
    }

    // `Proxy-*` headers are addressed to this hop and end here.
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-')),
    );

    const upstream = httpRequest({
      // The socket already dialled to a checked address. No `agent`: Node only
      // honours `createConnection` without one, and `agent: false` builds a
      // fresh agent that would dial the Host header's name instead.
      createConnection: () => socket,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      // The Host header the browser sent, not the address: virtual hosting
      // depends on it, and the address is only where the bytes go.
      headers,
      setHost: false,
      timeout: TIMEOUTS.httpHopMs,
    });
    // Whether the answer was relayed or the browser gave up on it, the
    // upstream request has nothing left to do.
    response.once('close', () => upstream.destroy());
    let timedOut = false;
    upstream.on('timeout', () => {
      timedOut = true;
      upstream.destroy();
    });
    upstream.on('error', (cause) => {
      if (!response.headersSent && !closed) {
        const what = timedOut
          ? `did not answer within ${String(TIMEOUTS.httpHopMs / 1000)}s`
          : `closed the connection before answering (${cause.message})`;
        failures.set(
          key,
          new CheckError('network', `${target.hostname} on port ${String(port)} ${what}`),
        );
      }
      response.destroy();
    });
    upstream.on('response', (answer) => {
      failures.delete(key);
      response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(response);
    });
    request.pipe(upstream);
  }

  /**
   * Opens a `CONNECT` tunnel to a checked address.
   *
   * @param request The `CONNECT` request, whose target is `host:port`.
   * @param client The browser's socket.
   * @param head Bytes the browser sent after the request, to pass on.
   */
  async function tunnel(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const requested = request.url ?? '';
    const parsed = URL.canParse(`http://${requested}`) ? new URL(`http://${requested}`) : null;
    const port = parsed === null ? NaN : Number(parsed.port === '' ? 80 : parsed.port);
    const addresses =
      parsed === null || !Number.isInteger(port)
        ? null
        : await checkedAddresses(parsed.hostname, port);

    // A status here is the proxy protocol's answer to `CONNECT`, which a
    // browser never shows a page as the site's: it fails the load instead.
    if (parsed === null || addresses === null) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const upstream = await connectTo(parsed.hostname, addresses, port);
    if (upstream === null) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    // The browser can give up while the name is resolved or dialled, and a
    // socket opened after that would relay to nobody, for as long as it idled.
    if (client.destroyed || closed) {
      upstream.destroy();
      return;
    }
    failures.delete(authority(parsed.hostname, port));
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.once('close', () => upstream.destroy());

    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const { port } = server.address() as { port: number };

  return {
    server: `http://127.0.0.1:${String(port)}`,
    failureFor: (target) => {
      const port = target.port === '' ? DEFAULT_PORTS[target.protocol] : Number(target.port);
      return port === undefined ? null : (failures.get(authority(target.hostname, port)) ?? null);
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        closed = true;
        for (const socket of open) socket.destroy();
        server.close(() => {
          resolveClose();
        });
      }),
  };
}

/**
 * @param address An address literal.
 * @param port The port to be connected to.
 * @returns The URL the policy judges: `https:` for 443, `http:` for anything
 *   else, so a tunnel to any port but the two web ports is refused by the same
 *   rule that refuses it everywhere else.
 * @throws Never.
 */
function targetFor(address: string, port: number): URL {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return port === 443 ? new URL(`https://${host}/`) : new URL(`http://${host}:${String(port)}/`);
}

/**
 * Connects to the first address that answers within a hop's deadline.
 *
 * @param addresses Checked addresses, in the resolver's order.
 * @param port The port.
 * @param track Registers each attempt as it starts, so closing the proxy
 *   stops one still in flight instead of leaving it to connect afterwards.
 * @returns The connected socket, or why the last address did not connect.
 * @throws Never.
 */
async function dial(
  addresses: readonly string[],
  port: number,
  track: (socket: Socket) => void,
): Promise<Socket | string> {
  let reason = 'no address to try';
  for (const address of addresses) {
    const socket = await new Promise<Socket | null>((resolveDial) => {
      const attempt = connect({ host: address, port });
      track(attempt);
      reason = 'the connection was abandoned';
      const timer = setTimeout(() => {
        reason = `timed out after ${String(TIMEOUTS.httpHopMs / 1000)}s`;
        attempt.destroy();
      }, TIMEOUTS.httpHopMs);
      attempt.once('connect', () => {
        clearTimeout(timer);
        resolveDial(attempt);
      });
      attempt.once('error', (cause: NodeJS.ErrnoException) => {
        reason = cause.code === 'ECONNREFUSED' ? 'connection refused' : cause.message;
      });
      // Every way an attempt ends without connecting closes it: an error, the
      // deadline above, or the proxy closing underneath it.
      attempt.once('close', () => {
        clearTimeout(timer);
        resolveDial(null);
      });
    });
    if (socket !== null) return socket;
  }
  return reason;
}

/**
 * @param hostname A host as the browser named it, from a parsed URL.
 * @param port The port.
 * @returns The key a failure is remembered under.
 * @throws Never.
 */
function authority(hostname: string, port: number): string {
  return `${hostname.toLowerCase()}:${String(port)}`;
}

/**
 * @param cause Whatever a resolver or the policy threw.
 * @param fallback What to say when it is not one of this project's errors.
 * @returns It as a {@link CheckError}, its wording kept when it already is one.
 * @throws Never.
 */
function asCheckError(cause: unknown, fallback: string): CheckError {
  if (cause instanceof CheckError) return cause;
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new CheckError('network', `${fallback}: ${detail}`, { cause });
}

/**
 * @param response The response to refuse.
 * @param status Why.
 * @throws Never.
 */
function refuse(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-length': '0' });
  response.end();
}
