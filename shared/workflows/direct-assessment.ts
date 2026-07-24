import { z } from 'zod';

import type { LoadedConfig, PretestConfig } from '../config/schemas';
import { buildLearnerProfile } from '../scoring/profile';
import {
  type AssistanceMetadata,
  resolveRubricDecision,
} from '../scoring/rubric';
import type { StudentSession } from '../session/schema';
import { appendSessionEvent } from '../session/session';
import { classifyTextResponse } from './assessment';

export const directAssessmentVerdictSchema = z.enum([
  'hit',
  'partial',
  'miss',
  'needs-review',
]);

export const directAssessmentReviewReasonSchema = z.enum([
  'low-confidence',
  'no-majority',
  'rubric-boundary',
  'ambiguous-transcription',
  'provider-failure',
]);

const directEvidenceSchema = z
  .object({
    quote: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((evidence) => evidence.end > evidence.start, {
    path: ['end'],
    message: 'evidence end must follow start',
  });

export const directNodeAssessmentSchema = z
  .object({
    nodeId: z.string().trim().min(1),
    verdict: directAssessmentVerdictSchema,
    misconceptionIds: z.array(z.string().trim().min(1)),
    rationale: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    reviewReason: directAssessmentReviewReasonSchema.nullable(),
    evidence: z.array(directEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (assessment.verdict === 'needs-review' && assessment.reviewReason === null) {
      context.addIssue({
        code: 'custom',
        path: ['reviewReason'],
        message: 'needs-review verdict requires a review reason',
      });
    }
    if (assessment.verdict !== 'needs-review' && assessment.reviewReason !== null) {
      context.addIssue({
        code: 'custom',
        path: ['reviewReason'],
        message: 'scored verdict cannot carry a review reason',
      });
    }
  });

export const directAssessmentResponseSchema = z
  .object({
    assessments: z.array(directNodeAssessmentSchema).min(1),
  })
  .strict();

export type DirectNodeAssessment = z.infer<typeof directNodeAssessmentSchema>;
export type DirectAssessmentResponse = z.infer<typeof directAssessmentResponseSchema>;

type DirectQuestion = PretestConfig['questions'][number] & {
  directAssessment: NonNullable<PretestConfig['questions'][number]['directAssessment']>;
};

function nodeMisconceptionIds(config: LoadedConfig, nodeId: string) {
  return config.knowledgeModel.nodes
    .find((node) => node.id === nodeId)
    ?.misconceptions.map((misconception) => misconception.id) ?? [];
}

export function createClosedDirectAssessmentSchema(input: {
  config: LoadedConfig;
  question: DirectQuestion;
}) {
  const branches = input.question.targetNodeIds.map((nodeId) => ({
    type: 'object',
    additionalProperties: false,
    required: [
      'nodeId',
      'verdict',
      'misconceptionIds',
      'rationale',
      'confidence',
      'reviewReason',
      'evidence',
    ],
    properties: {
      nodeId: { type: 'string', const: nodeId },
      verdict: { enum: directAssessmentVerdictSchema.options },
      misconceptionIds: {
        type: 'array',
        uniqueItems: true,
        items: { type: 'string', enum: nodeMisconceptionIds(input.config, nodeId) },
      },
      rationale: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reviewReason: {
        anyOf: [
          {
            enum: [
              'low-confidence',
              'rubric-boundary',
              'ambiguous-transcription',
            ],
          },
          { type: 'null' },
        ],
      },
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
    },
  }));
  return {
    type: 'object',
    additionalProperties: false,
    required: ['assessments'],
    properties: {
      assessments: {
        type: 'array',
        minItems: branches.length,
        maxItems: branches.length,
        items: { oneOf: branches },
      },
    },
  };
}

export function validateDirectAssessmentResponse(input: {
  value: unknown;
  answer: string;
  config: LoadedConfig;
  question: DirectQuestion;
}) {
  const parsed = directAssessmentResponseSchema.parse(input.value);
  const expected = input.question.targetNodeIds;
  if (
    parsed.assessments.length !== expected.length
    || parsed.assessments.some((assessment, index) => assessment.nodeId !== expected[index])
  ) {
    throw new Error('Direct assessment nodes must exactly match configured targets in order');
  }
  parsed.assessments.forEach((assessment) => {
    if (
      assessment.reviewReason === 'no-majority'
      || assessment.reviewReason === 'provider-failure'
    ) {
      throw new Error(
        `Direct assessment provider cannot emit internal review reason ${assessment.reviewReason}`,
      );
    }
    const allowedMisconceptions = new Set(
      nodeMisconceptionIds(input.config, assessment.nodeId),
    );
    if (
      new Set(assessment.misconceptionIds).size !== assessment.misconceptionIds.length
      || assessment.misconceptionIds.some((id) => !allowedMisconceptions.has(id))
    ) {
      throw new Error(`Direct assessment contains an invalid misconception for ${assessment.nodeId}`);
    }
    assessment.evidence.forEach((evidence) => {
      if (
        evidence.end > input.answer.length
        || input.answer.slice(evidence.start, evidence.end) !== evidence.quote
      ) {
        throw new Error(`Direct assessment evidence is not an exact quote for ${assessment.nodeId}`);
      }
    });
  });
  return parsed;
}

export interface AggregatedDirectAssessment extends DirectNodeAssessment {
  agreeingVotes: 1 | 2 | 3;
}

export interface RecordDirectAssessmentInput {
  session: StudentSession;
  config: LoadedConfig;
  question: DirectQuestion;
  answer: {
    id: string;
    occurredAt: string;
    caseId: string;
    stageId: string;
    attemptId: string;
    questionId: string;
    value: string;
    responseToAgentTurnId?: string;
    responseContractId?: string;
  };
  assessments?: readonly AggregatedDirectAssessment[];
  assistance?: AssistanceMetadata;
  provenance: {
    promptId: string;
    promptVersion: string;
    cacheKey: string;
    model: string;
  };
  assessmentEventIdPrefix: string;
  assessedAt: string;
}

export function recordDirectAssessment(input: RecordDirectAssessmentInput) {
  const responseKind = classifyTextResponse(input.answer.value);
  const assistance = input.assistance ?? { kind: 'none' as const, rounds: 0 };
  const assessmentByNode = new Map(
    input.assessments?.map((assessment) => [assessment.nodeId, assessment]) ?? [],
  );
  if (
    responseKind === 'substantive'
    && (
      assessmentByNode.size !== input.question.targetNodeIds.length
      || input.question.targetNodeIds.some((nodeId) => !assessmentByNode.has(nodeId))
    )
  ) {
    throw new Error('Substantive direct assessment must cover every configured target node');
  }

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
    ...(input.answer.responseToAgentTurnId && input.answer.responseContractId
      ? {
          responseToAgentTurnId: input.answer.responseToAgentTurnId,
          responseContractId: input.answer.responseContractId,
        }
      : {}),
  });

  input.question.targetNodeIds.forEach((nodeId, index) => {
    const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId);
    if (!rubric) throw new Error(`No rubric configured for node ${nodeId}`);
    const eventBase = {
      id: `${input.assessmentEventIdPrefix}-${index + 1}`,
      occurredAt: input.assessedAt,
      kind: 'assessment.completed' as const,
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      assistance,
    };
    if (responseKind !== 'substantive') {
      const policy = input.config.rubrics.policy.nonResponse;
      session = appendSessionEvent(session, {
        ...eventBase,
        pipelineStage: 'score',
        extraction: {
          status: 'assessed',
          evidence: [],
          model: 'deterministic-non-response',
          provenance: {
            promptId: input.provenance.promptId,
            promptVersion: input.provenance.promptVersion,
            cacheKey: input.provenance.cacheKey,
          },
        },
        ruleDecision: {
          status: 'unanswered',
          reason: 'Response was blank or did not attempt the question',
          promptRetry: policy.promptRetry,
          includeInDiagnosis: policy.includeInDiagnosis,
        },
        following: {
          status: 'not-followed',
          anchorNodeId: null,
          anchorOutcome: null,
          policy: input.config.rubrics.policy.followingError.strategy,
        },
        score: {
          status: 'unanswered',
          promptRetry: policy.promptRetry,
          includeInDiagnosis: policy.includeInDiagnosis,
        },
      });
      return;
    }

    const assessment = assessmentByNode.get(nodeId)!;
    if (assessment.verdict === 'needs-review' || assessment.agreeingVotes < 2) {
      session = appendSessionEvent(session, {
        ...eventBase,
        ...(assessment.misconceptionIds.length > 0
          ? { misconceptionIds: assessment.misconceptionIds }
          : {}),
        pipelineStage: 'extraction',
        extraction: {
          status: 'needs-review',
          reason: assessment.reviewReason ?? 'no-majority',
          model: input.provenance.model,
          provenance: {
            promptId: input.provenance.promptId,
            promptVersion: input.provenance.promptVersion,
            cacheKey: input.provenance.cacheKey,
          },
        },
        ruleDecision: { status: 'unassessed', reason: assessment.rationale },
        following: { status: 'unassessed' },
        score: { status: 'unassessed' },
      });
      return;
    }

    const decision = resolveRubricDecision({
      rubrics: input.config.rubrics,
      scaffoldPolicy: input.config.scaffoldPolicy,
      nodeId,
      objectiveOutcome: assessment.verdict,
      assistance,
      engine: {
        id: 'direct-assessment',
        version: 'direct-assessment.v1',
        reason: assessment.rationale,
      },
    });
    session = appendSessionEvent(session, {
      ...eventBase,
      ...(assessment.misconceptionIds.length > 0
        ? { misconceptionIds: assessment.misconceptionIds }
        : {}),
      pipelineStage: 'score',
      objectiveOutcome: assessment.verdict,
      extraction: {
        status: 'assessed',
        evidence: assessment.evidence,
        model: input.provenance.model,
        provenance: {
          promptId: input.provenance.promptId,
          promptVersion: input.provenance.promptVersion,
          cacheKey: input.provenance.cacheKey,
        },
        judgment: {
          confidence: assessment.confidence,
          voteCount: input.question.directAssessment.votes,
          agreeingVotes: assessment.agreeingVotes as 2 | 3,
          scopeVersion: input.question.directAssessment.version,
          rationale: assessment.rationale,
        },
      },
      ...decision,
    });
  });

  return {
    session,
    profile: buildLearnerProfile(session, input.config),
  };
}
