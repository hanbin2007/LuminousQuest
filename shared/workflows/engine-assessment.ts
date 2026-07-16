import type { LoadedConfig } from '../config/schemas';
import {
  equationScoringEngineVersion,
  scoreEquation,
  validateHalfReactionPair,
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
import type { AnswerSubmittedEvent, StudentSession } from '../session/schema';

const caseCompositeEngineVersion = 'equation-case-composite.v1';
type EquationOutcome = 'hit' | 'partial' | 'miss' | 'unanswered';
type TextAnswerEvent = AnswerSubmittedEvent & {
  answer: Extract<AnswerSubmittedEvent['answer'], { format: 'text' }>;
};

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

function latestEquationAnswer(
  session: StudentSession,
  caseId: string,
  equationSetId: string,
) {
  const questionId = `${caseId}:${equationSetId}`;
  return session.events.reduce<TextAnswerEvent | undefined>(
    (latest, event) => event.kind === 'answer.submitted'
      && event.caseId === caseId
      && event.questionId === questionId
      && event.answer.format === 'text'
      && (!latest || event.sequence > latest.sequence)
        ? event as TextAnswerEvent
        : latest,
    undefined,
  );
}

function combinedOutcome(outcomes: readonly EquationOutcome[]): EquationOutcome {
  if (outcomes.includes('miss')) return 'miss';
  if (outcomes.includes('unanswered')) return 'unanswered';
  if (outcomes.includes('partial')) return 'partial';
  return 'hit';
}

function appendCaseEquationComposite(input: {
  session: StudentSession;
  config: LoadedConfig;
  trainingCase: LoadedConfig['cases'][number];
  answer: WorkflowAnswer<string>;
  assessedAt: string;
  assessmentEventIdPrefix: string;
}) {
  const scored = new Map(input.trainingCase.equationSets.map((equationSet) => {
    const answer = latestEquationAnswer(input.session, input.trainingCase.id, equationSet.id);
    return [equationSet.electrode, {
      equationSet,
      answer,
      score: answer
        ? scoreEquation(answer.answer.value, equationSet, input.config.rubrics.policy)
        : undefined,
    }] as const;
  }));
  const negative = scored.get('negative')!;
  const positive = scored.get('positive')!;
  const overall = scored.get('overall')!;
  const decisionFor = (
    entry: typeof negative,
    nodeId: 'P3' | 'P6' | 'P7',
  ): EquationOutcome => entry.score?.nodeDecisions.find((decision) => decision.nodeId === nodeId)?.outcome
    ?? entry.score?.outcome
    ?? 'unanswered';

  const p3 = combinedOutcome([
    decisionFor(negative, 'P3'),
    decisionFor(positive, 'P3'),
  ]);
  let p6 = combinedOutcome([
    decisionFor(negative, 'P6'),
    decisionFor(positive, 'P6'),
  ]);
  let pairReason = 'Both half reactions must be valid accepted equations with equal submitted electron counts';
  if (p6 === 'hit' && negative.answer && positive.answer) {
    const pair = validateHalfReactionPair(
      negative.answer.answer.value,
      positive.answer.answer.value,
      input.trainingCase.medium,
    );
    if (!pair.balanced) {
      p6 = 'partial';
      pairReason = `Half reactions require multipliers ${pair.multipliers[0]}:${pair.multipliers[1]} before electrons cancel`;
    } else {
      pairReason = `Both half reactions balance and cancel ${pair.electronCount} electrons`;
    }
  }
  const p7 = decisionFor(overall, 'P7');
  const attempts = [negative, positive, overall]
    .map((entry) => `${entry.equationSet.electrode}=${entry.answer?.attemptId ?? 'missing'}`)
    .join(', ');
  const outcomes = [
    { nodeId: 'P3', outcome: p3, reason: `Combined electrode product and medium evidence; ${attempts}` },
    { nodeId: 'P6', outcome: p6, reason: `${pairReason}; ${attempts}` },
    { nodeId: 'P7', outcome: p7, reason: `Derived only from the submitted overall equation; ${attempts}` },
  ] as const;

  let session = input.session;
  outcomes.forEach((entry, index) => {
    session = appendEngineDecision({
      session,
      config: input.config,
      answer: input.answer,
      assistance: { kind: 'none', rounds: 0 },
      eventId: `${input.assessmentEventIdPrefix}-composite-${index + 1}`,
      assessedAt: input.assessedAt,
      nodeId: entry.nodeId,
      outcome: entry.outcome,
      engine: {
        id: 'equation-case-composite',
        version: caseCompositeEngineVersion,
        ruleId: `equation-case-${entry.nodeId.toLowerCase()}`,
        reason: entry.reason,
      },
    });
  });
  return session;
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
  const storedAnswer = session.events.at(-1);
  if (!storedAnswer || storedAnswer.kind !== 'answer.submitted' || storedAnswer.answer.format !== 'builder') {
    throw new Error('Builder answer was not persisted');
  }
  const canonicalAnswer = { ...answer, value: storedAnswer.answer.value };
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
      answer: canonicalAnswer,
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
  session = appendCaseEquationComposite({
    session,
    config: input.config,
    trainingCase,
    answer: input.answer,
    assessedAt: input.assessedAt,
    assessmentEventIdPrefix: input.assessmentEventIdPrefix,
  });
  return { session, profile: buildLearnerProfile(session, input.config), assessment };
}
