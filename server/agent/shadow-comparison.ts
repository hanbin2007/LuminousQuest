import type { LoadedConfig } from '../../shared/config/schemas';
import { buildLearnerProfile } from '../../shared/scoring/profile';
import {
  sessionSchema,
  type AssessmentCompletedEvent,
} from '../../shared/session/schema';
import type { ComparableAgentVerdict } from '../../shared/agent/contracts';

export const AGENT_SHADOW_COMPARISON_POLICY_VERSION =
  'agent-shadow-comparison.v1' as const;

export type ShadowAssessmentSelection =
  | {
      status: 'comparable';
      assessmentEventId: string;
      verdict: ComparableAgentVerdict;
      comparisonPolicyVersion: typeof AGENT_SHADOW_COMPARISON_POLICY_VERSION;
    }
  | {
      status: 'incomparable';
      reason: 'needs-review' | 'unanswered' | 'unassessed';
      comparisonPolicyVersion: typeof AGENT_SHADOW_COMPARISON_POLICY_VERSION;
    };

function normalizedVerdict(event: AssessmentCompletedEvent): ComparableAgentVerdict | null {
  if (event.score.status !== 'scored') return null;
  const outcome = event.score.outcome ?? event.ruleDecision.status;
  if (outcome === 'hit-with-help') return 'hit';
  if (outcome === 'hit' || outcome === 'partial' || outcome === 'miss') return outcome;
  return null;
}

export function selectShadowAssessmentAtBasis(
  sessionInput: unknown,
  config: LoadedConfig,
  nodeId: string,
  basisThroughSequence: number,
): ShadowAssessmentSelection {
  const session = sessionSchema.parse(sessionInput);
  if (
    !Number.isInteger(basisThroughSequence)
    || basisThroughSequence < 0
    || basisThroughSequence >= session.events.length
  ) {
    throw new Error(`Invalid shadow comparison basis sequence ${basisThroughSequence}`);
  }
  const events = session.events.slice(0, basisThroughSequence + 1);
  const prefix = sessionSchema.parse({
    ...session,
    updatedAt: events.at(-1)?.occurredAt ?? session.startedAt,
    events,
  });
  const node = buildLearnerProfile(prefix, config).nodes.find((entry) =>
    entry.nodeId === nodeId);
  const latestStatus = node?.latestAttempt?.status;
  if (latestStatus !== 'scored') {
    return {
      status: 'incomparable',
      reason: latestStatus === 'needs-review' || latestStatus === 'unanswered'
        ? latestStatus
        : 'unassessed',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    };
  }
  if (!node?.selectedAssessment) {
    return {
      status: 'incomparable',
      reason: 'unassessed',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    };
  }
  const assessment = prefix.events.find((event): event is AssessmentCompletedEvent =>
    event.kind === 'assessment.completed'
    && event.id === node.selectedAssessment!.eventId
    && event.sequence === node.selectedAssessment!.sequence);
  if (!assessment) {
    throw new Error(`Selected shadow assessment ${node.selectedAssessment.eventId} is missing`);
  }
  const verdict = normalizedVerdict(assessment);
  if (!verdict) {
    return {
      status: 'incomparable',
      reason: 'unassessed',
      comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
    };
  }
  return {
    status: 'comparable',
    assessmentEventId: assessment.id,
    verdict,
    comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
  };
}
