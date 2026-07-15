import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { evaluateCasePass, nextScaffoldLevel } from '../shared/scoring/scaffold';

async function policy() {
  return (await loadAllConfig(process.cwd())).scaffoldPolicy;
}

function attempt(
  outcome: 'hit' | 'hit-with-help' | 'partial' | 'miss',
  assistance: { kind: 'none' | 'hint' | 'socratic'; rounds: number } = { kind: 'none', rounds: 0 },
) {
  return { outcome, earned: outcome === 'miss' ? 0 : 1, possible: 1, assistance };
}

describe('deterministic scaffold policy', () => {
  it('promotes after two consecutive unassisted hits', async () => {
    const result = nextScaffoldLevel(1, [attempt('partial'), attempt('hit'), attempt('hit')], await policy());

    expect(result).toMatchObject({ level: 2, action: 'promote', streak: 2 });
  });

  it('demotes one level after a miss and respects the lower boundary', async () => {
    expect(nextScaffoldLevel(3, [attempt('hit'), attempt('miss')], await policy())).toMatchObject({
      level: 2,
      action: 'demote',
    });
    expect(nextScaffoldLevel(1, [attempt('miss')], await policy())).toMatchObject({
      level: 1,
      action: 'stay',
    });
  });

  it('does not count hit-with-help toward the promotion streak', async () => {
    const result = nextScaffoldLevel(1, [
      attempt('hit'),
      attempt('hit-with-help', { kind: 'hint', rounds: 1 }),
      attempt('hit'),
    ], await policy());

    expect(result).toMatchObject({ level: 1, action: 'stay', streak: 1 });
  });

  it('stays at the independence boundary and reports ordinary non-transition outcomes', async () => {
    const config = await policy();

    expect(nextScaffoldLevel(3, [attempt('hit'), attempt('hit')], config)).toMatchObject({
      level: 3,
      action: 'stay',
      reason: 'Already fully independent',
    });
    expect(nextScaffoldLevel(2, [attempt('partial')], config)).toMatchObject({
      level: 2,
      action: 'stay',
      reason: 'No transition threshold reached',
    });
    expect(() => nextScaffoldLevel(4, [], config)).toThrow(/Unknown scaffold level/);
  });

  it('requires both the ratio threshold and no core miss to pass a case', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = structuredClone(config.cases.find((entry) => entry.id === 'zinc-copper')!);
    trainingCase.targetNodeIds = ['P2', 'P3'];
    const passed = evaluateCasePass(
      [
        { nodeId: 'P2', earned: 2, possible: 2, outcome: 'hit', assistance: { kind: 'none', rounds: 0 } },
        { nodeId: 'P3', earned: 1, possible: 2, outcome: 'partial', assistance: { kind: 'none', rounds: 0 } },
      ],
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    );
    trainingCase.targetNodeIds = ['P2', 'P3', 'P4', 'P5'];
    const coreMiss = evaluateCasePass(
      [
        { nodeId: 'P2', earned: 0, possible: 2, outcome: 'miss', assistance: { kind: 'none', rounds: 0 } },
        { nodeId: 'P3', earned: 2, possible: 2, outcome: 'hit', assistance: { kind: 'none', rounds: 0 } },
        { nodeId: 'P4', earned: 2, possible: 2, outcome: 'hit', assistance: { kind: 'none', rounds: 0 } },
        { nodeId: 'P5', earned: 1, possible: 1, outcome: 'hit', assistance: { kind: 'none', rounds: 0 } },
      ],
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    );

    expect(passed).toMatchObject({ passed: true, ratio: 0.75, coreMissNodeIds: [] });
    expect(coreMiss).toMatchObject({ passed: false, ratio: expect.any(Number), coreMissNodeIds: ['P2'] });
  });

  it('validates score inputs and keeps an empty case outside the pass denominator', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = structuredClone(config.cases.find((entry) => entry.id === 'zinc-copper')!);
    trainingCase.targetNodeIds = ['P2'];

    expect(() => evaluateCasePass(
      [],
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    )).toThrow(/complete.*target/i);
    expect(() => evaluateCasePass(
      [{ nodeId: 'UNKNOWN', earned: 0, possible: 1, outcome: 'miss', assistance: { kind: 'none', rounds: 0 } }],
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    )).toThrow(/Unknown knowledge node/);
    for (const score of [
      { nodeId: 'P2', earned: 0, possible: 0, outcome: 'miss' as const, assistance: { kind: 'none' as const, rounds: 0 } },
      { nodeId: 'P2', earned: -1, possible: 2, outcome: 'miss' as const, assistance: { kind: 'none' as const, rounds: 0 } },
      { nodeId: 'P2', earned: 3, possible: 2, outcome: 'hit' as const, assistance: { kind: 'none' as const, rounds: 0 } },
    ]) {
      expect(() => evaluateCasePass(
        [score],
        trainingCase,
        config.knowledgeModel,
        config.rubrics,
        config.scaffoldPolicy,
      )).toThrow(/Invalid score/);
    }
  });

  it('requires each case target exactly once and excludes unanswered attempts from the denominator', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = structuredClone(config.cases.find((entry) => entry.id === 'zinc-copper')!);
    trainingCase.targetNodeIds = ['P2', 'P3'];
    const scores = [
      { nodeId: 'P2', earned: 2, possible: 2, outcome: 'hit' as const, assistance: { kind: 'none' as const, rounds: 0 } },
      { nodeId: 'P3', outcome: 'unanswered' as const, assistance: { kind: 'none' as const, rounds: 0 } },
    ];

    expect(evaluateCasePass(
      scores,
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    )).toMatchObject({
      passed: false,
      earned: 2,
      possible: 2,
      ratio: 1,
      incompleteTargetNodeIds: ['P3'],
    });
    expect(() => evaluateCasePass(
      [...scores, scores[0]],
      trainingCase,
      config.knowledgeModel,
      config.rubrics,
      config.scaffoldPolicy,
    )).toThrow(/exactly once/i);
  });
});
