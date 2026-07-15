import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';
import { z } from 'zod';

import { loadAllConfig, ConfigValidationError } from './config/loader';
import { RecordingStore } from './llm/recording-store';
import { createProviderRegistry } from './llm/providers';
import { LLMService } from './llm/service';
import type { LLMProvider, LLMRequest } from './llm/types';
import { loadAllPrompts, loadPrompt, PromptValidationError } from './prompts/loader';
import { loadExternalAsset, loadStaticAsset } from './static-assets';

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

export interface ServerAppOptions {
  contentRoot: string;
  clientRoot: string;
  providers?: Map<string, LLMProvider>;
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

export function createServerApp(options: ServerAppOptions) {
  const app = new Hono();
  const apiToken = options.apiToken ?? randomBytes(32).toString('hex');
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  const recordings = new RecordingStore(options.contentRoot);
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
    if (context.req.header('x-lq-api-token') !== apiToken) {
      return context.json({ error: 'Unauthorized request' }, 401);
    }
    const requestUrl = new URL(context.req.url);
    const origin = context.req.header('origin');
    if (origin && origin !== requestUrl.origin) {
      return context.json({ error: 'Cross-origin request denied' }, 403);
    }
    const mediaType = context.req.header('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return context.json({ error: 'Content-Type must be application/json' }, 415);
    }
    const declaredLength = Number(context.req.header('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBodyBytes) {
      return context.json({ error: 'Request body is too large' }, 413);
    }

    let body: unknown;
    try {
      const bytes = await readBoundedBody(context.req.raw, maxRequestBodyBytes);
      if (!bytes) {
        return context.json({ error: 'Request body is too large' }, 413);
      }
      body = JSON.parse(new TextDecoder().decode(bytes));
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
