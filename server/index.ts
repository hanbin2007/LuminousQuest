import path from 'node:path';

import { serve } from '@hono/node-server';
import { config as loadEnvironment } from 'dotenv';

import { createServerApp } from './app';
import { loadAllConfig, ConfigValidationError } from './config/loader';
import { RecordingStore, RecordingValidationError } from './llm/recording-store';
import { resolveClientRoot, resolveContentRoot } from './runtime/content-root';
import { openBrowser } from './runtime/open-browser';
import { findAvailablePort } from './runtime/ports';

const host = '127.0.0.1' as const;

async function main() {
  const contentRoot = resolveContentRoot();
  loadEnvironment({ path: path.join(contentRoot, '.env'), quiet: true });

  await loadAllConfig(contentRoot);
  const recordings = new RecordingStore(contentRoot);
  await recordings.validateDemoAssets();

  const preferredPort = Number.parseInt(process.env.LQ_PORT ?? '4173', 10);
  const port = await findAvailablePort({ host, preferredPort, attempts: 100 });
  if (port !== preferredPort) {
    console.log(`[startup] Port ${preferredPort} is occupied; selected ${port} instead.`);
  }

  const app = createServerApp({
    contentRoot,
    clientRoot: resolveClientRoot(contentRoot),
  });
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    const url = `http://${host}:${info.port}`;
    console.log(`[startup] LuminousQuest is ready at ${url}`);
    console.log(`[startup] External content: ${contentRoot}`);
    openBrowser(url);
  });

  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received; closing local server.`);
    server.close((error) => {
      if (error) {
        console.error(`[shutdown] ${error.message}`);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigValidationError || error instanceof RecordingValidationError) {
    console.error(`[startup] ${error.file} | ${error.field} | ${error.reason}`);
  } else {
    console.error(`[startup] ${(error as Error).message}`);
  }
  process.exitCode = 1;
});

