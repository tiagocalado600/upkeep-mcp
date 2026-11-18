import { createServer, request, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startGuardedProxy, type GuardedProxy } from '../../src/lib/browser-proxy.js';
import { CheckError } from '../../src/lib/errors.js';

/**
 * The proxy every browser connection goes through on a public instance.
 *
 * Everything here stays on loopback: the "public" names are resolved by an
 * injected resolver to a local server, which is exactly the property under
 * test — the proxy connects to the address it checked, whatever a second
 * lookup of the name would have said.
 */

let upstream: Server | undefined;
let proxy: GuardedProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await new Promise<void>((resolve) => {
    if (upstream === undefined) resolve();
    else
      upstream.close(() => {
        resolve();
      });
  });
  proxy = undefined;
  upstream = undefined;
});

/** A local server that answers with the Host header it was sent. */
async function startUpstream(): Promise<number> {
  const server = createServer((incoming, response) => {
    response.end(`host=${incoming.headers.host ?? ''}`);
  });
  upstream = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** A policy allowing only the given address literals, recording what it was asked. */
function allowing(...addresses: string[]): {
  allow: (target: URL) => Promise<void>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    allow: (target) => {
      asked.push(target.href);
      return addresses.includes(target.hostname)
        ? Promise.resolve()
        : Promise.reject(new CheckError('invalid_input', `${target.hostname} is not public`));
    },
  };
}

/** Sends a plain HTTP request through the proxy, as Chromium does: absolute form. */
async function viaProxy(target: string): Promise<{ status: number; body: string }> {
  const { port, hostname } = new URL(proxy?.server ?? '');
  return new Promise((resolve, reject) => {
    // The Host header names the target, as a browser's does; the connection
    // goes to the proxy.
    const host = URL.canParse(target) ? new URL(target).host : 'localhost';
    const outgoing = request(
      { host: hostname, port, path: target, headers: { host } },
      (answer) => {
        let body = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk: string) => (body += chunk));
        answer.on('end', () => {
          resolve({ status: answer.statusCode ?? 0, body });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Opens a CONNECT tunnel and returns the proxy's status line, then what came through. */
async function tunnelTo(authority: string, send: string): Promise<string> {
  const { port, hostname } = new URL(proxy?.server ?? '');
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let received = '';
    let sent = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
      if (!sent && received.includes('\r\n\r\n') && received.startsWith('HTTP/1.1 200')) {
        sent = true;
        socket.write(send);
      }
    });
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', reject);
    setTimeout(() => socket.end(), 1000);
  });
}

describe('startGuardedProxy', () => {
  it('connects to the address it checked, not to whatever the name says later', async () => {
    // The browser used to resolve names itself, after the guard had. A name that
    // answered with a public address for the guard and with 169.254.169.254 for
    // the browser walked past every check. Here the proxy resolves once, judges
    // the literal, and connects to that literal.
    const port = await startUpstream();
    const policy = allowing('127.0.0.1');
    const lookups: string[] = [];
    proxy = await startGuardedProxy({
      allow: policy.allow,
      resolve: (hostname) => {
        lookups.push(hostname);
        return Promise.resolve(['127.0.0.1']);
      },
    });

    const answer = await viaProxy(`http://site.example:${String(port)}/page`);

    expect(answer).toEqual({ status: 200, body: `host=site.example:${String(port)}` });
    expect(lookups).toEqual(['site.example']);
    // Asked about the address, never the name.
    expect(policy.asked).toEqual([`http://127.0.0.1:${String(port)}/`]);
  });

  it('refuses a name when any of its addresses is refused, with no status the site never sent', async () => {
    // A made-up 403 reached the page as the site's own answer, and the audit
    // graded the site critical for an error page it never served.
    const port = await startUpstream();
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.resolve(['127.0.0.1', '169.254.169.254']),
    });
    const target = `http://site.example:${String(port)}/`;

    await expect(viaProxy(target)).rejects.toThrow(/socket hang up/);
    expect(proxy.failureFor(new URL(target))).toMatchObject({
      code: 'invalid_input',
      message: '169.254.169.254 is not public',
    });
  });

  it('refuses a name that does not resolve, and says so', async () => {
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.reject(new CheckError('not_found', 'no such name')),
    });

    await expect(viaProxy('http://missing.example/')).rejects.toThrow(/socket hang up/);
    expect(proxy.failureFor(new URL('http://missing.example/'))).toMatchObject({
      code: 'not_found',
      message: 'no such name',
    });
    // Another port on the same host is another question.
    expect(proxy.failureFor(new URL('https://missing.example/'))).toBeNull();
  });

  it('passes on an error status the site really sent, and blames nothing', async () => {
    const server = createServer((_incoming, response) => {
      response.writeHead(403).end('forbidden');
    });
    upstream = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    const target = `http://site.example:${String(port)}/`;

    await expect(viaProxy(target)).resolves.toEqual({ status: 403, body: 'forbidden' });
    expect(proxy.failureFor(new URL(target))).toBeNull();
  });

  it('tries the next checked address when the first will not connect', async () => {
    // The upstream listens on IPv4 only, so ::1 refuses at once.
    const port = await startUpstream();
    proxy = await startGuardedProxy({
      allow: allowing('[::1]', '127.0.0.1').allow,
      resolve: () => Promise.resolve(['::1', '127.0.0.1']),
    });

    await expect(viaProxy(`http://site.example:${String(port)}/`)).resolves.toMatchObject({
      status: 200,
    });
  });

  it('reports an address that will not connect as a failure to connect, not as the site', async () => {
    const port = await startUpstream();
    proxy = await startGuardedProxy({
      allow: allowing('[::1]').allow,
      resolve: () => Promise.resolve(['::1']),
    });
    const target = `http://site.example:${String(port)}/`;

    await expect(viaProxy(target)).rejects.toThrow(/socket hang up/);
    expect(proxy.failureFor(new URL(target))).toMatchObject({
      code: 'network',
      message: expect.stringMatching(
        /did not accept a connection on port \d+ \(connection refused\)/,
      ) as unknown,
    });
  });

  it('reports a site that hangs up before answering as a failed check, not as a 502', async () => {
    const server = createServer((incoming) => {
      incoming.socket.destroy();
    });
    upstream = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });
    const target = `http://site.example:${String(port)}/`;

    await expect(viaProxy(target)).rejects.toThrow(/socket hang up/);
    expect(proxy.failureFor(new URL(target))).toMatchObject({
      code: 'network',
      message: expect.stringMatching(/closed the connection before answering/) as unknown,
    });
  });

  it('stops relaying when the browser hangs up', async () => {
    // The upstream request used to outlive the browser's socket, streaming an
    // answer to nobody until the site finished it.
    let upstreamClosed: () => void = () => undefined;
    const closedUpstream = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const server = createServer((_incoming, response) => {
      response.writeHead(200);
      response.write('first chunk');
      response.on('close', upstreamClosed);
    });
    upstream = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });

    const { port: proxyPort, hostname } = new URL(proxy.server);
    const outgoing = request({
      host: hostname,
      port: proxyPort,
      path: `http://site.example:${String(port)}/`,
      headers: { host: `site.example:${String(port)}` },
    });
    outgoing.on('error', () => undefined);
    outgoing.on('response', (answer) => {
      answer.once('data', () => outgoing.destroy());
    });
    outgoing.end();

    await expect(
      Promise.race([
        closedUpstream.then(() => 'closed'),
        new Promise((resolve) =>
          setTimeout(() => {
            resolve('still open');
          }, 2000),
        ),
      ]),
    ).resolves.toBe('closed');
  });

  it('opens nothing after it is closed, even for a tunnel it was still resolving', async () => {
    // A name still being looked up when the audit ended used to connect
    // afterwards, holding a socket open that nothing would ever close.
    const port = await startUpstream();
    let connections = 0;
    upstream?.on('connection', () => (connections += 1));
    let answer: (addresses: string[]) => void = () => undefined;
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () =>
        new Promise<string[]>((resolve) => {
          answer = resolve;
        }),
    });

    const tunnelled = tunnelTo(`site.example:${String(port)}`, '');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await proxy.close();
    answer(['127.0.0.1']);
    await tunnelled;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(connections).toBe(0);
  });

  it('caps how many connections the browser may hold open through it', async () => {
    proxy = await startGuardedProxy({ allow: allowing().allow });
    const { port, hostname } = new URL(proxy.server);
    const sockets = await Promise.all(
      Array.from(
        { length: 80 },
        () =>
          new Promise<Socket>((resolve) => {
            const socket = connect(Number(port), hostname, () => {
              resolve(socket);
            });
            socket.on('error', () => undefined);
          }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    const dropped = sockets.filter((socket) => socket.destroyed || socket.readableEnded).length;
    for (const socket of sockets) socket.destroy();
    expect(dropped).toBeGreaterThanOrEqual(80 - 64);
  });

  it('refuses a tunnel to a refused address, which is how a WebSocket from a worker arrives', async () => {
    // Playwright's WebSocket routing replaces the constructor in the page's own
    // JavaScript, so a worker's socket never meets it. Through a proxy, every
    // `ws:` and `wss:` connection is a CONNECT, from wherever it was opened.
    const port = await startUpstream();
    proxy = await startGuardedProxy({ allow: allowing('192.0.2.1').allow });

    const answer = await tunnelTo(`127.0.0.1:${String(port)}`, 'GET / HTTP/1.1\r\n\r\n');

    expect(answer).toMatch(/^HTTP\/1\.1 403 /);
  });

  it('judges a tunnel to 443 as HTTPS and any other port as HTTP on that port', async () => {
    const policy = allowing();
    proxy = await startGuardedProxy({
      allow: policy.allow,
      resolve: () => Promise.resolve(['203.0.113.9', '2001:db8::9']),
    });

    await tunnelTo('site.example:443', '');
    await tunnelTo('site.example:22', '');

    expect(policy.asked).toEqual([
      'https://203.0.113.9/',
      'https://[2001:db8::9]/',
      'http://203.0.113.9:22/',
      'http://[2001:db8::9]:22/',
    ]);
  });

  it('opens a tunnel to an allowed address and relays both ways', async () => {
    const port = await startUpstream();
    proxy = await startGuardedProxy({
      allow: allowing('127.0.0.1').allow,
      resolve: () => Promise.resolve(['127.0.0.1']),
    });

    const answer = await tunnelTo(
      `site.example:${String(port)}`,
      'GET / HTTP/1.1\r\nHost: site.example\r\nConnection: close\r\n\r\n',
    );

    expect(answer).toMatch(/^HTTP\/1\.1 200 Connection Established/);
    expect(answer).toContain('host=site.example');
  });

  it('refuses a request that is not an absolute http URL', async () => {
    proxy = await startGuardedProxy({ allow: allowing('127.0.0.1').allow });

    await expect(viaProxy('/relative')).resolves.toMatchObject({ status: 400 });
  });
});
