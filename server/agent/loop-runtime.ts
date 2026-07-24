import type { LoadedConfig } from '../../shared/config/schemas';
import {
  AGENT_CONTRACT_REVISION,
  AGENT_CONTEXT_BUILDER_VERSION,
  AGENT_TOOLSET_DIGEST,
  terminalAgentActionNameSchema,
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
  AGENT_TEACHER_FALLBACK_BOARD,
  AGENT_TEACHER_FALLBACK_QUESTION,
  AgentToolHandler,
} from './tool-handlers';
import type {
  AgentTurnAdapter,
  AgentTurnAdapterResult,
} from './adapters/adapter';
import { ResponseContractRegistry } from './response-contracts';
import { AgentTurnTransaction } from './turn-transaction';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';

export class AgentLoopBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentLoopBudgetError';
  }
}

export const DEFAULT_AGENT_ESTIMATED_INPUT_TOKEN_BUDGET = 100_000;
export const DEFAULT_AGENT_TOTAL_TOKEN_BUDGET = 32_000;
const LEGACY_AGENT_MARKERS = {
  contractRevision: 'agent-contract.v1',
  toolsetDigest:
    'sha256:9ba48ee80a9684b10385dbe8e99c393c8113980b7244da9a264f8f2b65fd9078',
  contextBuilderVersion: 'agent-context-builder.v1',
} as const;
const V2_AGENT_MARKERS = {
  contractRevision: 'agent-contract.v2',
  toolsetDigest:
    'sha256:ea7e6baecb69ed89efd3a7d1ec410982c406ddab9202e76c8c6f5ae778bb0047',
  contextBuilderVersion: 'agent-context-builder.v2',
} as const;

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
  maximumProviderAttempts?: number;
  timeoutMs?: number;
  commitUnderstanding?: boolean;
  caseRunId?: string;
  sdkSessionId?: string;
  resumeSdkSession?: boolean;
  transcriptStore?: SessionStore;
  recoveredActions?: NormalizedAgentAction[];
  deterministicFallback?: (
    context: BuiltAgentTurnContext,
  ) => AgentLoopFallback | Promise<AgentLoopFallback>;
}

export interface AgentLoopTurnResult {
  session: StudentSession;
  adapterResult: AgentTurnAdapterResult;
  degraded: boolean;
  failureCategory?: string;
  providerAttempts: number;
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
    && (
      error.name === 'TimeoutError'
      || error.name === 'AbortError'
      || error.name === 'ProviderTimeoutError'
    )
  ) {
    return 'timeout';
  }
  return 'provider-error';
}

function providerHttpStatus(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  if ('httpStatus' in error && typeof error.httpStatus === 'number') {
    return error.httpStatus;
  }
  if ('status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return undefined;
}

function isRetryableProviderFailure(
  error: unknown,
  executionMode: LLMExecutionMode,
) {
  if (executionMode !== 'live') return false;
  if (
    error
    && typeof error === 'object'
    && 'retryable' in error
    && error.retryable === false
  ) {
    return false;
  }
  const category = failureCategory(error);
  if (new Set([
    'budget-exceeded',
    'configuration',
    'invalid-message-chain',
    'invalid-tool-definition',
    'invalid-tool-result',
    'replay-missing',
    'schema-definition',
  ]).has(category)) {
    return false;
  }
  const status = providerHttpStatus(error);
  if (status === undefined) return true;
  return status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500;
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
  const currentContract = (
    session.agentContractRevision !== AGENT_CONTRACT_REVISION
    || session.toolsetDigest !== AGENT_TOOLSET_DIGEST
    || session.contextBuilderVersion !== AGENT_CONTEXT_BUILDER_VERSION
  );
  const legacyContract = (
    session.agentContractRevision === LEGACY_AGENT_MARKERS.contractRevision
    && session.toolsetDigest === LEGACY_AGENT_MARKERS.toolsetDigest
    && session.contextBuilderVersion === LEGACY_AGENT_MARKERS.contextBuilderVersion
  );
  const v2Contract = (
    session.agentContractRevision === V2_AGENT_MARKERS.contractRevision
    && session.toolsetDigest === V2_AGENT_MARKERS.toolsetDigest
    && session.contextBuilderVersion === V2_AGENT_MARKERS.contextBuilderVersion
  );
  if (currentContract && !legacyContract && !v2Contract) {
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
    ...(input.caseRunId ? { caseRunId: input.caseRunId } : {}),
    ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
    ...(input.resumeSdkSession !== undefined
      ? { resume: input.resumeSdkSession }
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
  const createAttempt = () => {
    const transaction = new AgentTurnTransaction();
    return {
      transaction,
      handler: new AgentToolHandler({
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
        commitUnderstanding: input.commitUnderstanding,
        caseRunId: input.caseRunId,
        sdkSessionId: input.sdkSessionId,
      }),
    };
  };
  let providerAttempts = 0;

  if (input.recoveredActions?.length) {
    const { transaction, handler } = createAttempt();
    for (const action of input.recoveredActions) {
      const executed = await handler.execute(action);
      if (!executed.accepted) {
        throw new Error(
          `Recovered transcript tool call was rejected: ${
            executed.errorCategory ?? 'tool-rejected'
          }`,
        );
      }
    }
    const recoveredActions = transaction.recordedActions;
    const terminal = recoveredActions.at(-1);
    if (!terminal || !terminalAgentActionNameSchema.safeParse(terminal.name).success) {
      throw new Error('Recovered transcript lacks a terminal Agent action');
    }
    const adapterResult: AgentTurnAdapterResult = {
      source: 'provider',
      model: input.model,
      orderedActions: recoveredActions,
      terminalAction: {
        callId: terminal.callId,
        name: terminal.name as AgentTurnAdapterResult['terminalAction']['name'],
      },
      usage: {},
      ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
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
      source: 'provider',
      model: input.model,
      providerAttempts: 0,
      provenance,
      ...(input.caseRunId ? { caseRunId: input.caseRunId } : {}),
      ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
    });
    return {
      session: committed,
      adapterResult,
      degraded: false,
      providerAttempts: 0,
    };
  }

  try {
    const maximumEstimatedInputTokens = input.maximumEstimatedInputTokens
      ?? DEFAULT_AGENT_ESTIMATED_INPUT_TOKEN_BUDGET;
    if (estimatedInputTokens > maximumEstimatedInputTokens) {
      throw new AgentLoopBudgetError(
        `Agent context exceeds the ${maximumEstimatedInputTokens} token budget`,
      );
    }
    const configuredProviderAttempts = input.maximumProviderAttempts ?? 2;
    const maximumProviderAttempts = Number.isFinite(configuredProviderAttempts)
      ? Math.min(3, Math.max(1, Math.trunc(configuredProviderAttempts)))
      : 2;
    while (providerAttempts < maximumProviderAttempts) {
      providerAttempts += 1;
      const { transaction, handler } = createAttempt();
      try {
        const adapterResult = await input.service.executeAgentTurn(
          {
            ...built.adapterRequest,
            signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
            executeTool: (action) => handler.execute(action),
            ...(input.sdkSessionId && input.transcriptStore
              ? {
                  sdkSession: {
                    sessionId: input.sdkSessionId,
                    resume: input.resumeSdkSession ?? false,
                    store: input.transcriptStore,
                  },
                }
              : {}),
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
        if (
          adapterResult.compacted
          && input.caseRunId
          && input.sdkSessionId
        ) {
          transaction.stageWrite({
            id: `${input.turnId}-context-compacted`,
            occurredAt: input.occurredAt,
            kind: 'agent.context.compacted',
            pipelineStage: 'agent',
            ...identity,
            caseRunId: input.caseRunId,
            sdkSessionId: input.sdkSessionId,
            trigger: 'auto',
            preTokens: adapterResult.contextUsage?.totalTokens ?? 0,
          });
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
          ...(providerAttempts > 1 ? { providerAttempts } : {}),
          provenance,
          ...(input.caseRunId ? { caseRunId: input.caseRunId } : {}),
          ...(input.sdkSessionId ? { sdkSessionId: input.sdkSessionId } : {}),
          ...(adapterResult.compacted !== undefined
            ? { compacted: adapterResult.compacted }
            : {}),
        });
        return {
          session: committed,
          adapterResult,
          degraded: adapterResult.source === 'fallback',
          providerAttempts,
        };
      } catch (error) {
        input.responseContracts.discardTurn(session.id, input.turnId);
        if (
          providerAttempts >= maximumProviderAttempts
          || !isRetryableProviderFailure(error, input.executionMode)
        ) {
          throw error;
        }
      }
    }
    throw new Error('Agent provider attempt loop ended unexpectedly');
  } catch (error) {
    // Case-level Agent sessions never synthesize a replacement question. The
    // last committed card and client draft remain intact and the caller may
    // retry the same pending input idempotently.
    if (input.caseRunId || input.sdkSessionId) throw error;
    if (
      input.executionMode === 'demo'
      && failureCategory(error) === 'replay-missing'
    ) {
      throw error;
    }
    input.responseContracts.discardTurn(session.id, input.turnId);
    const { transaction, handler } = createAttempt();
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
          board: AGENT_TEACHER_FALLBACK_BOARD,
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
          board: AGENT_TEACHER_FALLBACK_BOARD,
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
      failureCategory: failureCategory(error),
      providerAttempts,
      provenance,
    });
    return {
      session: committed,
      adapterResult: fallbackResult,
      degraded: true,
      failureCategory: failureCategory(error),
      providerAttempts,
    };
  }
}
