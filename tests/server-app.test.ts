import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'test-api-token';
const apiHeaders = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

describe('Hono server responsibilities', () => {
  it('hot-loads external configuration on every API request', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client'), apiToken });

    const first = await app.request('/api/config');
    const firstConfig = (await first.json()) as { knowledgeModel: { version: string } };

    const configFile = path.join(root, 'config', 'knowledge-model.json');
    const changed = JSON.parse(await readFile(configFile, 'utf8')) as { version: string };
    changed.version = 'knowledge-model.v2';
    await writeFile(configFile, JSON.stringify(changed));

    const second = await app.request('/api/config');
    const secondConfig = (await second.json()) as {
      knowledgeModel: { version: string };
      configVersion: string;
    };
    expect(firstConfig.knowledgeModel.version).toBe('knowledge-model.v1');
    expect(secondConfig.knowledgeModel.version).toBe('knowledge-model.v2');
    expect(secondConfig.configVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('provides a no-key mock LLM flow through the proxy route', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client'), apiToken });

    const response = await app.request('/api/llm', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        executionMode: 'development',
        capability: 'chat',
        provider: 'mock',
        model: 'mock-v1',
        prompt: { id: 'test', version: 'prompt.v1', text: 'test prompt' },
        schemaVersion: 'schema.v1',
        configVersion: 'config.v1',
        input: { answer: 'test' },
        images: [],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: 'provider',
      degraded: false,
      response: { model: 'mock-v1' },
    });
  });

  it('injects the startup token into the frontend and enforces it on LLM requests', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const clientRoot = path.join(root, 'client');
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'index.html'), '<html><head></head><body>shell</body></html>');
    const app = createServerApp({ contentRoot: root, clientRoot, apiToken });

    const frontend = await app.request('/');
    const unauthorized = await app.request('/api/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(await frontend.text()).toContain(apiToken);
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'Unauthorized request' });
  });

  it('accepts only same-origin application/json requests within the body limit', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      maxRequestBodyBytes: 64,
    });

    const wrongType = await app.request('/api/llm', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-lq-api-token': apiToken },
      body: '{}',
    });
    const crossOrigin = await app.request('http://localhost/api/llm', {
      method: 'POST',
      headers: { ...apiHeaders, origin: 'https://attacker.example' },
      body: '{}',
    });
    const oversized = await app.request('/api/llm', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({ padding: 'x'.repeat(100) }),
    });

    expect(wrongType.status).toBe(415);
    expect(crossOrigin.status).toBe(403);
    expect(oversized.status).toBe(413);
  });

  it('forces the current server config digest and prompt content into LLM cache keys', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const seen: LLMRequest[] = [];
    const provider: LLMProvider = {
      id: 'capture',
      async chat(request) {
        seen.push(request);
        return { content: 'captured', model: request.model };
      },
      async vision() {
        throw new Error('not used');
      },
      async structured() {
        throw new Error('not used');
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
    });
    const request = (claimedConfigVersion: string) =>
      app.request('/api/llm', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({
          executionMode: 'development',
          capability: 'chat',
          provider: 'capture',
          model: 'capture-v1',
          prompt: { id: 'test', version: 'client-version', text: 'client prompt' },
          schemaVersion: 'schema.v1',
          configVersion: claimedConfigVersion,
          input: { answer: 'same' },
          images: [],
        }),
      });

    const first = await request('stale-client-value');
    const second = await request('another-client-value');
    const firstResult = (await first.json()) as { cacheKey: string };
    const secondResult = (await second.json()) as { cacheKey: string; source: string };

    expect(seen).toHaveLength(1);
    expect(seen[0].configVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(seen[0].configVersion).not.toBe('stale-client-value');
    expect(seen[0].prompt).toMatchObject({ id: 'test', text: 'Server-owned prompt v1' });
    expect(seen[0].prompt.version).not.toBe('client-version');
    expect(secondResult.source).toBe('development-cache');
    expect(secondResult.cacheKey).toBe(firstResult.cacheKey);
  });

  it('keeps external-data failure details in server logs for LLM requests', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client'), apiToken });
    await writeFile(path.join(root, 'config', 'knowledge-model.json'), '{}');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await app.request('/api/llm', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        executionMode: 'live',
        capability: 'chat',
        provider: 'mock',
        model: 'mock-v1',
        prompt: { id: 'test' },
        schemaVersion: 'schema.v1',
        input: {},
        images: [],
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'LLM request failed' });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('config/knowledge-model.json'));
    errorLog.mockRestore();
  });

  it('serves the built SPA and falls back to index.html for client routes', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const clientRoot = path.join(root, 'client');
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'index.html'), '<main>LuminousQuest test shell</main>');
    const app = createServerApp({ contentRoot: root, clientRoot, apiToken });

    const response = await app.request('/training/session-1');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('LuminousQuest test shell');
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('does not turn a missing static asset into an HTML success response', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const clientRoot = path.join(root, 'client');
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'index.html'), '<main>shell</main>');
    const app = createServerApp({ contentRoot: root, clientRoot, apiToken });

    const response = await app.request('/assets/missing.js');

    expect(response.status).toBe(404);
  });

  it('serves only files inside the external assets directory', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    await writeFile(path.join(root, 'assets', 'material.png'), 'asset bytes');
    await writeFile(path.join(root, 'secret.txt'), 'do not serve');
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client'), apiToken });

    const asset = await app.request('/assets/material.png');
    const traversal = await app.request('/assets/%2e%2e%2fsecret.txt');
    const doubleEncodedTraversal = await app.request('/assets/%252e%252e%252fsecret.txt');

    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('asset bytes');
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(traversal.status).toBe(404);
    expect(doubleEncodedTraversal.status).toBe(404);
  });
});
