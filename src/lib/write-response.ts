import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Writes a web-standard `Response` to a Node response.
 *
 * Piped rather than buffered: the streamable transport answers with an event
 * stream, and buffering one would hold every notification until the connection
 * closed.
 *
 * `pipeline` rather than `pipe`: a client that disconnects never produces
 * `finish`, and a caller waiting on that alone holds its concurrency slot for
 * ever. `pipeline` also cancels the source, so the answer stops being produced
 * for nobody.
 *
 * @param response The Node response to write.
 * @param answer What the handler produced.
 * @returns Nothing, once the body is written or the client has gone away.
 * @throws Whatever the source stream throws, or a socket failure other than the
 *   client disconnecting.
 */
export async function writeResponse(response: ServerResponse, answer: Response): Promise<void> {
  response.writeHead(answer.status, Object.fromEntries(answer.headers));

  const body = answer.body;
  if (body === null) {
    response.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(body), response);
  } catch (cause) {
    if (!isClientDisconnect(cause)) throw cause;
  }
}

/**
 * @param cause What `pipeline` rejected with.
 * @returns Whether the client simply went away, which is routine and not a
 *   server failure worth logging.
 * @throws Never.
 */
function isClientDisconnect(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    'code' in cause &&
    (cause.code === 'ERR_STREAM_PREMATURE_CLOSE' || cause.code === 'ECONNRESET')
  );
}
