import type {
  KnowledgeModelConfig,
  LoadedConfig,
  RubricsConfig,
} from '../config/schemas';
import {
  type AssessmentCompletedEvent,
  type AnswerSubmittedEvent,
  sessionSchema,
} from '../session/schema';

export type LearnerNodeStatus = 'scored' | 'unassessed' | 'needs-review';
export type LatestAttemptStatus = 'scored' | 'unanswered' | 'unassessed' | 'needs-review';

export interface LearnerNodeProfile {
  nodeId: string;
  dimensionId: string;
  weight: number;
  status: LearnerNodeStatus;
  latestAttempt?: {
    status: LatestAttemptStatus;
    eventId: string;
    sequence: number;
    assistance: AssessmentCompletedEvent['assistance'];
  };
  outcome?: 'hit' | 'hit-with-help' | 'partial' | 'miss';
  /** 被 repeated-answers 策略选中的评分事件(点亮状态与顺序的同源依据)。 */
  selectedAssessment?: { eventId: string; sequence: number };
  earned?: number;
  possible?: number;
  visualization?: 'half-lit' | 'dark' | 'full-lit';
  annotations?: Array<'following' | 'hit-with-help'>;
  trace?: {
    sourceAnswerEventId: string;
    originalAnswer: string;
    rubric: { id: string; version: string };
    ruleId: string;
    evidence: Array<{ quote: string; start: number; end: number }>;
    engine: { id: string; version: string };
    assistance: AssessmentCompletedEvent['assistance'];
  };
}

export interface DimensionProfile {
  dimensionId: string;
  earned: number;
  possible: number;
  ratio: number | null;
  level: 'unassessed' | 'weak' | 'developing' | 'mastered';
  weak: boolean;
  assessedNodeIds: string[];
  unassessedNodeIds: string[];
  needsReviewNodeIds: string[];
}

export function classifyDimensionLevel(
  ratio: number | null,
  weaknessThreshold: number,
): DimensionProfile['level'] {
  if (ratio === null) return 'unassessed';
  if (ratio < weaknessThreshold) return 'weak';
  if (ratio < 1) return 'developing';
  return 'mastered';
}

function originalAnswer(answer: AnswerSubmittedEvent) {
  return answer.answer.format === 'text' || answer.answer.format === 'equation'
    ? answer.answer.value
    : answer.answer.format === 'choice'
      ? answer.answer.optionId
      : JSON.stringify(answer.answer.value);
}

function needsReview(event: AssessmentCompletedEvent) {
  return [event.extraction.status, event.ruleDecision.status, event.following.status, event.score.status]
    .includes('needs-review');
}

function latestAttemptStatus(event: AssessmentCompletedEvent): LatestAttemptStatus {
  if (needsReview(event)) return 'needs-review';
  if (event.score.status === 'scored') return 'scored';
  if (event.score.status === 'unanswered') return 'unanswered';
  return 'unassessed';
}

function selectedCompletedEvent(
  events: readonly AssessmentCompletedEvent[],
  strategy: RubricsConfig['policy']['repeatedAnswers']['strategy'],
) {
  const scored = events.filter((event): event is AssessmentCompletedEvent & {
    score: Extract<AssessmentCompletedEvent['score'], { status: 'scored' }>;
  } => event.score.status === 'scored');
  if (scored.length === 0) return undefined;
  if (strategy === 'latest') return scored.at(-1);
  return [...scored].sort((left, right) => {
    const leftRatio = left.score.earned / left.score.possible;
    const rightRatio = right.score.earned / right.score.possible;
    const comparison = strategy === 'best'
      ? rightRatio - leftRatio
      : leftRatio - rightRatio;
    return comparison || right.sequence - left.sequence;
  })[0];
}

function validateConfigVersions(session: ReturnType<typeof sessionSchema.parse>, config: LoadedConfig) {
  if (session.configVersions.configDigest !== config.configVersion) {
    throw new Error('Session config digest does not match the profile configuration');
  }
  if (JSON.stringify(session.configVersions.cases) !== JSON.stringify(config.runtimeVersions.cases)) {
    throw new Error('Session case versions do not match the profile configuration');
  }
  if (session.configVersions.grammar !== config.runtimeVersions.grammar) {
    throw new Error('Session equation grammar version does not match the profile configuration');
  }
  if (JSON.stringify(session.configVersions.engines) !== JSON.stringify(config.runtimeVersions.engines)) {
    throw new Error('Session scoring engine versions do not match the profile configuration');
  }
  if (session.configVersions.pretest !== config.pretest.version) {
    throw new Error('Session pretest version does not match the profile configuration');
  }
  if (session.configVersions.scaffoldPolicy !== config.scaffoldPolicy.version) {
    throw new Error('Session scaffold policy version does not match the profile configuration');
  }
}

function policyDimension(
  nodeId: string,
  fallback: string,
  policy: RubricsConfig['policy'],
) {
  if (nodeId === 'P1') return policy.dimensionAssignments.spontaneousRedox;
  if (nodeId === 'D5' && policy.dimensionAssignments.siteReactantDistinction === 'principle-only') {
    return 'principle';
  }
  return fallback;
}

function effectiveWeight(
  node: KnowledgeModelConfig['nodes'][number],
  policy: RubricsConfig['policy'],
) {
  return policy.weighting.nodeOverrides[node.id]
    ?? (node.weight === 2 ? policy.weighting.coreWeight : policy.weighting.secondaryWeight);
}

function visualizationFor(
  outcome: LearnerNodeProfile['outcome'],
  policy: RubricsConfig['policy'],
) {
  if (outcome === 'hit' || outcome === 'hit-with-help') return 'full-lit' as const;
  if (outcome === 'partial') return policy.weakness.partialVisualization;
  return 'dark' as const;
}

export function buildLearnerProfile(
  session: unknown,
  configOrKnowledgeModel: LoadedConfig | KnowledgeModelConfig,
  legacyRubrics?: RubricsConfig,
) {
  const loadedConfig = 'knowledgeModel' in configOrKnowledgeModel ? configOrKnowledgeModel : undefined;
  const knowledgeModel = loadedConfig?.knowledgeModel ?? configOrKnowledgeModel as KnowledgeModelConfig;
  const rubrics = loadedConfig?.rubrics ?? legacyRubrics;
  if (!rubrics) throw new Error('Rubric configuration is required');
  const parsed = sessionSchema.parse(session);
  if (loadedConfig) validateConfigVersions(parsed, loadedConfig);
  if (parsed.configVersions.knowledgeModel !== knowledgeModel.version) {
    throw new Error('Session knowledge model version does not match the profile configuration');
  }
  if (parsed.configVersions.rubrics !== rubrics.version) {
    throw new Error('Session rubric version does not match the profile configuration');
  }

  const answers = new Map<string, AnswerSubmittedEvent>();
  const eventsByNode = new Map<string, AssessmentCompletedEvent[]>();
  for (const event of parsed.events) {
    if (event.kind === 'answer.submitted') {
      answers.set(event.id, event);
    } else if (event.kind === 'assessment.completed') {
      const events = eventsByNode.get(event.nodeId) ?? [];
      events.push(event);
      eventsByNode.set(event.nodeId, events);
    }
  }
  const rubricById = new Map(rubrics.rubrics.map((rubric) => [rubric.id, rubric]));

  const nodes: LearnerNodeProfile[] = knowledgeModel.nodes.map((node) => {
    const events = eventsByNode.get(node.id) ?? [];
    const latest = events.at(-1);
    const selected = selectedCompletedEvent(events, rubrics.policy.repeatedAnswers.strategy);
    const base = {
      nodeId: node.id,
      dimensionId: policyDimension(node.id, node.dimensionId, rubrics.policy),
      weight: effectiveWeight(node, rubrics.policy),
      ...(latest
        ? {
            latestAttempt: {
              status: latestAttemptStatus(latest),
              eventId: latest.id,
              sequence: latest.sequence,
              assistance: latest.assistance,
            },
          }
        : {}),
    };
    if (!selected) {
      return {
        ...base,
        status: latest && needsReview(latest) ? 'needs-review' as const : 'unassessed' as const,
      };
    }

    const ruleDecision = selected.ruleDecision;
    const extraction = selected.extraction;
    if (!('ruleId' in ruleDecision) || extraction.status !== 'assessed') {
      throw new Error(`Completed score for node ${node.id} lacks an assessed rule trace`);
    }
    const rubric = rubricById.get(selected.rubric.id);
    if (!rubric || rubric.nodeId !== node.id || selected.rubric.version !== rubrics.version) {
      throw new Error(`Rubric trace does not match node ${node.id}`);
    }
    const rule = rubric.rules.find((entry) => entry.id === ruleDecision.ruleId);
    const ruleOutcome = ruleDecision.status === 'hit-with-help' ? 'hit' : ruleDecision.status;
    if (!rule || rule.outcome !== ruleOutcome) {
      throw new Error(`Rubric rule trace does not match node ${node.id}`);
    }
    if (selected.score.earned !== rule.score || selected.score.possible !== rubric.maxScore) {
      throw new Error(`Persisted score does not match rubric rule ${rule.id}`);
    }
    if (selected.score.outcome && selected.score.outcome !== ruleDecision.status) {
      throw new Error(`Persisted mastery outcome does not match rubric rule ${rule.id}`);
    }
    const answer = answers.get(selected.sourceAnswerEventId);
    if (!answer) throw new Error(`Missing source answer ${selected.sourceAnswerEventId}`);

    return {
      ...base,
      status: 'scored' as const,
      outcome: ruleDecision.status,
      selectedAssessment: { eventId: selected.id, sequence: selected.sequence },
      earned: selected.score.earned,
      possible: selected.score.possible,
      visualization: visualizationFor(ruleDecision.status, rubrics.policy),
      annotations: selected.score.annotations,
      trace: {
        sourceAnswerEventId: selected.sourceAnswerEventId,
        originalAnswer: originalAnswer(answer),
        rubric: selected.rubric,
        ruleId: ruleDecision.ruleId,
        evidence: extraction.evidence,
        engine: ruleDecision.engine,
        assistance: selected.assistance,
      },
    };
  });

  const dimensions: DimensionProfile[] = knowledgeModel.dimensions.map((dimension) => {
    const dimensionNodes = nodes.filter((node) => node.dimensionId === dimension.id);
    const assessed = dimensionNodes.filter(
      (node): node is LearnerNodeProfile & {
        status: 'scored';
        earned: number;
        possible: number;
      } => node.status === 'scored',
    );
    const earned = assessed.reduce(
      (total, node) => total + (node.earned / node.possible) * node.weight,
      0,
    );
    const possible = assessed.reduce((total, node) => total + node.weight, 0);
    const ratio = possible === 0 ? null : earned / possible;
    const level = classifyDimensionLevel(ratio, rubrics.policy.weakness.threshold);
    return {
      dimensionId: dimension.id,
      earned,
      possible,
      ratio,
      level,
      weak: level === 'weak',
      assessedNodeIds: assessed.map((node) => node.nodeId),
      unassessedNodeIds: dimensionNodes
        .filter((node) => node.status === 'unassessed')
        .map((node) => node.nodeId),
      needsReviewNodeIds: dimensionNodes
        .filter((node) => node.status === 'needs-review')
        .map((node) => node.nodeId),
    };
  });

  const assessedDimensions = dimensions.filter((dimension) => dimension.ratio !== null);
  const overallRatio = assessedDimensions.length === 0
    ? null
    : rubrics.policy.weighting.dimensionMode === 'equal'
      ? assessedDimensions.reduce((sum, dimension) => sum + dimension.ratio!, 0) / assessedDimensions.length
      : assessedDimensions.reduce((sum, dimension) => sum + dimension.earned, 0)
        / assessedDimensions.reduce((sum, dimension) => sum + dimension.possible, 0);
  const studentRadar = dimensions.map((dimension) => {
    const score = dimension.ratio;
    const level = dimension.level;
    if (rubrics.policy.presentation.studentRadar === 'score') {
      return { dimensionId: dimension.dimensionId, score };
    }
    if (rubrics.policy.presentation.studentRadar === 'level') {
      return { dimensionId: dimension.dimensionId, level };
    }
    return { dimensionId: dimension.dimensionId, score, level };
  });

  return {
    sessionId: parsed.id,
    anonymousStudentId: parsed.anonymousStudentId,
    rubricVersion: rubrics.version,
    nodes,
    dimensions,
    overallRatio,
    weakNodeIds: nodes
      .filter((node) =>
        node.status === 'scored'
        && node.earned! / node.possible! < rubrics.policy.weakness.threshold)
      .map((node) => node.nodeId),
    conceptAssignments: {
      spontaneousRedoxDimensionId: rubrics.policy.dimensionAssignments.spontaneousRedox,
      saltBridgeNodeId: rubrics.policy.dimensionAssignments.saltBridge,
      siteReactantDistinction: rubrics.policy.dimensionAssignments.siteReactantDistinction,
    },
    crossAxisNodeIds: rubrics.policy.dimensionAssignments.siteReactantDistinction === 'D5-cross-axis'
      ? ['D5']
      : [],
    presentation: {
      studentRadarMode: rubrics.policy.presentation.studentRadar,
      studentRadar,
      classSummaryMetrics: rubrics.policy.presentation.classSummary,
    },
  };
}
