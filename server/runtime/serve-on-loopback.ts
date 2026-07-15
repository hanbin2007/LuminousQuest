import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

export type ServeImplementation = typeof serve;
type FetchCallback = Parameters<ServeImplementation>[0]['fetch'];

export interface ServeOnLoopbackOptions {
  fetch: FetchCallback;
  preferredPort: number;
  attempts?: number;
  serveImplementation?: ServeImplementation;
}

export interface StartedLoopbackServer {
  server: ServerType;
  port: number;
}

const host = '127.0.0.1' as const;

function listenOnce(
  fetch: FetchCallback,
  port: number,
  serveImplementation: ServeImplementation,
) {
  return new Promise<StartedLoopbackServer>((resolve, reject) => {
    let server: ServerType;
    const onError = (error: Error) => {
      server?.removeListener('error', onError);
      reject(error);
    };
    try {
      server = serveImplementation({ fetch, hostname: host, port }, (info) => {
        server.removeListener('error', onError);
        resolve({ server, port: info.port });
      });
      server.once('error', onError);
    } catch (error) {
      reject(error);
    }
  });
}

export async function serveOnLoopback({
  fetch,
  preferredPort,
  attempts = 100,
  serveImplementation = serve,
}: ServeOnLoopbackOptions): Promise<StartedLoopbackServer> {
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new RangeError(`Invalid preferred port: ${preferredPort}`);
  }
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError(`Invalid port attempt count: ${attempts}`);
  }

  for (let offset = 0; offset <= attempts; offset += 1) {
    const port = preferredPort + offset;
    if (port > 65_535) break;
    try {
      return await listenOnce(fetch, port, serveImplementation);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
    }
  }

  throw new Error(
    `No available loopback port in range ${preferredPort}-${Math.min(65_535, preferredPort + attempts)}`,
  );
}
