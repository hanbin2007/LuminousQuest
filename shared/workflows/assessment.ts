import { z } from 'zod';

import type { LoadedConfig } from '../config/schemas';
import { buildLearnerProfile } from '../scoring/profile';
import { evaluateExtractedFacts, factsMatchRequirements } from '../scoring/policy';
import { resolveRubricDecision, rubricPolicyEngineVersion } from '../scoring/rubric';
import { appendSessionEvent } from '../session/session';
import type { StudentSession } from '../session/schema';

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

const factSlotSchema = z
  .object({
    id: z.string().trim().min(1),
    value: z.string().trim().min(1),
  })
  .strict();

const extractedFactsSchema = z
  .object({
    response: z.enum(['substantive', 'blank', 'non-answer']),
    terminology: z.enum(['model', 'colloquial']),
    syllabus: z.enum(['within', 'beyond']),
    contradiction: z.boolean(),
    typo: z.enum(['none', 'unambiguous', 'ambiguous']),
    slots: z.array(factSlotSchema),
  })
  .strict();

const assistanceSchema = z
  .object({
    kind: z.enum(['none', 'hint', 'socratic']),
    rounds: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'none' && value.rounds !== 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'unassisted extraction requires zero rounds' });
    }
    if (value.kind !== 'none' && value.rounds === 0) {
      context.addIssue({ code: 'custom', path: ['rounds'], message: 'assisted extraction requires at least one round' });
    }
  });

export const structuredAssessmentResponseSchema = z
  .object({
    anchors: z
      .array(
        z
          .object({
            anchorId: z.string().trim().min(1),
            facts: z.array(factSlotSchema).min(1),
            evidence: z.array(evidenceSchema).min(1),
          })
          .strict(),
      )
      .default([]),
    assessments: z
      .array(
        z
          .object({
            nodeId: z.string().trim().min(1),
            errorIds: z.array(z.string().trim().min(1)),
            facts: extractedFactsSchema,
            evidence: z.array(evidenceSchema),
            assistance: assistanceSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const anchorIds = new Set<string>();
    value.anchors.forEach((anchor, index) => {
      if (anchorIds.has(anchor.anchorId)) {
        context.addIssue({
          code: 'custom',
          path: ['anchors', index, 'anchorId'],
          message: `duplicate anchor assessment ${anchor.anchorId}`,
        });
      }
      anchorIds.add(anchor.anchorId);
    });
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
  required: ['anchors', 'assessments'],
  properties: {
    anchors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['anchorId', 'facts', 'evidence'],
        properties: {
          anchorId: { type: 'string', minLength: 1 },
          facts: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'value'],
              properties: {
                id: { type: 'string', minLength: 1 },
                value: { type: 'string', minLength: 1 },
              },
            },
          },
          evidence: {
            type: 'array',
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
      },
    },
    assessments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'nodeId',
          'errorIds',
          'facts',
          'evidence',
          'assistance',
        ],
        properties: {
          nodeId: { type: 'string', minLength: 1 },
          errorIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          facts: {
            type: 'object',
            additionalProperties: false,
            required: ['response', 'terminology', 'syllabus', 'contradiction', 'typo', 'slots'],
            properties: {
              response: { enum: ['substantive', 'blank', 'non-answer'] },
              terminology: { enum: ['model', 'colloquial'] },
              syllabus: { enum: ['within', 'beyond'] },
              contradiction: { type: 'boolean' },
              typo: { enum: ['none', 'unambiguous', 'ambiguous'] },
              slots: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'value'],
                  properties: {
                    id: { type: 'string', minLength: 1 },
                    value: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
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
          assistance: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'rounds'],
            properties: {
              kind: { enum: ['none', 'hint', 'socratic'] },
              rounds: { type: 'integer', minimum: 0 },
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

function parseAnchorValue(value: string) {
  return new Map(value.split(';').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error(`Invalid configured anchor value ${value}`);
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }));
}

function serializeAnchorFacts(facts: readonly { id: string; value: string }[]) {
  return facts.map((fact) => `${fact.id}=${fact.value}`).join(';');
}

function directionRequirements(
  facts: { slots: Array<{ id: string; value: string }> },
  polarity: ReadonlyMap<string, string>,
) {
  const values: Record<string, string | undefined> = {
    'electron-from': polarity.get('negative'),
    'electron-to': polarity.get('positive'),
    'cation-toward': polarity.get('positive'),
    'anion-toward': polarity.get('negative'),
  };
  const present = new Set(facts.slots.map((slot) => slot.id));
  return Object.entries(values).flatMap(([id, value]) =>
    value !== undefined && present.has(id) ? [{ id, acceptedValues: [value] }] : []);
}

export function recordStructuredTextAssessment(input: RecordStructuredTextAssessmentInput) {
  const extraction = structuredAssessmentResponseSchema.parse(input.extraction);
  const trainingCase = input.config.cases.find((entry) => entry.id === input.answer.caseId);
  if (!trainingCase) throw new Error(`No case configured for ${input.answer.caseId}`);
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

  const anchorEvents = new Map<string, {
    outcome: 'hit' | 'miss';
    correct: Map<string, string>;
    extracted: Map<string, string>;
  }>();
  extraction.anchors.forEach((anchor, index) => {
    const configured = trainingCase.followingAnchors.find((entry) => entry.id === anchor.anchorId);
    if (!configured) throw new Error(`No following anchor configured for ${anchor.anchorId}`);
    const correct = parseAnchorValue(configured.correctValue);
    const extracted = new Map(anchor.facts.map((fact) => [fact.id, fact.value]));
    const extractedValue = serializeAnchorFacts(anchor.facts);
    const outcome = [...correct].every(([id, value]) => extracted.get(id) === value) ? 'hit' : 'miss';
    session = appendSessionEvent(session, {
      id: `${input.assessmentEventIdPrefix}-anchor-${index + 1}`,
      occurredAt: input.assessedAt,
      kind: 'polarity.assessed',
      pipelineStage: 'rule',
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      anchorId: anchor.anchorId,
      facts: anchor.facts,
      extractedValue,
      correctValue: configured.correctValue,
      outcome,
      evidence: anchor.evidence,
      engine: { id: 'case-anchor-policy', version: rubricPolicyEngineVersion },
    });
    anchorEvents.set(anchor.anchorId, { outcome, correct, extracted });
  });

  const misconceptionNode = new Map(
    input.config.knowledgeModel.nodes.flatMap((node) =>
      node.misconceptions.map((misconception) => [misconception.id, node.id] as const)),
  );

  extraction.assessments.forEach((assessment, index) => {
    const rubric = input.config.rubrics.rubrics.find(
      (entry) => entry.nodeId === assessment.nodeId,
    );
    if (!rubric) throw new Error(`No rubric configured for node ${assessment.nodeId}`);
    assessment.errorIds.forEach((errorId) => {
      if (misconceptionNode.get(errorId) !== assessment.nodeId) {
        throw new Error(`Error ${errorId} is not configured for node ${assessment.nodeId}`);
      }
    });
    const evidencePath = trainingCase.evidencePaths.find((entry) =>
      entry.nodeId === assessment.nodeId && entry.source === 'answer');
    const anchor = rubric.followingAnchorId
      ? anchorEvents.get(rubric.followingAnchorId)
      : undefined;
    const requirements = evidencePath?.factRequirements.length
      ? evidencePath.factRequirements
      : assessment.nodeId === 'P4' && anchor
        ? directionRequirements(assessment.facts, anchor.correct)
        : [];
    if (requirements.length === 0) {
      throw new Error(`No deterministic fact requirements configured for node ${assessment.nodeId}`);
    }
    const evaluation = evaluateExtractedFacts({
      facts: assessment.facts,
      requirements,
      policy: input.config.rubrics.policy,
    });
    const eventBase = {
      id: `${input.assessmentEventIdPrefix}-${index + 1}`,
      occurredAt: input.assessedAt,
      kind: 'assessment.completed' as const,
      caseId: input.answer.caseId,
      stageId: input.answer.stageId,
      attemptId: input.answer.attemptId,
      sourceAnswerEventId: input.answer.id,
      nodeId: assessment.nodeId,
      rubric: { id: rubric.id, version: input.config.rubrics.version },
      assistance: assessment.assistance,
    };
    if (evaluation.status === 'unanswered') {
      session = appendSessionEvent(session, {
        ...eventBase,
        pipelineStage: 'score',
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
        ruleDecision: {
          status: 'unanswered',
          reason: 'Response was blank or did not attempt the question',
          promptRetry: evaluation.promptRetry,
          includeInDiagnosis: evaluation.includeInDiagnosis,
        },
        following: {
          status: 'not-followed',
          anchorNodeId: null,
          anchorOutcome: null,
          policy: input.config.rubrics.policy.followingError.strategy,
        },
        score: {
          status: 'unanswered',
          promptRetry: evaluation.promptRetry,
          includeInDiagnosis: evaluation.includeInDiagnosis,
        },
      });
      return;
    }
    if (evaluation.status === 'needs-review') {
      session = appendSessionEvent(session, {
        ...eventBase,
        pipelineStage: 'extraction',
        extraction: {
          status: 'needs-review',
          reason: 'Extracted facts require review under the configured ambiguity policy',
          model: input.provenance.model,
          provenance: {
            promptId: input.provenance.promptId,
            promptVersion: input.provenance.promptVersion,
            cacheKey: input.provenance.cacheKey,
          },
        },
        ruleDecision: { status: 'unassessed', reason: 'awaiting extraction review' },
        following: { status: 'unassessed' },
        score: { status: 'unassessed' },
      });
      return;
    }
    if (
      evaluation.status !== 'hit'
      && evaluation.status !== 'partial'
      && evaluation.status !== 'miss'
    ) {
      throw new Error(`Assessment status ${evaluation.status} requires a non-scoring workflow event`);
    }
    const logicalChainConsistent = Boolean(
      anchor
      && anchor.outcome === 'miss'
      && factsMatchRequirements(
        assessment.facts,
        assessment.nodeId === 'P4'
          ? directionRequirements(assessment.facts, anchor.extracted)
          : requirements.map((requirement) => ({
              ...requirement,
              acceptedValues: requirement.acceptedValues.map((value) => {
                for (const [slot, correctValue] of anchor.correct) {
                  if (value === correctValue) return anchor.extracted.get(slot) ?? value;
                }
                return value;
              }),
            })),
      )
    );
    const decision = resolveRubricDecision({
      rubrics: input.config.rubrics,
      scaffoldPolicy: input.config.scaffoldPolicy,
      nodeId: assessment.nodeId,
      logicalOutcome: logicalChainConsistent ? 'hit' : evaluation.status,
      objectiveOutcome: evaluation.status,
      following: anchor && rubric.followingAnchorId
        ? {
            anchorId: rubric.followingAnchorId,
            anchorOutcome: anchor.outcome,
            logicalChainConsistent,
          }
        : undefined,
      assistance: assessment.assistance,
      engine: {
        id: 'fact-policy',
        version: rubricPolicyEngineVersion,
        reason: `Matched ${evaluation.matchedRequirementIds.length}/${requirements.length} configured facts`,
      },
    });

    session = appendSessionEvent(session, {
      ...eventBase,
      pipelineStage: 'score',
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
      input.config,
    ),
  };
}
