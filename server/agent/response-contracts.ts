import { createHash, randomUUID } from 'node:crypto';

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
  responseContractId?: string;
}

export interface IssueUnassessedResponseContractInput {
  sessionId: string;
  agentTurnId: string;
  caseId: string | null;
  createdThroughSequence: number;
  reason: ResponseContractUnassessedReason;
  responseContractId?: string;
}

export interface ResponseContractCandidate {
  candidateId: string;
  kind: 'question' | 'unassessed';
  caseId: string;
  questionId: string | null;
  reason?: ResponseContractUnassessedReason;
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

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

const currentResponseContractIdPrefix = `rc-${
  RESPONSE_CONTRACT_REVISION.replace('response-contract.', '')
}-`;

export function responseContractIdFor(
  agentTurnId: string,
  callId: string,
  candidateId: string,
) {
  return `${currentResponseContractIdPrefix}${shortHash(
    `${RESPONSE_CONTRACT_REVISION}\u0000${agentTurnId}\u0000${callId}\u0000${candidateId}`,
  )}`;
}

export function buildResponseContractCandidates(input: {
  config: LoadedConfig;
  caseId: string;
  agentTurnId: string;
}): ResponseContractCandidate[] {
  const candidates: Array<Omit<ResponseContractCandidate, 'candidateId'>> = [];
  if (input.caseId === 'pretest') {
    candidates.push({
      kind: 'question',
      caseId: 'pretest',
      questionId: 'pretest-builder',
    });
    input.config.pretest.questions.forEach((question) => {
      candidates.push({
        kind: 'question',
        caseId: 'pretest',
        questionId: question.id,
      });
    });
  } else {
    const trainingCase = input.config.cases.find((entry) => entry.id === input.caseId);
    if (trainingCase) {
      candidates.push({
        kind: 'question',
        caseId: trainingCase.id,
        questionId: `${trainingCase.id}:analysis`,
      });
      trainingCase.equationSets.forEach((equationSet) => {
        candidates.push({
          kind: 'question',
          caseId: trainingCase.id,
          questionId: `${trainingCase.id}:${equationSet.id}`,
        });
      });
    }
  }
  candidates.push({
    kind: 'unassessed',
    caseId: input.caseId,
    questionId: null,
    reason: 'conversation-only',
  });
  return candidates.map((candidate) => ({
    ...candidate,
    candidateId: `rcc-${shortHash(
      `${input.agentTurnId}\u0000${candidate.caseId}\u0000${candidate.questionId ?? 'free'}`,
    )}`,
  }));
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
      assessmentEntrypoint: question.directAssessment?.mode === 'record-primary'
        ? question.type === 'choice'
          ? { kind: 'direct-choice', route: '/api/assessment/choice' }
          : { kind: 'direct-text', route: '/api/assessment/extract' }
        : question.type === 'choice'
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
      responseContractId: input.responseContractId ?? this.idFactory(),
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
      responseContractId: input.responseContractId ?? this.idFactory(),
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
    config?: LoadedConfig;
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
      || (
        terminal.name !== 'ask_student'
        && terminal.name !== 'present_question'
        && terminal.name !== 'show_question_card'
      )
    ) {
      throw new ResponseContractBindingError('Agent turn does not accept a student response');
    }
    const responseContractId = terminal.arguments.responseContractId;
    if (!responseContractId) {
      throw new ResponseContractBindingError('Agent question card lacks its server contract');
    }
    let contract = this.get(session.id, responseContractId);
    if (!contract && terminal.name === 'show_question_card' && input.config) {
      const objective = input.config.cases
        .find((entry) => entry.id === turn.caseId)
        ?.agentObjectives.find((entry) =>
          entry.id === terminal.arguments.objectiveId);
      if (!objective) {
        throw new ResponseContractBindingError('Agent question objective is not configured');
      }
      contract = objective.equationSetId
        ? this.issueQuestion({
            sessionId: session.id,
            agentTurnId: turn.turnId,
            questionId: `${turn.caseId}:${objective.equationSetId}`,
            caseId: turn.caseId,
            createdThroughSequence: turn.contextThroughSequence,
            responseContractId,
          }, input.config)
        : this.issueUnassessed({
            sessionId: session.id,
            agentTurnId: turn.turnId,
            caseId: turn.caseId,
            createdThroughSequence: turn.contextThroughSequence,
            reason: 'conversation-only',
            responseContractId,
          });
    }
    if (!contract && input.config && terminal.name !== 'show_question_card') {
      contract = this.recoverContract({
        session,
        turn,
        terminal,
        config: input.config,
      });
    }
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

  discardTurn(sessionId: string, agentTurnId: string) {
    const sessionContracts = this.contracts.get(sessionId);
    if (!sessionContracts) return;
    for (const [contractId, contract] of sessionContracts) {
      if (contract.agentTurnId === agentTurnId) sessionContracts.delete(contractId);
    }
    if (sessionContracts.size === 0) this.contracts.delete(sessionId);
  }

  private recoverContract(input: {
    session: StudentSession;
    turn: Extract<StudentSession['events'][number], { kind: 'agent.turn.completed' }>;
    terminal: Extract<
      Extract<StudentSession['events'][number], { kind: 'agent.turn.completed' }>['orderedActions'][number],
      { name: 'ask_student' | 'present_question' }
    >;
    config: LoadedConfig;
  }) {
    const responseContractId = input.terminal.arguments.responseContractId;
    const candidates = buildResponseContractCandidates({
      config: input.config,
      caseId: input.turn.caseId,
      agentTurnId: input.turn.turnId,
    });
    let candidate = candidates.find((entry) =>
      responseContractIdFor(
        input.turn.turnId,
        input.terminal.callId,
        entry.candidateId,
      ) === responseContractId);
    if (
      !candidate
      && responseContractId.startsWith(currentResponseContractIdPrefix)
      && input.terminal.name === 'present_question'
    ) {
      const questionId = input.terminal.arguments.questionId;
      candidate = candidates.find((entry) =>
        entry.kind === 'question'
        && entry.questionId === questionId);
    }
    if (!candidate) return undefined;
    if (candidate.kind === 'question' && candidate.questionId) {
      return this.issueQuestion({
        sessionId: input.session.id,
        agentTurnId: input.turn.turnId,
        questionId: candidate.questionId,
        caseId: candidate.caseId,
        createdThroughSequence: input.turn.contextThroughSequence,
        responseContractId,
      }, input.config);
    }
    return this.issueUnassessed({
      sessionId: input.session.id,
      agentTurnId: input.turn.turnId,
      caseId: candidate.caseId,
      createdThroughSequence: input.turn.contextThroughSequence,
      reason: candidate.reason ?? 'conversation-only',
      responseContractId,
    });
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
