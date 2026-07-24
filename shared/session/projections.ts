import {
  sessionSchema,
  type AgentTurnCompletedEvent,
  type AnswerSubmittedEvent,
  type AssessmentCompletedEvent,
  type PolarityAssessedEvent,
  type PolarityRevealedEvent,
  type SessionCommandExecutedEvent,
  type SessionEvent,
  type StudentSession,
  type TutorCycleStartedEvent,
  type TutorCycleTerminalEvent,
  type TutorTurnCompletedEvent,
} from './schema';
import { isAuditOnlyEvent } from './audit';

const studentVisibleActionNames = new Set([
  'ask_student',
  'present_question',
  'present_material',
  'focus_node',
  'end_session',
  'show_question_card',
  'show_case_material',
  'focus_cognitive_node',
  'end_case',
]);

type StudentEventBase = Pick<
  SessionEvent,
  | 'schemaVersion'
  | 'id'
  | 'sequence'
  | 'occurredAt'
  | 'caseId'
  | 'stageId'
  | 'attemptId'
  | 'kind'
  | 'pipelineStage'
  | 'command'
>;

function base(event: SessionEvent, sequence: number): StudentEventBase {
  return {
    schemaVersion: event.schemaVersion,
    id: event.id,
    sequence,
    occurredAt: event.occurredAt,
    caseId: event.caseId,
    stageId: event.stageId,
    attemptId: event.attemptId,
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    ...(event.command ? { command: event.command } : {}),
  };
}

function projectAnswer(event: AnswerSubmittedEvent, sequence: number) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    questionId: event.questionId,
    answer: event.answer,
    ...(event.responseToAgentTurnId
      ? { responseToAgentTurnId: event.responseToAgentTurnId }
      : {}),
    ...(event.responseContractId
      ? { responseContractId: event.responseContractId }
      : {}),
  };
}

function publicExtraction(event: AssessmentCompletedEvent) {
  return event.extraction.status === 'assessed'
    ? { status: event.extraction.status, evidence: event.extraction.evidence }
    : { status: event.extraction.status };
}

function publicRuleDecision(event: AssessmentCompletedEvent) {
  if (event.ruleDecision.status === 'unanswered') {
    return {
      status: event.ruleDecision.status,
      promptRetry: event.ruleDecision.promptRetry,
      includeInDiagnosis: event.ruleDecision.includeInDiagnosis,
    };
  }
  return 'ruleId' in event.ruleDecision
    ? {
        status: event.ruleDecision.status,
        ruleId: event.ruleDecision.ruleId,
      }
    : { status: event.ruleDecision.status };
}

function publicFollowing(event: AssessmentCompletedEvent) {
  if (
    event.following.status === 'followed'
    || event.following.status === 'not-followed'
  ) {
    return {
      status: event.following.status,
      anchorNodeId: event.following.anchorNodeId,
      anchorOutcome: event.following.anchorOutcome,
    };
  }
  return { status: event.following.status };
}

function projectAssessment(event: AssessmentCompletedEvent, sequence: number) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    sourceAnswerEventId: event.sourceAnswerEventId,
    nodeId: event.nodeId,
    ...(event.misconceptionIds
      ? { misconceptionIds: event.misconceptionIds }
      : {}),
    rubric: event.rubric,
    assistance: event.assistance,
    ...(event.objectiveOutcome
      ? { objectiveOutcome: event.objectiveOutcome }
      : {}),
    extraction: publicExtraction(event),
    ruleDecision: publicRuleDecision(event),
    following: publicFollowing(event),
    score: event.score,
  };
}

function projectPolarity(event: PolarityAssessedEvent, sequence: number) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    sourceAnswerEventId: event.sourceAnswerEventId,
    anchorId: event.anchorId,
    facts: event.facts,
    outcome: event.outcome,
    evidence: event.evidence,
  };
}

function projectReveal(event: PolarityRevealedEvent, sequence: number) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    sourcePolarityAssessmentEventId: event.sourcePolarityAssessmentEventId,
    anchorId: event.anchorId,
    values: event.values,
  };
}

function projectCommand(event: SessionCommandExecutedEvent, sequence: number) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    commandName: event.commandName,
    idempotencyKey: event.idempotencyKey,
    expectedSequence: event.expectedSequence,
    resultingSequence: event.resultingSequence,
    requestFingerprint: event.requestFingerprint,
    resultEventIds: event.resultEventIds,
  };
}

function projectTutorStarted(
  event:
    | TutorCycleStartedEvent
    | TutorTurnCompletedEvent
    | TutorCycleTerminalEvent,
  sequence: number,
) {
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    sourceAnswerEventId: event.sourceAnswerEventId,
    sourceAssessmentEventId: event.sourceAssessmentEventId,
    nodeId: event.nodeId,
    cycleId: event.cycleId,
  };
}

function projectTutorTurn(event: TutorTurnCompletedEvent, sequence: number) {
  return {
    ...projectTutorStarted(event, sequence),
    kind: event.kind,
    studentAnswer: event.studentAnswer,
    turn: event.turn,
    source: event.source,
    degraded: event.degraded,
  };
}

function projectTutorTerminal(
  event: TutorCycleTerminalEvent,
  sequence: number,
) {
  return {
    ...projectTutorStarted(event, sequence),
    kind: event.kind,
    reason: event.reason,
    content: event.content,
  };
}

function projectAgentTurn(
  event: AgentTurnCompletedEvent,
  sequence: number,
  contextThroughSequence: number,
) {
  const orderedActions = event.orderedActions.filter((action) =>
    studentVisibleActionNames.has(action.name));
  return {
    ...base(event, sequence),
    kind: event.kind,
    pipelineStage: event.pipelineStage,
    turnId: event.turnId,
    triggerEventId: event.triggerEventId,
    contextThroughSequence,
    source: event.source,
    ...(event.failureCategory
      ? { failureCategory: event.failureCategory }
      : {}),
    ...(event.providerAttempts !== undefined
      ? { providerAttempts: event.providerAttempts }
      : {}),
    orderedActions,
    terminalAction: event.terminalAction,
    ...(event.caseRunId ? { caseRunId: event.caseRunId } : {}),
    ...(event.questionRunId ? { questionRunId: event.questionRunId } : {}),
    ...(event.objectiveId ? { objectiveId: event.objectiveId } : {}),
    ...(event.compacted !== undefined ? { compacted: event.compacted } : {}),
  };
}

type AgentStateEvent = Exclude<
  Extract<SessionEvent, { pipelineStage: 'agent' }>,
  | AgentTurnCompletedEvent
  | Extract<SessionEvent, { kind: 'agent.judgment.recorded' | 'agent.divergence.changed' }>
>;

function projectAgentState(event: AgentStateEvent, sequence: number) {
  return {
    ...event,
    sequence,
    ...(event.command ? { command: event.command } : {}),
  };
}

export type StudentProjectionEvent =
  | ReturnType<typeof projectAnswer>
  | ReturnType<typeof projectAssessment>
  | ReturnType<typeof projectPolarity>
  | ReturnType<typeof projectReveal>
  | ReturnType<typeof projectCommand>
  | ReturnType<typeof projectTutorStarted>
  | ReturnType<typeof projectTutorTurn>
  | ReturnType<typeof projectTutorTerminal>
  | ReturnType<typeof projectAgentTurn>
  | ReturnType<typeof projectAgentState>;

export type StudentSessionProjection = Omit<StudentSession, 'events'> & {
  events: StudentProjectionEvent[];
};
export type TeacherAuditSessionProjection = StudentSession;

export function projectStudentSession(session: unknown): StudentSessionProjection {
  const parsed = sessionSchema.parse(session);
  const retained = parsed.events.filter((event) => !isAuditOnlyEvent(event));
  const sequenceByOriginal = new Map(
    retained.map((event, sequence) => [event.sequence, sequence] as const),
  );
  const projectedEvents = retained.map((event, sequence): StudentProjectionEvent => {
    switch (event.kind) {
      case 'answer.submitted':
        return projectAnswer(event, sequence);
      case 'assessment.completed':
        return projectAssessment(event, sequence);
      case 'polarity.assessed':
        return projectPolarity(event, sequence);
      case 'polarity.revealed':
        return projectReveal(event, sequence);
      case 'session.command.executed':
        return projectCommand(event, sequence);
      case 'tutor.cycle.started':
        return projectTutorStarted(event, sequence);
      case 'tutor.turn.completed':
        return projectTutorTurn(event, sequence);
      case 'tutor.cycle.terminal':
        return projectTutorTerminal(event, sequence);
      case 'agent.turn.completed': {
        const contextEvent = [...retained].reverse().find((candidate) =>
          candidate.sequence <= event.contextThroughSequence);
        if (!contextEvent) {
          throw new Error(`Agent turn ${event.turnId} has no learner-visible context event`);
        }
        return projectAgentTurn(
          event,
          sequence,
          sequenceByOriginal.get(contextEvent.sequence)!,
        );
      }
      case 'agent.case.started':
      case 'agent.question.started':
      case 'agent.understanding.updated':
      case 'agent.memory.recalled':
      case 'agent.question.resolved':
      case 'agent.memory.snapshot.committed':
      case 'agent.case.completed':
      case 'agent.anchor.revealed':
      case 'agent.input.pending':
      case 'agent.context.compacted':
        return projectAgentState(event, sequence);
    }
  });

  return {
    ...parsed,
    serverSequence: parsed.serverSequence ?? parsed.events.length,
    events: projectedEvents,
  };
}

function requireProjectionObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Student session projection must be an object');
  }
  return value as Record<string, any>;
}

function inflateAssessment(event: Record<string, any>) {
  const extraction = event.extraction?.status === 'assessed'
    ? {
        status: 'assessed',
        evidence: event.extraction.evidence,
        model: 'student-projection',
        provenance: {
          promptId: 'student-projection',
          promptVersion: 'student-projection.v1',
          cacheKey: `student-projection:${event.id}`,
        },
      }
    : event.extraction?.status === 'needs-review'
      ? {
          status: 'needs-review',
          reason: 'redacted from student projection',
          model: 'student-projection',
          provenance: {
            promptId: 'student-projection',
            promptVersion: 'student-projection.v1',
            cacheKey: `student-projection:${event.id}`,
          },
        }
      : {
          status: 'unassessed',
          reason: 'redacted from student projection',
          provenance: {
            promptId: 'student-projection',
            promptVersion: 'student-projection.v1',
            cacheKey: `student-projection:${event.id}`,
          },
        };
  const ruleStatus = event.ruleDecision?.status;
  const ruleDecision = ['hit', 'hit-with-help', 'partial', 'miss'].includes(ruleStatus)
    ? {
        status: ruleStatus,
        ruleId: event.ruleDecision.ruleId,
        reason: 'redacted from student projection',
        engine: { id: 'student-projection', version: 'student-projection.v1' },
      }
    : ruleStatus === 'unanswered'
      ? {
          status: 'unanswered',
          reason: 'redacted from student projection',
          promptRetry: event.ruleDecision.promptRetry,
          includeInDiagnosis: event.ruleDecision.includeInDiagnosis,
        }
      : {
          status: ruleStatus,
          reason: 'redacted from student projection',
        };
  const followingStatus = event.following?.status;
  const following = followingStatus === 'followed' || followingStatus === 'not-followed'
    ? {
        status: followingStatus,
        anchorNodeId: event.following.anchorNodeId,
        anchorOutcome: event.following.anchorOutcome,
        policy: 'score-logical-chain',
      }
    : followingStatus === 'needs-review'
      ? {
          status: 'needs-review',
          reason: 'redacted from student projection',
        }
      : { status: 'unassessed' };
  return {
    ...event,
    extraction,
    ruleDecision,
    following,
  };
}

/**
 * Restores a locally usable event shape from a student DTO. Redacted values are
 * replaced only with inert placeholders; authoritative grading always stays on
 * the server audit stream.
 */
export function inflateStudentSessionProjection(
  projection: unknown,
): StudentSession {
  const complete = sessionSchema.safeParse(projection);
  if (complete.success) return complete.data;
  const source = requireProjectionObject(projection);
  if (!Array.isArray(source.events)) {
    throw new Error('Student session projection must contain events');
  }
  const revealValues = new Map<string, { negative: string; positive: string }>();
  const sdkSessionByCaseRun = new Map<string, string>();
  source.events.forEach((candidate) => {
    const event = requireProjectionObject(candidate);
    if (event.kind === 'polarity.revealed') {
      revealValues.set(event.sourcePolarityAssessmentEventId, event.values);
    }
    if (
      event.kind === 'agent.case.started'
      && typeof event.caseRunId === 'string'
      && typeof event.sdkSessionId === 'string'
    ) {
      sdkSessionByCaseRun.set(event.caseRunId, event.sdkSessionId);
    }
  });
  const events = source.events.map((candidate) => {
    const event = requireProjectionObject(candidate);
    switch (event.kind) {
      case 'answer.submitted':
      case 'polarity.revealed':
      case 'session.command.executed':
      case 'tutor.cycle.started':
        return event;
      case 'assessment.completed':
        return inflateAssessment(event);
      case 'polarity.assessed': {
        const reveal = revealValues.get(event.id);
        return {
          ...event,
          extractedValue: event.facts
            .map((fact: { id: string; value: string }) =>
              `${fact.id}=${fact.value}`)
            .join(';'),
          correctValue: reveal
            ? `negative=${reveal.negative};positive=${reveal.positive}`
            : 'redacted=unavailable',
          engine: { id: 'student-projection', version: 'student-projection.v1' },
        };
      }
      case 'tutor.turn.completed':
        return { ...event, activeElapsedMs: 0 };
      case 'tutor.cycle.terminal': {
        return {
          ...event,
          activeElapsedMs: 0,
        };
      }
      case 'agent.turn.completed':
        return {
          ...event,
          ...(typeof event.caseRunId === 'string' && !event.sdkSessionId
            ? { sdkSessionId: sdkSessionByCaseRun.get(event.caseRunId) }
            : {}),
          requestHash: `sha256:${'0'.repeat(64)}`,
          model: 'student-projection',
          provenance: {
            adapter: 'openai-compatible',
            adapterVersion: 'student-projection.v1',
          },
        };
      case 'agent.case.started':
      case 'agent.question.started':
      case 'agent.understanding.updated':
      case 'agent.memory.recalled':
      case 'agent.question.resolved':
      case 'agent.memory.snapshot.committed':
      case 'agent.case.completed':
      case 'agent.anchor.revealed':
      case 'agent.input.pending':
      case 'agent.context.compacted':
        return event;
      default:
        throw new Error(`Unsupported student event kind ${String(event.kind)}`);
    }
  });
  return sessionSchema.parse({
    ...source,
    events,
  });
}

export function projectTeacherAuditSession(session: unknown): TeacherAuditSessionProjection {
  return sessionSchema.parse(structuredClone(session));
}
