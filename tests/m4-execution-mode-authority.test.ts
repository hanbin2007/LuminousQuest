import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import type { LLMProvider, LLMRequest } from '../server/llm/types';

const apiToken = 'm4-execution-mode-authority';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

function providerSpy() {
  const response = (request: LLMRequest) => ({
    content: request.capability === 'structured' ? '{}' : 'network response',
    ...(request.capability === 'structured' ? { structured: {} } : {}),
    model: request.model,
  });
  const chat = vi.fn(async (request: LLMRequest) => response(request));
  const vision = vi.fn(async (request: LLMRequest) => response(request));
  const structured = vi.fn(async (request: LLMRequest) => response(request));
  const provider: LLMProvider = { id: 'provider-spy', chat, vision, structured };
  return { provider, chat, vision, structured };
}

async function post(app: ReturnType<typeof createServerApp>, route: string, body: unknown) {
  return app.request(route, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('M4.1 server execution-mode authority', () => {
  it('overrides live client claims in global demo mode across every LLM entry point', async () => {
    const spy = providerSpy();
    const config = await loadAllConfig(process.cwd());
    const png = await readFile(path.join(
      process.cwd(),
      'tests',
      'fixtures',
      'red-team',
      'hand-drawing-prompt-injection.png',
    ));
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[spy.provider.id, spy.provider]]),
      workflow: { executionMode: 'live', provider: spy.provider.id, model: 'provider-spy-v1' },
      apiToken,
    });

    const activation = await post(app, '/api/runtime/demo', {});
    expect(activation.status).toBe(200);
    const demo = await activation.json() as { session: { id: string } };

    for (const capability of ['chat', 'vision', 'structured'] as const) {
      const response = await post(app, '/api/llm', {
        executionMode: 'live',
        capability,
        provider: spy.provider.id,
        model: 'provider-spy-v1',
        prompt: { id: capability === 'chat' ? 'chat-system' : 'vision-extraction' },
        schemaVersion: `provider-spy-${capability}.v1`,
        input: { clientClaim: 'live' },
        images: capability === 'vision'
          ? [{ mediaType: 'image/png', data: png.toString('base64') }]
          : [],
        ...(capability === 'structured'
          ? { schema: { type: 'object', additionalProperties: true } }
          : {}),
        stepId: 'm0-health-check',
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { source: string }).source)
        .toMatch(/demo-recording|fallback/u);
    }

    const tutor = await post(app, '/api/tutor/turn', {
      sessionId: demo.session.id,
      nodeId: 'P4',
      studentAnswer: '我仍然认为电子经过盐桥。',
    });
    expect(tutor.status).toBe(200);

    const choice = config.pretest.questions.find((entry) => entry.type === 'choice');
    if (!choice || choice.type !== 'choice') throw new Error('choice fixture is missing');
    expect((await post(app, '/api/assessment/choice', {
      sessionId: demo.session.id,
      questionId: choice.id,
      optionId: choice.options[0].id,
      submissionId: 'provider-spy-choice',
    })).status).toBe(200);

    expect((await post(app, '/api/assessment/extract', {
      sessionId: demo.session.id,
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['P4'],
      studentAnswer: '电子从锌极经导线流向铜极。',
      submissionId: 'provider-spy-extract',
    })).status).toBe(200);

    const zinc = config.cases.find((entry) => entry.id === 'zinc-copper');
    const equation = zinc?.equationSets[0];
    if (!equation) throw new Error('equation fixture is missing');
    expect((await post(app, '/api/assessment/equation', {
      sessionId: demo.session.id,
      caseId: zinc.id,
      equationSetId: equation.id,
      equation: equation.accepted[0],
      submissionId: 'provider-spy-equation',
    })).status).toBe(200);

    expect((await post(app, '/api/drawing/review', {
      imageData: png.toString('base64'),
    })).status).toBe(200);

    expect(spy.chat).not.toHaveBeenCalled();
    expect(spy.vision).not.toHaveBeenCalled();
    expect(spy.structured).not.toHaveBeenCalled();
  });

  it('does not let a client force demo replay while the global mode is live', async () => {
    const spy = providerSpy();
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[spy.provider.id, spy.provider]]),
      workflow: { executionMode: 'live', provider: spy.provider.id, model: 'provider-spy-v1' },
      apiToken,
    });

    const response = await post(app, '/api/llm', {
      executionMode: 'demo',
      capability: 'chat',
      provider: spy.provider.id,
      model: 'provider-spy-v1',
      prompt: { id: 'chat-system' },
      schemaVersion: 'chat-response.v1',
      input: { clientClaim: 'demo' },
      images: [],
      stepId: 'm0-health-check',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: 'provider' });
    expect(spy.chat).toHaveBeenCalledTimes(1);
  });
});
