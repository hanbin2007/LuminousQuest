import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExtractionValidationCategory } from '../../shared/workflows/extraction-validation';
import { hashValue } from './cache-key';
import {
  defaultRecordingRedactor,
  redactPersonalText,
  type RecordingRedactor,
} from './redaction';

export interface EvalCandidateProvenance {
  configDigest: string;
  thresholds: {
    maxEditDistanceRatio: number;
    normalizationCandidateMaxEditDistanceRatio: number;
  };
  prompt: { id: string; version: string };
  schemaVersion: string;
  provider: string;
  model: string;
}

export interface ExtractionEvalCandidate {
  category: ExtractionValidationCategory;
  answer: string;
  detail: Record<string, unknown>;
  provenance: EvalCandidateProvenance;
}

export interface EvalCandidateWriter {
  record(candidate: ExtractionEvalCandidate): Promise<string>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
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
    const body = redactPersonalText(this.redactor({
      category: candidate.category,
      provenance: candidate.provenance,
      sample: {
        answer: candidate.answer,
        modelQuote: candidate.detail.modelQuote ?? null,
      },
      context: Object.fromEntries(
        Object.entries(candidate.detail).filter(([key]) => key !== 'modelQuote'),
      ),
    })) as Record<string, unknown>;
    const payload = {
      version: 'eval-candidate.v2',
      recordedAt,
      stableHash: hashValue(JSON.stringify(canonicalize(body))),
      ...body,
      distribution: { requiresHumanAudit: true },
    };

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
