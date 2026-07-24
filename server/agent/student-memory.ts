import type { LoadedConfig } from '../../shared/config/schemas';
import {
  studentMemoryIndexV1Schema,
  studentMemoryNodeUpdateSchema,
  studentMemorySnapshotV1Schema,
  studentMemoryTopicV1Schema,
  type StudentMemoryIndexV1,
  type StudentMemoryNode,
  type StudentMemoryNodeUpdate,
  type StudentMemorySnapshotV1,
} from '../../shared/agent/memory';
import {
  sessionSchema,
  type AssessmentCompletedEvent,
  type StudentSession,
} from '../../shared/session/schema';
import { buildDiagnosticProfile } from './diagnostic-profile';

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function assessmentVerdict(event: AssessmentCompletedEvent) {
  if (
    event.extraction.status === 'needs-review'
    || event.ruleDecision.status === 'needs-review'
    || event.following.status === 'needs-review'
    || event.score.status === 'needs-review'
  ) return 'needs-review' as const;
  if (event.score.status !== 'scored') return 'unassessed' as const;
  const outcome = event.score.outcome ?? event.ruleDecision.status;
  if (outcome === 'hit' || outcome === 'hit-with-help') return 'hit' as const;
  if (outcome === 'partial') return 'partial' as const;
  if (outcome === 'miss') return 'miss' as const;
  return 'unassessed' as const;
}

function baselineState(
  status: 'scored' | 'unassessed' | 'needs-review',
  outcome?: 'hit' | 'hit-with-help' | 'partial' | 'miss',
) {
  if (status === 'needs-review') return 'uncertain' as const;
  if (status !== 'scored') return 'unseen' as const;
  if (outcome === 'hit') return 'mastered' as const;
  if (outcome === 'hit-with-help' || outcome === 'partial') return 'developing' as const;
  if (outcome === 'miss') return 'not-yet' as const;
  return 'unseen' as const;
}

function latestFormalAssessments(session: StudentSession) {
  const latest = new Map<string, AssessmentCompletedEvent>();
  for (const event of session.events) {
    if (event.kind !== 'assessment.completed') continue;
    latest.set(event.nodeId, event);
  }
  return [...latest.values()]
    .map((event) => ({
      nodeId: event.nodeId,
      assessmentEventId: event.id,
      verdict: assessmentVerdict(event),
      occurredAt: event.occurredAt,
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

function buildDivergences(
  nodes: StudentMemoryNode[],
  formal: ReturnType<typeof latestFormalAssessments>,
) {
  const formalByNode = new Map(formal.map((entry) => [entry.nodeId, entry]));
  return nodes.flatMap((node) => {
    const entry = formalByNode.get(node.nodeId);
    if (!entry) return [];
    const matches = (
      (entry.verdict === 'hit' && node.state === 'mastered')
      || (entry.verdict === 'partial' && node.state === 'developing')
      || (entry.verdict === 'miss' && node.state === 'not-yet')
      || (entry.verdict === 'needs-review' && node.state === 'uncertain')
      || (entry.verdict === 'unassessed' && node.state === 'unseen')
    );
    return [{
      nodeId: node.nodeId,
      agentState: node.state,
      formalVerdict: entry.verdict,
      status: matches ? 'matched' as const : 'detected' as const,
    }];
  });
}

export function createInitialStudentMemorySnapshot(input: {
  session: unknown;
  config: LoadedConfig;
  snapshotId: string;
  occurredAt: string;
}): StudentMemorySnapshotV1 {
  const session = sessionSchema.parse(input.session);
  const diagnostic = buildDiagnosticProfile(session, input.config);
  const byNode = new Map(diagnostic.nodes.map((node) => [node.nodeId, node]));
  const nodes: StudentMemoryNode[] = input.config.knowledgeModel.nodes.map((configured) => {
    const diagnosticNode = byNode.get(configured.id);
    const evidenceEventIds = diagnosticNode
      ? unique(diagnosticNode.evidence.flatMap((evidence) => [
          evidence.sourceAnswerEventId,
          evidence.assessmentEventId,
        ]))
      : [];
    return {
      nodeId: configured.id,
      state: diagnosticNode
        ? baselineState(diagnosticNode.status, diagnosticNode.outcome)
        : 'unseen',
      confidence: diagnosticNode?.status === 'scored' ? 0.75 : 0,
      rationale: diagnosticNode?.status === 'scored'
        ? 'Initialized from the immutable pretest baseline.'
        : '',
      misconceptionIds: diagnosticNode?.misconceptionIds ?? [],
      evidenceEventIds,
      updatedAt: input.occurredAt,
      sourceQuestionId: null,
    };
  });
  const formalAssessments = latestFormalAssessments(session);
  return studentMemorySnapshotV1Schema.parse({
    version: 'student-memory-snapshot.v1',
    snapshotId: input.snapshotId,
    studentId: session.anonymousStudentId,
    previousSnapshotId: null,
    sourceQuestionId: null,
    sourceThroughSequence: Math.max(0, diagnostic.baselineThroughSequence ?? 0),
    occurredAt: input.occurredAt,
    configVersions: session.configVersions,
    pretestBaseline: {
      source: 'pretest',
      capturedThroughSequence: diagnostic.baselineThroughSequence,
      nodes: structuredClone(nodes),
    },
    nodes,
    formalAssessments,
    divergences: buildDivergences(nodes, formalAssessments),
    supportDependencies: input.config.knowledgeModel.nodes.map((node) => ({
      nodeId: node.id,
      dependsOn: [...node.dependsOn],
    })),
    resolvedObjectives: [],
    caseProgress: input.config.cases.map((trainingCase) => ({
      caseId: trainingCase.id,
      resolvedObjectiveIds: [],
      completed: false,
    })),
    interactionSignals: {
      answerCount: session.events.filter((event) => event.kind === 'answer.submitted').length,
      assistanceCount: session.events.filter((event) =>
        event.kind === 'assessment.completed'
        && event.assistance.kind !== 'none').length,
      retryCount: 0,
    },
  });
}

export function mergeResolvedQuestionSnapshot(input: {
  previous: StudentMemorySnapshotV1;
  session: unknown;
  config: LoadedConfig;
  snapshotId: string;
  caseId: string;
  objectiveId: string;
  sourceQuestionId: string;
  sourceThroughSequence: number;
  occurredAt: string;
  updates: StudentMemoryNodeUpdate[];
  caseCompleted?: boolean;
}): StudentMemorySnapshotV1 {
  const previous = studentMemorySnapshotV1Schema.parse(input.previous);
  const session = sessionSchema.parse(input.session);
  if (previous.studentId !== session.anonymousStudentId) {
    throw new Error('Student memory snapshot belongs to a different student');
  }
  if (previous.configVersions.configDigest !== session.configVersions.configDigest) {
    throw new Error('Student memory snapshot uses a different configuration');
  }
  if (!input.config.cases.some((entry) => entry.id === input.caseId)) {
    throw new Error(`Unknown case ${input.caseId}`);
  }
  const knownNodes = new Map(input.config.knowledgeModel.nodes.map((node) => [node.id, node]));
  const knownEvents = new Set(
    session.events
      .filter((event) => event.sequence <= input.sourceThroughSequence)
      .map((event) => event.id),
  );
  const parsedUpdates = input.updates.map((candidate) =>
    studentMemoryNodeUpdateSchema.parse(candidate));
  const updateByNode = new Map<string, StudentMemoryNodeUpdate>();
  for (const update of parsedUpdates) {
    const node = knownNodes.get(update.nodeId);
    if (!node) throw new Error(`Unknown knowledge node ${update.nodeId}`);
    if (updateByNode.has(update.nodeId)) {
      throw new Error(`Duplicate knowledge node update ${update.nodeId}`);
    }
    for (const misconceptionId of update.misconceptionIds) {
      if (!node.misconceptions.some((entry) => entry.id === misconceptionId)) {
        throw new Error(`Unknown misconception ${misconceptionId} for node ${update.nodeId}`);
      }
    }
    for (const evidenceEventId of update.evidenceEventIds) {
      if (!knownEvents.has(evidenceEventId)) {
        throw new Error(`Forged or future evidence event ${evidenceEventId}`);
      }
    }
    updateByNode.set(update.nodeId, update);
  }
  const nodes = previous.nodes.map((node) => {
    const update = updateByNode.get(node.nodeId);
    if (!update) return structuredClone(node);
    return {
      nodeId: update.nodeId,
      state: update.state,
      confidence: update.confidence,
      rationale: update.rationale,
      misconceptionIds: unique(update.misconceptionIds),
      evidenceEventIds: unique(update.evidenceEventIds),
      updatedAt: input.occurredAt,
      sourceQuestionId: input.sourceQuestionId,
    };
  });
  const formalAssessments = latestFormalAssessments(session);
  const resolvedObjectives = [
    ...previous.resolvedObjectives.filter((entry) =>
      entry.caseId !== input.caseId || entry.objectiveId !== input.objectiveId),
    {
      caseId: input.caseId,
      objectiveId: input.objectiveId,
      questionId: input.sourceQuestionId,
      resolvedAt: input.occurredAt,
    },
  ];
  const caseProgress = previous.caseProgress.map((progress) => {
    if (progress.caseId !== input.caseId) return progress;
    return {
      ...progress,
      resolvedObjectiveIds: unique([...progress.resolvedObjectiveIds, input.objectiveId]),
      completed: input.caseCompleted ?? progress.completed,
    };
  });
  return studentMemorySnapshotV1Schema.parse({
    ...previous,
    snapshotId: input.snapshotId,
    previousSnapshotId: previous.snapshotId,
    sourceQuestionId: input.sourceQuestionId,
    sourceThroughSequence: input.sourceThroughSequence,
    occurredAt: input.occurredAt,
    nodes,
    formalAssessments,
    divergences: buildDivergences(nodes, formalAssessments),
    resolvedObjectives,
    caseProgress,
    interactionSignals: {
      ...previous.interactionSignals,
      answerCount: session.events.filter((event) => event.kind === 'answer.submitted').length,
      assistanceCount: session.events.filter((event) =>
        event.kind === 'assessment.completed'
        && event.assistance.kind !== 'none').length,
      retryCount: session.events.reduce((count, event) =>
        event.kind === 'agent.turn.completed'
          ? count + Math.max(0, (event.providerAttempts ?? 1) - 1)
          : count, 0),
    },
  });
}

export function buildStudentMemoryIndex(
  snapshotInput: StudentMemorySnapshotV1,
): StudentMemoryIndexV1 {
  const snapshot = studentMemorySnapshotV1Schema.parse(snapshotInput);
  const divergences = new Set(snapshot.divergences
    .filter((entry) => entry.status === 'detected')
    .map((entry) => entry.nodeId));
  return studentMemoryIndexV1Schema.parse({
    version: 'student-memory-index.v1',
    snapshotId: snapshot.snapshotId,
    sourceThroughSequence: snapshot.sourceThroughSequence,
    counts: {
      mastered: snapshot.nodes.filter((node) => node.state === 'mastered').length,
      developing: snapshot.nodes.filter((node) => node.state === 'developing').length,
      'not-yet': snapshot.nodes.filter((node) => node.state === 'not-yet').length,
      uncertain: snapshot.nodes.filter((node) => node.state === 'uncertain').length,
      unseen: snapshot.nodes.filter((node) => node.state === 'unseen').length,
    },
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      state: node.state,
      confidence: node.confidence,
      hasMisconception: node.misconceptionIds.length > 0,
      hasDivergence: divergences.has(node.nodeId),
    })),
    resolvedObjectives: snapshot.resolvedObjectives.map((entry) => ({
      caseId: entry.caseId,
      objectiveId: entry.objectiveId,
    })),
  });
}

export type StudentMemoryRecallRequest =
  | { kind: 'index' }
  | { kind: 'node'; nodeId: string }
  | { kind: 'dimension'; dimensionId: string }
  | { kind: 'evidence'; eventId: string };

export function recallStudentMemory(
  snapshotInput: StudentMemorySnapshotV1,
  config: LoadedConfig,
  request: StudentMemoryRecallRequest,
) {
  const snapshot = studentMemorySnapshotV1Schema.parse(snapshotInput);
  if (request.kind === 'index') {
    return { kind: 'index' as const, value: buildStudentMemoryIndex(snapshot) };
  }
  const nodeIds = request.kind === 'node'
    ? [request.nodeId]
    : request.kind === 'dimension'
      ? config.knowledgeModel.nodes
          .filter((node) => node.dimensionId === request.dimensionId)
          .map((node) => node.id)
      : snapshot.nodes
          .filter((node) => node.evidenceEventIds.includes(request.eventId))
          .map((node) => node.nodeId);
  if (nodeIds.length === 0) throw new Error(`Unknown or empty memory topic`);
  for (const nodeId of nodeIds) {
    if (!config.knowledgeModel.nodes.some((node) => node.id === nodeId)) {
      throw new Error(`Unknown knowledge node ${nodeId}`);
    }
  }
  const topic = studentMemoryTopicV1Schema.parse({
    version: 'student-memory-topic.v1',
    snapshotId: snapshot.snapshotId,
    kind: request.kind,
    key: request.kind === 'node'
      ? request.nodeId
      : request.kind === 'dimension'
        ? request.dimensionId
        : request.eventId,
    nodes: snapshot.nodes.filter((node) => nodeIds.includes(node.nodeId)),
    formalAssessments: snapshot.formalAssessments.filter((entry) =>
      nodeIds.includes(entry.nodeId)),
    divergences: snapshot.divergences.filter((entry) =>
      nodeIds.includes(entry.nodeId)),
    supportDependencies: snapshot.supportDependencies.filter((entry) =>
      nodeIds.includes(entry.nodeId)),
  });
  return { kind: request.kind, value: topic };
}

export function latestStudentMemorySnapshot(
  session: StudentSession,
): StudentMemorySnapshotV1 | undefined {
  const event = [...session.events].reverse().find((candidate) =>
    candidate.kind === 'agent.memory.snapshot.committed');
  return event?.kind === 'agent.memory.snapshot.committed'
    ? studentMemorySnapshotV1Schema.parse(event.snapshot)
    : undefined;
}
