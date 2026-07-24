import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  AgentTurnAdapter,
  AgentTurnAdapterRequest,
} from '../server/agent/adapters/adapter';
import { AGENT_TEACHER_FALLBACK_SUMMARY } from '../server/agent/tool-handlers';
import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { InMemorySessionStore } from '../server/session/store';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'm6-agent-route-token';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

function triggeredSession(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  caseId: string,
) {
  return appendSessionEvent(createSession({
    id: 'agent-route-session',
    anonymousStudentId: 'anon-ROUTE001',
    now: '2026-07-23T20:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  }), {
    id: 'agent-route-trigger',
    occurredAt: '2026-07-23T20:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId,
    stageId: 'training',
    attemptId: 'agent-route-seed',
    questionId: `${caseId}:analysis`,
    answer: { format: 'text', value: '我先从电子转移方向开始分析。' },
  });
}

describe('M6 Phase 3 agent HTTP routes', () => {
  it('requires the command envelope on both routes', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
    });

    const turn = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'missing-envelope',
        caseId: 'zinc-copper',
        triggerEventId: 'trigger',
      }),
    });
    const answer = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'missing-envelope',
        turnId: 'turn',
        answer: { format: 'text', value: 'answer' },
      }),
    });

    expect(turn.status).toBe(400);
    expect(answer.status).toBe(400);
    await expect(turn.json()).resolves.toMatchObject({
      error: 'Invalid agent turn request',
    });
    await expect(answer.json()).resolves.toMatchObject({
      error: 'Invalid agent answer request',
    });
  });

  it('scores an answer through its response contract, then runs the next turn atomically', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')
      ?? config.cases[0];
    const equationSet = trainingCase.equationSets[0];
    const sessions = new InMemorySessionStore();
    sessions.set(triggeredSession(config, trainingCase.id));
    let adapterCall = 0;
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute(request: AgentTurnAdapterRequest) {
        adapterCall += 1;
        const context = JSON.parse(request.messages[0].content) as {
          questionBank: Array<{
            questionId: string;
            responseContractCandidateId?: string;
          }>;
        };
        if (adapterCall === 1) {
          const questionId = `${trainingCase.id}:${equationSet.id}`;
          const candidate = context.questionBank.find(
            (entry) => entry.questionId === questionId,
          )?.responseContractCandidateId;
          if (!candidate) throw new Error('missing equation response contract candidate');
          const action = {
            callId: 'route-question',
            name: 'present_question' as const,
            arguments: {
              questionId,
              responseContractId: candidate,
            },
          };
          const executed = await request.executeTool!(action);
          return {
            source: 'provider',
            model: request.model,
            orderedActions: [executed.action],
            terminalAction: {
              callId: executed.action.callId,
              name: 'present_question' as const,
            },
            usage: {},
          };
        }
        const terminal = await request.executeTool!({
          callId: 'route-end',
          name: 'end_session',
          arguments: { summary: AGENT_TEACHER_FALLBACK_SUMMARY },
        });
        return {
          source: 'provider',
          model: request.model,
          orderedActions: [terminal.action],
          terminalAction: {
            callId: terminal.action.callId,
            name: 'end_session' as const,
          },
          usage: {},
        };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      agentAdapters: new Map([['stub-agent', adapter]]),
      workflow: {
        executionMode: 'live',
        provider: 'stub-agent',
        model: 'stub-agent-model',
        now: () => Date.parse('2026-07-23T20:00:02.000Z') + adapterCall,
      },
    });

    const firstResponse = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'agent-route-session',
        caseId: trainingCase.id,
        triggerEventId: 'agent-route-trigger',
        expectedSequence: 1,
        idempotencyKey: 'agent-route-start',
      }),
    });
    const first = await firstResponse.json() as {
      status: string;
      turnId: string;
      session: StudentSession;
    };

    expect(firstResponse.status).toBe(200);
    expect(first.status).toBe('completed');
    expect(first.session.events.at(-1)).toMatchObject({
      kind: 'agent.turn.completed',
      turnId: first.turnId,
      orderedActions: [{
        name: 'present_question',
        arguments: { questionId: `${trainingCase.id}:${equationSet.id}` },
      }],
    });
    const expectedSequence = first.session.serverSequence!;
    const answerRequest = {
      sessionId: 'agent-route-session',
      turnId: first.turnId,
      answer: {
        format: 'text' as const,
        value: equationSet.accepted[0],
      },
      expectedSequence,
      idempotencyKey: 'agent-route-answer',
    };
    const answerResponse = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify(answerRequest),
    });
    const answer = await answerResponse.json() as {
      status: string;
      assessmentStatus: string;
      nextTurnId: string;
      session: StudentSession;
      failureCategory?: string;
    };

    expect(answerResponse.status).toBe(200);
    expect(answer).toMatchObject({
      status: 'recorded',
      assessmentStatus: 'equation-assessed',
    });
    expect(answer.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'answer.submitted',
        responseToAgentTurnId: first.turnId,
      }),
      expect.objectContaining({
        kind: 'assessment.completed',
      }),
      expect.objectContaining({
        kind: 'agent.turn.completed',
        turnId: answer.nextTurnId,
        terminalAction: expect.objectContaining({ name: 'end_session' }),
      }),
    ]));
    expect(answer.session.events.some((event) =>
      event.kind === 'agent.judgment.recorded'
      || event.kind === 'agent.divergence.changed')).toBe(false);
    const eventCount = sessions.get('agent-route-session')!.events.length;
    const replayResponse = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify(answerRequest),
    });
    const replay = await replayResponse.json() as {
      status: string;
      nextTurnId: string;
      session: StudentSession;
    };
    expect(replayResponse.status).toBe(200);
    expect(replay).toMatchObject({
      status: 'already-recorded',
      nextTurnId: answer.nextTurnId,
    });
    expect(sessions.get('agent-route-session')?.events).toHaveLength(eventCount);
    expect(replay.session.events.filter((event) =>
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId === first.turnId)).toHaveLength(1);
    expect(adapterCall).toBe(2);
  });

  it('preserves a retryable pending input without synthesizing fallback dialogue', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const sessions = new InMemorySessionStore();
    sessions.set(triggeredSession(config, trainingCase.id));
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { category: 'provider-error' });
    });
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      agentAdapters: new Map([[
        'offline-agent',
        { id: 'openai-compatible', execute } satisfies AgentTurnAdapter,
      ]]),
      workflow: {
        executionMode: 'live',
        provider: 'offline-agent',
        model: 'offline-model',
      },
    });

    const response = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'agent-route-session',
        caseId: trainingCase.id,
        triggerEventId: 'agent-route-trigger',
        expectedSequence: 1,
        idempotencyKey: 'agent-route-fallback',
      }),
    });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Agent turn failed' });
    const stored = sessions.get('agent-route-session')!;
    expect(stored.events.filter((event) => event.kind === 'agent.input.pending'))
      .toHaveLength(1);
    expect(stored.events.some((event) =>
      event.kind === 'agent.turn.completed' && event.source === 'fallback')).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
