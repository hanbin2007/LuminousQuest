import type { LoadedConfig } from '../../shared/config/schemas';
import type { DemoStartState } from '../../shared/demo/start-state';
import type { StudentSession } from '../../shared/session/schema';
import { inflateStudentSessionProjection } from '../../shared/session/projections';

interface SessionCommandInput {
  expectedSequence: number;
  idempotencyKey: string;
}

export interface ExtractAssessmentInput extends SessionCommandInput {
  sessionId: string;
  caseId?: string;
  questionId: string;
  targetNodeIds: string[];
  studentAnswer: string;
  submissionId: string;
}

export interface ExtractAssessmentResult {
  session: StudentSession | null;
  status?: 'extracted' | 'needs-review' | 'deterministic' | 'already-recorded';
  source?: 'provider' | 'development-cache' | 'demo-recording' | 'fallback';
  model?: string;
  degraded?: boolean;
}

export interface EquationAssessmentInput extends SessionCommandInput {
  sessionId: string;
  caseId: string;
  equationSetId: string;
  equation: string;
  submissionId: string;
}

export interface TutorTurnInput extends SessionCommandInput {
  sessionId: string;
  nodeId: string;
  studentAnswer: string;
}

export type TutorTurnResult = {
  session: StudentSession;
  assistance: { kind: 'none' | 'socratic'; rounds: number };
  source: 'provider' | 'development-cache' | 'demo-recording' | 'preset';
  degraded: boolean;
} & (
  | { status: 'none'; reason: 'no-assessment' | 'not-miss' | 'not-tutorable' }
  | {
      status: 'respond';
      turn: { action: 'probe' | 'hint' | 'check'; content: string };
      completedRounds: number;
      finalRound: boolean;
      reason?: string;
    }
  | {
      status: 'advance';
      content: string;
      completedRounds: number;
      reason: 'max-rounds' | 'deadline';
    }
);

export interface ChoiceAssessmentInput extends SessionCommandInput {
  sessionId: string;
  questionId: string;
  optionId: string;
  submissionId: string;
}

export interface SessionSyncInput {
  session: StudentSession;
  expectedSequence: number;
  idempotencyKey: string;
}

export interface SessionSyncResult {
  status: 'hydrated' | 'already-current';
  replayed: boolean;
  sequence: number;
  session: StudentSession;
}

export interface AppRuntime {
  loadConfig: () => Promise<LoadedConfig>;
  assessChoice: (input: ChoiceAssessmentInput) => Promise<{ session: StudentSession | null }>;
  extractAssessment: (input: ExtractAssessmentInput) => Promise<ExtractAssessmentResult>;
  assessEquation: (input: EquationAssessmentInput) => Promise<{ session: StudentSession | null }>;
  tutorTurn: (input: TutorTurnInput) => Promise<TutorTurnResult>;
  reviewDrawing: (imageData: string) => Promise<string>;
  syncSession?: (input: SessionSyncInput) => Promise<SessionSyncResult>;
  getRuntimeState?: () => Promise<{ executionMode: LLMExecutionMode; testNavigation?: boolean }>;
  activateDemo?: () => Promise<{
    executionMode: 'demo';
    session: StudentSession;
    progress: { pretestComplete: boolean; trainingComplete: boolean };
    uiState: {
      version: DemoStartState['version'];
      route: DemoStartState['route'];
      pretest: DemoStartState['pretest'];
      training: DemoStartState['training'];
    };
  }>;
  setExecutionMode?: (executionMode: LLMExecutionMode) => Promise<{
    executionMode: LLMExecutionMode;
  }>;
}

export type LLMExecutionMode = 'live' | 'development' | 'demo';

declare global {
  // Injected by the integrated Hono server for protected, same-origin API calls.
  // eslint-disable-next-line no-var
  var __LQ_API_TOKEN__: string | undefined;
}

function protectedHeaders() {
  return {
    'content-type': 'application/json',
    'x-lq-api-token': globalThis.__LQ_API_TOKEN__ ?? '',
  };
}

async function jsonResponse<T>(response: Response) {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed with status ${response.status}`);
  return value;
}

export const defaultRuntime: AppRuntime = {
  async loadConfig() {
    const response = await fetch('/api/config');
    const token = response.headers.get('x-lq-api-token');
    if (token) globalThis.__LQ_API_TOKEN__ = token;
    return jsonResponse<LoadedConfig>(response);
  },

  async getRuntimeState() {
    const response = await fetch('/api/runtime');
    return jsonResponse<{ executionMode: LLMExecutionMode; testNavigation?: boolean }>(response);
  },

  async activateDemo() {
    const response = await fetch('/api/runtime/demo', {
      method: 'POST',
      headers: protectedHeaders(),
      body: '{}',
    });
    const result = await jsonResponse<{
      executionMode: 'demo';
      session: StudentSession;
      progress: { pretestComplete: boolean; trainingComplete: boolean };
      uiState: {
        version: DemoStartState['version'];
        route: DemoStartState['route'];
        pretest: DemoStartState['pretest'];
        training: DemoStartState['training'];
      };
    }>(response);
    return {
      ...result,
      session: inflateStudentSessionProjection(result.session),
    };
  },

  async setExecutionMode(executionMode) {
    const response = await fetch('/api/runtime/execution-mode', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify({ executionMode }),
    });
    return jsonResponse<{ executionMode: LLMExecutionMode }>(response);
  },

  async syncSession(input) {
    const response = await fetch('/api/session/sync', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify(input),
    });
    const result = await jsonResponse<SessionSyncResult>(response);
    return {
      ...result,
      session: inflateStudentSessionProjection(result.session),
    };
  },

  async assessChoice(input) {
    const response = await fetch('/api/assessment/choice', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify(input),
    });
    const result = await jsonResponse<{ session: StudentSession }>(response);
    return {
      ...result,
      session: result.session
        ? inflateStudentSessionProjection(result.session)
        : result.session,
    };
  },

  async extractAssessment(input) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch('/api/assessment/extract', {
        method: 'POST',
        headers: protectedHeaders(),
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      const result = await jsonResponse<ExtractAssessmentResult>(response);
      return {
        ...result,
        session: result.session
          ? inflateStudentSessionProjection(result.session)
          : null,
      };
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new Error('判分请求超时，请重试；重试不会重复记录本次作答。');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  },

  async assessEquation(input) {
    const response = await fetch('/api/assessment/equation', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify(input),
    });
    const result = await jsonResponse<{ session: StudentSession }>(response);
    return {
      ...result,
      session: result.session
        ? inflateStudentSessionProjection(result.session)
        : result.session,
    };
  },

  async tutorTurn(input) {
    const response = await fetch('/api/tutor/turn', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify(input),
    });
    const result = await jsonResponse<TutorTurnResult>(response);
    return {
      ...result,
      session: result.session
        ? inflateStudentSessionProjection(result.session)
        : result.session,
    };
  },

  async reviewDrawing(imageData) {
    const response = await fetch('/api/drawing/review', {
      method: 'POST',
      headers: protectedHeaders(),
      body: JSON.stringify({ imageData }),
    });
    const result = await jsonResponse<{ feedback: string }>(response);
    return result.feedback;
  },
};
