import { vi } from 'vitest';

import type { LoadedConfig } from '../../shared/config/schemas';
import { appendSessionEvent, createSession, sessionConfigVersions } from '../../shared/session/session';
import type { StudentSession } from '../../shared/session/schema';
import type {
  AppRuntime,
  EquationAssessmentInput,
  ExtractAssessmentInput,
  TutorTurnResult,
} from '../../src/runtime/api';

type AssessmentOutcome = 'hit' | 'partial' | 'miss';

export function withImmediatePromotion(config: LoadedConfig) {
  const value = structuredClone(config);
  value.scaffoldPolicy.promotion.consecutiveHits = 1;
  return value;
}

export function withTransferFixture(config: LoadedConfig) {
  const value = withImmediatePromotion(config);
  const existing = value.cases.find((entry) => entry.caseType === 'transfer');
  if (existing) {
    existing.title = '陌生燃料电池';
    return value;
  }
  const source = value.cases.find((entry) => entry.id === 'hydrogen-oxygen');
  if (!source) throw new Error('hydrogen fixture is missing');
  const transfer = structuredClone(source);
  transfer.id = 'cold-transfer-fixture';
  transfer.sequence = 4;
  transfer.title = '陌生燃料电池';
  transfer.caseType = 'transfer';
  transfer.tutoring = [];
  value.cases.push(transfer);
  value.runtimeVersions.cases[transfer.id] = transfer.version;
  value.configVersion = 'sha256:transfer-fixture';
  return value;
}

function outcomeRule(config: LoadedConfig, nodeId: string, outcome: AssessmentOutcome) {
  const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId);
  const rule = rubric?.rules.find((entry) => entry.outcome === outcome);
  if (!rubric || !rule) throw new Error(`missing ${outcome} rubric for ${nodeId}`);
  return { rubric, rule };
}

export function createTrainingRuntime(
  config: LoadedConfig,
  options: {
    outcome?: AssessmentOutcome;
    tutorReason?: string;
  } = {},
) {
  let serverSession: StudentSession | null = null;
  let sequence = 0;
  const outcome = options.outcome ?? 'hit';

  const current = (sessionId: string) => {
    serverSession ??= createSession({
      id: sessionId,
      configVersions: sessionConfigVersions(config),
    });
    return serverSession;
  };

  const record = (
    sessionId: string,
    input: {
      caseId: string;
      stageId: string;
      attemptId: string;
      questionId: string;
      answer: string;
      nodeIds: readonly string[];
    },
  ) => {
    let session = current(sessionId);
    const suffix = ++sequence;
    const occurredAt = new Date(Date.now() + suffix).toISOString();
    const answerId = `mock-answer-${suffix}`;
    session = appendSessionEvent(session, {
      id: answerId,
      occurredAt,
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: input.caseId,
      stageId: input.stageId,
      attemptId: input.attemptId,
      questionId: input.questionId,
      answer: { format: 'text', value: input.answer },
    });
    [...new Set(input.nodeIds)].forEach((nodeId, index) => {
      const { rubric, rule } = outcomeRule(config, nodeId, outcome);
      session = appendSessionEvent(session, {
        id: `mock-assessment-${suffix}-${index}`,
        occurredAt,
        kind: 'assessment.completed',
        pipelineStage: 'score',
        caseId: input.caseId,
        stageId: input.stageId,
        attemptId: input.attemptId,
        sourceAnswerEventId: answerId,
        nodeId,
        rubric: { id: rubric.id, version: config.rubrics.version },
        assistance: { kind: 'none', rounds: 0 },
        objectiveOutcome: outcome,
        extraction: {
          status: 'assessed',
          evidence: [{ quote: input.answer, start: 0, end: input.answer.length }],
          model: 'training-mock',
          provenance: {
            promptId: 'training-mock',
            promptVersion: 'training-mock.v1',
            cacheKey: `${input.attemptId}:${nodeId}`,
          },
        },
        ruleDecision: {
          status: outcome,
          ruleId: rule.id,
          reason: `mock ${outcome}`,
          engine: { id: 'training-mock', version: 'training-mock.v1' },
        },
        following: {
          status: 'not-followed',
          anchorNodeId: null,
          anchorOutcome: null,
          policy: config.rubrics.policy.followingError.strategy,
        },
        score: {
          status: 'scored',
          earned: rule.score,
          possible: rubric.maxScore,
          annotations: [],
          outcome,
        },
      });
    });
    serverSession = session;
    return session;
  };

  const extractAssessment = vi.fn(async (input: ExtractAssessmentInput) => {
    const trainingCase = config.cases.find((entry) => entry.id === input.caseId);
    if (!trainingCase) throw new Error('unknown training case');
    return {
      session: record(input.sessionId, {
        caseId: trainingCase.id,
        stageId: trainingCase.caseType === 'transfer' ? 'transfer' : 'training',
        attemptId: input.submissionId,
        questionId: input.questionId,
        answer: input.studentAnswer,
        nodeIds: input.targetNodeIds,
      }),
    };
  });

  const assessEquation = vi.fn(async (input: EquationAssessmentInput) => {
    const trainingCase = config.cases.find((entry) => entry.id === input.caseId);
    const equationSet = trainingCase?.equationSets.find((entry) => entry.id === input.equationSetId);
    if (!trainingCase || !equationSet) throw new Error('unknown equation set');
    return {
      session: record(input.sessionId, {
        caseId: trainingCase.id,
        stageId: trainingCase.caseType === 'transfer' ? 'transfer' : 'training',
        attemptId: input.submissionId,
        questionId: `${trainingCase.id}:${equationSet.id}`,
        answer: input.equation,
        nodeIds: equationSet.electrode === 'overall' ? ['P3', 'P7'] : ['P3', 'P6'],
      }),
    };
  });

  const tutorTurn = vi.fn(async (): Promise<TutorTurnResult> => ({
    status: 'respond',
    turn: { action: 'probe', content: '先判断当前节点里的对象，再说明方向依据。' },
    completedRounds: 1,
    finalRound: false,
    assistance: { kind: 'socratic', rounds: 1 },
    source: 'preset',
    degraded: true,
    reason: options.tutorReason ?? 'provider-error',
    session: serverSession ?? current('training-session'),
  }));

  const runtime: AppRuntime = {
    loadConfig: vi.fn(async () => config),
    assessChoice: vi.fn(async () => ({ session: null })),
    extractAssessment,
    assessEquation,
    tutorTurn,
    reviewDrawing: vi.fn(async () => 'unused'),
  };

  return { runtime, extractAssessment, assessEquation, tutorTurn };
}
