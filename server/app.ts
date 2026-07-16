import { randomBytes, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { type AssistanceMetadata } from '../shared/scoring/rubric';
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
import { EvalCandidateStore } from './llm/eval-candidate-store';
import { RecordingStore } from './llm/recording-store';
import { createProviderRegistry } from './llm/providers';
import { LLMService } from './llm/service';
import type { LLMExecutionMode, LLMProvider, LLMRequest } from './llm/types';
import { loadPrompt, PromptValidationError } from './prompts/loader';
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

const equationRouteRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    caseId: z.string().trim().min(1).max(128),
    equationSetId: z.string().trim().min(1).max(128),
    equation: z.string(),
    submissionId: z.string().trim().min(1).max(128),
  })
  .strict();

const choiceRouteRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    questionId: z.string().trim().min(1).max(128),
    optionId: z.string().trim().min(1).max(128),
    submissionId: z.string().trim().min(1).max(128),
  })
  .strict();

const drawingReviewRequestSchema = z
  .object({ imageData: z.string().min(1) })
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
      let session = sessions.get(parsed.data.sessionId) ?? createSession({
        id: parsed.data.sessionId,
        now: new Date(nowMs).toISOString(),
        configVersions: sessionConfigVersions(config),
      });
      if (session.configVersions.configDigest !== config.configVersion) {
        return context.json({ error: 'Session config version does not match the current server config' }, 409);
      }
      const existing = session.events.find((event) =>
        event.kind === 'answer.submitted' && event.attemptId === parsed.data.submissionId);
      if (existing?.kind === 'answer.submitted') {
        const matches = existing.questionId === question.id
          && existing.answer.format === 'text'
          && existing.answer.value === option.text;
        return matches
          ? context.json({ status: 'already-recorded', session })
          : context.json({ error: 'Submission id was already used for different content' }, 409);
      }

      const operationId = randomUUID();
      let idIndex = 0;
      const occurredAt = new Date(Math.max(nowMs, Date.parse(session.updatedAt))).toISOString();
      const recorded = recordChoiceAssessment({
        session,
        config,
        question,
        optionId: option.id,
        occurredAt,
        attemptId: parsed.data.submissionId,
        idFactory: (prefix) => `${prefix}-${operationId}-${idIndex++}`,
      });
      session = recorded.session;
      sessions.set(session);
      return context.json({ status: 'recorded', session });
    } catch (error) {
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
        capability: 'vision',
        provider: workflow.provider,
        model: workflow.model,
        prompt,
        schemaVersion: 'hand-drawing-feedback.v1',
        configVersion: config.configVersion,
        input: { task: '只用自然语言点评手绘表达，不判分，不写入学习者画像。' },
        images: [{ mediaType: 'image/png', data: parsed.data.imageData }],
        ...(workflow.executionMode === 'demo' ? { stepId: 'hand-drawing-feedback' } : {}),
      });
      const content = result.response.content;
      const feedback = workflow.provider === 'mock' || content.startsWith('Mock vision extraction')
        ? '演示占位：已收到手绘表达。请检查电子路径、离子路径与方向标注是否一致。'
        : content;
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
      const question = parsed.data.caseId
        ? undefined
        : config.pretest.questions.find((entry) =>
            entry.id === parsed.data.questionId && entry.type === 'text');
      if (parsed.data.caseId && !requestedCase) {
        return context.json({ error: 'Unknown training case' }, 400);
      }
      if (requestedCase && parsed.data.questionId !== `${requestedCase.id}:analysis`) {
        return context.json({ error: 'Unknown training question' }, 400);
      }
      if (!parsed.data.caseId && (!question || question.type !== 'text')) {
        return context.json({ error: 'Unknown text question' }, 400);
      }
      const configuredTargets = new Set(requestedCase?.targetNodeIds ?? question!.targetNodeIds);
      if (parsed.data.targetNodeIds.some((nodeId) => !configuredTargets.has(nodeId))) {
        return context.json({ error: 'Target node is not configured for this question' }, 400);
      }
      const referenceCaseId = requestedCase?.id
        ?? (question!.type === 'text' ? question!.referenceEquations[0].caseId : '');
      const trainingCase = config.cases.find((entry) => entry.id === referenceCaseId);
      if (!trainingCase) throw new Error(`Required case ${referenceCaseId} is missing`);
      const sourceByNode = new Map(trainingCase.evidencePaths.map((path) => [path.nodeId, path.source]));
      const answerTargetNodeIds = parsed.data.targetNodeIds.filter((nodeId) =>
        sourceByNode.get(nodeId) === 'answer');
      const equationTargetNodeIds = parsed.data.targetNodeIds.filter((nodeId) =>
        sourceByNode.get(nodeId) === 'equation');
      if (answerTargetNodeIds.length + equationTargetNodeIds.length !== parsed.data.targetNodeIds.length) {
        return context.json({ error: 'Target node has no supported assessment path for this question' }, 400);
      }
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
      const existing = session.events.find((event) =>
        event.kind === 'answer.submitted' && event.attemptId === parsed.data.submissionId);
      if (existing?.kind === 'answer.submitted') {
        const matches = existing.questionId === parsed.data.questionId
          && existing.answer.format === 'text'
          && existing.answer.value === parsed.data.studentAnswer;
        return matches
          ? context.json({ status: 'already-recorded', session })
          : context.json({ error: 'Submission id was already used for different content' }, 409);
      }
      const assistanceByNode = answerTargetNodeIds.map((nodeId) =>
        derivedAssistance(session, nodeId));
      const assistance = assistanceByNode.reduce<AssistanceMetadata>((selected, candidate) =>
        candidate.rounds > selected.rounds ? candidate : selected, { kind: 'none', rounds: 0 });
      const operationId = randomUUID();
      const occurredAt = new Date(Math.max(nowMs, Date.parse(session.updatedAt))).toISOString();
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
      let extractionResult: Awaited<ReturnType<typeof runAssessmentExtraction>> | null = null;
      let profile: ReturnType<typeof recordPretestEquationAssessments>['profile'] | undefined;
      if (answerTargetNodeIds.length > 0) {
        extractionResult = await runAssessmentExtraction({
          service: llmService,
          evalCandidates,
          config,
          prompt,
          answer: parsed.data.studentAnswer,
          caseId: referenceCaseId,
          targetNodeIds: answerTargetNodeIds,
          assistance,
          executionMode: workflow.executionMode,
          provider: workflow.provider,
          model: workflow.model,
          ...(workflow.extractionStepId ? { stepId: workflow.extractionStepId } : {}),
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
          targetNodeIds: equationTargetNodeIds,
          assessmentEventIdPrefix: `assessment-${operationId}-equation`,
          assessedAt: occurredAt,
        });
        session = recorded.session;
        profile = recorded.profile;
      }
      sessions.set(session);
      return context.json({
        ...(extractionResult ?? { status: 'deterministic' as const }),
        session,
        profile,
        recordingStatus: 'recorded',
      });
    } catch (error) {
      if (error instanceof ExtractionValidationError && error.category === 'answer-too-long') {
        return context.json({ error: error.message }, 413);
      }
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
      let session = sessions.get(parsed.data.sessionId) ?? createSession({
        id: parsed.data.sessionId,
        now: new Date(nowMs).toISOString(),
        configVersions: sessionConfigVersions(config),
      });
      if (session.configVersions.configDigest !== config.configVersion) {
        return context.json({ error: 'Session config version does not match the current server config' }, 409);
      }
      const questionId = `${trainingCase.id}:${equationSet.id}`;
      const existing = session.events.find((event) =>
        event.kind === 'answer.submitted' && event.attemptId === parsed.data.submissionId);
      if (existing?.kind === 'answer.submitted') {
        const matches = existing.questionId === questionId
          && existing.answer.format === 'text'
          && existing.answer.value === parsed.data.equation;
        return matches
          ? context.json({ status: 'already-recorded', session })
          : context.json({ error: 'Submission id was already used for different content' }, 409);
      }

      const operationId = randomUUID();
      const occurredAt = new Date(Math.max(nowMs, Date.parse(session.updatedAt))).toISOString();
      const recorded = recordEquationAssessment({
        session,
        config,
        equationSetId: equationSet.id,
        answer: {
          id: `answer-${operationId}`,
          occurredAt,
          caseId: trainingCase.id,
          stageId: trainingCase.caseType === 'transfer' ? 'transfer' : 'training',
          attemptId: parsed.data.submissionId,
          questionId,
          value: parsed.data.equation,
        },
        assistance: { kind: 'none', rounds: 0 },
        assessmentEventIdPrefix: `assessment-${operationId}-equation`,
        assessedAt: occurredAt,
      });
      session = recorded.session;
      sessions.set(session);
      return context.json({
        status: 'recorded',
        session,
        profile: recorded.profile,
        assessment: recorded.assessment,
      });
    } catch (error) {
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
