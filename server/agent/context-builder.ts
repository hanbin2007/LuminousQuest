import type { LoadedConfig } from '../../shared/config/schemas';
import { buildLearnerProfile } from '../../shared/scoring/profile';
import { isAuditOnlyEvent } from '../../shared/session/audit';
import {
  sessionSchema,
  type AssessmentCompletedEvent,
  type StudentSession,
} from '../../shared/session/schema';
import {
  AGENT_CONTEXT_BUILDER_VERSION,
  type AgentRequestHash,
} from '../../shared/agent/contracts';
import type { AgentTurnAdapterRequest } from './adapters/adapter';
import { buildDiagnosticProfile } from './diagnostic-profile';
import { deterministicHash, deterministicJson } from './deterministic-json';
import {
  buildAgentQuestionBankIndex,
  type AgentQuestionBankEntry,
} from './question-bank';
import type { ResponseContractCandidate } from './response-contracts';
import { createAgentToolDefinitions } from './tools';
import { latestAgentUnderstanding } from './understanding';
import {
  buildStudentMemoryIndex,
  createInitialStudentMemorySnapshot,
  latestStudentMemorySnapshot,
} from './student-memory';

export const AGENT_SYSTEM_PROMPT_VERSION = 'agent-system-prompt.v3' as const;
export const DEFAULT_AGENT_LOGICAL_ROUND_WINDOW = 6;
// Keep non-Agent providers/package smoke independent of the optional SDK runtime.
// This is the public boundary token exported by @anthropic-ai/claude-agent-sdk.
export const AGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__' as const;

export const AGENT_SYSTEM_PROMPT = [
  `[${AGENT_SYSTEM_PROMPT_VERSION}]`,
  '你是 LuminousQuest 训练阶段的自主电化学导师。',
  '一个案例对应一个 Claude session；案例内所有原子目标共享完整对话，案例之间不得引用自然语言 transcript。',
  '前测基线不可改写。每次案例启动都会注入完整前测基线和最新学生记忆索引。',
  '每次学生回答后必须先调用 update_student_understanding，实时更新题内工作理解。',
  '每个理解更新都必须把本轮 studentResponse.answerEventId 放入 evidenceEventIds，形成可核验证据链。',
  '同一原子目标可以反复追问；只有你确认已解决后才调用 resolve_question。',
  'resolve_question 会原子写入完整学生记忆快照，并返回最新索引供同一案例下一题立即使用。',
  '只能从服务端目标池选择目标。先 select_objective，再围绕该目标逐次追问。',
  '每轮永远只显示一个问题。只能使用 single-choice、short-fill 或 equation-fill。',
  'short-fill 默认不超过 24 字，绝对上限 40 字；禁止要求完整句子、长段解释或组合回答。',
  '题干最多一个问句，禁止“分别回答”“依次说明”等多问表达。',
  '所有学生可见问题、材料、3D 聚焦和案例结束都必须通过工具。',
  'focus_cognitive_node 只改变镜头和光圈，不代表掌握；不得直接指定灯色、极性或电极名称。',
  '每个 SDK query 最终必须恰好调用一次 show_question_card 或 end_case，且必须是最后一次工具调用。',
  '不要生成预设替代题；调用失败时由产品保留当前题卡并显示重试。',
].join('\n');
export const AGENT_RECORDING_PROMPT = {
  id: 'agent-loop',
  version: 'agent-loop.v1',
  text: AGENT_SYSTEM_PROMPT,
} as const;

interface LogicalRound {
  agentTurnId: string;
  actions: Array<{
    name: string;
    arguments: unknown;
  }>;
  response?: {
    answerEventId: string;
    questionId: string;
    answer: unknown;
  };
}

function selectedMisconceptions(
  session: StudentSession,
  selectedEventId: string | undefined,
) {
  if (!selectedEventId) return [];
  const assessment = session.events.find((event): event is AssessmentCompletedEvent =>
    event.kind === 'assessment.completed' && event.id === selectedEventId);
  return [...new Set(assessment?.misconceptionIds ?? [])].sort();
}

function recordTrackSnapshot(session: StudentSession, config: LoadedConfig) {
  const profile = buildLearnerProfile(session, config);
  return {
    nodes: profile.nodes.map((node) => ({
      nodeId: node.nodeId,
      status: node.status,
      ...(node.latestAttempt ? { latestAttempt: node.latestAttempt } : {}),
      ...(node.outcome ? { outcome: node.outcome } : {}),
      misconceptionIds: selectedMisconceptions(
        session,
        node.selectedAssessment?.eventId,
      ),
      ...(node.selectedAssessment
        ? { selectedAssessmentEventId: node.selectedAssessment.eventId }
        : {}),
      ...(node.earned !== undefined ? { earned: node.earned } : {}),
      ...(node.possible !== undefined ? { possible: node.possible } : {}),
      ...(node.trace ? { trace: node.trace } : {}),
    })),
    dimensions: profile.dimensions.map((dimension) => ({
      dimensionId: dimension.dimensionId,
      earned: dimension.earned,
      possible: dimension.possible,
      ratio: dimension.ratio,
      level: dimension.level,
      weak: dimension.weak,
      assessedNodeIds: dimension.assessedNodeIds,
      unassessedNodeIds: dimension.unassessedNodeIds,
      needsReviewNodeIds: dimension.needsReviewNodeIds,
    })),
    overallRatio: profile.overallRatio,
    weakNodeIds: profile.weakNodeIds,
  };
}

function latestJudgments(session: StudentSession) {
  return latestAgentUnderstanding(session).map((entry) => ({
    eventId: entry.persistedEventId ?? `working:${entry.turnId}:${entry.callId}`,
    turnId: entry.turnId,
    nodeId: entry.nodeId,
    verdict: entry.verdict,
    basisThroughSequence: entry.basisThroughSequence,
    basisEventIds: entry.basisEventIds,
    persistence: entry.persistence,
  }));
}

function contextActionArguments(
  action: Extract<
    StudentSession['events'][number],
    { kind: 'agent.turn.completed' }
  >['orderedActions'][number],
) {
  if (action.name !== 'conclude_node') return action.arguments;
  return {
    nodeId: action.arguments.nodeId,
    verdict: action.arguments.verdict,
  };
}

function lastLogicalRounds(
  session: StudentSession,
  maximum: number,
  caseId: string,
): LogicalRound[] {
  const responseByTurn = new Map(
    session.events
      .filter((event): event is Extract<
        StudentSession['events'][number],
        { kind: 'answer.submitted' }
      > => event.kind === 'answer.submitted' && Boolean(event.responseToAgentTurnId))
      .map((event) => [event.responseToAgentTurnId!, event]),
  );
  return session.events
    .filter((event): event is Extract<
      StudentSession['events'][number],
      { kind: 'agent.turn.completed' }
    > => event.kind === 'agent.turn.completed' && event.caseId === caseId)
    .map((turn): LogicalRound => {
      const response = responseByTurn.get(turn.turnId);
      return {
        agentTurnId: turn.turnId,
        actions: turn.orderedActions.map((action) => ({
          name: action.name,
          arguments: contextActionArguments(action),
        })),
        ...(response
          ? {
              response: {
                answerEventId: response.id,
                questionId: response.questionId,
                answer: response.answer,
              },
            }
          : {}),
      };
    })
    .slice(-maximum);
}

function currentTrigger(session: StudentSession, triggerEventId: string) {
  const event = session.events.find((candidate) => candidate.id === triggerEventId);
  if (!event) throw new Error(`Unknown agent trigger event ${triggerEventId}`);
  if (isAuditOnlyEvent(event)) {
    throw new Error('An audit-only event cannot trigger an agent turn');
  }
  return stripContextData(event) as Omit<typeof event, 'occurredAt' | 'schemaVersion'>;
}

function pendingStudentResponse(session: StudentSession, triggerEventId: string) {
  const pending = session.events.find((event) =>
    event.id === triggerEventId && event.kind === 'agent.input.pending');
  if (!pending || pending.kind !== 'agent.input.pending') return null;
  const answer = session.events.find((event) =>
    event.id === pending.triggerEventId
    && event.kind === 'answer.submitted'
    && Boolean(event.responseToAgentTurnId));
  if (!answer || answer.kind !== 'answer.submitted') return null;
  return {
    answerEventId: answer.id,
    responseToAgentTurnId: answer.responseToAgentTurnId!,
    responseContractId: answer.responseContractId!,
    questionId: answer.questionId,
    answer: answer.answer,
  };
}

function materialIndex(config: LoadedConfig) {
  return config.cases.flatMap((trainingCase) =>
    trainingCase.materials.map((material) => ({
      caseId: trainingCase.id,
      materialId: material.id,
      kind: material.kind,
      status: material.status,
      revealAfterNodeIds: material.revealAfterNodeIds,
    })));
}

function isTimingKey(key: string, value: unknown) {
  return key === 'occurredAt'
    || key.toLowerCase().includes('elapsed')
    || (key.endsWith('Ms') && typeof value === 'number');
}

const answerDataKeys = new Set([
  'answerKey',
  'correctValue',
  'acceptedValues',
  'accepted',
  'answerGuidance',
  'referenceEquations',
  'referenceAnswerPoints',
  'factRequirements',
]);

function stripContextData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripContextData);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, entry]) =>
        key !== 'schemaVersion'
        && key !== 'rationale'
        && !answerDataKeys.has(key)
        && !(record.kind === 'polarity.revealed' && key === 'values')
        && !isTimingKey(key, entry))
      .map(([key, entry]) => [key, stripContextData(entry)]),
  );
}

function assertSafeContextData(value: unknown) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertSafeContextData);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    if (isTimingKey(key, entry)) {
      throw new Error(`Agent context cannot contain timing field ${key}`);
    }
    if (
      answerDataKeys.has(key)
      || (record.kind === 'polarity.revealed' && key === 'values')
    ) {
      throw new Error(`Agent context cannot contain answer field ${key}`);
    }
    assertSafeContextData(entry);
  }
}

export interface BuildAgentTurnContextInput {
  session: unknown;
  config: LoadedConfig;
  triggerEventId: string;
  turnId: string;
  currentCaseId: string;
  provider?: string;
  model: string;
  maxTurns?: number;
  logicalRoundWindow?: number;
  caseRunId?: string;
  sdkSessionId?: string;
  resume?: boolean;
}

export interface AgentTurnContext {
  version: typeof AGENT_CONTEXT_BUILDER_VERSION;
  systemPromptVersion: typeof AGENT_SYSTEM_PROMPT_VERSION;
  contextThroughSequence: number;
  knowledgeModel: LoadedConfig['knowledgeModel'];
  rubrics: LoadedConfig['rubrics'];
  diagnosticProfile: ReturnType<typeof buildDiagnosticProfile>;
  recordTrack: ReturnType<typeof recordTrackSnapshot>;
  latestJudgments: ReturnType<typeof latestJudgments>;
  learnerUnderstanding: {
    persistencePolicy: 'per-question-full-snapshot';
    nodes: ReturnType<typeof latestJudgments>;
  };
  questionBank: AgentQuestionBankEntry[];
  materials: ReturnType<typeof materialIndex>;
  recentLogicalRounds: LogicalRound[];
  currentTrigger: ReturnType<typeof currentTrigger>;
  freeResponseContractCandidateId: string;
  caseAgent: {
    caseRunId: string | null;
    sdkSessionId: string | null;
    resume: boolean;
    case: {
      id: string;
      title: string;
      caseType: 'training' | 'transfer';
      medium: string;
    };
    objectives: Array<{
      id: string;
      goal: string;
      targetNodeIds: string[];
      boardKinds: Array<'single-choice' | 'short-fill' | 'equation-fill'>;
      equationSetId?: string;
    }>;
    materials: Array<{
      id: string;
      kind: string;
      status: string;
      revealAfterNodeIds: string[];
    }>;
    pretestBaseline: ReturnType<typeof createInitialStudentMemorySnapshot>['pretestBaseline'];
    memoryIndex: ReturnType<typeof buildStudentMemoryIndex>;
  };
}

export interface BuiltAgentTurnContext {
  context: AgentTurnContext;
  serializedContext: string;
  requestHash: AgentRequestHash;
  adapterRequest: AgentTurnAdapterRequest;
  responseContractCandidates: ResponseContractCandidate[];
}

export function buildAgentTurnContext(
  input: BuildAgentTurnContextInput,
): BuiltAgentTurnContext {
  const session = sessionSchema.parse(input.session);
  if (session.events.length === 0) {
    throw new Error('An agent turn requires an earlier trigger event');
  }
  const questionBank = buildAgentQuestionBankIndex({
    config: input.config,
    currentCaseId: input.currentCaseId,
    agentTurnId: input.turnId,
  });
  const freeCandidate = questionBank.responseContractCandidates.find(
    (candidate) => candidate.kind === 'unassessed',
  );
  if (!freeCandidate) throw new Error('Agent context lacks an unassessed response candidate');
  const trainingCase = input.config.cases.find((entry) =>
    entry.id === input.currentCaseId) ?? input.config.cases[0];
  if (!trainingCase) throw new Error('Agent context requires at least one configured case');
  const snapshot = latestStudentMemorySnapshot(session)
    ?? createInitialStudentMemorySnapshot({
      session,
      config: input.config,
      snapshotId: `${session.id}-memory-initial`,
      occurredAt: session.updatedAt,
    });

  const rawContext: AgentTurnContext = {
    version: AGENT_CONTEXT_BUILDER_VERSION,
    systemPromptVersion: AGENT_SYSTEM_PROMPT_VERSION,
    contextThroughSequence: session.events.length - 1,
    knowledgeModel: input.config.knowledgeModel,
    rubrics: input.config.rubrics,
    diagnosticProfile: buildDiagnosticProfile(session, input.config),
    recordTrack: recordTrackSnapshot(session, input.config),
    latestJudgments: latestJudgments(session),
    learnerUnderstanding: {
      persistencePolicy: 'per-question-full-snapshot',
      nodes: latestJudgments(session),
    },
    questionBank: questionBank.entries,
    materials: materialIndex(input.config),
    recentLogicalRounds: lastLogicalRounds(
      session,
      input.logicalRoundWindow ?? DEFAULT_AGENT_LOGICAL_ROUND_WINDOW,
      input.currentCaseId,
    ),
    currentTrigger: currentTrigger(session, input.triggerEventId),
    freeResponseContractCandidateId: freeCandidate.candidateId,
    caseAgent: {
      caseRunId: input.caseRunId ?? null,
      sdkSessionId: input.sdkSessionId ?? null,
      resume: input.resume ?? false,
      case: {
        id: trainingCase.id,
        title: trainingCase.title,
        caseType: trainingCase.caseType,
        medium: trainingCase.medium,
      },
      objectives: trainingCase.agentObjectives.map((objective) => ({
        id: objective.id,
        goal: objective.goal,
        targetNodeIds: [...objective.targetNodeIds],
        boardKinds: [...objective.boardKinds],
        ...(objective.equationSetId
          ? { equationSetId: objective.equationSetId }
          : {}),
      })),
      materials: trainingCase.materials.map((material) => ({
        id: material.id,
        kind: material.kind,
        status: material.status,
        revealAfterNodeIds: [...material.revealAfterNodeIds],
      })),
      pretestBaseline: snapshot.pretestBaseline,
      memoryIndex: buildStudentMemoryIndex(snapshot),
    },
  };
  const context = stripContextData(rawContext) as AgentTurnContext;
  assertSafeContextData(context);
  const serializedContext = deterministicJson(context);
  const tools = createAgentToolDefinitions();
  const maxTurns = input.maxTurns ?? 16;
  const messages = [{
    role: 'user' as const,
    content: input.resume
      ? deterministicJson({
          type: 'student-turn',
          caseRunId: input.caseRunId,
          currentTrigger: rawContext.currentTrigger,
          studentResponse: pendingStudentResponse(session, input.triggerEventId),
          instruction:
            'Process this single student response using the existing case conversation. '
            + 'Update working understanding, then either ask one next atomic question, '
            + 'or resolve the objective and continue to exactly one next card/end_case.',
        })
      : serializedContext,
  }];
  const dynamicSystemContext = deterministicJson({
    caseRunId: input.caseRunId ?? null,
    sdkSessionId: input.sdkSessionId ?? null,
    caseId: trainingCase.id,
    objectiveIds: trainingCase.agentObjectives.map((objective) => objective.id),
    memorySnapshotId: snapshot.snapshotId,
    coldTransfer: trainingCase.caseType === 'transfer',
  });
  const systemPrompt = [
    AGENT_SYSTEM_PROMPT,
    AGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    dynamicSystemContext,
  ];
  const requestHash = deterministicHash({
    contextBuilderVersion: AGENT_CONTEXT_BUILDER_VERSION,
    systemPrompt,
    provider: input.provider,
    model: input.model,
    maxTurns,
    messages,
    tools,
  });

  return {
    context,
    serializedContext,
    requestHash,
    adapterRequest: {
      requestHash,
      model: input.model,
      systemPrompt,
      messages,
      tools,
      maxTurns,
    },
    responseContractCandidates: questionBank.responseContractCandidates,
  };
}
