import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { evaluateCasePass, nextScaffoldLevel } from '../shared/scoring/scaffold';

async function policy() {
  return (await loadAllConfig(process.cwd())).scaffoldPolicy;
}

describe('deterministic scaffold policy', () => {
  it('promotes after two consecutive unassisted hits', async () => {
    const result = nextScaffoldLevel(1, ['partial', 'hit', 'hit'], await policy());

    expect(result).toMatchObject({ level: 2, action: 'promote', streak: 2 });
  });

  it('demotes one level after a miss and respects the lower boundary', async () => {
    expect(nextScaffoldLevel(3, ['hit', 'miss'], await policy())).toMatchObject({
      level: 2,
      action: 'demote',
    });
    expect(nextScaffoldLevel(1, ['miss'], await policy())).toMatchObject({
      level: 1,
      action: 'stay',
    });
  });

  it('does not count hit-with-help toward the promotion streak', async () => {
    const result = nextScaffoldLevel(1, ['hit', 'hit-with-help', 'hit'], await policy());

    expect(result).toMatchObject({ level: 1, action: 'stay', streak: 1 });
  });

  it('stays at the independence boundary and reports ordinary non-transition outcomes', async () => {
    const config = await policy();

    expect(nextScaffoldLevel(3, ['hit', 'hit'], config)).toMatchObject({
      level: 3,
      action: 'stay',
      reason: 'Already fully independent',
    });
    expect(nextScaffoldLevel(2, ['partial'], config)).toMatchObject({
      level: 2,
      action: 'stay',
      reason: 'No transition threshold reached',
    });
    expect(() => nextScaffoldLevel(4, [], config)).toThrow(/Unknown scaffold level/);
  });

  it('requires both the ratio threshold and no core miss to pass a case', async () => {
    const config = await loadAllConfig(process.cwd());
    const passed = evaluateCasePass(
      [
        { nodeId: 'P2', earned: 2, possible: 2, outcome: 'hit' },
        { nodeId: 'P3', earned: 1, possible: 2, outcome: 'partial' },
      ],
      config.knowledgeModel,
      config.scaffoldPolicy,
    );
    const coreMiss = evaluateCasePass(
      [
        { nodeId: 'P2', earned: 0, possible: 2, outcome: 'miss' },
        { nodeId: 'P3', earned: 2, possible: 2, outcome: 'hit' },
        { nodeId: 'P4', earned: 2, possible: 2, outcome: 'hit' },
        { nodeId: 'P5', earned: 1, possible: 1, outcome: 'hit' },
      ],
      config.knowledgeModel,
      config.scaffoldPolicy,
    );

    expect(passed).toMatchObject({ passed: true, ratio: 0.75, coreMissNodeIds: [] });
    expect(coreMiss).toMatchObject({ passed: false, ratio: expect.any(Number), coreMissNodeIds: ['P2'] });
  });

  it('validates score inputs and keeps an empty case outside the pass denominator', async () => {
    const config = await loadAllConfig(process.cwd());

    expect(evaluateCasePass([], config.knowledgeModel, config.scaffoldPolicy)).toMatchObject({
      passed: false,
      earned: 0,
      possible: 0,
      ratio: null,
    });
    expect(() => evaluateCasePass(
      [{ nodeId: 'UNKNOWN', earned: 0, possible: 1, outcome: 'miss' }],
      config.knowledgeModel,
      config.scaffoldPolicy,
    )).toThrow(/Unknown knowledge node/);
    for (const score of [
      { nodeId: 'P2', earned: 0, possible: 0, outcome: 'miss' as const },
      { nodeId: 'P2', earned: -1, possible: 2, outcome: 'miss' as const },
      { nodeId: 'P2', earned: 3, possible: 2, outcome: 'hit' as const },
    ]) {
      expect(() => evaluateCasePass(
        [score],
        config.knowledgeModel,
        config.scaffoldPolicy,
      )).toThrow(/Invalid score/);
    }
  });
});
