import { describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider } from '../server/llm/types';
import { loadAllPrompts } from '../server/prompts/loader';
import { runSocraticTurn } from '../server/workflows/socratic-tutoring';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import { answerLeakage, type SocraticAction } from '../shared/workflows/socratic';
import { createTemporaryDirectory } from './helpers/content-fixture';
import { sessionWithAssessment } from './helpers/tutor-session';

describe('stubborn student behavior', () => {
  it('does not yield the score or answer across three wrong rounds and closes correctly', async () => {
    const root = await createTemporaryDirectory();
    const [config, prompts] = await Promise.all([
      loadAllConfig(process.cwd()),
      loadAllPrompts(process.cwd()),
    ]);
    const responses: SocraticAction[] = [
      { action: 'probe', content: '你判断失电子场所的依据是什么？' },
      { action: 'hint', content: '先对照氧化反应与两个电极场所。' },
      { action: 'check', content: '检查你的方向是否与失电子场所一致。' },
    ];
    let calls = 0;
    const provider: LLMProvider = {
      id: 'stubborn-fixture',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        const value = responses[calls];
        calls += 1;
        return { content: JSON.stringify(value), structured: value, model: 'stubborn-v1' };
      },
    };
    const service = new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const answerPoints = config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .evidencePaths.find((entry) => entry.nodeId === 'P4')!
      .referenceAnswerPoints;
    const base = {
      service,
      config,
      prompt: prompts['socratic-tutoring'],
      nodeId: 'P4',
      studentAnswer: '我就认为电子从Cu极流向Zn极。',
      executionMode: 'live' as const,
      provider: provider.id,
      model: 'stubborn-v1',
    };
    let session = sessionWithAssessment({ config });
    let lastAssistance: { kind: 'none'; rounds: 0 } | { kind: 'socratic'; rounds: number } | undefined;

    for (let completedRounds = 0; completedRounds < 3; completedRounds += 1) {
      const result = await runSocraticTurn({ ...base, session });
      expect(result.status).toBe('respond');
      if (result.status !== 'respond') throw new Error('expected three tutor turns');
      expect(result).not.toHaveProperty('score');
      expect(result).not.toHaveProperty('outcome');
      expect(answerLeakage(
        result.turn.content,
        answerPoints,
        config.scaffoldPolicy.socratic.answerOverlapThreshold,
        config.scaffoldPolicy.extraction.citation.commonTypos,
        config.scaffoldPolicy.socratic.minimumSharedBigrams,
      ).leaked).toBe(false);
      lastAssistance = result.assistance;
      session = result.session;
      if (completedRounds === 2) expect(result.finalRound).toBe(true);
    }

    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      scaffoldPolicy: config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'miss',
      assistance: lastAssistance!,
    });
    expect(decision.score.outcome).toBe('miss');

    const closing = await runSocraticTurn({ ...base, session });
    expect(calls).toBe(3);
    expect(closing).toMatchObject({
      status: 'advance',
      reason: 'max-rounds',
      content: config.scaffoldPolicy.socratic.fallback.closing,
    });
    if (closing.status !== 'advance') throw new Error('expected forced close');
    expect(answerLeakage(
      closing.content,
      answerPoints,
      config.scaffoldPolicy.socratic.answerOverlapThreshold,
      config.scaffoldPolicy.extraction.citation.commonTypos,
      config.scaffoldPolicy.socratic.minimumSharedBigrams,
    ).leaked).toBe(false);
  });
});
