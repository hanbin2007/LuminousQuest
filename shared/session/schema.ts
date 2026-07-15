import { z } from 'zod';

import { functionalRoleSchema } from '../config/schemas';

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(1);

const workflowIdentityShape = {
  caseId: identifierSchema,
  stageId: identifierSchema,
  attemptId: identifierSchema,
};

const eventBaseShape = {
  schemaVersion: z.literal('event.v2'),
  id: identifierSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  ...workflowIdentityShape,
};

const answerPayloadSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('text'), value: z.string() }).strict(),
  z
    .object({
      format: z.literal('builder'),
      value: z
        .object({
          components: z.array(
            z
              .object({
                instanceId: identifierSchema,
                componentId: identifierSchema,
                x: z.number().finite(),
                y: z.number().finite(),
                label: z.string().optional(),
                assignedRole: functionalRoleSchema.optional(),
                materialBinding: z
                  .object({
                    materialId: identifierSchema,
                    specificity: z.enum(['generic', 'specific']),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          ),
          connections: z.array(
            z
              .object({
                id: identifierSchema.optional(),
                from: identifierSchema,
                to: identifierSchema,
                kind: z.enum(['electron-path', 'ion-path']),
                carrier: z.enum(['electron', 'cation', 'anion']).optional(),
              })
              .strict(),
          ),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      format: z.literal('canvas'),
      value: z
        .object({
          dataUrl: z.string().startsWith('data:image/'),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .strict(),
    })
    .strict(),
]);

export const answerSubmittedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('answer.submitted'),
    pipelineStage: z.literal('answer'),
    questionId: identifierSchema,
    answer: answerPayloadSchema,
  })
  .strict();

const extractionProvenanceSchema = z
  .object({
    promptId: identifierSchema,
    promptVersion: identifierSchema,
    cacheKey: identifierSchema,
  })
  .strict();

const evidenceSchema = z
  .object({
    quote: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((evidence) => evidence.end >= evidence.start, {
    path: ['end'],
    message: 'evidence end cannot precede start',
  });

const assistanceMetadataSchema = z
  .object({
    kind: z.enum(['none', 'hint', 'socratic']),
    rounds: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'none' && value.rounds !== 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'unassisted assessment requires zero rounds' });
    }
    if (value.kind !== 'none' && value.rounds === 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'assisted assessment requires at least one round' });
    }
  });

const assessedExtractionSchema = z
  .object({
    status: z.literal('assessed'),
    evidence: z.array(evidenceSchema),
    model: identifierSchema,
    provenance: extractionProvenanceSchema,
  })
  .strict();

const needsReviewExtractionSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
    model: identifierSchema,
    provenance: extractionProvenanceSchema,
  })
  .strict();

const unassessedExtractionSchema = z
  .object({
    status: z.literal('unassessed'),
    reason: z.string().trim().min(1),
    model: identifierSchema.optional(),
    provenance: extractionProvenanceSchema,
  })
  .strict();

const assessedRuleDecisionSchema = z
  .object({
    status: z.enum(['hit', 'hit-with-help', 'partial', 'miss']),
    ruleId: identifierSchema,
    reason: z.string().trim().min(1),
    engine: z
      .object({
        id: identifierSchema,
        version: identifierSchema,
        sourceRuleId: identifierSchema.optional(),
      })
      .strict()
      .default({ id: 'legacy-rule', version: 'legacy.v1' }),
  })
  .strict();

const needsReviewRuleDecisionSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedRuleDecisionSchema = z
  .object({
    status: z.literal('unassessed'),
    reason: z.string().trim().min(1),
  })
  .strict();

const assessedFollowingSchema = z
  .object({
    status: z.enum(['followed', 'not-followed']),
    anchorNodeId: identifierSchema.nullable(),
    anchorOutcome: z.enum(['hit', 'partial', 'miss']).nullable().default(null),
    policy: z
      .enum(['score-logical-chain', 'score-objective-fact'])
      .default('score-logical-chain'),
  })
  .strict();

const needsReviewFollowingSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedFollowingSchema = z.object({ status: z.literal('unassessed') }).strict();

const scoredSchema = z
  .object({
    status: z.literal('scored'),
    earned: z.number().nonnegative(),
    possible: z.number().positive(),
    annotations: z.array(z.enum(['following', 'hit-with-help'])).default([]),
    outcome: z.enum(['hit', 'hit-with-help', 'partial', 'miss']).optional(),
  })
  .strict()
  .refine((score) => score.earned <= score.possible, {
    message: 'earned score cannot exceed possible score',
    path: ['earned'],
  });

const needsReviewScoreSchema = z
  .object({
    status: z.literal('needs-review'),
    reason: z.string().trim().min(1),
  })
  .strict();

const unassessedScoreSchema = z.object({ status: z.literal('unassessed') }).strict();

const assessmentPipelineStageSchema = z.enum(['extraction', 'rule', 'following', 'score']);

export const assessmentCompletedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('assessment.completed'),
    pipelineStage: assessmentPipelineStageSchema,
    sourceAnswerEventId: identifierSchema,
    nodeId: identifierSchema,
    rubric: z.object({ id: identifierSchema, version: identifierSchema }).strict(),
    assistance: assistanceMetadataSchema.default({ kind: 'none', rounds: 0 }),
    extraction: z.union([
      assessedExtractionSchema,
      needsReviewExtractionSchema,
      unassessedExtractionSchema,
    ]),
    ruleDecision: z.union([
      assessedRuleDecisionSchema,
      needsReviewRuleDecisionSchema,
      unassessedRuleDecisionSchema,
    ]),
    following: z.union([
      assessedFollowingSchema,
      needsReviewFollowingSchema,
      unassessedFollowingSchema,
    ]),
    score: z.union([scoredSchema, needsReviewScoreSchema, unassessedScoreSchema]),
  })
  .strict()
  .superRefine((event, context) => {
    const issue = (field: 'extraction' | 'ruleDecision' | 'following' | 'score', message: string) => {
      context.addIssue({ code: 'custom', path: [field, 'status'], message });
    };
    const extractionAssessed = event.extraction.status === 'assessed';
    const ruleAssessed = ['hit', 'hit-with-help', 'partial', 'miss'].includes(event.ruleDecision.status);
    const followingAssessed = ['followed', 'not-followed'].includes(event.following.status);

    if (event.pipelineStage === 'extraction') {
      if (event.ruleDecision.status !== 'unassessed') issue('ruleDecision', 'must remain unassessed at extraction stage');
      if (event.following.status !== 'unassessed') issue('following', 'must remain unassessed at extraction stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at extraction stage');
      return;
    }

    if (!extractionAssessed) {
      issue('extraction', `must be assessed before ${event.pipelineStage} stage`);
    }

    if (event.pipelineStage === 'rule') {
      if (event.ruleDecision.status === 'unassessed') issue('ruleDecision', 'must be decided or need review at rule stage');
      if (event.following.status !== 'unassessed') issue('following', 'must remain unassessed at rule stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at rule stage');
      return;
    }

    if (!ruleAssessed) {
      issue('ruleDecision', `must be assessed before ${event.pipelineStage} stage`);
    }

    if (event.pipelineStage === 'following') {
      if (event.following.status === 'unassessed') issue('following', 'must be decided or need review at following stage');
      if (event.score.status !== 'unassessed') issue('score', 'must remain unassessed at following stage');
      return;
    }

    if (!followingAssessed) issue('following', 'must be assessed before score stage');
    if (event.score.status === 'unassessed') issue('score', 'must be scored or need review at score stage');
    if (event.score.status === 'scored' && followingAssessed) {
      const hasFollowingAnnotation = event.score.annotations.includes('following');
      if (event.following.status === 'followed') {
        if (event.following.anchorNodeId === null || event.following.anchorOutcome === null) {
          issue('following', 'followed status requires an anchor and anchor outcome');
        }
        if (!hasFollowingAnnotation) issue('score', 'followed status requires following annotation');
      } else if (hasFollowingAnnotation) {
        issue('score', 'following annotation requires followed status');
      }
      if (
        event.score.annotations.includes('hit-with-help')
        && !['hit', 'hit-with-help'].includes(event.ruleDecision.status)
      ) {
        issue('score', 'hit-with-help annotation requires a hit rule decision');
      }
    }
  });

export const polarityAssessedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('polarity.assessed'),
    pipelineStage: z.literal('rule'),
    sourceAnswerEventId: identifierSchema,
    anchorId: identifierSchema,
    facts: z.array(z.object({ id: identifierSchema, value: z.string().trim().min(1) }).strict()).min(1),
    extractedValue: z.string().trim().min(1),
    correctValue: z.string().trim().min(1),
    outcome: z.enum(['hit', 'miss']),
    evidence: z.array(evidenceSchema).min(1),
    engine: z.object({ id: identifierSchema, version: identifierSchema }).strict(),
  })
  .strict();

export const sessionEventSchema = z.union([
  answerSubmittedEventSchema,
  polarityAssessedEventSchema,
  assessmentCompletedEventSchema,
]);

const pipelineStageOrder = {
  extraction: 1,
  rule: 2,
  following: 3,
  score: 4,
} as const;

export const sessionSchema = z
  .object({
    schemaVersion: z.literal('session.v2'),
    id: identifierSchema,
    anonymousStudentId: z.string().regex(/^anon-[A-Z0-9]{8,}$/),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    configVersions: z
      .object({
        configDigest: identifierSchema,
        knowledgeModel: identifierSchema,
        rubrics: identifierSchema,
        pretest: identifierSchema,
        scaffoldPolicy: identifierSchema,
        cases: z.record(identifierSchema, identifierSchema),
        grammar: identifierSchema,
        engines: z
          .object({
            rubric: identifierSchema,
            topology: identifierSchema,
            equation: identifierSchema,
          })
          .strict(),
      })
      .strict(),
    events: z.array(sessionEventSchema),
  })
  .strict()
  .superRefine((session, context) => {
    const eventIds = new Set<string>();
    const answers = new Map<string, z.infer<typeof answerSubmittedEventSchema>>();
    const answerWorkflows = new Set<string>();
    const progress = new Map<string, number>();

    session.events.forEach((event, index) => {
      if (event.sequence !== index) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sequence'],
          message: `expected sequence ${index}`,
        });
      }
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'id'],
          message: `duplicate event id ${event.id}`,
        });
      }
      eventIds.add(event.id);

      if (event.kind === 'answer.submitted') {
        const workflowKey = `${event.caseId}\u0000${event.stageId}\u0000${event.attemptId}`;
        if (answerWorkflows.has(workflowKey)) {
          context.addIssue({
            code: 'custom',
            path: ['events', index, 'attemptId'],
            message: 'duplicate answer for case, stage, and attempt',
          });
        }
        answerWorkflows.add(workflowKey);
        answers.set(event.id, event);
        return;
      }

      const answer = answers.get(event.sourceAnswerEventId);
      if (!answer) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sourceAnswerEventId'],
          message: 'must reference an earlier answer event',
        });
      } else {
        for (const field of ['caseId', 'stageId', 'attemptId'] as const) {
          if (event[field] !== answer[field]) {
            context.addIssue({
              code: 'custom',
              path: ['events', index, field],
              message: `must match source answer ${field}`,
            });
          }
        }
        if (event.kind === 'polarity.assessed') {
          const original = answer.answer.format === 'text'
            ? answer.answer.value
            : JSON.stringify(answer.answer.value);
          event.evidence.forEach((evidence, evidenceIndex) => {
            if (
              evidence.end > original.length
              || original.slice(evidence.start, evidence.end) !== evidence.quote
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'evidence', evidenceIndex],
                message: 'evidence must exactly quote the source answer',
              });
            }
          });
        } else if (event.extraction.status === 'assessed') {
          const original = answer.answer.format === 'text'
            ? answer.answer.value
            : JSON.stringify(answer.answer.value);
          event.extraction.evidence.forEach((evidence, evidenceIndex) => {
            if (
              evidence.end > original.length
              || original.slice(evidence.start, evidence.end) !== evidence.quote
            ) {
              context.addIssue({
                code: 'custom',
                path: ['events', index, 'extraction', 'evidence', evidenceIndex],
                message: 'evidence must exactly quote the source answer',
              });
            }
          });
        }
      }

      if (event.kind === 'polarity.assessed') return;

      const progressKey =
        `${event.caseId}\u0000${event.stageId}\u0000${event.attemptId}\u0000${event.nodeId}`;
      const currentProgress = pipelineStageOrder[event.pipelineStage];
      const previousProgress = progress.get(progressKey);
      if (previousProgress !== undefined && currentProgress < previousProgress) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'pipelineStage'],
          message: 'assessment pipeline progress cannot move backward',
        });
      }
      progress.set(progressKey, Math.max(previousProgress ?? 0, currentProgress));
    });
  });

export type AnswerSubmittedEvent = z.infer<typeof answerSubmittedEventSchema>;
export type AssessmentCompletedEvent = z.infer<typeof assessmentCompletedEventSchema>;
export type PolarityAssessedEvent = z.infer<typeof polarityAssessedEventSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type StudentSession = z.infer<typeof sessionSchema>;

type EventManagedFields = 'schemaVersion' | 'sequence';
export type SessionEventInput =
  | Omit<z.input<typeof answerSubmittedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof polarityAssessedEventSchema>, EventManagedFields>
  | Omit<z.input<typeof assessmentCompletedEventSchema>, EventManagedFields>;
