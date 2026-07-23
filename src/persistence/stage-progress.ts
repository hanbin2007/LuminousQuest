import type { WorkspaceStorage } from './workspace-storage';

export interface StageProgress {
  schemaVersion: 'stage-progress.v3';
  pretestComplete: boolean;
  trainingComplete: boolean;
}

const stageProgressKey = (sessionId: string) =>
  `luminous-quest:progress.v3:${sessionId}`;

const legacyPretestKey = (sessionId: string) =>
  `luminous-quest:pretest-complete.v1:${sessionId}`;

const legacyTrainingKey = (sessionId: string) =>
  `luminous-quest:training-complete.v1:${sessionId}`;

function fallbackProgress(): StageProgress {
  return {
    schemaVersion: 'stage-progress.v3',
    pretestComplete: false,
    trainingComplete: false,
  };
}

export function readStageProgress(storage: WorkspaceStorage, sessionId: string) {
  try {
    const source = storage.getItem(stageProgressKey(sessionId));
    if (source) {
      const value = JSON.parse(source) as Partial<StageProgress>;
      if (
        value.schemaVersion === 'stage-progress.v3'
        && typeof value.pretestComplete === 'boolean'
        && typeof value.trainingComplete === 'boolean'
      ) return value as StageProgress;
    }
    const legacy = {
      schemaVersion: 'stage-progress.v3' as const,
      pretestComplete: storage.getItem(legacyPretestKey(sessionId)) === 'true',
      trainingComplete: storage.getItem(legacyTrainingKey(sessionId)) === 'true',
    };
    if (legacy.pretestComplete || legacy.trainingComplete) writeStageProgress(storage, sessionId, legacy);
    return legacy;
  } catch {
    return fallbackProgress();
  }
}

export function writeStageProgress(
  storage: WorkspaceStorage,
  sessionId: string,
  progress: Pick<StageProgress, 'pretestComplete' | 'trainingComplete'>,
) {
  const value: StageProgress = {
    schemaVersion: 'stage-progress.v3',
    pretestComplete: progress.pretestComplete,
    trainingComplete: progress.trainingComplete,
  };
  storage.transaction(() => {
    storage.setItem(stageProgressKey(sessionId), JSON.stringify(value));
    storage.removeItem(legacyPretestKey(sessionId));
    storage.removeItem(legacyTrainingKey(sessionId));
  });
}
