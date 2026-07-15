import { useEffect, useMemo, useState } from 'react';

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
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  } catch {
    // Privacy modes can expose localStorage but throw when it is accessed.
  }
  return new MemoryStorage();
}

export function useLocalSession(config: LoadedConfig) {
  const versions = useMemo(() => sessionConfigVersions(config), [config]);
  const store = useMemo(() => new LocalSessionStore(browserStorage()), []);
  const [restored] = useState(() => store.restoreLatest(versions));
  const [session, setSession] = useState<StudentSession>(() => restored ?? createSession({
    configVersions: versions,
  }));

  useEffect(() => {
    store.save(session);
  }, [session, store]);

  return { session, setSession, restored: restored !== null, store, versions };
}
