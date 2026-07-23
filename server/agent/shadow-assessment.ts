import { randomUUID } from 'node:crypto';

import type { LoadedConfig } from '../../shared/config/schemas';
import type { PretestConfig } from '../../shared/config/schemas';
import {
  agentAnswerSubmissionSchema,
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';
import { appendSessionEvent } from '../../shared/session/session';
import { recordChoiceAssessment } from '../../shared/workflows/choice-assessment';
import {
  recordBuilderAssessment,
  recordEquationAssessment,
} from '../../shared/workflows/engine-assessment';
import {
  recordNeedsReviewTextAssessments,
  recordStructuredTextAssessment,
} from '../../shared/workflows/assessment';
import { recordPretestEquationAssessments } from '../../shared/workflows/pretest-equation-assessment';
import type { ResponseContract } from '../../shared/agent/contracts';
import type { EvalCandidateWriter } from '../llm/eval-candidate-store';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';
import type { LoadedPrompt } from '../prompts/loader';
import { runAssessmentExtraction } from '../workflows/assessment-extraction';
import { ResponseContractRegistry } from './response-contracts';

export interface AgentTextShadowAssessmentInput {
  session: StudentSession;
  config: LoadedConfig;
  contract: ResponseContract;
  answer: {
    id: string;
    occurredAt: string;
    caseId: string;
    stageId: string;
    attemptId: string;
    questionId: string;
    value: string;
    responseToAgentTurnId: string;
    responseContractId: string;
  };
}

export interface AgentTextShadowAssessment {
  assess(input: AgentTextShadowAssessmentInput): Promise<{ session: StudentSession }>;
}

export class ExistingTextShadowAssessment implements AgentTextShadowAssessment {
  constructor(private readonly options: {
    service: LLMService;
    evalCandidates: EvalCandidateWriter;
    prompt: LoadedPrompt;
    executionMode: LLMExecutionMode;
    provider: string;
    model: string;
    stepId?: string;
  }) {}

  async assess(input: AgentTextShadowAssessmentInput) {
    type TextQuestion = Extract<
      PretestConfig['questions'][number],
      { type: 'text' }
    >;
    const question = input.contract.caseId === 'pretest'
      ? input.config.pretest.questions.find((entry): entry is TextQuestion =>
          entry.id === input.contract.questionId && entry.type === 'text')
      : undefined;
    const trainingCase = input.contract.caseId === 'pretest'
      ? input.config.cases.find((entry) =>
          entry.id === question?.referenceEquations[0]?.caseId)
      : input.config.cases.find((entry) => entry.id === input.contract.caseId);
    if (!trainingCase) throw new Error('Text response contract has no configured case');
    const sourceByNode = new Map(
      trainingCase.evidencePaths.map((entry) => [entry.nodeId, entry.source]),
    );
    question?.evidence?.forEach((entry) => sourceByNode.set(entry.nodeId, 'answer'));
    const answerTargets = input.contract.targetNodeIds.filter(
      (nodeId) => sourceByNode.get(nodeId) === 'answer',
    );
    const equationTargets = input.contract.targetNodeIds.filter(
      (nodeId) => sourceByNode.get(nodeId) === 'equation',
    );
    if (answerTargets.length + equationTargets.length !== input.contract.targetNodeIds.length) {
      throw new Error('Text response contract contains an unsupported target node');
    }

    let session = input.session;
    if (answerTargets.length > 0) {
      const extraction = await runAssessmentExtraction({
        service: this.options.service,
        evalCandidates: this.options.evalCandidates,
        config: input.config,
        prompt: this.options.prompt,
        answer: input.answer.value,
        caseId: trainingCase.id,
        targetNodeIds: answerTargets,
        questionEvidence: question?.evidence,
        assistance: { kind: 'none', rounds: 0 },
        executionMode: this.options.executionMode,
        provider: this.options.provider,
        model: this.options.model,
        ...(this.options.stepId ? { stepId: this.options.stepId } : {}),
      });
      const provenance = {
        promptId: this.options.prompt.id,
        promptVersion: this.options.prompt.version,
        cacheKey: extraction.cacheKey,
        model: extraction.model,
      };
      const recorded = extraction.status === 'extracted'
        ? recordStructuredTextAssessment({
            session,
            config: input.config,
            answer: input.answer,
            extraction: extraction.extraction,
            provenance,
            assessmentEventIdPrefix: `${input.answer.id}-text`,
            assessedAt: input.answer.occurredAt,
            referenceCaseId: trainingCase.id,
            questionEvidence: question?.evidence,
          })
        : recordNeedsReviewTextAssessments({
            session,
            config: input.config,
            answer: input.answer,
            nodeIds: answerTargets,
            assistance: { kind: 'none', rounds: 0 },
            reason: extraction.reason,
            provenance,
            assessmentEventIdPrefix: `${input.answer.id}-text`,
            assessedAt: input.answer.occurredAt,
          });
      session = recorded.session;
    }
    if (equationTargets.length > 0) {
      session = recordPretestEquationAssessments({
        session,
        config: input.config,
        answer: input.answer,
        referenceCaseId: trainingCase.id,
        referenceEquationSetIds: question?.referenceEquations
          .filter((entry) => entry.caseId === trainingCase.id)
          .map((entry) => entry.equationSetId),
        targetNodeIds: equationTargets,
        assessmentEventIdPrefix: `${input.answer.id}-equation`,
        assessedAt: input.answer.occurredAt,
      }).session;
    }
    return { session };
  }
}

export interface SubmitAgentAnswerInput {
  session: unknown;
  config: LoadedConfig;
  responseContracts: ResponseContractRegistry;
  submission: unknown;
  occurredAt: string;
  textAssessment?: AgentTextShadowAssessment;
  idFactory?: (prefix: string) => string;
}

export type AgentAnswerAssessmentStatus =
  | 'choice-assessed'
  | 'text-assessed'
  | 'equation-assessed'
  | 'builder-assessed'
  | 'unassessed';

export async function submitAgentAnswer(
  input: SubmitAgentAnswerInput,
): Promise<{
  session: StudentSession;
  contract: ResponseContract;
  status: AgentAnswerAssessmentStatus;
}> {
  const session = sessionSchema.parse(input.session);
  const submission = agentAnswerSubmissionSchema.parse(input.submission);
  const turn = session.events.find((event) =>
    event.kind === 'agent.turn.completed'
    && event.turnId === submission.turnId);
  if (!turn || turn.kind !== 'agent.turn.completed') {
    throw new Error('Student response references an unknown agent turn');
  }
  const resolution = input.responseContracts.resolveSubmission({
    session,
    agentTurnId: submission.turnId,
    config: input.config,
  });
  const contract = resolution.contract;
  const idFactory = input.idFactory
    ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const answerId = idFactory('answer-agent');
  const link = {
    responseToAgentTurnId: submission.turnId,
    responseContractId: contract.responseContractId,
  };
  const answerIdentity = {
    id: answerId,
    occurredAt: input.occurredAt,
    caseId: turn.caseId,
    stageId: turn.stageId,
    attemptId: turn.attemptId,
  };

  if (resolution.status === 'unassessed') {
    const next = appendSessionEvent(session, {
      ...answerIdentity,
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      questionId: `agent:${submission.turnId}:conversation`,
      answer: submission.answer,
      ...link,
    });
    return { session: next, contract, status: 'unassessed' };
  }

  const entrypoint = contract.assessmentEntrypoint;
  if (!contract.questionId || !contract.caseId) {
    throw new Error('Assessed response contract is missing its question binding');
  }
  if (entrypoint.kind === 'choice') {
    if (submission.answer.format !== 'text') {
      throw new Error('Choice response contract requires a text option id');
    }
    const question = input.config.pretest.questions.find(
      (entry) => entry.id === contract.questionId && entry.type === 'choice',
    );
    if (!question || question.type !== 'choice') {
      throw new Error(`Unknown choice question ${contract.questionId}`);
    }
    const option = question.options.find((entry) =>
      entry.id === submission.answer.value
      || entry.text === submission.answer.value);
    if (!option) throw new Error('Student response does not identify a configured option');
    const recorded = recordChoiceAssessment({
      session,
      config: input.config,
      question,
      optionId: option.id,
      occurredAt: input.occurredAt,
      attemptId: turn.attemptId,
      idFactory,
      ...link,
    });
    return {
      session: recorded.session,
      contract,
      status: 'choice-assessed',
    };
  }

  if (entrypoint.kind === 'builder') {
    if (submission.answer.format !== 'builder') {
      throw new Error('Builder response contract requires a builder answer');
    }
    const recorded = recordBuilderAssessment({
      session,
      config: input.config,
      answer: {
        ...answerIdentity,
        questionId: contract.questionId,
        value: {
          components: submission.answer.value.components,
          connections: submission.answer.value.connections.map(
            (connection, index) => ({
              ...connection,
              id: connection.id ?? `connection-${index + 1}`,
            }),
          ),
        },
        ...link,
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: idFactory('assessment-agent-builder'),
      assessedAt: input.occurredAt,
    });
    return {
      session: recorded.session,
      contract,
      status: 'builder-assessed',
    };
  }

  if (entrypoint.kind === 'equation') {
    if (submission.answer.format !== 'text') {
      throw new Error('Equation response contract requires a text answer');
    }
    const recorded = recordEquationAssessment({
      session,
      config: input.config,
      equationSetId: entrypoint.equationSetId,
      answer: {
        ...answerIdentity,
        questionId: contract.questionId,
        value: submission.answer.value,
        ...link,
      },
      assistance: { kind: 'none', rounds: 0 },
      assessmentEventIdPrefix: idFactory('assessment-agent-equation'),
      assessedAt: input.occurredAt,
    });
    return {
      session: recorded.session,
      contract,
      status: 'equation-assessed',
    };
  }

  if (submission.answer.format !== 'text') {
    throw new Error('Text extraction response contract requires a text answer');
  }
  if (!input.textAssessment) {
    throw new Error('Text extraction shadow assessment is not configured');
  }
  const recorded = await input.textAssessment.assess({
    session,
    config: input.config,
    contract,
    answer: {
      ...answerIdentity,
      questionId: contract.questionId,
      value: submission.answer.value,
      ...link,
    },
  });
  const parsed = sessionSchema.parse(recorded.session);
  const linkedAnswer = parsed.events.find((event) =>
    event.kind === 'answer.submitted'
    && event.id === answerId
    && event.responseToAgentTurnId === submission.turnId
    && event.responseContractId === contract.responseContractId);
  if (!linkedAnswer) {
    throw new Error('Text assessment did not persist the response-contract linkage');
  }
  return { session: parsed, contract, status: 'text-assessed' };
}
