import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultRuntime } from '../src/runtime/api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete globalThis.__LQ_API_TOKEN__;
});

describe('M2 browser runtime', () => {
  it('captures the API token exposed by the dev-compatible config response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configVersion: 'test' }), {
      headers: {
        'content-type': 'application/json',
        'x-lq-api-token': 'dev-token',
      },
    })));

    await defaultRuntime.loadConfig();

    expect(globalThis.__LQ_API_TOKEN__).toBe('dev-token');
  });

  it('aborts a slow extraction with explicit idempotent retry guidance', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })));

    const result = defaultRuntime.extractAssessment({
      sessionId: 'runtime-session',
      expectedSequence: 0,
      idempotencyKey: 'stable-submission',
      questionId: 'pretest-principle-process',
      targetNodeIds: ['P3', 'P4'],
      studentAnswer: '作答',
      submissionId: 'stable-submission',
    });
    const assertion = expect(result).rejects.toThrow('判分请求超时，请重试；重试不会重复记录本次作答。');
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it('sends only image data to the dedicated drawing route', async () => {
    globalThis.__LQ_API_TOKEN__ = 'runtime-token';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ feedback: '演示占位：反馈' }), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(defaultRuntime.reviewDrawing('image-bytes')).resolves.toBe('演示占位：反馈');
    expect(fetchMock).toHaveBeenCalledWith('/api/drawing/review', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ imageData: 'image-bytes' }),
    }));
  });

  it('uses protected training assessment and tutor routes', async () => {
    globalThis.__LQ_API_TOKEN__ = 'runtime-token';
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      status: 'recorded',
      session: null,
      turn: { action: 'probe', content: '先判断对象。' },
    }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await defaultRuntime.extractAssessment({
      sessionId: 'training-session',
      expectedSequence: 0,
      idempotencyKey: 'analysis-1',
      caseId: 'zinc-copper',
      questionId: 'zinc-copper:analysis',
      targetNodeIds: ['D1'],
      studentAnswer: 'Zn 失去电子。',
      submissionId: 'analysis-1',
    });
    await defaultRuntime.assessEquation({
      sessionId: 'training-session',
      expectedSequence: 0,
      idempotencyKey: 'equation-1',
      caseId: 'zinc-copper',
      equationSetId: 'zinc-negative',
      equation: 'Zn -> Zn^2+ + 2e^-',
      submissionId: 'equation-1',
    });
    await defaultRuntime.tutorTurn({
      sessionId: 'training-session',
      expectedSequence: 0,
      idempotencyKey: 'tutor-D1-0',
      nodeId: 'D1',
      studentAnswer: '不知道',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/assessment/extract',
      '/api/assessment/equation',
      '/api/tutor/turn',
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      body: expect.stringContaining('"caseId":"zinc-copper"'),
    }));
  });
});
