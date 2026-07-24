import type { LoadedConfig } from '../../shared/config/schemas';
import type { DemoStartState } from '../../shared/demo/start-state';
import type {
  AgentAnswerSubmission,
  StudentSession,
} from '../../shared/session/schema';
import { inflateStudentSessionProjection } from '../../shared/session/projections';

interface SessionCommandInput {
  expectedSequence: number;
  idempotencyKey: string;
}

interface HydratableSessionCommandInput extends SessionCommandInput {
  session?: StudentSession;
}

export interface ExtractAssessmentInput extends HydratableSessionCommandInput {
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
  assessmentSummary?: {
    scoredCount: number;
    needsReviewCount: number;
  };
}

export interface EquationAssessmentInput extends HydratableSessionCommandInput {
  sessionId: string;
  caseId: string;
  equationSetId: string;
  equation: string;
  submissionId: string;
}

export interface TutorTurnInput extends HydratableSessionCommandInput {
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

export interface ChoiceAssessmentInput extends HydratableSessionCommandInput {
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

export interface AgentTurnInput extends SessionCommandInput {
  session: StudentSession;
  sessionId: string;
  caseId: string;
  triggerEventId: string;
}

export interface AgentTurnResult {
  status: 'completed' | 'already-completed';
  turnId: string;
  degraded: boolean;
  failureCategory?: string;
  session: StudentSession;
}

export interface AgentAnswerInput extends SessionCommandInput {
  session: StudentSession;
  sessionId: string;
  turnId: string;
  answer: AgentAnswerSubmission['answer'];
}

export interface AgentAnswerResult {
  status: 'recorded' | 'already-recorded';
  assessmentStatus?:
    | 'choice-assessed'
    | 'text-assessed'
    | 'equation-assessed'
    | 'builder-assessed'
    | 'unassessed';
  nextTurnId: string;
  degraded: boolean;
  failureCategory?: string;
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
  runAgentTurn?: (input: AgentTurnInput) => Promise<AgentTurnResult>;
  submitAgentAnswer?: (input: AgentAnswerInput) => Promise<AgentAnswerResult>;
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

export class RuntimeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
  ) {
    super(message);
    this.name = 'RuntimeHttpError';
  }
}

async function jsonResponse<T>(response: Response) {
  const value = await response.json() as T & { error?: string };
  if (!response.ok) {
    throw new RuntimeHttpError(
      value.error ?? `Request failed with status ${response.status}`,
      response.status,
      value,
    );
  }
  return value;
}

async function syncSessionRequest(input: SessionSyncInput) {
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
}

async function hydrateMissingSession(session: StudentSession, idempotencyKey: string) {
  try {
    return await syncSessionRequest({
      session,
      expectedSequence: 0,
      idempotencyKey,
    });
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
    return syncSessionRequest({
      session,
      expectedSequence: actualSequence,
      idempotencyKey: `${idempotencyKey}:retry-${actualSequence}`,
    });
  }
}

async function postSessionCommand<
  T,
  TInput extends HydratableSessionCommandInput,
>(
  path: string,
  input: TInput,
  requestInit: Pick<RequestInit, 'signal'> = {},
) {
  const { session, ...command } = input;
  const send = (body: unknown) => fetch(path, {
    method: 'POST',
    headers: protectedHeaders(),
    body: JSON.stringify(body),
    ...requestInit,
  });

  let response = await send(command);
  if (response.status === 404 && session) {
    const synchronized = await hydrateMissingSession(
      session,
      `hydrate:${input.idempotencyKey}`,
    );
    response = await send({
      ...command,
      expectedSequence: synchronized.sequence,
    });
  }
  return jsonResponse<T>(response);
}

async function postAgentCommand<T extends { session: StudentSession }>(
  path: '/api/agent/turn' | '/api/agent/answer',
  input: AgentTurnInput | AgentAnswerInput,
) {
  const result = await postSessionCommand<T, AgentTurnInput | AgentAnswerInput>(
    path,
    input,
  );
  return {
    ...result,
    session: inflateStudentSessionProjection(result.session),
  };
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
    return syncSessionRequest(input);
  },

  async runAgentTurn(input) {
    return postAgentCommand<AgentTurnResult>('/api/agent/turn', input);
  },

  async submitAgentAnswer(input) {
    return postAgentCommand<AgentAnswerResult>('/api/agent/answer', input);
  },

  async assessChoice(input) {
    const result = await postSessionCommand<
      { session: StudentSession },
      ChoiceAssessmentInput
    >('/api/assessment/choice', input);
    return {
      ...result,
      session: result.session
        ? inflateStudentSessionProjection(result.session)
        : result.session,
    };
  },

  async extractAssessment(input) {
    const controller = new AbortController();
    // 判分链路含 LLM 抽取与校验重试:claude-agent 开发通道 P95≈92s、含重试可达
    // 数分钟;服务端超时(LLM_TIMEOUT_MS)才是权威上限,客户端只兜底更长的窗口。
    const timeout = setTimeout(() => controller.abort(), 240_000);
    try {
      const result = await postSessionCommand<
        ExtractAssessmentResult,
        ExtractAssessmentInput
      >('/api/assessment/extract', input, {
        signal: controller.signal,
      });
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
    const result = await postSessionCommand<
      { session: StudentSession },
      EquationAssessmentInput
    >('/api/assessment/equation', input);
    return {
      ...result,
      session: result.session
        ? inflateStudentSessionProjection(result.session)
        : result.session,
    };
  },

  async tutorTurn(input) {
    const result = await postSessionCommand<TutorTurnResult, TutorTurnInput>(
      '/api/tutor/turn',
      input,
    );
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
