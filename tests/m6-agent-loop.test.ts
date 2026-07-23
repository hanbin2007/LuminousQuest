import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  agentTurnAdapterResultSchema,
  type AgentTurnAdapter,
  type AgentTurnAdapterRequest,
} from '../server/agent/adapters/adapter';
import {
  AGENT_RECORDING_PROMPT,
  buildAgentTurnContext,
} from '../server/agent/context-builder';
import { buildDiagnosticProfile } from '../server/agent/diagnostic-profile';
import {
  guardFreeQuestion,
  guardQuestionBankText,
  guardStudentSummary,
} from '../server/agent/leakage-guard';
import { runAgentLoopTurn } from '../server/agent/loop-runtime';
import {
  buildAgentQuestionBankIndex,
  findAgentQuestion,
} from '../server/agent/question-bank';
import { ResponseContractRegistry } from '../server/agent/response-contracts';
import { submitAgentAnswer } from '../server/agent/shadow-assessment';
import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import {
  createSession,
  sessionConfigVersions,
} from '../shared/session';
import { recordChoiceAssessment } from '../shared/workflows/choice-assessment';
import { createTemporaryDirectory } from './helpers/content-fixture';

async function assessedPretest() {
  const config = await loadAllConfig(process.cwd());
  const question = config.pretest.questions.find(
    (entry) => entry.type === 'choice'
      && entry.options.some((option) =>
        !option.correct && option.misconceptionIds.length > 0),
  );
  if (!question || question.type !== 'choice') {
    throw new Error('Fixture requires a misconception-bearing choice question');
  }
  const option = question.options.find(
    (entry) => !entry.correct && entry.misconceptionIds.length > 0,
  )!;
  const base = createSession({
    id: 'agent-loop-session',
    anonymousStudentId: 'anon-AGENT001',
    now: '2026-07-23T18:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  let eventId = 0;
  const recorded = recordChoiceAssessment({
    session: base,
    config,
    question,
    optionId: option.id,
    occurredAt: '2026-07-23T18:00:01.000Z',
    attemptId: 'pretest-choice-attempt',
    idFactory: (prefix) => `${prefix}-fixture-${++eventId}`,
  });
  return { config, question, option, session: recorded.session };
}

describe('M6 Phase 2 agent context and guards', () => {
  it('builds a pretest-only DiagnosticProfile with misconception ids', async () => {
    const { config, question, option, session } = await assessedPretest();

    const profile = buildDiagnosticProfile(session, config);

    const target = profile.nodes.find(
      (node) => node.nodeId === question.targetNodeIds[0],
    );
    expect(target).toMatchObject({
      status: 'scored',
      outcome: 'miss',
      misconceptionIds: expect.arrayContaining(option.misconceptionIds),
    });
  });

  it('rebuilds identical context bytes and request hashes without occurredAt', async () => {
    const { config, session } = await assessedPretest();
    const trigger = session.events.at(-1)!;
    const input = {
      session,
      config,
      triggerEventId: trigger.id,
      turnId: 'deterministic-turn',
      currentCaseId: 'pretest',
      model: 'frozen-model',
    };

    const first = buildAgentTurnContext(input);
    const second = buildAgentTurnContext(input);

    expect(first.serializedContext).toBe(second.serializedContext);
    expect(first.requestHash).toBe(second.requestHash);
    expect(first.serializedContext).not.toContain('occurredAt');
    expect(first.context.currentTrigger).not.toHaveProperty('occurredAt');
    expect(first.context.knowledgeModel).toEqual(config.knowledgeModel);
    expect(first.context.rubrics).toEqual(config.rubrics);
  });

  it('enforces all three leakage-guard paths and disables question-only heuristics', async () => {
    const { config, question } = await assessedPretest();
    const indexed = buildAgentQuestionBankIndex({
      config,
      currentCaseId: 'pretest',
      agentTurnId: 'guard-turn',
    });
    const bankQuestion = findAgentQuestion(config, question.id)!;
    expect(guardQuestionBankText(bankQuestion, bankQuestion.prompt)).toEqual({
      safe: true,
      path: 'question-bank-verbatim',
    });
    expect(guardQuestionBankText(bankQuestion, `${bankQuestion.prompt} `))
      .toMatchObject({ safe: false, category: 'question-content-mismatch' });

    const candidate = indexed.responseContractCandidates.find(
      (entry) => entry.kind === 'unassessed',
    )!;
    expect(guardFreeQuestion({
      config,
      candidate,
      text: '请比较前者和后者，并尝试补全 A -> ?',
    })).toEqual({ safe: true, path: 'free-question' });

    const trainingCase = config.cases[0];
    const hiddenEquation = trainingCase.equationSets[0].accepted[0];
    expect(guardStudentSummary({
      config,
      caseId: trainingCase.id,
      summary: `结论是 ${hiddenEquation}`,
      recentAgentOutputs: [],
    })).toMatchObject({ safe: false, category: 'summary-answer-leak' });
  });
});

describe('M6 Phase 2 loop transaction and replay', () => {
  it('serially executes tools and atomically commits turn, judgment, and divergence', async () => {
    const { config, question, session } = await assessedPretest();
    const trigger = session.events.at(-1)!;
    const nodeId = question.targetNodeIds[0];
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute(request) {
        const context = JSON.parse(request.messages[0].content) as {
          freeResponseContractCandidateId: string;
        };
        const conclusion = await request.executeTool!({
          callId: 'judge-call',
          name: 'conclude_node',
          arguments: {
            nodeId,
            verdict: 'hit',
            rationale: 'The explanation now connects direction and electrode role.',
          },
        });
        const terminal = await request.executeTool!({
          callId: 'ask-call',
          name: 'ask_student',
          arguments: {
            text: '请解释你做出这个判断的思路。',
            responseContractId: context.freeResponseContractCandidateId,
          },
        });
        return {
          source: 'provider',
          model: request.model,
          orderedActions: [conclusion.action, terminal.action],
          terminalAction: {
            callId: terminal.action.callId,
            name: 'ask_student',
          },
          usage: { totalTokens: 40 },
        };
      },
    };
    const service = {
      executeAgentTurn: (
        request: AgentTurnAdapterRequest,
      ) => adapter.execute(request),
    } as Pick<LLMService, 'executeAgentTurn'>;
    const result = await runAgentLoopTurn({
      session,
      config,
      service,
      adapter,
      responseContracts: new ResponseContractRegistry({
        idFactory: () => 'unused-random-id',
      }),
      executionMode: 'live',
      provider: 'test-openai',
      model: 'frozen-model',
      turnId: 'runtime-turn',
      triggerEventId: trigger.id,
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'runtime-response-attempt',
      occurredAt: '2026-07-23T18:00:02.000Z',
    });

    expect(result.degraded).toBe(false);
    expect(result.session.events.slice(-3).map((event) => event.kind)).toEqual([
      'agent.turn.completed',
      'agent.judgment.recorded',
      'agent.divergence.changed',
    ]);
    expect(result.session.events.at(-1)).toMatchObject({
      kind: 'agent.divergence.changed',
      status: 'detected',
      agentVerdict: 'hit',
      shadowVerdict: 'miss',
    });
    const turn = result.session.events.at(-3);
    expect(turn).toMatchObject({
      kind: 'agent.turn.completed',
      orderedActions: [
        { name: 'conclude_node' },
        {
          name: 'ask_student',
          arguments: { responseContractId: expect.stringMatching(/^rc-/) },
        },
      ],
    });
  });

  it('records a student-visible deterministic fallback when the adapter fails', async () => {
    const { config, session } = await assessedPretest();
    const trigger = session.events.at(-1)!;
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute() {
        throw Object.assign(new Error('provider unavailable'), {
          category: 'provider-error',
        });
      },
    };
    const service = {
      executeAgentTurn: (
        request: AgentTurnAdapterRequest,
      ) => adapter.execute(request),
    } as Pick<LLMService, 'executeAgentTurn'>;
    const registry = new ResponseContractRegistry();

    const result = await runAgentLoopTurn({
      session,
      config,
      service,
      adapter,
      responseContracts: registry,
      executionMode: 'live',
      provider: 'offline',
      model: 'offline-model',
      turnId: 'fallback-turn',
      triggerEventId: trigger.id,
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'fallback-response-attempt',
      occurredAt: '2026-07-23T18:00:03.000Z',
    });

    expect(result).toMatchObject({
      degraded: true,
      failureCategory: 'provider-error',
      adapterResult: { source: 'fallback' },
    });
    expect(result.session.events.at(-1)).toMatchObject({
      kind: 'agent.turn.completed',
      source: 'fallback',
      terminalAction: { name: 'ask_student' },
      orderedActions: [{
        name: 'ask_student',
        arguments: { text: expect.stringContaining('固定训练流程') },
      }],
    });
    const assessmentsBefore = result.session.events.filter(
      (event) => event.kind === 'assessment.completed',
    ).length;
    const unassessed = await submitAgentAnswer({
      session: result.session,
      config,
      responseContracts: registry,
      submission: {
        turnId: 'fallback-turn',
        answer: { format: 'text', value: '我目前还不确定。' },
      },
      occurredAt: '2026-07-23T18:00:04.000Z',
      idFactory: (prefix) => `${prefix}-unassessed`,
    });
    expect(unassessed.status).toBe('unassessed');
    expect(unassessed.session.events.filter(
      (event) => event.kind === 'assessment.completed',
    )).toHaveLength(assessmentsBefore);
  });

  it('degrades before provider invocation when the context exceeds its budget', async () => {
    const { config, session } = await assessedPretest();
    const trigger = session.events.at(-1)!;
    const execute = vi.fn(async () => {
      throw new Error('the over-budget turn must not reach the adapter');
    });
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      execute,
    };
    const service = {
      executeAgentTurn: (
        request: AgentTurnAdapterRequest,
      ) => adapter.execute(request),
    } as Pick<LLMService, 'executeAgentTurn'>;

    const result = await runAgentLoopTurn({
      session,
      config,
      service,
      adapter,
      responseContracts: new ResponseContractRegistry(),
      executionMode: 'live',
      provider: 'budget-provider',
      model: 'budget-model',
      turnId: 'budget-turn',
      triggerEventId: trigger.id,
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'budget-response-attempt',
      occurredAt: '2026-07-23T18:00:04.000Z',
      maximumEstimatedInputTokens: 1,
    });

    expect(execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      degraded: true,
      failureCategory: 'budget-exceeded',
      adapterResult: { source: 'fallback' },
    });
  });

  it('routes a contracted student answer into the existing choice shadow pipeline', async () => {
    const { config, question, session } = await assessedPretest();
    const trigger = session.events.at(-1)!;
    const registry = new ResponseContractRegistry();
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute(request) {
        const context = JSON.parse(request.messages[0].content) as {
          questionBank: Array<{
            questionId: string;
            responseContractCandidateId?: string;
          }>;
        };
        const indexed = context.questionBank.find(
          (entry) => entry.questionId === question.id,
        )!;
        const terminal = await request.executeTool!({
          callId: 'present-choice',
          name: 'present_question',
          arguments: {
            questionId: question.id,
            responseContractId: indexed.responseContractCandidateId!,
          },
        });
        return {
          source: 'provider',
          model: request.model,
          orderedActions: [terminal.action],
          terminalAction: {
            callId: terminal.action.callId,
            name: 'present_question',
          },
          usage: {},
        };
      },
    };
    const service = {
      executeAgentTurn: (
        request: AgentTurnAdapterRequest,
      ) => adapter.execute(request),
    } as Pick<LLMService, 'executeAgentTurn'>;
    const turn = await runAgentLoopTurn({
      session,
      config,
      service,
      adapter,
      responseContracts: registry,
      executionMode: 'live',
      provider: 'choice-provider',
      model: 'choice-model',
      turnId: 'choice-agent-turn',
      triggerEventId: trigger.id,
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'choice-agent-response',
      occurredAt: '2026-07-23T18:00:04.000Z',
    });
    let id = 0;
    const submitted = await submitAgentAnswer({
      session: turn.session,
      config,
      responseContracts: registry,
      submission: {
        turnId: 'choice-agent-turn',
        answer: {
          format: 'text',
          value: question.options[0].id,
        },
      },
      occurredAt: '2026-07-23T18:00:05.000Z',
      idFactory: (prefix) => `${prefix}-shadow-${++id}`,
    });

    expect(submitted.status).toBe('choice-assessed');
    const linked = submitted.session.events.find((event) =>
      event.kind === 'answer.submitted'
      && event.responseToAgentTurnId === 'choice-agent-turn');
    expect(linked).toMatchObject({
      responseContractId: submitted.contract.responseContractId,
      attemptId: 'choice-agent-response',
    });
    expect(submitted.session.events.some((event) =>
      event.kind === 'assessment.completed'
      && event.sourceAnswerEventId === linked?.id)).toBe(true);
    expect(buildDiagnosticProfile(submitted.session, config))
      .toEqual(buildDiagnosticProfile(session, config));
  });

  it('records a provider turn once and replays it by requestHash cache key', async () => {
    const root = await createTemporaryDirectory();
    const recordings = new RecordingStore(root);
    const service = new LLMService({
      providers: new Map(),
      recordings,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const execute = vi.fn(async (request: AgentTurnAdapterRequest) => {
      const action = {
        callId: 'cached-end',
        name: 'end_session' as const,
        arguments: { summary: '完成。' },
      };
      await request.executeTool?.(action);
      return {
        source: 'provider' as const,
        model: request.model,
        orderedActions: [action],
        terminalAction: { callId: action.callId, name: action.name },
        usage: {},
      };
    });
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      execute,
    };
    const adapterRequest: AgentTurnAdapterRequest = {
      requestHash: `sha256:${'a'.repeat(64)}`,
      model: 'cache-model',
      systemPrompt: 'Call end_session.',
      messages: [{ role: 'user', content: '{}' }],
      tools: [{
        name: 'end_session',
        description: 'End.',
        inputSchema: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
      }],
      maxTurns: 4,
      executeTool: async (action) => ({
        accepted: true,
        action,
        content: '{"ok":true}',
      }),
    };
    const execution = {
      executionMode: 'development' as const,
      provider: 'cache-provider',
      configVersion: 'config.v1',
      adapter,
    };

    const first = await service.executeAgentTurn(adapterRequest, execution);
    const replay = await service.executeAgentTurn(adapterRequest, execution);

    expect(first.source).toBe('provider');
    expect(replay.source).toBe('development-cache');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('replays an agent turn in demo mode by requestHash without calling a provider', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    const requestHash = `sha256:${'b'.repeat(64)}` as const;
    const traceSchema = z.toJSONSchema(agentTurnAdapterResultSchema, {
      target: 'draft-7',
    });
    const recordedResult = {
      source: 'provider',
      model: 'demo-agent-model',
      orderedActions: [{
        callId: 'demo-end',
        name: 'end_session',
        arguments: { summary: '回放结束。' },
      }],
      terminalAction: { callId: 'demo-end', name: 'end_session' },
      usage: {},
    };
    await writeFile(
      path.join(root, 'recordings', 'demo-script.json'),
      JSON.stringify({
        version: 'demo-script.v2',
        steps: [{
          id: 'agent-request-hash',
          recording: 'demo/agent-request-hash.json',
          resourceRefs: [],
          configVersion: 'config.v1',
          schemaVersion: 'agent-turn-trace.v1',
          schema: traceSchema,
          prompt: {
            id: AGENT_RECORDING_PROMPT.id,
            version: AGENT_RECORDING_PROMPT.version,
          },
        }],
      }),
    );
    await writeFile(
      path.join(demoRoot, 'agent-request-hash.json'),
      JSON.stringify({
        version: 'llm-recording.v2',
        recordedAt: '2026-07-23T00:00:00.000Z',
        cacheKey: requestHash,
        metadata: {
          configVersion: 'config.v1',
          schemaVersion: 'agent-turn-trace.v1',
          prompt: {
            id: AGENT_RECORDING_PROMPT.id,
            version: AGENT_RECORDING_PROMPT.version,
          },
        },
        request: {},
        response: {
          content: JSON.stringify(recordedResult),
          structured: recordedResult,
          model: 'demo-agent-model',
        },
      }),
    );
    const recordingStore = new RecordingStore(root);
    await recordingStore.validateDemoAssets({
      configVersion: 'config.v1',
      prompts: {
        [AGENT_RECORDING_PROMPT.id]: AGENT_RECORDING_PROMPT,
      },
    });
    const service = new LLMService({
      providers: new Map(),
      recordings: recordingStore,
    });
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      execute: vi.fn(async () => {
        throw new Error('demo replay must not call the provider');
      }),
    };
    const executeTool = vi.fn(async (action) => ({
      accepted: true,
      action,
      content: '{"ok":true}',
    }));

    const replay = await service.executeAgentTurn({
      requestHash,
      model: 'demo-agent-model',
      systemPrompt: 'demo',
      messages: [{ role: 'user', content: '{}' }],
      tools: [],
      maxTurns: 4,
      executeTool,
    }, {
      executionMode: 'demo',
      provider: 'offline',
      configVersion: 'config.v1',
      adapter,
    });

    expect(replay).toMatchObject({
      source: 'demo-recording',
      terminalAction: { name: 'end_session' },
    });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
