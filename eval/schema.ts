import { z } from 'zod';

export const evalOutcomeSchema = z.enum([
  'hit',
  'partial',
  'miss',
  'unanswered',
  'needs-review',
]);

export const metamorphicVariantSchema = z.enum([
  'paraphrase',
  'noise',
  'rename-person',
]);

const questionReferenceSchema = z
  .object({
    caseId: z.string().trim().min(1),
    nodeId: z.string().trim().min(1),
    equationSetId: z.string().trim().min(1).optional(),
  })
  .strict();

const expectedExtractionSchema = z
  .object({
    response: z.enum(['substantive', 'blank', 'non-answer']),
    terminology: z.enum(['model', 'colloquial']),
    syllabus: z.enum(['within', 'beyond']),
    contradiction: z.boolean(),
    typo: z.enum(['none', 'unambiguous', 'ambiguous']),
    errorIds: z.array(z.string().trim().min(1)),
    slots: z.array(
      z
        .object({
          id: z.string().trim().min(1),
          value: z.string().trim().min(1),
          evidenceQuote: z.string().min(1),
        })
        .strict(),
    ),
    evidenceQuotes: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.slots.forEach((slot, index) => {
      if (ids.has(slot.id)) {
        context.addIssue({
          code: 'custom',
          path: ['slots', index, 'id'],
          message: `duplicate expected slot ${slot.id}`,
        });
      }
      ids.add(slot.id);
    });
  });

const correctedProvenanceSchema = z
  .object({
    configDigest: z.string().trim().min(1),
    thresholds: z
      .object({
        maxEditDistanceRatio: z.number().min(0).max(1),
        normalizationCandidateMaxEditDistanceRatio: z.number().min(0).max(1),
      })
      .strict(),
    prompt: z
      .object({ id: z.string().trim().min(1), version: z.string().trim().min(1) })
      .strict(),
    schemaVersion: z.string().trim().min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
  })
  .strict();

const candidateImportSchema = z
  .object({
    stableHash: z.string().regex(/^[a-f0-9]{64}$/),
    originalCategory: z.string().trim().min(1),
    currentCategory: z.string().trim().min(1),
    requiresHumanAudit: z.literal(true),
    provenance: correctedProvenanceSchema,
  })
  .strict();

const evalCaseBase = z.object({
  version: z.literal('eval-case.v1'),
  evaluationPath: z.enum(['structured-assessment', 'equation']).default('structured-assessment'),
  id: z.string().trim().min(1),
  questionRef: questionReferenceSchema,
  studentAnswer: z.string(),
  rubricVersion: z.string().trim().min(1),
  source: z.enum(['synthetic', 'human', 'exam']),
  misconceptionIds: z.array(z.string().trim().min(1)),
  tags: z.array(z.string().trim().min(1)),
  seriousMisjudgmentOpportunity: z.boolean(),
  runs: z.number().int().min(1).max(20).optional(),
});

export const labeledEvalCaseSchema = evalCaseBase
  .extend({
    annotationStatus: z.literal('labeled'),
    expectedExtraction: expectedExtractionSchema,
    expectedScore: evalOutcomeSchema,
    annotator: z.string().trim().min(1),
    candidateImport: candidateImportSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.evaluationPath === 'equation' && value.questionRef.equationSetId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['questionRef', 'equationSetId'],
        message: 'is required for equation eval cases',
      });
    }
    if (
      value.evaluationPath === 'equation'
      && !value.expectedExtraction.slots.some((slot) => slot.id === 'equation')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expectedExtraction', 'slots'],
        message: 'equation eval cases require an equation slot',
      });
    }
  });

export const pendingEvalCaseSchema = evalCaseBase
  .extend({
    annotationStatus: z.literal('pending'),
    expectedExtraction: z.null(),
    expectedScore: z.null(),
    annotator: z.null(),
    candidateImport: candidateImportSchema,
  })
  .strict();

export const evalCaseSchema = z.discriminatedUnion('annotationStatus', [
  labeledEvalCaseSchema,
  pendingEvalCaseSchema,
]);

export const evalConfigSchema = z
  .object({
    version: z.literal('eval-config.v1'),
    defaultRuns: z.number().int().min(1).max(20).default(3),
    temperature: z.number().min(0).max(1).default(0.1),
    thresholds: z
      .object({
        nodeMacroAccuracy: z.number().min(0).max(1),
        severeFalseMasteryRate: z.number().min(0).max(1),
        citationHallucinationRate: z.number().min(0).max(1),
        schemaFailureRate: z.number().min(0).max(1),
        metamorphicInvariantRate: z.number().min(0).max(1),
      })
      .strict(),
    metamorphic: z
      .object({
        enabled: z.boolean(),
        variants: z.array(metamorphicVariantSchema).min(1),
      })
      .strict(),
    pricing: z
      .object({
        inputUsdPerMillionTokens: z.number().nonnegative().nullable(),
        outputUsdPerMillionTokens: z.number().nonnegative().nullable(),
      })
      .strict(),
    coverage: z
      .object({
        minimumCases: z.number().int().positive(),
        minimumCasesPerNode: z.number().int().positive(),
        minimumCasesPerMisconception: z.number().int().positive(),
      })
      .strict(),
    live: z
      .object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

export const evalObservationSchema = z
  .object({
    caseId: z.string().trim().min(1),
    nodeId: z.string().trim().min(1),
    variant: z.union([z.literal('base'), metamorphicVariantSchema]),
    iteration: z.number().int().positive(),
    expectedScore: evalOutcomeSchema,
    predictedScore: evalOutcomeSchema,
    extractionExact: z.boolean().nullable(),
    resultSignature: z.string(),
    source: z.enum([
      'provider',
      'development-cache',
      'demo-recording',
      'fallback',
      'deterministic-engine',
    ]),
    failureReason: z.string().optional(),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().nullable(),
    citationHallucination: z.boolean(),
    schemaFailure: z.boolean(),
  })
  .strict();

export type EvalOutcome = z.infer<typeof evalOutcomeSchema>;
export type MetamorphicVariantName = z.infer<typeof metamorphicVariantSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type LabeledEvalCase = z.infer<typeof labeledEvalCaseSchema>;
export type PendingEvalCase = z.infer<typeof pendingEvalCaseSchema>;
export type EvalConfig = z.infer<typeof evalConfigSchema>;
export type EvalObservation = z.infer<typeof evalObservationSchema>;
