import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  AgentToolExecutionResult,
  AgentTurnAdapter,
  AgentTurnAdapterRequest,
} from '../server/agent/adapters/adapter';
import {
  buildStudentMemoryIndex,
  latestStudentMemorySnapshot,
  mergeResolvedQuestionSnapshot,
} from '../server/agent/student-memory';
import { InMemoryAgentTranscriptStore } from '../server/agent/transcript-store';
import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { InMemorySessionStore } from '../server/session/store';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import { sessionSchema } from '../shared/session/schema';
import { buildLiveCellState } from '../src/features/model/live-cell';

const apiToken = 'agent-case-runtime-token';
const headers = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

function providerResult(
  request: AgentTurnAdapterRequest,
  actions: AgentToolExecutionResult[],
) {
  const terminal = actions.at(-1)!.action;
  return {
    source: 'provider' as const,
    model: request.model,
    orderedActions: actions.map((entry) => entry.action),
    terminalAction: {
      callId: terminal.callId,
      name: terminal.name as 'show_question_card',
    },
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    sdkSessionId: request.sdkSession?.sessionId,
  };
}

describe('case-level Agent runtime', () => {
  it('reports stale teaching configuration explicitly instead of a session-prefix conflict', async () => {
    const config = await loadAllConfig(process.cwd());
    const sessions = new InMemorySessionStore();
    let session = createSession({
      id: 'case-runtime-stale-config',
      anonymousStudentId: 'anon-CASERUN2',
      now: '2026-07-24T09:00:00.000Z',
      configVersions: {
        ...sessionConfigVersions(config),
        configDigest: 'sha256:stale-training-config',
      },
    });
    session = appendSessionEvent(session, {
      id: 'case-runtime-stale-trigger',
      occurredAt: '2026-07-24T09:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: config.cases[0]!.id,
      stageId: 'training',
      attemptId: 'case-runtime-stale',
      questionId: `${config.cases[0]!.id}:analysis`,
      answer: { format: 'text', value: 'ready' },
    });
    sessions.set(session);
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist'),
      apiToken,
      sessions,
      agentAdapters: new Map(),
      workflow: {
        executionMode: 'live',
        provider: 'claude-agent',
        model: 'claude-sonnet-5',
      },
    });

    const response = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        caseId: config.cases[0]!.id,
        triggerEventId: 'case-runtime-stale-trigger',
        expectedSequence: 1,
        idempotencyKey: 'case-runtime-stale-start',
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'agent-config-version-mismatch',
    });
  });

  it('shares one SDK session across objectives and commits a full snapshot per resolved objective', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const firstObjective = trainingCase.agentObjectives[0]!;
    const secondObjective = trainingCase.agentObjectives[1]!;
    const sessions = new InMemorySessionStore();
    const transcripts = new InMemoryAgentTranscriptStore();
    let session = createSession({
      id: 'case-runtime-session',
      anonymousStudentId: 'anon-CASERUN1',
      now: '2026-07-24T10:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    session = appendSessionEvent(session, {
      id: 'case-runtime-trigger',
      occurredAt: '2026-07-24T10:00:01.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: 'case-runtime-seed',
      questionId: `${trainingCase.id}:analysis`,
      answer: { format: 'text', value: 'ready' },
    });
    sessions.set(session);

    const requests: AgentTurnAdapterRequest[] = [];
    const adapter: AgentTurnAdapter = {
      id: 'claude-agent',
      async execute(request) {
        requests.push(request);
        if (!request.executeTool || !request.sdkSession) {
          throw new Error('case Agent request lacks tool execution or SDK session metadata');
        }
        await request.sdkSession.store.append({
          projectKey: 'agent-case-runtime',
          sessionId: request.sdkSession.sessionId,
        }, [{
          type: 'marker',
          uuid: `request-${requests.length}`,
        }]);

        if (requests.length === 1) {
          const selected = await request.executeTool({
            callId: 'select-first',
            name: 'select_objective',
            arguments: { objectiveId: firstObjective.id },
          });
          const compound = await request.executeTool({
            callId: 'show-compound-first',
            name: 'show_question_card',
            arguments: {
              objectiveId: firstObjective.id,
              text: '请判断锌片的变化，并说明电子方向。',
              board: {
                kind: 'single-choice',
                options: [
                  { id: 'oxidation', label: '失去电子' },
                  { id: 'reduction', label: '得到电子' },
                ],
              },
            },
          });
          const shown = await request.executeTool({
            callId: 'show-first',
            name: 'show_question_card',
            arguments: {
              objectiveId: firstObjective.id,
              text: '锌片首先发生哪类变化？',
              board: {
                kind: 'single-choice',
                options: [
                  { id: 'oxidation', label: '失去电子' },
                  { id: 'reduction', label: '得到电子' },
                ],
              },
            },
          });
          expect(compound).toMatchObject({
            accepted: false,
            errorCategory: 'multiple-student-questions',
          });
          return providerResult(request, [selected, shown]);
        }

        if (requests.length === 3) {
          const context = JSON.parse(request.messages[0]!.content) as {
            caseAgent: {
              objectives: Array<{
                id: string;
                boardKinds: Array<'single-choice' | 'short-fill' | 'equation-fill'>;
              }>;
            };
          };
          const objective = context.caseAgent.objectives[0]!;
          const selected = await request.executeTool({
            callId: 'select-next-case',
            name: 'select_objective',
            arguments: { objectiveId: objective.id },
          });
          const shown = await request.executeTool({
            callId: 'show-next-case',
            name: 'show_question_card',
            arguments: {
              objectiveId: objective.id,
              text: '新案例中首先辨认哪一类对象？',
              board: {
                kind: 'single-choice',
                options: [
                  { id: 'electrode', label: '电极与反应物' },
                  { id: 'energy', label: '能量损耗' },
                ],
              },
            },
          });
          return providerResult(request, [selected, shown]);
        }

        const currentStudentTurn = JSON.parse(request.messages[0]!.content) as {
          studentResponse: { answerEventId: string };
        };
        const currentAnswerEventId = currentStudentTurn.studentResponse.answerEventId;
        const resolutionWithoutWorkingUpdate = await request.executeTool({
          callId: 'resolve-first-without-working-update',
          name: 'resolve_question',
          arguments: {
            objectiveId: firstObjective.id,
            summary: 'This skips the required working update.',
            updates: [{
              nodeId: firstObjective.targetNodeIds[0]!,
              state: 'mastered',
              confidence: 0.9,
              rationale: 'The student selected electron loss.',
              misconceptionIds: [],
              evidenceEventIds: [currentAnswerEventId],
            }],
          },
        });
        const understood = await request.executeTool({
          callId: 'understand-first',
          name: 'update_student_understanding',
          arguments: {
            objectiveId: firstObjective.id,
            updates: [{
              nodeId: firstObjective.targetNodeIds[0]!,
              state: 'mastered',
              confidence: 0.9,
              rationale: 'The student selected electron loss.',
              misconceptionIds: [],
              evidenceEventIds: [currentAnswerEventId],
            }],
          },
        });
        const resolved = await request.executeTool({
          callId: 'resolve-first',
          name: 'resolve_question',
          arguments: {
            objectiveId: firstObjective.id,
            summary: 'The student distinguishes oxidation at the zinc electrode.',
            updates: [{
              nodeId: firstObjective.targetNodeIds[0]!,
              state: 'mastered',
              confidence: 0.9,
              rationale: 'The student selected electron loss.',
              misconceptionIds: [],
              evidenceEventIds: [currentAnswerEventId],
            }],
          },
        });
        const selected = await request.executeTool({
          callId: 'select-second',
          name: 'select_objective',
          arguments: { objectiveId: secondObjective.id },
        });
        const prematureResolution = await request.executeTool({
          callId: 'resolve-second-too-early',
          name: 'resolve_question',
          arguments: {
            objectiveId: secondObjective.id,
            summary: 'This objective has not been asked yet.',
            updates: [{
              nodeId: secondObjective.targetNodeIds[0]!,
              state: 'mastered',
              confidence: 0.9,
              rationale: 'Invalid reuse of the previous answer.',
              misconceptionIds: [],
              evidenceEventIds: [],
            }],
          },
        });
        const shown = await request.executeTool({
          callId: 'show-second',
          name: 'show_question_card',
          arguments: {
            objectiveId: secondObjective.id,
            text: '电子通过哪一部分移动？',
            board: {
              kind: 'short-fill',
              placeholder: '填写部件名',
              maxLength: 24,
            },
          },
        });
        expect(resolutionWithoutWorkingUpdate).toMatchObject({
          accepted: false,
          errorCategory: 'missing-understanding-update',
        });
        expect(understood.accepted).toBe(true);
        expect(resolved.accepted).toBe(true);
        expect(prematureResolution).toMatchObject({
          accepted: false,
          errorCategory: 'missing-student-answer',
        });
        return providerResult(request, [understood, resolved, selected, shown]);
      },
    };
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist'),
      apiToken,
      sessions,
      agentTranscripts: transcripts,
      agentAdapters: new Map([['claude-agent', adapter]]),
      workflow: {
        executionMode: 'live',
        provider: 'claude-agent',
        model: 'claude-sonnet-5',
        now: () => Date.parse('2026-07-24T10:01:00.000Z') + requests.length,
      },
    });

    const startedResponse = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        caseId: trainingCase.id,
        triggerEventId: 'case-runtime-trigger',
        expectedSequence: 1,
        idempotencyKey: 'case-runtime-start',
      }),
    });
    expect(startedResponse.status).toBe(200);
    const started = await startedResponse.json() as {
      session: typeof session;
      turnId: string;
    };
    const firstTurn = sessions.get(session.id)!.events.find((event) =>
      event.kind === 'agent.turn.completed' && event.turnId === started.turnId);
    expect(firstTurn).toMatchObject({
      caseId: trainingCase.id,
      sdkSessionId: requests[0]!.sdkSession!.sessionId,
      terminalAction: { name: 'show_question_card' },
    });
    const overlappingCase = config.cases.find(
      (entry) => entry.id !== trainingCase.id,
    )!;
    const overlappingResponse = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        caseId: overlappingCase.id,
        triggerEventId: 'case-runtime-trigger',
        expectedSequence: started.session.serverSequence,
        idempotencyKey: 'case-runtime-overlap',
      }),
    });
    expect(overlappingResponse.status).toBe(409);
    await expect(overlappingResponse.json()).resolves.toMatchObject({
      error: 'agent-case-already-active',
      caseId: trainingCase.id,
    });

    const invalidAnswer = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        turnId: started.turnId,
        answer: { format: 'choice', optionId: 'not-on-this-card' },
        expectedSequence: started.session.serverSequence,
        idempotencyKey: 'case-runtime-invalid-answer',
      }),
    });
    expect(invalidAnswer.status).toBe(400);
    await expect(invalidAnswer.json()).resolves.toMatchObject({
      error: 'agent-answer-invalid',
    });
    expect(requests).toHaveLength(1);

    const answeredResponse = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        turnId: started.turnId,
        answer: { format: 'choice', optionId: 'oxidation' },
        expectedSequence: started.session.serverSequence,
        idempotencyKey: 'case-runtime-answer-1',
      }),
    });
    expect(answeredResponse.status).toBe(200);
    const answered = await answeredResponse.json() as { session: typeof session };
    const eventCountAfterAnswer = sessions.get(session.id)!.events.length;
    const duplicateAnswer = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        turnId: started.turnId,
        answer: { format: 'choice', optionId: 'oxidation' },
        expectedSequence: answered.session.serverSequence,
        idempotencyKey: 'case-runtime-answer-duplicate-key',
      }),
    });
    expect(duplicateAnswer.status).toBe(200);
    await expect(duplicateAnswer.json()).resolves.toMatchObject({
      status: 'already-recorded',
    });
    expect(requests).toHaveLength(2);
    expect(sessions.get(session.id)!.events).toHaveLength(eventCountAfterAnswer);

    const conflictingAnswer = await app.request('/api/agent/answer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        turnId: started.turnId,
        answer: { format: 'choice', optionId: 'reduction' },
        expectedSequence: answered.session.serverSequence,
        idempotencyKey: 'case-runtime-answer-conflict-key',
      }),
    });
    expect(conflictingAnswer.status).toBe(409);
    await expect(conflictingAnswer.json()).resolves.toMatchObject({
      error: 'agent-answer-already-submitted',
    });
    expect(requests).toHaveLength(2);
    expect(sessions.get(session.id)!.events).toHaveLength(eventCountAfterAnswer);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.sdkSession).toMatchObject({ resume: false });
    expect(requests[1]!.sdkSession).toMatchObject({
      sessionId: requests[0]!.sdkSession!.sessionId,
      resume: true,
    });
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([
      'select_objective',
      'show_question_card',
      'show_case_material',
      'focus_cognitive_node',
      'recall_student_memory',
      'update_student_understanding',
      'resolve_question',
      'end_case',
    ]);
    const firstContext = JSON.parse(requests[0]!.messages[0]!.content) as {
      caseAgent: {
        pretestBaseline: { source: string };
        objectives: Array<{ id: string }>;
      };
    };
    expect(firstContext.caseAgent.pretestBaseline.source).toBe('pretest');
    expect(firstContext.caseAgent.objectives.map((entry) => entry.id))
      .toEqual(trainingCase.agentObjectives.map((entry) => entry.id));
    const studentTurn = JSON.parse(requests[1]!.messages[0]!.content) as {
      type: string;
      studentResponse: {
        answerEventId: string;
        answer: { format: string; optionId: string };
      };
    };
    expect(studentTurn).toMatchObject({
      type: 'student-turn',
      studentResponse: {
        answerEventId: expect.stringMatching(/^answer-agent-/),
        answer: { format: 'choice', optionId: 'oxidation' },
      },
    });

    const stored = sessions.get(session.id)!;
    const committedEvents = stored.events.filter((event) =>
      event.kind === 'agent.memory.snapshot.committed');
    expect(committedEvents).toHaveLength(2);
    expect(stored.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'agent.question.resolved',
        objectiveId: firstObjective.id,
      }),
      expect.objectContaining({
        kind: 'agent.question.started',
        objectiveId: secondObjective.id,
      }),
    ]));
    const latest = latestStudentMemorySnapshot(stored)!;
    expect(latest.previousSnapshotId).toBe(`${session.id}-memory-initial`);
    expect(latest.pretestBaseline).toEqual(committedEvents[0]!.kind ===
      'agent.memory.snapshot.committed'
      ? committedEvents[0]!.snapshot.pretestBaseline
      : null);
    expect(latest.nodes.find(
      (node) => node.nodeId === firstObjective.targetNodeIds[0],
    )?.state).toBe('mastered');
    const liveModel = buildLiveCellState(stored, config, trainingCase);
    expect(liveModel.nodes.find(
      (node) => node.id === firstObjective.targetNodeIds[0],
    )?.light).toBe('full-lit');
    expect(liveModel.polarityLit).toBe(true);
    expect(liveModel.electrodes).toMatchObject({
      negative: { label: '锌' },
      positive: { label: '铜' },
    });
    expect(answered.session.events.some((event) =>
      event.kind === 'agent.turn.completed'
      && event.terminalAction.name === 'show_question_card')).toBe(true);

    const firstCaseStart = stored.events.find((event) =>
      event.kind === 'agent.case.started');
    if (!firstCaseStart || firstCaseStart.kind !== 'agent.case.started') {
      throw new Error('first case start was not persisted');
    }
    const secondQuestion = stored.events.find((event) =>
      event.kind === 'agent.question.started'
      && event.caseRunId === firstCaseStart.caseRunId
      && event.objectiveId === secondObjective.id);
    if (!secondQuestion || secondQuestion.kind !== 'agent.question.started') {
      throw new Error('second objective question start was not persisted');
    }
    let closedFirstCase = sessionSchema.parse({
      ...stored,
      events: stored.events.map((event) =>
        event.kind === 'agent.case.started' && event.caseRunId === firstCaseStart.caseRunId
          ? {
              ...event,
              objectiveIds: [firstObjective.id, secondObjective.id],
            }
          : event),
    });
    const secondSnapshot = mergeResolvedQuestionSnapshot({
      previous: latest,
      session: closedFirstCase,
      config,
      snapshotId: 'case-runtime-second-snapshot',
      caseId: trainingCase.id,
      objectiveId: secondObjective.id,
      sourceQuestionId: secondQuestion.questionRunId,
      sourceThroughSequence: closedFirstCase.events.length - 1,
      occurredAt: '2026-07-24T10:02:30.000Z',
      updates: [{
        nodeId: secondObjective.targetNodeIds[0]!,
        state: 'developing',
        confidence: 0.7,
        rationale: 'Fixture closes the second atomic objective.',
        misconceptionIds: [],
        evidenceEventIds: [],
      }],
      caseCompleted: true,
    });
    closedFirstCase = appendSessionEvent(closedFirstCase, {
      id: 'case-runtime-second-question-resolved',
      occurredAt: '2026-07-24T10:02:30.000Z',
      kind: 'agent.question.resolved',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: firstCaseStart.caseRunId,
      caseRunId: firstCaseStart.caseRunId,
      questionRunId: secondQuestion.questionRunId,
      objectiveId: secondObjective.id,
      summary: 'Fixture closes the second atomic objective.',
      snapshotId: secondSnapshot.snapshotId,
    });
    closedFirstCase = appendSessionEvent(closedFirstCase, {
      id: 'case-runtime-second-memory-committed',
      occurredAt: '2026-07-24T10:02:30.000Z',
      kind: 'agent.memory.snapshot.committed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: firstCaseStart.caseRunId,
      caseRunId: firstCaseStart.caseRunId,
      questionRunId: secondQuestion.questionRunId,
      objectiveId: secondObjective.id,
      snapshot: secondSnapshot,
      index: buildStudentMemoryIndex(secondSnapshot),
    });
    const completedFirstCase = appendSessionEvent(closedFirstCase, {
      id: 'case-runtime-first-case-completed',
      occurredAt: '2026-07-24T10:03:00.000Z',
      kind: 'agent.case.completed',
      pipelineStage: 'agent',
      caseId: trainingCase.id,
      stageId: 'training',
      attemptId: firstCaseStart.caseRunId,
      caseRunId: firstCaseStart.caseRunId,
      sdkSessionId: firstCaseStart.sdkSessionId,
      summary: 'Fixture closes the first case after its objective checks.',
      finalSnapshotId: secondSnapshot.snapshotId,
    });
    sessions.set(completedFirstCase);
    const nextCase = config.cases.find((entry) => entry.id !== trainingCase.id)!;
    const nextCaseResponse = await app.request('/api/agent/turn', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: session.id,
        caseId: nextCase.id,
        triggerEventId: 'case-runtime-trigger',
        expectedSequence: completedFirstCase.events.length,
        idempotencyKey: 'case-runtime-next-case',
      }),
    });
    expect(nextCaseResponse.status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.sdkSession).toMatchObject({ resume: false });
    expect(requests[2]!.sdkSession!.sessionId)
      .not.toBe(requests[0]!.sdkSession!.sessionId);
    const nextCaseContext = JSON.parse(requests[2]!.messages[0]!.content) as {
      recentLogicalRounds: unknown[];
      caseAgent: {
        case: { id: string };
        memoryIndex: { snapshotId: string };
        pretestBaseline: { source: string };
      };
    };
    expect(nextCaseContext.recentLogicalRounds).toEqual([]);
    expect(nextCaseContext.caseAgent).toMatchObject({
      case: { id: nextCase.id },
      memoryIndex: { snapshotId: secondSnapshot.snapshotId },
      pretestBaseline: { source: 'pretest' },
    });
  });
});
