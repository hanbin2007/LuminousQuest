import { createHash } from 'node:crypto';

import type { LoadedConfig, PretestConfig } from '../../shared/config/schemas';
import type { AssistanceMetadata } from '../../shared/scoring/rubric';
import {
  createClosedDirectAssessmentSchema,
  type AggregatedDirectAssessment,
  type DirectAssessmentResponse,
  validateDirectAssessmentResponse,
} from '../../shared/workflows/direct-assessment';
import { ExtractionValidationError } from '../../shared/workflows/extraction-validation';
import { StructuredResponseValidationError } from '../llm/errors';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';
import type { LoadedPrompt } from '../prompts/loader';

type DirectQuestion = PretestConfig['questions'][number] & {
  directAssessment: NonNullable<PretestConfig['questions'][number]['directAssessment']>;
};

function configuredReferences(config: LoadedConfig, question: DirectQuestion) {
  if (question.type !== 'text') return [];
  return question.referenceEquations.map((reference) => {
    const trainingCase = config.cases.find((entry) => entry.id === reference.caseId);
    const equationSet = trainingCase?.equationSets.find(
      (entry) => entry.id === reference.equationSetId,
    );
    if (!trainingCase || !equationSet) {
      throw new Error(
        `Direct assessment reference ${reference.caseId}/${reference.equationSetId} is missing`,
      );
    }
    return {
      caseId: trainingCase.id,
      equationSetId: equationSet.id,
      electrode: equationSet.electrode,
      medium: equationSet.medium,
      accepted: equationSet.accepted,
    };
  });
}

export function assembleDirectAssessmentInput(input: {
  config: LoadedConfig;
  question: DirectQuestion;
  answer: string;
  selectedOptionId?: string;
  voteIndex: number;
  assistance: AssistanceMetadata;
}) {
  return {
    task: 'Judge the original student answer node by node using only this server-owned scope.',
    voteIndex: input.voteIndex,
    answer: input.answer,
    assistance: input.assistance,
    question: {
      id: input.question.id,
      prompt: input.question.prompt,
      evidencePath: input.question.evidencePath,
      ...(input.question.group ? { group: input.question.group } : {}),
      ...(input.question.type === 'choice'
        ? {
            options: input.question.options.map((option) => ({
              id: option.id,
              text: option.text,
            })),
            ...(input.selectedOptionId
              ? { selectedOptionId: input.selectedOptionId }
              : {}),
          }
        : {
            referenceEquations: configuredReferences(input.config, input.question),
          }),
    },
    scoringSource: input.question.type === 'choice'
      ? {
          correctOptions: input.question.options
            .filter((option) => option.correct)
            .map((option) => ({ id: option.id, text: option.text })),
          optionMisconceptions: input.question.options.map((option) => ({
            optionId: option.id,
            misconceptionIds: option.misconceptionIds,
          })),
        }
      : {
          answerGuidance: input.question.answerGuidance ?? [],
          evidence: input.question.evidence ?? [],
          referenceEquations: configuredReferences(input.config, input.question),
        },
    nodes: input.question.targetNodeIds.map((nodeId) => {
      const node = input.config.knowledgeModel.nodes.find((entry) => entry.id === nodeId);
      if (!node) throw new Error(`Direct assessment node ${nodeId} is missing`);
      return {
        id: node.id,
        statement: node.statement,
        misconceptions: node.misconceptions.map((misconception) => ({
          id: misconception.id,
          statement: misconception.statement,
        })),
      };
    }),
    rubrics: input.question.targetNodeIds.map((nodeId) => {
      const rubric = input.config.rubrics.rubrics.find((entry) => entry.nodeId === nodeId);
      if (!rubric) throw new Error(`Direct assessment rubric for ${nodeId} is missing`);
      return {
        id: rubric.id,
        nodeId: rubric.nodeId,
        maxScore: rubric.maxScore,
        rules: rubric.rules.map((rule) => ({
          id: rule.id,
          outcome: rule.outcome,
          description: rule.description,
          score: rule.score,
        })),
      };
    }),
    scope: {
      version: input.question.directAssessment.version,
      lowConfidenceThreshold: input.question.directAssessment.lowConfidenceThreshold,
      context: input.question.directAssessment.context,
      adjudication: input.question.directAssessment.adjudication,
      nodes: input.question.directAssessment.nodes,
      examples: input.question.directAssessment.examples,
    },
  };
}

function fallbackVote(
  question: DirectQuestion,
  answer: string,
): DirectAssessmentResponse {
  const evidence = [{ quote: answer, start: 0, end: answer.length }];
  return {
    assessments: question.targetNodeIds.map((nodeId) => ({
      nodeId,
      verdict: 'needs-review',
      misconceptionIds: [],
      rationale: 'The direct assessment provider did not return a reliable judgment.',
      confidence: 0,
      reviewReason: 'provider-failure',
      evidence,
    })),
  };
}

function aggregateVotes(
  question: DirectQuestion,
  votes: readonly DirectAssessmentResponse[],
): AggregatedDirectAssessment[] {
  return question.targetNodeIds.map((nodeId, nodeIndex) => {
    const candidates = votes.map((vote) => vote.assessments[nodeIndex]!);
    const counts = new Map<string, number>();
    candidates.forEach((candidate) => {
      counts.set(candidate.verdict, (counts.get(candidate.verdict) ?? 0) + 1);
    });
    const winner = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])[0];
    if (!winner || winner[1] < 2) {
      const basis = candidates[0]!;
      return {
        ...basis,
        verdict: 'needs-review',
        misconceptionIds: [],
        rationale: 'The three direct assessment votes did not reach a per-node majority.',
        confidence: 0,
        reviewReason: 'no-majority',
        agreeingVotes: 1,
      };
    }
    const winningCandidates = candidates.filter((candidate) =>
      candidate.verdict === winner[0]);
    const basis = winningCandidates[0]!;
    const confidence = winningCandidates.reduce(
      (sum, candidate) => sum + candidate.confidence,
      0,
    ) / winningCandidates.length;
    if (
      basis.verdict !== 'needs-review'
      && confidence < question.directAssessment.lowConfidenceThreshold
    ) {
      return {
        ...basis,
        verdict: 'needs-review',
        misconceptionIds: [],
        rationale: `Majority confidence ${confidence.toFixed(3)} is below the configured threshold.`,
        confidence,
        reviewReason: 'low-confidence',
        agreeingVotes: winner[1] as 2 | 3,
      };
    }
    return {
      ...basis,
      confidence,
      agreeingVotes: winner[1] as 2 | 3,
    };
  });
}

export interface RunDirectAssessmentInput {
  service: LLMService;
  config: LoadedConfig;
  prompt: LoadedPrompt;
  question: DirectQuestion;
  answer: string;
  selectedOptionId?: string;
  assistance: AssistanceMetadata;
  executionMode: LLMExecutionMode;
  provider: string;
  model: string;
}

export async function runDirectAssessment(input: RunDirectAssessmentInput) {
  const maximumAnswerCharacters =
    input.config.scaffoldPolicy.extraction.maximumAnswerCharacters;
  if (input.answer.length > maximumAnswerCharacters) {
    throw new ExtractionValidationError(
      'answer-too-long',
      false,
      `Answer exceeds the configured ${maximumAnswerCharacters} character limit`,
      { answerLength: input.answer.length, maximumAnswerCharacters },
    );
  }
  const schema = createClosedDirectAssessmentSchema({
    config: input.config,
    question: input.question,
  });
  const executions = await Promise.all(
    Array.from({ length: input.question.directAssessment.votes }, async (_, index) => {
      const voteIndex = index + 1;
      let validated: DirectAssessmentResponse | null = null;
      const result = await input.service.execute({
        executionMode: input.executionMode,
        capability: 'structured',
        provider: input.provider,
        model: input.model,
        prompt: input.prompt,
        schemaVersion: 'direct-assessment.v1',
        configVersion: input.config.configVersion,
        input: assembleDirectAssessmentInput({
          config: input.config,
          question: input.question,
          answer: input.answer,
          ...(input.selectedOptionId
            ? { selectedOptionId: input.selectedOptionId }
            : {}),
          voteIndex,
          assistance: input.assistance,
        }),
        images: [],
        schema,
        temperature: 0.1,
      }, {
        retryCount: input.config.scaffoldPolicy.extraction.retryCount,
        timeoutMs: 6_000,
        validateStructured(value) {
          try {
            validated = validateDirectAssessmentResponse({
              value,
              answer: input.answer,
              config: input.config,
              question: input.question,
            });
            return value;
          } catch (error) {
            throw new StructuredResponseValidationError(
              `Direct assessment validation failed: ${(error as Error).message}`,
              { category: 'direct-assessment-invalid' },
            );
          }
        },
      });
      return {
        result,
        vote: validated ?? fallbackVote(input.question, input.answer),
      };
    }),
  );
  const cacheKeys = executions.map((execution) => execution.result.cacheKey);
  const cacheKey = `sha256:${createHash('sha256')
    .update(cacheKeys.join('\u0000'))
    .digest('hex')}`;
  return {
    assessments: aggregateVotes(
      input.question,
      executions.map((execution) => execution.vote),
    ),
    cacheKey,
    cacheKeys,
    model: executions.find((execution) =>
      execution.result.source !== 'fallback')?.result.response.model
      ?? executions[0]!.result.response.model,
    source: executions.some((execution) => execution.result.source === 'fallback')
      ? 'fallback' as const
      : executions[0]!.result.source,
    degraded: executions.some((execution) => execution.result.degraded),
  };
}
