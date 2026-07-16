import type {
  CaseConfig,
  KnowledgeModelConfig,
  RubricsConfig,
  ScaffoldPolicyConfig,
} from '../config/schemas';

export type ScaffoldOutcome = 'hit' | 'hit-with-help' | 'partial' | 'miss' | 'unanswered';

export interface ScaffoldScoreInput {
  outcome: ScaffoldOutcome;
  earned: number;
  possible: number;
  assistance: {
    kind: 'none' | 'hint' | 'socratic';
    rounds: number;
  };
}

export interface ScaffoldTransition {
  level: number;
  action: 'promote' | 'demote' | 'stay';
  streak: number;
  reason: string;
}

export function nextScaffoldLevel(
  currentLevel: number,
  scores: readonly ScaffoldScoreInput[],
  policy: ScaffoldPolicyConfig,
): ScaffoldTransition {
  const configuredLevels = policy.levels.map((entry) => entry.level);
  const minimumLevel = Math.min(...configuredLevels);
  const maximumLevel = Math.max(...configuredLevels);
  if (!configuredLevels.includes(currentLevel)) {
    throw new Error(`Unknown scaffold level ${currentLevel}`);
  }

  const outcomes = scores.map((score) => {
    if (score.possible <= 0 || score.earned < 0 || score.earned > score.possible) {
      throw new Error('Invalid full score supplied to scaffold policy');
    }
    if (score.outcome !== 'hit' && score.outcome !== 'hit-with-help') return score.outcome;
    if (score.assistance.kind === 'none') return score.outcome;
    if (score.assistance.kind === 'hint') return policy.assistance.correctOutcome;
    return score.assistance.rounds <= policy.socratic.maxRounds
      ? policy.socratic.correctedOutcome
      : 'partial';
  });
  const latest = outcomes.at(-1);
  let missStreak = 0;
  for (let index = outcomes.length - 1; index >= 0 && outcomes[index] === 'miss'; index -= 1) {
    missStreak += 1;
  }
  if (latest === 'miss' && missStreak >= policy.demotion.consecutiveMisses) {
    const level = Math.max(minimumLevel, currentLevel - policy.demotion.levels);
    return {
      level,
      action: level === currentLevel ? 'stay' : 'demote',
      streak: missStreak,
      reason: level === currentLevel ? 'Already at maximum support' : 'Miss threshold reached',
    };
  }

  const eligible = new Set<ScaffoldOutcome>(policy.promotion.eligibleOutcomes);
  if (policy.assistance.countsForPromotion) eligible.add('hit-with-help');
  else eligible.delete('hit-with-help');
  let hitStreak = 0;
  for (let index = outcomes.length - 1; index >= 0; index -= 1) {
    if (!eligible.has(outcomes[index])) break;
    hitStreak += 1;
  }
  if (hitStreak >= policy.promotion.consecutiveHits) {
    const level = Math.min(maximumLevel, currentLevel + 1);
    return {
      level,
      action: level === currentLevel ? 'stay' : 'promote',
      streak: hitStreak,
      reason: level === currentLevel ? 'Already fully independent' : 'Hit threshold reached',
    };
  }

  return {
    level: currentLevel,
    action: 'stay',
    streak: hitStreak,
    reason: latest === 'hit-with-help'
      ? 'Assisted hit does not count toward promotion'
      : 'No transition threshold reached',
  };
}

export interface CaseScoreInput {
  nodeId: string;
  earned?: number;
  possible?: number;
  outcome: 'hit' | 'hit-with-help' | 'partial' | 'miss' | 'unanswered' | 'needs-review' | 'unassessed';
  assistance: {
    kind: 'none' | 'hint' | 'socratic';
    rounds: number;
  };
}

export function evaluateCasePass(
  scores: readonly CaseScoreInput[],
  trainingCase: CaseConfig,
  knowledgeModel: KnowledgeModelConfig,
  rubrics: RubricsConfig,
  policy: ScaffoldPolicyConfig,
) {
  const nodeById = new Map(knowledgeModel.nodes.map((node) => [node.id, node]));
  const rubricByNodeId = new Map(rubrics.rubrics.map((rubric) => [rubric.nodeId, rubric]));
  const targetIds = new Set(trainingCase.targetNodeIds);
  const scoreIds = new Set<string>();
  for (const score of scores) {
    if (!nodeById.has(score.nodeId)) throw new Error(`Unknown knowledge node ${score.nodeId}`);
    if (!targetIds.has(score.nodeId)) throw new Error(`Node ${score.nodeId} is not a target of case ${trainingCase.id}`);
    if (scoreIds.has(score.nodeId)) throw new Error(`Case target ${score.nodeId} must appear exactly once`);
    scoreIds.add(score.nodeId);
  }
  const missingTargetNodeIds = trainingCase.targetNodeIds.filter((nodeId) => !scoreIds.has(nodeId));
  if (missingTargetNodeIds.length > 0) {
    throw new Error(`Scores must contain the complete case target set: missing ${missingTargetNodeIds.join(', ')}`);
  }
  let earned = 0;
  let possible = 0;
  const coreMissNodeIds: string[] = [];
  const incompleteTargetNodeIds: string[] = [];
  for (const score of scores) {
    const node = nodeById.get(score.nodeId)!;
    const rubric = rubricByNodeId.get(score.nodeId);
    if (!rubric) throw new Error(`No rubric configured for case target ${score.nodeId}`);
    if (
      score.outcome === 'unanswered'
      || score.outcome === 'needs-review'
      || score.outcome === 'unassessed'
    ) {
      incompleteTargetNodeIds.push(score.nodeId);
      continue;
    }
    if (
      score.possible === undefined
      || score.earned === undefined
      || score.possible <= 0
      || score.earned < 0
      || score.earned > score.possible
      || score.possible !== rubric.maxScore
    ) {
      throw new Error(`Invalid score for node ${score.nodeId}`);
    }
    const rubricOutcome = score.outcome === 'hit-with-help' ? 'hit' : score.outcome;
    const rule = rubric.rules.find((entry) => entry.outcome === rubricOutcome);
    if (!rule || rule.score !== score.earned) {
      throw new Error(`Invalid score for node ${score.nodeId}: does not match rubric outcome`);
    }
    earned += score.earned;
    possible += score.possible;
    const effectiveWeight = rubrics.policy.weighting.nodeOverrides[score.nodeId]
      ?? (node.weight === 2
        ? rubrics.policy.weighting.coreWeight
        : rubrics.policy.weighting.secondaryWeight);
    if (effectiveWeight === rubrics.policy.weighting.coreWeight && score.outcome === 'miss') {
      coreMissNodeIds.push(score.nodeId);
    }
  }
  const ratio = possible === 0 ? null : earned / possible;
  return {
    passed: ratio !== null
      && incompleteTargetNodeIds.length === 0
      && ratio >= policy.passing.minimumRatio
      && (!policy.passing.requireNoCoreMiss || coreMissNodeIds.length === 0),
    earned,
    possible,
    ratio,
    coreMissNodeIds,
    incompleteTargetNodeIds,
  };
}
