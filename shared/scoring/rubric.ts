import type { RubricsConfig, ScaffoldPolicyConfig } from '../config/schemas';
import type { MasteryOutcome } from './policy';

export type RubricOutcome = 'hit' | 'partial' | 'miss';
export type AssistanceKind = 'none' | 'hint' | 'socratic';
export const rubricPolicyEngineVersion = 'rubric-policy.v2';

export interface AssistanceMetadata {
  kind: AssistanceKind;
  rounds: number;
}

export interface FollowingDecisionInput {
  anchorId: string;
  anchorOutcome: RubricOutcome;
  logicalChainConsistent: boolean;
}

export interface ResolveRubricDecisionInput {
  rubrics: RubricsConfig;
  scaffoldPolicy?: ScaffoldPolicyConfig;
  nodeId: string;
  logicalOutcome?: RubricOutcome;
  objectiveOutcome: RubricOutcome;
  following?: FollowingDecisionInput;
  assistance: AssistanceKind | AssistanceMetadata;
  engine?: { id: string; version: string; ruleId?: string; reason?: string };
}

function assistanceMetadata(assistance: AssistanceKind | AssistanceMetadata): AssistanceMetadata {
  return typeof assistance === 'string'
    ? { kind: assistance, rounds: assistance === 'none' ? 0 : 1 }
    : assistance;
}

function applyAssistance(
  outcome: RubricOutcome,
  assistance: AssistanceMetadata,
  policy?: ScaffoldPolicyConfig,
): MasteryOutcome {
  if (outcome !== 'hit' || assistance.kind === 'none') return outcome;
  if (assistance.kind === 'hint') return policy?.assistance.correctOutcome ?? 'hit-with-help';
  if (policy && assistance.rounds > policy.socratic.maxRounds) return 'partial';
  return policy?.socratic.correctedOutcome ?? 'hit-with-help';
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
  const baseOutcome = shouldFollow ? (input.logicalOutcome ?? input.objectiveOutcome) : input.objectiveOutcome;
  const normalizedBaseOutcome = baseOutcome === 'partial'
    && input.rubrics.policy.outcomeScale.mode === 'two-state'
    ? 'miss'
    : baseOutcome;
  const assistance = assistanceMetadata(input.assistance);
  const outcome = applyAssistance(normalizedBaseOutcome, assistance, input.scaffoldPolicy);
  const rubricOutcome = outcome === 'hit-with-help' ? 'hit' : outcome;
  const rule = rubric.rules.find((entry) => entry.outcome === rubricOutcome);
  if (!rule) throw new Error(`Rubric ${rubric.id} has no ${rubricOutcome} rule`);

  const annotations: Array<'following' | 'hit-with-help'> = [];
  if (shouldFollow) annotations.push('following');
  if (outcome === 'hit-with-help') annotations.push('hit-with-help');

  return {
    ruleDecision: {
      status: outcome,
      ruleId: rule.id,
      reason: input.engine?.reason ?? (shouldFollow
        ? `Logical chain is coherent under the ${input.following!.anchorId} anchor`
        : `Objective rubric outcome is ${outcome}`),
      engine: {
        id: input.engine?.id ?? 'rubric-policy',
        version: input.engine?.version ?? rubricPolicyEngineVersion,
        ...(input.engine?.ruleId ? { sourceRuleId: input.engine.ruleId } : {}),
      },
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
      outcome,
    },
    assistance,
  };
}
