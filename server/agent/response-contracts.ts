import { randomUUID } from 'node:crypto';

import type { LoadedConfig } from '../../shared/config/schemas';
import {
  RESPONSE_CONTRACT_REVISION,
  responseContractSchema,
  type AssessmentEntrypoint,
  type ResponseContract,
  type ResponseContractUnassessedReason,
} from '../../shared/agent/contracts';
import {
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';

export class ResponseContractBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseContractBindingError';
  }
}

export interface IssueQuestionResponseContractInput {
  sessionId: string;
  agentTurnId: string;
  questionId: string;
  caseId: string;
  createdThroughSequence: number;
}

export interface IssueUnassessedResponseContractInput {
  sessionId: string;
  agentTurnId: string;
  caseId: string | null;
  createdThroughSequence: number;
  reason: ResponseContractUnassessedReason;
}

export type ResponseContractResolution =
  | { status: 'assessed'; contract: ResponseContract }
  | {
      status: 'unassessed';
      contract: ResponseContract;
      reason: ResponseContractUnassessedReason;
    };

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function questionBinding(
  input: IssueQuestionResponseContractInput,
  config: LoadedConfig,
): {
  targetNodeIds: string[];
  assessmentEntrypoint: Exclude<AssessmentEntrypoint, { kind: 'unassessed' }>;
} {
  if (input.caseId === 'pretest' && input.questionId === 'pretest-builder') {
    return {
      targetNodeIds: unique(config.pretest.builder.structuralRules.flatMap((rule) => rule.nodeIds)),
      assessmentEntrypoint: {
        kind: 'builder',
        handler: 'recordBuilderAssessment',
      },
    };
  }

  if (input.caseId === 'pretest') {
    const question = config.pretest.questions.find((entry) => entry.id === input.questionId);
    if (!question) {
      throw new ResponseContractBindingError(`Unknown pretest question ${input.questionId}`);
    }
    return {
      targetNodeIds: [...question.targetNodeIds],
      assessmentEntrypoint: question.type === 'choice'
        ? { kind: 'choice', route: '/api/assessment/choice' }
        : { kind: 'text-extraction', route: '/api/assessment/extract' },
    };
  }

  const trainingCase = config.cases.find((entry) => entry.id === input.caseId);
  if (!trainingCase) {
    throw new ResponseContractBindingError(`Unknown training case ${input.caseId}`);
  }
  if (input.questionId === `${trainingCase.id}:analysis`) {
    return {
      targetNodeIds: [...trainingCase.targetNodeIds],
      assessmentEntrypoint: {
        kind: 'text-extraction',
        route: '/api/assessment/extract',
      },
    };
  }
  const equationSet = trainingCase.equationSets.find((entry) =>
    input.questionId === `${trainingCase.id}:${entry.id}`);
  if (equationSet) {
    return {
      targetNodeIds: unique(trainingCase.evidencePaths
        .filter((entry) => entry.source === 'equation')
        .map((entry) => entry.nodeId)),
      assessmentEntrypoint: {
        kind: 'equation',
        route: '/api/assessment/equation',
        equationSetId: equationSet.id,
      },
    };
  }
  throw new ResponseContractBindingError(
    `Question ${input.questionId} is not configured for case ${input.caseId}`,
  );
}

export class ResponseContractRegistry {
  private readonly contracts = new Map<string, Map<string, ResponseContract>>();
  private readonly idFactory: () => string;

  constructor(options: { idFactory?: () => string } = {}) {
    this.idFactory = options.idFactory ?? (() => randomUUID());
  }

  issueQuestion(
    input: IssueQuestionResponseContractInput,
    config: LoadedConfig,
  ): ResponseContract {
    const binding = questionBinding(input, config);
    return this.store(responseContractSchema.parse({
      revision: RESPONSE_CONTRACT_REVISION,
      responseContractId: this.idFactory(),
      sessionId: input.sessionId,
      agentTurnId: input.agentTurnId,
      questionId: input.questionId,
      caseId: input.caseId,
      targetNodeIds: binding.targetNodeIds,
      assessmentEntrypoint: binding.assessmentEntrypoint,
      createdThroughSequence: input.createdThroughSequence,
    }));
  }

  issueUnassessed(input: IssueUnassessedResponseContractInput): ResponseContract {
    return this.store(responseContractSchema.parse({
      revision: RESPONSE_CONTRACT_REVISION,
      responseContractId: this.idFactory(),
      sessionId: input.sessionId,
      agentTurnId: input.agentTurnId,
      questionId: null,
      caseId: input.caseId,
      targetNodeIds: [],
      assessmentEntrypoint: {
        kind: 'unassessed',
        reason: input.reason,
      },
      createdThroughSequence: input.createdThroughSequence,
    }));
  }

  get(sessionId: string, responseContractId: string) {
    return this.contracts.get(sessionId)?.get(responseContractId);
  }

  resolveSubmission(input: {
    session: StudentSession;
    agentTurnId: string;
  }): ResponseContractResolution {
    const session = sessionSchema.parse(input.session);
    const turn = session.events.find((event) =>
      event.kind === 'agent.turn.completed' && event.turnId === input.agentTurnId);
    if (!turn || turn.kind !== 'agent.turn.completed') {
      throw new ResponseContractBindingError('Response agent turn was not recorded');
    }
    const terminal = turn.orderedActions.find((action) =>
      action.callId === turn.terminalAction.callId);
    if (
      !terminal
      || (terminal.name !== 'ask_student' && terminal.name !== 'present_question')
    ) {
      throw new ResponseContractBindingError('Agent turn does not accept a student response');
    }
    const contract = this.get(session.id, terminal.arguments.responseContractId);
    if (!contract) {
      throw new ResponseContractBindingError('Response contract was not issued for this session');
    }
    if (contract.agentTurnId !== input.agentTurnId) {
      throw new ResponseContractBindingError('Response contract belongs to a different agent turn');
    }
    if (contract.createdThroughSequence > turn.contextThroughSequence) {
      throw new ResponseContractBindingError('Response contract was issued beyond the turn context');
    }

    if (contract.assessmentEntrypoint.kind === 'unassessed') {
      return {
        status: 'unassessed',
        contract,
        reason: contract.assessmentEntrypoint.reason,
      };
    }
    return { status: 'assessed', contract };
  }

  private store(contract: ResponseContract) {
    const sessionContracts = this.contracts.get(contract.sessionId)
      ?? new Map<string, ResponseContract>();
    if (sessionContracts.has(contract.responseContractId)) {
      throw new ResponseContractBindingError(
        `Duplicate response contract id ${contract.responseContractId}`,
      );
    }
    if ([...sessionContracts.values()].some((existing) =>
      existing.agentTurnId === contract.agentTurnId)) {
      throw new ResponseContractBindingError(
        `Agent turn ${contract.agentTurnId} already has a response contract`,
      );
    }
    sessionContracts.set(contract.responseContractId, contract);
    this.contracts.set(contract.sessionId, sessionContracts);
    return contract;
  }
}
