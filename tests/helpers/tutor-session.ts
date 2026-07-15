import type { LoadedConfig } from '../../shared/config/schemas';
import { resolveRubricDecision } from '../../shared/scoring/rubric';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../../shared/session';

export function sessionWithAssessment(input: {
  config: LoadedConfig;
  nodeId?: string;
  outcome?: 'hit' | 'partial' | 'miss';
  sessionId?: string;
}) {
  const nodeId = input.nodeId ?? 'P4';
  const outcome = input.outcome ?? 'miss';
  const answer = '电子从Cu极流向Zn极。';
  let session = createSession({
    id: input.sessionId ?? `session-${nodeId.toLowerCase()}`,
    anonymousStudentId: 'anon-A1B2C3D4',
    now: '2026-07-15T12:00:00.000Z',
    configVersions: sessionConfigVersions(input.config),
  });
  session = appendSessionEvent(session, {
    id: `answer-${nodeId}`,
    occurredAt: '2026-07-15T12:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'analysis',
    attemptId: `attempt-${nodeId}`,
    questionId: `question-${nodeId}`,
    answer: { format: 'text', value: answer },
  });
  const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId)!;
  const decision = resolveRubricDecision({
    rubrics: input.config.rubrics,
    scaffoldPolicy: input.config.scaffoldPolicy,
    nodeId,
    objectiveOutcome: outcome,
    assistance: { kind: 'none', rounds: 0 },
  });
  return appendSessionEvent(session, {
    id: `assessment-${nodeId}`,
    occurredAt: '2026-07-15T12:00:02.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: 'zinc-copper',
    stageId: 'analysis',
    attemptId: `attempt-${nodeId}`,
    sourceAnswerEventId: `answer-${nodeId}`,
    nodeId,
    rubric: { id: rubric.id, version: input.config.rubrics.version },
    objectiveOutcome: outcome,
    extraction: {
      status: 'assessed',
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      model: 'fixture-v1',
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v1',
        cacheKey: `cache-${nodeId}`,
      },
    },
    ...decision,
  });
}
