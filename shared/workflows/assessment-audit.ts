import type {
  AssessmentCompletedEvent,
  StudentSession,
} from '../session/schema';
import { appendSessionEvent } from '../session/session';

export const assessmentComparisonPolicyVersion = 'assessment-comparison.v1';

type AuditVerdict = 'hit' | 'partial' | 'miss' | 'unanswered' | 'needs-review';

function normalizedVerdict(event: AssessmentCompletedEvent): AuditVerdict {
  if (event.score.status === 'scored') {
    const outcome = event.score.outcome ?? event.ruleDecision.status;
    if (outcome === 'hit-with-help') return 'hit';
    if (outcome === 'hit' || outcome === 'partial' || outcome === 'miss') {
      return outcome;
    }
    return 'needs-review';
  }
  if (event.score.status === 'unanswered') return 'unanswered' as const;
  return 'needs-review' as const;
}

function rationale(event: AssessmentCompletedEvent) {
  if ('reason' in event.ruleDecision) return event.ruleDecision.reason;
  if ('reason' in event.extraction) return event.extraction.reason;
  return 'Existing assessment pipeline produced this audit verdict.';
}

function provenance(event: AssessmentCompletedEvent) {
  return {
    promptId: event.extraction.provenance.promptId,
    promptVersion: event.extraction.provenance.promptVersion,
    cacheKey: event.extraction.provenance.cacheKey,
    model: event.extraction.status === 'unassessed'
      ? event.extraction.model ?? 'deterministic-audit'
      : event.extraction.model,
  };
}

function engine(event: AssessmentCompletedEvent) {
  return 'engine' in event.ruleDecision
    ? {
        id: event.ruleDecision.engine.id,
        version: event.ruleDecision.engine.version,
      }
    : {
        id: 'existing-assessment-audit',
        version: 'existing-assessment-audit.v1',
      };
}

export function appendAssessmentAudit(input: {
  session: StudentSession;
  auditSession: StudentSession;
  sourceAnswerEventId: string;
  questionId: string;
  targetNodeIds: readonly string[];
  eventIdPrefix: string;
  occurredAt: string;
}) {
  const answer = input.session.events.find((event) =>
    event.kind === 'answer.submitted' && event.id === input.sourceAnswerEventId);
  if (!answer || answer.kind !== 'answer.submitted') {
    throw new Error('Assessment audit requires its primary answer event');
  }
  const auditByNode = new Map<string, AssessmentCompletedEvent[]>();
  input.auditSession.events.forEach((event) => {
    if (event.kind !== 'assessment.completed') return;
    const events = auditByNode.get(event.nodeId) ?? [];
    events.push(event);
    auditByNode.set(event.nodeId, events);
  });
  const primaryByNode = new Map<string, AssessmentCompletedEvent>();
  input.session.events.forEach((event) => {
    if (
      event.kind === 'assessment.completed'
      && event.sourceAnswerEventId === input.sourceAnswerEventId
    ) {
      primaryByNode.set(event.nodeId, event);
    }
  });

  let session = input.session;
  const comparisons: Array<{
    index: number;
    nodeId: string;
    auditEventId: string;
    primary: AssessmentCompletedEvent;
    primaryVerdict: 'hit' | 'partial' | 'miss';
    auditVerdict: 'hit' | 'partial' | 'miss';
  }> = [];
  input.targetNodeIds.forEach((nodeId, index) => {
    const auditCandidates = auditByNode.get(nodeId) ?? [];
    const auditEventId = `${input.eventIdPrefix}-assessment-${index + 1}`;
    const audit = auditCandidates.length === 1 ? auditCandidates[0]! : null;
    const auditVerdict = audit ? normalizedVerdict(audit) : 'needs-review';
    session = appendSessionEvent(session, {
      id: auditEventId,
      occurredAt: input.occurredAt,
      kind: 'assessment.audit.completed',
      pipelineStage: 'audit',
      caseId: answer.caseId,
      stageId: answer.stageId,
      attemptId: answer.attemptId,
      sourceAnswerEventId: answer.id,
      questionId: input.questionId,
      nodeId,
      verdict: auditVerdict,
      ...(audit?.misconceptionIds?.length
        ? { misconceptionIds: audit.misconceptionIds }
        : {}),
      rationale: audit
        ? rationale(audit)
        : `Existing assessment audit produced ${auditCandidates.length} results for ${nodeId}.`,
      evidence: audit?.extraction.status === 'assessed'
        ? audit.extraction.evidence
        : [],
      engine: audit
        ? engine(audit)
        : {
            id: 'existing-assessment-audit',
            version: 'existing-assessment-audit.v1',
          },
      provenance: audit
        ? provenance(audit)
        : {
            promptId: 'assessment-audit',
            promptVersion: 'assessment-audit.v1',
            cacheKey: `deterministic:${input.eventIdPrefix}:${nodeId}:invalid-cardinality`,
            model: 'audit-fallback',
          },
    });

    const primary = primaryByNode.get(nodeId);
    if (!primary) throw new Error(`Primary direct assessment did not cover node ${nodeId}`);
    const primaryVerdict = normalizedVerdict(primary);
    if (
      (primaryVerdict === 'hit' || primaryVerdict === 'partial' || primaryVerdict === 'miss')
      && (auditVerdict === 'hit' || auditVerdict === 'partial' || auditVerdict === 'miss')
    ) {
      comparisons.push({
        index,
        nodeId,
        auditEventId,
        primary,
        primaryVerdict,
        auditVerdict,
      });
    }
  });
  comparisons.forEach((comparison) => {
    session = appendSessionEvent(session, {
      id: `${input.eventIdPrefix}-divergence-${comparison.index + 1}`,
      occurredAt: input.occurredAt,
      kind: 'assessment.divergence.changed',
      pipelineStage: 'audit',
      caseId: answer.caseId,
      stageId: answer.stageId,
      attemptId: answer.attemptId,
      sourceAnswerEventId: answer.id,
      nodeId: comparison.nodeId,
      primaryAssessmentEventId: comparison.primary.id,
      auditEventId: comparison.auditEventId,
      primaryVerdict: comparison.primaryVerdict,
      auditVerdict: comparison.auditVerdict,
      status: comparison.primaryVerdict === comparison.auditVerdict ? 'matched' : 'detected',
      comparisonPolicyVersion: assessmentComparisonPolicyVersion,
    });
  });
  return session;
}
