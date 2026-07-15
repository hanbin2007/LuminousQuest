import {
  type AssessmentCompletedEvent,
  type SessionEventInput,
  type StudentSession,
  sessionSchema,
} from './schema';

export interface CreateSessionInput {
  id?: string;
  anonymousStudentId?: string;
  now?: string;
  configVersions: StudentSession['configVersions'];
}

export function createAnonymousStudentId() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `anon-${suffix.toUpperCase()}`;
}

export function createSession(input: CreateSessionInput): StudentSession {
  const now = input.now ?? new Date().toISOString();
  return sessionSchema.parse({
    schemaVersion: 'session.v1',
    id: input.id ?? crypto.randomUUID(),
    anonymousStudentId: input.anonymousStudentId ?? createAnonymousStudentId(),
    startedAt: now,
    updatedAt: now,
    configVersions: input.configVersions,
    events: [],
  });
}

export function appendSessionEvent(
  session: StudentSession,
  event: SessionEventInput,
): StudentSession {
  return sessionSchema.parse({
    ...session,
    updatedAt: event.occurredAt,
    events: [
      ...session.events,
      {
        ...event,
        schemaVersion: 'event.v1',
        sequence: session.events.length,
      },
    ],
  });
}

export function exportSession(session: StudentSession) {
  return `${JSON.stringify(sessionSchema.parse(session), null, 2)}\n`;
}

export function importSession(source: string) {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Session import is not valid JSON: ${(error as Error).message}`);
  }
  return sessionSchema.parse(value);
}

export interface ScoreSummary {
  earned: number;
  possible: number;
  ratio: number | null;
  assessedNodeIds: string[];
  unassessedNodeIds: string[];
}

export function summarizeAssessedScores(events: readonly unknown[]): ScoreSummary {
  const assessments: AssessmentCompletedEvent[] = [];
  for (const event of events) {
    const parsed = sessionSchema.shape.events.element.safeParse(event);
    if (parsed.success && parsed.data.kind === 'assessment.completed') {
      assessments.push(parsed.data);
    }
  }

  const assessed = assessments.filter(
    (event): event is AssessmentCompletedEvent & { score: { status: 'scored'; earned: number; possible: number } } =>
      event.score.status === 'scored',
  );
  const earned = assessed.reduce((sum, event) => sum + event.score.earned, 0);
  const possible = assessed.reduce((sum, event) => sum + event.score.possible, 0);

  return {
    earned,
    possible,
    ratio: possible === 0 ? null : earned / possible,
    assessedNodeIds: assessed.map((event) => event.nodeId),
    unassessedNodeIds: assessments
      .filter((event) => event.score.status === 'unassessed')
      .map((event) => event.nodeId),
  };
}
