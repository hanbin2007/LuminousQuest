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

export interface LearnerNodeProfile {
  nodeId: string;
  dimensionId: string;
  weight: 1 | 2;
  status: LearnerNodeStatus;
  outcome?: 'hit' | 'hit-with-help' | 'partial' | 'miss';
  earned?: number;
  possible?: number;
  annotations?: Array<'following' | 'hit-with-help'>;
  trace?: {
    sourceAnswerEventId: string;
    originalAnswer: string;
    rubric: { id: string; version: string };
    ruleId: string;
    evidence: Array<{ quote: string; start: number; end: number }>;
    engine: { id: string; version: string };
  };
}

export interface DimensionProfile {
  dimensionId: string;
  earned: number;
  possible: number;
  ratio: number | null;
  assessedNodeIds: string[];
  unassessedNodeIds: string[];
  needsReviewNodeIds: string[];
}

function originalAnswer(answer: AnswerSubmittedEvent) {
  return answer.answer.format === 'text'
    ? answer.answer.value
    : JSON.stringify(answer.answer.value);
}

function needsReview(event: AssessmentCompletedEvent) {
  return [event.extraction.status, event.ruleDecision.status, event.following.status, event.score.status]
    .includes('needs-review');
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
  if (loadedConfig) {
    if (parsed.configVersions.configDigest !== loadedConfig.configVersion) {
      throw new Error('Session config digest does not match the profile configuration');
    }
    const expectedCases = JSON.stringify(loadedConfig.runtimeVersions.cases);
    if (JSON.stringify(parsed.configVersions.cases) !== expectedCases) {
      throw new Error('Session case versions do not match the profile configuration');
    }
    if (parsed.configVersions.grammar !== loadedConfig.runtimeVersions.grammar) {
      throw new Error('Session equation grammar version does not match the profile configuration');
    }
    if (JSON.stringify(parsed.configVersions.engines) !== JSON.stringify(loadedConfig.runtimeVersions.engines)) {
      throw new Error('Session scoring engine versions do not match the profile configuration');
    }
    if (parsed.configVersions.pretest !== loadedConfig.pretest.version) {
      throw new Error('Session pretest version does not match the profile configuration');
    }
    if (parsed.configVersions.scaffoldPolicy !== loadedConfig.scaffoldPolicy.version) {
      throw new Error('Session scaffold policy version does not match the profile configuration');
    }
  }
  if (parsed.configVersions.knowledgeModel !== knowledgeModel.version) {
    throw new Error('Session knowledge model version does not match the profile configuration');
  }
  if (parsed.configVersions.rubrics !== rubrics.version) {
    throw new Error('Session rubric version does not match the profile configuration');
  }

  const answers = new Map<string, AnswerSubmittedEvent>();
  const latestByNode = new Map<string, AssessmentCompletedEvent>();
  for (const event of parsed.events) {
    if (event.kind === 'answer.submitted') answers.set(event.id, event);
    else if (event.kind === 'assessment.completed') latestByNode.set(event.nodeId, event);
  }
  const rubricById = new Map(rubrics.rubrics.map((rubric) => [rubric.id, rubric]));

  const nodes: LearnerNodeProfile[] = knowledgeModel.nodes.map((node) => {
    const event = latestByNode.get(node.id);
    const base = { nodeId: node.id, dimensionId: node.dimensionId, weight: node.weight };
    if (!event) return { ...base, status: 'unassessed' as const };
    if (needsReview(event)) return { ...base, status: 'needs-review' as const };
    if (event.score.status !== 'scored') return { ...base, status: 'unassessed' as const };
    // sessionSchema guarantees that a scored event has assessed extraction and rule stages.
    const ruleDecision = event.ruleDecision as Extract<
      AssessmentCompletedEvent['ruleDecision'],
      { ruleId: string }
    >;
    const extraction = event.extraction as Extract<
      AssessmentCompletedEvent['extraction'],
      { status: 'assessed' }
    >;

    const rubric = rubricById.get(event.rubric.id);
    if (!rubric || rubric.nodeId !== node.id || event.rubric.version !== rubrics.version) {
      throw new Error(`Rubric trace does not match node ${node.id}`);
    }
    const rule = rubric.rules.find((entry) => entry.id === ruleDecision.ruleId);
    const ruleOutcome = ruleDecision.status === 'hit-with-help' ? 'hit' : ruleDecision.status;
    if (!rule || rule.outcome !== ruleOutcome) {
      throw new Error(`Rubric rule trace does not match node ${node.id}`);
    }
    if (event.score.earned !== rule.score || event.score.possible !== rubric.maxScore) {
      throw new Error(`Persisted score does not match rubric rule ${rule.id}`);
    }
    const answer = answers.get(event.sourceAnswerEventId)!;
    const source = originalAnswer(answer);

    return {
      ...base,
      status: 'scored' as const,
      outcome: ruleDecision.status,
      earned: event.score.earned,
      possible: event.score.possible,
      annotations: event.score.annotations,
      trace: {
        sourceAnswerEventId: event.sourceAnswerEventId,
        originalAnswer: source,
        rubric: event.rubric,
        ruleId: ruleDecision.ruleId,
        evidence: extraction.evidence,
        engine: ruleDecision.engine,
      },
    };
  });

  const dimensions: DimensionProfile[] = knowledgeModel.dimensions.map((dimension) => {
    const dimensionNodes = nodes.filter((node) => node.dimensionId === dimension.id);
    const assessed = dimensionNodes.filter(
      (node): node is LearnerNodeProfile & { status: 'scored'; earned: number; possible: number } =>
        node.status === 'scored',
    );
    const earned = assessed.reduce((total, node) => total + node.earned, 0);
    const possible = assessed.reduce((total, node) => total + node.possible, 0);
    return {
      dimensionId: dimension.id,
      earned,
      possible,
      ratio: possible === 0 ? null : earned / possible,
      assessedNodeIds: assessed.map((node) => node.nodeId),
      unassessedNodeIds: dimensionNodes
        .filter((node) => node.status === 'unassessed')
        .map((node) => node.nodeId),
      needsReviewNodeIds: dimensionNodes
        .filter((node) => node.status === 'needs-review')
        .map((node) => node.nodeId),
    };
  });

  return {
    sessionId: parsed.id,
    anonymousStudentId: parsed.anonymousStudentId,
    rubricVersion: rubrics.version,
    nodes,
    dimensions,
  };
}
