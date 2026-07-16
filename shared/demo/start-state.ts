import { z } from 'zod';

const trainingDraftSchema = z
  .object({
    schemaVersion: z.literal('training-draft.v2'),
    activeCaseId: z.string().trim().min(1),
    currentLevel: z.number().int().min(1).max(3),
    answers: z.record(z.string(), z.record(z.string(), z.string())),
    equations: z.record(z.string(), z.record(z.string(), z.string())),
    scaffoldHistory: z.array(z
      .object({
        caseId: z.string().trim().min(1),
        attemptKey: z.string(),
        score: z
          .object({
            outcome: z.enum(['hit', 'hit-with-help', 'partial', 'miss', 'unanswered']),
            earned: z.number().nonnegative(),
            possible: z.number().positive(),
            assistance: z
              .object({
                kind: z.enum(['none', 'hint', 'socratic']),
                rounds: z.number().int().nonnegative(),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()),
  })
  .strict();

export const demoStartStateSchema = z
  .object({
    version: z.literal('demo-start-state.v1'),
    sessionRef: z.literal('recordings/demo/session.json'),
    route: z.literal('/training'),
    progress: z
      .object({
        pretestComplete: z.boolean(),
        trainingComplete: z.boolean(),
      })
      .strict(),
    pretest: z
      .object({ page: z.literal('drawing') })
      .strict(),
    training: z
      .object({
        draft: trainingDraftSchema,
        feedbackRound: z
          .object({
            caseId: z.string().trim().min(1),
            attemptIds: z.array(z.string().trim().min(1)).min(1),
          })
          .strict(),
      })
      .strict(),
    classSessionRefs: z
      .array(z.string().regex(/^recordings\/demo\/class\/[a-z0-9-]+\.json$/u))
      .min(3),
  })
  .strict();

export type DemoStartState = z.infer<typeof demoStartStateSchema>;
