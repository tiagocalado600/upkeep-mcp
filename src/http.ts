#!/usr/bin/env node
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { parseArgs } from 'node:util';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from './lib/constants.js';
import { clientKey, createInboundLimiter } from './lib/inbound-limit.js';
import { createDefaultPorts } from './lib/ports.js';
import { writeResponse } from './lib/write-response.js';
import { createServer } from './server.js';

/**
 * The Streamable HTTP entrypoint, for a publicly reachable instance.
 *
 * Two things differ from the stdio entrypoint, and both are consequences of the
 * caller being a stranger rather than the person who started the process:
 * every tool is handed ports that refuse anything but public targets on port
 * 443 (`docs/adr/0012`), and inbound traffic is admitted through a per-client
 * token bucket, a per-client concurrency cap and a global one.
 *
 * The Node-to-web adaptation below is deliberately hand-written. The SDK
 * documents `toNodeHandler` from `@modelcontextprotocol/node` for this, and it
 * would be one more dependency to carry for sixty lines that this project can
 * own and test.
 *
 * The port is read from `--port`, and whether to trust `X-Forwarded-For` from
 * `--forwarded-for-hops`, never from the environment: a test asserts
 * that nothing under `src/` reads `process.env`, which is how "this server
 * needs no configuration and holds no secrets" stays a fact rather than a
 * claim. Cloud Run's default container port is 8080, which is this default.
 */

/** Where the MCP endpoint lives. Anything else gets the human-readable page. */
const MCP_PATH = '/mcp';

/** Most bytes accepted in one request body. MCP messages are small. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * How much traffic one demo instance will take.
 *
 * Sized for what a demo is: someone connects a client, lists the tools, calls
 * two or three. Sixty a minute is generous for that and useless for anyone
 * hoping to borrow the egress.
 */
const LIMITS = {
  perClientPerMinute: 60,
  burst: 20,
  maxConcurrent: 8,
  // Two, because a `portfolio_report` or `accessibility_audit` can run for
  // minutes, and the burst alone would let one caller fill all eight slots.
  perClientConcurrent: 2,
  maxClients: 1000,
} as const;

/**
 * The most `--forwarded-for-hops` may be. Two proxies in front of this is
 * already unusual; a larger number is a typo, not a topology.
 */
const MAX_FORWARDED_FOR_HOPS = 4;

/**
 * How long a client has to deliver its request line and headers, and then the
 * whole request. Node's defaults are 60 s and 300 s, sized for uploads. An MCP
 * message is a few kilobytes and arrives in one write; a request still arriving
 * after ten seconds is not a slow network, it is someone holding a socket open.
 * The body is read before a concurrency slot is taken, so this bounds sockets,
 * not slots — but sockets are finite too.
 */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How often Node checks those two deadlines. Its default of 30 s would let a
 * stalled request live up to twice as long as the deadline says.
 */
const TIMEOUT_CHECK_INTERVAL_MS = 5_000;

const { port, forwardedForHops } = readArguments(process.argv.slice(2));
const ports = createDefaultPorts({ publicTargetsOnly: true });
const handler = createMcpHandler(() => createServer(ports));
const limiter = createInboundLimiter(LIMITS);

const server = createHttpServer(
  {
    headersTimeout: HEADERS_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionsCheckingInterval: TIMEOUT_CHECK_INTERVAL_MS,
  },
  (request, response) => {
    void route(request, response);
  },
);

server.listen(port, () => {
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} listening on http://0.0.0.0:${String(port)}${MCP_PATH}`,
  );
  console.error(
    forwardedForHops === null
      ? 'rate limiting callers by socket address; pass --forwarded-for-hops behind a proxy that writes X-Forwarded-For'
      : `rate limiting callers by X-Forwarded-For, ${String(forwardedForHops)} trusted entries after the client's`,
  );
});

/**
 * Routes one request: the landing page, or the MCP endpoint behind the limiter.
 *
 * @param request The incoming request.
 * @param response The response to write.
 * @returns Nothing; every failure is answered rather than thrown.
 * @throws Never.
 */
async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = parseRequestUrl(request);
  if (url === null) {
    respond(response, 400, 'text/plain; charset=utf-8', 'malformed request URL or Host header\n');
    return;
  }

  if (url.pathname === '/') {
    respond(response, 200, 'text/plain; charset=utf-8', landingPage());
    return;
  }

  if (url.pathname !== MCP_PATH) {
    // Answering every path with the landing page told a crawler, a browser
    // asking for a favicon, and a person with a typo that they had found
    // something. Only one path here serves anything.
    respond(
      response,
      404,
      'text/plain; charset=utf-8',
      `nothing here. The MCP endpoint is ${MCP_PATH}\n`,
    );
    return;
  }

  // The body is read before a slot is taken. The other way round, a client
  // that sent its headers and then nothing held a slot until the request
  // deadline, and nine of them closed the instance without running a tool.
  let body: Buffer | null;
  try {
    body = await readBody(request);
  } catch {
    // The client went away or the request deadline closed the socket; there is
    // nobody left to answer.
    return;
  }
  if (body === null) {
    respond(response, 413, 'text/plain; charset=utf-8', 'request body too large\n');
    return;
  }

  const admission = limiter.admit(
    clientKey(headerOf(request, 'x-forwarded-for'), request.socket.remoteAddress, forwardedForHops),
  );
  if (!admission.ok) {
    respond(response, admission.status, 'text/plain; charset=utf-8', `${admission.message}\n`);
    return;
  }

  try {
    // The slot is held until the body has finished writing, not until the
    // handler returns: what the cap is protecting is the outbound work a tool
    // does while it streams its answer. A client that disconnects ends the write
    // too, which releases the slot.
    //
    // A stream nobody closes would still hold one: `subscriptions/listen` is
    // served over a stream that stays open until the client leaves, so eight of
    // them would hold every slot and shut the instance to everyone. The transport
    // refuses that method here — measured, including with a `bus` and subscription
    // capabilities declared — so the shape cannot arise. `test/http.test.ts` fails
    // if that ever changes.
    const answer = await handler.fetch(toWebRequest(request, url, body));
    await writeResponse(response, answer);
  } catch (cause) {
    // Nothing may escape: an unhandled rejection here would take the process
    // down and the demo with it.
    console.error('request failed', cause);
    if (!response.headersSent) {
      respond(response, 500, 'text/plain; charset=utf-8', 'internal error\n');
    } else {
      response.end();
    }
  } finally {
    admission.release();
  }
}

/**
 * Parses the target of a request.
 *
 * Both inputs are whatever a stranger typed: `Host: [` and `GET //` each make
 * `new URL` throw, and this runs before any handler could catch it.
 *
 * @param request The incoming request.
 * @returns The parsed URL, or `null` when the request line or `Host` is malformed.
 * @throws Never.
 */
function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    return null;
  }
}

/**
 * Reads the command line, refusing anything it does not understand.
 *
 * Strict, because both flags decide how the instance is exposed, and one that
 * was skipped started the server in a state nobody asked for without a sign of
 * it: `--forwarded-for-hops=0` used to read as absent, and `--port=8081` as
 * 8080. Both `--flag value` and `--flag=value` are accepted.
 *
 * Trusting `X-Forwarded-For` is opt-in, because the header is whatever the
 * caller sent unless something in front of this server rewrites it. The
 * published image runs without the flag, so a plain `docker run` keys callers
 * on the socket address; the Cloud Run deploy in `docs/deploying.md` passes
 * `--forwarded-for-hops 0`, Google's front end being the one that appends the
 * caller's address last.
 *
 * @param args The arguments after the script path.
 * @returns The port (`--port`, default 8080) and how many `X-Forwarded-For`
 *   entries a trusted front end appends after the client's, or `null` when
 *   `--forwarded-for-hops` is absent.
 * @throws Never; anything unusable stops the process with exit code 2 and a
 *   message. A port that is not one used to fall back to 8080, which on a
 *   platform routing to another port is a server that is up and unreachable;
 *   and guessing a hop count would either trust a header nobody vouches for or
 *   key every caller on a proxy.
 */
function readArguments(args: readonly string[]): {
  port: number;
  forwardedForHops: number | null;
} {
  let values: { port?: string | undefined; 'forwarded-for-hops'?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { port: { type: 'string' }, 'forwarded-for-hops': { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (cause) {
    return usage(cause instanceof Error ? cause.message : String(cause));
  }

  const port = values.port === undefined ? 8080 : integerIn(values.port, 1, 65_535);
  if (port === null) {
    return usage(`--port takes a TCP port from 1 to 65535; got ${shown(values.port)}`);
  }

  const hops = values['forwarded-for-hops'];
  if (hops === undefined) return { port, forwardedForHops: null };
  const forwardedForHops = integerIn(hops, 0, MAX_FORWARDED_FOR_HOPS);
  if (forwardedForHops === null) {
    return usage(
      `--forwarded-for-hops takes how many X-Forwarded-For entries your front end appends after the client's, 0 to ${String(MAX_FORWARDED_FOR_HOPS)}; got ${shown(hops)}`,
    );
  }
  return { port, forwardedForHops };
}

/**
 * @param value A flag's value.
 * @param min The smallest it may be.
 * @param max The largest it may be.
 * @returns It as an integer, or `null` when it is not a plain one in range.
 * @throws Never.
 */
function integerIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
}

/**
 * @param value A flag's value, possibly empty.
 * @returns It as a message shows it.
 * @throws Never.
 */
function shown(value: string | undefined): string {
  return value === undefined || value === '' ? 'nothing' : value;
}

/**
 * @param problem What was wrong with the command line.
 * @returns Never: it exits with code 2, the conventional code for a usage error.
 * @throws Never.
 */
function usage(problem: string): never {
  console.error(
    `${problem}\nusage: http.js [--port <1-65535>] [--forwarded-for-hops <0-${String(MAX_FORWARDED_FOR_HOPS)}>]`,
  );
  process.exit(2);
}

/**
 * @param request The incoming request.
 * @param name Header name, lowercase.
 * @returns The header value, joining repeats as the platform proxy would.
 * @throws Never.
 */
function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Reads a request body, refusing one that is too large.
 *
 * Buffered rather than streamed: MCP messages are small, and buffering is what
 * makes the size limit enforceable before anything is parsed.
 *
 * @param request The incoming request.
 * @returns The body, or `null` when it exceeded the limit.
 * @throws Whatever the socket throws.
 */
async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/**
 * @param request The incoming request.
 * @param url Its parsed URL.
 * @param body Its body.
 * @returns The same request as a web-standard `Request`, which is what the
 *   SDK's handler speaks.
 * @throws Never.
 */
function toWebRequest(request: IncomingMessage, url: URL, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = request.method ?? 'GET';
  return new Request(url, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

/**
 * @param response The response to write.
 * @param status HTTP status.
 * @param contentType Content type.
 * @param body The body.
 * @throws Never.
 */
function respond(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

/**
 * @returns What a person gets for pasting the URL into a browser. They are not
 *   the audience — an MCP client is — so it says what this is and where to
 *   point that client.
 * @throws Never.
 */
function landingPage(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    '',
    'A Model Context Protocol server for the recurring checks behind website',
    'maintenance: domains, SSL certificates, uptime and technical SEO.',
    '',
    `This is a demo instance. Point an MCP client at ${MCP_PATH} on this host.`,
    '',
    'It contacts only public addresses, on the web ports and on port 53 for the',
    'nameservers a domain itself publishes. It rate limits every caller and',
    'stores nothing.',
    'Source: https://github.com/tiagocalado600/upkeep-mcp',
    '',
  ].join('\n');
}
