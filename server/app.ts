import { Hono } from 'hono';
import { z } from 'zod';

import { loadAllConfig, ConfigValidationError } from './config/loader';
import { RecordingStore, RecordingValidationError } from './llm/recording-store';
import { createProviderRegistry } from './llm/providers';
import { LLMService } from './llm/service';
import type { LLMProvider, LLMRequest } from './llm/types';
import { loadStaticAsset } from './static-assets';

const llmRequestSchema = z
  .object({
    executionMode: z.enum(['live', 'development', 'demo']),
    capability: z.enum(['chat', 'vision', 'structured']),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    prompt: z.object({
      id: z.string().trim().min(1),
      version: z.string().trim().min(1),
      text: z.string().min(1),
    }),
    schemaVersion: z.string().trim().min(1),
    configVersion: z.string().trim().min(1),
    input: z.unknown(),
    images: z
      .array(
        z.object({
          mediaType: z.string().regex(/^image\//),
          data: z.string().min(1),
        }),
      )
      .default([]),
    schema: z.record(z.string(), z.unknown()).optional(),
    stepId: z.string().trim().min(1).optional(),
  })
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

export interface ServerAppOptions {
  contentRoot: string;
  clientRoot: string;
  providers?: Map<string, LLMProvider>;
}

function externalDataError(error: ConfigValidationError | RecordingValidationError) {
  return {
    error: error.name,
    file: error.file,
    field: error.field,
    reason: error.reason,
  };
}

export function createServerApp(options: ServerAppOptions) {
  const app = new Hono();
  const recordings = new RecordingStore(options.contentRoot);
  const llmService = new LLMService({
    providers: options.providers ?? createProviderRegistry(),
    recordings,
  });

  app.get('/api/config', async (context) => {
    try {
      return context.json(await loadAllConfig(options.contentRoot));
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return context.json(externalDataError(error), 500);
      }
      throw error;
    }
  });

  app.post('/api/llm', async (context) => {
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'Request body must be valid JSON' }, 400);
    }
    const parsed = llmRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: 'Invalid LLM request',
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || '$',
            reason: issue.message,
          })),
        },
        400,
      );
    }

    try {
      return context.json(await llmService.execute(parsed.data as LLMRequest));
    } catch (error) {
      if (error instanceof RecordingValidationError) {
        return context.json(externalDataError(error), 500);
      }
      throw error;
    }
  });

  app.all('/api/*', (context) => context.json({ error: 'API route not found' }, 404));

  app.get('*', async (context) => {
    const asset = await loadStaticAsset(options.clientRoot, new URL(context.req.url).pathname);
    if (!asset) return context.text('Frontend build not found', 404);
    context.header('content-type', asset.contentType);
    context.header('cache-control', asset.isIndex ? 'no-cache' : 'public, max-age=31536000, immutable');
    return context.body(asset.body);
  });

  app.onError((error, context) => {
    console.error('[server] unhandled request error:', error.message);
    return context.json({ error: 'Internal server error' }, 500);
  });

  return app;
}

