import { appendSessionEvent } from '../../../shared/session/session';
import type { SessionEventInput, StudentSession } from '../../../shared/session/schema';

export function mergeServerSession(local: StudentSession, incoming: StudentSession) {
  const knownIds = new Set(local.events.map((event) => event.id));
  return incoming.events.reduce((session, event) => {
    if (knownIds.has(event.id)) return session;
    const { schemaVersion: _schemaVersion, sequence: _sequence, ...input } = event;
    knownIds.add(event.id);
    return appendSessionEvent(session, input as SessionEventInput);
  }, local);
}
