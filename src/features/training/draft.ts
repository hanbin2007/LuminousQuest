import type { ScaffoldScoreInput } from '../../../shared/scoring/scaffold';

export interface TrainingDraft {
  schemaVersion: 'training-draft.v1';
  activeCaseId: string;
  currentLevel: number;
  answers: Record<string, Record<string, string>>;
  equations: Record<string, Record<string, string>>;
  scaffoldHistory: ScaffoldScoreInput[];
}

export function emptyTrainingDraft(activeCaseId: string, currentLevel: number): TrainingDraft {
  return {
    schemaVersion: 'training-draft.v1',
    activeCaseId,
    currentLevel,
    answers: {},
    equations: {},
    scaffoldHistory: [],
  };
}

function isScaffoldHistory(value: unknown): value is ScaffoldScoreInput[] {
  return Array.isArray(value) && value.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const score = entry as Partial<ScaffoldScoreInput>;
    return typeof score.outcome === 'string'
      && typeof score.earned === 'number'
      && typeof score.possible === 'number'
      && score.assistance !== null
      && typeof score.assistance === 'object';
  });
}

export function loadTrainingDraft(
  storage: Pick<Storage, 'getItem'> | null,
  sessionId: string,
  caseIds: readonly string[],
  initialLevel: number,
) {
  const fallback = emptyTrainingDraft(caseIds[0] ?? '', initialLevel);
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(`luminous-quest:training-draft.v1:${sessionId}`);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<TrainingDraft>;
    if (
      value.schemaVersion !== 'training-draft.v1'
      || typeof value.activeCaseId !== 'string'
      || !caseIds.includes(value.activeCaseId)
      || typeof value.currentLevel !== 'number'
      || !value.answers
      || typeof value.answers !== 'object'
      || !value.equations
      || typeof value.equations !== 'object'
      || !isScaffoldHistory(value.scaffoldHistory)
    ) return fallback;
    return value as TrainingDraft;
  } catch {
    return fallback;
  }
}

export function saveTrainingDraft(
  storage: Pick<Storage, 'setItem'> | null,
  sessionId: string,
  draft: TrainingDraft,
) {
  storage?.setItem(`luminous-quest:training-draft.v1:${sessionId}`, JSON.stringify(draft));
}
