import { z } from 'zod';

import type { LoadedConfig } from '../config/schemas';
import { buildLearnerProfile } from '../scoring/profile';
import { resolveRubricDecision } from '../scoring/rubric';
import { appendSessionEvent } from '../session/session';
import type { StudentSession } from '../session/schema';

const outcomeSchema = z.enum(['hit', 'partial', 'miss']);
const evidenceSchema = z
  .object({
    quote: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict()
  .refine((evidence) => evidence.end > evidence.start, {
    path: ['end'],
    message: 'evidence end must follow start',
  });

export const structuredAssessmentResponseSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            nodeId: z.string().trim().min(1),
            logicalOutcome: outcomeSchema,
            objectiveOutcome: outcomeSchema,
            evidence: z.array(evidenceSchema).min(1),
            assistance: z.enum(['none', 'hint', 'socratic']),
            following: z
              .object({
                anchorId: z.string().trim().min(1),
                anchorOutcome: outcomeSchema,
                logicalChainConsistent: z.boolean(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.assessments.forEach((assessment, index) => {
      if (seen.has(assessment.nodeId)) {
        context.addIssue({
          code: 'custom',
          path: ['assessments', index, 'nodeId'],
          message: `duplicate node assessment ${assessment.nodeId}`,
        });
      }
      seen.add(assessment.nodeId);
    });
  });

export const structuredAssessmentResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['assessments'],
  properties: {
    assessments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'nodeId',
          'logicalOutcome',
          'objectiveOutcome',
          'evidence',
          'assistance',
        ],
        properties: {
          nodeId: { type: 'string', minLength: 1 },
          logicalOutcome: { enum: ['hit', 'partial', 'miss'] },
          objectiveOutcome: { enum: ['hit', 'partial', 'miss'] },
          evidence: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['quote', 'start', 'end'],
              properties: {
                quote: { type: 'string', minLength: 1 },
                start: { type: 'integer', minimum: 0 },
                end: { type: 'integer', minimum: 1 },
              },
            },
          },
          assistance: { enum: ['none', 'hint', 'socratic'] },
          following: {
            type: 'object',
            additionalProperties: false,
            required: ['anchorId', 'anchorOutcome', 'logicalChainConsistent'],
            properties: {
              anchorId: { type: 'string', minLength: 1 },
              anchorOutcome: { enum: ['hit', 'partial', 'miss'] },
              logicalChainConsistent: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
} as const;

export interface RecordStructuredTextAssessmentInput {
  session: StudentSession;
  config: LoadedConfig;
  answer: {
    id: string;
    occurredAt: string;
    caseId: string;
    stageId: string;
    attemptId: string;
    questionId: string;
    value: string;
  };
  extraction: unknown;
  provenance: {
    promptId: string;
    promptVersion: string;
    cacheKey: string;
    model: string;
  };
  assessmentEventIdPrefix: string;
  assessedAt: string;
}

export function recordStructuredTextAssessment(input: RecordStructuredTextAssessmentInput) {
  const extraction = structuredAssessmentResponseSchema.parse(input.extraction);
  let session = appendSessionEvent(input.session, {
    id: input.answer.id,
    occurredAt: input.answer.occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: input.answer.caseId,
    stageId: input.answer.stageId,
    attemptId: input.answer.attemptId,
    questionId: input.answer.questionId,
    answer: { format: 'text', value: input.answer.value },
  });

  extraction.assessments.forEach((assessment, index) => {
    const rubric = input.config.rubrics.rubrics.find(
      (entry) => entry.nodeId === assessment.nodeId,
    );
    if (!rubric) throw new Error(`No rubric configured for node ${assessment.nodeId}`);
    const decision = resolveRubricDecision({
      rubrics: input.config.rubrics,
      nodeId: assessment.nodeId,
      logicalOutcome: assessment.logicalOutcome,
      objectiveOutcome: assessment.objectiveOutcome,
      following: assessment.following,
      assistance: assessment.assistance,
    });

    session = appendSessionEvent(session, {
      id: `${input.assessmentEventIdPrefix}-${index + 1}`,
      occurredAt: input.assessedAt,
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      nodeId: assessment.nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: assessment.evidence,
        model: input.provenance.model,
        provenance: {
          promptId: input.provenance.promptId,
          promptVersion: input.provenance.promptVersion,
          cacheKey: input.provenance.cacheKey,
        },
      },
      ...decision,
    });
  });

  return {
    session,
    profile: buildLearnerProfile(
      session,
      input.config.knowledgeModel,
      input.config.rubrics,
    ),
  };
}
