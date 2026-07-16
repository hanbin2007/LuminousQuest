import { useCallback, useEffect, useState } from 'react';
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
import { PlaceholderPage } from './app/PlaceholderPage';
import { PretestPage } from './features/pretest/PretestPage';
import { TrainingPage } from './features/training/TrainingPage';
import { defaultRuntime, type AppRuntime } from './runtime/api';
import { useLocalSession } from './session/useLocalSession';

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
    }}>
      <AppErrorBoundary session={session} onReset={resetSession}>
        <BrowserRouter>
          <Routes>
          <Route element={<AppShell />}>
            <Route index element={<Navigate replace to="/pretest" />} />
            <Route path="pretest" element={<PretestPage />} />
            <Route path="training" element={<TrainingPage />} />
            <Route path="model" element={(
              <PlaceholderPage
                module="模块三"
                title="3D 思维模型外显"
                terms="装置 · 原理 · 能量"
              />
            )} />
            <Route path="teacher" element={(
              <PlaceholderPage
                module="班级证据"
                title="教师视图"
                terms="量表条目 · 学生原文 · 诊断证据"
              />
            )} />
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
