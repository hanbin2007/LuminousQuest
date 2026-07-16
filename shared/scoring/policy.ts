import type { RubricsConfig } from '../config/schemas';

export type MasteryOutcome = 'hit' | 'hit-with-help' | 'partial' | 'miss';
export type PolicyAssessmentStatus = MasteryOutcome | 'unanswered' | 'needs-review';

export interface ExtractedFactSlot {
  id: string;
  value: string;
}

export interface ExtractedAssessmentFacts {
  response: 'substantive' | 'blank' | 'non-answer';
  verified: {
    colloquial: boolean;
    beyondSyllabus: boolean;
    contradiction: boolean;
    typo: 'none' | 'unambiguous' | 'ambiguous';
  };
  slots: ExtractedFactSlot[];
}

export interface FactRequirement {
  id: string;
  acceptedValues: readonly string[];
}

export interface PolicyEvaluation {
  status: Exclude<PolicyAssessmentStatus, 'hit-with-help'>;
  matchedRequirementIds: string[];
  missingRequirementIds: string[];
  warnings: string[];
  promptRetry: boolean;
  includeInDiagnosis: boolean;
  bonusPoints: number;
}

export function normalizeFactValue(value: string) {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function capPartial(
  outcome: 'hit' | 'partial' | 'miss',
  policy: RubricsConfig['policy'],
) {
  return outcome === 'partial' && policy.outcomeScale.mode === 'two-state' ? 'miss' : outcome;
}

export function evaluateExtractedFacts(input: {
  facts: ExtractedAssessmentFacts;
  requirements: readonly FactRequirement[];
  policy: RubricsConfig['policy'];
}): PolicyEvaluation {
  const { facts, requirements, policy } = input;
  const slots = new Map(facts.slots.map((slot) => [slot.id, normalizeFactValue(slot.value)]));
  const matchedRequirementIds = requirements
    .filter((requirement) => {
      const actual = slots.get(requirement.id);
      return actual !== undefined
        && requirement.acceptedValues.some((value) => normalizeFactValue(value) === actual);
    })
    .map((requirement) => requirement.id);
  const matched = new Set(matchedRequirementIds);
  const missingRequirementIds = requirements
    .filter((requirement) => !matched.has(requirement.id))
    .map((requirement) => requirement.id);
  const base = {
    matchedRequirementIds,
    missingRequirementIds,
    warnings: [] as string[],
    promptRetry: false,
    includeInDiagnosis: true,
    bonusPoints: 0,
  };

  if (facts.response !== 'substantive') {
    return {
      ...base,
      status: policy.nonResponse.status,
      promptRetry: policy.nonResponse.promptRetry,
      includeInDiagnosis: policy.nonResponse.includeInDiagnosis,
    };
  }
  if (facts.verified.contradiction) {
    return { ...base, status: capPartial(policy.contradiction.outcome, policy) };
  }
  if (facts.verified.typo === 'ambiguous') {
    return { ...base, status: policy.typos.ambiguousStrategy };
  }

  let status: 'hit' | 'partial' | 'miss' = requirements.length > 0
    && matchedRequirementIds.length === requirements.length
    ? 'hit'
    : matchedRequirementIds.length > 0
      ? 'partial'
      : 'miss';

  if (status === 'hit' && facts.verified.colloquial) {
    status = policy.terminology.requireModelTermsForHit
      ? 'partial'
      : policy.terminology.colloquialCorrectOutcome;
  }
  if (status === 'hit' && facts.verified.beyondSyllabus) {
    status = policy.beyondSyllabus.correctOutcome;
    base.bonusPoints = policy.beyondSyllabus.bonusPoints;
  }
  if (facts.verified.typo === 'unambiguous') {
    if (policy.typos.unambiguousStrategy === 'warn-no-penalty') {
      base.warnings.push('unambiguous-typo');
    } else if (policy.typos.unambiguousStrategy === 'penalize' && status === 'hit') {
      status = 'partial';
    }
  }

  return { ...base, status: capPartial(status, policy) };
}

export function factsMatchRequirements(
  facts: Pick<ExtractedAssessmentFacts, 'slots'>,
  requirements: readonly FactRequirement[],
) {
  const slots = new Map(facts.slots.map((slot) => [slot.id, normalizeFactValue(slot.value)]));
  return requirements.length > 0 && requirements.every((requirement) => {
    const actual = slots.get(requirement.id);
    return actual !== undefined
      && requirement.acceptedValues.some((value) => normalizeFactValue(value) === actual);
  });
}
