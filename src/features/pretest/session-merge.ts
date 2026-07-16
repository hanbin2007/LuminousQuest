import { appendSessionEvent } from '../../../shared/session/session';
import { sessionSchema, type SessionEventInput, type StudentSession } from '../../../shared/session/schema';

export function mergeServerSession(local: StudentSession, incoming: StudentSession) {
  const knownIds = new Set(local.events.map((event) => event.id));
  const merged = incoming.events.reduce((session, event) => {
    if (knownIds.has(event.id)) return session;
    const { schemaVersion: _schemaVersion, sequence: _sequence, ...input } = event;
    knownIds.add(event.id);
    return appendSessionEvent(session, input as SessionEventInput);
  }, local);
  const updatedAt = new Date(Math.max(
    Date.parse(local.updatedAt),
    Date.parse(incoming.updatedAt),
    Date.parse(merged.updatedAt),
  )).toISOString();
  return sessionSchema.parse({ ...merged, updatedAt });
}
