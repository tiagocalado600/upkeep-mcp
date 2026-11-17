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
 */

/** A running proxy. */
export interface GuardedProxy {
  /** The address to hand Chromium, e.g. `http://127.0.0.1:53124`. */
  server: string;
  /** Stops accepting and destroys every open connection. */
  close(): Promise<void>;
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
 * Starts a guarded forward proxy on loopback.
 *
 * @param options The policy and the resolver.
 * @returns The running proxy. It must be closed, or its sockets outlive the audit.
 * @throws Whatever binding a loopback port throws, which is nothing in practice.
 */
export async function startGuardedProxy(options: GuardedProxyOptions): Promise<GuardedProxy> {
  const resolve = options.resolve ?? ((hostname: string) => resolveAddresses(hostname));
  const open = new Set<Duplex>();
  const track = (socket: Duplex): void => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  };

  /**
   * @param hostname The host as the browser asked for it.
   * @param port The port it asked for.
   * @returns The addresses that may be connected to, every one of them
   *   checked, or `null` when any was refused.
   */
  const checkedAddresses = async (hostname: string, port: number): Promise<string[] | null> => {
    const bare = hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = isIP(bare) === 0 ? await resolve(bare) : [bare];
    } catch {
      return null;
    }
    if (addresses.length === 0) return null;

    // Every address, as the guard does with names: one public and one private
    // answer is the standard way past a check that stops at the first.
    const verdicts = await Promise.all(
      addresses.map((address) =>
        options.allow(targetFor(address, port)).then(
          () => true,
          () => false,
        ),
      ),
    );
    return verdicts.every(Boolean) ? addresses : null;
  };

  // Neither handler may reject unobserved: an unhandled rejection takes the
  // whole server down, and the input here is a stranger's page.
  const server = createServer((request, response) => {
    forward(request, response).catch(() => response.destroy());
  });
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
    const addresses = await checkedAddresses(target.hostname, port);
    const address = addresses?.[0];
    if (address === undefined) {
      refuse(response, 403);
      return;
    }

    // `Proxy-*` headers are addressed to this hop and end here.
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !name.startsWith('proxy-')),
    );

    const upstream = httpRequest({
      host: address,
      port,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      // The Host header the browser sent, not the address: virtual hosting
      // depends on it, and the address is only where the bytes go.
      headers,
      setHost: false,
      agent: false,
      timeout: TIMEOUTS.httpHopMs,
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!response.headersSent) refuse(response, 502);
      else response.destroy();
    });
    upstream.on('response', (answer) => {
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
    const authority = request.url ?? '';
    const parsed = URL.canParse(`http://${authority}`) ? new URL(`http://${authority}`) : null;
    const port = parsed === null ? NaN : Number(parsed.port === '' ? 80 : parsed.port);
    const addresses =
      parsed === null || !Number.isInteger(port)
        ? null
        : await checkedAddresses(parsed.hostname, port);

    if (addresses === null) {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    const upstream = await dial(addresses, port);
    if (upstream === null) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    track(upstream);
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());

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
    close: () =>
      new Promise<void>((resolveClose) => {
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
 * @returns The connected socket, or `null` when none answered.
 * @throws Never.
 */
async function dial(addresses: readonly string[], port: number): Promise<Socket | null> {
  for (const address of addresses) {
    const socket = await new Promise<Socket | null>((resolveDial) => {
      const attempt = connect({ host: address, port });
      const timer = setTimeout(() => {
        attempt.destroy();
        resolveDial(null);
      }, TIMEOUTS.httpHopMs);
      attempt.once('connect', () => {
        clearTimeout(timer);
        resolveDial(attempt);
      });
      attempt.once('error', () => {
        clearTimeout(timer);
        resolveDial(null);
      });
    });
    if (socket !== null) return socket;
  }
  return null;
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
