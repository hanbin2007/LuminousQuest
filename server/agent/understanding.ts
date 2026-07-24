import type {
  AgentEventProvenance,
  AgentVerdict,
  NormalizedAgentAction,
} from '../../shared/agent/contracts';
import {
  sessionSchema,
  type AgentJudgmentRecordedEvent,
  type AgentTurnCompletedEvent,
  type StudentSession,
} from '../../shared/session/schema';

type Conclusion = Extract<NormalizedAgentAction, { name: 'conclude_node' }>;

export interface WorkingAgentTurn {
  turnId: string;
  triggerEventId: string;
  contextThroughSequence: number;
  caseId: string;
  stageId: string;
  attemptId: string;
  provenance: AgentEventProvenance;
  actions: readonly NormalizedAgentAction[];
}

export interface AgentUnderstandingEntry {
  nodeId: string;
  verdict: AgentVerdict;
  rationale: string;
  turnId: string;
  callId: string;
  triggerEventId: string;
  basisThroughSequence: number;
  basisEventIds: string[];
  caseId: string;
  stageId: string;
  attemptId: string;
  provenance: AgentEventProvenance;
  persistence: 'working-memory' | 'committed';
  persistedEventId?: string;
  supersedesEventId?: string;
}

function conclusionFor(
  turn: Pick<AgentTurnCompletedEvent, 'orderedActions'>,
  nodeId: string,
) {
  return turn.orderedActions.find(
    (action): action is Conclusion =>
      action.name === 'conclude_node' && action.arguments.nodeId === nodeId,
  );
}

function basisEventIds(
  session: StudentSession,
  nodeId: string,
  triggerEventId: string,
  basisThroughSequence: number,
) {
  const latestAssessment = [...session.events].reverse().find(
    (event): event is Extract<
      StudentSession['events'][number],
      { kind: 'assessment.completed' }
    > =>
      event.kind === 'assessment.completed'
      && event.nodeId === nodeId
      && event.sequence <= basisThroughSequence,
  );
  return [...new Set([
    triggerEventId,
    ...(latestAssessment
      ? [latestAssessment.sourceAnswerEventId, latestAssessment.id]
      : []),
  ])].filter((eventId) => {
    const event = session.events.find((candidate) => candidate.id === eventId);
    return Boolean(event && event.sequence <= basisThroughSequence);
  });
}

function fromTurn(
  session: StudentSession,
  turn: WorkingAgentTurn,
  conclusion: Conclusion,
  previous?: AgentUnderstandingEntry,
): AgentUnderstandingEntry {
  return {
    nodeId: conclusion.arguments.nodeId,
    verdict: conclusion.arguments.verdict,
    rationale: conclusion.arguments.rationale,
    turnId: turn.turnId,
    callId: conclusion.callId,
    triggerEventId: turn.triggerEventId,
    basisThroughSequence: turn.contextThroughSequence,
    basisEventIds: basisEventIds(
      session,
      conclusion.arguments.nodeId,
      turn.triggerEventId,
      turn.contextThroughSequence,
    ),
    caseId: turn.caseId,
    stageId: turn.stageId,
    attemptId: turn.attemptId,
    provenance: turn.provenance,
    persistence: 'working-memory',
    ...(previous?.persistedEventId
      ? { supersedesEventId: previous.persistedEventId }
      : previous?.supersedesEventId
        ? { supersedesEventId: previous.supersedesEventId }
        : {}),
  };
}

function fromCommitted(
  turn: AgentTurnCompletedEvent,
  judgment: AgentJudgmentRecordedEvent,
): AgentUnderstandingEntry {
  const conclusion = conclusionFor(turn, judgment.nodeId);
  if (!conclusion) {
    throw new Error(`Committed Agent judgment ${judgment.id} has no matching conclusion`);
  }
  return {
    nodeId: judgment.nodeId,
    verdict: judgment.verdict,
    rationale: judgment.rationale,
    turnId: judgment.turnId,
    callId: conclusion.callId,
    triggerEventId: turn.triggerEventId,
    basisThroughSequence: judgment.basisThroughSequence,
    basisEventIds: judgment.basisEventIds,
    caseId: judgment.caseId,
    stageId: judgment.stageId,
    attemptId: judgment.attemptId,
    provenance: judgment.provenance,
    persistence: 'committed',
    persistedEventId: judgment.id,
    ...(judgment.supersedesEventId
      ? { supersedesEventId: judgment.supersedesEventId }
      : {}),
  };
}

export function latestAgentUnderstanding(
  sessionInput: unknown,
  currentTurn?: WorkingAgentTurn,
) {
  const session = sessionSchema.parse(sessionInput);
  const turns = new Map<string, AgentTurnCompletedEvent>();
  const latest = new Map<string, AgentUnderstandingEntry>();

  for (const event of session.events) {
    if (event.kind === 'agent.turn.completed') {
      turns.set(event.turnId, event);
      for (const action of event.orderedActions) {
        if (action.name !== 'conclude_node') continue;
        latest.set(
          action.arguments.nodeId,
          fromTurn(session, {
            turnId: event.turnId,
            triggerEventId: event.triggerEventId,
            contextThroughSequence: event.contextThroughSequence,
            caseId: event.caseId,
            stageId: event.stageId,
            attemptId: event.attemptId,
            provenance: event.provenance,
            actions: event.orderedActions,
          }, action, latest.get(action.arguments.nodeId)),
        );
      }
      continue;
    }
    if (event.kind === 'agent.judgment.recorded') {
      const turn = turns.get(event.turnId);
      if (turn) latest.set(event.nodeId, fromCommitted(turn, event));
    }
  }

  if (currentTurn) {
    for (const action of currentTurn.actions) {
      if (action.name !== 'conclude_node') continue;
      latest.set(
        action.arguments.nodeId,
        fromTurn(session, currentTurn, action, latest.get(action.arguments.nodeId)),
      );
    }
  }

  return [...latest.values()].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId));
}
