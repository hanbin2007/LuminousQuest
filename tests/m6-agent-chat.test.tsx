// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import path from 'node:path';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { inflateStudentSessionProjection } from '../shared/session/projections';
import {
  AgentChat,
  agentTurnTriggerForCase,
} from '../src/features/training/AgentChat';
import type {
  AgentAnswerInput,
  AgentAnswerResult,
  AppRuntime,
} from '../src/runtime/api';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'm6-agent-chat-token';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

afterEach(cleanup);

function triggeredSession(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  caseId: string,
) {
  return appendSessionEvent(createSession({
    id: 'agent-chat-session',
    anonymousStudentId: 'anon-CHAT0001',
    now: '2026-07-23T21:30:00.000Z',
    configVersions: sessionConfigVersions(config),
  }), {
    id: 'agent-chat-trigger',
    occurredAt: '2026-07-23T21:30:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId,
    stageId: 'training',
    attemptId: 'agent-chat-seed',
    questionId: `${caseId}:analysis`,
    answer: { format: 'text', value: 'seed' },
  });
}

function renderChat(input: {
  config: Awaited<ReturnType<typeof loadAllConfig>>;
  session: StudentSession;
  runtime: AppRuntime;
  caseId: string;
}) {
  const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId)!;

  function Harness() {
    const [session, setSession] = useState(input.session);
    return (
      <AgentChat
        config={input.config}
        runtime={input.runtime}
        session={session}
        trainingCase={trainingCase}
        onSession={setSession}
      />
    );
  }

  return render(<Harness />);
}

describe('M6 Phase 3 student agent chat', () => {
  it('starts the first training case from the latest learner-visible event', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const session = triggeredSession(config, 'pretest');

    expect(agentTurnTriggerForCase(session, config.cases[0].id)?.id)
      .toBe('agent-chat-trigger');
  });

  it('submits an answer, records shadow scoring, renders the next turn, and retries idempotently', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const equation = trainingCase.equationSets[0];
    const sessions = new InMemorySessionStore();
    sessions.set(triggeredSession(config, trainingCase.id));
    let adapterCall = 0;
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute(request: AgentTurnAdapterRequest) {
        adapterCall += 1;
        if (adapterCall === 1) {
          const context = JSON.parse(request.messages[0].content) as {
            questionBank: Array<{
              questionId: string;
              responseContractCandidateId?: string;
            }>;
          };
          const questionId = `${trainingCase.id}:${equation.id}`;
          const candidate = context.questionBank.find(
            (entry) => entry.questionId === questionId,
          )?.responseContractCandidateId;
          const executed = await request.executeTool!({
            callId: 'chat-question',
            name: 'present_question',
            arguments: {
              questionId,
              responseContractId: candidate!,
            },
          });
          return {
            source: 'provider',
            model: request.model,
            orderedActions: [executed.action],
            terminalAction: { callId: executed.action.callId, name: 'present_question' },
            usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
          };
        }
        const executed = await request.executeTool!({
          callId: 'chat-summary',
          name: 'end_session',
          arguments: { summary: AGENT_TEACHER_FALLBACK_SUMMARY },
        });
        return {
          source: 'provider',
          model: request.model,
          orderedActions: [executed.action],
          terminalAction: { callId: executed.action.callId, name: 'end_session' },
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        };
      },
    };
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      agentAdapters: new Map([['mock', adapter]]),
      workflow: {
        executionMode: 'live',
        provider: 'mock',
        model: 'mock-agent',
        now: () => Date.parse('2026-07-23T21:31:00.000Z') + adapterCall,
      },
    });
    const turnResponse = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'agent-chat-session',
        caseId: trainingCase.id,
        triggerEventId: 'agent-chat-trigger',
        expectedSequence: 1,
        idempotencyKey: 'chat-turn-command',
      }),
    });
    const initial = await turnResponse.json() as { session: StudentSession };
    const submitAgentAnswer = vi.fn(async (input: AgentAnswerInput) => {
      const { session: _session, ...body } = input;
      const response = await app.request('/api/agent/answer', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const payload = await response.json() as AgentAnswerResult & { error?: string };
      if (response.status !== 200) {
        throw new Error(`${response.status}: ${payload.error ?? 'agent answer failed'}`);
      }
      return {
        ...payload,
        session: inflateStudentSessionProjection(payload.session),
      };
    });
    const runtime = {
      submitAgentAnswer,
    } as unknown as AppRuntime;
    const user = userEvent.setup();

    renderChat({
      config,
      session: inflateStudentSessionProjection(initial.session),
      runtime,
      caseId: trainingCase.id,
    });
    await user.type(
      screen.getByRole('textbox', { name: /负极半反应/ }),
      equation.accepted[0],
    );
    await user.click(screen.getByRole('button', { name: '提交给 Agent' }));

    await waitFor(() => expect(submitAgentAnswer).toHaveBeenCalledTimes(1));
    await expect(submitAgentAnswer.mock.results[0].value).resolves.toMatchObject({
      status: 'recorded',
    });
    expect(await screen.findByText(AGENT_TEACHER_FALLBACK_SUMMARY)).toBeInTheDocument();
    const recorded = sessions.get('agent-chat-session')!;
    expect(recorded.events.some((event) => event.kind === 'assessment.completed')).toBe(true);
    expect(recorded.events.filter((event) => event.kind === 'agent.turn.completed')).toHaveLength(2);

    const beforeRetry = recorded.events.length;
    const retry = await submitAgentAnswer(submitAgentAnswer.mock.calls[0][0]);
    expect(retry.status).toBe('already-recorded');
    expect(sessions.get('agent-chat-session')!.events).toHaveLength(beforeRetry);
  });

  it('shows the fallback state and leaves the deterministic workspace as the active path', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const sessions = new InMemorySessionStore();
    sessions.set(triggeredSession(config, trainingCase.id));
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
      agentAdapters: new Map([['mock', {
        id: 'openai-compatible',
        async execute() {
          throw Object.assign(new Error('provider unavailable'), {
            category: 'provider-unavailable',
          });
        },
      } satisfies AgentTurnAdapter]]),
      workflow: {
        executionMode: 'live',
        provider: 'mock',
        model: 'mock-agent',
        now: () => Date.parse('2026-07-23T21:35:00.000Z'),
      },
    });
    const response = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'agent-chat-session',
        caseId: trainingCase.id,
        triggerEventId: 'agent-chat-trigger',
        expectedSequence: 1,
        idempotencyKey: 'chat-fallback-turn',
      }),
    });
    const fallback = await response.json() as { session: StudentSession };

    renderChat({
      config,
      session: fallback.session,
      runtime: {} as AppRuntime,
      caseId: trainingCase.id,
    });

    expect(screen.getByText('Agent 通道已降级')).toBeInTheDocument();
    expect(screen.getByText(/继续使用下方现有确定性训练流程/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });
});
