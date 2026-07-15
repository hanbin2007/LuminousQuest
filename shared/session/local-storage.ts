import type { SessionEventInput, StudentSession } from './schema';
import { appendSessionEvent, exportSession, importSession } from './session';

const latestSessionKey = 'luminous-quest:session.v1:latest';
const sessionKey = (id: string) => `luminous-quest:session.v1:${id}`;

export class LocalSessionStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  save(session: StudentSession) {
    const serialized = exportSession(session);
    this.storage.setItem(sessionKey(session.id), serialized);
    this.storage.setItem(latestSessionKey, session.id);
  }

  load(id: string) {
    const serialized = this.storage.getItem(sessionKey(id));
    return serialized === null ? null : importSession(serialized);
  }

  restoreLatest() {
    const latestId = this.storage.getItem(latestSessionKey);
    return latestId === null ? null : this.load(latestId);
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

