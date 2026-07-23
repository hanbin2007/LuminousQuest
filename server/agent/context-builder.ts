import type { LoadedConfig } from '../../shared/config/schemas';
import { buildLearnerProfile } from '../../shared/scoring/profile';
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

export const AGENT_SYSTEM_PROMPT_VERSION = 'agent-system-prompt.v1' as const;
export const DEFAULT_AGENT_LOGICAL_ROUND_WINDOW = 6;

export const AGENT_SYSTEM_PROMPT = [
  `[${AGENT_SYSTEM_PROMPT_VERSION}]`,
  '你是 LuminousQuest 训练阶段的自主电化学导师。',
  '前测画像只用于节奏：已掌握节点快速核验，薄弱节点细致追问；不得改写记录轨结论。',
  '记录轨判分是灯态与量表账本的唯一来源。你可以独立判断，并用 conclude_node 留下依据。',
  '所有学生可见问题和总结都必须通过工具；不得在文本中泄露题库答案或未公开事实。',
  'continuation 工具可连续调用，但最终必须恰好调用一次 ask_student、present_question 或 end_session。',
  'responseContractId 必须逐字使用上下文给出的候选 id，不得自行编造。',
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
  const latest = new Map<string, Extract<
    StudentSession['events'][number],
    { kind: 'agent.judgment.recorded' }
  >>();
  session.events.forEach((event) => {
    if (event.kind === 'agent.judgment.recorded') latest.set(event.nodeId, event);
  });
  return [...latest.values()]
    .sort((left, right) => left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
    .map((event) => ({
      eventId: event.id,
      turnId: event.turnId,
      nodeId: event.nodeId,
      verdict: event.verdict,
      basisThroughSequence: event.basisThroughSequence,
      basisEventIds: event.basisEventIds,
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

function lastLogicalRounds(session: StudentSession, maximum: number): LogicalRound[] {
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
    > => event.kind === 'agent.turn.completed')
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
  if (
    event.kind === 'agent.judgment.recorded'
    || event.kind === 'agent.divergence.changed'
  ) {
    throw new Error('An audit-only event cannot trigger an agent turn');
  }
  return stripContextData(event) as Omit<typeof event, 'occurredAt' | 'schemaVersion'>;
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
  questionBank: AgentQuestionBankEntry[];
  materials: ReturnType<typeof materialIndex>;
  recentLogicalRounds: LogicalRound[];
  currentTrigger: ReturnType<typeof currentTrigger>;
  freeResponseContractCandidateId: string;
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

  const rawContext: AgentTurnContext = {
    version: AGENT_CONTEXT_BUILDER_VERSION,
    systemPromptVersion: AGENT_SYSTEM_PROMPT_VERSION,
    contextThroughSequence: session.events.length - 1,
    knowledgeModel: input.config.knowledgeModel,
    rubrics: input.config.rubrics,
    diagnosticProfile: buildDiagnosticProfile(session, input.config),
    recordTrack: recordTrackSnapshot(session, input.config),
    latestJudgments: latestJudgments(session),
    questionBank: questionBank.entries,
    materials: materialIndex(input.config),
    recentLogicalRounds: lastLogicalRounds(
      session,
      input.logicalRoundWindow ?? DEFAULT_AGENT_LOGICAL_ROUND_WINDOW,
    ),
    currentTrigger: currentTrigger(session, input.triggerEventId),
    freeResponseContractCandidateId: freeCandidate.candidateId,
  };
  const context = stripContextData(rawContext) as AgentTurnContext;
  assertSafeContextData(context);
  const serializedContext = deterministicJson(context);
  const tools = createAgentToolDefinitions();
  const maxTurns = input.maxTurns ?? 16;
  const messages = [{ role: 'user' as const, content: serializedContext }];
  const requestHash = deterministicHash({
    contextBuilderVersion: AGENT_CONTEXT_BUILDER_VERSION,
    systemPrompt: AGENT_SYSTEM_PROMPT,
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
      systemPrompt: AGENT_SYSTEM_PROMPT,
      messages,
      tools,
      maxTurns,
    },
    responseContractCandidates: questionBank.responseContractCandidates,
  };
}
