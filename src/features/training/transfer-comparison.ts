import type {
  KnowledgeModelConfig,
  LoadedConfig,
  RubricsConfig,
} from '../../../shared/config/schemas';
import {
  type AssessmentCompletedEvent,
  sessionSchema,
} from '../../../shared/session';
import { classifyDimensionLevel, type DimensionProfile } from '../../../shared/scoring/profile';

type DimensionId = KnowledgeModelConfig['dimensions'][number]['id'];
type ScoredAssessment = AssessmentCompletedEvent & {
  score: Extract<AssessmentCompletedEvent['score'], { status: 'scored' }>;
};

export interface NormalizedDimensionResult {
  weightedEarned: number;
  assessedWeight: number;
  ratio: number | null;
  level: DimensionProfile['level'];
  assessedNodeIds: string[];
  unassessedNodeIds: string[];
}

export interface TransferDimensionComparison {
  dimensionId: DimensionId;
  label: string;
  commonNodeIds: string[];
  pretest: NormalizedDimensionResult;
  transfer: NormalizedDimensionResult;
}

export interface TransferComparison {
  transferCaseId: string;
  commonNodeIds: string[];
  dimensions: TransferDimensionComparison[];
}

function pretestTargetNodeIds(config: LoadedConfig) {
  return new Set([
    ...config.pretest.builder.structuralRules.flatMap((rule) => rule.nodeIds),
    ...config.pretest.questions.flatMap((question) => question.targetNodeIds),
  ]);
}

function dimensionForNode(
  nodeId: string,
  fallback: DimensionId,
  policy: RubricsConfig['policy'],
): DimensionId {
  if (nodeId === 'P1') return policy.dimensionAssignments.spontaneousRedox;
  if (nodeId === 'D5' && policy.dimensionAssignments.siteReactantDistinction === 'principle-only') {
    return 'principle';
  }
  return fallback;
}

function nodeWeight(
  node: KnowledgeModelConfig['nodes'][number],
  policy: RubricsConfig['policy'],
) {
  return policy.weighting.nodeOverrides[node.id]
    ?? (node.weight === 2 ? policy.weighting.coreWeight : policy.weighting.secondaryWeight);
}

export function latestScoredByNode(
  events: readonly AssessmentCompletedEvent[],
  caseId: string,
  commonNodeIds: ReadonlySet<string>,
) {
  const result = new Map<string, ScoredAssessment>();
  for (const event of events) {
    if (
      event.caseId === caseId
      && commonNodeIds.has(event.nodeId)
      && event.score.status === 'scored'
    ) {
      const current = result.get(event.nodeId);
      if (!current || event.sequence > current.sequence) {
        result.set(event.nodeId, event as ScoredAssessment);
      }
    }
  }
  return result;
}

function normalizeDimension(
  nodes: readonly KnowledgeModelConfig['nodes'][number][],
  scores: ReadonlyMap<string, ScoredAssessment>,
  policy: RubricsConfig['policy'],
): NormalizedDimensionResult {
  let weightedEarned = 0;
  let assessedWeight = 0;
  const assessedNodeIds: string[] = [];
  const unassessedNodeIds: string[] = [];

  for (const node of nodes) {
    const assessment = scores.get(node.id);
    if (!assessment) {
      unassessedNodeIds.push(node.id);
      continue;
    }
    const weight = nodeWeight(node, policy);
    weightedEarned += (assessment.score.earned / assessment.score.possible) * weight;
    assessedWeight += weight;
    assessedNodeIds.push(node.id);
  }

  const ratio = assessedWeight === 0 ? null : weightedEarned / assessedWeight;
  return {
    weightedEarned,
    assessedWeight,
    ratio,
    level: classifyDimensionLevel(ratio, policy.weakness.threshold),
    assessedNodeIds,
    unassessedNodeIds,
  };
}

export function buildTransferComparison(
  session: unknown,
  config: LoadedConfig,
  transferCaseId: string,
): TransferComparison {
  const transferCase = config.cases.find((entry) => entry.id === transferCaseId);
  if (!transferCase) throw new Error(`Unknown transfer case ${transferCaseId}`);
  if (transferCase.caseType !== 'transfer') {
    throw new Error(`Case ${transferCaseId} is not a transfer case`);
  }

  const parsed = sessionSchema.parse(session);
  const pretestTargets = pretestTargetNodeIds(config);
  const transferTargets = new Set(transferCase.targetNodeIds);
  const commonNodes = config.knowledgeModel.nodes.filter(
    (node) => pretestTargets.has(node.id) && transferTargets.has(node.id),
  );
  const commonNodeIds = commonNodes.map((node) => node.id);
  const commonNodeIdSet = new Set(commonNodeIds);
  const assessmentEvents = parsed.events.filter(
    (event): event is AssessmentCompletedEvent => event.kind === 'assessment.completed',
  );
  const pretestScores = latestScoredByNode(assessmentEvents, 'pretest', commonNodeIdSet);
  const transferScores = latestScoredByNode(assessmentEvents, transferCaseId, commonNodeIdSet);

  return {
    transferCaseId,
    commonNodeIds,
    dimensions: config.knowledgeModel.dimensions.map((dimension) => {
      const nodes = commonNodes.filter((node) =>
        dimensionForNode(node.id, node.dimensionId, config.rubrics.policy) === dimension.id);
      return {
        dimensionId: dimension.id,
        label: dimension.label,
        commonNodeIds: nodes.map((node) => node.id),
        pretest: normalizeDimension(nodes, pretestScores, config.rubrics.policy),
        transfer: normalizeDimension(nodes, transferScores, config.rubrics.policy),
      };
    }),
  };
}
