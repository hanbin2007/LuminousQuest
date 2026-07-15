import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Ajv from 'ajv';
import { z } from 'zod';

import type { LoadedPrompt } from '../prompts/loader';
import { hashValue } from './cache-key';
import type { LLMRequest, LLMResponse } from './types';
import { defaultRecordingRedactor, type RecordingRedactor } from './redaction';

const promptMetadataSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
  })
  .strict();

const llmResponseSchema = z
  .object({
    content: z.string(),
    model: z.string(),
    structured: z.unknown().optional(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const recordingSchema = z
  .object({
    version: z.literal('llm-recording.v2'),
    recordedAt: z.string().datetime({ offset: true }),
    cacheKey: z.string().optional(),
    metadata: z
      .object({
        configVersion: z.string().trim().min(1),
        schemaVersion: z.string().trim().min(1),
        prompt: promptMetadataSchema,
      })
      .strict(),
    request: z.unknown(),
    response: llmResponseSchema,
  })
  .strict();

const demoScriptSchema = z
  .object({
    version: z.literal('demo-script.v2'),
    steps: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            recording: z.string().trim().min(1),
            resourceRefs: z.array(z.string().trim().min(1)),
            configVersion: z.string().trim().min(1),
            schemaVersion: z.string().trim().min(1),
            schema: z.record(z.string(), z.unknown()).optional(),
            prompt: promptMetadataSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

type DemoScript = z.infer<typeof demoScriptSchema>;
type Recording = z.infer<typeof recordingSchema>;

export interface DemoValidationOptions {
  configVersion?: string;
  prompts?: Record<string, LoadedPrompt>;
  warn?: (message: string) => void;
}

export class RecordingValidationError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${file}: ${field}: ${reason}`);
    this.name = 'RecordingValidationError';
  }
}

async function readJson(relativeFile: string, absoluteFile: string) {
  let source: string;
  try {
    source = await readFile(absoluteFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RecordingValidationError(relativeFile, '$', (error as Error).message);
  }
  if (source.trim().length === 0) {
    throw new RecordingValidationError(relativeFile, '$', 'file is empty');
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new RecordingValidationError(relativeFile, '$', `invalid JSON: ${(error as Error).message}`);
  }
}

function resolveInside(root: string, relativePath: string) {
  if (relativePath.includes('\\')) {
    throw new RecordingValidationError(relativePath, '$', 'path escapes the content directory');
  }
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new RecordingValidationError(relativePath, '$', 'path escapes the content directory');
  }
  return absolute;
}

function replaceResponseImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(replaceResponseImages);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  if (
    typeof object.data === 'string' &&
    typeof object.mediaType === 'string' &&
    object.mediaType.startsWith('image/')
  ) {
    return {
      ...object,
      data: `[IMAGE SHA256:${hashValue(object.data)}]`,
    };
  }
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, replaceResponseImages(entry)]),
  );
}

function parseRecording(relativeFile: string, value: unknown) {
  const parsed = recordingSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecordingValidationError(relativeFile, issue.path.join('.') || '$', issue.message);
  }
  return parsed.data;
}

function recordedRequest(recording: Recording) {
  return recording.request && typeof recording.request === 'object'
    ? recording.request as Partial<LLMRequest>
    : null;
}

export class RecordingStore {
  private readonly recordingsRoot: string;
  private readonly cacheRoot: string;
  private readonly demoRoot: string;
  private validatedManifest: DemoScript | null = null;

  constructor(
    private readonly contentRoot: string,
    private readonly redactor: RecordingRedactor = defaultRecordingRedactor,
  ) {
    this.recordingsRoot = path.join(contentRoot, 'recordings');
    this.cacheRoot = path.join(this.recordingsRoot, 'cache');
    this.demoRoot = path.join(this.recordingsRoot, 'demo');
  }

  async getDevelopment(cacheKey: string): Promise<LLMResponse | null> {
    const relativeFile = path.join('recordings', 'cache', `${cacheKey}.json`);
    const value = await readJson(relativeFile, path.join(this.cacheRoot, `${cacheKey}.json`));
    if (value === null) return null;
    return parseRecording(relativeFile, value).response;
  }

  async saveDevelopment(cacheKey: string, request: LLMRequest, response: LLMResponse) {
    const file = path.join(this.cacheRoot, `${cacheKey}.json`);
    const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const recording = {
      version: 'llm-recording.v2',
      recordedAt: new Date().toISOString(),
      cacheKey,
      metadata: {
        configVersion: request.configVersion,
        schemaVersion: request.schemaVersion,
        prompt: { id: request.prompt.id, version: request.prompt.version },
      },
      request: this.redactor(request),
      response: replaceResponseImages(response),
    };

    await mkdir(this.cacheRoot, { recursive: true });
    try {
      await writeFile(temporaryFile, `${JSON.stringify(recording, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryFile, file);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  async getDemo(stepId: string): Promise<LLMResponse | null> {
    const manifest = this.validatedManifest ?? await this.loadDemoScript(false);
    if (!manifest) return null;
    const step = manifest.steps.find((candidate) => candidate.id === stepId);
    if (!step) return null;
    return (await this.readDemoRecording(step.recording))?.response ?? null;
  }

  async validateDemoAssets(options: DemoValidationOptions = {}) {
    const manifest = await this.loadDemoScript(true);
    if (!manifest) throw new RecordingValidationError('recordings/demo-script.json', '$', 'file is missing');
    const seen = new Set<string>();
    const warn = options.warn ?? console.warn;

    for (const [index, step] of manifest.steps.entries()) {
      if (seen.has(step.id)) {
        throw new RecordingValidationError(
          'recordings/demo-script.json',
          `steps.${index}.id`,
          `duplicate step id ${step.id}`,
        );
      }
      seen.add(step.id);

      const recording = await this.readDemoRecording(step.recording);
      if (!recording) {
        throw new RecordingValidationError(
          'recordings/demo-script.json',
          `steps.${index}.recording`,
          `recording is missing: ${step.recording}`,
        );
      }

      this.warnAboutVersionMismatch(step, index, recording, options, warn);
      this.validateStructuredReplay(step, recording);

      for (const [resourceIndex, resource] of step.resourceRefs.entries()) {
        const absoluteResource = resolveInside(this.contentRoot, resource);
        try {
          const [resolvedRoot, resolvedResource] = await Promise.all([
            realpath(this.contentRoot),
            realpath(absoluteResource),
          ]);
          if (
            resolvedResource !== resolvedRoot &&
            !resolvedResource.startsWith(`${resolvedRoot}${path.sep}`)
          ) {
            throw new Error('resource escapes the content directory');
          }
          const info = await stat(resolvedResource);
          if (!info.isFile()) throw new Error('resource is not a file');
        } catch {
          throw new RecordingValidationError(
            'recordings/demo-script.json',
            `steps.${index}.resourceRefs.${resourceIndex}`,
            `resource is missing or unsafe: ${resource}`,
          );
        }
      }
    }

    this.validatedManifest = manifest;
  }

  private warnAboutVersionMismatch(
    step: DemoScript['steps'][number],
    stepIndex: number,
    recording: Recording,
    options: DemoValidationOptions,
    warn: (message: string) => void,
  ) {
    const warning = (subject: string, recorded: string, current: string) => {
      if (recorded !== current) {
        warn(
          `[startup] WARNING: DEMO REPLAY VERSION MISMATCH for step ${step.id}: ${subject} ` +
            `recorded=${recorded}, current=${current}`,
        );
      }
    };

    if (options.configVersion) {
      warning('config', step.configVersion, options.configVersion);
      warning('recording config', recording.metadata.configVersion, options.configVersion);
    }
    warning('schema', recording.metadata.schemaVersion, step.schemaVersion);
    warning('prompt', recording.metadata.prompt.version, step.prompt.version);

    const currentPrompt = options.prompts?.[step.prompt.id];
    if (options.prompts && !currentPrompt) {
      throw new RecordingValidationError(
        'recordings/demo-script.json',
        `steps.${stepIndex}.prompt.id`,
        `unknown prompt ${step.prompt.id}`,
      );
    }
    if (currentPrompt) warning('current prompt', step.prompt.version, currentPrompt.version);
  }

  private validateStructuredReplay(step: DemoScript['steps'][number], recording: Recording) {
    const request = recordedRequest(recording);
    if (request?.capability !== 'structured' && recording.response.structured === undefined) return;
    const schema = step.schema ?? request?.schema;
    const relativeFile = path.join('recordings', step.recording);
    if (!schema) {
      throw new RecordingValidationError(
        relativeFile,
        'request.schema',
        'structured replay does not include its current schema',
      );
    }

    let structured = recording.response.structured;
    if (structured === undefined) {
      try {
        structured = JSON.parse(recording.response.content);
      } catch {
        throw new RecordingValidationError(
          relativeFile,
          'response.content',
          'structured replay response is not valid JSON',
        );
      }
    }
    try {
      const ajv = new Ajv({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      if (!validate(structured)) {
        throw new RecordingValidationError(
          relativeFile,
          'response.structured',
          `response failed current schema validation: ${ajv.errorsText(validate.errors)}`,
        );
      }
    } catch (error) {
      if (error instanceof RecordingValidationError) throw error;
      throw new RecordingValidationError(relativeFile, 'request.schema', `invalid schema: ${(error as Error).message}`);
    }
  }

  private async readDemoRecording(recordingPath: string) {
    const relativeFile = path.join('recordings', recordingPath);
    const normalized = recordingPath.replaceAll('\\', '/');
    if (!normalized.startsWith('demo/')) {
      throw new RecordingValidationError(relativeFile, '$', 'demo recording must stay inside recordings/demo/');
    }
    const absoluteFile = resolveInside(this.demoRoot, normalized.slice('demo/'.length));
    const value = await readJson(relativeFile, absoluteFile);
    return value === null ? null : parseRecording(relativeFile, value);
  }

  private async loadDemoScript(required: boolean) {
    const relativeFile = path.join('recordings', 'demo-script.json');
    const value = await readJson(relativeFile, path.join(this.recordingsRoot, 'demo-script.json'));
    if (value === null) {
      if (required) throw new RecordingValidationError(relativeFile, '$', 'file is missing');
      return null;
    }
    const parsed = demoScriptSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RecordingValidationError(relativeFile, issue.path.join('.') || '$', issue.message);
    }
    return parsed.data;
  }
}
