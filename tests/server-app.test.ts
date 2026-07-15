import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../server/app';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

describe('Hono server responsibilities', () => {
  it('hot-loads external configuration on every API request', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client') });

    const first = await app.request('/api/config');
    const firstConfig = (await first.json()) as { knowledgeModel: { version: string } };

    const configFile = path.join(root, 'config', 'knowledge-model.json');
    const changed = JSON.parse(await readFile(configFile, 'utf8')) as { version: string };
    changed.version = 'knowledge-model.v2';
    await writeFile(configFile, JSON.stringify(changed));

    const second = await app.request('/api/config');
    const secondConfig = (await second.json()) as { knowledgeModel: { version: string } };
    expect(firstConfig.knowledgeModel.version).toBe('knowledge-model.v1');
    expect(secondConfig.knowledgeModel.version).toBe('knowledge-model.v2');
  });

  it('provides a no-key mock LLM flow through the proxy route', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({ contentRoot: root, clientRoot: path.join(root, 'client') });

    const response = await app.request('/api/llm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

  it('serves the built SPA and falls back to index.html for client routes', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const clientRoot = path.join(root, 'client');
    await mkdir(clientRoot, { recursive: true });
    await writeFile(path.join(clientRoot, 'index.html'), '<main>LuminousQuest test shell</main>');
    const app = createServerApp({ contentRoot: root, clientRoot });

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
    const app = createServerApp({ contentRoot: root, clientRoot });

    const response = await app.request('/assets/missing.js');

    expect(response.status).toBe(404);
  });
});
