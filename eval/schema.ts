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
    anchors: z.array(
      z
        .object({
          anchorId: z.string().trim().min(1),
          facts: z.array(
            z
              .object({
                id: z.string().trim().min(1),
                value: z.string().trim().min(1),
                evidenceQuote: z.string().min(1),
              })
              .strict(),
          ).min(1),
          evidenceQuotes: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
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
    const anchorIds = new Set<string>();
    value.anchors.forEach((anchor, anchorIndex) => {
      if (anchorIds.has(anchor.anchorId)) {
        context.addIssue({
          code: 'custom',
          path: ['anchors', anchorIndex, 'anchorId'],
          message: `duplicate expected anchor ${anchor.anchorId}`,
        });
      }
      anchorIds.add(anchor.anchorId);
      const factIds = new Set<string>();
      anchor.facts.forEach((fact, factIndex) => {
        if (factIds.has(fact.id)) {
          context.addIssue({
            code: 'custom',
            path: ['anchors', anchorIndex, 'facts', factIndex, 'id'],
            message: `duplicate expected anchor fact ${fact.id}`,
          });
        }
        factIds.add(fact.id);
      });
    });
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

const annotationRationaleSchema = z
  .object({
    rubricRefs: z.array(z.string().trim().min(1)).min(1),
    adjudicationRefs: z.array(z.string().regex(/^§\d+[a-z]?$/u)).min(1),
    text: z.string().trim().min(1),
  })
  .strict();

const metamorphicVariantReviewSchema = z
  .object({
    status: z.enum(['approved', 'not-applicable']),
    rationale: z.string().trim().min(1),
  })
  .strict();

const metamorphicReviewSchema = z
  .object({
    reviewer: z.string().trim().min(1),
    status: z.literal('approved'),
    variants: z
      .object({
        paraphrase: metamorphicVariantReviewSchema,
        noise: metamorphicVariantReviewSchema,
        'rename-person': metamorphicVariantReviewSchema,
      })
      .strict(),
  })
  .strict();

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
  version: z.literal('eval-case.v2'),
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
    reviewer: z.string().trim().min(1),
    reviewStatus: z.literal('reviewed'),
    adjudicationVersion: z.literal('adjudication-table.v1.1'),
    rationale: annotationRationaleSchema,
    expectedDisagreement: z.literal(false),
    metamorphicReview: metamorphicReviewSchema,
    candidateImport: candidateImportSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.annotator === value.reviewer) {
      context.addIssue({
        code: 'custom',
        path: ['reviewer'],
        message: 'reviewer must be independent from annotator',
      });
    }
    if (value.metamorphicReview.reviewer !== value.reviewer) {
      context.addIssue({
        code: 'custom',
        path: ['metamorphicReview', 'reviewer'],
        message: 'metamorphic reviewer must match the case reviewer',
      });
    }
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
    version: z.literal('eval-config.v2'),
    defaultRuns: z.number().int().min(1).max(20).default(3),
    thresholds: z
      .object({
        nodeMacroAccuracy: z.number().min(0).max(1),
        severeFalseMasteryRate: z.number().min(0).max(1),
        citationHallucinationRate: z.number().min(0).max(1),
        schemaFailureRate: z.number().min(0).max(1),
        metamorphicInvariantRate: z.number().min(0).max(1),
        scoreConsistencyRate: z.number().min(0).max(1),
      })
      .strict(),
    metamorphic: z
      .object({
        enabled: z.literal(true),
        variants: z.array(metamorphicVariantSchema).min(1),
      })
      .strict(),
    pricing: z
      .object({
        inputUsdPerMillionTokens: z.number().nonnegative().nullable(),
        outputUsdPerMillionTokens: z.number().nonnegative().nullable(),
      })
      .strict(),
    corpus: z
      .object({
        stage: z.enum(['seed', 'complete']),
      })
      .strict(),
    live: z
      .object({
        provider: z.string().trim().min(1),
        model: z.string().trim().min(1),
        pilotCases: z.number().int().min(1).max(20),
        minimumClosedSetComplianceRate: z.number().min(0).max(1),
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
    expectedErrorIds: z.array(z.string().trim().min(1)),
    predictedErrorIds: z.array(z.string().trim().min(1)),
    errorIdsExact: z.boolean(),
    extractionAttempted: z.boolean(),
    extractionExact: z.boolean(),
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
    closedSetFailure: z.boolean(),
  })
  .strict();

export const evalHoldoutManifestSchema = z
  .object({
    version: z.literal('eval-holdout-manifest.v1'),
    files: z.array(
      z
        .object({
          path: z.string().regex(/^cases\/[a-zA-Z0-9._/-]+\.json$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set<string>();
    value.files.forEach((entry, index) => {
      if (entry.path.split('/').includes('..')) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: 'holdout path cannot traverse parent directories',
        });
      }
      if (paths.has(entry.path)) {
        context.addIssue({
          code: 'custom',
          path: ['files', index, 'path'],
          message: `duplicate holdout manifest path ${entry.path}`,
        });
      }
      paths.add(entry.path);
    });
  });

export type EvalOutcome = z.infer<typeof evalOutcomeSchema>;
export type MetamorphicVariantName = z.infer<typeof metamorphicVariantSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type LabeledEvalCase = z.infer<typeof labeledEvalCaseSchema>;
export type PendingEvalCase = z.infer<typeof pendingEvalCaseSchema>;
export type EvalConfig = z.infer<typeof evalConfigSchema>;
export type EvalObservation = z.infer<typeof evalObservationSchema>;
export type EvalHoldoutManifest = z.infer<typeof evalHoldoutManifestSchema>;
