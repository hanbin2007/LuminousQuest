import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

import type { LoadedConfig } from '../../shared/config/schemas';
import type { StudentSession } from '../../shared/session/schema';
import type { AppRuntime, LLMExecutionMode } from '../runtime/api';

export interface AppContextValue {
  config: LoadedConfig;
  runtime: AppRuntime;
  session: StudentSession;
  setSession: Dispatch<SetStateAction<StudentSession>>;
  persistenceError: string | null;
  historicalSessions: StudentSession[];
  pretestComplete: boolean;
  setPretestComplete: (complete: boolean) => void;
  trainingComplete: boolean;
  setTrainingComplete: (complete: boolean) => void;
  executionMode: LLMExecutionMode;
  demoModePending: boolean;
  demoModeError: string | null;
  toggleDemoMode: () => Promise<LLMExecutionMode>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppContext is not available');
  return value;
}
