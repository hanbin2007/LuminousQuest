import { randomBytes, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { type AssistanceMetadata } from '../shared/scoring/rubric';
import {
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import {
  recordNeedsReviewTextAssessment,
  recordStructuredTextAssessment,
} from '../shared/workflows/assessment';
import { ExtractionValidationError } from '../shared/workflows/extraction-validation';
import { loadAllConfig, ConfigValidationError } from './config/loader';
import { EvalCandidateStore } from './llm/eval-candidate-store';
import { RecordingStore } from './llm/recording-store';
import { createProviderRegistry } from './llm/providers';
import { LLMService } from './llm/service';
import type { LLMExecutionMode, LLMProvider, LLMRequest } from './llm/types';
import { loadAllPrompts, loadPrompt, PromptValidationError } from './prompts/loader';
import { InMemorySessionStore, type ServerSessionStore } from './session/store';
import { loadExternalAsset, loadStaticAsset } from './static-assets';
import {
  runAssessmentExtraction,
} from './workflows/assessment-extraction';
import { runSocraticTurn } from './workflows/socratic-tutoring';

const llmRequestSchema = z
  .object({
    executionMode: z.enum(['live', 'development', 'demo']),
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
    if (request.executionMode === 'demo' && request.stepId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['stepId'],
        message: 'is required in demo mode',
      });
    }
  });

const assessmentRouteRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    caseId: z.string().trim().min(1).max(128),
    nodeId: z.string().trim().min(1).max(128),
    studentAnswer: z.string(),
  })
  .strict();

const tutorRouteRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    nodeId: z.string().trim().min(1).max(128),
    studentAnswer: z.string(),
  })
  .strict();

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
  sessions?: ServerSessionStore;
  workflow?: Partial<ServerWorkflowOptions>;
  apiToken?: string;
  maxRequestBodyBytes?: number;
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

function invalidRequest(context: Context, label: string, error: z.ZodError) {
  return context.json({
    error: `Invalid ${label} request`,
    issues: error.issues.map((issue) => ({
      field: issue.path.join('.') || '$',
      reason: issue.message,
    })),
  }, 400);
}

function configuredWorkflow(options: ServerAppOptions): ServerWorkflowOptions {
  const requestedMode = options.workflow?.executionMode ?? process.env.LQ_LLM_EXECUTION_MODE;
  const executionMode: LLMExecutionMode = requestedMode === 'live' || requestedMode === 'demo'
    ? requestedMode
    : 'development';
  return {
    executionMode,
    provider: options.workflow?.provider ?? process.env.LQ_LLM_PROVIDER ?? 'mock',
    model: options.workflow?.model ?? process.env.LQ_LLM_MODEL ?? 'mock-v1',
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

export function createServerApp(options: ServerAppOptions) {
  const app = new Hono();
  const apiToken = options.apiToken ?? randomBytes(32).toString('hex');
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  const recordings = new RecordingStore(options.contentRoot);
  const evalCandidates = new EvalCandidateStore(options.contentRoot);
  const sessions = options.sessions ?? new InMemorySessionStore();
  const workflow = configuredWorkflow(options);
  const llmService = new LLMService({
    providers: options.providers ?? createProviderRegistry(),
    recordings,
  });

  app.get('/api/config', async (context) => {
    try {
      const [config, prompts] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadAllPrompts(options.contentRoot),
      ]);
      return context.json({ ...config, prompts });
    } catch (error) {
      if (error instanceof ConfigValidationError || error instanceof PromptValidationError) {
        return context.json(externalDataError(error), 500);
      }
      throw error;
    }
  });

  app.post('/api/llm', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = llmRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) {
      return invalidRequest(context, 'LLM', parsed.error);
    }
    if (['structured-assessment', 'socratic-tutoring'].includes(parsed.data.prompt.id)) {
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
        prompt,
        configVersion: config.configVersion,
      };
      return context.json(await llmService.execute(request));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[llm] request failed: ${detail}`);
      return context.json({ error: 'LLM request failed' }, 500);
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
      const nowMs = workflow.now?.() ?? Date.now();
      // Local single-process limitation: changing the client-supplied sessionId resets assistance counts.
      let session = sessions.get(parsed.data.sessionId) ?? createSession({
        id: parsed.data.sessionId,
        now: new Date(nowMs).toISOString(),
        configVersions: sessionConfigVersions(config),
      });
      if (session.configVersions.configDigest !== config.configVersion) {
        return context.json({ error: 'Session config version does not match the current server config' }, 409);
      }
      const assistance = derivedAssistance(session, parsed.data.nodeId);
      const result = await runAssessmentExtraction({
        service: llmService,
        evalCandidates,
        config,
        prompt,
        answer: parsed.data.studentAnswer,
        caseId: parsed.data.caseId,
        targetNodeIds: [parsed.data.nodeId],
        assistance,
        executionMode: workflow.executionMode,
        provider: workflow.provider,
        model: workflow.model,
        ...(workflow.extractionStepId ? { stepId: workflow.extractionStepId } : {}),
      });
      const operationId = randomUUID();
      const occurredAt = new Date(Math.max(nowMs, Date.parse(session.updatedAt))).toISOString();
      const questionId = `${parsed.data.caseId}:${parsed.data.nodeId}`;
      const attemptNumber = session.events.filter((event) =>
        event.kind === 'answer.submitted' && event.questionId === questionId).length + 1;
      const answer = {
        id: `answer-${operationId}`,
        occurredAt,
        caseId: parsed.data.caseId,
        stageId: 'assessment',
        attemptId: `${parsed.data.nodeId.toLowerCase()}-${attemptNumber}`,
        questionId,
        value: parsed.data.studentAnswer,
      };
      const provenance = {
        promptId: prompt.id,
        promptVersion: prompt.version,
        cacheKey: result.cacheKey,
        model: result.model,
      };
      const recorded = result.status === 'extracted'
        ? recordStructuredTextAssessment({
            session,
            config,
            answer,
            extraction: result.extraction,
            provenance,
            assessmentEventIdPrefix: `assessment-${operationId}`,
            assessedAt: occurredAt,
          })
        : recordNeedsReviewTextAssessment({
            session,
            config,
            answer,
            nodeId: parsed.data.nodeId,
            assistance,
            reason: result.reason,
            provenance,
            assessmentEventId: `assessment-${operationId}`,
            assessedAt: occurredAt,
          });
      session = recorded.session;
      sessions.set(session);
      return context.json({ ...result, ...recorded });
    } catch (error) {
      if (error instanceof ExtractionValidationError && error.category === 'answer-too-long') {
        return context.json({ error: error.message }, 413);
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[assessment] request failed: ${detail}`);
      return context.json({ error: 'Assessment extraction failed' }, 500);
    }
  });

  app.post('/api/tutor/turn', async (context) => {
    const requestBody = await readProtectedJson(context, apiToken, maxRequestBodyBytes);
    if (!requestBody.ok) return requestBody.response;
    const parsed = tutorRouteRequestSchema.safeParse(requestBody.body);
    if (!parsed.success) return invalidRequest(context, 'tutor turn', parsed.error);
    const session = sessions.get(parsed.data.sessionId);
    if (!session) return context.json({ error: 'Session not found' }, 404);

    try {
      const [config, prompt] = await Promise.all([
        loadAllConfig(options.contentRoot),
        loadPrompt(options.contentRoot, 'socratic-tutoring'),
      ]);
      if (!prompt) throw new Error('Required prompt socratic-tutoring is missing');
      if (session.configVersions.configDigest !== config.configVersion) {
        return context.json({ error: 'Session config version does not match the current server config' }, 409);
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
        ...(workflow.tutorStepId ? { stepId: workflow.tutorStepId } : {}),
      });
      sessions.set(result.session);
      return context.json(result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[tutor] request failed: ${detail}`);
      return context.json({ error: 'Tutor turn failed' }, 500);
    }
  });

  app.all('/api/*', (context) => context.json({ error: 'API route not found' }, 404));

  app.get('/assets/*', async (context) => {
    const pathname = new URL(context.req.url).pathname;
    const asset = await loadExternalAsset(options.contentRoot, pathname.slice('/assets/'.length));
    if (!asset) return context.text('Asset not found', 404);
    context.header('content-type', asset.contentType);
    context.header('cache-control', 'no-cache');
    return context.body(asset.body);
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
