import { createServer } from 'node:net';

export interface PortSearchOptions {
  host?: '127.0.0.1';
  preferredPort: number;
  attempts?: number;
}

async function isPortAvailable(host: string, port: number) {
  return new Promise<boolean>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen(port, host, () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

export async function findAvailablePort({
  host = '127.0.0.1',
  preferredPort,
  attempts = 100,
}: PortSearchOptions) {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new RangeError(`Invalid preferred port: ${preferredPort}`);
  }

  for (let offset = 0; offset <= attempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    if (await isPortAvailable(host, port)) return port;
  }

  throw new Error(
    `No available port on ${host} in range ${preferredPort}-${Math.min(65_535, preferredPort + attempts)}`,
  );
}

