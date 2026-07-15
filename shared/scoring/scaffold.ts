import type {
  KnowledgeModelConfig,
  ScaffoldPolicyConfig,
} from '../config/schemas';

export type ScaffoldOutcome = 'hit' | 'hit-with-help' | 'partial' | 'miss';

export interface ScaffoldTransition {
  level: number;
  action: 'promote' | 'demote' | 'stay';
  streak: number;
  reason: string;
}

export function nextScaffoldLevel(
  currentLevel: number,
  outcomes: readonly ScaffoldOutcome[],
  policy: ScaffoldPolicyConfig,
): ScaffoldTransition {
  const configuredLevels = policy.levels.map((entry) => entry.level);
  const minimumLevel = Math.min(...configuredLevels);
  const maximumLevel = Math.max(...configuredLevels);
  if (!configuredLevels.includes(currentLevel)) {
    throw new Error(`Unknown scaffold level ${currentLevel}`);
  }

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
  earned: number;
  possible: number;
  outcome: 'hit' | 'partial' | 'miss';
}

export function evaluateCasePass(
  scores: readonly CaseScoreInput[],
  knowledgeModel: KnowledgeModelConfig,
  policy: ScaffoldPolicyConfig,
) {
  const nodeById = new Map(knowledgeModel.nodes.map((node) => [node.id, node]));
  let earned = 0;
  let possible = 0;
  const coreMissNodeIds: string[] = [];
  for (const score of scores) {
    const node = nodeById.get(score.nodeId);
    if (!node) throw new Error(`Unknown knowledge node ${score.nodeId}`);
    if (score.possible <= 0 || score.earned < 0 || score.earned > score.possible) {
      throw new Error(`Invalid score for node ${score.nodeId}`);
    }
    earned += score.earned;
    possible += score.possible;
    if (node.weight === 2 && score.outcome === 'miss') coreMissNodeIds.push(score.nodeId);
  }
  const ratio = possible === 0 ? null : earned / possible;
  return {
    passed: ratio !== null
      && ratio >= policy.passing.minimumRatio
      && (!policy.passing.requireNoCoreMiss || coreMissNodeIds.length === 0),
    earned,
    possible,
    ratio,
    coreMissNodeIds,
  };
}
