import type { SessionEventInput, StudentSession } from './schema';
import { appendSessionEvent, exportAuditSession, importSession } from './session';

const latestSessionKey = 'luminous-quest:session.v2:latest';
const suspendedSessionIdsKey = 'luminous-quest:session.v2:suspended';
const sessionKey = (id: string) => `luminous-quest:session.v2:${id}`;

export class SessionStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStorageError';
  }
}

export class SessionVersionMismatchError extends Error {
  constructor() {
    super('Persisted session configuration versions do not match the active content');
    this.name = 'SessionVersionMismatchError';
  }
}

export class LocalSessionStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  private readSuspendedIds() {
    const serialized = this.storage.getItem(suspendedSessionIdsKey);
    if (serialized === null) return [];
    try {
      const value: unknown = JSON.parse(serialized);
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        throw new Error('invalid suspended session index');
      }
      return [...new Set(value)];
    } catch {
      this.storage.removeItem(suspendedSessionIdsKey);
      return [];
    }
  }

  private writeSuspendedIds(ids: readonly string[]) {
    if (ids.length === 0) {
      this.storage.removeItem(suspendedSessionIdsKey);
      return;
    }
    this.storage.setItem(suspendedSessionIdsKey, JSON.stringify(ids));
  }

  private suspend(id: string) {
    try {
      this.writeSuspendedIds([id, ...this.readSuspendedIds().filter((candidate) => candidate !== id)]);
    } catch {
      // The original session remains intact even if the small history index cannot be written.
    }
  }

  save(session: StudentSession, options: { makeLatest?: boolean } = {}) {
    const serialized = exportAuditSession(session);
    const key = sessionKey(session.id);
    const previousSession = this.storage.getItem(key);
    const previousLatest = this.storage.getItem(latestSessionKey);
    const makeLatest = options.makeLatest ?? true;
    try {
      this.storage.setItem(key, serialized);
      if (makeLatest) this.storage.setItem(latestSessionKey, session.id);
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

  load(id: string, expectedVersions?: StudentSession['configVersions']) {
    const serialized = this.storage.getItem(sessionKey(id));
    if (serialized === null) return null;
    const session = importSession(serialized);
    if (
      expectedVersions
      && JSON.stringify(session.configVersions) !== JSON.stringify(expectedVersions)
    ) {
      throw new SessionVersionMismatchError();
    }
    return session;
  }

  restoreLatest(expectedVersions?: StudentSession['configVersions']) {
    const latestId = this.storage.getItem(latestSessionKey);
    if (latestId === null) return null;
    try {
      return this.load(latestId, expectedVersions);
    } catch (error) {
      if (error instanceof SessionVersionMismatchError) {
        this.suspend(latestId);
      } else {
        this.storage.removeItem(sessionKey(latestId));
      }
      this.storage.removeItem(latestSessionKey);
      return null;
    }
  }

  listSuspended() {
    const sessions: StudentSession[] = [];
    const validIds: string[] = [];
    for (const id of this.readSuspendedIds()) {
      try {
        const session = this.load(id);
        if (!session) continue;
        sessions.push(session);
        validIds.push(id);
      } catch {
        this.storage.removeItem(sessionKey(id));
      }
    }
    try {
      this.writeSuspendedIds(validIds);
    } catch {
      // Listing remains available in memory when index cleanup cannot be persisted.
    }
    return sessions;
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
    try {
      this.writeSuspendedIds(this.readSuspendedIds().filter((candidate) => candidate !== id));
    } catch {
      // Removing the session itself is the primary operation.
    }
  }
}
