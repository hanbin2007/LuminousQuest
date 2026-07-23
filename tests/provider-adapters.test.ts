import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeepSeekProvider } from '../server/llm/providers/deepseek';
import { createModelverseProvider } from '../server/llm/providers/modelverse';
import { createTongyiProvider } from '../server/llm/providers/tongyi';
import { createZhipuProvider } from '../server/llm/providers/zhipu';
import type { LLMRequest } from '../server/llm/types';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    executionMode: 'live',
    capability: 'chat',
    provider: 'adapter',
    model: 'model-v1',
    prompt: { id: 'test', version: 'prompt.v1', text: 'System instructions' },
    schemaVersion: 'schema.v1',
    configVersion: 'config.v1',
    input: { answer: 'student answer' },
    images: [],
    ...overrides,
  };
}

const adapters = [
  {
    id: 'deepseek',
    env: 'DEEPSEEK_BASE_URL',
    create: () => createDeepSeekProvider('secret-key'),
    supportsVision: false,
  },
  {
    id: 'modelverse',
    env: 'MODELVERSE_BASE_URL',
    create: () => createModelverseProvider('secret-key'),
    supportsVision: false,
  },
  {
    id: 'tongyi',
    env: 'TONGYI_BASE_URL',
    create: () => createTongyiProvider('secret-key'),
    supportsVision: true,
  },
  {
    id: 'zhipu',
    env: 'ZHIPU_BASE_URL',
    create: () => createZhipuProvider('secret-key'),
    supportsVision: true,
  },
] as const;

describe.each(adapters)('$id adapter', ({ id, env, create, supportsVision }) => {
  function configureBaseUrl() {
    process.env[env] = `https://${id}.test/v1`;
  }

  it('sends chat requests through the OpenAI-compatible endpoint', async () => {
    configureBaseUrl();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'chat response' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await create().chat(request());

    expect(response).toMatchObject({
      content: 'chat response',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://${id}.test/v1/chat/completions`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'model-v1' });
  });

  it('handles vision according to the adapter capability gate', async () => {
    configureBaseUrl();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'vision response' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const visionRequest = request({
      capability: 'vision',
      images: [{ mediaType: 'image/png', data: Buffer.from('pixels').toString('base64') }],
    });

    if (supportsVision) {
      await expect(create().vision(visionRequest)).resolves.toMatchObject({ content: 'vision response' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } else {
      await expect(create().vision(visionRequest)).rejects.toThrow(/vision/i);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('vision'));
    }
  });

  it('requests structured JSON and gates image-bearing structured calls', async () => {
    configureBaseUrl();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"score":1}' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const schema = { type: 'object', properties: { score: { type: 'number' } } };

    await expect(create().structured(request({ capability: 'structured', schema }))).resolves.toMatchObject({
      content: '{"score":1}',
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.response_format).toEqual({ type: 'json_object' });

    if (!supportsVision) {
      await expect(
        create().structured(
          request({
            capability: 'structured',
            schema,
            images: [{ mediaType: 'image/png', data: 'pixels' }],
          }),
        ),
      ).rejects.toThrow(/vision/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('aborts requests at the configured timeout', async () => {
    configureBaseUrl();
    process.env.LLM_TIMEOUT_MS = '5';
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(create().chat(request())).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
