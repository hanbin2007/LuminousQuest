import { z } from 'zod';

import type { LoadedConfig } from '../../shared/config/schemas';
import {
  answerLeakage,
  socraticActionJsonSchema,
  socraticActionSchema,
  type SocraticAction,
} from '../../shared/workflows/socratic';
import type { LoadedPrompt } from '../prompts/loader';
import { StructuredResponseValidationError } from '../llm/errors';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';

type TutorSource = 'provider' | 'development-cache' | 'demo-recording' | 'preset';

export interface SocraticConversationRound {
  student: string;
  tutor?: SocraticAction;
}

export interface SocraticTurnInput {
  service: LLMService;
  config: LoadedConfig;
  prompt: LoadedPrompt;
  caseId: string;
  nodeId: string;
  studentAnswer: string;
  conversation: readonly SocraticConversationRound[];
  completedRounds: number;
  cycleStartedAtMs: number;
  now?: () => number;
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
  stepId?: string;
}

export type SocraticTurnResult =
  | {
      status: 'respond';
      turn: SocraticAction;
      completedRounds: number;
      finalRound: boolean;
      assistance: { kind: 'socratic'; rounds: number };
      source: TutorSource;
      degraded: boolean;
      reason?: string;
    }
  | {
      status: 'advance';
      content: string;
      completedRounds: number;
      assistance: { kind: 'socratic'; rounds: number };
      source: 'preset';
      degraded: true;
      reason: 'max-rounds' | 'deadline';
    };

function configuredReferencePoints(config: LoadedConfig, caseId: string, nodeId: string) {
  const trainingCase = config.cases.find((entry) => entry.id === caseId);
  if (!trainingCase) throw new Error(`Unknown case ${caseId}`);
  const evidencePaths = trainingCase.evidencePaths.filter((entry) => entry.nodeId === nodeId);
  if (evidencePaths.length === 0) throw new Error(`Node ${nodeId} is not configured for case ${caseId}`);
  return [...new Set([
    ...evidencePaths.map((entry) => entry.description),
    ...trainingCase.scaffold.flatMap((level) => level.answerPoints),
  ])];
}

function fallbackAction(round: number): SocraticAction['action'] {
  return (['probe', 'hint', 'check'] as const)[Math.min(round - 1, 2)];
}

function advanceResult(
  input: SocraticTurnInput,
  reason: 'max-rounds' | 'deadline',
): SocraticTurnResult {
  const rounds = Math.min(input.completedRounds, input.config.scaffoldPolicy.socratic.maxRounds);
  return {
    status: 'advance',
    content: input.config.scaffoldPolicy.socratic.fallback.closing,
    completedRounds: rounds,
    assistance: { kind: 'socratic', rounds },
    source: 'preset',
    degraded: true,
    reason,
  };
}

export async function runSocraticTurn(input: SocraticTurnInput): Promise<SocraticTurnResult> {
  if (!Number.isInteger(input.completedRounds) || input.completedRounds < 0) {
    throw new Error('completedRounds must be a non-negative integer');
  }
  const policy = input.config.scaffoldPolicy.socratic;
  const now = input.now ?? Date.now;
  if (input.completedRounds >= policy.maxRounds) return advanceResult(input, 'max-rounds');
  const elapsed = Math.max(0, now() - input.cycleStartedAtMs);
  if (elapsed >= policy.forceAdvanceAfterMs) return advanceResult(input, 'deadline');

  const referenceAnswerPoints = configuredReferencePoints(input.config, input.caseId, input.nodeId);
  const nextRound = input.completedRounds + 1;
  const remainingMs = policy.forceAdvanceAfterMs - elapsed;
  const attemptCount = policy.retryCount + 1;
  const timeoutMs = Math.max(1, Math.min(policy.timeoutMs, Math.floor(remainingMs / attemptCount)));
  const result = await input.service.execute({
    executionMode: input.executionMode,
    capability: 'structured',
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    schemaVersion: 'socratic-action.v1',
    configVersion: input.config.configVersion,
    input: {
      caseId: input.caseId,
      nodeId: input.nodeId,
      studentAnswer: input.studentAnswer,
      conversation: input.conversation,
      round: nextRound,
      maximumRounds: policy.maxRounds,
      referenceAnswerPoints,
    },
    images: [],
    schema: structuredClone(socraticActionJsonSchema),
    ...(input.stepId ? { stepId: input.stepId } : {}),
  }, {
    retryCount: policy.retryCount,
    timeoutMs,
    validateStructured: (value) => {
      let action: SocraticAction;
      try {
        action = socraticActionSchema.parse(value);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new StructuredResponseValidationError(
            `Socratic action failed semantic validation: ${error.issues[0]?.message ?? 'invalid value'}`,
            { category: 'schema-invalid' },
          );
        }
        throw error;
      }
      const leakage = answerLeakage(
        action.content,
        referenceAnswerPoints,
        policy.answerOverlapThreshold,
        input.config.scaffoldPolicy.extraction.citation.commonTypos,
      );
      if (leakage.leaked) {
        throw new StructuredResponseValidationError(
          `Tutor content overlaps a configured answer point at ratio ${leakage.overlap.toFixed(3)}`,
          { retryable: false, category: 'unsafe-content' },
        );
      }
      return action;
    },
  });

  if (Math.max(0, now() - input.cycleStartedAtMs) >= policy.forceAdvanceAfterMs) {
    return advanceResult(input, 'deadline');
  }
  const assistance = { kind: 'socratic' as const, rounds: nextRound };
  if (result.source === 'fallback' || result.requiresTeacherReview) {
    const action = fallbackAction(nextRound);
    return {
      status: 'respond',
      turn: { action, content: policy.fallback[action] },
      completedRounds: nextRound,
      finalRound: nextRound >= policy.maxRounds,
      assistance,
      source: 'preset',
      degraded: true,
      reason: result.failureReason ?? 'provider-error',
    };
  }
  return {
    status: 'respond',
    turn: socraticActionSchema.parse(result.response.structured),
    completedRounds: nextRound,
    finalRound: nextRound >= policy.maxRounds,
    assistance,
    source: result.source,
    degraded: result.degraded,
  };
}
