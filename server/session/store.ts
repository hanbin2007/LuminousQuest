import type { StudentSession } from '../../shared/session/schema';

export interface ServerSessionStore {
  get(sessionId: string): StudentSession | undefined;
  set(session: StudentSession): void;
}

export class InMemorySessionStore implements ServerSessionStore {
  private readonly sessions = new Map<string, StudentSession>();

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  set(session: StudentSession) {
    this.sessions.set(session.id, session);
  }
}
