import type { LoadedConfig } from '../../shared/config/schemas';
import type {
  AgentEventProvenance,
  NormalizedAgentAction,
  ResponseContract,
} from '../../shared/agent/contracts';
import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
} from '../../shared/agent/contracts';
import {
  sessionSchema,
  type AssessmentCompletedEvent,
  type StudentSession,
} from '../../shared/session/schema';
import type { AgentToolExecutionResult } from './adapters/adapter';
import type { BuiltAgentTurnContext } from './context-builder';
import {
  guardFreeQuestion,
  guardQuestionBankText,
  guardStudentSummary,
  type AgentLeakageGuardResult,
} from './leakage-guard';
import {
  findAgentQuestion,
  findResponseContractCandidate,
} from './question-bank';
import {
  responseContractIdFor,
  ResponseContractRegistry,
  type ResponseContractCandidate,
} from './response-contracts';
import {
  AGENT_SHADOW_COMPARISON_POLICY_VERSION,
  selectShadowAssessmentAtBasis,
} from './shadow-comparison';
import { AgentTurnTransaction } from './turn-transaction';

export const AGENT_TEACHER_FALLBACK_QUESTION =
  'AI 导师暂时无法安全生成下一问，已切换到固定训练流程。请先说明你目前最确定的一条判断。';
export const AGENT_TEACHER_FALLBACK_SUMMARY =
  '本轮训练已结束。系统已保留你的作答与判分记录，教师可据此继续指导。';

interface AgentTurnIdentity {
  caseId: string;
  stageId: string;
  attemptId: string;
}

export interface AgentToolHandlerOptions {
  session: StudentSession;
  config: LoadedConfig;
  transaction: AgentTurnTransaction;
  responseContracts: ResponseContractRegistry;
  builtContext: BuiltAgentTurnContext;
  turnId: string;
  triggerEventId: string;
  occurredAt: string;
  identity: AgentTurnIdentity;
  provenance: AgentEventProvenance;
}

function success(
  action: NormalizedAgentAction,
  value: unknown,
): AgentToolExecutionResult {
  return {
    accepted: true,
    action,
    content: JSON.stringify({ ok: true, value }),
  };
}

function rejected(
  action: NormalizedAgentAction,
  category: string,
  detail: string,
): AgentToolExecutionResult {
  return {
    accepted: false,
    action,
    errorCategory: category,
    content: JSON.stringify({
      ok: false,
      error: { category, detail },
      repairRemaining: 1,
    }),
  };
}

function terminalText(
  session: StudentSession,
  config: LoadedConfig,
  caseId: string,
) {
  return session.events
    .filter((event): event is Extract<
      StudentSession['events'][number],
      { kind: 'agent.turn.completed' }
    > => event.kind === 'agent.turn.completed' && event.caseId === caseId)
    .flatMap((turn) => {
      const terminal = turn.orderedActions.find(
        (action) => action.callId === turn.terminalAction.callId,
      );
      if (!terminal) return [];
      if (terminal.name === 'ask_student') return [terminal.arguments.text];
      if (terminal.name === 'end_session') return [terminal.arguments.summary];
      if (terminal.name === 'present_question') {
        return [findAgentQuestion(config, terminal.arguments.questionId)?.prompt ?? ''];
      }
      return [];
    })
    .filter(Boolean);
}

function candidateForExistingContract(
  contract: ResponseContract,
  candidates: readonly ResponseContractCandidate[],
) {
  if (contract.assessmentEntrypoint.kind === 'unassessed') {
    return candidates.find((candidate) => candidate.kind === 'unassessed');
  }
  return candidates.find((candidate) =>
    candidate.kind === 'question'
    && candidate.questionId === contract.questionId
    && candidate.caseId === contract.caseId);
}

export class AgentToolHandler {
  private readonly failures = new Map<'question' | 'summary', number>();
  private readonly session: StudentSession;

  constructor(private readonly options: AgentToolHandlerOptions) {
    this.session = sessionSchema.parse(options.session);
  }

  async execute(input: NormalizedAgentAction): Promise<AgentToolExecutionResult> {
    const action = normalizedAgentActionSchema.parse(input);
    switch (action.name) {
      case 'ask_student':
        return this.askStudent(action);
      case 'present_question':
        return this.presentQuestion(action);
      case 'present_material':
        return this.presentMaterial(action);
      case 'focus_node':
        return this.focusNode(action);
      case 'get_profile':
        return this.getProfile(action);
      case 'conclude_node':
        return this.concludeNode(action);
      case 'end_session':
        return this.endSession(action);
    }
  }

  private askStudent(
    action: Extract<NormalizedAgentAction, { name: 'ask_student' }>,
  ) {
    const existing = this.options.responseContracts.get(
      this.session.id,
      action.arguments.responseContractId,
    );
    const candidate = existing
      ? candidateForExistingContract(
          existing,
          this.options.builtContext.responseContractCandidates,
        )
      : findResponseContractCandidate(
          this.options.builtContext.responseContractCandidates,
          action.arguments.responseContractId,
          { agentTurnId: this.options.turnId, callId: action.callId },
        );
    if (!candidate) {
      return this.guardFailure(
        'question',
        action,
        {
          safe: false,
          category: 'target-fact-leak',
          detail: 'response-contract-candidate-not-found',
        },
      );
    }
    const guarded = guardFreeQuestion({
      config: this.options.config,
      text: action.arguments.text,
      candidate,
      studentVisibleOutputs: terminalText(
        this.session,
        this.options.config,
        this.options.identity.caseId,
      ),
    });
    if (!guarded.safe) return this.guardFailure('question', action, guarded);

    const responseContract = existing ?? this.issueContract(action.callId, candidate);
    const canonical = normalizedAgentActionSchema.parse({
      ...action,
      arguments: {
        ...action.arguments,
        responseContractId: responseContract.responseContractId,
      },
    });
    this.options.transaction.recordAction(canonical);
    return success(canonical, {
      status: 'waiting-for-student',
      responseContractId: responseContract.responseContractId,
      guardPath: guarded.path,
    });
  }

  private presentQuestion(
    action: Extract<NormalizedAgentAction, { name: 'present_question' }>,
  ) {
    const question = findAgentQuestion(this.options.config, action.arguments.questionId);
    if (!question) {
      return rejected(action, 'unknown-question', 'questionId is not configured');
    }
    const guarded = guardQuestionBankText(question, question.prompt);
    if (!guarded.safe) return this.guardFailure('question', action, guarded);
    const candidate = this.options.builtContext.responseContractCandidates.find(
      (entry) =>
        entry.kind === 'question'
        && entry.questionId === question.questionId,
    );
    if (!candidate) {
      return rejected(
        action,
        'question-outside-current-case',
        'question has no response contract candidate in this turn',
      );
    }
    const responseContract = this.issueContract(action.callId, candidate);
    const canonical = normalizedAgentActionSchema.parse({
      ...action,
      arguments: {
        questionId: action.arguments.questionId,
        responseContractId: responseContract.responseContractId,
      },
    });
    this.options.transaction.recordAction(canonical);
    return success(canonical, {
      status: 'waiting-for-student',
      questionId: question.questionId,
      contentHash: question.contentHash,
      responseContractId: responseContract.responseContractId,
    });
  }

  private presentMaterial(
    action: Extract<NormalizedAgentAction, { name: 'present_material' }>,
  ) {
    const currentCase = this.options.config.cases.find(
      (entry) => entry.id === this.options.identity.caseId,
    );
    const configuredMaterial = currentCase?.materials.find(
      (entry) => entry.id === action.arguments.materialId,
    );
    const material = configuredMaterial && currentCase
      ? { ...configuredMaterial, caseId: currentCase.id }
      : undefined;
    if (!material) {
      return rejected(action, 'unknown-material', 'materialId is not configured');
    }
    if (material.status !== 'ready' || !material.materialRef) {
      return rejected(action, 'material-unavailable', 'material asset is not ready');
    }
    const reachedNodeIds = new Set(
      this.options.builtContext.context.recordTrack.nodes
        .filter((node) => node.status === 'scored')
        .map((node) => node.nodeId),
    );
    const unmetNodeIds = material.revealAfterNodeIds.filter(
      (nodeId) => !reachedNodeIds.has(nodeId),
    );
    if (unmetNodeIds.length > 0) {
      return rejected(
        action,
        'material-gated',
        `material requires completed nodes: ${unmetNodeIds.join(', ')}`,
      );
    }
    this.options.transaction.recordAction(action);
    return success(action, {
      materialId: material.id,
      caseId: material.caseId,
      kind: material.kind,
      materialRef: material.materialRef,
    });
  }

  private focusNode(
    action: Extract<NormalizedAgentAction, { name: 'focus_node' }>,
  ) {
    const node = this.options.config.knowledgeModel.nodes.find(
      (entry) => entry.id === action.arguments.nodeId,
    );
    if (!node) return rejected(action, 'unknown-node', 'nodeId is not configured');
    this.options.transaction.recordAction(action);
    return success(action, {
      nodeId: node.id,
      authoritative: false,
      effect: 'focus',
    });
  }

  private getProfile(
    action: Extract<NormalizedAgentAction, { name: 'get_profile' }>,
  ) {
    this.options.transaction.recordAction(action);
    return success(action, {
      diagnosticProfile: this.options.builtContext.context.diagnosticProfile,
      recordTrack: this.options.builtContext.context.recordTrack,
      latestJudgments: this.options.builtContext.context.latestJudgments,
    });
  }

  private concludeNode(
    action: Extract<NormalizedAgentAction, { name: 'conclude_node' }>,
  ) {
    if (!this.options.config.knowledgeModel.nodes.some(
      (node) => node.id === action.arguments.nodeId,
    )) {
      return rejected(action, 'unknown-node', 'nodeId is not configured');
    }
    this.options.transaction.recordAction(action);
    const judgmentId = `${this.options.turnId}-judgment-${action.callId}`;
    const basisThroughSequence = this.options.builtContext.context.contextThroughSequence;
    const basisEventIds = this.basisEventIds(action.arguments.nodeId);
    const superseded = [...this.session.events].reverse().find((event) =>
      event.kind === 'agent.judgment.recorded'
      && event.nodeId === action.arguments.nodeId);
    this.options.transaction.stageWrite({
      id: judgmentId,
      occurredAt: this.options.occurredAt,
      kind: 'agent.judgment.recorded',
      pipelineStage: 'agent',
      ...this.options.identity,
      turnId: this.options.turnId,
      nodeId: action.arguments.nodeId,
      verdict: action.arguments.verdict,
      rationale: action.arguments.rationale,
      basisThroughSequence,
      basisEventIds,
      ...(superseded ? { supersedesEventId: superseded.id } : {}),
      provenance: this.options.provenance,
    });

    const shadow = selectShadowAssessmentAtBasis(
      this.session,
      this.options.config,
      action.arguments.nodeId,
      basisThroughSequence,
    );
    if (
      shadow.status === 'comparable'
      && action.arguments.verdict !== 'inconclusive'
    ) {
      this.options.transaction.stageWrite({
        id: `${this.options.turnId}-divergence-${action.callId}`,
        occurredAt: this.options.occurredAt,
        kind: 'agent.divergence.changed',
        pipelineStage: 'agent',
        ...this.options.identity,
        judgmentEventId: judgmentId,
        shadowAssessmentEventId: shadow.assessmentEventId,
        agentVerdict: action.arguments.verdict,
        shadowVerdict: shadow.verdict,
        status: action.arguments.verdict === shadow.verdict
          ? 'resolved'
          : 'detected',
        comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
      });
    }
    return success(action, {
      recorded: true,
      shadowComparison: shadow,
    });
  }

  private endSession(
    action: Extract<NormalizedAgentAction, { name: 'end_session' }>,
  ) {
    const guarded = guardStudentSummary({
      config: this.options.config,
      caseId: this.options.identity.caseId,
      summary: action.arguments.summary,
      recentAgentOutputs: terminalText(
        this.session,
        this.options.config,
        this.options.identity.caseId,
      ),
    });
    if (!guarded.safe) return this.guardFailure('summary', action, guarded);
    this.options.transaction.recordAction(action);
    return success(action, {
      status: 'session-ended',
      guardPath: guarded.path,
    });
  }

  private guardFailure(
    kind: 'question' | 'summary',
    action: NormalizedAgentAction,
    failure: Extract<AgentLeakageGuardResult, { safe: false }>,
  ) {
    const count = (this.failures.get(kind) ?? 0) + 1;
    this.failures.set(kind, count);
    if (count === 1) {
      return rejected(action, failure.category, failure.detail);
    }
    return kind === 'question'
      ? this.fallbackQuestion(action.callId)
      : this.fallbackSummary(action.callId);
  }

  private fallbackQuestion(callId: string) {
    const candidate = this.options.builtContext.responseContractCandidates.find(
      (entry) => entry.kind === 'unassessed',
    );
    if (!candidate) throw new Error('Missing fallback response contract candidate');
    const contract = this.issueContract(callId, candidate);
    const action = normalizedAgentActionSchema.parse({
      callId,
      name: 'ask_student',
      arguments: {
        text: AGENT_TEACHER_FALLBACK_QUESTION,
        responseContractId: contract.responseContractId,
      },
    });
    this.options.transaction.recordAction(action);
    return success(action, {
      status: 'teacher-fallback',
      category: 'unsafe-question-repeated',
    });
  }

  private fallbackSummary(callId: string) {
    const action = normalizedAgentActionSchema.parse({
      callId,
      name: 'end_session',
      arguments: { summary: AGENT_TEACHER_FALLBACK_SUMMARY },
    });
    this.options.transaction.recordAction(action);
    return success(action, {
      status: 'teacher-fallback',
      category: 'unsafe-summary-repeated',
    });
  }

  private issueContract(callId: string, candidate: ResponseContractCandidate) {
    const responseContractId = responseContractIdFor(
      this.options.turnId,
      callId,
      candidate.candidateId,
    );
    if (candidate.kind === 'question' && candidate.questionId) {
      return this.options.responseContracts.issueQuestion({
        sessionId: this.session.id,
        agentTurnId: this.options.turnId,
        questionId: candidate.questionId,
        caseId: candidate.caseId,
        createdThroughSequence:
          this.options.builtContext.context.contextThroughSequence,
        responseContractId,
      }, this.options.config);
    }
    return this.options.responseContracts.issueUnassessed({
      sessionId: this.session.id,
      agentTurnId: this.options.turnId,
      caseId: candidate.caseId,
      createdThroughSequence:
        this.options.builtContext.context.contextThroughSequence,
      reason: candidate.reason ?? 'conversation-only',
      responseContractId,
    });
  }

  private basisEventIds(nodeId: string) {
    const selectedAssessmentEventId = this.options.builtContext.context.recordTrack.nodes
      .find((node) => node.nodeId === nodeId)
      ?.selectedAssessmentEventId;
    const selected = this.session.events.find(
      (event): event is AssessmentCompletedEvent =>
        event.kind === 'assessment.completed'
        && event.id === selectedAssessmentEventId,
    );
    const ids = [
      this.options.triggerEventId,
      ...(selected ? [selected.sourceAnswerEventId, selected.id] : []),
    ];
    return [...new Set(ids)].filter((id) => {
      const event = this.session.events.find((candidate) => candidate.id === id);
      return event
        && event.sequence <= this.options.builtContext.context.contextThroughSequence;
    });
  }
}

export function isTerminalAgentAction(action: NormalizedAgentAction) {
  return terminalAgentActionNameSchema.safeParse(action.name).success;
}
