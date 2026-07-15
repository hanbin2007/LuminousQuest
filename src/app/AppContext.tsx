import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

import type { LoadedConfig } from '../../shared/config/schemas';
import type { StudentSession } from '../../shared/session/schema';
import type { AppRuntime } from '../runtime/api';

export interface AppContextValue {
  config: LoadedConfig;
  runtime: AppRuntime;
  session: StudentSession;
  setSession: Dispatch<SetStateAction<StudentSession>>;
  pretestComplete: boolean;
  setPretestComplete: (complete: boolean) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useAppContext() {
  const value = useContext(AppContext);
  if (!value) throw new Error('AppContext is not available');
  return value;
}
