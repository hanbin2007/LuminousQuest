import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExtractionValidationCategory } from '../../shared/workflows/extraction-validation';
import { defaultRecordingRedactor, type RecordingRedactor } from './redaction';

export interface ExtractionEvalCandidate {
  category: ExtractionValidationCategory;
  answer: string;
  detail: Record<string, unknown>;
}

export interface EvalCandidateWriter {
  record(candidate: ExtractionEvalCandidate): Promise<string>;
}

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const phonePattern = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g;
const identifierPattern = /(?<!\d)\d{15,18}[\dXx]?(?!\d)/g;

function redactPersonalText(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(emailPattern, '[REDACTED_EMAIL]')
      .replace(phonePattern, '[REDACTED_PHONE]')
      .replace(identifierPattern, '[REDACTED_ID]');
  }
  if (Array.isArray(value)) return value.map(redactPersonalText);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, redactPersonalText(entry)]),
    );
  }
  return value;
}

export class EvalCandidateStore implements EvalCandidateWriter {
  private readonly directory: string;

  constructor(
    contentRoot: string,
    private readonly redactor: RecordingRedactor = defaultRecordingRedactor,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = path.join(contentRoot, 'recordings', 'eval-candidates');
  }

  async record(candidate: ExtractionEvalCandidate) {
    const recordedAt = this.now().toISOString();
    const id = randomUUID();
    const fileName = `${recordedAt.replaceAll(':', '-')}-${candidate.category}-${id}.json`;
    const file = path.join(this.directory, fileName);
    const temporaryFile = `${file}.${process.pid}.tmp`;
    const payload = redactPersonalText(this.redactor({
      version: 'eval-candidate.v1',
      recordedAt,
      category: candidate.category,
      sample: {
        answer: candidate.answer,
        modelQuote: candidate.detail.modelQuote ?? null,
      },
      context: Object.fromEntries(
        Object.entries(candidate.detail).filter(([key]) => key !== 'modelQuote'),
      ),
    }));

    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryFile, file);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
    return file;
  }
}
