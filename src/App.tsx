import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';

import type { LoadedConfig } from '../shared/config/schemas';
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
    hydratedSessionIds.current.add(target.id);
    sessionSyncTargetId.current = target.id;
    setSessionSyncError(null);
    if (!runtime.syncSession) return target;

    const initialExpectedSequence = sessionServerSequence(target);
    const synchronize = (expectedSequence: number, suffix = '') => runtime.syncSession!({
      session: target,
      expectedSequence,
      idempotencyKey: `sync:${reason}:${target.id}:${initialExpectedSequence}${suffix}`,
    });

    try {
      let result;
      try {
        result = await synchronize(initialExpectedSequence);
      } catch (error) {
        const actualSequence = error instanceof RuntimeHttpError
          && error.status === 409
          && error.payload
          && typeof error.payload === 'object'
          && 'error' in error.payload
          && error.payload.error === 'session-sequence-conflict'
          && 'actualSequence' in error.payload
          && typeof error.payload.actualSequence === 'number'
          ? error.payload.actualSequence
          : null;
        if (actualSequence === null) throw error;
        result = await synchronize(actualSequence, `:retry-${actualSequence}`);
      }
      const merged = mergeServerSession(target, result.session);
      setSession((current) => current.id === target.id
        ? mergeServerSession(current, result.session)
        : current);
      return merged;
    } catch (error) {
      const detail = error instanceof Error && error.message.trim()
        ? `：${error.message}`
        : '';
      if (sessionSyncTargetId.current === target.id) {
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
