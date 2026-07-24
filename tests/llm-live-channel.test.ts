import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import type { LLMProvider } from '../server/llm/types';
import type { AssessmentCompletedEvent, StudentSession } from '../shared/session/schema';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const originalEnvironment = { ...process.env };
const apiToken = 'llm-live-channel-token';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.restoreAllMocks();
});

function clearLLMEnvironment() {
  for (const name of [
    'LQ_LOCK_DEMO',
    'LQ_LLM_EXECUTION_MODE',
    'LQ_LLM_MODEL',
    'LQ_LLM_PROVIDER',
    'DEEPSEEK_API_KEY',
    'MODELVERSE_API_KEY',
    'TONGYI_API_KEY',
    'ZHIPU_API_KEY',
  ]) {
    delete process.env[name];
  }
}

function providerWithId(id: string): LLMProvider {
  return {
    id,
    async chat(request) { return { content: 'OK', model: request.model }; },
    async vision() { throw new Error('not used'); },
    async structured(request) {
      return {
        content: '{"ok":true}',
        structured: { ok: true },
        model: request.model,
      };
    },
  };
}

describe('live LLM channel wiring', () => {
  it('makes the server provider and model authoritative on the generic LLM route', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const live = providerWithId('live-provider');
    const chat = vi.spyOn(live, 'chat');
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[live.id, live]]),
      workflow: {
        executionMode: 'live',
        provider: live.id,
        model: 'live-v1',
      },
    });

    const response = await app.request('/api/llm', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        executionMode: 'demo',
        capability: 'chat',
        provider: 'mock',
        model: 'mock-v1',
        prompt: { id: 'test' },
        schemaVersion: 'test.v1',
        input: { answer: 'student answer' },
        images: [],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: 'provider',
      response: { model: 'live-v1' },
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'live',
      provider: 'live-provider',
      model: 'live-v1',
    }));
  });

  it('defaults an explicitly selected Claude Agent channel to live with its real model', async () => {
    clearLLMEnvironment();
    process.env.LQ_LLM_PROVIDER = 'claude-agent';
    const provider = providerWithId('claude-agent');
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
    });

    const runtime = await app.request('/api/runtime');
    const health = await app.request('/api/llm/health');

    expect(await runtime.json()).toMatchObject({ executionMode: 'live' });
    expect(await health.json()).toMatchObject({
      provider: 'claude-agent',
      model: 'claude-sonnet-5',
      status: 'ok',
    });
  });

  it('does not let an unrelated provider key override the default Claude Agent channel', async () => {
    clearLLMEnvironment();
    process.env.MODELVERSE_API_KEY = 'test-key';
    const provider = providerWithId('claude-agent');
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
    });

    const health = await app.request('/api/llm/health');

    expect(await health.json()).toMatchObject({
      provider: 'claude-agent',
      model: 'claude-sonnet-5',
      status: 'ok',
    });
  });

  it('does not silently enable mock when no live provider is configured', async () => {
    clearLLMEnvironment();
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map(),
    });

    const health = await app.request('/api/llm/health');
    const payload = await health.json() as { provider: string; status: string };

    expect(payload.provider).not.toBe('mock');
    expect(payload.status).toBe('down');
  });

  it('records the answer and needs-review assessments when a live provider fails', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const provider: LLMProvider = {
      id: 'offline-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() { throw new Error('provider process stopped'); },
    };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      workflow: {
        executionMode: 'live',
        provider: provider.id,
        model: 'offline-v1',
      },
    });

    const response = await app.request('/api/assessment/extract', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'live-failure-session',
        questionId: 'pretest-exam1-membrane',
        targetNodeIds: ['D3', 'P1'],
        studentAnswer: '不能，只允许 K+ 通过。',
        submissionId: 'live-failure-1',
      }),
    });
    const payload = await response.json() as {
      status: string;
      source: string;
      recordingStatus: string;
      session: StudentSession;
    };
    const assessments = payload.session.events.filter(
      (event): event is AssessmentCompletedEvent => event.kind === 'assessment.completed',
    );

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      status: 'direct-assessed',
      source: 'fallback',
      recordingStatus: 'recorded',
    });
    expect(payload.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'answer.submitted' }),
    ]));
    expect(assessments).toHaveLength(2);
    expect(assessments.every((event) =>
      event.extraction.status === 'needs-review'
      && event.ruleDecision.status === 'unassessed'
      && event.score.status === 'unassessed')).toBe(true);
    expect(errorLog).toHaveBeenCalled();
  });
});
