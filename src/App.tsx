import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import developmentPretestSessionSource from '../recordings/development/pretest-ready.json';
import type { LoadedConfig } from '../shared/config/schemas';
import { buildLearnerProfile } from '../shared/scoring/profile';
import { importSession } from '../shared/session/session';
import { sessionServerSequence } from '../shared/session/sync';
import { createAgentActivityRuntime } from './agent/agent-activity';
import {
  AgentActivityProvider,
  useAgentActivityActions,
} from './agent/AgentActivityContext';
import { AppRoutes } from './app/AppRoutes';
import { AppContext } from './app/AppContext';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { savePretestDraft } from './features/pretest/draft';
import { mergeServerSession } from './features/pretest/session-merge';
import { saveDemoTrainingStart } from './features/training/draft';
import {
  readStageProgress,
  writeStageProgress,
  type StageProgress,
} from './persistence/stage-progress';
import { getWorkspaceStorage } from './persistence/workspace-storage';
import {
  defaultRuntime,
  RuntimeHttpError,
  type AppRuntime,
  type LLMExecutionMode,
} from './runtime/api';
import { useLocalSession } from './session/useLocalSession';

const demoPreviousModeKey = 'luminous-quest:demo.v1:previous-mode';
type DemoActivation = Awaited<ReturnType<NonNullable<AppRuntime['activateDemo']>>>;

function runtimeConflictPayload(error: unknown, kind: string) {
  if (
    error instanceof RuntimeHttpError
    && error.status === 409
    && error.payload
    && typeof error.payload === 'object'
    && 'error' in error.payload
    && error.payload.error === kind
  ) {
    return error.payload as Record<string, unknown>;
  }
  return null;
}

export type { AppRuntime } from './runtime/api';

export interface AppProps {
  runtime?: AppRuntime;
  initialConfig?: LoadedConfig;
}

function ConfiguredApp({ config, runtime: baseRuntime }: { config: LoadedConfig; runtime: AppRuntime }) {
  const activity = useAgentActivityActions();
  const runtime = useMemo(
    () => createAgentActivityRuntime(baseRuntime, activity),
    [activity, baseRuntime],
  );
  const {
    session,
    setSession,
    setTransientSession,
    resetSession,
    persistenceError,
    historicalSessions,
  } = useLocalSession(config);
  const workspaceStorage = useMemo(() => getWorkspaceStorage(), []);
  const [progress, setProgress] = useState<StageProgress>(() =>
    readStageProgress(workspaceStorage, session.id));
  const { pretestComplete, trainingComplete } = progress;
  const [executionMode, setExecutionModeState] = useState<LLMExecutionMode>('development');
  const [testNavigation, setTestNavigation] = useState(false);
  const [demoModePending, setDemoModePending] = useState(false);
  const [demoModeError, setDemoModeError] = useState<string | null>(null);
  const [sessionSyncError, setSessionSyncError] = useState<string | null>(null);
  const hydratedSessionIds = useRef(new Set<string>());
  const sessionSyncTargetId = useRef<string | null>(null);
  const previousMode = useRef<LLMExecutionMode>('development');
  const previousSession = useRef<typeof session | null>(null);

  const saveDemoPageState = (activated: DemoActivation) => {
    savePretestDraft(workspaceStorage, activated.session.id, {
      step: config.pretest.questions.length + 1,
      builder: { components: [], connections: [] },
      answers: {},
    });
    saveDemoTrainingStart(workspaceStorage, activated.session.id, activated.uiState.training);
  };

  useEffect(() => {
    let active = true;
    runtime.getRuntimeState?.()
      .then(async (state) => {
        if (!active) return;
        setTestNavigation(state.testNavigation === true);
        if (state.executionMode !== 'demo' || !runtime.activateDemo) {
          setExecutionModeState(state.executionMode);
          return;
        }
        previousSession.current = session;
        try {
          const persistedMode = workspaceStorage.getItem(demoPreviousModeKey);
          previousMode.current = persistedMode === 'live' || persistedMode === 'development'
            ? persistedMode
            : 'development';
        } catch {
          previousMode.current = 'development';
        }
        const activated = await runtime.activateDemo();
        if (!active) return;
        try {
          saveDemoPageState(activated);
          writeStageProgress(workspaceStorage, activated.session.id, activated.progress);
        } catch {
          // The versioned server state still initializes the in-memory demo session.
        }
        hydratedSessionIds.current.add(activated.session.id);
        sessionSyncTargetId.current = activated.session.id;
        setSessionSyncError(null);
        setTransientSession(activated.session);
        setExecutionModeState(activated.executionMode);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [runtime, workspaceStorage]);

  useEffect(() => {
    setProgress(readStageProgress(workspaceStorage, session.id));
  }, [session.id, workspaceStorage]);

  useEffect(() => workspaceStorage.subscribe(() => {
    setProgress(readStageProgress(workspaceStorage, session.id));
  }), [session.id, workspaceStorage]);

  const hydrateSession = useCallback(async (
    target: typeof session,
    reason: 'startup' | 'import' | 'recovery' = 'recovery',
  ) => {
    const requestedSessionId = target.id;
    let activeSyncTargetId = target.id;
    hydratedSessionIds.current.add(target.id);
    sessionSyncTargetId.current = target.id;
    setSessionSyncError(null);
    if (!runtime.syncSession) return target;

    // 每次尝试独立 key:sync 是前缀调和,天然幂等;跨启动复用同 key 会因
    // 会话内容漂移(updatedAt 等)触发服务端指纹冲突,把会话锁死在 409。
    const attemptNonce = crypto.randomUUID();
    const synchronize = async (
      candidate: typeof target,
      expectedSequence: number,
      attemptLabel: string,
    ) => {
      const send = (sequence: number, suffix = '') => runtime.syncSession!({
        session: candidate,
        expectedSequence: sequence,
        idempotencyKey:
          `sync:${reason}:${attemptLabel}:${attemptNonce}${suffix}`,
      });
      try {
        return await send(expectedSequence);
      } catch (error) {
        const conflict = runtimeConflictPayload(error, 'session-sequence-conflict');
        const actualSequence = typeof conflict?.actualSequence === 'number'
          ? conflict.actualSequence
          : null;
        if (actualSequence === null) throw error;
        return send(actualSequence, `:retry-${actualSequence}`);
      }
    };

    try {
      let candidate = target;
      let result;
      try {
        result = await synchronize(
          candidate,
          sessionServerSequence(candidate),
          'primary',
        );
      } catch (error) {
        if (!runtimeConflictPayload(error, 'session-prefix-conflict')) throw error;
        candidate = importSession(JSON.stringify({
          ...target,
          id: `recovered-${crypto.randomUUID()}`,
          serverSequence: 0,
        }));
        hydratedSessionIds.current.add(candidate.id);
        activeSyncTargetId = candidate.id;
        sessionSyncTargetId.current = candidate.id;
        result = await synchronize(candidate, 0, 'fork');
      }
      const merged = mergeServerSession(candidate, result.session);
      setSession((current) => {
        if (current.id === candidate.id) {
          return mergeServerSession(current, result.session);
        }
        return current.id === requestedSessionId ? merged : current;
      });
      return merged;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? `：${error.message}`
        : '';
      if (sessionSyncTargetId.current === activeSyncTargetId) {
        setSessionSyncError(`会话同步失败，本机记录仍可查看${detail}`);
      }
      return target;
    }
  }, [runtime, setSession]);

  useEffect(() => {
    if (!runtime.syncSession || hydratedSessionIds.current.has(session.id)) return;
    void hydrateSession(session, 'startup');
  }, [hydrateSession, runtime.syncSession, session]);

  const updateProgress = useCallback((update: Partial<Pick<
    StageProgress,
    'pretestComplete' | 'trainingComplete'
  >>) => {
    try {
      const current = readStageProgress(workspaceStorage, session.id);
      const next = { ...current, ...update };
      if (
        next.pretestComplete === current.pretestComplete
        && next.trainingComplete === current.trainingComplete
      ) {
        return;
      }
      writeStageProgress(workspaceStorage, session.id, next);
      setProgress(next);
    } catch {
      // Session persistence already exposes the primary storage failure state.
    }
  }, [session.id, workspaceStorage]);

  const setPretestComplete = useCallback((complete: boolean) => {
    updateProgress({ pretestComplete: complete });
  }, [updateProgress]);

  const setTrainingComplete = useCallback((complete: boolean) => {
    updateProgress({ trainingComplete: complete });
  }, [updateProgress]);

  const toggleDemoMode = useCallback(async () => {
    setDemoModePending(true);
    setDemoModeError(null);
    try {
      if (executionMode === 'demo') {
        const target = previousMode.current === 'demo' ? 'development' : previousMode.current;
        const state = runtime.setExecutionMode
          ? await runtime.setExecutionMode(target)
          : { executionMode: target };
        if (previousSession.current) {
          setSession(previousSession.current);
          previousSession.current = null;
        }
        try {
          workspaceStorage.removeItem(demoPreviousModeKey);
        } catch {
          // The server mode and in-memory session still restore correctly.
        }
        setExecutionModeState(state.executionMode);
        return state.executionMode;
      }
      previousMode.current = executionMode;
      previousSession.current = session;
      try {
        workspaceStorage.setItem(demoPreviousModeKey, executionMode);
      } catch {
        // In-memory refs preserve the same-tab exit path.
      }
      if (!runtime.activateDemo) throw new Error('当前运行环境未提供演示回放。');
      const activated = await runtime.activateDemo();
      try {
        saveDemoPageState(activated);
        writeStageProgress(workspaceStorage, activated.session.id, activated.progress);
      } catch {
        // The in-memory demo remains usable when browser persistence is unavailable.
      }
      hydratedSessionIds.current.add(activated.session.id);
      sessionSyncTargetId.current = activated.session.id;
      setSessionSyncError(null);
      setTransientSession(activated.session);
      setExecutionModeState(activated.executionMode);
      return activated.executionMode;
    } catch (error) {
      previousSession.current = null;
      const message = error instanceof Error ? error.message : '演示模式切换失败';
      setDemoModeError(message);
      throw error;
    } finally {
      setDemoModePending(false);
    }
  }, [executionMode, runtime, session, setSession, setTransientSession, workspaceStorage]);

  const activateDevelopmentPretest = useCallback(async () => {
    if (!testNavigation) throw new Error('调试前测仅在 LQ_TEST_NAV=1 时可用');
    const fixture = importSession(JSON.stringify(developmentPretestSessionSource));
    if (JSON.stringify(fixture.configVersions) !== JSON.stringify(session.configVersions)) {
      throw new Error('调试前测数据与当前配置版本不匹配');
    }
    buildLearnerProfile(fixture, config);
    const developmentSession = {
      ...fixture,
      id: `development-${crypto.randomUUID()}`,
      anonymousStudentId: session.anonymousStudentId,
    };
    const nextProgress = {
      schemaVersion: 'stage-progress.v3' as const,
      pretestComplete: true,
      trainingComplete: false,
    };
    writeStageProgress(workspaceStorage, developmentSession.id, nextProgress);
    setProgress(nextProgress);
    setSession(developmentSession);
    const hydrated = await hydrateSession(developmentSession, 'import');
    setSession(hydrated);
    setProgress(nextProgress);
    return hydrated;
  }, [
    config,
    hydrateSession,
    session.configVersions,
    setSession,
    testNavigation,
    workspaceStorage,
  ]);

  return (
    <AppContext.Provider value={{
      config,
      runtime,
      session,
      setSession,
      hydrateSession,
      sessionSyncError,
      persistenceError,
      historicalSessions,
      pretestComplete,
      setPretestComplete,
      trainingComplete,
      setTrainingComplete,
      executionMode,
      demoModePending,
      demoModeError,
      toggleDemoMode,
      testNavigation,
      activateDevelopmentPretest,
    }}>
      <AppErrorBoundary session={session} onReset={resetSession}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AppErrorBoundary>
    </AppContext.Provider>
  );
}

export function App({ runtime = defaultRuntime, initialConfig }: AppProps) {
  const [config, setConfig] = useState<LoadedConfig | null>(initialConfig ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialConfig) return;
    let active = true;
    runtime.loadConfig()
      .then((value) => { if (active) setConfig(value); })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : '配置载入失败');
      });
    return () => { active = false; };
  }, [initialConfig, runtime]);

  if (error) return <main className="fatal-state"><h1>无法载入课程配置</h1><p>{error}</p></main>;
  if (!config) return <main className="loading-state" aria-label="课程配置载入中" />;
  return (
    <AgentActivityProvider>
      <ConfiguredApp config={config} runtime={runtime} />
    </AgentActivityProvider>
  );
}
