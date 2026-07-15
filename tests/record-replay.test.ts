import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createDevelopmentCacheKey } from '../server/llm/cache-key';
import { RecordingStore } from '../server/llm/recording-store';
import { ProviderHttpError } from '../server/llm/providers/openai-compatible';
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
      content: 'safe response containing token text',
      model: 'test-v1',
      structured: {
        token: 'response-token-must-survive',
        preview: { mediaType: 'image/png', data: 'response-image-bytes' },
      },
    });

    const persisted = await readFile(
      path.join(root, 'recordings', 'cache', `${cacheKey}.json`),
      'utf8',
    );
    expect(persisted).not.toContain('secret-value');
    expect(persisted).not.toContain('raw-image-bytes');
    expect(persisted).toContain('[REDACTED]');
    expect(persisted).toContain('[IMAGE SHA256:');
    expect(persisted).toContain('response-token-must-survive');
    expect(persisted).not.toContain('response-image-bytes');
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
        version: 'demo-script.v2',
        steps: [
          {
            id: 'pretest-q1',
            recording: 'demo/pretest-q1.json',
            resourceRefs: [],
            configVersion: 'config.v1',
            schemaVersion: 'schema.v1',
            prompt: { id: 'diagnose', version: 'prompt.v1' },
          },
        ],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'pretest-q1.json'),
      JSON.stringify({
        version: 'llm-recording.v2',
        recordedAt: '2026-07-15T00:00:00.000Z',
        metadata: {
          configVersion: 'config.v1',
          schemaVersion: 'schema.v1',
          prompt: { id: 'diagnose', version: 'prompt.v1' },
        },
        request: developmentRequest({ executionMode: 'demo', stepId: 'pretest-q1' }),
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
        version: 'demo-script.v2',
        steps: [
          {
            id: 'incomplete-step',
            recording: 'demo/incomplete-step.json',
            resourceRefs: ['assets/missing.png'],
            configVersion: 'config.v1',
            schemaVersion: 'schema.v1',
            prompt: { id: 'diagnose', version: 'prompt.v1' },
          },
        ],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'incomplete-step.json'),
      JSON.stringify({
        version: 'llm-recording.v2',
        recordedAt: '2026-07-15T00:00:00.000Z',
        metadata: {
          configVersion: 'config.v1',
          schemaVersion: 'schema.v1',
          prompt: { id: 'diagnose', version: 'prompt.v1' },
        },
        request: developmentRequest({ executionMode: 'demo', stepId: 'incomplete-step' }),
        response: { content: 'demo answer', model: 'recorded' },
      }),
    );

    await expect(new RecordingStore(root).validateDemoAssets()).rejects.toMatchObject({
      file: 'recordings/demo-script.json',
      field: 'steps.0.resourceRefs.0',
      reason: expect.stringContaining('assets/missing.png'),
    });
  });

  it('warns without blocking when demo versions are stale', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    await writeFile(
      path.join(root, 'recordings', 'demo-script.json'),
      JSON.stringify({
        version: 'demo-script.v2',
        steps: [
          {
            id: 'stale-step',
            recording: 'demo/stale-step.json',
            resourceRefs: [],
            configVersion: 'old-config',
            schemaVersion: 'schema.v2',
            prompt: { id: 'diagnose', version: 'prompt.v2' },
          },
        ],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'stale-step.json'),
      JSON.stringify({
        version: 'llm-recording.v2',
        recordedAt: '2026-07-15T00:00:00.000Z',
        metadata: {
          configVersion: 'old-config',
          schemaVersion: 'schema.v1',
          prompt: { id: 'diagnose', version: 'prompt.v1' },
        },
        request: developmentRequest({ executionMode: 'demo', stepId: 'stale-step' }),
        response: { content: 'demo answer', model: 'recorded' },
      }),
    );
    const warn = vi.fn();

    await expect(
      new RecordingStore(root).validateDemoAssets({
        configVersion: 'current-config',
        prompts: {
          diagnose: { id: 'diagnose', version: 'prompt.v2', text: 'current prompt' },
        },
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale-step'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('config'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('schema'));
  });

  it('validates every structured demo response against the manifest schema at startup', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    const schema = {
      type: 'object',
      required: ['score'],
      additionalProperties: false,
      properties: { score: { type: 'number' } },
    };
    await writeFile(
      path.join(root, 'recordings', 'demo-script.json'),
      JSON.stringify({
        version: 'demo-script.v2',
        steps: [
          {
            id: 'structured-step',
            recording: 'demo/structured-step.json',
            resourceRefs: [],
            configVersion: 'config.v1',
            schemaVersion: 'schema.v1',
            schema,
            prompt: { id: 'diagnose', version: 'prompt.v1' },
          },
        ],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'structured-step.json'),
      JSON.stringify({
        version: 'llm-recording.v2',
        recordedAt: '2026-07-15T00:00:00.000Z',
        metadata: {
          configVersion: 'config.v1',
          schemaVersion: 'schema.v1',
          prompt: { id: 'diagnose', version: 'prompt.v1' },
        },
        request: developmentRequest({
          executionMode: 'demo',
          stepId: 'structured-step',
          capability: 'structured',
          schema,
        }),
        response: {
          content: '{"score":"invalid"}',
          structured: { score: 'invalid' },
          model: 'recorded',
        },
      }),
    );

    await expect(
      new RecordingStore(root).validateDemoAssets({
        configVersion: 'config.v1',
        prompts: {
          diagnose: { id: 'diagnose', version: 'prompt.v1', text: 'prompt' },
        },
      }),
    ).rejects.toMatchObject({
      file: 'recordings/demo/structured-step.json',
      field: 'response.structured',
      reason: expect.stringContaining('schema'),
    });
  });

  it('never calls a real provider for a demo cache miss', async () => {
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

    expect(attempts).toBe(0);
    expect(result).toMatchObject({
      source: 'fallback',
      degraded: true,
    });
  });

  it('keeps the two provider attempts for a retryable development failure', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'test',
      async chat() {
        attempts += 1;
        throw new Error('temporary offline detail');
      },
      async vision() {
        throw new Error('not used');
      },
      async structured() {
        throw new Error('not used');
      },
    };
    const logger = { error: vi.fn(), warn: vi.fn() };
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger,
    });

    const result = await service.execute(developmentRequest());

    expect(attempts).toBe(2);
    expect(result.error).not.toContain('temporary offline detail');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('temporary offline detail'));
  });

  it('does not retry authorization failures but retries a schema failure once', async () => {
    const root = await createTemporaryDirectory();
    let authAttempts = 0;
    const unauthorized: LLMProvider = {
      id: 'test',
      async chat() {
        authAttempts += 1;
        throw new ProviderHttpError('test', 401, 'private upstream detail');
      },
      async vision() {
        throw new Error('not used');
      },
      async structured() {
        throw new Error('not used');
      },
    };
    const authService = new LLMService({
      providers: new Map([[unauthorized.id, unauthorized]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    await authService.execute(developmentRequest());

    let schemaAttempts = 0;
    const invalidStructured: LLMProvider = {
      ...unauthorized,
      async chat() {
        throw new Error('not used');
      },
      async structured() {
        schemaAttempts += 1;
        return { content: '{"score":"wrong"}', model: 'test-v1' };
      },
    };
    const schemaService = new LLMService({
      providers: new Map([[invalidStructured.id, invalidStructured]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const schemaResult = await schemaService.execute(
      developmentRequest({
        capability: 'structured',
        schema: {
          type: 'object',
          required: ['score'],
          properties: { score: { type: 'number' } },
        },
      }),
    );

    expect(authAttempts).toBe(1);
    expect(schemaAttempts).toBe(2);
    expect(schemaResult).toMatchObject({
      requiresTeacherReview: true,
      response: { structured: { status: 'needs-review' } },
    });
  });

  it('returns a provider response even when the development cache write fails', async () => {
    let calls = 0;
    const provider: LLMProvider = {
      id: 'test',
      async chat() {
        calls += 1;
        return { content: 'usable response', model: 'test-v1' };
      },
      async vision() {
        throw new Error('not used');
      },
      async structured() {
        throw new Error('not used');
      },
    };
    const recordings = {
      getDevelopment: async () => null,
      getDemo: async () => null,
      saveDevelopment: async () => {
        throw new Error('disk full detail');
      },
    } as unknown as RecordingStore;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const service = new LLMService({ providers: new Map([[provider.id, provider]]), recordings, logger });

    const result = await service.execute(developmentRequest());

    expect(calls).toBe(1);
    expect(result).toMatchObject({ source: 'provider', response: { content: 'usable response' } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk full detail'));
  });

  it('uses unique temporary files for concurrent writes to one cache key', async () => {
    const root = await createTemporaryDirectory();
    const store = new RecordingStore(root);
    const request = developmentRequest();
    const cacheKey = createDevelopmentCacheKey(request);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.saveDevelopment(cacheKey, request, { content: `response-${index}`, model: 'test-v1' }),
      ),
    );

    const files = await readdir(path.join(root, 'recordings', 'cache'));
    expect(files).toEqual([`${cacheKey}.json`]);
    await expect(store.getDevelopment(cacheKey)).resolves.toMatchObject({ content: expect.stringMatching(/^response-/) });
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
