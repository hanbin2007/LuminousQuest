import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDevelopmentCacheKey } from '../server/llm/cache-key';
import { RecordingStore } from '../server/llm/recording-store';
import { MockProvider } from '../server/llm/providers/mock';
import { LLMService } from '../server/llm/service';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import { createTemporaryDirectory } from './helpers/content-fixture';

function developmentRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    executionMode: 'development',
    capability: 'chat',
    provider: 'test',
    model: 'test-v1',
    prompt: { id: 'diagnose', version: 'prompt.v1', text: 'diagnose this answer' },
    schemaVersion: 'schema.v1',
    configVersion: 'config.v1',
    input: { answer: '电子由负极流向正极', context: { question: 1 } },
    images: [],
    ...overrides,
  };
}

describe('LLM recording and replay', () => {
  it('uses a stable development cache key for normalized input and image hashes', () => {
    const left = developmentRequest({
      input: { b: 2, a: 1 },
      images: [{ mediaType: 'image/png', data: 'same-image' }],
    });
    const right = developmentRequest({
      input: { a: 1, b: 2 },
      images: [{ mediaType: 'image/png', data: 'same-image' }],
    });

    expect(createDevelopmentCacheKey(left)).toBe(createDevelopmentCacheKey(right));
    expect(createDevelopmentCacheKey(left)).not.toContain('same-image');
  });

  it('hashes image bytes identically for raw base64 and data URLs', () => {
    const base64 = Buffer.from('same pixels').toString('base64');
    const raw = developmentRequest({
      images: [{ mediaType: 'image/png', data: base64 }],
    });
    const dataUrl = developmentRequest({
      images: [{ mediaType: 'image/png', data: `data:image/png;base64,${base64}` }],
    });

    expect(createDevelopmentCacheKey(raw)).toBe(createDevelopmentCacheKey(dataUrl));
  });

  it('records a development miss and replays it without a second provider call', async () => {
    const root = await createTemporaryDirectory();
    let calls = 0;
    const provider: LLMProvider = {
      id: 'test',
      async chat() {
        calls += 1;
        return { content: 'cached answer', model: 'test-v1' };
      },
      async vision() {
        throw new Error('not used');
      },
      async structured() {
        throw new Error('not used');
      },
    };
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
    });

    const first = await service.execute(developmentRequest());
    const second = await service.execute(developmentRequest());

    expect(first.source).toBe('provider');
    expect(second.source).toBe('development-cache');
    expect(second.response).toEqual(first.response);
    expect(calls).toBe(1);
  });

  it('runs the redaction hook before a recording reaches disk', async () => {
    const root = await createTemporaryDirectory();
    const store = new RecordingStore(root);
    const request = developmentRequest({
      input: { apiKey: 'secret-value', answer: 'visible answer' },
      images: [{ mediaType: 'image/png', data: 'raw-image-bytes' }],
    });
    const cacheKey = createDevelopmentCacheKey(request);

    await store.saveDevelopment(cacheKey, request, {
      content: 'safe response',
      model: 'test-v1',
    });

    const persisted = await readFile(
      path.join(root, 'recordings', 'cache', `${cacheKey}.json`),
      'utf8',
    );
    expect(persisted).not.toContain('secret-value');
    expect(persisted).not.toContain('raw-image-bytes');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).toContain('[IMAGE SHA256:');
  });

  it('preserves non-secret token usage metadata in redacted recordings', async () => {
    const root = await createTemporaryDirectory();
    const store = new RecordingStore(root);
    const request = developmentRequest();
    const cacheKey = createDevelopmentCacheKey(request);

    await store.saveDevelopment(cacheKey, request, {
      content: 'safe response',
      model: 'test-v1',
      usage: { inputTokens: 12, outputTokens: 4 },
    });

    await expect(store.getDevelopment(cacheKey)).resolves.toMatchObject({
      usage: { inputTokens: 12, outputTokens: 4 },
    });
  });

  it('replays demo responses by step id', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    await writeFile(
      path.join(root, 'recordings', 'demo-script.json'),
      JSON.stringify({
        version: 'demo-script.v1',
        steps: [{ id: 'pretest-q1', recording: 'demo/pretest-q1.json', resourceRefs: [] }],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'pretest-q1.json'),
      JSON.stringify({
        version: 'llm-recording.v1',
        recordedAt: '2026-07-15T00:00:00.000Z',
        request: { redacted: true },
        response: { content: 'demo answer', model: 'recorded' },
      }),
    );
    const service = new LLMService({
      providers: new Map(),
      recordings: new RecordingStore(root),
    });

    const result = await service.execute(
      developmentRequest({ executionMode: 'demo', stepId: 'pretest-q1' }),
    );

    expect(result).toMatchObject({
      source: 'demo-recording',
      response: { content: 'demo answer' },
    });
  });

  it('rejects a demo script whose referenced resources are incomplete', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    await writeFile(
      path.join(root, 'recordings', 'demo-script.json'),
      JSON.stringify({
        version: 'demo-script.v1',
        steps: [
          {
            id: 'incomplete-step',
            recording: 'demo/incomplete-step.json',
            resourceRefs: ['assets/missing.png'],
          },
        ],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'incomplete-step.json'),
      JSON.stringify({
        version: 'llm-recording.v1',
        recordedAt: '2026-07-15T00:00:00.000Z',
        request: { redacted: true },
        response: { content: 'demo answer', model: 'recorded' },
      }),
    );

    await expect(new RecordingStore(root).validateDemoAssets()).rejects.toMatchObject({
      file: 'recordings/demo-script.json',
      field: 'steps.0.resourceRefs.0',
      reason: expect.stringContaining('assets/missing.png'),
    });
  });

  it('retries once and uses a preset fallback when a cache miss cannot reach a provider', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'test',
      async chat() {
        attempts += 1;
        throw new Error('offline');
      },
      async vision() {
        throw new Error('offline');
      },
      async structured() {
        throw new Error('offline');
      },
    };
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
    });

    const result = await service.execute(
      developmentRequest({ executionMode: 'demo', stepId: 'not-recorded' }),
    );

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      source: 'fallback',
      degraded: true,
    });
  });

  it('keeps structured mock development on the provider path for constrained schemas', async () => {
    const root = await createTemporaryDirectory();
    const provider = new MockProvider();
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
    });

    const result = await service.execute(
      developmentRequest({
        capability: 'structured',
        provider: 'mock',
        schema: {
          type: 'object',
          required: ['status', 'score', 'evidence'],
          properties: {
            status: { enum: ['hit', 'miss'] },
            score: { type: 'integer', minimum: 1 },
            evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 2 } },
          },
        },
      }),
    );

    expect(result).toMatchObject({
      source: 'provider',
      degraded: false,
      requiresTeacherReview: false,
      response: {
        structured: { status: 'hit', score: 1, evidence: [expect.any(String)] },
      },
    });
  });
});
