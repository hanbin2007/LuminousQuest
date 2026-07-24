import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

import { config as loadEnvironment } from 'dotenv';

import { createServerApp } from './app';
import { AGENT_RECORDING_PROMPT } from './agent/context-builder';
import { loadAllConfig, ConfigValidationError } from './config/loader';
import { RecordingStore, RecordingValidationError } from './llm/recording-store';
import { loadAllPrompts, PromptValidationError } from './prompts/loader';
import { resolveClientRoot, resolveContentRoot } from './runtime/content-root';
import { FileSessionStore } from './session/store';
import { FileAgentTranscriptStore } from './agent/transcript-store';
import { openBrowser } from './runtime/open-browser';
import {
  demoLockEnabled,
  lanAccessUrls,
  parseLaunchOptions,
} from './runtime/launch-options';
import { serveOnHost } from './runtime/serve-on-loopback';

async function main() {
  const launch = parseLaunchOptions(process.argv.slice(2));
  const contentRoot = resolveContentRoot();
  loadEnvironment({ path: path.join(contentRoot, '.env'), quiet: true });
  const lockDemo = launch.lockDemo || demoLockEnabled(process.env.LQ_LOCK_DEMO);

  const [loadedConfig, prompts] = await Promise.all([
    loadAllConfig(contentRoot),
    loadAllPrompts(contentRoot),
  ]);
  const recordings = new RecordingStore(contentRoot);
  await recordings.validateDemoAssets({
    configVersion: loadedConfig.configVersion,
    prompts: {
      ...prompts,
      [AGENT_RECORDING_PROMPT.id]: AGENT_RECORDING_PROMPT,
    },
  });

  const preferredPort = Number.parseInt(process.env.LQ_PORT ?? '4173', 10);
  const accessToken = launch.lan ? randomBytes(24).toString('base64url') : undefined;
  const app = createServerApp({
    contentRoot,
    clientRoot: resolveClientRoot(contentRoot),
    sessions: new FileSessionStore(
      process.env.LQ_SESSION_STORE
        ?? path.join(contentRoot, 'recordings', 'runtime', 'sessions'),
    ),
    agentTranscripts: new FileAgentTranscriptStore(
      process.env.LQ_AGENT_TRANSCRIPT_STORE
        ?? path.join(contentRoot, 'recordings', 'runtime', 'agent-transcripts'),
    ),
    ...(accessToken ? { accessToken } : {}),
    lockDemo,
    testNavigation: process.env.LQ_TEST_NAV === '1',
  });
  const { server, port } = await serveOnHost({
    fetch: app.fetch,
    hostname: launch.hostname,
    preferredPort,
    attempts: 100,
  });
  if (port !== preferredPort) {
    console.log(`[startup] Port ${preferredPort} is occupied; selected ${port} instead.`);
  }

  const localUrl = accessToken
    ? `http://127.0.0.1:${port}/?access_token=${encodeURIComponent(accessToken)}`
    : `http://127.0.0.1:${port}`;
  console.log(`[startup] LuminousQuest is ready at ${localUrl}`);
  console.log(`[startup] External content: ${contentRoot}`);
  if (lockDemo) console.log('[startup] Demo mode is locked for this process.');
  if (accessToken) {
    const addresses = Object.values(networkInterfaces()).flatMap((entries) => entries ?? []);
    console.log(`[startup] LAN access token: ${accessToken}`);
    const urls = lanAccessUrls(port, accessToken, addresses);
    if (urls.length === 0) console.log('[startup] No private IPv4 LAN address was detected.');
    urls.forEach((url) => console.log(`[startup] LAN URL: ${url}`));
    console.log('[startup] LAN mode is HTTP-only; use only on a trusted private network.');
  }
  openBrowser(localUrl);
  server.on('error', (error) => {
    console.error(`[server] ${(error as Error).message}`);
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
  if (
    error instanceof ConfigValidationError ||
    error instanceof RecordingValidationError ||
    error instanceof PromptValidationError
  ) {
    console.error(`[startup] ${error.file} | ${error.field} | ${error.reason}`);
  } else {
    console.error(`[startup] ${(error as Error).message}`);
  }
  process.exitCode = 1;
});
