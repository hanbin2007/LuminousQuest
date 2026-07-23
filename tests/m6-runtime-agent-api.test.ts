import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session';
import { defaultRuntime } from '../src/runtime/api';

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.__LQ_API_TOKEN__ = undefined;
});

describe('M6 Phase 3 client agent API', () => {
  it('hydrates a missing server session and retries the turn with the synchronized sequence', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases[0];
    const session = appendSessionEvent(createSession({
      id: 'runtime-agent-session',
      anonymousStudentId: 'anon-RUNTIME1',
      now: '2026-07-23T21:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    }), {
      id: 'runtime-agent-trigger',
      occurredAt: '2026-07-23T21:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'runtime-agent-seed',
      questionId: `${trainingCase.id}:analysis`,
      answer: { format: 'text', value: 'seed' },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Session not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'hydrated',
        replayed: false,
        sequence: session.events.length,
        session,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'completed',
        turnId: 'runtime-agent-turn',
        degraded: false,
        session,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await defaultRuntime.runAgentTurn!({
      session,
      sessionId: session.id,
      caseId: trainingCase.id,
      triggerEventId: 'runtime-agent-trigger',
      expectedSequence: 99,
      idempotencyKey: 'runtime-agent-command',
    });

    expect(result.turnId).toBe('runtime-agent-turn');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/agent/turn',
      '/api/session/sync',
      '/api/agent/turn',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      session: { id: session.id },
      expectedSequence: 0,
      idempotencyKey: 'hydrate:runtime-agent-command',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      sessionId: session.id,
      expectedSequence: session.events.length,
      idempotencyKey: 'runtime-agent-command',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('session');
  });

  it('uses the same 404 hydrate recovery for existing deterministic session commands', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases[0];
    const equation = trainingCase.equationSets[0];
    const session = createSession({
      id: 'runtime-equation-session',
      anonymousStudentId: 'anon-RUNTIME2',
      now: '2026-07-23T21:10:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: 'Session not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'hydrated',
        replayed: false,
        sequence: 0,
        session,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ session }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await defaultRuntime.assessEquation({
      session,
      sessionId: session.id,
      caseId: trainingCase.id,
      equationSetId: equation.id,
      equation: equation.accepted[0],
      submissionId: 'runtime-equation-submission',
      expectedSequence: 8,
      idempotencyKey: 'runtime-equation-command',
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/assessment/equation',
      '/api/session/sync',
      '/api/assessment/equation',
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      expectedSequence: 0,
      idempotencyKey: 'runtime-equation-command',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty('session');
  });
});
