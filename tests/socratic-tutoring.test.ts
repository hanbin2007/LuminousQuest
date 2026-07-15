import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { answerLeakage } from '../shared/workflows/socratic';

describe('Socratic overlap leakage', () => {
  it('requires both the configured ratio and the absolute shared-bigram floor', async () => {
    const config = await loadAllConfig(process.cwd());
    const answerPoint = config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .evidencePaths.find((entry) => entry.nodeId === 'P4')!
      .referenceAnswerPoints[0];
    const policy = config.scaffoldPolicy.socratic;

    expect(answerLeakage(
      answerPoint,
      [answerPoint],
      policy.answerOverlapThreshold,
      config.scaffoldPolicy.extraction.citation.commonTypos,
      policy.minimumSharedBigrams,
    )).toMatchObject({ leaked: true, overlap: 1 });
    expect(answerLeakage(
      '先找到发生失电子反应的场所，再说出判断依据。',
      [answerPoint],
      policy.answerOverlapThreshold,
      config.scaffoldPolicy.extraction.citation.commonTypos,
      policy.minimumSharedBigrams,
    ).leaked).toBe(false);
  });

  it('does not false-positive on empty or very short matching text', () => {
    expect(answerLeakage('', [], 0.5, {}, 2)).toEqual({
      leaked: false,
      overlap: 0,
      sharedBigrams: 0,
      matchedPointIndex: null,
    });
    expect(answerLeakage('', ['答案要点'], 0.5, {}, 2)).toEqual({
      leaked: false,
      overlap: 0,
      sharedBigrams: 0,
      matchedPointIndex: null,
    });
    expect(answerLeakage('答案要点', [''], 0.5, {}, 2)).toEqual({
      leaked: false,
      overlap: 0,
      sharedBigrams: 0,
      matchedPointIndex: null,
    });
    expect(answerLeakage('A', ['Ａ'], 0.5, {}, 2)).toEqual({
      leaked: false,
      overlap: 1,
      sharedBigrams: 1,
      matchedPointIndex: 0,
    });
  });
});
