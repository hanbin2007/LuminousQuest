import { z } from 'zod';

import type { LoadedConfig } from '../../shared/config/schemas';
import { appendSessionEvent } from '../../shared/session/session';
import type {
  AssessmentCompletedEvent,
  StudentSession,
  TutorCycleTerminalEvent,
  TutorTurnCompletedEvent,
} from '../../shared/session/schema';
import {
  answerLeakage,
  containsSycophanticConclusion,
  factValueLeakage,
  socraticActionJsonSchema,
  socraticActionSchema,
  type SocraticAction,
} from '../../shared/workflows/socratic';
import type { LoadedPrompt } from '../prompts/loader';
import { StructuredResponseValidationError } from '../llm/errors';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';

type TutorSource = 'provider' | 'development-cache' | 'demo-recording' | 'preset';

export interface SocraticTurnInput {
  service: LLMService;
  config: LoadedConfig;
  prompt: LoadedPrompt;
  session: StudentSession;
  nodeId: string;
  studentAnswer: string;
  now?: () => number;
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
  stepId?: string;
  referenceCaseId?: string;
}

type Assistance =
  | { kind: 'none'; rounds: 0 }
  | { kind: 'socratic'; rounds: number };

type ResultBase = {
  session: StudentSession;
  assistance: Assistance;
  source: TutorSource;
  degraded: boolean;
};

export type SocraticTurnResult =
  | (ResultBase & {
      status: 'none';
      reason: 'no-assessment' | 'not-miss' | 'not-tutorable';
    })
  | (ResultBase & {
      status: 'respond';
      turn: SocraticAction;
      completedRounds: number;
      finalRound: boolean;
      reason?: string;
    })
  | (ResultBase & {
      status: 'advance';
      content: string;
      completedRounds: number;
      reason: 'max-rounds' | 'deadline';
    });

function fallbackAction(round: number): SocraticAction['action'] {
  return (['probe', 'hint', 'check'] as const)[Math.min(round - 1, 2)];
}

function assistance(rounds: number): Assistance {
  return rounds === 0
    ? { kind: 'none', rounds: 0 }
    : { kind: 'socratic', rounds };
}

function latestAssessment(session: StudentSession, nodeId: string) {
  return [...session.events].reverse().find((event): event is AssessmentCompletedEvent =>
    event.kind === 'assessment.completed' && event.nodeId === nodeId);
}

function objectiveOutcome(event: AssessmentCompletedEvent) {
  if (event.objectiveOutcome) return event.objectiveOutcome;
  return event.ruleDecision.status === 'hit-with-help'
    ? 'hit'
    : ['hit', 'partial', 'miss'].includes(event.ruleDecision.status)
      ? event.ruleDecision.status as 'hit' | 'partial' | 'miss'
      : null;
}

function eventTime(session: StudentSession, milliseconds: number) {
  return new Date(Math.max(milliseconds, Date.parse(session.updatedAt))).toISOString();
}

function configuredTutor(input: SocraticTurnInput, assessment: AssessmentCompletedEvent) {
  const caseId = input.referenceCaseId ?? assessment.caseId;
  const trainingCase = input.config.cases.find((entry) => entry.id === caseId);
  if (!trainingCase) throw new Error(`Unknown case ${caseId}`);
  if (!trainingCase.tutoring.some((entry) => entry.nodeId === input.nodeId)) return null;
  const evidencePath = trainingCase.evidencePaths.find((entry) =>
    entry.nodeId === input.nodeId && entry.source === 'answer');
  if (!evidencePath) return null;
  const forbiddenValues = [...new Set(
    evidencePath.factRequirements.flatMap((requirement) => requirement.acceptedValues),
  )];
  if (forbiddenValues.length === 0) return null;
  const node = input.config.knowledgeModel.nodes.find((entry) => entry.id === input.nodeId);
  if (!node) throw new Error(`Unknown node ${input.nodeId}`);
  return {
    context: `${trainingCase.title}（${trainingCase.medium}）：${evidencePath.description}`,
    misconceptions: node.misconceptions.map((entry) => entry.statement),
    referenceAnswerPoints: evidencePath.referenceAnswerPoints,
    forbiddenValues,
  };
}

function cycleEvents(session: StudentSession, cycleId: string) {
  const turns: TutorTurnCompletedEvent[] = [];
  let started = false;
  let terminal: TutorCycleTerminalEvent | undefined;
  for (const event of session.events) {
    if (!('cycleId' in event) || event.cycleId !== cycleId) continue;
    if (event.kind === 'tutor.cycle.started') started = true;
    if (event.kind === 'tutor.turn.completed') turns.push(event);
    if (event.kind === 'tutor.cycle.terminal') terminal = event;
  }
  return { started, turns, terminal };
}

function identity(assessment: AssessmentCompletedEvent, cycleId: string) {
  return {
    caseId: assessment.caseId,
    stageId: assessment.stageId,
    attemptId: assessment.attemptId,
    sourceAnswerEventId: assessment.sourceAnswerEventId,
    sourceAssessmentEventId: assessment.id,
    nodeId: assessment.nodeId,
    cycleId,
  };
}

function appendTerminal(input: {
  session: StudentSession;
  assessment: AssessmentCompletedEvent;
  cycleId: string;
  nowMs: number;
  reason: 'max-rounds' | 'deadline';
  content: string;
  activeElapsedMs: number;
}) {
  return appendSessionEvent(input.session, {
    id: `${input.cycleId}-terminal`,
    occurredAt: eventTime(input.session, input.nowMs),
    kind: 'tutor.cycle.terminal',
    pipelineStage: 'tutor',
    ...identity(input.assessment, input.cycleId),
    reason: input.reason,
    content: input.content,
    activeElapsedMs: input.activeElapsedMs,
  });
}

function advanceResult(
  session: StudentSession,
  terminal: TutorCycleTerminalEvent,
  rounds: number,
): SocraticTurnResult {
  return {
    status: 'advance',
    content: terminal.content,
    completedRounds: rounds,
    assistance: assistance(rounds),
    source: 'preset',
    degraded: true,
    reason: terminal.reason,
    session,
  };
}

export async function runSocraticTurn(input: SocraticTurnInput): Promise<SocraticTurnResult> {
  const assessment = latestAssessment(input.session, input.nodeId);
  if (!assessment) {
    return {
      status: 'none',
      reason: 'no-assessment',
      assistance: { kind: 'none', rounds: 0 },
      source: 'preset',
      degraded: false,
      session: input.session,
    };
  }
  if (objectiveOutcome(assessment) !== 'miss') {
    return {
      status: 'none',
      reason: 'not-miss',
      assistance: { kind: 'none', rounds: 0 },
      source: 'preset',
      degraded: false,
      session: input.session,
    };
  }
  const sourceAnswer = input.session.events.find((event) =>
    event.kind === 'answer.submitted' && event.id === assessment.sourceAnswerEventId);
  const pretestQuestion = sourceAnswer?.kind === 'answer.submitted'
    ? input.config.pretest.questions.find((question) =>
        question.id === sourceAnswer.questionId && question.type === 'text')
    : undefined;
  const referenceCaseId = input.referenceCaseId
    ?? (pretestQuestion?.type === 'text' ? pretestQuestion.referenceEquations[0]?.caseId : undefined)
    ?? assessment.caseId;
  const configuredInput = { ...input, referenceCaseId };
  const tutor = configuredTutor(configuredInput, assessment);
  if (!tutor) {
    return {
      status: 'none',
      reason: 'not-tutorable',
      assistance: { kind: 'none', rounds: 0 },
      source: 'preset',
      degraded: false,
      session: input.session,
    };
  }

  const policy = input.config.scaffoldPolicy.socratic;
  const now = input.now ?? Date.now;
  const cycleId = `tutor-${assessment.id}`;
  let session = input.session;
  let state = cycleEvents(session, cycleId);
  if (state.terminal) return advanceResult(session, state.terminal, state.turns.length);

  const initialNow = now();
  if (!state.started) {
    session = appendSessionEvent(session, {
      id: `${cycleId}-started`,
      occurredAt: eventTime(session, initialNow),
      kind: 'tutor.cycle.started',
      pipelineStage: 'tutor',
      ...identity(assessment, cycleId),
    });
    state = cycleEvents(session, cycleId);
  }

  const activeElapsedMs = state.turns.reduce((sum, turn) => sum + turn.activeElapsedMs, 0);
  if (state.turns.length >= policy.maxRounds || activeElapsedMs >= policy.forceAdvanceAfterMs) {
    const reason = state.turns.length >= policy.maxRounds ? 'max-rounds' : 'deadline';
    session = appendTerminal({
      session,
      assessment,
      cycleId,
      nowMs: initialNow,
      reason,
      content: policy.fallback.closing,
      activeElapsedMs,
    });
    return advanceResult(session, cycleEvents(session, cycleId).terminal!, state.turns.length);
  }

  const nextRound = state.turns.length + 1;
  const remainingMs = policy.forceAdvanceAfterMs - activeElapsedMs;
  const timeoutMs = Math.max(
    1,
    Math.min(policy.timeoutMs, Math.floor(remainingMs / (policy.retryCount + 1))),
  );
  const callStartedAtMs = now();
  const result = await input.service.execute({
    executionMode: input.executionMode,
    capability: 'structured',
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    schemaVersion: 'socratic-action.v2',
    configVersion: input.config.configVersion,
    input: {
      caseId: referenceCaseId,
      nodeId: input.nodeId,
      studentAnswer: input.studentAnswer,
      conversation: state.turns.map((turn) => ({
        student: turn.studentAnswer,
        tutor: turn.turn,
      })),
      round: nextRound,
      maximumRounds: policy.maxRounds,
      context: tutor.context,
      misconceptions: tutor.misconceptions,
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
      const overlap = answerLeakage(
        action.content,
        tutor.referenceAnswerPoints,
        policy.answerOverlapThreshold,
        input.config.scaffoldPolicy.extraction.citation.commonTypos,
        policy.minimumSharedBigrams,
      );
      const facts = factValueLeakage({
        content: action.content,
        forbiddenValues: tutor.forbiddenValues,
        aliases: input.config.scaffoldPolicy.extraction.factValueAliases,
        commonTypos: input.config.scaffoldPolicy.extraction.citation.commonTypos,
      });
      if (overlap.leaked || facts.leaked) {
        throw new StructuredResponseValidationError(
          'Tutor content deterministically reveals a configured answer fact',
          { retryable: false, category: 'unsafe-content' },
        );
      }
      if (containsSycophanticConclusion(action.content)) {
        throw new StructuredResponseValidationError(
          'Tutor content contradicts the objective miss outcome',
          { retryable: false, category: 'sycophancy' },
        );
      }
      return action;
    },
  });
  const callEndedAtMs = now();
  const turnElapsedMs = Math.max(0, Math.round(callEndedAtMs - callStartedAtMs));
  const totalActiveElapsedMs = activeElapsedMs + turnElapsedMs;
  if (totalActiveElapsedMs >= policy.forceAdvanceAfterMs) {
    session = appendTerminal({
      session,
      assessment,
      cycleId,
      nowMs: callEndedAtMs,
      reason: 'deadline',
      content: policy.fallback.closing,
      activeElapsedMs: totalActiveElapsedMs,
    });
    return advanceResult(session, cycleEvents(session, cycleId).terminal!, state.turns.length);
  }

  let turn: SocraticAction;
  let source: TutorSource;
  let degraded: boolean;
  let reason: string | undefined;
  if (result.source === 'fallback' || result.requiresTeacherReview) {
    const action = fallbackAction(nextRound);
    turn = { action, content: policy.fallback[action] };
    source = 'preset';
    degraded = true;
    reason = result.failureReason ?? 'provider-error';
  } else {
    turn = socraticActionSchema.parse(result.response.structured);
    source = result.source;
    degraded = result.degraded;
  }

  session = appendSessionEvent(session, {
    id: `${cycleId}-turn-${nextRound}`,
    occurredAt: eventTime(session, callEndedAtMs),
    kind: 'tutor.turn.completed',
    pipelineStage: 'tutor',
    ...identity(assessment, cycleId),
    studentAnswer: input.studentAnswer,
    turn,
    source,
    degraded,
    activeElapsedMs: turnElapsedMs,
  });
  const completedRounds = nextRound;
  const finalRound = completedRounds >= policy.maxRounds;
  if (finalRound) {
    session = appendTerminal({
      session,
      assessment,
      cycleId,
      nowMs: callEndedAtMs,
      reason: 'max-rounds',
      content: policy.fallback.closing,
      activeElapsedMs: totalActiveElapsedMs,
    });
  }
  return {
    status: 'respond',
    turn,
    completedRounds,
    finalRound,
    assistance: { kind: 'socratic', rounds: completedRounds },
    source,
    degraded,
    ...(reason ? { reason } : {}),
    session,
  };
}
