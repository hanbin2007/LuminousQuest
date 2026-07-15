import { describe, expect, it } from 'vitest';

import {
  LocalSessionStore,
  appendSessionEvent,
  createSession,
  exportSession,
  importSession,
  sessionSchema,
  summarizeAssessedScores,
} from '../shared/session';

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

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
    this.data.set(key, value);
  }
}

describe('session persistence', () => {
  it('round-trips the complete answer-to-score evidence chain', () => {
    const started = createSession({
      id: 'session-1',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: {
        knowledgeModel: 'knowledge-model.v1',
        rubrics: 'rubrics.v1',
        pretest: 'pretest.v1',
        scaffoldPolicy: 'scaffold-policy.v1',
      },
    });
    const answered = appendSessionEvent(started, {
      id: 'event-answer-1',
      occurredAt: '2026-07-15T12:01:00.000Z',
      kind: 'answer.submitted',
      questionId: 'q1',
      answer: { format: 'text', value: '电子从锌流向铜。' },
    });
    const assessed = appendSessionEvent(answered, {
      id: 'event-assessment-1',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      sourceAnswerEventId: 'event-answer-1',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: 'rubrics.v1' },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: '电子从锌流向铜', start: 0, end: 8 }],
        model: 'mock-v1',
      },
      ruleDecision: { status: 'hit', ruleId: 'p4-electron-direction', reason: '方向正确' },
      following: { status: 'not-followed', anchorNodeId: null },
      score: { status: 'scored', earned: 2, possible: 2 },
    });

    const restored = importSession(exportSession(assessed));

    expect(restored).toEqual(assessed);
    expect(restored.events[1]).toMatchObject({
      extraction: { status: 'assessed' },
      ruleDecision: { status: 'hit' },
      following: { status: 'not-followed' },
      score: { status: 'scored', earned: 2 },
    });
  });

  it('automatically saves each appended event and restores it after a reload', () => {
    const storage = new MemoryStorage();
    const store = new LocalSessionStore(storage);
    const session = createSession({
      id: 'session-auto-save',
      anonymousStudentId: 'anon-01020304',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: {
        knowledgeModel: 'knowledge-model.v1',
        rubrics: 'rubrics.v1',
        pretest: 'pretest.v1',
        scaffoldPolicy: 'scaffold-policy.v1',
      },
    });
    store.save(session);

    const updated = store.append('session-auto-save', {
      id: 'event-answer-auto-save',
      occurredAt: '2026-07-15T12:02:00.000Z',
      kind: 'answer.submitted',
      questionId: 'q2',
      answer: { format: 'text', value: '作答' },
    });

    expect(store.load('session-auto-save')).toEqual(updated);
  });

  it('keeps a measured miss separate from an unassessed node and excludes unassessed scores', () => {
    const assessedMiss = {
      schemaVersion: 'event.v1',
      sequence: 0,
      id: 'event-miss',
      occurredAt: '2026-07-15T12:00:00.000Z',
      kind: 'assessment.completed',
      sourceAnswerEventId: 'answer-1',
      nodeId: 'D1',
      rubric: { id: 'rubric-d1', version: 'rubrics.v1' },
      extraction: { status: 'assessed', evidence: [], model: 'mock-v1' },
      ruleDecision: { status: 'miss', ruleId: 'd1-miss', reason: '明确错误' },
      following: { status: 'not-followed', anchorNodeId: null },
      score: { status: 'scored', earned: 0, possible: 2 },
    } as const;
    const unassessed = {
      ...assessedMiss,
      id: 'event-unassessed',
      sequence: 1,
      nodeId: 'P1',
      extraction: { status: 'unassessed', reason: '题目未覆盖' },
      ruleDecision: { status: 'unassessed', reason: '没有证据' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    } as const;

    expect(sessionSchema.shape.events.element.safeParse(assessedMiss).success).toBe(true);
    expect(sessionSchema.shape.events.element.safeParse(unassessed).success).toBe(true);
    expect(
      sessionSchema.shape.events.element.safeParse({
        ...unassessed,
        ruleDecision: { status: 'miss', ruleId: 'bad', reason: 'must not conflate' },
      }).success,
    ).toBe(false);
    expect(summarizeAssessedScores([assessedMiss, unassessed])).toEqual({
      earned: 0,
      possible: 2,
      ratio: 0,
      assessedNodeIds: ['D1'],
      unassessedNodeIds: ['P1'],
    });
  });
});

