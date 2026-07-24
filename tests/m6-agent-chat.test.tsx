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

  it('waits for the explicit first-round button before calling the Agent', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const session = triggeredSession(config, trainingCase.id);
    const runAgentTurn = vi.fn(async () => ({
      status: 'completed' as const,
      turnId: 'manual-agent-turn',
      degraded: false,
      session,
    }));
    const user = userEvent.setup();

    renderChat({
      config,
      session,
      runtime: { runAgentTurn } as unknown as AppRuntime,
      caseId: trainingCase.id,
    });

    expect(runAgentTurn).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '开始 Agent 对话' }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      caseId: trainingCase.id,
      triggerEventId: 'agent-chat-trigger',
      idempotencyKey: `agent-turn:${trainingCase.id}:0:attempt-0`,
    }));
  });

  it('keeps every configured question visible when the Agent presents a case analysis', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const triggerSession = triggeredSession(config, trainingCase.id);
    const session = appendSessionEvent(triggerSession, {
      id: 'agent-chat-analysis-event',
      occurredAt: '2026-07-23T21:30:02.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'agent-chat-analysis-attempt',
      turnId: 'agent-chat-analysis-turn',
      triggerEventId: 'agent-chat-trigger',
      contextThroughSequence: triggerSession.events.at(-1)!.sequence,
      requestHash: `sha256:${'a'.repeat(64)}`,
      source: 'provider',
      model: 'mock-agent',
      orderedActions: [{
        callId: 'agent-chat-analysis-question',
        name: 'present_question',
        arguments: {
          questionId: `${trainingCase.id}:analysis`,
          responseContractId: 'agent-chat-analysis-contract',
        },
      }],
      terminalAction: {
        callId: 'agent-chat-analysis-question',
        name: 'present_question',
      },
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'agent-chat-test.v1',
      },
    });

    renderChat({
      config,
      session,
      runtime: { submitAgentAnswer: vi.fn() } as unknown as AppRuntime,
      caseId: trainingCase.id,
    });

    const firstScaffold = trainingCase.scaffold.find((entry) => entry.level === 1)!;
    if (firstScaffold.level !== 1) throw new Error('level-one scaffold missing');
    for (const field of firstScaffold.fields) {
      expect(screen.getByText(field.prompt)).toBeInTheDocument();
    }
    expect(screen.getByRole('textbox', { name: /逐项完成分析/ })).toBeInTheDocument();
  });

  it('renders Agent answers as a choice board instead of a sentence textarea', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const trainingCase = config.cases[0];
    const triggerSession = triggeredSession(config, trainingCase.id);
    const session = appendSessionEvent(triggerSession, {
      id: 'agent-chat-choice-event',
      occurredAt: '2026-07-23T21:30:02.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'agent-chat-choice-attempt',
      turnId: 'agent-chat-choice-turn',
      triggerEventId: 'agent-chat-trigger',
      contextThroughSequence: triggerSession.events.at(-1)!.sequence,
      requestHash: `sha256:${'b'.repeat(64)}`,
      source: 'provider',
      model: 'mock-agent',
      orderedActions: [{
        callId: 'agent-chat-choice-question',
        name: 'ask_student',
        arguments: {
          text: '电子经过哪一部分？',
          responseContractId: 'agent-chat-choice-contract',
          board: {
            kind: 'choice',
            options: [
              { id: 'wire', label: '外电路' },
              { id: 'solution', label: '电解质溶液' },
            ],
          },
        },
      }],
      terminalAction: {
        callId: 'agent-chat-choice-question',
        name: 'ask_student',
      },
      provenance: {
        adapter: 'openai-compatible',
        adapterVersion: 'agent-chat-test.v1',
      },
    });
    const submitAgentAnswer = vi.fn(async () => ({
      status: 'recorded' as const,
      session,
    }));
    const user = userEvent.setup();

    const rendered = renderChat({
      config,
      session,
      runtime: { submitAgentAnswer } as unknown as AppRuntime,
      caseId: trainingCase.id,
    });

    expect(screen.getByRole('radio', { name: '外电路' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '电解质溶液' })).toBeInTheDocument();
    expect(rendered.container.querySelector('textarea')).toBeNull();
    await user.click(screen.getByRole('radio', { name: '外电路' }));
    await user.click(screen.getByRole('button', { name: '提交给 Agent' }));
    await waitFor(() => expect(submitAgentAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'agent-chat-choice-turn',
        answer: { format: 'choice', optionId: 'wire' },
      }),
    ));
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

  it('shows a retry state without presenting the preset fallback as Agent dialogue', async () => {
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
        idempotencyKey: `agent-turn:${trainingCase.id}:0:attempt-0`,
      }),
    });
    expect(response.status).toBe(500);
    const pending = sessions.get('agent-chat-session')!;
    expect(pending.events.some((event) => event.kind === 'agent.input.pending')).toBe(true);

    const runAgentTurn = vi.fn(async () => ({
      status: 'completed' as const,
      turnId: 'retry-turn',
      degraded: false,
      session: pending,
    }));
    const user = userEvent.setup();

    renderChat({
      config,
      session: pending,
      runtime: { runAgentTurn } as unknown as AppRuntime,
      caseId: trainingCase.id,
    });

    expect(screen.getByText('Agent 上一轮尚未完成')).toBeInTheDocument();
    expect(screen.getByText(/持久化会话继续/)).toBeInTheDocument();
    expect(screen.queryByText(/最确定的一条判断/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: '继续本轮' }));
    await waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    expect(runAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      triggerEventId: 'agent-chat-trigger',
      idempotencyKey: `agent-turn:${trainingCase.id}:0:attempt-0`,
    }));
  });
});
