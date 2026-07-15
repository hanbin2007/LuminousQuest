import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { findAvailablePort } from '../server/runtime/ports';

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
});

