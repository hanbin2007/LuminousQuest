import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import type { ServerType } from '@hono/node-server';

import { findAvailablePort } from '../server/runtime/ports';
import { serveOnLoopback, type ServeImplementation } from '../server/runtime/serve-on-loopback';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('port detection', () => {
  it('skips an occupied loopback port instead of taking it over', async () => {
    const occupied = createServer();
    servers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

    const selected = await findAvailablePort({
      host: '127.0.0.1',
      preferredPort: address.port,
      attempts: 20,
    });

    expect(selected).toBeGreaterThan(address.port);
    expect(selected).toBeLessThanOrEqual(address.port + 20);
  });

  it('binds only to 127.0.0.1 and retries when serve loses an EADDRINUSE race', async () => {
    const attempts: Array<{ hostname?: string; port?: number }> = [];
    const serveImplementation: ServeImplementation = (options, listeningListener) => {
      attempts.push({ hostname: options.hostname, port: options.port });
      const server = new EventEmitter() as ServerType;
      if (attempts.length === 1) {
        queueMicrotask(() => {
          const error = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
          server.emit('error', error);
        });
      } else {
        queueMicrotask(() =>
          listeningListener?.({ address: '127.0.0.1', family: 'IPv4', port: options.port ?? 0 }),
        );
      }
      return server;
    };

    const started = await serveOnLoopback({
      fetch: () => new Response('ok'),
      preferredPort: 4173,
      attempts: 2,
      serveImplementation,
    });

    expect(started.port).toBe(4174);
    expect(attempts).toEqual([
      { hostname: '127.0.0.1', port: 4173 },
      { hostname: '127.0.0.1', port: 4174 },
    ]);
  });
});
