import type { LoadedConfig } from '../../shared/config/schemas';
import { buildLearnerProfile } from '../../shared/scoring/profile';
import {
  sessionSchema,
  type AssessmentCompletedEvent,
  type StudentSession,
} from '../../shared/session/schema';

export const DIAGNOSTIC_PROFILE_VERSION = 'diagnostic-profile.v1' as const;

export interface DiagnosticProfileNode {
  nodeId: string;
  status: 'scored' | 'unassessed' | 'needs-review';
  outcome?: 'hit' | 'hit-with-help' | 'partial' | 'miss';
  misconceptionIds: string[];
  evidence: Array<{
    assessmentEventId: string;
    sourceAnswerEventId: string;
    quotes: string[];
  }>;
}

export interface DiagnosticProfile {
  version: typeof DIAGNOSTIC_PROFILE_VERSION;
  sourceStage: 'pretest';
  baselineThroughSequence: number | null;
  nodes: DiagnosticProfileNode[];
}

function pretestLedger(session: StudentSession) {
  const baselineAnswerIds = new Set(
    session.events
      .filter((event) =>
        event.kind === 'answer.submitted'
        && event.caseId === 'pretest'
        && event.responseToAgentTurnId === undefined)
      .map((event) => event.id),
  );
  const retained = session.events.filter((event) =>
    (event.kind === 'answer.submitted' && baselineAnswerIds.has(event.id))
    || (
      event.kind === 'assessment.completed'
      && event.caseId === 'pretest'
      && baselineAnswerIds.has(event.sourceAnswerEventId)
    ));
  return sessionSchema.parse({
    ...session,
    updatedAt: retained.at(-1)?.occurredAt ?? session.startedAt,
    events: retained.map((event, sequence) => ({ ...event, sequence })),
  });
}

export function buildDiagnosticProfile(
  sessionInput: unknown,
  config: LoadedConfig,
): DiagnosticProfile {
  const session = sessionSchema.parse(sessionInput);
  const baselineSourceEvents = session.events.filter((event) => {
    if (event.kind === 'answer.submitted') {
      return event.caseId === 'pretest'
        && event.responseToAgentTurnId === undefined;
    }
    if (event.kind !== 'assessment.completed' || event.caseId !== 'pretest') {
      return false;
    }
    return session.events.some((candidate) =>
      candidate.kind === 'answer.submitted'
      && candidate.id === event.sourceAnswerEventId
      && candidate.responseToAgentTurnId === undefined);
  });
  const baseline = pretestLedger(session);
  const profile = buildLearnerProfile(baseline, config);
  const assessmentById = new Map(
    baseline.events
      .filter((event): event is AssessmentCompletedEvent =>
        event.kind === 'assessment.completed')
      .map((event) => [event.id, event]),
  );

  return {
    version: DIAGNOSTIC_PROFILE_VERSION,
    sourceStage: 'pretest',
    baselineThroughSequence: baselineSourceEvents.at(-1)?.sequence ?? null,
    nodes: profile.nodes.map((node) => {
      const selected = node.selectedAssessment
        ? assessmentById.get(node.selectedAssessment.eventId)
        : undefined;
      return {
        nodeId: node.nodeId,
        status: node.status,
        ...(node.outcome ? { outcome: node.outcome } : {}),
        misconceptionIds: [...new Set(selected?.misconceptionIds ?? [])].sort(),
        evidence: selected && selected.extraction.status === 'assessed'
          ? [{
              assessmentEventId: selected.id,
              sourceAnswerEventId: selected.sourceAnswerEventId,
              quotes: selected.extraction.evidence.map((entry) => entry.quote),
            }]
          : [],
      };
    }),
  };
}
