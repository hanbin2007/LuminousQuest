import { z } from 'zod';

import type { LoadedConfig } from '../../shared/config/schemas';
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

function createClosedExtractionSchema(input: {
  config: LoadedConfig;
  caseId: string;
  targetNodeIds: readonly string[];
  assistance: AssistanceMetadata;
}) {
  const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId);
  if (!trainingCase) throw new Error(`Unknown case ${input.caseId}`);
  if (input.targetNodeIds.length === 0 || new Set(input.targetNodeIds).size !== input.targetNodeIds.length) {
    throw new Error('Extraction target node ids must be non-empty and unique');
  }
  const answerNodeIds = new Set(
    trainingCase.evidencePaths
      .filter((entry) => entry.source === 'answer')
      .map((entry) => entry.nodeId),
  );
  for (const nodeId of input.targetNodeIds) {
    if (!answerNodeIds.has(nodeId)) {
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
  objectProperties(anchorItem).anchorId = {
    type: 'string',
    enum: trainingCase.followingAnchors.map((anchor) => anchor.id),
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
    schemaVersion: 'structured-assessment.v3',
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
  }, {
    retryCount: input.config.scaffoldPolicy.extraction.retryCount,
    validateStructured: async (value) => {
      try {
        return validateAssessmentExtraction({
          extraction: value,
          answer: input.answer,
          caseId: input.caseId,
          targetNodeIds: input.targetNodeIds,
          config: input.config,
        });
      } catch (error) {
        if (error instanceof ExtractionValidationError) {
          try {
            await input.evalCandidates.record({
              category: error.category,
              answer: input.answer,
              detail: error.detail,
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
