import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForRuntime(port: number, child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runtime`);
      if (response.ok) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the packaged server');
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

describe('M5 packaged server smoke', () => {
  it('starts the package-equivalent CJS bundle without loading the external Claude SDK', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'lq-package-smoke-'));
    const serverBundle = path.join(temporary, 'server.cjs');
    await build({
      entryPoints: [path.join(projectRoot, 'server', 'index.ts')],
      outfile: serverBundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      minify: true,
      sourcemap: false,
      logLevel: 'info',
      external: ['@anthropic-ai/claude-agent-sdk'],
    });

    const port = await availablePort();
    const child = spawn(process.execPath, [serverBundle], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CI: 'true',
        LQ_CONTENT_DIR: projectRoot,
        LQ_LLM_PROVIDER: 'mock',
        LQ_LLM_MODEL: 'mock-v1',
        LQ_NO_OPEN: '1',
        LQ_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    try {
      const runtime = await waitForRuntime(port, child);
      await expect(runtime.json()).resolves.toEqual({ executionMode: 'development', testNavigation: false });

      const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
      const apiToken = configResponse.headers.get('x-lq-api-token');
      expect(apiToken).toBeTruthy();
      const unavailable = await fetch(`http://127.0.0.1:${port}/api/llm`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lq-api-token': apiToken!,
        },
        body: JSON.stringify({
          executionMode: 'development',
          capability: 'chat',
          provider: 'claude-agent',
          model: 'claude-sonnet-4-5',
          prompt: { id: 'chat-system' },
          schemaVersion: 'schema.v1',
          input: { answer: 'test' },
          images: [],
        }),
      });
      await expect(unavailable.json()).resolves.toMatchObject({
        source: 'fallback',
        failureReason: 'provider-error',
      });
      expect(stderr).toMatch(/claude-agent.*unavailable.*zhipu.*demo/isu);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        { cause: error },
      );
    } finally {
      await stopChild(child);
    }
  }, 30_000);
});
