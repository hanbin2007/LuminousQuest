import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { LLMRequest, LLMResponse } from './types';
import { defaultRecordingRedactor, type RecordingRedactor } from './redaction';

const llmResponseSchema = z.object({
  content: z.string(),
  model: z.string(),
  structured: z.unknown().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
    })
    .optional(),
});

const recordingSchema = z.object({
  version: z.literal('llm-recording.v1'),
  recordedAt: z.string().datetime({ offset: true }),
  cacheKey: z.string().optional(),
  request: z.unknown(),
  response: llmResponseSchema,
});

const demoScriptSchema = z.object({
  version: z.literal('demo-script.v1'),
  steps: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        recording: z.string().trim().min(1),
        resourceRefs: z.array(z.string().trim().min(1)),
      }),
    )
    .min(1),
});

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
  const absolute = path.resolve(root, relativePath);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(normalizedRoot)) {
    throw new RecordingValidationError(relativePath, '$', 'path escapes the content directory');
  }
  return absolute;
}

export class RecordingStore {
  private readonly recordingsRoot: string;

  constructor(
    private readonly contentRoot: string,
    private readonly redactor: RecordingRedactor = defaultRecordingRedactor,
  ) {
    this.recordingsRoot = path.join(contentRoot, 'recordings');
  }

  async getDevelopment(cacheKey: string): Promise<LLMResponse | null> {
    const relativeFile = path.join('recordings', 'cache', `${cacheKey}.json`);
    const value = await readJson(relativeFile, path.join(this.contentRoot, relativeFile));
    if (value === null) return null;
    const parsed = recordingSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RecordingValidationError(relativeFile, issue.path.join('.') || '$', issue.message);
    }
    return parsed.data.response;
  }

  async saveDevelopment(cacheKey: string, request: LLMRequest, response: LLMResponse) {
    const directory = path.join(this.recordingsRoot, 'cache');
    const file = path.join(directory, `${cacheKey}.json`);
    const temporaryFile = `${file}.${process.pid}.tmp`;
    const recording = this.redactor({
      version: 'llm-recording.v1',
      recordedAt: new Date().toISOString(),
      cacheKey,
      request,
      response,
    });

    await mkdir(directory, { recursive: true });
    await writeFile(temporaryFile, `${JSON.stringify(recording, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryFile, file);
  }

  async getDemo(stepId: string): Promise<LLMResponse | null> {
    const manifest = await this.loadDemoScript(false);
    if (!manifest) return null;
    const step = manifest.steps.find((candidate) => candidate.id === stepId);
    if (!step) return null;

    const relativeFile = path.join('recordings', step.recording);
    const absoluteFile = resolveInside(this.contentRoot, relativeFile);
    const value = await readJson(relativeFile, absoluteFile);
    if (value === null) return null;
    const parsed = recordingSchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RecordingValidationError(relativeFile, issue.path.join('.') || '$', issue.message);
    }
    return parsed.data.response;
  }

  async validateDemoAssets() {
    const manifest = await this.loadDemoScript(true);
    if (!manifest) throw new RecordingValidationError('recordings/demo-script.json', '$', 'file is missing');
    const seen = new Set<string>();

    for (const [index, step] of manifest.steps.entries()) {
      if (seen.has(step.id)) {
        throw new RecordingValidationError(
          'recordings/demo-script.json',
          `steps.${index}.id`,
          `duplicate step id ${step.id}`,
        );
      }
      seen.add(step.id);

      if (!(await this.getDemo(step.id))) {
        throw new RecordingValidationError(
          'recordings/demo-script.json',
          `steps.${index}.recording`,
          `recording is missing: ${step.recording}`,
        );
      }

      for (const [resourceIndex, resource] of step.resourceRefs.entries()) {
        const absoluteResource = resolveInside(this.contentRoot, resource);
        try {
          await stat(absoluteResource);
        } catch {
          throw new RecordingValidationError(
            'recordings/demo-script.json',
            `steps.${index}.resourceRefs.${resourceIndex}`,
            `resource is missing: ${resource}`,
          );
        }
      }
    }
  }

  private async loadDemoScript(required: boolean) {
    const relativeFile = path.join('recordings', 'demo-script.json');
    const value = await readJson(relativeFile, path.join(this.contentRoot, relativeFile));
    if (value === null) {
      if (required) {
        throw new RecordingValidationError(relativeFile, '$', 'file is missing');
      }
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

