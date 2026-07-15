import type { LoadedConfig } from '../config/schemas';
import {
  equationScoringEngineVersion,
  scoreEquation,
} from '../chemistry/equation';
import { buildLearnerProfile } from '../scoring/profile';
import {
  type AssistanceMetadata,
  resolveRubricDecision,
} from '../scoring/rubric';
import {
  assessBuilderTopology,
  topologyEngineVersion,
  type BuilderGraph,
} from '../scoring/topology';
import { appendSessionEvent } from '../session/session';
import type { StudentSession } from '../session/schema';

interface WorkflowAnswer<T> {
  id: string;
  occurredAt: string;
  caseId: string;
  stageId: string;
  attemptId: string;
  questionId: string;
  value: T;
}

interface BuilderAnswerValue {
  components: Array<BuilderGraph['components'][number] & { x: number; y: number }>;
  connections: BuilderGraph['connections'];
}

interface BaseEngineAssessmentInput<T> {
  session: StudentSession;
  config: LoadedConfig;
  answer: WorkflowAnswer<T>;
  assistance: AssistanceMetadata;
  assessmentEventIdPrefix: string;
  assessedAt: string;
}

function engineEvidence(value: unknown) {
  const quote = typeof value === 'string' ? value : JSON.stringify(value);
  return [{ quote, start: 0, end: quote.length }];
}

function appendEngineDecision(input: {
  session: StudentSession;
  config: LoadedConfig;
  answer: WorkflowAnswer<unknown>;
  assistance: AssistanceMetadata;
  eventId: string;
  assessedAt: string;
  nodeId: string;
  outcome: 'hit' | 'partial' | 'miss' | 'unanswered';
  engine: { id: string; version: string; ruleId: string; reason: string };
}) {
  const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === input.nodeId);
  if (!rubric) throw new Error(`No rubric configured for node ${input.nodeId}`);
  if (input.outcome === 'unanswered') {
    return appendSessionEvent(input.session, {
      id: input.eventId,
      occurredAt: input.assessedAt,
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      nodeId: input.nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      assistance: input.assistance,
      extraction: {
        status: 'assessed',
        evidence: engineEvidence(input.answer.value),
        model: input.engine.id,
        provenance: {
          promptId: input.engine.id,
          promptVersion: input.engine.version,
          cacheKey: `${input.answer.id}:${input.nodeId}`,
        },
      },
      ruleDecision: {
        status: 'unanswered',
        reason: input.engine.reason,
        promptRetry: input.config.rubrics.policy.nonResponse.promptRetry,
        includeInDiagnosis: input.config.rubrics.policy.nonResponse.includeInDiagnosis,
      },
      following: {
        status: 'not-followed',
        anchorNodeId: null,
        anchorOutcome: null,
        policy: input.config.rubrics.policy.followingError.strategy,
      },
      score: {
        status: 'unanswered',
        promptRetry: input.config.rubrics.policy.nonResponse.promptRetry,
        includeInDiagnosis: input.config.rubrics.policy.nonResponse.includeInDiagnosis,
      },
    });
  }
  const decision = resolveRubricDecision({
    rubrics: input.config.rubrics,
    scaffoldPolicy: input.config.scaffoldPolicy,
    nodeId: input.nodeId,
    objectiveOutcome: input.outcome,
    assistance: input.assistance,
    engine: input.engine,
  });
  return appendSessionEvent(input.session, {
    id: input.eventId,
    occurredAt: input.assessedAt,
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: input.answer.caseId,
    stageId: input.answer.stageId,
    attemptId: input.answer.attemptId,
    sourceAnswerEventId: input.answer.id,
    nodeId: input.nodeId,
    rubric: { id: rubric.id, version: input.config.rubrics.version },
    extraction: {
      status: 'assessed',
      evidence: engineEvidence(input.answer.value),
      model: input.engine.id,
      provenance: {
        promptId: input.engine.id,
        promptVersion: input.engine.version,
        cacheKey: `${input.answer.id}:${input.nodeId}`,
      },
    },
    ...decision,
  });
}

export function recordBuilderAssessment(input: BaseEngineAssessmentInput<BuilderAnswerValue>) {
  const normalizedValue: BuilderAnswerValue = {
    components: input.answer.value.components,
    connections: input.answer.value.connections.map((connection, index) => ({
      ...connection,
      id: connection.id || `connection-${index + 1}`,
    })),
  };
  const answer = { ...input.answer, value: normalizedValue };
  let session = appendSessionEvent(input.session, {
    id: answer.id,
    occurredAt: answer.occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: answer.caseId,
    stageId: answer.stageId,
    attemptId: answer.attemptId,
    questionId: answer.questionId,
    answer: { format: 'builder', value: normalizedValue },
  });
  const graph: BuilderGraph = {
    components: normalizedValue.components.map(({ x: _x, y: _y, ...component }) => component),
    connections: normalizedValue.connections,
  };
  const assessment = assessBuilderTopology(graph, input.config.pretest.builder);
  assessment.nodeDecisions.forEach((nodeDecision, index) => {
    const sourceRuleId = nodeDecision.evidence[0]?.ruleId ?? 'builder-topology';
    session = appendEngineDecision({
      session,
      config: input.config,
      answer,
      assistance: input.assistance,
      eventId: `${input.assessmentEventIdPrefix}-${index + 1}`,
      assessedAt: input.assessedAt,
      nodeId: nodeDecision.nodeId,
      outcome: nodeDecision.status,
      engine: {
        id: 'builder-topology',
        version: topologyEngineVersion,
        ruleId: sourceRuleId,
        reason: nodeDecision.evidence.map((entry) => entry.message).join('; '),
      },
    });
  });
  return { session, profile: buildLearnerProfile(session, input.config), assessment };
}

export function recordEquationAssessment(
  input: BaseEngineAssessmentInput<string> & { equationSetId: string },
) {
  const trainingCase = input.config.cases.find((entry) => entry.id === input.answer.caseId);
  if (!trainingCase) throw new Error(`No case configured for ${input.answer.caseId}`);
  const equationSet = trainingCase.equationSets.find((entry) => entry.id === input.equationSetId);
  if (!equationSet) throw new Error(`No equation set configured for ${input.equationSetId}`);
  let session = appendSessionEvent(input.session, {
    id: input.answer.id,
    occurredAt: input.answer.occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: input.answer.caseId,
    stageId: input.answer.stageId,
    attemptId: input.answer.attemptId,
    questionId: input.answer.questionId,
    answer: { format: 'text', value: input.answer.value },
  });
  const assessment = scoreEquation(input.answer.value, equationSet, input.config.rubrics.policy);
  assessment.nodeDecisions.forEach((nodeDecision, index) => {
    session = appendEngineDecision({
      session,
      config: input.config,
      answer: input.answer,
      assistance: input.assistance,
      eventId: `${input.assessmentEventIdPrefix}-${index + 1}`,
      assessedAt: input.assessedAt,
      nodeId: nodeDecision.nodeId,
      outcome: nodeDecision.outcome,
      engine: {
        id: 'equation-scoring',
        version: equationScoringEngineVersion,
        ruleId: assessment.ruleId,
        reason: nodeDecision.reasons.join('; '),
      },
    });
  });
  return { session, profile: buildLearnerProfile(session, input.config), assessment };
}
