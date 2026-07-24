import type { LoadedConfig } from '../../shared/config/schemas';
import type {
  AgentEventProvenance,
  AgentResponseBoard,
  NormalizedAgentAction,
  ResponseContract,
} from '../../shared/agent/contracts';
import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
} from '../../shared/agent/contracts';
import {
  sessionSchema,
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
import { latestAgentUnderstanding } from './understanding';
import {
  buildStudentMemoryIndex,
  createInitialStudentMemorySnapshot,
  latestStudentMemorySnapshot,
  mergeResolvedQuestionSnapshot,
  recallStudentMemory,
} from './student-memory';
import type { StudentMemorySnapshotV1 } from '../../shared/agent/memory';

export const AGENT_TEACHER_FALLBACK_QUESTION =
  'AI 导师暂时无法安全生成下一问。请选择你当前最接近的状态。';
export const AGENT_TEACHER_FALLBACK_SUMMARY =
  '本轮训练已结束。系统已保留你的作答与判分记录，教师可据此继续指导。';
export const AGENT_TEACHER_FALLBACK_BOARD = {
  kind: 'choice',
  options: [
    { id: 'continue', label: '可以继续' },
    { id: 'rephrase', label: '换一种问法' },
    { id: 'unsure', label: '还不确定' },
  ],
} satisfies AgentResponseBoard;
const AGENT_LEGACY_FILL_BOARD = {
  kind: 'fill-blank',
  placeholder: '填写关键词',
  maxLength: 40,
} satisfies AgentResponseBoard;

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
  commitUnderstanding?: boolean;
  caseRunId?: string;
  sdkSessionId?: string;
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
      if (terminal.name === 'ask_student') {
        return [
          terminal.arguments.text,
          ...(terminal.arguments.board?.kind === 'choice'
            ? terminal.arguments.board.options.map((option) => option.label)
            : []),
        ];
      }
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

function containsMultipleStudentPrompts(text: string) {
  const questionMarkCount = text.match(/[？?]/gu)?.length ?? 0;
  const enumeratedPromptCount = text.match(
    /(?:^|\n)\s*(?:\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])/gmu,
  )?.length ?? 0;
  const compoundDirective = new RegExp(
    '(?:判断|选择|填写|写出|指出|说明|解释|比较|计算|配平)'
      + '.{0,80}(?:并|再|然后|接着|同时|以及|且)'
      + '.{0,20}(?:判断|选择|填写|写出|指出|说明|解释|比较|计算|配平)',
    'u',
  ).test(text);
  return questionMarkCount > 1
    || enumeratedPromptCount > 1
    || compoundDirective
    || /(?:分别|依次|同时).{0,12}(?:回答|说明|判断|写出|选择|填写|指出)/u.test(text);
}

export class AgentToolHandler {
  private readonly failures = new Map<'question' | 'summary', number>();
  private readonly session: StudentSession;
  private selectedObjectiveId: string | undefined;
  private questionRunId: string | undefined;
  private memorySnapshot: StudentMemorySnapshotV1;
  private readonly resolvedObjectiveIds: Set<string>;

  constructor(private readonly options: AgentToolHandlerOptions) {
    this.session = sessionSchema.parse(options.session);
    const latest = latestStudentMemorySnapshot(this.session);
    this.memorySnapshot = latest ?? createInitialStudentMemorySnapshot({
      session: this.session,
      config: this.options.config,
      snapshotId: `${this.session.id}-memory-initial`,
      occurredAt: this.options.occurredAt,
    });
    this.resolvedObjectiveIds = new Set(this.memorySnapshot.resolvedObjectives
      .filter((entry) => entry.caseId === options.identity.caseId)
      .map((entry) => entry.objectiveId));
    const active = [...this.session.events].reverse().find((event) =>
      event.kind === 'agent.question.started'
      && event.caseRunId === options.caseRunId
      && !this.session.events.some((candidate) =>
        candidate.kind === 'agent.question.resolved'
        && candidate.questionRunId === event.questionRunId));
    if (active?.kind === 'agent.question.started') {
      this.selectedObjectiveId = active.objectiveId;
      this.questionRunId = active.questionRunId;
    }
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
      case 'select_objective':
        return this.selectObjective(action);
      case 'show_question_card':
        return this.showQuestionCard(action);
      case 'show_case_material':
        return this.showCaseMaterial(action);
      case 'focus_cognitive_node':
        return this.focusCognitiveNode(action);
      case 'recall_student_memory':
        return this.recallMemory(action);
      case 'update_student_understanding':
        return this.updateUnderstanding(action);
      case 'resolve_question':
        return this.resolveQuestion(action);
      case 'end_case':
        return this.endCase(action);
    }
  }

  private currentCase() {
    return this.options.config.cases.find(
      (entry) => entry.id === this.options.identity.caseId,
    );
  }

  private objective(objectiveId: string) {
    return this.currentCase()?.agentObjectives.find((entry) => entry.id === objectiveId);
  }

  private sourceAnswerForCurrentQuestion() {
    const trigger = this.session.events.find(
      (event) => event.id === this.options.triggerEventId,
    );
    const sourceAnswerId = trigger?.kind === 'agent.input.pending'
      ? trigger.triggerEventId
      : trigger?.id;
    const answer = this.session.events.find((event) =>
      event.id === sourceAnswerId
      && event.kind === 'answer.submitted');
    if (!answer || answer.kind !== 'answer.submitted' || !answer.responseToAgentTurnId) {
      return undefined;
    }
    const questionTurn = this.session.events.find((event) =>
      event.kind === 'agent.turn.completed'
      && event.turnId === answer.responseToAgentTurnId
      && event.caseRunId === this.options.caseRunId);
    if (!questionTurn || questionTurn.kind !== 'agent.turn.completed') {
      return undefined;
    }
    const terminal = questionTurn.orderedActions.find(
      (action) => action.callId === questionTurn.terminalAction.callId,
    );
    if (
      !terminal
      || terminal.name !== 'show_question_card'
      || terminal.arguments.objectiveId !== this.selectedObjectiveId
    ) {
      return undefined;
    }
    return answer;
  }

  private updatedCurrentObjectiveInThisTurn() {
    return this.options.transaction.recordedActions.some((action) =>
      action.name === 'update_student_understanding'
      && action.arguments.objectiveId === this.selectedObjectiveId);
  }

  private requireCaseRun(action: NormalizedAgentAction) {
    if (!this.options.caseRunId || !this.options.sdkSessionId) {
      return rejected(
        action,
        'missing-case-run',
        'case-level SDK session metadata is required',
      );
    }
    return null;
  }

  private selectObjective(
    action: Extract<NormalizedAgentAction, { name: 'select_objective' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    const objective = this.objective(action.arguments.objectiveId);
    if (!objective) {
      return rejected(action, 'unknown-objective', 'objectiveId is not in this case');
    }
    if (this.resolvedObjectiveIds.has(objective.id)) {
      return rejected(action, 'objective-resolved', 'select an unresolved objective');
    }
    if (
      this.selectedObjectiveId
      && this.selectedObjectiveId !== objective.id
    ) {
      return rejected(
        action,
        'objective-in-progress',
        `finish ${this.selectedObjectiveId} before selecting another objective`,
      );
    }
    this.selectedObjectiveId = objective.id;
    this.questionRunId = `${this.options.caseRunId}:question:${objective.id}`;
    this.options.transaction.recordAction(action);
    if (!this.session.events.some((event) =>
      event.kind === 'agent.question.started'
      && event.questionRunId === this.questionRunId)) {
      this.options.transaction.stageWrite({
        id: `${this.options.turnId}-question-started-${objective.id}`,
        occurredAt: this.options.occurredAt,
        kind: 'agent.question.started',
        pipelineStage: 'agent',
        ...this.options.identity,
        caseRunId: this.options.caseRunId!,
        questionRunId: this.questionRunId,
        objectiveId: objective.id,
      });
    }
    return success(action, {
      objectiveId: objective.id,
      questionRunId: this.questionRunId,
      goal: objective.goal,
      targetNodeIds: objective.targetNodeIds,
      allowedBoards: objective.boardKinds,
    });
  }

  private showQuestionCard(
    action: Extract<NormalizedAgentAction, { name: 'show_question_card' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    const objective = this.objective(action.arguments.objectiveId);
    if (!objective || objective.id !== this.selectedObjectiveId) {
      return rejected(
        action,
        'objective-not-selected',
        'show_question_card must target the current selected objective',
      );
    }
    if (!objective.boardKinds.includes(action.arguments.board.kind)) {
      return rejected(
        action,
        'board-not-allowed',
        `objective ${objective.id} does not allow ${action.arguments.board.kind}`,
      );
    }
    if (containsMultipleStudentPrompts(action.arguments.text)) {
      return rejected(
        action,
        'multiple-student-questions',
        'show_question_card must contain at most one question',
      );
    }
    if (
      action.arguments.board.kind === 'short-fill'
      && action.arguments.board.maxLength > 40
    ) {
      return rejected(action, 'answer-too-long', 'short-fill has an absolute 40 character limit');
    }
    if (
      action.arguments.board.kind === 'short-fill'
      && /(?:完整句子|完整语句|一段|详细说明|详细解释|阐述|论述|说明理由|解释原因)/u
        .test(action.arguments.text)
    ) {
      return rejected(
        action,
        'long-response-request',
        'short-fill can request only a keyword, symbol, material name, or short value',
      );
    }
    if (
      this.sourceAnswerForCurrentQuestion()
      && !this.updatedCurrentObjectiveInThisTurn()
    ) {
      return rejected(
        action,
        'missing-understanding-update',
        'update_student_understanding is required after every student answer',
      );
    }
    const responseContractId = responseContractIdFor(
      this.options.turnId,
      action.callId,
      objective.id,
    );
    const existing = this.options.responseContracts.get(
      this.session.id,
      responseContractId,
    );
    const responseContract = existing ?? (
      objective.equationSetId
        ? this.options.responseContracts.issueQuestion({
            sessionId: this.session.id,
            agentTurnId: this.options.turnId,
            questionId: `${this.options.identity.caseId}:${objective.equationSetId}`,
            caseId: this.options.identity.caseId,
            createdThroughSequence:
              this.options.builtContext.context.contextThroughSequence,
            responseContractId,
          }, this.options.config)
        : this.options.responseContracts.issueUnassessed({
            sessionId: this.session.id,
            agentTurnId: this.options.turnId,
            caseId: this.options.identity.caseId,
            createdThroughSequence:
              this.options.builtContext.context.contextThroughSequence,
            reason: 'conversation-only',
            responseContractId,
          })
    );
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
      objectiveId: objective.id,
      questionRunId: this.questionRunId,
      responseContractId,
    });
  }

  private showCaseMaterial(
    action: Extract<NormalizedAgentAction, { name: 'show_case_material' }>,
  ) {
    const currentCase = this.currentCase();
    const material = currentCase?.materials.find(
      (entry) => entry.id === action.arguments.materialId,
    );
    if (!material || material.status !== 'ready' || !material.materialRef) {
      return rejected(action, 'material-unavailable', 'material is not configured or ready');
    }
    const resolvedNodes = new Set(this.memorySnapshot.nodes
      .filter((node) => node.state !== 'unseen')
      .map((node) => node.nodeId));
    const blocked = material.revealAfterNodeIds.filter((nodeId) => !resolvedNodes.has(nodeId));
    if (blocked.length > 0) {
      return rejected(action, 'material-gated', `material requires nodes: ${blocked.join(', ')}`);
    }
    this.options.transaction.recordAction(action);
    return success(action, {
      materialId: material.id,
      kind: material.kind,
      materialRef: material.materialRef,
    });
  }

  private focusCognitiveNode(
    action: Extract<NormalizedAgentAction, { name: 'focus_cognitive_node' }>,
  ) {
    if (!this.options.config.knowledgeModel.nodes.some(
      (node) => node.id === action.arguments.nodeId,
    )) {
      return rejected(action, 'unknown-node', 'nodeId is not configured');
    }
    this.options.transaction.recordAction(action);
    return success(action, {
      nodeId: action.arguments.nodeId,
      mode: action.arguments.mode,
      authoritative: false,
    });
  }

  private recallMemory(
    action: Extract<NormalizedAgentAction, { name: 'recall_student_memory' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    let request:
      | { kind: 'index' }
      | { kind: 'node'; nodeId: string }
      | { kind: 'dimension'; dimensionId: string }
      | { kind: 'evidence'; eventId: string };
    if (action.arguments.kind === 'index') request = { kind: 'index' };
    else if (action.arguments.kind === 'node') request = {
      kind: 'node',
      nodeId: action.arguments.nodeId,
    };
    else if (action.arguments.kind === 'dimension') request = {
      kind: 'dimension',
      dimensionId: action.arguments.dimensionId,
    };
    else request = {
      kind: 'evidence',
      eventId: action.arguments.eventId,
    };
    try {
      const recalled = recallStudentMemory(
        this.memorySnapshot,
        this.options.config,
        request,
      );
      this.options.transaction.recordAction(action);
      this.options.transaction.stageWrite({
        id: `${this.options.turnId}-memory-recalled-${action.callId}`,
        occurredAt: this.options.occurredAt,
        kind: 'agent.memory.recalled',
        pipelineStage: 'agent',
        ...this.options.identity,
        caseRunId: this.options.caseRunId!,
        snapshotId: this.memorySnapshot.snapshotId,
        topicKind: action.arguments.kind,
        ...(action.arguments.kind === 'node'
          ? { topicKey: action.arguments.nodeId }
          : action.arguments.kind === 'dimension'
            ? { topicKey: action.arguments.dimensionId }
            : action.arguments.kind === 'evidence'
              ? { topicKey: action.arguments.eventId }
              : {}),
      });
      return success(action, recalled);
    } catch (error) {
      return rejected(
        action,
        'memory-topic-not-found',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private validateObjectiveUpdates(
    action: Extract<NormalizedAgentAction, {
      name: 'update_student_understanding' | 'resolve_question';
    }>,
  ) {
    const objective = this.objective(action.arguments.objectiveId);
    if (!objective || objective.id !== this.selectedObjectiveId) {
      return rejected(
        action,
        'objective-not-selected',
        'understanding updates must target the current objective',
      );
    }
    const outside = action.arguments.updates.find(
      (update) => !objective.targetNodeIds.includes(update.nodeId),
    );
    if (outside) {
      return rejected(
        action,
        'node-outside-objective',
        `node ${outside.nodeId} is outside objective ${objective.id}`,
      );
    }
    return objective;
  }

  private updateUnderstanding(
    action: Extract<NormalizedAgentAction, { name: 'update_student_understanding' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    const objective = this.validateObjectiveUpdates(action);
    if (!('id' in objective)) return objective;
    const sourceAnswer = this.sourceAnswerForCurrentQuestion();
    if (!sourceAnswer) {
      return rejected(
        action,
        'missing-student-answer',
        'working understanding requires an answer to this objective question card',
      );
    }
    if (action.arguments.updates.some(
      (update) => !update.evidenceEventIds.includes(sourceAnswer.id),
    )) {
      return rejected(
        action,
        'missing-current-answer-evidence',
        'every working update must cite the current student answer event',
      );
    }
    this.options.transaction.recordAction(action);
    this.options.transaction.stageWrite({
      id: `${this.options.turnId}-understanding-${action.callId}`,
      occurredAt: this.options.occurredAt,
      kind: 'agent.understanding.updated',
      pipelineStage: 'agent',
      ...this.options.identity,
      caseRunId: this.options.caseRunId!,
      questionRunId: this.questionRunId!,
      objectiveId: objective.id,
      sourceAnswerEventId: sourceAnswer.id,
      updates: action.arguments.updates,
    });
    return success(action, {
      status: 'working',
      persistence: 'sdk-session',
      provisionalProjection: action.arguments.updates.map((update) => ({
        nodeId: update.nodeId,
        state: update.state,
      })),
    });
  }

  private resolveQuestion(
    action: Extract<NormalizedAgentAction, { name: 'resolve_question' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    const objective = this.validateObjectiveUpdates(action);
    if (!('id' in objective)) return objective;
    const sourceAnswer = this.sourceAnswerForCurrentQuestion();
    if (!sourceAnswer) {
      return rejected(
        action,
        'missing-student-answer',
        'an atomic question can resolve only after its own displayed card was answered',
      );
    }
    if (!this.updatedCurrentObjectiveInThisTurn()) {
      return rejected(
        action,
        'missing-understanding-update',
        'update_student_understanding must run before resolve_question',
      );
    }
    if (action.arguments.updates.some(
      (update) => !update.evidenceEventIds.includes(sourceAnswer.id),
    )) {
      return rejected(
        action,
        'missing-current-answer-evidence',
        'every committed update must cite the current student answer event',
      );
    }
    try {
      const snapshotId = `${this.options.turnId}-snapshot-${objective.id}`;
      const caseCompleted = this.currentCase()?.agentObjectives.every(
        (candidate) =>
          candidate.id === objective.id
          || this.resolvedObjectiveIds.has(candidate.id),
      ) ?? false;
      const next = mergeResolvedQuestionSnapshot({
        previous: this.memorySnapshot,
        session: this.session,
        config: this.options.config,
        snapshotId,
        caseId: this.options.identity.caseId,
        objectiveId: objective.id,
        sourceQuestionId: this.questionRunId!,
        sourceThroughSequence:
          this.options.builtContext.context.contextThroughSequence,
        occurredAt: this.options.occurredAt,
        updates: action.arguments.updates,
        caseCompleted,
      });
      const index = buildStudentMemoryIndex(next);
      this.options.transaction.recordAction(action);
      this.options.transaction.stageWrite({
        id: `${this.options.turnId}-question-resolved-${objective.id}`,
        occurredAt: this.options.occurredAt,
        kind: 'agent.question.resolved',
        pipelineStage: 'agent',
        ...this.options.identity,
        caseRunId: this.options.caseRunId!,
        questionRunId: this.questionRunId!,
        objectiveId: objective.id,
        summary: action.arguments.summary,
        snapshotId,
      });
      this.options.transaction.stageWrite({
        id: `${this.options.turnId}-memory-snapshot-${objective.id}`,
        occurredAt: this.options.occurredAt,
        kind: 'agent.memory.snapshot.committed',
        pipelineStage: 'agent',
        ...this.options.identity,
        caseRunId: this.options.caseRunId!,
        questionRunId: this.questionRunId!,
        objectiveId: objective.id,
        snapshot: next,
        index,
      });
      if (objective.unlockAnchorId) {
        const anchor = this.currentCase()?.followingAnchors.find(
          (entry) => entry.id === objective.unlockAnchorId,
        );
        const values = new Map(anchor?.correctValue.split(';').map((entry) => {
          const separator = entry.indexOf('=');
          return [
            entry.slice(0, separator).trim(),
            entry.slice(separator + 1).trim(),
          ];
        }) ?? []);
        const negative = values.get('negative');
        const positive = values.get('positive');
        if (!anchor || !negative || !positive) {
          throw new Error(`Reveal anchor ${objective.unlockAnchorId} is invalid`);
        }
        this.options.transaction.stageWrite({
          id: `${this.options.turnId}-anchor-revealed-${anchor.id}`,
          occurredAt: this.options.occurredAt,
          kind: 'agent.anchor.revealed',
          pipelineStage: 'agent',
          ...this.options.identity,
          caseRunId: this.options.caseRunId!,
          objectiveId: objective.id,
          anchorId: anchor.id,
          values: { negative, positive },
        });
      }
      this.memorySnapshot = next;
      this.resolvedObjectiveIds.add(objective.id);
      this.selectedObjectiveId = undefined;
      this.questionRunId = undefined;
      return success(action, {
        status: 'committed',
        snapshotId,
        index,
      });
    } catch (error) {
      return rejected(
        action,
        'invalid-memory-update',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private endCase(
    action: Extract<NormalizedAgentAction, { name: 'end_case' }>,
  ) {
    const missingRun = this.requireCaseRun(action);
    if (missingRun) return missingRun;
    const currentCase = this.currentCase();
    if (!currentCase) return rejected(action, 'unknown-case', 'case is not configured');
    const unresolved = currentCase.agentObjectives
      .filter((objective) => !this.resolvedObjectiveIds.has(objective.id))
      .map((objective) => objective.id);
    if (unresolved.length > 0) {
      return rejected(
        action,
        'unresolved-objectives',
        `resolve before ending: ${unresolved.join(', ')}`,
      );
    }
    this.options.transaction.recordAction(action);
    this.options.transaction.stageWrite({
      id: `${this.options.turnId}-case-completed`,
      occurredAt: this.options.occurredAt,
      kind: 'agent.case.completed',
      pipelineStage: 'agent',
      ...this.options.identity,
      caseRunId: this.options.caseRunId!,
      sdkSessionId: this.options.sdkSessionId!,
      summary: action.arguments.summary,
      finalSnapshotId: this.memorySnapshot.snapshotId,
    });
    return success(action, {
      status: 'case-ended',
      finalSnapshotId: this.memorySnapshot.snapshotId,
    });
  }

  private askStudent(
    input: Extract<NormalizedAgentAction, { name: 'ask_student' }>,
  ) {
    // Archived recordings predate response boards. Canonicalize them at the
    // execution boundary so replay remains possible without reintroducing a
    // long-form text area into the student UI.
    const action: Extract<NormalizedAgentAction, { name: 'ask_student' }> =
      input.arguments.board
        ? input
        : normalizedAgentActionSchema.parse({
          ...input,
          arguments: {
            ...input.arguments,
            board: AGENT_LEGACY_FILL_BOARD,
          },
        }) as Extract<NormalizedAgentAction, { name: 'ask_student' }>;
    const board = action.arguments.board ?? AGENT_LEGACY_FILL_BOARD;
    if (containsMultipleStudentPrompts(action.arguments.text)) {
      return rejected(
        action,
        'multiple-student-questions',
        'ask_student must contain at most one student-facing question',
      );
    }
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
      text: [
        action.arguments.text,
        ...(board.kind === 'choice'
          ? board.options.map((option) => option.label)
          : []),
      ].join('\n'),
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
    if (question.kind !== 'choice' && question.kind !== 'equation') {
      return rejected(
        action,
        'question-requires-response-board',
        'Long-form configured questions must be decomposed into one ask_student board',
      );
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
    return success(action, {
      updated: true,
      persistence: 'working-memory',
      commitPolicy: 'final-training-end',
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
    const committedNodeIds = this.options.commitUnderstanding
      ? this.stageUnderstandingCommit()
      : [];
    this.options.transaction.recordAction(action);
    return success(action, {
      status: 'session-ended',
      guardPath: guarded.path,
      understanding: this.options.commitUnderstanding
        ? { status: 'committed', nodeIds: committedNodeIds }
        : { status: 'working-memory', nodeIds: [] },
    });
  }

  private stageUnderstandingCommit() {
    const understanding = latestAgentUnderstanding(this.session, {
      turnId: this.options.turnId,
      triggerEventId: this.options.triggerEventId,
      contextThroughSequence: this.options.builtContext.context.contextThroughSequence,
      ...this.options.identity,
      provenance: this.options.provenance,
      actions: this.options.transaction.recordedActions,
    });
    const committedNodeIds: string[] = [];
    for (const entry of understanding) {
      if (entry.persistence !== 'working-memory') continue;
      const judgmentId =
        `${this.options.turnId}-understanding-${entry.nodeId}`;
      this.options.transaction.stageWrite({
        id: judgmentId,
        occurredAt: this.options.occurredAt,
        kind: 'agent.judgment.recorded',
        pipelineStage: 'agent',
        caseId: entry.caseId,
        stageId: entry.stageId,
        attemptId: entry.attemptId,
        turnId: entry.turnId,
        nodeId: entry.nodeId,
        verdict: entry.verdict,
        rationale: entry.rationale,
        basisThroughSequence: entry.basisThroughSequence,
        basisEventIds: entry.basisEventIds,
        ...(entry.supersedesEventId
          ? { supersedesEventId: entry.supersedesEventId }
          : {}),
        provenance: entry.provenance,
      });
      const shadow = selectShadowAssessmentAtBasis(
        this.session,
        this.options.config,
        entry.nodeId,
        entry.basisThroughSequence,
      );
      if (shadow.status === 'comparable' && entry.verdict !== 'inconclusive') {
        this.options.transaction.stageWrite({
          id: `${this.options.turnId}-understanding-divergence-${entry.nodeId}`,
          occurredAt: this.options.occurredAt,
          kind: 'agent.divergence.changed',
          pipelineStage: 'agent',
          caseId: entry.caseId,
          stageId: entry.stageId,
          attemptId: entry.attemptId,
          judgmentEventId: judgmentId,
          shadowAssessmentEventId: shadow.assessmentEventId,
          agentVerdict: entry.verdict,
          shadowVerdict: shadow.verdict,
          status: entry.verdict === shadow.verdict ? 'resolved' : 'detected',
          comparisonPolicyVersion: AGENT_SHADOW_COMPARISON_POLICY_VERSION,
        });
      }
      committedNodeIds.push(entry.nodeId);
    }
    return committedNodeIds;
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
        board: AGENT_TEACHER_FALLBACK_BOARD,
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
    const committedNodeIds = this.options.commitUnderstanding
      ? this.stageUnderstandingCommit()
      : [];
    this.options.transaction.recordAction(action);
    return success(action, {
      status: 'teacher-fallback',
      category: 'unsafe-summary-repeated',
      understanding: this.options.commitUnderstanding
        ? { status: 'committed', nodeIds: committedNodeIds }
        : { status: 'working-memory', nodeIds: [] },
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

}

export function isTerminalAgentAction(action: NormalizedAgentAction) {
  return terminalAgentActionNameSchema.safeParse(action.name).success;
}
