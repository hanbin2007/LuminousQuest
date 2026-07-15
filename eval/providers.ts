import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { LLMProvider, LLMRequest, LLMResponse } from '../server/llm/types';
import type { LabeledEvalCase, MetamorphicVariantName } from './schema';

const responseSchema = z
  .object({
    content: z.string(),
    model: z.string(),
    structured: z.unknown().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const evalRecordingSchema = z
  .object({
    version: z.literal('eval-recording.v1'),
    recordedAt: z.string().datetime({ offset: true }),
    metadata: z
      .object({
        caseId: z.string().trim().min(1),
        variant: z.union([z.literal('base'), z.enum(['paraphrase', 'noise', 'rename-person'])]),
        iteration: z.number().int().positive(),
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        prompt: z.object({ id: z.string(), version: z.string() }).strict(),
        configVersion: z.string().trim().min(1),
        schemaVersion: z.string().trim().min(1),
        temperature: z.number().min(0).max(2),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    responses: z.array(responseSchema).min(1),
  })
  .strict();

export type EvalVariant = 'base' | MetamorphicVariantName;

function safeSegment(value: string) {
  const segment = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!segment) throw new Error(`Unsafe empty eval recording segment from ${JSON.stringify(value)}`);
  return segment;
}

export function evalRecordingFile(input: {
  recordingsRoot: string;
  providerId: string;
  caseId: string;
  variant: EvalVariant;
  iteration: number;
}) {
  return path.join(
    input.recordingsRoot,
    safeSegment(input.providerId),
    safeSegment(input.caseId),
    `${safeSegment(input.variant)}-${input.iteration}.json`,
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function requestHash(request: LLMRequest) {
  return createHash('sha256').update(JSON.stringify(canonicalize({
    capability: request.capability,
    provider: request.provider,
    model: request.model,
    prompt: { id: request.prompt.id, version: request.prompt.version },
    schemaVersion: request.schemaVersion,
    configVersion: request.configVersion,
    input: request.input,
    schema: request.schema,
    temperature: request.temperature,
  }))).digest('hex');
}

function evidence(answer: string, quote: string) {
  const start = answer.indexOf(quote);
  if (start < 0) {
    throw new Error(`Golden evidence quote ${JSON.stringify(quote)} is absent from ${JSON.stringify(answer)}`);
  }
  return { quote, start, end: start + quote.length };
}

export function goldenResponse(evalCase: LabeledEvalCase, model: string): LLMResponse {
  const expected = evalCase.expectedExtraction;
  const structured = {
    anchors: [],
    assessments: [{
      nodeId: evalCase.questionRef.nodeId,
      errorIds: expected.errorIds,
      facts: {
        response: expected.response,
        terminology: expected.terminology,
        syllabus: expected.syllabus,
        contradiction: expected.contradiction,
        typo: expected.typo,
        slots: expected.slots.map((slot) => ({
          id: slot.id,
          value: slot.value,
          evidence: evidence(evalCase.studentAnswer, slot.evidenceQuote),
        })),
      },
      evidence: expected.evidenceQuotes.map((quote) => evidence(evalCase.studentAnswer, quote)),
      assistance: { kind: 'none', rounds: 0 },
    }],
  };
  return {
    content: JSON.stringify(structured),
    structured,
    model,
    usage: {
      inputTokens: Math.max(1, Math.ceil(evalCase.studentAnswer.length / 2)),
      outputTokens: Math.max(1, Math.ceil(JSON.stringify(structured).length / 4)),
    },
  };
}

export class GoldenEvalProvider implements LLMProvider {
  constructor(
    readonly id: string,
    private readonly evalCase: LabeledEvalCase,
    private readonly model: string,
  ) {}

  async chat(): Promise<never> { throw new Error('Eval golden provider only supports structured extraction'); }
  async vision(): Promise<never> { throw new Error('Eval golden provider only supports structured extraction'); }
  async structured() { return goldenResponse(this.evalCase, this.model); }
}

export class TrackingEvalProvider implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  readonly responses: LLMResponse[] = [];

  constructor(private readonly provider: LLMProvider) {}

  get id() { return this.provider.id; }

  async chat(request: LLMRequest) { return this.capture(request, () => this.provider.chat(request)); }
  async vision(request: LLMRequest) { return this.capture(request, () => this.provider.vision(request)); }
  async structured(request: LLMRequest) { return this.capture(request, () => this.provider.structured(request)); }

  private async capture(request: LLMRequest, operation: () => Promise<LLMResponse>) {
    this.requests.push(structuredClone(request));
    const response = await operation();
    this.responses.push(structuredClone(response));
    return response;
  }
}

export class ReplayEvalProvider implements LLMProvider {
  private index = 0;

  constructor(
    readonly id: string,
    private readonly recording: z.infer<typeof evalRecordingSchema>,
  ) {}

  async chat(): Promise<never> { throw new Error('Eval replay only supports structured extraction'); }
  async vision(): Promise<never> { throw new Error('Eval replay only supports structured extraction'); }

  async structured(request: LLMRequest) {
    if (requestHash(request) !== this.recording.metadata.requestHash) {
      throw new Error(`Eval recording request mismatch for ${this.recording.metadata.caseId}`);
    }
    const response = this.recording.responses[this.index];
    if (!response) throw new Error(`Eval recording exhausted for ${this.recording.metadata.caseId}`);
    this.index += 1;
    return structuredClone(response);
  }
}

export async function loadEvalRecording(file: string) {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Eval replay recording is missing: ${file}`);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid eval replay JSON ${file}: ${(error as Error).message}`);
  }
  const parsed = evalRecordingSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid eval replay ${file}: ${issue.path.join('.') || '$'}: ${issue.message}`);
  }
  return parsed.data;
}

export async function saveEvalRecording(input: {
  file: string;
  evalCase: LabeledEvalCase;
  variant: EvalVariant;
  iteration: number;
  providerId: string;
  model: string;
  temperature: number;
  requests: readonly LLMRequest[];
  responses: readonly LLMResponse[];
  now?: () => Date;
}) {
  if (input.requests.length === 0 || input.responses.length === 0) return null;
  const request = input.requests[0];
  const payload = evalRecordingSchema.parse({
    version: 'eval-recording.v1',
    recordedAt: (input.now?.() ?? new Date()).toISOString(),
    metadata: {
      caseId: input.evalCase.id,
      variant: input.variant,
      iteration: input.iteration,
      provider: input.providerId,
      model: input.model,
      prompt: { id: request.prompt.id, version: request.prompt.version },
      configVersion: request.configVersion,
      schemaVersion: request.schemaVersion,
      temperature: input.temperature,
      requestHash: requestHash(request),
    },
    responses: input.responses,
  });
  const temporary = `${input.file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(input.file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, input.file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return input.file;
}

