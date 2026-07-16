import { describe, expect, it } from 'vitest';

import type { ScaffoldPolicyConfig } from '../shared/config/schemas';
import { assessmentCompletedEventSchema } from '../shared/session';
import {
  advanceScaffold,
  deriveCaseScaffoldScore,
  deriveAttemptScores,
  initialScaffold,
} from '../src/features/training/scaffold-adapter';

const policy: ScaffoldPolicyConfig = {
  version: 'scaffold-policy.v1',
  levels: [
    { level: 3, label: '独立作答', promptCount: 1 },
    { level: 1, label: '完整引导', promptCount: 9 },
    { level: 2, label: '三维度标题', promptCount: 3 },
  ],
  promotion: { consecutiveHits: 2, eligibleOutcomes: ['hit'] },
  demotion: { consecutiveMisses: 1, levels: 1 },
  assistance: { correctOutcome: 'hit-with-help', countsForPromotion: false },
  extraction: {
    retryCount: 1,
    temperature: 0.1,
    maximumAnswerCharacters: 2_000,
    factValueAliases: {},
    citation: {
      maxEditDistanceRatio: 0.12,
      normalizationCandidateMaxEditDistanceRatio: 0.35,
      commonTypos: {},
    },
  },
  socratic: {
    maxRounds: 3,
    correctedOutcome: 'hit-with-help',
    timeoutMs: 6_000,
    retryCount: 1,
    forceAdvanceAfterMs: 15_000,
    answerOverlapThreshold: 0.55,
    minimumSharedBigrams: 3,
    fallback: { probe: 'probe', hint: 'hint', check: 'check', closing: 'closing' },
  },
  passing: { minimumRatio: 0.75, requireNoCoreMiss: true },
  selection: { weakNodeThreshold: 0.6, recentCaseWindow: 3 },
};

type Outcome = 'hit' | 'hit-with-help' | 'partial' | 'miss';

function score(outcome: Outcome, assistance: 'none' | 'hint' | 'socratic' = 'none') {
  return {
    outcome,
    earned: outcome === 'miss' ? 0 : 1,
    possible: 1,
    assistance: {
      kind: assistance,
      rounds: assistance === 'none' ? 0 : 1,
    },
  } as const;
}

function scoredEvent(input: {
  id: string;
  sequence: number;
  attemptId?: string;
  nodeId: string;
  outcome: Outcome;
  earned: number;
  possible: number;
  assistance?: 'none' | 'hint' | 'socratic';
}) {
  const assistance = input.assistance ?? 'none';
  return assessmentCompletedEventSchema.parse({
    schemaVersion: 'event.v2',
    id: input.id,
    sequence: input.sequence,
    occurredAt: `2026-07-15T12:00:${String(input.sequence).padStart(2, '0')}.000Z`,
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: input.attemptId ?? 'attempt-a',
    sourceAnswerEventId: `answer-${input.id}`,
    nodeId: input.nodeId,
    rubric: { id: `rubric-${input.nodeId.toLowerCase()}`, version: 'rubrics.v1' },
    assistance: { kind: assistance, rounds: assistance === 'none' ? 0 : 1 },
    extraction: {
      status: 'assessed',
      evidence: [],
      model: 'mock-v1',
      provenance: { promptId: 'prompt', promptVersion: 'prompt.v1', cacheKey: input.id },
    },
    ruleDecision: { status: input.outcome, ruleId: `${input.nodeId}-rule`, reason: 'test' },
    following: { status: 'not-followed', anchorNodeId: null },
    score: {
      status: 'scored',
      earned: input.earned,
      possible: input.possible,
      outcome: input.outcome,
      annotations: input.outcome === 'hit-with-help' ? ['hit-with-help'] : [],
    },
  });
}

function unassessedEvent(sequence: number, nodeId: string) {
  return assessmentCompletedEventSchema.parse({
    schemaVersion: 'event.v2',
    id: `unassessed-${nodeId}`,
    sequence,
    occurredAt: `2026-07-15T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    kind: 'assessment.completed',
    pipelineStage: 'extraction',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'attempt-a',
    sourceAnswerEventId: `answer-unassessed-${nodeId}`,
    nodeId,
    rubric: { id: `rubric-${nodeId.toLowerCase()}`, version: 'rubrics.v1' },
    extraction: {
      status: 'unassessed',
      reason: 'not covered',
      provenance: { promptId: 'prompt', promptVersion: 'prompt.v1', cacheKey: nodeId },
    },
    ruleDecision: { status: 'unassessed', reason: 'not covered' },
    following: { status: 'unassessed' },
    score: { status: 'unassessed' },
  });
}

describe('M3 scaffold UI adapter', () => {
  it('starts normal training at the minimum configured level and fixes transfer at level 3', () => {
    expect(initialScaffold('training', policy)).toMatchObject({
      level: 1,
      action: 'stay',
      streak: 0,
      currentLabel: '当前脚手架：第 1 级（完整引导）',
    });
    expect(initialScaffold('transfer', policy)).toMatchObject({
      level: 3,
      action: 'stay',
      streak: 0,
      currentLabel: '当前脚手架：第 3 级（独立作答）',
      changeReason: '冷迁移后测固定使用第 3 级独立作答。',
    });
  });

  it('uses shared policy transitions and exposes their action and streak in Chinese', () => {
    expect(advanceScaffold('training', 1, [score('hit'), score('hit')], policy)).toMatchObject({
      level: 2,
      action: 'promote',
      streak: 2,
      changeReason: '连续 2 次独立答对，减少引导，调整为第 2 级。',
    });
    expect(advanceScaffold('training', 2, [score('miss')], policy)).toMatchObject({
      level: 1,
      action: 'demote',
      streak: 1,
      changeReason: '连续 1 次未答对，增加引导，调整为第 1 级。',
    });
  });

  it('does not promote a hit-with-help and explains the reset promotion streak', () => {
    const result = advanceScaffold(
      'training',
      1,
      [score('hit'), score('hit-with-help', 'hint'), score('hit')],
      policy,
    );

    expect(result).toMatchObject({ level: 1, action: 'stay', streak: 1 });
    expect(result.changeReason).toBe('帮助后答对不计入升级；当前连续独立答对 1 次，保持第 1 级。');
  });

  it('keeps transfer fixed even when ordinary policy scores would demote it', () => {
    expect(advanceScaffold('transfer', 3, [score('miss')], policy)).toMatchObject({
      level: 3,
      action: 'stay',
      streak: 0,
      changeReason: '冷迁移后测固定使用第 3 级独立作答。',
    });
  });

  it('derives case and scaffold inputs from each latest unique scored node in one attempt', () => {
    const result = deriveAttemptScores([
      scoredEvent({ id: 'p2-old', sequence: 1, nodeId: 'P2', outcome: 'partial', earned: 1, possible: 2 }),
      scoredEvent({
        id: 'other-attempt',
        sequence: 8,
        attemptId: 'attempt-b',
        nodeId: 'P4',
        outcome: 'miss',
        earned: 0,
        possible: 2,
      }),
      unassessedEvent(6, 'P3'),
      scoredEvent({
        id: 'p5-helped',
        sequence: 5,
        nodeId: 'P5',
        outcome: 'hit-with-help',
        earned: 1,
        possible: 1,
        assistance: 'socratic',
      }),
      scoredEvent({ id: 'p2-latest', sequence: 4, nodeId: 'P2', outcome: 'hit', earned: 2, possible: 2 }),
    ], 'attempt-a');

    expect(result.caseScores).toEqual([
      {
        nodeId: 'P2',
        outcome: 'hit',
        earned: 2,
        possible: 2,
        assistance: { kind: 'none', rounds: 0 },
      },
      {
        nodeId: 'P5',
        outcome: 'hit-with-help',
        earned: 1,
        possible: 1,
        assistance: { kind: 'socratic', rounds: 1 },
      },
    ]);
    expect(result.scaffoldScores).toEqual([
      {
        outcome: 'hit',
        earned: 2,
        possible: 2,
        assistance: { kind: 'none', rounds: 0 },
      },
      {
        outcome: 'hit-with-help',
        earned: 1,
        possible: 1,
        assistance: { kind: 'socratic', rounds: 1 },
      },
    ]);
    expect(result.summary).toEqual({ earned: 3, possible: 3, ratio: 1 });
  });

  it('derives one deduplicated scaffold history score for a completed case round', () => {
    const events = [
      scoredEvent({ id: 'p2-first', sequence: 1, attemptId: 'attempt-a', nodeId: 'P2', outcome: 'miss', earned: 0, possible: 2 }),
      scoredEvent({ id: 'p2-retry', sequence: 7, attemptId: 'attempt-b', nodeId: 'P2', outcome: 'hit', earned: 2, possible: 2 }),
      scoredEvent({
        id: 'p3-helped',
        sequence: 3,
        attemptId: 'attempt-a',
        nodeId: 'P3',
        outcome: 'hit-with-help',
        earned: 2,
        possible: 2,
        assistance: 'socratic',
      }),
      scoredEvent({ id: 'outside-round', sequence: 9, attemptId: 'attempt-c', nodeId: 'P4', outcome: 'miss', earned: 0, possible: 2 }),
      {
        ...scoredEvent({ id: 'other-case', sequence: 10, attemptId: 'attempt-b', nodeId: 'P5', outcome: 'miss', earned: 0, possible: 1 }),
        caseId: 'hydrogen-oxygen',
      },
      unassessedEvent(8, 'D5'),
    ];

    expect(deriveCaseScaffoldScore(events, 'zinc-copper', ['attempt-a', 'attempt-b'])).toEqual({
      outcome: 'partial',
      earned: 4,
      possible: 4,
      assistance: { kind: 'socratic', rounds: 1 },
    });

    const allHit = [
      scoredEvent({ id: 'hit-p2', sequence: 11, attemptId: 'attempt-d', nodeId: 'P2', outcome: 'hit', earned: 2, possible: 2 }),
      scoredEvent({ id: 'hit-p3', sequence: 12, attemptId: 'attempt-d', nodeId: 'P3', outcome: 'hit', earned: 2, possible: 2 }),
    ];
    expect(deriveCaseScaffoldScore(allHit, 'zinc-copper', ['attempt-d'])).toMatchObject({
      outcome: 'hit',
      earned: 4,
      possible: 4,
    });
    expect(deriveCaseScaffoldScore([unassessedEvent(13, 'P2')], 'zinc-copper', ['attempt-a']))
      .toBeNull();
  });
});
