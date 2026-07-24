import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  buildStudentMemoryIndex,
  createInitialStudentMemorySnapshot,
  mergeResolvedQuestionSnapshot,
  recallStudentMemory,
} from '../server/agent/student-memory';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import { buildLiveCellState } from '../src/features/model/live-cell';

const contentRoot = process.cwd();

describe('case Agent student memory', () => {
  it('rejects a memory snapshot that belongs to another student', async () => {
    const config = await loadAllConfig(contentRoot);
    const session = createSession({
      id: 'memory-session-foreign',
      anonymousStudentId: 'anon-MEMORY00',
      now: '2026-07-24T08:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const initial = createInitialStudentMemorySnapshot({
      session,
      config,
      snapshotId: 'snapshot-foreign',
      occurredAt: '2026-07-24T08:00:00.000Z',
    });

    expect(() => appendSessionEvent(session, {
      id: 'memory-foreign-commit',
      occurredAt: '2026-07-24T08:00:00.000Z',
      kind: 'agent.memory.snapshot.committed',
      pipelineStage: 'agent',
      caseId: config.cases[0]!.id,
      stageId: 'training',
      attemptId: 'case-run-foreign',
      caseRunId: 'case-run-foreign',
      snapshot: {
        ...initial,
        studentId: 'anon-ANOTHER-STUDENT',
      },
      index: buildStudentMemoryIndex(initial),
    })).toThrow(/student memory must belong to this session/);
  });

  it('keeps a complete immutable pretest baseline and all knowledge nodes in every snapshot', async () => {
    const config = await loadAllConfig(contentRoot);
    const session = createSession({
      id: 'memory-session',
      anonymousStudentId: 'anon-MEMORY01',
      now: '2026-07-24T08:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const initial = createInitialStudentMemorySnapshot({
      session,
      config,
      snapshotId: 'snapshot-0',
      occurredAt: '2026-07-24T08:00:00.000Z',
    });
    const nodeId = config.knowledgeModel.nodes[0]!.id;
    const next = mergeResolvedQuestionSnapshot({
      previous: initial,
      session,
      config,
      snapshotId: 'snapshot-1',
      caseId: config.cases[0]!.id,
      objectiveId: 'objective-1',
      sourceQuestionId: 'question-1',
      sourceThroughSequence: 0,
      occurredAt: '2026-07-24T08:01:00.000Z',
      updates: [{
        nodeId,
        state: 'mastered',
        confidence: 0.9,
        rationale: 'The student selected the correct electron donor.',
        evidenceEventIds: [],
        misconceptionIds: [],
      }],
    });

    expect(initial.nodes).toHaveLength(config.knowledgeModel.nodes.length);
    expect(next.nodes).toHaveLength(config.knowledgeModel.nodes.length);
    expect(next.pretestBaseline).toEqual(initial.pretestBaseline);
    expect(next.previousSnapshotId).toBe(initial.snapshotId);
    expect(next.nodes.find((node) => node.nodeId === nodeId)?.state).toBe('mastered');
    expect(next.nodes.filter((node) => node.nodeId !== nodeId))
      .toEqual(initial.nodes.filter((node) => node.nodeId !== nodeId));
    expect(next.resolvedObjectives).toContainEqual({
      caseId: config.cases[0]!.id,
      objectiveId: 'objective-1',
      questionId: 'question-1',
      resolvedAt: '2026-07-24T08:01:00.000Z',
    });
  });

  it('rejects unknown nodes and forged evidence references', async () => {
    const config = await loadAllConfig(contentRoot);
    const session = createSession({
      id: 'memory-session-invalid',
      anonymousStudentId: 'anon-MEMORY02',
      now: '2026-07-24T08:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const initial = createInitialStudentMemorySnapshot({
      session,
      config,
      snapshotId: 'snapshot-0',
      occurredAt: '2026-07-24T08:00:00.000Z',
    });

    expect(() => mergeResolvedQuestionSnapshot({
      previous: initial,
      session,
      config,
      snapshotId: 'snapshot-1',
      caseId: config.cases[0]!.id,
      objectiveId: 'objective-1',
      sourceQuestionId: 'question-1',
      sourceThroughSequence: 0,
      occurredAt: '2026-07-24T08:01:00.000Z',
      updates: [{
        nodeId: 'unknown-node',
        state: 'uncertain',
        confidence: 0.2,
        rationale: 'invalid',
        evidenceEventIds: ['forged-event'],
        misconceptionIds: [],
      }],
    })).toThrow(/unknown knowledge node/i);
  });

  it('supports index and topic recall without mutating the snapshot', async () => {
    const config = await loadAllConfig(contentRoot);
    const session = createSession({
      id: 'memory-session-recall',
      anonymousStudentId: 'anon-MEMORY03',
      now: '2026-07-24T08:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const initial = createInitialStudentMemorySnapshot({
      session,
      config,
      snapshotId: 'snapshot-0',
      occurredAt: '2026-07-24T08:00:00.000Z',
    });
    const before = structuredClone(initial);

    const index = recallStudentMemory(initial, config, { kind: 'index' });
    const node = recallStudentMemory(initial, config, {
      kind: 'node',
      nodeId: config.knowledgeModel.nodes[0]!.id,
    });

    expect(index.kind).toBe('index');
    expect(node.kind).toBe('node');
    expect(initial).toEqual(before);
  });

  it('projects working understanding temporarily and committed memory after resolution', async () => {
    const config = await loadAllConfig(contentRoot);
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const objective = trainingCase.agentObjectives[0]!;
    const nodeId = objective.targetNodeIds[0]!;
    let session = createSession({
      id: 'memory-session-live-projection',
      anonymousStudentId: 'anon-MEMORY04',
      now: '2026-07-24T08:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const initial = createInitialStudentMemorySnapshot({
      session,
      config,
      snapshotId: 'snapshot-live-0',
      occurredAt: '2026-07-24T08:00:00.000Z',
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-initial',
      occurredAt: '2026-07-24T08:00:00.000Z',
      kind: 'agent.memory.snapshot.committed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      snapshot: initial,
      index: buildStudentMemoryIndex(initial),
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-case-started',
      occurredAt: '2026-07-24T08:00:00.100Z',
      kind: 'agent.case.started',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      sdkSessionId: '7933e23b-2276-45db-93a8-20c762f65fbd',
      initialSnapshotId: initial.snapshotId,
      objectiveIds: [objective.id],
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-question-started',
      occurredAt: '2026-07-24T08:00:00.200Z',
      kind: 'agent.question.started',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      questionRunId: 'question-live',
      objectiveId: objective.id,
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-answer',
      occurredAt: '2026-07-24T08:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live-answer',
      questionId: 'question-live',
      answer: { format: 'choice', optionId: 'partial' },
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-working',
      occurredAt: '2026-07-24T08:00:02.000Z',
      kind: 'agent.understanding.updated',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      questionRunId: 'question-live',
      objectiveId: objective.id,
      sourceAnswerEventId: 'memory-live-answer',
      updates: [{
        nodeId,
        state: 'developing',
        confidence: 0.6,
        rationale: 'The student has part of the distinction.',
        misconceptionIds: [],
        evidenceEventIds: ['memory-live-answer'],
      }],
    });

    expect(buildLiveCellState(session, config, trainingCase).nodes.find(
      (node) => node.id === nodeId,
    )?.light).toBe('half-lit');

    const committed = mergeResolvedQuestionSnapshot({
      previous: initial,
      session,
      config,
      snapshotId: 'snapshot-live-1',
      caseId: trainingCase.id,
      objectiveId: objective.id,
      sourceQuestionId: 'question-live',
      sourceThroughSequence: session.events.at(-1)!.sequence,
      occurredAt: '2026-07-24T08:00:03.000Z',
      updates: [{
        nodeId,
        state: 'mastered',
        confidence: 0.9,
        rationale: 'The objective was resolved after a follow-up.',
        misconceptionIds: [],
        evidenceEventIds: ['memory-live-answer'],
      }],
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-resolved',
      occurredAt: '2026-07-24T08:00:03.000Z',
      kind: 'agent.question.resolved',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      questionRunId: 'question-live',
      objectiveId: objective.id,
      summary: 'The objective was resolved after a follow-up.',
      snapshotId: committed.snapshotId,
    });
    session = appendSessionEvent(session, {
      id: 'memory-live-committed',
      occurredAt: '2026-07-24T08:00:03.100Z',
      kind: 'agent.memory.snapshot.committed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-run-live',
      caseRunId: 'case-run-live',
      questionRunId: 'question-live',
      objectiveId: objective.id,
      snapshot: committed,
      index: buildStudentMemoryIndex(committed),
    });

    expect(buildLiveCellState(session, config, trainingCase).nodes.find(
      (node) => node.id === nodeId,
    )?.light).toBe('full-lit');
  });
});
