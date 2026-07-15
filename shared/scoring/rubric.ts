import type { RubricsConfig } from '../config/schemas';

export type RubricOutcome = 'hit' | 'partial' | 'miss';
export type AssistanceKind = 'none' | 'hint' | 'socratic';

export interface FollowingDecisionInput {
  anchorId: string;
  anchorOutcome: RubricOutcome;
  logicalChainConsistent: boolean;
}

export interface ResolveRubricDecisionInput {
  rubrics: RubricsConfig;
  nodeId: string;
  logicalOutcome: RubricOutcome;
  objectiveOutcome: RubricOutcome;
  following?: FollowingDecisionInput;
  assistance: AssistanceKind;
}

export function resolveRubricDecision(input: ResolveRubricDecisionInput) {
  const rubric = input.rubrics.rubrics.find((entry) => entry.nodeId === input.nodeId);
  if (!rubric) throw new Error(`No rubric configured for node ${input.nodeId}`);

  const followingPolicy = input.rubrics.policy.followingError;
  const shouldFollow = followingPolicy.strategy === 'score-logical-chain'
    && rubric.followingAnchorId !== undefined
    && input.following?.anchorId === rubric.followingAnchorId
    && input.following.anchorOutcome !== 'hit'
    && input.following.logicalChainConsistent;
  const outcome = shouldFollow ? input.logicalOutcome : input.objectiveOutcome;
  const rule = rubric.rules.find((entry) => entry.outcome === outcome);
  if (!rule) throw new Error(`Rubric ${rubric.id} has no ${outcome} rule`);

  const annotations: Array<'following' | 'hit-with-help'> = [];
  if (shouldFollow) annotations.push('following');
  if (outcome === 'hit' && input.assistance !== 'none') annotations.push('hit-with-help');

  return {
    ruleDecision: {
      status: outcome,
      ruleId: rule.id,
      reason: shouldFollow
        ? `Logical chain is coherent under the ${input.following!.anchorId} anchor`
        : `Objective rubric outcome is ${outcome}`,
      engine: { id: 'rubric-policy', version: input.rubrics.version },
    } as const,
    following: shouldFollow
      ? {
          status: 'followed' as const,
          anchorNodeId: input.following!.anchorId,
          anchorOutcome: input.following!.anchorOutcome,
          policy: followingPolicy.strategy,
        }
      : {
          status: 'not-followed' as const,
          anchorNodeId: null,
          anchorOutcome: null,
          policy: followingPolicy.strategy,
        },
    score: {
      status: 'scored' as const,
      earned: rule.score,
      possible: rubric.maxScore,
      annotations,
    },
  };
}
