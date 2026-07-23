import { appendSessionEvent } from '../../../shared/session/session';
import { sessionSchema, type SessionEventInput, type StudentSession } from '../../../shared/session/schema';
import {
  inflateStudentSessionProjection,
  type StudentSessionProjection,
} from '../../../shared/session/projections';

export function mergeServerSession(
  local: StudentSession,
  incoming: StudentSession | StudentSessionProjection,
) {
  const completeIncoming = inflateStudentSessionProjection(incoming);
  const knownIds = new Set(local.events.map((event) => event.id));
  const merged = completeIncoming.events.reduce((session, event) => {
    if (knownIds.has(event.id)) return session;
    const { schemaVersion: _schemaVersion, sequence: _sequence, ...input } = event;
    knownIds.add(event.id);
    return appendSessionEvent(session, input as SessionEventInput);
  }, local);
  const updatedAt = new Date(Math.max(
    Date.parse(local.updatedAt),
    Date.parse(completeIncoming.updatedAt),
    Date.parse(merged.updatedAt),
  )).toISOString();
  return sessionSchema.parse({
    ...merged,
    updatedAt,
    ...(completeIncoming.serverSequence === undefined
      ? {}
      : { serverSequence: completeIncoming.serverSequence }),
  });
}
