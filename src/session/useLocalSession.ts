import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedConfig } from '../../shared/config/schemas';
import { LocalSessionStore } from '../../shared/session/local-storage';
import { createSession, sessionConfigVersions } from '../../shared/session/session';
import type { StudentSession } from '../../shared/session/schema';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function browserStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.getItem('luminous-quest:storage-probe');
      return window.localStorage;
    }
  } catch {
    // Privacy modes can expose localStorage but throw when it is accessed.
  }
  return new MemoryStorage();
}

export function useLocalSession(config: LoadedConfig) {
  const versions = useMemo(() => sessionConfigVersions(config), [config]);
  const store = useMemo(() => new LocalSessionStore(browserStorage()), []);
  const [restored] = useState(() => store.restoreLatest(versions));
  const [historicalSessions] = useState(() => store.listSuspended());
  const [session, setSession] = useState<StudentSession>(() => restored ?? createSession({
    configVersions: versions,
  }));
  const transientSessionIds = useRef(new Set<string>());
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  useEffect(() => {
    try {
      store.save(session, { makeLatest: !transientSessionIds.current.has(session.id) });
      setPersistenceError(null);
    } catch {
      setPersistenceError('本地保存失败，请导出会话。');
    }
  }, [session, store]);

  const resetSession = () => {
    transientSessionIds.current.delete(session.id);
    store.remove(session.id);
    try {
      window.localStorage.removeItem(`luminous-quest:pretest-ui.v1:${session.id}`);
      window.localStorage.removeItem(`luminous-quest:pretest-complete.v1:${session.id}`);
    } catch {
      // Reset still replaces the in-memory session when storage is unavailable.
    }
    setSession(createSession({ configVersions: versions }));
    setPersistenceError(null);
  };

  const setTransientSession = (next: StudentSession) => {
    transientSessionIds.current.add(next.id);
    setSession(next);
  };

  return {
    session,
    setSession,
    setTransientSession,
    resetSession,
    persistenceError,
    historicalSessions,
    restored: restored !== null,
    store,
    versions,
  };
}
