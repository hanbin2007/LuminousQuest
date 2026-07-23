import {
  sessionSchema,
  type AgentTurnCompletedEvent,
  type SessionEvent,
  type StudentSession,
} from './schema';

const studentVisibleActionNames = new Set([
  'ask_student',
  'present_question',
  'present_material',
  'focus_node',
  'end_session',
]);

export type StudentProjectionEvent = Exclude<
  SessionEvent,
  { kind: 'agent.judgment.recorded' | 'agent.divergence.changed' }
>;
export type StudentSessionProjection = Omit<StudentSession, 'events'> & {
  events: StudentProjectionEvent[];
};
export type TeacherAuditSessionProjection = StudentSession;

function isStudentVisibleEvent(event: SessionEvent) {
  return event.kind !== 'agent.judgment.recorded'
    && event.kind !== 'agent.divergence.changed';
}

function studentTurnProjection(
  event: AgentTurnCompletedEvent,
  sequence: number,
  contextThroughSequence: number,
): AgentTurnCompletedEvent {
  return {
    ...event,
    sequence,
    contextThroughSequence,
    orderedActions: event.orderedActions.filter((action) =>
      studentVisibleActionNames.has(action.name)),
  };
}

export function projectStudentSession(session: unknown): StudentSessionProjection {
  const parsed = sessionSchema.parse(session);
  const retained = parsed.events.filter(isStudentVisibleEvent);
  const sequenceByOriginal = new Map(
    retained.map((event, sequence) => [event.sequence, sequence] as const),
  );
  const projectedEvents = retained.map((event, sequence) => {
    if (event.kind !== 'agent.turn.completed') return { ...event, sequence };
    const contextEvent = [...retained].reverse().find((candidate) =>
      candidate.sequence <= event.contextThroughSequence);
    if (!contextEvent) {
      throw new Error(`Agent turn ${event.turnId} has no learner-visible context event`);
    }
    return studentTurnProjection(
      event,
      sequence,
      sequenceByOriginal.get(contextEvent.sequence)!,
    );
  });

  return sessionSchema.parse({
    ...parsed,
    events: projectedEvents,
  }) as StudentSessionProjection;
}

export function projectTeacherAuditSession(session: unknown): TeacherAuditSessionProjection {
  return sessionSchema.parse(structuredClone(session));
}
