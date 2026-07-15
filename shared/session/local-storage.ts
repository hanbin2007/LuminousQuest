import type { SessionEventInput, StudentSession } from './schema';
import { appendSessionEvent, exportSession, importSession } from './session';

const latestSessionKey = 'luminous-quest:session.v2:latest';
const sessionKey = (id: string) => `luminous-quest:session.v2:${id}`;

export class SessionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStorageError';
  }
}

export class LocalSessionStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  save(session: StudentSession) {
    const serialized = exportSession(session);
    const key = sessionKey(session.id);
    const previousSession = this.storage.getItem(key);
    const previousLatest = this.storage.getItem(latestSessionKey);
    try {
      this.storage.setItem(key, serialized);
      this.storage.setItem(latestSessionKey, session.id);
    } catch (error) {
      try {
        if (previousSession === null) this.storage.removeItem(key);
        else this.storage.setItem(key, previousSession);
        if (previousLatest === null) this.storage.removeItem(latestSessionKey);
        else this.storage.setItem(latestSessionKey, previousLatest);
      } catch {
        this.storage.removeItem(latestSessionKey);
      }
      throw new SessionStorageError('Unable to save session to localStorage', { cause: error });
    }
  }

  load(id: string) {
    const serialized = this.storage.getItem(sessionKey(id));
    return serialized === null ? null : importSession(serialized);
  }

  restoreLatest() {
    const latestId = this.storage.getItem(latestSessionKey);
    if (latestId === null) return null;
    try {
      return this.load(latestId);
    } catch {
      this.storage.removeItem(sessionKey(latestId));
      this.storage.removeItem(latestSessionKey);
      return null;
    }
  }

  append(id: string, event: SessionEventInput) {
    const current = this.load(id);
    if (!current) throw new Error(`Session ${id} was not found in localStorage`);
    const updated = appendSessionEvent(current, event);
    this.save(updated);
    return updated;
  }

  remove(id: string) {
    this.storage.removeItem(sessionKey(id));
    if (this.storage.getItem(latestSessionKey) === id) {
      this.storage.removeItem(latestSessionKey);
    }
  }
}
