import { createHash, randomUUID } from 'node:crypto';

import type { LoadedConfig } from '../../shared/config/schemas';
import type { PretestConfig } from '../../shared/config/schemas';
import {
  agentAnswerSubmissionSchema,
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';
import { appendSessionEvent, createSession } from '../../shared/session/session';
import { appendAssessmentAudit } from '../../shared/workflows/assessment-audit';
import { classifyTextResponse } from '../../shared/workflows/assessment';
import { recordChoiceAssessment } from '../../shared/workflows/choice-assessment';
import {
  recordBuilderAssessment,
  recordEquationAssessment,
} from '../../shared/workflows/engine-assessment';
import {
  recordNeedsReviewTextAssessments,
  recordStructuredTextAssessment,
} from '../../shared/workflows/assessment';
import { recordDirectAssessment } from '../../shared/workflows/direct-assessment';
import { recordPretestEquationAssessments } from '../../shared/workflows/pretest-equation-assessment';
import type { ResponseContract } from '../../shared/agent/contracts';
import type { EvalCandidateWriter } from '../llm/eval-candidate-store';
import type { LLMService } from '../llm/service';
import type { LLMExecutionMode } from '../llm/types';
import type { LoadedPrompt } from '../prompts/loader';
import { runAssessmentExtraction } from '../workflows/assessment-extraction';
import { runDirectAssessment } from '../workflows/direct-assessment';
import { ResponseContractRegistry } from './response-contracts';

export class AgentAnswerBoardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentAnswerBoardValidationError';
  }
}

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
            reviewNodes: extraction.reviewNodes,
          })
        : recordNeedsReviewTextAssessments({
            session,
            config: input.config,
            answer: input.answer,
            nodeIds: extraction.reviewNodes.map((review) => review.nodeId),
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

export interface AgentDirectPrimaryAssessmentInput extends AgentTextShadowAssessmentInput {
  selectedOptionId?: string;
}

export interface AgentDirectPrimaryAssessment {
  assess(input: AgentDirectPrimaryAssessmentInput): Promise<{ session: StudentSession }>;
}

export class ExistingDirectPrimaryAssessment implements AgentDirectPrimaryAssessment {
  constructor(private readonly options: {
    service: LLMService;
    directPrompt: LoadedPrompt;
    textAudit: AgentTextShadowAssessment;
    executionMode: LLMExecutionMode;
    provider: string;
    model: string;
  }) {}

  async assess(input: AgentDirectPrimaryAssessmentInput) {
    const question = input.config.pretest.questions.find((entry) =>
      entry.id === input.contract.questionId
      && entry.directAssessment?.mode === 'record-primary');
    if (!question?.directAssessment) {
      throw new Error('Direct response contract has no configured direct question');
    }
    if (
      input.contract.targetNodeIds.length !== question.targetNodeIds.length
      || input.contract.targetNodeIds.some((nodeId, index) =>
        nodeId !== question.targetNodeIds[index])
    ) {
      throw new Error('Direct response contract targets do not match its configured question');
    }
    const directQuestion = { ...question, directAssessment: question.directAssessment };
    const assistance = { kind: 'none' as const, rounds: 0 };
    const substantive = classifyTextResponse(input.answer.value) === 'substantive';
    const direct = substantive
      ? await runDirectAssessment({
          service: this.options.service,
          config: input.config,
          prompt: this.options.directPrompt,
          question: directQuestion,
          answer: input.answer.value,
          ...(input.selectedOptionId
            ? { selectedOptionId: input.selectedOptionId }
            : {}),
          assistance,
          executionMode: this.options.executionMode,
          provider: this.options.provider,
          model: this.options.model,
        })
      : null;
    let session = recordDirectAssessment({
      session: input.session,
      config: input.config,
      question: directQuestion,
      answer: input.answer,
      ...(direct ? { assessments: direct.assessments } : {}),
      assistance,
      provenance: direct
        ? {
            promptId: this.options.directPrompt.id,
            promptVersion: this.options.directPrompt.version,
            cacheKey: direct.cacheKey,
            model: direct.model,
          }
        : {
            promptId: this.options.directPrompt.id,
            promptVersion: this.options.directPrompt.version,
            cacheKey: `deterministic:${question.directAssessment.version}:non-response`,
            model: 'deterministic-non-response',
          },
      assessmentEventIdPrefix: `${input.answer.id}-direct`,
      assessedAt: input.answer.occurredAt,
    }).session;

    const auditBase = createSession({
      id: input.session.id,
      anonymousStudentId: input.session.anonymousStudentId,
      now: input.session.startedAt,
      configVersions: input.session.configVersions,
    });
    const auditAnswer = {
      ...input.answer,
      id: `${input.answer.id}-audit-source`,
    };
    let auditSession: StudentSession;
    try {
      if (!substantive) {
        auditSession = recordDirectAssessment({
          session: auditBase,
          config: input.config,
          question: directQuestion,
          answer: auditAnswer,
          assistance,
          provenance: {
            promptId: 'assessment-audit',
            promptVersion: 'assessment-audit.v1',
            cacheKey: `deterministic:${question.directAssessment.version}:non-response-audit`,
            model: 'deterministic-non-response',
          },
          assessmentEventIdPrefix: `${input.answer.id}-audit-source`,
          assessedAt: input.answer.occurredAt,
        }).session;
      } else if (question.type === 'choice') {
        if (!input.selectedOptionId) {
          throw new Error('Direct choice response contract has no selected option');
        }
        let auditId = 0;
        auditSession = recordChoiceAssessment({
          session: auditBase,
          config: input.config,
          question,
          optionId: input.selectedOptionId,
          rawAnswer: input.answer.value,
          occurredAt: input.answer.occurredAt,
          attemptId: input.answer.attemptId,
          idFactory: (prefix) => `${prefix}-${input.answer.id}-audit-${auditId++}`,
        }).session;
      } else {
        auditSession = (await this.options.textAudit.assess({
          session: auditBase,
          config: input.config,
          contract: input.contract,
          answer: auditAnswer,
        })).session;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[assessment-audit] agent response audit failed: ${detail}`);
      auditSession = recordNeedsReviewTextAssessments({
        session: auditBase,
        config: input.config,
        answer: auditAnswer,
        nodeIds: question.targetNodeIds,
        assistance,
        reason: 'The legacy assessment audit could not produce a reliable result.',
        provenance: {
          promptId: 'assessment-audit',
          promptVersion: 'assessment-audit.v1',
          cacheKey: `deterministic:${question.directAssessment.version}:audit-failure`,
          model: 'audit-fallback',
        },
        assessmentEventIdPrefix: `${input.answer.id}-audit-failure`,
        assessedAt: input.answer.occurredAt,
      }).session;
    }
    session = appendAssessmentAudit({
      session,
      auditSession,
      sourceAnswerEventId: input.answer.id,
      questionId: question.id,
      targetNodeIds: question.targetNodeIds,
      eventIdPrefix: `${input.answer.id}-audit`,
      occurredAt: input.answer.occurredAt,
    });
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
  directAssessment?: AgentDirectPrimaryAssessment;
  idFactory?: (prefix: string) => string;
}

export type AgentAnswerAssessmentStatus =
  | 'choice-assessed'
  | 'text-assessed'
  | 'equation-assessed'
  | 'builder-assessed'
  | 'unassessed';

function statusForContract(contract: ResponseContract): AgentAnswerAssessmentStatus {
  switch (contract.assessmentEntrypoint.kind) {
    case 'choice':
    case 'direct-choice':
      return 'choice-assessed';
    case 'text-extraction':
    case 'direct-text':
      return 'text-assessed';
    case 'equation':
      return 'equation-assessed';
    case 'builder':
      return 'builder-assessed';
    case 'unassessed':
      return 'unassessed';
  }
}

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
  const terminal = turn.orderedActions.find((action) =>
    action.callId === turn.terminalAction.callId);
  if (terminal?.name === 'show_question_card') {
    const board = terminal.arguments.board;
    if (board.kind === 'single-choice') {
      const selectedOptionId = submission.answer.format === 'choice'
        ? submission.answer.optionId
        : null;
      if (!selectedOptionId || !board.options.some((option) => option.id === selectedOptionId)) {
        throw new AgentAnswerBoardValidationError(
          'Single-choice answer must identify one option from the displayed card',
        );
      }
    } else if (board.kind === 'short-fill') {
      if (
        submission.answer.format !== 'text'
        || !submission.answer.value.trim()
        || submission.answer.value.length > board.maxLength
      ) {
        throw new AgentAnswerBoardValidationError(
          `Short-fill answer must contain 1 to ${board.maxLength} characters`,
        );
      }
    } else if (submission.answer.format !== 'equation') {
      throw new AgentAnswerBoardValidationError(
        'Equation card requires a structured equation answer',
      );
    }
  }
  const resolution = input.responseContracts.resolveSubmission({
    session,
    agentTurnId: submission.turnId,
    config: input.config,
  });
  const contract = resolution.contract;
  const stableDigest = createHash('sha256')
    .update(`${submission.turnId}\u0000${contract.responseContractId}`)
    .digest('hex')
    .slice(0, 32);
  const answerId = `answer-agent-${stableDigest}`;
  const attemptId = `attempt-agent-${stableDigest}`;
  const existingAnswer = session.events.find((event) =>
    event.kind === 'answer.submitted'
    && event.responseToAgentTurnId === submission.turnId);
  if (existingAnswer?.kind === 'answer.submitted') {
    if (existingAnswer.responseContractId !== contract.responseContractId) {
      throw new Error('Agent turn already has a response for another contract');
    }
    let expectedAnswer = submission.answer;
    if (
      contract.assessmentEntrypoint.kind === 'choice'
      && submission.answer.format === 'text'
      && contract.questionId
    ) {
      const submittedValue = submission.answer.value;
      const question = input.config.pretest.questions.find(
        (entry) => entry.id === contract.questionId && entry.type === 'choice',
      );
      const option = question?.type === 'choice'
        ? question.options.find((entry) =>
            entry.id === submittedValue
            || entry.text === submittedValue)
        : undefined;
      if (option) {
        expectedAnswer = { format: 'text', value: option.text };
      }
    }
    if (JSON.stringify(existingAnswer.answer) !== JSON.stringify(expectedAnswer)) {
      throw new Error('Agent turn answer was already submitted with different content');
    }
    return {
      session,
      contract,
      status: statusForContract(contract),
    };
  }
  const idFactory = input.idFactory
    ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const link = {
    responseToAgentTurnId: submission.turnId,
    responseContractId: contract.responseContractId,
  };
  const answerIdentity = {
    id: answerId,
    occurredAt: input.occurredAt,
    caseId: turn.caseId,
    stageId: turn.stageId,
    attemptId,
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
  if (entrypoint.kind === 'choice' || entrypoint.kind === 'direct-choice') {
    if (
      submission.answer.format !== 'text'
      && submission.answer.format !== 'choice'
    ) {
      throw new Error('Choice response contract requires a structured option id');
    }
    const question = input.config.pretest.questions.find(
      (entry) => entry.id === contract.questionId && entry.type === 'choice',
    );
    if (!question || question.type !== 'choice') {
      throw new Error(`Unknown choice question ${contract.questionId}`);
    }
    const option = question.options.find((entry) =>
      entry.id === (
        submission.answer.format === 'choice'
          ? submission.answer.optionId
          : submission.answer.value
      )
      || (
        submission.answer.format === 'text'
        && entry.text === submission.answer.value
      ));
    if (!option) throw new Error('Student response does not identify a configured option');
    const recorded = entrypoint.kind === 'direct-choice'
      ? await input.directAssessment?.assess({
          session,
          config: input.config,
          contract,
          selectedOptionId: option.id,
          answer: {
            ...answerIdentity,
            questionId: contract.questionId,
            value: submission.answer.format === 'choice'
              ? submission.answer.optionId
              : submission.answer.value,
            ...link,
          },
        })
      : recordChoiceAssessment({
          session,
          config: input.config,
          question,
          optionId: option.id,
          occurredAt: input.occurredAt,
          attemptId,
          idFactory: (prefix) =>
            prefix === 'answer-choice' ? answerId : idFactory(prefix),
          ...link,
        });
    if (!recorded) {
      throw new Error('Direct choice response assessment is not configured');
    }
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
    if (
      submission.answer.format !== 'text'
      && submission.answer.format !== 'equation'
    ) {
      throw new Error('Equation response contract requires a structured equation answer');
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
  if (entrypoint.kind === 'direct-text') {
    if (!input.directAssessment) {
      throw new Error('Direct text response assessment is not configured');
    }
    const recorded = await input.directAssessment.assess({
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
    return { session: recorded.session, contract, status: 'text-assessed' };
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
