import { z } from 'zod';

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(1);

const eventBaseShape = {
  schemaVersion: z.literal('event.v1'),
  id: identifierSchema,
  sequence: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
};

const answerPayloadSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('text'),
    value: z.string(),
  }),
  z.object({
    format: z.literal('builder'),
    value: z.object({
      components: z.array(
        z.object({
          instanceId: identifierSchema,
          componentId: identifierSchema,
          x: z.number().finite(),
          y: z.number().finite(),
          label: z.string().optional(),
        }),
      ),
      connections: z.array(
        z.object({
          from: identifierSchema,
          to: identifierSchema,
          kind: z.enum(['wire', 'ion-path']),
        }),
      ),
    }),
  }),
  z.object({
    format: z.literal('canvas'),
    value: z.object({
      dataUrl: z.string().startsWith('data:image/'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
]);

export const answerSubmittedEventSchema = z.object({
  ...eventBaseShape,
  kind: z.literal('answer.submitted'),
  questionId: identifierSchema,
  answer: answerPayloadSchema,
});

const assessedExtractionSchema = z.object({
  status: z.literal('assessed'),
  evidence: z.array(
    z.object({
      quote: z.string(),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    }),
  ),
  model: identifierSchema,
});

const unassessedExtractionSchema = z.object({
  status: z.literal('unassessed'),
  reason: z.string().trim().min(1),
});

const assessedRuleDecisionSchema = z.object({
  status: z.enum(['hit', 'partial', 'miss']),
  ruleId: identifierSchema,
  reason: z.string().trim().min(1),
});

const unassessedRuleDecisionSchema = z.object({
  status: z.literal('unassessed'),
  reason: z.string().trim().min(1),
});

const assessedFollowingSchema = z.object({
  status: z.enum(['followed', 'not-followed']),
  anchorNodeId: identifierSchema.nullable(),
});

const unassessedFollowingSchema = z.object({
  status: z.literal('unassessed'),
});

const scoredSchema = z
  .object({
    status: z.literal('scored'),
    earned: z.number().nonnegative(),
    possible: z.number().positive(),
  })
  .refine((score) => score.earned <= score.possible, {
    message: 'earned score cannot exceed possible score',
    path: ['earned'],
  });

const unassessedScoreSchema = z.object({
  status: z.literal('unassessed'),
});

export const assessmentCompletedEventSchema = z
  .object({
    ...eventBaseShape,
    kind: z.literal('assessment.completed'),
    sourceAnswerEventId: identifierSchema,
    nodeId: identifierSchema,
    rubric: z.object({
      id: identifierSchema,
      version: identifierSchema,
    }),
    extraction: z.union([assessedExtractionSchema, unassessedExtractionSchema]),
    ruleDecision: z.union([assessedRuleDecisionSchema, unassessedRuleDecisionSchema]),
    following: z.union([assessedFollowingSchema, unassessedFollowingSchema]),
    score: z.union([scoredSchema, unassessedScoreSchema]),
  })
  .superRefine((event, context) => {
    const isUnassessed = event.extraction.status === 'unassessed';
    const laterStatuses = [
      ['ruleDecision', event.ruleDecision.status],
      ['following', event.following.status],
      ['score', event.score.status],
    ] as const;

    laterStatuses.forEach(([field, status]) => {
      const laterIsUnassessed = status === 'unassessed';
      if (laterIsUnassessed !== isUnassessed) {
        context.addIssue({
          code: 'custom',
          path: [field, 'status'],
          message: isUnassessed
            ? 'must be unassessed when extraction is unassessed'
            : 'cannot be unassessed when extraction was assessed',
        });
      }
    });
  });

export const sessionEventSchema = z.union([
  answerSubmittedEventSchema,
  assessmentCompletedEventSchema,
]);

export const sessionSchema = z
  .object({
    schemaVersion: z.literal('session.v1'),
    id: identifierSchema,
    anonymousStudentId: z.string().regex(/^anon-[A-Z0-9]{8,}$/),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    configVersions: z.object({
      knowledgeModel: identifierSchema,
      rubrics: identifierSchema,
      pretest: identifierSchema,
      scaffoldPolicy: identifierSchema,
    }),
    events: z.array(sessionEventSchema),
  })
  .superRefine((session, context) => {
    const answers = new Set<string>();
    session.events.forEach((event, index) => {
      if (event.sequence !== index) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sequence'],
          message: `expected sequence ${index}`,
        });
      }
      if (event.kind === 'answer.submitted') {
        answers.add(event.id);
      } else if (!answers.has(event.sourceAnswerEventId)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'sourceAnswerEventId'],
          message: 'must reference an earlier answer event',
        });
      }
    });
  });

export type AnswerSubmittedEvent = z.infer<typeof answerSubmittedEventSchema>;
export type AssessmentCompletedEvent = z.infer<typeof assessmentCompletedEventSchema>;
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type StudentSession = z.infer<typeof sessionSchema>;

type EventManagedFields = 'schemaVersion' | 'sequence';
export type SessionEventInput =
  | Omit<AnswerSubmittedEvent, EventManagedFields>
  | Omit<AssessmentCompletedEvent, EventManagedFields>;

