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
});
