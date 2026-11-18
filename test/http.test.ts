import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../src/lib/constants.js';

/**
 * The HTTP entrypoint, driven over a real socket.
 *
 * It binds a loopback port and speaks to itself; it reaches nothing else,
 * because the entrypoint's own guard refuses every target that is not public —
 * which is one of the things asserted here.
 */
const PROTOCOL_VERSION = '2026-07-28';
const PORT = 8791;
const BASE = `http://127.0.0.1:${String(PORT)}`;

const repoRoot = new URL('..', import.meta.url);
const tsx = fileURLToPath(new URL('node_modules/tsx/dist/cli.mjs', repoRoot));
const entrypoint = fileURLToPath(new URL('src/http.ts', repoRoot));

let child: ChildProcessWithoutNullStreams;

/** Sends one JSON-RPC request and reads the answer out of the event stream. */
async function call(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  status: number;
  body: { result?: Record<string, unknown>; error?: { message: string } };
}> {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const text = await response.text();
  const payload = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .join('');

  return {
    status: response.status,
    body: payload === '' ? {} : (JSON.parse(payload) as { result?: Record<string, unknown> }),
  };
}

/** Reads the text of a tool result, whatever it decided. */
function toolText(body: { result?: Record<string, unknown> }): string {
  const content = (body.result?.['content'] ?? []) as { text?: string }[];
  return content.map((block) => block.text ?? '').join('\n');
}

/** Starts the entrypoint on a port, resolving once it is listening. */
async function startServer(
  port: number,
  flags: readonly string[],
): Promise<ChildProcessWithoutNullStreams> {
  const started = spawn(process.execPath, [tsx, entrypoint, '--port', String(port), ...flags], {
    cwd: fileURLToPath(repoRoot),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the server did not start within 20s'));
    }, 20_000);
    started.stderr.setEncoding('utf8');
    started.stderr.on('data', (chunk: string) => {
      if (chunk.includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return started;
}

beforeAll(async () => {
  // As deployed on Cloud Run, behind a front end that appends the caller's
  // address: the limiter tests below tell callers apart by that header.
  child = await startServer(PORT, ['--forwarded-for-hops', '0']);

  await call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'http-test', version: '0.0.0' },
  });
}, 30_000);

afterAll(() => {
  child.kill();
});

describe('the HTTP entrypoint', () => {
  it('answers a browser with something a person can read', async () => {
    const response = await fetch(BASE);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain(`${SERVER_NAME} ${SERVER_VERSION}`);
    expect(text).toContain('/mcp');
  });

  it('answers an unknown path with 404, not with the landing page', async () => {
    // Answering everything with 200 told a crawler and a browser asking for a
    // favicon that they had found something.
    const response = await fetch(`${BASE}/favicon.ico`);

    expect(response.status).toBe(404);
    expect(await response.text()).toContain('/mcp');
  });

  it.each([
    ['a malformed Host header', 'GET / HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'],
    ['an empty authority', 'GET // HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'],
  ])('answers %s with 400 and stays up', async (_label, rawRequest) => {
    // Raw socket, because `fetch` refuses to send either of these. An exception
    // here used to become an unhandled rejection that ended the process.
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(PORT, '127.0.0.1', () => socket.write(rawRequest));
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (received += chunk));
      socket.on('end', () => {
        resolve(received);
      });
      socket.on('error', reject);
    });

    expect(answer).toMatch(/^HTTP\/1\.1 400 /);
    expect((await fetch(BASE)).status).toBe(200);
  });

  it('serves the same tools as the stdio entrypoint', async () => {
    const { body } = await call('tools/list');
    const tools = (body.result?.['tools'] ?? []) as { name: string }[];

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'accessibility_audit',
      'domain_check',
      'health',
      'portfolio_report',
      'seo_audit',
      'site_crawl',
      'ssl_check',
      'uptime_check',
    ]);
  });

  it('runs a tool that needs no network', async () => {
    const { body } = await call('tools/call', { name: 'health', arguments: {} });

    expect(toolText(body)).toContain(SERVER_VERSION);
  });

  it('refuses a target that is not on the public internet', async () => {
    // The whole reason this entrypoint builds its own ports.
    const { body } = await call('tools/call', {
      name: 'uptime_check',
      arguments: { url: `${BASE}/` },
    });

    expect(body.result?.['isError']).toBe(true);
    expect(toolText(body)).toContain('only contacts the public internet');
    expect(toolText(body)).toContain('loopback');
  });

  it('refuses more inline sites than one call may ask for', async () => {
    const { body } = await call('tools/call', {
      name: 'portfolio_report',
      arguments: {
        sites: Array.from({ length: 201 }, (_unused, index) => ({
          name: `Site ${String(index)}`,
          url: `https://site${String(index)}.example`,
        })),
      },
    });

    expect(JSON.stringify(body)).toMatch(/200|too_big|Too big/);
    expect(toolText(body)).not.toContain('sites checked');
  });

  it('opens no file a caller names', async () => {
    const { body } = await call('tools/call', {
      name: 'portfolio_report',
      arguments: { file: 'package.json' },
    });

    expect(body.result?.['isError']).toBe(true);
    expect(toolText(body)).toContain('reads no portfolio files');
  });

  it('refuses to open a port other than 443', async () => {
    const { body } = await call('tools/call', {
      name: 'ssl_check',
      arguments: { domain: 'example.com', port: 8443 },
    });

    expect(body.result?.['isError']).toBe(true);
    expect(toolText(body)).toContain('port scanner');
  });

  it('rate limits a caller that spends its burst, without dropping the connection', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      statuses.push((await call('tools/list')).status);
    }

    // A refusal is an answer, not a closed socket: a client must be able to
    // read why it was turned away.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(0);
  }, 30_000);

  it('does not let a caller hold a slot by sending its body slowly', async () => {
    // The slot used to be taken before the body was read, so a client that sent
    // headers and then dribbled — or never sent — its body held one for as long
    // as Node let the request live, five minutes by default. Nine of them shut
    // the instance to everybody without spending a single tool call.
    const stalled = await Promise.all(
      Array.from(
        { length: 9 },
        (_unused, index) =>
          new Promise<ReturnType<typeof connect>>((resolve, reject) => {
            const socket = connect(PORT, '127.0.0.1', () => {
              socket.write(
                'POST /mcp HTTP/1.1\r\nHost: localhost\r\n' +
                  'content-type: application/json\r\n' +
                  'accept: application/json, text/event-stream\r\n' +
                  `x-forwarded-for: 198.51.100.${String(index)}\r\n` +
                  'content-length: 1000\r\n\r\n{"jsonrpc"',
              );
              resolve(socket);
            });
            socket.on('error', reject);
          }),
      ),
    );
    // Long enough for the server to have read the headers of every one.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const stillServed = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': '198.51.100.200',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 399, method: 'tools/list', params: {} }),
    });

    expect(stillServed.status).toBe(200);
    await stillServed.text();
    for (const socket of stalled) socket.destroy();
  }, 30_000);

  it('does not give a fresh bucket to a caller who writes their own X-Forwarded-For', async () => {
    // Behind the platform proxy the last entry is the one it appended. With no
    // proxy, as here, that is whatever the caller sent last, so the caller's own
    // spoofing goes on the left and a constant goes on the right.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': `10.${String(attempt)}.0.1, 192.0.2.77`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 500 + attempt, method: 'tools/list' }),
      });
      await response.text();
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  }, 30_000);

  it('does not let open streams exhaust the concurrency cap', async () => {
    // The entrypoint holds a caller's concurrency slot until the response body
    // has finished writing. A response that never finishes would hold one for
    // ever, and twelve of them would close the instance to everybody — there is
    // no authentication in front of this.
    //
    // `subscriptions/listen` is the request that asks for such a stream. It is
    // refused with -32601 today, because `createServer` registers no
    // subscription capability. This test fails the day one is added without the
    // limiter learning to tell a long-lived stream from a request.
    const streams = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        fetch(`${BASE}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            // Distinct callers, so this measures the global concurrency cap and
            // not one caller's token bucket.
            'x-forwarded-for': `203.0.113.${String(index)}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 200 + index,
            method: 'subscriptions/listen',
            params: { notifications: { toolsListChanged: true } },
          }),
        }),
      ),
    );

    // Deliberately left unread: an unfinished body is the whole point.
    const stillServed = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-for': '203.0.113.200',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 299, method: 'tools/list', params: {} }),
    });

    expect(stillServed.status).toBe(200);

    await Promise.all(streams.map(async (stream) => stream.body?.cancel()));
    await stillServed.text();
  }, 30_000);
});

describe('the HTTP entrypoint started without --forwarded-for-hops', () => {
  const BARE_PORT = PORT + 1;
  let bare: ChildProcessWithoutNullStreams | undefined;

  beforeAll(async () => {
    bare = await startServer(BARE_PORT, []);
  }, 30_000);

  afterAll(() => {
    bare?.kill();
  });

  it('does not let a caller rotate X-Forwarded-For into fresh buckets', async () => {
    // The published image runs this way under a plain `docker run`, with nothing
    // in front to rewrite the header. Trusting its last entry by default gave
    // every request with a new made-up address a bucket of its own.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${String(BARE_PORT)}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-forwarded-for': `10.${String(attempt)}.0.1`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 700 + attempt, method: 'tools/list' }),
      });
      await response.text();
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  }, 30_000);
});

/**
 * Starts the entrypoint with exactly these arguments and reads what it says on
 * the way up, stopping it once it has said how it keys callers.
 */
async function startup(args: readonly string[]): Promise<{ code: number | null; said: string }> {
  const started = spawn(process.execPath, [tsx, entrypoint, ...args], {
    cwd: fileURLToPath(repoRoot),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let said = '';
  started.stderr.setEncoding('utf8');
  started.stderr.on('data', (chunk: string) => {
    said += chunk;
    if (said.includes('rate limiting callers')) started.kill();
  });
  const timer = setTimeout(() => started.kill(), 20_000);
  const code = await new Promise<number | null>((resolve) => {
    started.on('exit', (exitCode) => {
      resolve(exitCode);
    });
  });
  clearTimeout(timer);
  return { code, said };
}

describe('the HTTP entrypoint command line', () => {
  const ARGS_PORT = PORT + 2;

  it.each([[['--forwarded-for-hops', '0']], [['--forwarded-for-hops=0']]])(
    'honours %j and the port, in either form',
    async (hops) => {
      for (const port of [['--port', String(ARGS_PORT)], [`--port=${String(ARGS_PORT)}`]]) {
        const { said } = await startup([...port, ...hops]);

        expect(said).toContain(`listening on http://0.0.0.0:${String(ARGS_PORT)}/mcp`);
        expect(said).toContain("X-Forwarded-For, 0 trusted entries after the client's");
      }
    },
    60_000,
  );

  it.each([
    [['--forwarded-for-hop=0'], 'Unknown option'],
    [['--port', String(ARGS_PORT), 'extra'], 'positional argument'],
    [['--forwarded-for-hops=-1'], '--forwarded-for-hops takes'],
    [['--forwarded-for-hops='], 'got nothing'],
    [['--forwarded-for-hops'], 'argument missing'],
    [['--port=http'], '--port takes'],
    [['--port', '70000'], '--port takes'],
  ])(
    'refuses %j with exit code 2 and says why',
    async (args, reason) => {
      const { code, said } = await startup(args);

      expect(code).toBe(2);
      expect(said).toContain(reason);
      expect(said).toContain('usage:');
      expect(said).not.toContain('listening on');
    },
    30_000,
  );
});
