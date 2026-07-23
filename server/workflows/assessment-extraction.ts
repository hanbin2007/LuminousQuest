import { z } from 'zod';

import type { LoadedConfig, TextQuestionEvidence } from '../../shared/config/schemas';
import type { AssistanceMetadata } from '../../shared/scoring/rubric';
import {
  structuredAssessmentResponseJsonSchema,
  structuredAssessmentResponseSchema,
  type StructuredAssessmentResponse,
} from '../../shared/workflows/assessment';
import {
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
  requirements: readonly { id: string }[],
) {
  const baseItem = baseSlots.items as JsonSchema;
  return {
    ...structuredClone(baseSlots),
    maxItems: requirements.length,
    items: {
      oneOf: requirements.map((requirement) => {
        const branch = structuredClone(baseItem) as JsonSchema;
        objectProperties(branch).id = { type: 'string', const: requirement.id };
        return branch;
      }),
    },
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
      source: 'provider' | 'development-cache' | 'demo-recording';
      cacheKey: string;
      model: string;
      degraded: boolean;
    }
  | {
      status: 'needs-review';
      reason: string;
      source: 'fallback';
      cacheKey: string;
      model: string;
      degraded: true;
    };

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
        return validateAssessmentExtraction({
          extraction: value,
          answer: input.answer,
          caseId: input.caseId,
          targetNodeIds: input.targetNodeIds,
          questionEvidence: input.questionEvidence,
          config: input.config,
        });
      } catch (error) {
        if (error instanceof ExtractionValidationError) {
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
    return {
      status: 'needs-review',
      reason: result.failureReason ?? 'provider-error',
      source: 'fallback',
      cacheKey: result.cacheKey,
      model: result.response.model,
      degraded: true,
    };
  }
  return {
    status: 'extracted',
    extraction: structuredAssessmentResponseSchema.parse(result.response.structured),
    source: result.source,
    cacheKey: result.cacheKey,
    model: result.response.model,
    degraded: result.degraded,
  };
}
