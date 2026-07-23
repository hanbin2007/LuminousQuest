import { useEffect, useMemo, useRef, useState } from 'react';

import type { LoadedConfig } from '../../shared/config/schemas';
import { LocalSessionStore } from '../../shared/session/local-storage';
import { createSession, sessionConfigVersions } from '../../shared/session/session';
import type { StudentSession } from '../../shared/session/schema';
import { getWorkspaceStorage, removeSessionWorkspaceState } from '../persistence/workspace-storage';

export function useLocalSession(config: LoadedConfig) {
  const versions = useMemo(() => sessionConfigVersions(config), [config]);
  const workspaceStorage = useMemo(() => getWorkspaceStorage(), []);
  const store = useMemo(() => new LocalSessionStore(workspaceStorage), [workspaceStorage]);
  const [restored] = useState(() => store.restoreLatest(versions));
  const [historicalSessions, setHistoricalSessions] = useState(() => store.listSuspended());
  const [session, setSession] = useState<StudentSession>(() => restored ?? createSession({
    configVersions: versions,
  }));
  const transientSessionIds = useRef(new Set<string>());
  const saving = useRef(false);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);

  useEffect(() => {
    try {
      saving.current = true;
      workspaceStorage.transaction(() => {
        store.save(session, { makeLatest: !transientSessionIds.current.has(session.id) });
      });
      setPersistenceError(null);
    } catch {
      setPersistenceError('本地保存失败，请导出会话。');
    } finally {
      saving.current = false;
    }
  }, [session, store, workspaceStorage]);

  useEffect(() => workspaceStorage.subscribe(() => {
    if (saving.current) return;
    const next = store.restoreLatest(versions);
    if (next) {
      setSession((current) => (
        current.id === next.id
        && current.updatedAt === next.updatedAt
        && current.events.length === next.events.length
          ? current
          : next
      ));
    }
    setHistoricalSessions(store.listSuspended());
  }), [store, versions, workspaceStorage]);

  const resetSession = () => {
    transientSessionIds.current.delete(session.id);
    workspaceStorage.transaction(() => {
      store.remove(session.id);
      removeSessionWorkspaceState(session.id);
    });
    setHistoricalSessions(store.listSuspended());
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
