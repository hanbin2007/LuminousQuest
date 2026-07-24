import { execSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AgentTurnAdapter } from './agent/adapters/adapter';
import { createAgentAdapterRegistry } from './agent/adapters/factory';
import { runAgentLoopTurn } from './agent/loop-runtime';
import {
  ResponseContractBindingError,
  ResponseContractRegistry,
} from './agent/response-contracts';
import {
  ExistingTextShadowAssessment,
  submitAgentAnswer,
  type AgentAnswerAssessmentStatus,
} from './agent/shadow-assessment';

import { type AssistanceMetadata } from '../shared/scoring/rubric';
import { buildLearnerProfile } from '../shared/scoring/profile';
import { demoStartStateSchema } from '../shared/demo/start-state';
import type { AssessmentCompletedEvent } from '../shared/session/schema';
import {
  answerPayloadSchema,
  sessionSchema,
} from '../shared/session/schema';
import { projectStudentSession } from '../shared/session/projections';
import {
  sessionCommandEnvelopeSchema,
  sessionSyncRequestSchema,
} from '../shared/session/sync';
import {
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import {
  recordNeedsReviewTextAssessments,
  recordStructuredTextAssessment,
} from '../shared/workflows/assessment';
import { recordChoiceAssessment } from '../shared/workflows/choice-assessment';
import { recordEquationAssessment } from '../shared/workflows/engine-assessment';
import { ExtractionValidationError } from '../shared/workflows/extraction-validation';
import { recordPretestEquationAssessments } from '../shared/workflows/pretest-equation-assessment';
import { loadAllConfig, ConfigValidationError } from './config/loader';
import { createPublicConfigView } from './config/public-view';
import { resolveLLMConfiguration } from './llm/configuration';
import { EvalCandidateStore } from './llm/eval-candidate-store';
import { LLMHealthMonitor } from './llm/health';
import { RecordingStore } from './llm/recording-store';
import { createProviderRegistry } from './llm/providers';
import { AgentReplayMissingError, LLMService } from './llm/service';
import type { LLMExecutionMode, LLMProvider, LLMRequest } from './llm/types';
import { loadPrompt, PromptValidationError } from './prompts/loader';
import {
  coordinateSessionStore,
  executeSessionCommand,
  InMemorySessionStore,
  SessionIdempotencyConflictError,
  SessionPrefixConflictError,
  SessionSequenceConflictError,
  type ServerSessionStore,
} from './session/store';
import { loadExternalAsset, loadStaticAsset } from './static-assets';
import {
  runAssessmentExtraction,
} from './workflows/assessment-extraction';
import { runSocraticTurn } from './workflows/socratic-tutoring';
import { demoLockEnabled } from './runtime/launch-options';

class TutorEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TutorEligibilityError';
  }
}

const llmRequestSchema = z
  .object({
    executionMode: z.enum(['live', 'development', 'demo']).optional(),
    capability: z.enum(['chat', 'vision', 'structured']),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    prompt: z
      .object({
        id: z.string().trim().min(1),
        version: z.string().trim().min(1).optional(),
        text: z.string().min(1).optional(),
      })
      .strict(),
    schemaVersion: z.string().trim().min(1),
    configVersion: z.string().trim().min(1).optional(),
    input: z.unknown(),
    images: z
      .array(
        z
          .object({
            mediaType: z.string().regex(/^image\//),
            data: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    schema: z.record(z.string(), z.unknown()).optional(),
    stepId: z.string().trim().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.capability === 'structured' && request.schema === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['schema'],
        message: 'is required for structured capability',
      });
    }
  });

const routeCommandEnvelopeSchema = sessionCommandEnvelopeSchema.partial();

const assessmentRouteRequestSchema = routeCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    caseId: z.string().trim().min(1).max(128).optional(),
    questionId: z.string().trim().min(1).max(128),
    targetNodeIds: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
    studentAnswer: z.string(),
    submissionId: z.string().trim().min(1).max(128),
  })
  .strict()
  .refine((value) => new Set(value.targetNodeIds).size === value.targetNodeIds.length, {
    path: ['targetNodeIds'],
    message: 'must contain unique node ids',
  });

const equationRouteRequestSchema = routeCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    caseId: z.string().trim().min(1).max(128),
    equationSetId: z.string().trim().min(1).max(128),
    equation: z.string(),
    submissionId: z.string().trim().min(1).max(128),
  })
  .strict();

const choiceRouteRequestSchema = routeCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    questionId: z.string().trim().min(1).max(128),
    optionId: z.string().trim().min(1).max(128),
    submissionId: z.string().trim().min(1).max(128),
  })
  .strict();

const drawingReviewRequestSchema = z
  .object({
    imageData: z.string().min(1).refine((value) => {
      const encoded = value.startsWith('data:image/png;base64,')
        ? value.slice('data:image/png;base64,'.length)
        : value;
      const bytes = Buffer.from(encoded, 'base64');
      return bytes.length >= 8
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }, 'must be a base64-encoded PNG image'),
  })
  .strict();

const drawingFeedbackFallback = '手绘已保留；请人工检查四个功能要素与电子、离子路径标注。';
const drawingFeedbackResponseSchema = z
  .object({ comment: z.string().trim().min(1).max(400) })
  .strict();
const drawingFeedbackJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['comment'],
  properties: {
    comment: { type: 'string', minLength: 1, maxLength: 400 },
  },
} as const;

const tutorRouteRequestSchema = routeCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    nodeId: z.string().trim().min(1).max(128),
    studentAnswer: z.string(),
  })
  .strict();

const agentTurnRouteRequestSchema = sessionCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    caseId: z.string().trim().min(1).max(128),
    triggerEventId: z.string().trim().min(1).max(128),
  })
  .strict();

const agentAnswerRouteRequestSchema = sessionCommandEnvelopeSchema
  .extend({
    sessionId: z.string().trim().min(1).max(128),
    turnId: z.string().trim().min(1).max(128),
    answer: answerPayloadSchema,
  })
  .strict();

const executionModeRequestSchema = z
  .object({ executionMode: z.enum(['live', 'development', 'demo']) })
  .strict();

const emptyRequestSchema = z.object({}).strict();

interface AgentTurnCommandValue {
  degraded: boolean;
  failureCategory?: string;
}

interface AgentAnswerCommandValue {
  assessmentStatus: AgentAnswerAssessmentStatus;
  degraded: boolean;
  failureCategory?: string;
}

export interface ServerWorkflowOptions {
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
  extractionStepId?: string;
  tutorStepId?: string;
  now?: () => number;
}

export interface ServerAppOptions {
  contentRoot: string;
  clientRoot: string;
  providers?: Map<string, LLMProvider>;
  agentAdapters?: Map<string, AgentTurnAdapter>;
  sessions?: ServerSessionStore;
  workflow?: Partial<ServerWorkflowOptions>;
  apiToken?: string;
  accessToken?: string;
  maxRequestBodyBytes?: number;
  lockDemo?: boolean;
  /** 测试阶段的手动阶段跳转(LQ_TEST_NAV=1);锁演示时强制关闭。 */
  testNavigation?: boolean;
}

const lanAccessCookie = 'lq_lan_access';

function accessTokenMatches(candidate: string | undefined, expected: string) {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const entry of header.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function externalDataError(error: ConfigValidationError | PromptValidationError) {
  return {
    error: error.name,
    file: error.file,
    field: error.field,
    reason: error.reason,
  };
}

async function readBoundedBody(request: Request, maximumBytes: number) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readProtectedJson(
  context: Context,
  apiToken: string,
  maximumBytes: number,
) {
  if (context.req.header('x-lq-api-token') !== apiToken) {
    return { ok: false as const, response: context.json({ error: 'Unauthorized request' }, 401) };
  }
  const requestUrl = new URL(context.req.url);
  const origin = context.req.header('origin');
  if (origin && origin !== requestUrl.origin) {
    return { ok: false as const, response: context.json({ error: 'Cross-origin request denied' }, 403) };
  }
  const mediaType = context.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return {
      ok: false as const,
      response: context.json({ error: 'Content-Type must be application/json' }, 415),
    };
  }
  const declaredLength = Number(context.req.header('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return { ok: false as const, response: context.json({ error: 'Request body is too large' }, 413) };
  }

  try {
    const bytes = await readBoundedBody(context.req.raw, maximumBytes);
    if (!bytes) {
      return { ok: false as const, response: context.json({ error: 'Request body is too large' }, 413) };
    }
    return {
      ok: true as const,
      body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    };
  } catch {
    return {
      ok: false as const,
      response: context.json({ error: 'Request body must be valid JSON' }, 400),
    };
  }
}

// 服务端代码身份:启动时取一次 git 状态,供 /api/version 与前端徽标对账。
// 打包/断网环境(非 git 目录)回退 unknown,绝不因取版本失败影响启动。
let cachedServerVersion: { commit: string; dirty: boolean; startedAt: string } | null = null;
function serverVersionInfo() {
  if (cachedServerVersion) return cachedServerVersion;
  let commit = 'unknown';
  let dirty = false;
  try {
    commit = execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    dirty = execSync('git status --porcelain', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().length > 0;
  } catch {
    // 保持 unknown
  }
  cachedServerVersion = { commit, dirty, startedAt: new Date().toISOString() };
  return cachedServerVersion;
}

function invalidRequest(context: Context, label: string, error: z.ZodError) {
  return context.json({
    error: `Invalid ${label} request`,
    issues: error.issues.map((issue) => ({
      field: issue.path.join('.') || '$',
      reason: issue.message,
    })),
  }, 400);
}

function sessionCommandConflict(context: Context, error: unknown) {
  if (error instanceof SessionSequenceConflictError) {
    return context.json({
      error: 'session-sequence-conflict',
      expectedSequence: error.expectedSequence,
      actualSequence: error.actualSequence,
    }, 409);
  }
  if (error instanceof SessionIdempotencyConflictError) {
    return context.json({
      error: 'session-idempotency-conflict',
      idempotencyKey: error.idempotencyKey,
    }, 409);
  }
  if (error instanceof SessionPrefixConflictError) {
    return context.json({
      error: 'session-prefix-conflict',
      ...(error.eventIndex === undefined ? {} : { eventIndex: error.eventIndex }),
    }, 409);
  }
  return null;
}

function routeExpectedSequence(
  store: ServerSessionStore,
  sessionId: string,
  idempotencyKey: string,
  supplied: number | undefined,
) {
  if (supplied !== undefined) return supplied;
  const session = store.get(sessionId);
  const commandEvent = session?.events.find((event) =>
    event.command?.idempotencyKey === idempotencyKey);
  if (commandEvent?.command) return commandEvent.command.expectedSequence;
  const marker = session?.events.find((event) =>
    event.kind === 'session.command.executed'
    && event.idempotencyKey === idempotencyKey);
  if (marker?.kind === 'session.command.executed') {
    return marker.expectedSequence;
  }
  return session?.events.length ?? 0;
}

function configuredWorkflow(options: ServerAppOptions, lockDemo: boolean): ServerWorkflowOptions {
  const configured = resolveLLMConfiguration({
    environment: process.env,
    lockDemo,
    ...(options.workflow?.executionMode
      ? { executionMode: options.workflow.executionMode }
      : {}),
    ...(options.workflow?.provider ? { provider: options.workflow.provider } : {}),
    ...(options.workflow?.model ? { model: options.workflow.model } : {}),
  });
  return {
    ...configured,
    ...(options.workflow?.extractionStepId
      ? { extractionStepId: options.workflow.extractionStepId }
      : {}),
    ...(options.workflow?.tutorStepId ? { tutorStepId: options.workflow.tutorStepId } : {}),
    ...(options.workflow?.now ? { now: options.workflow.now } : {}),
  };
}

function derivedAssistance(
  session: ReturnType<typeof createSession>,
  nodeId: string,
): AssistanceMetadata {
  const assessment = [...session.events].reverse().find((event) =>
    event.kind === 'assessment.completed' && event.nodeId === nodeId);
  if (!assessment || assessment.kind !== 'assessment.completed') return { kind: 'none', rounds: 0 };
  const rounds = session.events.filter((event) =>
    event.kind === 'tutor.turn.completed'
    && event.sourceAssessmentEventId === assessment.id).length;
  return rounds === 0 ? { kind: 'none', rounds: 0 } : { kind: 'socratic', rounds };
}

function stableAgentIdentifier(prefix: string, ...parts: string[]) {
  return `${prefix}-${createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 32)}`;
}

function unavailableAgentAdapter(provider: string): AgentTurnAdapter {
  return {
    id: provider === 'claude-agent' ? 'claude-agent' : 'openai-compatible',
    async execute() {
      throw Object.assign(
        new Error(`Agent adapter ${provider} is not configured`),
        { category: 'provider-unavailable' },
      );
    },
  };
}

function agentRouteFailure(context: Context, error: unknown) {
  const conflict = sessionCommandConflict(context, error);
  if (conflict) return conflict;
  if (error instanceof AgentReplayMissingError) {
    return context.json({
      error: 'agent-replay-missing',
      requestHash: error.requestHash,
    }, 409);
  }
  if (error instanceof ResponseContractBindingError) {
    return context.json({ error: 'agent-answer-rejected' }, 409);
  }
  return null;
}

export function createServerApp(options: ServerAppOptions) {
  const app = new Hono();
  const apiToken = options.apiToken ?? randomBytes(32).toString('hex');
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  const recordings = new RecordingStore(options.contentRoot);
  const evalCandidates = new EvalCandidateStore(options.contentRoot);
  const sessions = coordinateSessionStore(options.sessions ?? new InMemorySessionStore());
  const lockDemo = options.lockDemo ?? demoLockEnabled(process.env.LQ_LOCK_DEMO);
  const workflow = configuredWorkflow(options, lockDemo);
  const startupWorkflow = { ...workflow };
  const providers = options.providers ?? createProviderRegistry();
  const agentAdapters = options.agentAdapters
    ?? (options.providers ? new Map<string, AgentTurnAdapter>() : createAgentAdapterRegistry());
  const responseContracts = new ResponseContractRegistry();
  const llmService = new LLMService({
    providers,
    recordings,
  });
  const llmHealth = new LLMHealthMonitor({
    providers,
    agentAdapters,
    configuration: () => workflow,
  });

  if (options.accessToken) {
    app.use('*', async (context, next) => {
      const url = new URL(context.req.url);
      const queryToken = url.searchParams.get('access_token') ?? undefined;
      if (queryToken !== undefined) {
        if (!accessTokenMatches(queryToken, options.accessToken!)) {
          return context.text('Invalid LAN access token', 401);
        }
        url.searchParams.delete('access_token');
        const location = `${url.pathname}${url.search}`;
        context.header(
          'set-cookie',
          `${lanAccessCookie}=${encodeURIComponent(options.accessToken!)}; Path=/; HttpOnly; SameSite=Strict`,
        );
        context.header('cache-control', 'no-store');
        return context.redirect(location || '/');
      }
      const admitted = accessTokenMatches(
        cookieValue(context.req.header('cookie'), lanAccessCookie),
        options.accessToken!,
      );
      if (!admitted) {
        return url.pathname.startsWith('/api/')
          ? context.json({ error: 'LAN access token required' }, 401)
          : context.text('LAN access token required', 401);
      }
      await next();
    });
  }

  app.get('/api/config', async (context) => {
    try {
      const config = await loadAllConfig(options.contentRoot);
      context.header('x-lq-api-token', apiToken);
      return context.json(createPublicConfigView(config));
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return context.json(externalDataError(error), 500);
      }
      throw error;
    }
  });

  app.get('/api/runtime', (context) => {
    context.header('cache-control', 'no-store');
    return context.json({
      executionMode: workflow.executionMode,
      testNavigation: (options.testNavigation ?? false) && !lockDemo,
    });
  });

  app.get('/api/version', (context) => {
    context.header('cache-control', 'no-store');
    return context.json(serverVersionInfo());
  });

  app.post('/api/session/sync', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = sessionSyncRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'session sync', parsed.error);

    try {
      const config = await loadAllConfig(options.contentRoot);
      if (parsed.data.session.configVersions.configDigest !== config.configVersion) {
        return context.json({
          error: 'session-config-digest-mismatch',
          expectedConfigDigest: config.configVersion,
          actualConfigDigest: parsed.data.session.configVersions.configDigest,
        }, 409);
      }
      const result = await sessions.synchronize(parsed.data.session, {
        expectedSequence: parsed.data.expectedSequence,
        idempotencyKey: parsed.data.idempotencyKey,
      });
      return context.json({
        ...result,
        session: projectStudentSession(result.session),
      });
    } catch (error) {
      if (error instanceof SessionSequenceConflictError) {
        return context.json({
          error: 'session-sequence-conflict',
          expectedSequence: error.expectedSequence,
          actualSequence: error.actualSequence,
        }, 409);
      }
      if (error instanceof SessionPrefixConflictError) {
        return context.json({
          error: 'session-prefix-conflict',
          ...(error.eventIndex === undefined ? {} : { eventIndex: error.eventIndex }),
        }, 409);
      }
      if (error instanceof SessionIdempotencyConflictError) {
        return context.json({
          error: 'session-idempotency-conflict',
          idempotencyKey: error.idempotencyKey,
        }, 409);
      }
      throw error;
    }
  });

  app.get('/api/llm/health', async (context) => {
    context.header('cache-control', 'no-store');
    return context.json(await llmHealth.get());
  });

  app.post('/api/runtime/execution-mode', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    if (lockDemo) {
      return context.json({ error: 'Demo mode is locked by startup configuration' }, 403);
    }
    const parsed = executionModeRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'execution mode', parsed.error);
    workflow.executionMode = parsed.data.executionMode;
    if (workflow.executionMode !== 'demo') {
      workflow.extractionStepId = startupWorkflow.extractionStepId;
      workflow.tutorStepId = startupWorkflow.tutorStepId;
    }
    return context.json({ executionMode: workflow.executionMode });
  });

  app.post('/api/runtime/demo', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = emptyRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'demo activation', parsed.error);

    try {
      const [config, startSource] = await Promise.all([
        loadAllConfig(options.contentRoot),
        readFile(path.join(options.contentRoot, 'recordings', 'demo', 'start-state.json'), 'utf8'),
      ]);
      const startState = demoStartStateSchema.parse(JSON.parse(startSource) as unknown);
      const [source, ...classSources] = await Promise.all([
        readFile(path.join(options.contentRoot, ...startState.sessionRef.split('/')), 'utf8'),
        ...startState.classSessionRefs.map((reference) =>
          readFile(path.join(options.contentRoot, ...reference.split('/')), 'utf8')),
      ]);
      const demoSession = sessionSchema.parse(JSON.parse(source) as unknown);
      buildLearnerProfile(demoSession, config);
      const classSessions = classSources.map((classSource) =>
        sessionSchema.parse(JSON.parse(classSource) as unknown));
      classSessions.forEach((classSession) => buildLearnerProfile(classSession, config));
      const ids = new Set([demoSession.id, ...classSessions.map((session) => session.id)]);
      if (ids.size !== classSessions.length + 1) {
        throw new Error('Demo sessions must use distinct session ids');
      }
      sessions.set(demoSession);
      workflow.executionMode = 'demo';
      workflow.extractionStepId = 'demo-extraction';
      workflow.tutorStepId = 'demo-tutor-p4';
      return context.json({
        executionMode: workflow.executionMode,
        session: projectStudentSession(demoSession),
        progress: startState.progress,
        uiState: {
          version: startState.version,
          route: startState.route,
          pretest: startState.pretest,
          training: startState.training,
        },
      });
    } catch (error) {
      console.error(`[demo] activation failed: ${error instanceof Error ? error.message : String(error)}`);
      return context.json({ error: 'Demo session is unavailable or incompatible with current content' }, 500);
    }
  });

  app.post('/api/llm', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = llmRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) {
      return invalidRequest(context, 'LLM', parsed.error);
    }
    if (['structured-assessment', 'socratic-tutoring', 'hand-drawing-feedback']
      .includes(parsed.data.prompt.id)) {
      return context.json({ error: 'Protected workflow prompt requires its dedicated API route' }, 403);
    }

    try {
      const [config, prompt] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadPrompt(options.contentRoot, parsed.data.prompt.id),
      ]);
      if (!prompt) return context.json({ error: 'Unknown prompt id' }, 400);
      const request: LLMRequest = {
        ...parsed.data,
        executionMode: workflow.executionMode,
        provider: workflow.provider,
        model: workflow.model,
        prompt,
        configVersion: config.configVersion,
      };
      if (request.executionMode === 'demo' && request.stepId === undefined) {
        return context.json({
          error: 'Invalid LLM request',
          issues: [{ field: 'stepId', reason: 'is required by the server demo mode' }],
        }, 400);
      }
      return context.json(await llmService.execute(request));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[llm] request failed: ${detail}`);
      return context.json({ error: 'LLM request failed' }, 500);
    }
  });

  app.post('/api/assessment/choice', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = choiceRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'choice assessment', parsed.error);

    try {
      const config = await loadAllConfig(options.contentRoot);
      const question = config.pretest.questions.find((entry) =>
        entry.id === parsed.data.questionId && entry.type === 'choice');
      if (!question || question.type !== 'choice') {
        return context.json({ error: 'Unknown choice question' }, 400);
      }
      const option = question.options.find((entry) => entry.id === parsed.data.optionId);
      if (!option) return context.json({ error: 'Unknown choice option' }, 400);
      const nowMs = workflow.now?.() ?? Date.now();
      const idempotencyKey =
        parsed.data.idempotencyKey ?? parsed.data.submissionId;
      const command = await executeSessionCommand({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'choice',
        expectedSequence: routeExpectedSequence(
          sessions,
          parsed.data.sessionId,
          idempotencyKey,
          parsed.data.expectedSequence,
        ),
        idempotencyKey,
        request: {
          questionId: parsed.data.questionId,
          optionId: parsed.data.optionId,
          submissionId: parsed.data.submissionId,
        },
        initialize: () => createSession({
          id: parsed.data.sessionId,
          now: new Date(nowMs).toISOString(),
          configVersions: sessionConfigVersions(config),
        }),
        execute(session) {
          if (session.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          const operationId = randomUUID();
          let idIndex = 0;
          const occurredAt = new Date(
            Math.max(nowMs, Date.parse(session.updatedAt)),
          ).toISOString();
          const recorded = recordChoiceAssessment({
            session,
            config,
            question,
            optionId: option.id,
            occurredAt,
            attemptId: parsed.data.submissionId,
            idFactory: (prefix) => `${prefix}-${operationId}-${idIndex++}`,
          });
          return {
            session: recorded.session,
            value: { status: 'recorded' as const },
          };
        },
      });
      return context.json({
        status: command.replayed ? 'already-recorded' : 'recorded',
        session: projectStudentSession(command.session),
      });
    } catch (error) {
      const conflict = sessionCommandConflict(context, error);
      if (conflict) return conflict;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[choice-assessment] request failed: ${detail}`);
      return context.json({ error: 'Choice assessment failed' }, 500);
    }
  });

  app.post('/api/drawing/review', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = drawingReviewRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'drawing review', parsed.error);

    try {
      const [config, prompt] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadPrompt(options.contentRoot, 'hand-drawing-feedback'),
      ]);
      if (!prompt) throw new Error('Required prompt hand-drawing-feedback is missing');
      const result = await llmService.execute({
        executionMode: workflow.executionMode,
        capability: 'structured',
        provider: workflow.provider,
        model: workflow.model,
        prompt,
        schemaVersion: 'hand-drawing-feedback.v1',
        configVersion: config.configVersion,
        input: { task: '只用自然语言点评手绘表达，不判分，不写入学习者画像。' },
        images: [{ mediaType: 'image/png', data: parsed.data.imageData }],
        schema: drawingFeedbackJsonSchema,
        ...(workflow.executionMode === 'demo' ? { stepId: 'hand-drawing-feedback' } : {}),
      });
      const feedbackValue = drawingFeedbackResponseSchema.safeParse(result.response.structured);
      const feedback = workflow.provider === 'mock'
        ? '演示占位：已收到手绘表达。请检查电子路径、离子路径与方向标注是否一致。'
        : feedbackValue.success ? feedbackValue.data.comment : drawingFeedbackFallback;
      return context.json({ feedback });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[drawing-review] request failed: ${detail}`);
      return context.json({ error: 'Drawing review failed' }, 500);
    }
  });

  app.post('/api/assessment/extract', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = assessmentRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'assessment extraction', parsed.error);

    try {
      const [config, prompt] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadPrompt(options.contentRoot, 'structured-assessment'),
      ]);
      if (!prompt) throw new Error('Required prompt structured-assessment is missing');
      const requestedCase = parsed.data.caseId
        ? config.cases.find((entry) => entry.id === parsed.data.caseId)
        : undefined;
      const questionCandidate = parsed.data.caseId
        ? undefined
        : config.pretest.questions.find((entry) => entry.id === parsed.data.questionId);
      const question = questionCandidate?.type === 'text' ? questionCandidate : undefined;
      if (parsed.data.caseId && !requestedCase) {
        return context.json({ error: 'Unknown training case' }, 400);
      }
      if (requestedCase && parsed.data.questionId !== `${requestedCase.id}:analysis`) {
        return context.json({ error: 'Unknown training question' }, 400);
      }
      if (!parsed.data.caseId && !question) {
        return context.json({ error: 'Unknown text question' }, 400);
      }
      const configuredTargets = new Set(requestedCase?.targetNodeIds ?? question!.targetNodeIds);
      if (parsed.data.targetNodeIds.some((nodeId) => !configuredTargets.has(nodeId))) {
        return context.json({ error: 'Target node is not configured for this question' }, 400);
      }
      const referenceCaseId = requestedCase?.id ?? question!.referenceEquations[0].caseId;
      const trainingCase = config.cases.find((entry) => entry.id === referenceCaseId);
      if (!trainingCase) throw new Error(`Required case ${referenceCaseId} is missing`);
      const sourceByNode = new Map(trainingCase.evidencePaths.map((path) => [path.nodeId, path.source]));
      question?.evidence?.forEach((evidence) => sourceByNode.set(evidence.nodeId, 'answer'));
      const answerTargetNodeIds = parsed.data.targetNodeIds.filter((nodeId) =>
        sourceByNode.get(nodeId) === 'answer');
      const equationTargetNodeIds = parsed.data.targetNodeIds.filter((nodeId) =>
        sourceByNode.get(nodeId) === 'equation');
      if (answerTargetNodeIds.length + equationTargetNodeIds.length !== parsed.data.targetNodeIds.length) {
        return context.json({ error: 'Target node has no supported assessment path for this question' }, 400);
      }
      const nowMs = workflow.now?.() ?? Date.now();
      const idempotencyKey =
        parsed.data.idempotencyKey ?? parsed.data.submissionId;
      const command = await executeSessionCommand({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'extract',
        expectedSequence: routeExpectedSequence(
          sessions,
          parsed.data.sessionId,
          idempotencyKey,
          parsed.data.expectedSequence,
        ),
        idempotencyKey,
        request: {
          caseId: parsed.data.caseId,
          questionId: parsed.data.questionId,
          targetNodeIds: parsed.data.targetNodeIds,
          studentAnswer: parsed.data.studentAnswer,
          submissionId: parsed.data.submissionId,
        },
        initialize: () => createSession({
          id: parsed.data.sessionId,
          now: new Date(nowMs).toISOString(),
          configVersions: sessionConfigVersions(config),
        }),
        async execute(currentSession) {
          if (currentSession.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          // Local single-process limitation: changing sessionId resets assistance counts.
          const assistanceByNode = answerTargetNodeIds.map((nodeId) =>
            derivedAssistance(currentSession, nodeId));
          const assistance = assistanceByNode.reduce<AssistanceMetadata>(
            (selected, candidate) =>
              candidate.rounds > selected.rounds ? candidate : selected,
            { kind: 'none', rounds: 0 },
          );
          const operationId = randomUUID();
          const occurredAt = new Date(
            Math.max(nowMs, Date.parse(currentSession.updatedAt)),
          ).toISOString();
          const answer = {
            id: `answer-${operationId}`,
            occurredAt,
            caseId: requestedCase?.id ?? 'pretest',
            stageId: requestedCase
              ? requestedCase.caseType === 'transfer' ? 'transfer' : 'training'
              : 'assessment',
            attemptId: parsed.data.submissionId,
            questionId: parsed.data.questionId,
            value: parsed.data.studentAnswer,
          };
          let session = currentSession;
          let extractionResult:
            Awaited<ReturnType<typeof runAssessmentExtraction>> | null = null;
          let profile:
            ReturnType<typeof recordPretestEquationAssessments>['profile']
            | undefined;
          if (answerTargetNodeIds.length > 0) {
            extractionResult = await runAssessmentExtraction({
              service: llmService,
              evalCandidates,
              config,
              prompt,
              answer: parsed.data.studentAnswer,
              caseId: referenceCaseId,
              targetNodeIds: answerTargetNodeIds,
              questionEvidence: question?.evidence,
              assistance,
              executionMode: workflow.executionMode,
              provider: workflow.provider,
              model: workflow.model,
              ...(workflow.extractionStepId
                ? { stepId: workflow.extractionStepId }
                : {}),
            });
            const provenance = {
              promptId: prompt.id,
              promptVersion: prompt.version,
              cacheKey: extractionResult.cacheKey,
              model: extractionResult.model,
            };
            const recorded = extractionResult.status === 'extracted'
              ? recordStructuredTextAssessment({
                  session,
                  config,
                  answer,
                  extraction: extractionResult.extraction,
                  provenance,
                  assessmentEventIdPrefix: `assessment-${operationId}-text`,
                  assessedAt: occurredAt,
                  referenceCaseId,
                  questionEvidence: question?.evidence,
                })
              : recordNeedsReviewTextAssessments({
                  session,
                  config,
                  answer,
                  nodeIds: answerTargetNodeIds,
                  assistance,
                  reason: extractionResult.reason,
                  provenance,
                  assessmentEventIdPrefix: `assessment-${operationId}-text`,
                  assessedAt: occurredAt,
                });
            session = recorded.session;
            profile = recorded.profile;
          }
          if (equationTargetNodeIds.length > 0) {
            const recorded = recordPretestEquationAssessments({
              session,
              config,
              answer,
              referenceCaseId,
              referenceEquationSetIds: question?.referenceEquations
                .filter((reference) => reference.caseId === referenceCaseId)
                .map((reference) => reference.equationSetId),
              targetNodeIds: equationTargetNodeIds,
              assessmentEventIdPrefix: `assessment-${operationId}-equation`,
              assessedAt: occurredAt,
            });
            session = recorded.session;
            profile = recorded.profile;
          }
          return {
            session,
            value: {
              ...(extractionResult ?? { status: 'deterministic' as const }),
              profile,
              recordingStatus: 'recorded' as const,
            },
          };
        },
      });
      const responseValue = command.value ?? {
          status: 'already-recorded' as const,
          profile: buildLearnerProfile(command.session, config),
          recordingStatus: 'already-recorded' as const,
        };
      return context.json({
        ...responseValue,
        ...(command.replayed
          ? {
              status: 'already-recorded' as const,
              recordingStatus: 'already-recorded' as const,
            }
          : {}),
        session: projectStudentSession(command.session),
      });
    } catch (error) {
      if (error instanceof ExtractionValidationError && error.category === 'answer-too-long') {
        return context.json({ error: error.message }, 413);
      }
      const conflict = sessionCommandConflict(context, error);
      if (conflict) return conflict;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[assessment] request failed: ${detail}`);
      return context.json({ error: 'Assessment extraction failed' }, 500);
    }
  });

  app.post('/api/assessment/equation', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = equationRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'equation assessment', parsed.error);

    try {
      const config = await loadAllConfig(options.contentRoot);
      const trainingCase = config.cases.find((entry) => entry.id === parsed.data.caseId);
      const equationSet = trainingCase?.equationSets.find((entry) =>
        entry.id === parsed.data.equationSetId);
      if (!trainingCase || !equationSet) {
        return context.json({ error: 'Unknown case equation set' }, 400);
      }
      const nowMs = workflow.now?.() ?? Date.now();
      const questionId = `${trainingCase.id}:${equationSet.id}`;
      const idempotencyKey =
        parsed.data.idempotencyKey ?? parsed.data.submissionId;
      const command = await executeSessionCommand({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'equation',
        expectedSequence: routeExpectedSequence(
          sessions,
          parsed.data.sessionId,
          idempotencyKey,
          parsed.data.expectedSequence,
        ),
        idempotencyKey,
        request: {
          caseId: parsed.data.caseId,
          equationSetId: parsed.data.equationSetId,
          equation: parsed.data.equation,
          submissionId: parsed.data.submissionId,
        },
        initialize: () => createSession({
          id: parsed.data.sessionId,
          now: new Date(nowMs).toISOString(),
          configVersions: sessionConfigVersions(config),
        }),
        execute(session) {
          if (session.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          const operationId = randomUUID();
          const occurredAt = new Date(
            Math.max(nowMs, Date.parse(session.updatedAt)),
          ).toISOString();
          const recorded = recordEquationAssessment({
            session,
            config,
            equationSetId: equationSet.id,
            answer: {
              id: `answer-${operationId}`,
              occurredAt,
              caseId: trainingCase.id,
              stageId: trainingCase.caseType === 'transfer'
                ? 'transfer'
                : 'training',
              attemptId: parsed.data.submissionId,
              questionId,
              value: parsed.data.equation,
            },
            assistance: { kind: 'none', rounds: 0 },
            assessmentEventIdPrefix: `assessment-${operationId}-equation`,
            assessedAt: occurredAt,
          });
          return {
            session: recorded.session,
            value: {
              profile: recorded.profile,
              assessment: recorded.assessment,
            },
          };
        },
      });
      return context.json({
        status: command.replayed ? 'already-recorded' : 'recorded',
        session: projectStudentSession(command.session),
        ...(command.value ?? {
          profile: buildLearnerProfile(command.session, config),
        }),
      });
    } catch (error) {
      const conflict = sessionCommandConflict(context, error);
      if (conflict) return conflict;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[equation-assessment] request failed: ${detail}`);
      return context.json({ error: 'Equation assessment failed' }, 500);
    }
  });

  app.post('/api/tutor/turn', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = tutorRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'tutor turn', parsed.error);
    const existingSession = sessions.get(parsed.data.sessionId);
    if (!existingSession) return context.json({ error: 'Session not found' }, 404);

    try {
      const config = await loadAllConfig(options.contentRoot);
      const prompt = await loadPrompt(options.contentRoot, 'socratic-tutoring');
      if (!prompt) throw new Error('Required prompt socratic-tutoring is missing');
      const fallbackSequence = existingSession.events.length;
      const idempotencyKey = parsed.data.idempotencyKey
        ?? `tutor:${parsed.data.nodeId}:${fallbackSequence}`;
      const command = await executeSessionCommand({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'tutor',
        expectedSequence: routeExpectedSequence(
          sessions,
          parsed.data.sessionId,
          idempotencyKey,
          parsed.data.expectedSequence,
        ),
        idempotencyKey,
        request: {
          nodeId: parsed.data.nodeId,
          studentAnswer: parsed.data.studentAnswer,
        },
        initialize: () => existingSession,
        async execute(session) {
          if (session.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          let latestAssessment: AssessmentCompletedEvent | undefined;
          for (const event of session.events) {
            if (
              event.kind !== 'assessment.completed'
              || event.nodeId !== parsed.data.nodeId
            ) {
              continue;
            }
            if (
              !latestAssessment
              || event.sequence > latestAssessment.sequence
            ) {
              latestAssessment = event;
            }
          }
          if (!latestAssessment) {
            throw new TutorEligibilityError(
              'Tutor requires an assessed training-stage answer',
            );
          }
          const assessedCase = config.cases.find(
            (entry) => entry.id === latestAssessment!.caseId,
          );
          if (
            latestAssessment.stageId !== 'training'
            || assessedCase?.caseType !== 'training'
          ) {
            throw new TutorEligibilityError(
              'Tutor is only available for training-stage answers',
            );
          }
          const result = await runSocraticTurn({
            service: llmService,
            config,
            prompt,
            session,
            nodeId: parsed.data.nodeId,
            studentAnswer: parsed.data.studentAnswer,
            now: workflow.now,
            executionMode: workflow.executionMode,
            provider: workflow.provider,
            model: workflow.model,
            ...(workflow.tutorStepId
              ? { stepId: workflow.tutorStepId }
              : {}),
          });
          const { session: resultSession, ...value } = result;
          return { session: resultSession, value };
        },
      });
      if (!command.value) {
        return context.json({
          error: 'Tutor command replay requires no additional action',
          session: projectStudentSession(command.session),
        }, 409);
      }
      return context.json({
        ...command.value,
        session: projectStudentSession(command.session),
      });
    } catch (error) {
      const conflict = sessionCommandConflict(context, error);
      if (conflict) return conflict;
      if (error instanceof TutorEligibilityError) {
        return context.json({ error: error.message }, 409);
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[tutor] request failed: ${detail}`);
      return context.json({ error: 'Tutor turn failed' }, 500);
    }
  });

  app.post('/api/agent/turn', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = agentTurnRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'agent turn', parsed.error);
    const existingSession = sessions.get(parsed.data.sessionId);
    if (!existingSession) return context.json({ error: 'Session not found' }, 404);

    try {
      const config = await loadAllConfig(options.contentRoot);
      const trainingCase = config.cases.find((entry) => entry.id === parsed.data.caseId);
      if (!trainingCase) return context.json({ error: 'Unknown training case' }, 400);
      const adapter = agentAdapters.get(workflow.provider)
        ?? unavailableAgentAdapter(workflow.provider);
      const turnId = stableAgentIdentifier(
        'agent-turn',
        parsed.data.sessionId,
        parsed.data.idempotencyKey,
      );
      const occurredAt = new Date(Math.max(
        workflow.now?.() ?? Date.now(),
        Date.parse(existingSession.updatedAt),
      )).toISOString();
      const command = await executeSessionCommand<AgentTurnCommandValue>({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'agent-turn',
        expectedSequence: parsed.data.expectedSequence,
        idempotencyKey: parsed.data.idempotencyKey,
        request: {
          caseId: parsed.data.caseId,
          triggerEventId: parsed.data.triggerEventId,
        },
        initialize: () => existingSession,
        async execute(session) {
          if (session.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          const result = await runAgentLoopTurn({
            session,
            config,
            service: llmService,
            adapter,
            responseContracts,
            executionMode: workflow.executionMode,
            provider: workflow.provider,
            model: workflow.model,
            turnId,
            triggerEventId: parsed.data.triggerEventId,
            caseId: trainingCase.id,
            stageId: trainingCase.caseType === 'transfer' ? 'transfer' : 'training',
            attemptId: stableAgentIdentifier('agent-attempt', turnId),
            occurredAt,
          });
          return {
            session: result.session,
            value: {
              degraded: result.degraded,
              failureCategory: result.failureCategory,
            },
          };
        },
      });
      const turn = command.session.events.find((event) =>
        event.kind === 'agent.turn.completed' && event.turnId === turnId);
      if (!turn || turn.kind !== 'agent.turn.completed') {
        throw new Error('Agent turn command did not persist its completed turn');
      }
      return context.json({
        status: command.replayed ? 'already-completed' : 'completed',
        turnId,
        degraded: turn.source === 'fallback',
        ...(command.value?.failureCategory
          ? { failureCategory: command.value.failureCategory }
          : {}),
        session: projectStudentSession(command.session),
      });
    } catch (error) {
      const failure = agentRouteFailure(context, error);
      if (failure) return failure;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[agent-turn] request failed: ${detail}`);
      return context.json({ error: 'Agent turn failed' }, 500);
    }
  });

  app.post('/api/agent/answer', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = agentAnswerRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'agent answer', parsed.error);
    const existingSession = sessions.get(parsed.data.sessionId);
    if (!existingSession) return context.json({ error: 'Session not found' }, 404);

    try {
      const [config, prompt] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadPrompt(options.contentRoot, 'structured-assessment'),
      ]);
      if (!prompt) throw new Error('Required prompt structured-assessment is missing');
      const responseTurn = existingSession.events.find((event) =>
        event.kind === 'agent.turn.completed'
        && event.turnId === parsed.data.turnId);
      if (!responseTurn || responseTurn.kind !== 'agent.turn.completed') {
        return context.json({ error: 'agent-answer-rejected' }, 409);
      }
      const adapter = agentAdapters.get(workflow.provider)
        ?? unavailableAgentAdapter(workflow.provider);
      const nextTurnId = stableAgentIdentifier(
        'agent-turn',
        parsed.data.sessionId,
        `response:${parsed.data.turnId}`,
      );
      const occurredAt = new Date(Math.max(
        workflow.now?.() ?? Date.now(),
        Date.parse(existingSession.updatedAt),
      )).toISOString();
      const command = await executeSessionCommand<AgentAnswerCommandValue>({
        store: sessions,
        sessionId: parsed.data.sessionId,
        commandName: 'agent-answer',
        expectedSequence: parsed.data.expectedSequence,
        idempotencyKey: parsed.data.idempotencyKey,
        request: {
          turnId: parsed.data.turnId,
          answer: parsed.data.answer,
        },
        initialize: () => existingSession,
        async execute(session) {
          if (session.configVersions.configDigest !== config.configVersion) {
            throw new SessionPrefixConflictError();
          }
          const submitted = await submitAgentAnswer({
            session,
            config,
            responseContracts,
            submission: {
              turnId: parsed.data.turnId,
              answer: parsed.data.answer,
            },
            occurredAt,
            textAssessment: new ExistingTextShadowAssessment({
              service: llmService,
              evalCandidates,
              prompt,
              executionMode: workflow.executionMode,
              provider: workflow.provider,
              model: workflow.model,
              ...(workflow.extractionStepId
                ? { stepId: workflow.extractionStepId }
                : {}),
            }),
            idFactory: (prefix) => stableAgentIdentifier(
              prefix,
              parsed.data.sessionId,
              parsed.data.turnId,
            ),
          });
          const answerEvent = submitted.session.events.find((event) =>
            event.kind === 'answer.submitted'
            && event.responseToAgentTurnId === parsed.data.turnId);
          if (!answerEvent || answerEvent.kind !== 'answer.submitted') {
            throw new Error('Agent answer command did not persist its linked answer');
          }
          const existingNextTurn = submitted.session.events.find((event) =>
            event.kind === 'agent.turn.completed'
            && event.triggerEventId === answerEvent.id);
          if (existingNextTurn?.kind === 'agent.turn.completed') {
            return {
              session: submitted.session,
              value: {
                assessmentStatus: submitted.status,
                degraded: existingNextTurn.source === 'fallback',
              },
            };
          }
          const result = await runAgentLoopTurn({
            session: submitted.session,
            config,
            service: llmService,
            adapter,
            responseContracts,
            executionMode: workflow.executionMode,
            provider: workflow.provider,
            model: workflow.model,
            turnId: nextTurnId,
            triggerEventId: answerEvent.id,
            caseId: responseTurn.caseId,
            stageId: responseTurn.stageId,
            attemptId: stableAgentIdentifier('agent-attempt', nextTurnId),
            occurredAt,
          });
          return {
            session: result.session,
            value: {
              assessmentStatus: submitted.status,
              degraded: result.degraded,
              failureCategory: result.failureCategory,
            },
          };
        },
      });
      const nextTurn = command.session.events.find((event) =>
        event.kind === 'agent.turn.completed' && event.turnId === nextTurnId);
      if (!nextTurn || nextTurn.kind !== 'agent.turn.completed') {
        throw new Error('Agent answer command did not persist its next turn');
      }
      return context.json({
        status: command.replayed ? 'already-recorded' : 'recorded',
        ...(command.value?.assessmentStatus
          ? { assessmentStatus: command.value.assessmentStatus }
          : {}),
        nextTurnId,
        degraded: nextTurn.source === 'fallback',
        ...(command.value?.failureCategory
          ? { failureCategory: command.value.failureCategory }
          : {}),
        session: projectStudentSession(command.session),
      });
    } catch (error) {
      const failure = agentRouteFailure(context, error);
      if (failure) return failure;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[agent-answer] request failed: ${detail}`);
      return context.json({ error: 'Agent answer failed' }, 500);
    }
  });

  app.all('/api/*', (context) => context.json({ error: 'API route not found' }, 404));

  app.get('/assets/*', async (context) => {
    const pathname = new URL(context.req.url).pathname;
    const asset = await loadExternalAsset(options.contentRoot, pathname.slice('/assets/'.length));
    if (asset) {
      context.header('content-type', asset.contentType);
      context.header('cache-control', 'no-cache');
      return context.body(asset.body);
    }
    // Vite 构建产物同样输出到 /assets/*(哈希文件名),外置素材未命中时回落到客户端静态资源
    const clientAsset = await loadStaticAsset(options.clientRoot, pathname);
    if (!clientAsset) return context.text('Asset not found', 404);
    context.header('content-type', clientAsset.contentType);
    context.header('cache-control', 'public, max-age=31536000, immutable');
    return context.body(clientAsset.body);
  });

  app.get('*', async (context) => {
    const asset = await loadStaticAsset(options.clientRoot, new URL(context.req.url).pathname);
    if (!asset) return context.text('Frontend build not found', 404);
    context.header('content-type', asset.contentType);
    context.header('cache-control', asset.isIndex ? 'no-cache' : 'public, max-age=31536000, immutable');
    if (asset.isIndex) {
      const html = new TextDecoder().decode(asset.body);
      const injection = `<script>globalThis.__LQ_API_TOKEN__=${JSON.stringify(apiToken)};</script>`;
      return context.html(html.includes('</head>') ? html.replace('</head>', `${injection}</head>`) : `${injection}${html}`);
    }
    return context.body(asset.body);
  });

  app.onError((error, context) => {
    console.error('[server] unhandled request error:', error.message);
    return context.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
