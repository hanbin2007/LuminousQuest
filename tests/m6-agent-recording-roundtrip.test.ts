import { describe, expect, it, vi } from 'vitest';

import type {
  AgentTurnAdapter,
  AgentTurnAdapterRequest,
} from '../server/agent/adapters/adapter';
import { AGENT_RECORDING_PROMPT } from '../server/agent/context-builder';
import { runAgentLoopTurn } from '../server/agent/loop-runtime';
import { ResponseContractRegistry } from '../server/agent/response-contracts';
import { submitAgentAnswer } from '../server/agent/shadow-assessment';
import { AGENT_TEACHER_FALLBACK_SUMMARY } from '../server/agent/tool-handlers';
import { loadAllConfig } from '../server/config/loader';
import { LLMService } from '../server/llm/service';
import { RecordingStore } from '../server/llm/recording-store';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';
import { createTemporaryDirectory } from './helpers/content-fixture';

function seedSession(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  caseId: string,
) {
  return appendSessionEvent(createSession({
    id: 'record-roundtrip-session',
    anonymousStudentId: 'anon-RECORD01',
    now: '2026-07-23T22:30:00.000Z',
    configVersions: sessionConfigVersions(config),
  }), {
    id: 'record-roundtrip-trigger',
    occurredAt: '2026-07-23T22:30:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId,
    stageId: 'training',
    attemptId: 'record-roundtrip-seed',
    questionId: `${caseId}:analysis`,
    answer: { format: 'text', value: 'seed' },
  });
}

describe('M6 Phase 3 agent recording roundtrip', () => {
  it('records a complete live exchange and replays every turn identically in demo mode', async () => {
    const root = await createTemporaryDirectory();
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases[0];
    const equation = trainingCase.equationSets[0];
    const initial = seedSession(config, trainingCase.id);
    const recordings = new RecordingStore(root);
    const service = new LLMService({
      providers: new Map(),
      recordings,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    let adapterCall = 0;
    const liveAdapter: AgentTurnAdapter = {
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
          const responseContractId = context.questionBank.find(
            (entry) => entry.questionId === questionId,
          )?.responseContractCandidateId;
          const executed = await request.executeTool!({
            callId: 'record-question',
            name: 'present_question',
            arguments: { questionId, responseContractId: responseContractId! },
          });
          return {
            source: 'provider',
            model: request.model,
            orderedActions: [executed.action],
            terminalAction: { callId: executed.action.callId, name: 'present_question' },
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          };
        }
        const executed = await request.executeTool!({
          callId: 'record-end',
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
    const liveRegistry = new ResponseContractRegistry();
    const common = {
      config,
      service,
      adapter: liveAdapter,
      responseContracts: liveRegistry,
      provider: 'roundtrip-stub',
      model: 'roundtrip-agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'record-roundtrip-attempt',
    } as const;
    const firstLive = await runAgentLoopTurn({
      ...common,
      session: initial,
      executionMode: 'live',
      turnId: 'record-roundtrip-turn-1',
      triggerEventId: 'record-roundtrip-trigger',
      occurredAt: '2026-07-23T22:30:02.000Z',
    });
    const submittedLive = await submitAgentAnswer({
      session: firstLive.session,
      config,
      responseContracts: liveRegistry,
      submission: {
        turnId: 'record-roundtrip-turn-1',
        answer: { format: 'text', value: equation.accepted[0] },
      },
      occurredAt: '2026-07-23T22:30:03.000Z',
      idFactory: (prefix) => `${prefix}-roundtrip`,
    });
    const answerLive = submittedLive.session.events.find((event) =>
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId === 'record-roundtrip-turn-1')!;
    const secondLive = await runAgentLoopTurn({
      ...common,
      session: submittedLive.session,
      executionMode: 'live',
      turnId: 'record-roundtrip-turn-2',
      triggerEventId: answerLive.id,
      occurredAt: '2026-07-23T22:30:04.000Z',
    });
    const liveTurns = secondLive.session.events.filter((event) =>
      event.kind === 'agent.turn.completed');
    const requestHashes = liveTurns.map((event) => event.requestHash);

    const published = await recordings.publishAgentDemoRecordings(requestHashes);
    expect(published.cacheKeys).toEqual(requestHashes);
    await recordings.validateDemoAssets({
      configVersion: config.configVersion,
      prompts: { [AGENT_RECORDING_PROMPT.id]: AGENT_RECORDING_PROMPT },
    });

    const offlineAdapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      execute: vi.fn(async () => {
        throw new Error('demo replay reached the adapter');
      }),
    };
    const demoRegistry = new ResponseContractRegistry();
    const demoCommon = {
      ...common,
      adapter: offlineAdapter,
      responseContracts: demoRegistry,
    };
    const firstDemo = await runAgentLoopTurn({
      ...demoCommon,
      session: initial,
      executionMode: 'demo',
      turnId: 'record-roundtrip-turn-1',
      triggerEventId: 'record-roundtrip-trigger',
      occurredAt: '2026-07-23T22:30:02.000Z',
    });
    const submittedDemo = await submitAgentAnswer({
      session: firstDemo.session,
      config,
      responseContracts: demoRegistry,
      submission: {
        turnId: 'record-roundtrip-turn-1',
        answer: { format: 'text', value: equation.accepted[0] },
      },
      occurredAt: '2026-07-23T22:30:03.000Z',
      idFactory: (prefix) => `${prefix}-roundtrip`,
    });
    const answerDemo = submittedDemo.session.events.find((event) =>
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId === 'record-roundtrip-turn-1')!;
    const secondDemo = await runAgentLoopTurn({
      ...demoCommon,
      session: submittedDemo.session,
      executionMode: 'demo',
      turnId: 'record-roundtrip-turn-2',
      triggerEventId: answerDemo.id,
      occurredAt: '2026-07-23T22:30:04.000Z',
    });
    const demoTurns = secondDemo.session.events.filter((event) =>
      event.kind === 'agent.turn.completed');

    expect(demoTurns.map((turn) => turn.requestHash)).toEqual(requestHashes);
    expect(demoTurns.map((turn) => turn.orderedActions))
      .toEqual(liveTurns.map((turn) => turn.orderedActions));
    expect(demoTurns.every((turn) => turn.source === 'demo-recording')).toBe(true);
    expect(offlineAdapter.execute).not.toHaveBeenCalled();
  });
});
