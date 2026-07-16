import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';

import type { LoadedConfig } from '../shared/config/schemas';
import { AppContext } from './app/AppContext';
import { AppErrorBoundary } from './app/AppErrorBoundary';
import { AppShell } from './app/AppShell';
import { defaultRuntime, type AppRuntime, type LLMExecutionMode } from './runtime/api';
import { useLocalSession } from './session/useLocalSession';

const PretestPage = lazy(async () => {
  const module = await import('./features/pretest/PretestPage');
  return { default: module.PretestPage };
});
const TrainingPage = lazy(async () => {
  const module = await import('./features/training/TrainingPage');
  return { default: module.TrainingPage };
});
const TeacherPage = lazy(() => import('./features/teacher/TeacherPage'));
const ModelPlaceholderPage = lazy(() => import('./features/model/ModelPlaceholderPage'));

export type { AppRuntime } from './runtime/api';

export interface AppProps {
  runtime?: AppRuntime;
  initialConfig?: LoadedConfig;
}

function ConfiguredApp({ config, runtime }: { config: LoadedConfig; runtime: AppRuntime }) {
  const {
    session,
    setSession,
    resetSession,
    persistenceError,
    historicalSessions,
  } = useLocalSession(config);
  const pretestProgressKey = `luminous-quest:pretest-complete.v1:${session.id}`;
  const trainingProgressKey = `luminous-quest:training-complete.v1:${session.id}`;
  const readProgress = (key: string) => {
    try {
      return window.localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  };
  const [pretestComplete, setStoredPretestComplete] = useState(() => readProgress(pretestProgressKey));
  const [trainingComplete, setStoredTrainingComplete] = useState(() => readProgress(trainingProgressKey));
  const [executionMode, setExecutionModeState] = useState<LLMExecutionMode>('development');
  const [demoModePending, setDemoModePending] = useState(false);
  const [demoModeError, setDemoModeError] = useState<string | null>(null);
  const previousMode = useRef<LLMExecutionMode>('development');
  const previousSession = useRef<typeof session | null>(null);

  useEffect(() => {
    let active = true;
    runtime.getRuntimeState?.()
      .then((state) => { if (active) setExecutionModeState(state.executionMode); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [runtime]);

  useEffect(() => {
    setStoredPretestComplete(readProgress(pretestProgressKey));
  }, [pretestProgressKey]);

  useEffect(() => {
    setStoredTrainingComplete(readProgress(trainingProgressKey));
  }, [trainingProgressKey]);

  const setPretestComplete = useCallback((complete: boolean) => {
    setStoredPretestComplete(complete);
    try {
      if (complete) window.localStorage.setItem(pretestProgressKey, 'true');
      else window.localStorage.removeItem(pretestProgressKey);
    } catch {
      // Session persistence already exposes the primary storage failure state.
    }
  }, [pretestProgressKey]);

  const setTrainingComplete = useCallback((complete: boolean) => {
    setStoredTrainingComplete(complete);
    try {
      if (complete) window.localStorage.setItem(trainingProgressKey, 'true');
      else window.localStorage.removeItem(trainingProgressKey);
    } catch {
      // Session persistence already exposes the primary storage failure state.
    }
  }, [trainingProgressKey]);

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
        setExecutionModeState(state.executionMode);
        return state.executionMode;
      }
      previousMode.current = executionMode;
      previousSession.current = session;
      if (!runtime.activateDemo) throw new Error('当前运行环境未提供演示回放。');
      const activated = await runtime.activateDemo();
      try {
        const pretestKey = `luminous-quest:pretest-complete.v1:${activated.session.id}`;
        const trainingKey = `luminous-quest:training-complete.v1:${activated.session.id}`;
        if (activated.progress.pretestComplete) window.localStorage.setItem(pretestKey, 'true');
        else window.localStorage.removeItem(pretestKey);
        if (activated.progress.trainingComplete) window.localStorage.setItem(trainingKey, 'true');
        else window.localStorage.removeItem(trainingKey);
      } catch {
        // The in-memory demo remains usable when browser persistence is unavailable.
      }
      setSession(activated.session);
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
  }, [executionMode, runtime, session, setSession]);

  return (
    <AppContext.Provider value={{
      config,
      runtime,
      session,
      setSession,
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
    }}>
      <AppErrorBoundary session={session} onReset={resetSession}>
        <BrowserRouter>
          <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate replace to="/pretest" />} />
            <Route path="pretest" element={<PretestPage />} />
            <Route path="training" element={<TrainingPage />} />
            <Route path="model" element={<ModelPlaceholderPage />} />
            <Route path="teacher" element={<TeacherPage />} />
            <Route path="*" element={<Navigate replace to="/pretest" />} />
          </Route>
          </Routes>
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
  return <ConfiguredApp config={config} runtime={runtime} />;
}
