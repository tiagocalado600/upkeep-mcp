import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { writeResponse } from '../../src/lib/write-response.js';

let server: Server | undefined;

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe('writeResponse', () => {
  it('settles and cancels the source when the client disconnects mid-answer', async () => {
    let cancelled = false;
    const neverEnds = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
      },
      cancel() {
        cancelled = true;
      },
    });

    const written = new Promise<void>((resolve, reject) => {
      server = createServer((_request, response) => {
        writeResponse(response, new Response(neverEnds)).then(resolve, reject);
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server?.address() as AddressInfo;
        const socket = connect(port, '127.0.0.1', () => {
          socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
        });
        socket.once('data', () => socket.destroy());
      });
    });

    // Before the fix this never settled, which is what held a concurrency slot.
    await expect(written).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
  });

  it('writes a whole body when nobody disconnects', async () => {
    server = createServer((_request, response) => {
      void writeResponse(response, new Response('hello', { status: 201 }));
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${String(port)}/`);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('hello');
  });

  it('rethrows a failure of the source, which is not a disconnect', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error('the source broke');
      },
    });

    const written = new Promise<void>((resolve, reject) => {
      server = createServer((_request, response) => {
        writeResponse(response, new Response(failing)).then(resolve, reject);
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server?.address() as AddressInfo;
        fetch(`http://127.0.0.1:${String(port)}/`).catch(() => undefined);
      });
    });

    await expect(written).rejects.toThrow('the source broke');
  });
});
