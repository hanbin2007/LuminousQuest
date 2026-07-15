import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import {
  classifyCitationCandidate,
  quoteExpressesFactValue,
} from '../shared/workflows/extraction-validation';
import { loadAllConfig } from '../server/config/loader';
import { loadPrompt } from '../server/prompts/loader';
import { pendingEvalCaseSchema } from './schema';

const candidateSchema = z
  .object({
    version: z.literal('eval-candidate.v2'),
    recordedAt: z.string().datetime({ offset: true }),
    stableHash: z.string().regex(/^[a-f0-9]{64}$/),
    category: z.string().trim().min(1),
    provenance: z
      .object({
        configDigest: z.string(),
        thresholds: z.record(z.string(), z.unknown()),
        prompt: z.object({ id: z.string(), version: z.string() }).strict(),
        schemaVersion: z.string(),
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
      })
      .strict(),
    sample: z
      .object({
        answer: z.string(),
        modelQuote: z.string().nullable(),
      })
      .strict(),
    context: z.record(z.string(), z.unknown()),
    distribution: z.object({ requiresHumanAudit: z.literal(true) }).strict(),
  })
  .strict();

function currentCategory(input: {
  original: string;
  answer: string;
  modelQuote: string | null;
  context: Record<string, unknown>;
  commonTypos: Record<string, string>;
  normalizationCandidateMaxEditDistanceRatio: number;
  aliases: Record<string, string[]>;
}) {
  if (input.modelQuote === null) return input.original;
  const citation = classifyCitationCandidate({
    answer: input.answer,
    quote: input.modelQuote,
    commonTypos: input.commonTypos,
    normalizationCandidateMaxEditDistanceRatio:
      input.normalizationCandidateMaxEditDistanceRatio,
  });
  if (citation.classification !== 'grounded') return citation.classification;
  if (typeof input.context.slotValue === 'string' && !quoteExpressesFactValue({
    quote: input.modelQuote,
    value: input.context.slotValue,
    aliases: input.aliases,
    commonTypos: input.commonTypos,
  })) return 'fact-grounding';
  return input.original;
}

export async function importEvalCandidates(input: {
  contentRoot: string;
  candidateDirectory?: string;
  outputDirectory?: string;
}) {
  const candidateDirectory = input.candidateDirectory
    ?? path.join(input.contentRoot, 'recordings', 'eval-candidates');
  const outputDirectory = input.outputDirectory
    ?? path.join(input.contentRoot, 'eval', 'cases', 'imported');
  const [config, prompt, files] = await Promise.all([
    loadAllConfig(input.contentRoot),
    loadPrompt(input.contentRoot, 'structured-assessment'),
    readdir(candidateDirectory),
  ]);
  if (!prompt) throw new Error('Required prompt structured-assessment is missing');
  const imported: string[] = [];
  const skipped: Array<{ file: string; reason: string }> = [];
  const citation = config.scaffoldPolicy.extraction.citation;

  for (const name of files.filter((file) => file.endsWith('.json')).sort()) {
    const sourceFile = path.join(candidateDirectory, name);
    try {
      const parsed = candidateSchema.parse(JSON.parse(await readFile(sourceFile, 'utf8')));
      const caseId = typeof parsed.context.caseId === 'string' ? parsed.context.caseId : null;
      const nodeId = typeof parsed.context.nodeId === 'string' ? parsed.context.nodeId : null;
      const trainingCase = config.cases.find((entry) => entry.id === caseId);
      const evidencePath = trainingCase?.evidencePaths.find((entry) =>
        entry.source === 'answer' && entry.nodeId === nodeId);
      if (!caseId || !nodeId || !trainingCase || !evidencePath) {
        throw new Error('candidate lacks a valid caseId/nodeId on the answer-extraction path');
      }
      const reclassified = currentCategory({
        original: parsed.category,
        answer: parsed.sample.answer,
        modelQuote: parsed.sample.modelQuote,
        context: parsed.context,
        commonTypos: citation.commonTypos,
        normalizationCandidateMaxEditDistanceRatio:
          citation.normalizationCandidateMaxEditDistanceRatio,
        aliases: config.scaffoldPolicy.extraction.factValueAliases,
      });
      const pending = pendingEvalCaseSchema.parse({
        version: 'eval-case.v1',
        annotationStatus: 'pending',
        id: `m1b-${parsed.stableHash.slice(0, 16)}`,
        questionRef: { caseId, nodeId },
        studentAnswer: parsed.sample.answer,
        expectedExtraction: null,
        expectedScore: null,
        annotator: null,
        rubricVersion: config.rubrics.version,
        source: 'human',
        misconceptionIds: [],
        tags: ['imported-eval-candidate', reclassified],
        seriousMisjudgmentOpportunity: false,
        candidateImport: {
          stableHash: parsed.stableHash,
          originalCategory: parsed.category,
          currentCategory: reclassified,
          requiresHumanAudit: true,
          provenance: {
            configDigest: config.configVersion,
            thresholds: {
              maxEditDistanceRatio: citation.maxEditDistanceRatio,
              normalizationCandidateMaxEditDistanceRatio:
                citation.normalizationCandidateMaxEditDistanceRatio,
            },
            prompt: { id: prompt.id, version: prompt.version },
            schemaVersion: 'structured-assessment.v4',
            provider: parsed.provenance.provider,
            model: parsed.provenance.model,
          },
        },
      });
      const destination = path.join(outputDirectory, `${pending.id}.pending.json`);
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(outputDirectory, { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      imported.push(destination);
    } catch (error) {
      skipped.push({ file: sourceFile, reason: (error as Error).message });
    }
  }
  return { imported, skipped };
}
