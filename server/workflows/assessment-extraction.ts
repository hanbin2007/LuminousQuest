import { z } from 'zod';

import type { LoadedConfig, TextQuestionEvidence } from '../../shared/config/schemas';
import type { AssistanceMetadata } from '../../shared/scoring/rubric';
import {
  structuredAssessmentResponseJsonSchema,
  structuredAssessmentResponseSchema,
  type StructuredAssessmentResponse,
} from '../../shared/workflows/assessment';
import {
  type AssessmentExtractionValidationResult,
  ExtractionValidationError,
  validateAssessmentExtraction,
} from '../../shared/workflows/extraction-validation';
import type { LoadedPrompt } from '../prompts/loader';
import { StructuredResponseValidationError } from '../llm/errors';
import type { EvalCandidateWriter } from '../llm/eval-candidate-store';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';

type JsonSchema = Record<string, unknown>;

function objectProperties(schema: JsonSchema) {
  return schema.properties as Record<string, JsonSchema>;
}

function closedFactSlotsSchema(
  baseSlots: JsonSchema,
  requirements: readonly { id: string; valueDomain?: readonly string[]; hint?: string }[],
) {
  const item = structuredClone(baseSlots.items as JsonSchema);
  const properties = objectProperties(item);
  properties.id = {
    type: 'string',
    minLength: 1,
    description: `Allowed fact slot ids: ${requirements.map((entry) => entry.id).join(', ')}`,
  };
  properties.value = {
    type: 'string',
    minLength: 1,
    description: requirements.map((requirement) => {
      const domain = requirement.valueDomain?.length
        ? ` (${requirement.valueDomain.join(', ')})`
        : '';
      return `${requirement.id}${domain}${requirement.hint ? `: ${requirement.hint}` : ''}`;
    }).join('; '),
  };
  return {
    ...structuredClone(baseSlots),
    items: item,
  };
}

export function createClosedExtractionSchema(input: {
  config: LoadedConfig;
  caseId: string;
  targetNodeIds: readonly string[];
  questionEvidence?: TextQuestionEvidence;
  assistance: AssistanceMetadata;
}) {
  const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId);
  if (!trainingCase) throw new Error(`Unknown case ${input.caseId}`);
  if (input.targetNodeIds.length === 0 || new Set(input.targetNodeIds).size !== input.targetNodeIds.length) {
    throw new Error('Extraction target node ids must be non-empty and unique');
  }
  for (const nodeId of input.targetNodeIds) {
    const questionEvidence = input.questionEvidence?.find((entry) => entry.nodeId === nodeId);
    const caseEvidence = trainingCase.evidencePaths.find((entry) =>
      entry.nodeId === nodeId && entry.source === 'answer');
    if (!questionEvidence && !caseEvidence) {
      throw new Error(`Node ${nodeId} has no answer extraction path in case ${input.caseId}`);
    }
  }

  const errorsByNode = new Map(
    input.config.knowledgeModel.nodes.map((node) => [
      node.id,
      node.misconceptions.map((misconception) => misconception.id),
    ]),
  );
  const schema = structuredClone(structuredAssessmentResponseJsonSchema) as unknown as JsonSchema;
  const rootProperties = objectProperties(schema);
  const anchors = rootProperties.anchors;
  const anchorItem = anchors.items as JsonSchema;
  anchors.maxItems = trainingCase.followingAnchors.length;
  anchors.items = {
    oneOf: trainingCase.followingAnchors.map((anchor) => {
      const branch = structuredClone(anchorItem) as JsonSchema;
      const properties = objectProperties(branch);
      properties.anchorId = { type: 'string', const: anchor.id };
      const requirements = anchor.correctValue.split(';').map((entry) => ({
        id: entry.slice(0, entry.indexOf('=')).trim(),
      }));
      properties.facts = closedFactSlotsSchema(properties.facts, requirements);
      return branch;
    }),
  };

  const assessments = rootProperties.assessments;
  const assessmentItem = assessments.items as JsonSchema;
  const branches = input.targetNodeIds.map((nodeId) => {
    const branch = structuredClone(assessmentItem) as JsonSchema;
    const properties = objectProperties(branch);
    properties.nodeId = { type: 'string', const: nodeId };
    properties.errorIds = {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: errorsByNode.get(nodeId) ?? [] },
    };
    const evidencePath = input.questionEvidence?.find((entry) => entry.nodeId === nodeId)
      ?? trainingCase.evidencePaths.find((entry) =>
        entry.nodeId === nodeId && entry.source === 'answer')!;
    const facts = properties.facts;
    const factsProperties = objectProperties(facts);
    factsProperties.slots = closedFactSlotsSchema(
      factsProperties.slots,
      evidencePath.factRequirements,
    );
    const assistance = properties.assistance;
    const assistanceProperties = objectProperties(assistance);
    assistanceProperties.kind = { type: 'string', const: input.assistance.kind };
    assistanceProperties.rounds = { type: 'integer', const: input.assistance.rounds };
    delete (properties.evidence as JsonSchema).minItems;
    return branch;
  });
  assessments.minItems = input.targetNodeIds.length;
  assessments.maxItems = input.targetNodeIds.length;
  assessments.items = { oneOf: branches };
  return schema;
}

export interface AssessmentExtractionInput {
  service: LLMService;
  evalCandidates: EvalCandidateWriter;
  config: LoadedConfig;
  prompt: LoadedPrompt;
  answer: string;
  caseId: string;
  targetNodeIds: readonly string[];
  questionEvidence?: TextQuestionEvidence;
  assistance: AssistanceMetadata;
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
  stepId?: string;
  logger?: Pick<Console, 'warn'>;
}

export type AssessmentExtractionResult =
  | {
      status: 'extracted';
      extraction: StructuredAssessmentResponse;
      reviewNodes: AssessmentExtractionReviewNode[];
      source: 'provider' | 'development-cache' | 'demo-recording';
      cacheKey: string;
      model: string;
      degraded: boolean;
    }
  | {
      status: 'needs-review';
      reason: string;
      reviewNodes: AssessmentExtractionReviewNode[];
      source: 'provider' | 'development-cache' | 'demo-recording' | 'fallback';
      cacheKey: string;
      model: string;
      degraded: true;
    };

export interface AssessmentExtractionReviewNode {
  nodeId: string;
  reason: string;
  assistance: AssistanceMetadata;
}

export async function runAssessmentExtraction(
  input: AssessmentExtractionInput,
): Promise<AssessmentExtractionResult> {
  const maximumAnswerCharacters = input.config.scaffoldPolicy.extraction.maximumAnswerCharacters;
  if (input.answer.length > maximumAnswerCharacters) {
    throw new ExtractionValidationError(
      'answer-too-long',
      false,
      `Answer exceeds the configured ${maximumAnswerCharacters} character limit`,
      { answerLength: input.answer.length, maximumAnswerCharacters },
    );
  }
  const schema = createClosedExtractionSchema(input);
  const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId)!;
  const errorIdsByNode = Object.fromEntries(
    input.config.knowledgeModel.nodes
      .filter((node) => input.targetNodeIds.includes(node.id))
      .map((node) => [node.id, node.misconceptions.map((entry) => entry.id)]),
  );
  let validationResult: AssessmentExtractionValidationResult | null = null;
  const recordCandidate = async (error: ExtractionValidationError) => {
    try {
      await input.evalCandidates.record({
        category: error.category,
        answer: input.answer,
        detail: error.detail,
        provenance: {
          configDigest: input.config.configVersion,
          thresholds: {
            maxEditDistanceRatio:
              input.config.scaffoldPolicy.extraction.citation.maxEditDistanceRatio,
            normalizationCandidateMaxEditDistanceRatio:
              input.config.scaffoldPolicy.extraction.citation
                .normalizationCandidateMaxEditDistanceRatio,
          },
          prompt: { id: input.prompt.id, version: input.prompt.version },
          schemaVersion: 'structured-assessment.v5',
          provider: input.provider,
          model: input.model,
        },
      });
    } catch (recordingError) {
      (input.logger ?? console).warn(
        `[llm] eval candidate write failed: ${(recordingError as Error).message}`,
      );
    }
  };
  const result = await input.service.execute({
    executionMode: input.executionMode,
    capability: 'structured',
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    schemaVersion: 'structured-assessment.v5',
    configVersion: input.config.configVersion,
    input: {
      answer: input.answer,
      caseId: input.caseId,
      targetNodeIds: [...input.targetNodeIds],
      assistance: input.assistance,
      closedSet: {
        nodeIds: [...input.targetNodeIds],
        errorIdsByNode,
        anchorIds: trainingCase.followingAnchors.map((anchor) => anchor.id),
      },
    },
    images: [],
    schema,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    temperature: input.config.scaffoldPolicy.extraction.temperature,
  }, {
    retryCount: input.config.scaffoldPolicy.extraction.retryCount,
    validateStructured: async (value) => {
      try {
        validationResult = validateAssessmentExtraction({
          extraction: value,
          answer: input.answer,
          caseId: input.caseId,
          targetNodeIds: input.targetNodeIds,
          questionEvidence: input.questionEvidence,
          config: input.config,
        });
        for (const failure of validationResult.failures) {
          await recordCandidate(failure);
        }
        // Keep the cached provider payload schema-conforming. The validated,
        // filtered result stays in this request-local side channel.
        return value;
      } catch (error) {
        if (error instanceof ExtractionValidationError) {
          await recordCandidate(error);
          throw new StructuredResponseValidationError(error.message, {
            retryable: error.retryable,
            category: error.category,
          });
        }
        if (error instanceof z.ZodError) {
          throw new StructuredResponseValidationError(
            `Structured extraction failed semantic schema validation: ${error.issues[0]?.message ?? 'invalid value'}`,
            { category: 'schema-invalid' },
          );
        }
        throw error;
      }
    },
  });

  if (result.requiresTeacherReview || result.source === 'fallback') {
    const reason = result.failureReason ?? 'provider-error';
    return {
      status: 'needs-review',
      reason,
      reviewNodes: input.targetNodeIds.map((nodeId) => ({
        nodeId,
        reason,
        assistance: input.assistance,
      })),
      source: 'fallback',
      cacheKey: result.cacheKey,
      model: result.response.model,
      degraded: true,
    };
  }
  const validated = validationResult as AssessmentExtractionValidationResult | null;
  if (!validated) {
    throw new Error('Structured extraction completed without a validation result');
  }
  if (!validated.extraction) {
    return {
      status: 'needs-review',
      reason: validated.reviewNodes[0]?.reason ?? 'validation-failed',
      reviewNodes: validated.reviewNodes,
      source: result.source,
      cacheKey: result.cacheKey,
      model: result.response.model,
      degraded: true,
    };
  }
  return {
    status: 'extracted',
    extraction: structuredAssessmentResponseSchema.parse(validated.extraction),
    reviewNodes: validated.reviewNodes,
    source: result.source,
    cacheKey: result.cacheKey,
    model: result.response.model,
    degraded: result.degraded || validated.reviewNodes.length > 0,
  };
}
