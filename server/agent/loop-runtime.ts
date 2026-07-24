import type { LoadedConfig } from '../../shared/config/schemas';
import {
  AGENT_CONTRACT_REVISION,
  AGENT_CONTEXT_BUILDER_VERSION,
  AGENT_TOOLSET_DIGEST,
  type NormalizedAgentAction,
} from '../../shared/agent/contracts';
import {
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';
import type { LLMExecutionMode } from '../llm/types';
import type { LLMService } from '../llm/service';
import {
  buildAgentTurnContext,
  type BuiltAgentTurnContext,
} from './context-builder';
import { deterministicJson } from './deterministic-json';
import {
  AGENT_TEACHER_FALLBACK_QUESTION,
  AgentToolHandler,
} from './tool-handlers';
import type {
  AgentTurnAdapter,
  AgentTurnAdapterResult,
} from './adapters/adapter';
import { ResponseContractRegistry } from './response-contracts';
import { AgentTurnTransaction } from './turn-transaction';

export class AgentLoopBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopBudgetError';
  }
}

export const DEFAULT_AGENT_ESTIMATED_INPUT_TOKEN_BUDGET = 100_000;
export const DEFAULT_AGENT_TOTAL_TOKEN_BUDGET = 32_000;

export interface AgentLoopFallback {
  questionId?: string;
  text?: string;
}

export interface RunAgentLoopTurnInput {
  session: unknown;
  config: LoadedConfig;
  service: Pick<LLMService, 'executeAgentTurn'>;
  adapter: AgentTurnAdapter;
  responseContracts: ResponseContractRegistry;
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
  turnId: string;
  triggerEventId: string;
  caseId: string;
  stageId: string;
  attemptId: string;
  occurredAt: string;
  maxTurns?: number;
  logicalRoundWindow?: number;
  maximumEstimatedInputTokens?: number;
  maximumTotalTokens?: number;
  timeoutMs?: number;
  deterministicFallback?: (
    context: BuiltAgentTurnContext,
  ) => AgentLoopFallback | Promise<AgentLoopFallback>;
}

export interface AgentLoopTurnResult {
  session: StudentSession;
  adapterResult: AgentTurnAdapterResult;
  degraded: boolean;
  failureCategory?: string;
}

function adapterVersion(adapter: AgentTurnAdapter) {
  return 'version' in adapter && typeof adapter.version === 'string'
    ? adapter.version
    : 'agent-adapter.v1';
}

function failureCategory(error: unknown) {
  if (
    error
    && typeof error === 'object'
    && 'category' in error
    && typeof error.category === 'string'
  ) {
    return error.category;
  }
  if (error instanceof AgentLoopBudgetError) return 'budget-exceeded';
  if (
    error instanceof Error
    && (error.name === 'TimeoutError' || error.name === 'AbortError')
  ) {
    return 'timeout';
  }
  return 'provider-error';
}

function ensureTraceMatches(
  expected: readonly NormalizedAgentAction[],
  actual: readonly NormalizedAgentAction[],
) {
  if (deterministicJson(expected) !== deterministicJson(actual)) {
    throw new Error('Adapter trace does not match the serial tool execution trace');
  }
}

function estimatedTextTokens(value: string) {
  let asciiCharacters = 0;
  let nonAsciiCharacters = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1;
    else nonAsciiCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 4) + nonAsciiCharacters;
}

export async function runAgentLoopTurn(
  input: RunAgentLoopTurnInput,
): Promise<AgentLoopTurnResult> {
  const session = sessionSchema.parse(input.session);
  // schema 不再钉死契约标记(避免旧会话被删档);agent loop 是唯一依赖
  // 标记一致性的运行时(requestHash/回放),在入口显式校验。
  if (
    session.agentContractRevision !== AGENT_CONTRACT_REVISION
    || session.toolsetDigest !== AGENT_TOOLSET_DIGEST
    || session.contextBuilderVersion !== AGENT_CONTEXT_BUILDER_VERSION
  ) {
    throw new Error(
      `agent loop refused: session contract markers do not match this build `
      + `(session ${session.toolsetDigest}/${session.agentContractRevision}/`
      + `${session.contextBuilderVersion})`,
    );
  }
  const built = buildAgentTurnContext({
    session,
    config: input.config,
    triggerEventId: input.triggerEventId,
    turnId: input.turnId,
    currentCaseId: input.caseId,
    provider: input.provider,
    model: input.model,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
    ...(input.logicalRoundWindow
      ? { logicalRoundWindow: input.logicalRoundWindow }
      : {}),
  });
  const estimatedInputTokens = estimatedTextTokens(deterministicJson({
    systemPrompt: built.adapterRequest.systemPrompt,
    messages: built.adapterRequest.messages,
    tools: built.adapterRequest.tools,
  }));
  const provenance = {
    adapter: input.adapter.id,
    adapterVersion: adapterVersion(input.adapter),
  } as const;
  const identity = {
    caseId: input.caseId,
    stageId: input.stageId,
    attemptId: input.attemptId,
  };
  let transaction = new AgentTurnTransaction();
  let handler = new AgentToolHandler({
    session,
    config: input.config,
    transaction,
    responseContracts: input.responseContracts,
    builtContext: built,
    turnId: input.turnId,
    triggerEventId: input.triggerEventId,
    occurredAt: input.occurredAt,
    identity,
    provenance,
  });

  try {
    const maximumEstimatedInputTokens = input.maximumEstimatedInputTokens
      ?? DEFAULT_AGENT_ESTIMATED_INPUT_TOKEN_BUDGET;
    if (estimatedInputTokens > maximumEstimatedInputTokens) {
      throw new AgentLoopBudgetError(
        `Agent context exceeds the ${maximumEstimatedInputTokens} token budget`,
      );
    }
    const adapterResult = await input.service.executeAgentTurn(
      {
        ...built.adapterRequest,
        signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
        executeTool: (action) => handler.execute(action),
      },
      {
        executionMode: input.executionMode,
        provider: input.provider,
        configVersion: input.config.configVersion,
        adapter: input.adapter,
      },
    );

    if (transaction.state === 'open') {
      for (const action of adapterResult.orderedActions) {
        await handler.execute(action);
      }
    }
    ensureTraceMatches(adapterResult.orderedActions, transaction.recordedActions);
    const maximumTotalTokens = input.maximumTotalTokens
      ?? DEFAULT_AGENT_TOTAL_TOKEN_BUDGET;
    if ((adapterResult.usage.totalTokens ?? 0) > maximumTotalTokens) {
      throw new AgentLoopBudgetError(
        `Agent turn exceeds the ${maximumTotalTokens} token budget`,
      );
    }
    const committed = transaction.commit(session, {
      id: `${input.turnId}-completed`,
      occurredAt: input.occurredAt,
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      ...identity,
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      contextThroughSequence: built.context.contextThroughSequence,
      requestHash: built.requestHash,
      source: adapterResult.source,
      model: adapterResult.model,
      provenance,
    });
    return {
      session: committed,
      adapterResult,
      degraded: adapterResult.source === 'fallback',
    };
  } catch (error) {
    if (
      input.executionMode === 'demo'
      && failureCategory(error) === 'replay-missing'
    ) {
      throw error;
    }
    input.responseContracts.discardTurn(session.id, input.turnId);
    transaction = new AgentTurnTransaction();
    handler = new AgentToolHandler({
      session,
      config: input.config,
      transaction,
      responseContracts: input.responseContracts,
      builtContext: built,
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      occurredAt: input.occurredAt,
      identity,
      provenance,
    });
    const configuredFallback = await input.deterministicFallback?.(built);
    let action: NormalizedAgentAction;
    if (configuredFallback?.questionId) {
      const candidate = built.responseContractCandidates.find(
        (entry) =>
          entry.kind === 'question'
          && entry.questionId === configuredFallback.questionId,
      );
      action = {
        callId: 'fallback-terminal',
        name: 'present_question',
        arguments: {
          questionId: configuredFallback.questionId,
          responseContractId: candidate?.candidateId ?? 'fallback-auto',
        },
      };
    } else {
      const free = built.responseContractCandidates.find(
        (entry) => entry.kind === 'unassessed',
      );
      if (!free) throw new Error('Agent fallback lacks a response contract candidate');
      action = {
        callId: 'fallback-terminal',
        name: 'ask_student',
        arguments: {
          text: configuredFallback?.text ?? AGENT_TEACHER_FALLBACK_QUESTION,
          responseContractId: free.candidateId,
        },
      };
    }
    let executed = await handler.execute(action);
    if (!executed.accepted) {
      const free = built.responseContractCandidates.find(
        (entry) => entry.kind === 'unassessed',
      )!;
      executed = await handler.execute({
        callId: 'fallback-terminal',
        name: 'ask_student',
        arguments: {
          text: AGENT_TEACHER_FALLBACK_QUESTION,
          responseContractId: free.candidateId,
        },
      });
    }
    if (!executed.accepted) {
      throw new Error('Teacher-approved agent fallback was rejected');
    }
    const fallbackResult: AgentTurnAdapterResult = {
      source: 'fallback',
      model: 'preset-agent-fallback.v1',
      orderedActions: transaction.recordedActions,
      terminalAction: {
        callId: transaction.recordedActions.at(-1)!.callId,
        name: transaction.recordedActions.at(-1)!.name as
          | 'ask_student'
          | 'present_question'
          | 'end_session',
      },
      usage: {},
    };
    const committed = transaction.commit(session, {
      id: `${input.turnId}-completed`,
      occurredAt: input.occurredAt,
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      ...identity,
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      contextThroughSequence: built.context.contextThroughSequence,
      requestHash: built.requestHash,
      source: 'fallback',
      model: fallbackResult.model,
      provenance,
    });
    return {
      session: committed,
      adapterResult: fallbackResult,
      degraded: true,
      failureCategory: failureCategory(error),
    };
  }
}
