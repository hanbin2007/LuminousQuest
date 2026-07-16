import { describe, expect, it } from 'vitest';

import {
  LocalSessionStore,
  appendSessionEvent,
  createSession,
  exportSession,
  importSession,
  sessionSchema,
  summarizeAssessedScores,
  type SessionEventInput,
  type StudentSession,
} from '../shared/session';

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  failWrites = false;

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    if (this.failWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.data.set(key, value);
  }
}

const configVersions = {
  configDigest: 'sha256:test',
  knowledgeModel: 'knowledge-model.v1',
  rubrics: 'rubrics.v1',
  pretest: 'pretest.v1',
  scaffoldPolicy: 'scaffold-policy.v1',
  cases: { 'zinc-copper': 'case.v1' },
  grammar: 'equation-grammar.v1',
  engines: {
    rubric: 'rubric-policy.v2',
    topology: 'builder-topology.v1',
    equation: 'equation-scoring.v1',
  },
};

function workflow(attemptId = 'attempt-1') {
  return {
    caseId: 'zinc-copper',
    stageId: 'pretest-q1',
    attemptId,
  };
}

function provenance() {
  return {
    promptId: 'structured-assessment',
    promptVersion: 'sha256:prompt',
    cacheKey: 'sha256:cache-key',
  };
}

function answerEvent(
  id: string,
  attemptId = 'attempt-1',
  occurredAt = '2026-07-15T12:01:00.000Z',
): SessionEventInput {
  return {
    id,
    occurredAt,
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    ...workflow(attemptId),
    questionId: 'q1',
    answer: { format: 'text', value: '电子从锌流向铜。' },
  };
}

function assessmentEvent(
  overrides: Partial<Extract<SessionEventInput, { kind: 'assessment.completed' }>> = {},
): Extract<SessionEventInput, { kind: 'assessment.completed' }> {
  return {
    id: 'event-assessment-1',
    occurredAt: '2026-07-15T12:01:01.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    ...workflow(),
    sourceAnswerEventId: 'event-answer-1',
    nodeId: 'P4',
    rubric: { id: 'rubric-p4', version: 'rubrics.v1' },
    extraction: {
      status: 'assessed',
      evidence: [{ quote: '电子从锌流向铜', start: 0, end: '电子从锌流向铜'.length }],
      model: 'mock-v1',
      provenance: provenance(),
    },
    ruleDecision: { status: 'hit', ruleId: 'p4-electron-direction', reason: '方向正确' },
    following: { status: 'not-followed', anchorNodeId: null },
    score: { status: 'scored', earned: 2, possible: 2 },
    ...overrides,
  };
}

function startedSession(id = 'session-1') {
  return createSession({
    id,
    anonymousStudentId: 'anon-A1B2C3D4',
    now: '2026-07-15T12:00:00.000Z',
    configVersions,
  });
}

function completeSession(): StudentSession {
  const answered = appendSessionEvent(startedSession(), answerEvent('event-answer-1'));
  return appendSessionEvent(answered, assessmentEvent());
}

describe('session persistence and staged assessment state', () => {
  it('round-trips the complete answer-to-score evidence chain with provenance', () => {
    const assessed = completeSession();

    const restored = importSession(exportSession(assessed));

    expect(restored).toEqual(assessed);
    expect(restored.events[1]).toMatchObject({
      caseId: 'zinc-copper',
      stageId: 'pretest-q1',
      attemptId: 'attempt-1',
      pipelineStage: 'score',
      extraction: {
        status: 'assessed',
        provenance: {
          promptId: 'structured-assessment',
          promptVersion: 'sha256:prompt',
          cacheKey: 'sha256:cache-key',
        },
      },
      score: { status: 'scored', earned: 2 },
    });
  });

  it('round-trips tutor cycle, turn, and terminal events without changing legacy v2 events', () => {
    let session = completeSession();
    expect(session.events[1]).not.toHaveProperty('objectiveOutcome');
    const identity = {
      pipelineStage: 'tutor' as const,
      ...workflow(),
      sourceAnswerEventId: 'event-answer-1',
      sourceAssessmentEventId: 'event-assessment-1',
      nodeId: 'P4',
      cycleId: 'tutor-event-assessment-1',
    };
    session = appendSessionEvent(session, {
      id: 'tutor-cycle-started',
      occurredAt: '2026-07-15T12:01:02.000Z',
      kind: 'tutor.cycle.started',
      ...identity,
    });
    session = appendSessionEvent(session, {
      id: 'tutor-turn-1',
      occurredAt: '2026-07-15T12:01:03.000Z',
      kind: 'tutor.turn.completed',
      ...identity,
      studentAnswer: '我再想想。',
      turn: { action: 'probe', content: '先说明判断依据。' },
      source: 'provider',
      degraded: false,
      activeElapsedMs: 120,
    });
    session = appendSessionEvent(session, {
      id: 'tutor-terminal',
      occurredAt: '2026-07-15T12:01:04.000Z',
      kind: 'tutor.cycle.terminal',
      ...identity,
      reason: 'max-rounds',
      content: '本轮结束。',
      activeElapsedMs: 120,
    });

    expect(importSession(exportSession(session))).toEqual(session);
  });

  it('restores the latest session from a newly constructed store after a refresh', () => {
    const storage = new MemoryStorage();
    const beforeRefresh = new LocalSessionStore(storage);
    beforeRefresh.save(completeSession());

    const afterRefresh = new LocalSessionStore(storage);

    expect(afterRefresh.restoreLatest()).toEqual(completeSession());
  });

  it('allows successful extraction while rule and downstream stages remain unassessed', () => {
    const answered = appendSessionEvent(startedSession(), answerEvent('event-answer-1'));
    const extractionOnly = assessmentEvent({
      pipelineStage: 'extraction',
      ruleDecision: { status: 'unassessed', reason: 'rule engine has not run' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    });

    expect(() => appendSessionEvent(answered, extractionOnly)).not.toThrow();
  });

  it('supports needs-review without permitting downstream assessment', () => {
    const answered = appendSessionEvent(startedSession(), answerEvent('event-answer-1'));
    const needsReview = assessmentEvent({
      pipelineStage: 'extraction',
      extraction: {
        status: 'needs-review',
        reason: 'image was ambiguous',
        model: 'vision-v1',
        provenance: provenance(),
      },
      ruleDecision: { status: 'unassessed', reason: 'awaiting extraction review' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    });

    expect(() => appendSessionEvent(answered, needsReview)).not.toThrow();
    expect(
      sessionSchema.shape.events.element.safeParse({
        ...needsReview,
        schemaVersion: 'event.v2',
        sequence: 1,
        score: { status: 'scored', earned: 1, possible: 2 },
      }).success,
    ).toBe(false);
  });

  it('enforces one-way pipeline progression for repeated snapshots of one attempt', () => {
    const answered = appendSessionEvent(startedSession(), answerEvent('event-answer-1'));
    const extractionOnly = appendSessionEvent(
      answered,
      assessmentEvent({
        id: 'assessment-extraction',
        pipelineStage: 'extraction',
        ruleDecision: { status: 'unassessed', reason: 'pending' },
        following: { status: 'unassessed' },
        score: { status: 'unassessed' },
      }),
    );
    const scored = appendSessionEvent(
      extractionOnly,
      assessmentEvent({ id: 'assessment-score', occurredAt: '2026-07-15T12:01:02.000Z' }),
    );

    expect(scored.events).toHaveLength(3);
    expect(() =>
      appendSessionEvent(
        scored,
        assessmentEvent({
          id: 'assessment-regression',
          occurredAt: '2026-07-15T12:01:03.000Z',
          pipelineStage: 'rule',
          ruleDecision: { status: 'hit', ruleId: 'p4-hit', reason: 'late regression' },
          following: { status: 'unassessed' },
          score: { status: 'unassessed' },
        }),
      ),
    ).toThrow(/progress/i);
  });

  it('keeps the latest completed score separate from a later unassessed attempt', () => {
    let session = appendSessionEvent(startedSession(), answerEvent('answer-1', 'attempt-1'));
    session = appendSessionEvent(
      session,
      assessmentEvent({
        id: 'assessed-old',
        sourceAnswerEventId: 'answer-1',
        nodeId: 'D1',
        attemptId: 'attempt-1',
      }),
    );
    session = appendSessionEvent(
      session,
      answerEvent('answer-2', 'attempt-2', '2026-07-15T12:02:00.000Z'),
    );
    session = appendSessionEvent(
      session,
      assessmentEvent({
        id: 'unassessed-latest',
        occurredAt: '2026-07-15T12:02:01.000Z',
        sourceAnswerEventId: 'answer-2',
        nodeId: 'D1',
        attemptId: 'attempt-2',
        pipelineStage: 'extraction',
        extraction: {
          status: 'unassessed',
          reason: 'question did not cover this node',
          provenance: provenance(),
        },
        ruleDecision: { status: 'unassessed', reason: 'no evidence' },
        following: { status: 'unassessed' },
        score: { status: 'unassessed' },
      }),
    );

    const summary = summarizeAssessedScores(session);

    expect(summary).toEqual({
      earned: 2,
      possible: 2,
      ratio: 1,
      assessedNodeIds: ['D1'],
      unassessedNodeIds: [],
      needsReviewNodeIds: [],
      unansweredNodeIds: [],
      latestAttemptStatusByNode: { D1: 'unassessed' },
    });
  });

  it('reports the latest needs-review node separately from unassessed nodes', () => {
    let session = appendSessionEvent(startedSession(), answerEvent('event-answer-1'));
    session = appendSessionEvent(
      session,
      assessmentEvent({
        pipelineStage: 'rule',
        ruleDecision: { status: 'needs-review', reason: 'rule conflict' },
        following: { status: 'unassessed' },
        score: { status: 'unassessed' },
      }),
    );

    expect(summarizeAssessedScores(session)).toMatchObject({
      needsReviewNodeIds: ['P4'],
      unassessedNodeIds: [],
      unansweredNodeIds: [],
      latestAttemptStatusByNode: { P4: 'needs-review' },
    });
  });

  it('requires a completely valid session before radar aggregation', () => {
    const session = completeSession();
    const invalid = {
      ...session,
      events: session.events.map((event, index) => index === 1 ? { ...event, sequence: 99 } : event),
    };

    expect(() => summarizeAssessedScores(invalid)).toThrow();
  });

  it('rejects duplicate event ids and workflow identifiers that conflict with the source answer', () => {
    const session = completeSession();
    expect(
      sessionSchema.safeParse({
        ...session,
        events: [session.events[0], { ...session.events[1], id: session.events[0].id }],
      }).success,
    ).toBe(false);
    expect(
      sessionSchema.safeParse({
        ...session,
        events: [session.events[0], { ...session.events[1], caseId: 'different-case' }],
      }).success,
    ).toBe(false);
  });

  it('clears a corrupted latest session instead of crashing restore', () => {
    const storage = new MemoryStorage();
    storage.setItem('luminous-quest:session.v2:latest', 'broken');
    storage.setItem('luminous-quest:session.v2:broken', '{not-json');
    const store = new LocalSessionStore(storage);

    expect(store.restoreLatest()).toBeNull();
    expect(storage.getItem('luminous-quest:session.v2:latest')).toBeNull();
    expect(storage.getItem('luminous-quest:session.v2:broken')).toBeNull();
  });

  it('reports malformed session schemas in Chinese', () => {
    expect(() => importSession(JSON.stringify({ schemaVersion: 'session.v2' })))
      .toThrow('会话文件格式不正确，请确认它由 LuminousQuest 导出。');
  });

  it('surfaces quota failures without publishing a latest-session pointer', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = new LocalSessionStore(storage);

    expect(() => store.save(completeSession())).toThrow(/localStorage/i);
    expect(storage.getItem('luminous-quest:session.v2:latest')).toBeNull();
  });
});
