import { createContext, useContext, type Dispatch, type SetStateAction } from 'react';

import type { LoadedConfig } from '../../shared/config/schemas';
import type { StudentSession } from '../../shared/session/schema';
import type { AppRuntime, LLMExecutionMode } from '../runtime/api';

export type StageJump =
  | { module: 'pretest'; step: number }
  | { module: 'training'; caseId: string };

export interface AppContextValue {
  /** 测试阶段的手动阶段跳转(服务端 LQ_TEST_NAV=1 下发,比赛构建恒 false)。 */
  testNavigation: boolean;
  stageJump: StageJump | null;
  requestStageJump: (jump: StageJump) => void;
  consumeStageJump: () => void;
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
