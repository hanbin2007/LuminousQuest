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
      .scaffold.flatMap((level) => level.answerPoints);
    const base = {
      service,
      config,
      prompt: prompts['socratic-tutoring'],
      caseId: 'zinc-copper',
      nodeId: 'P4',
      studentAnswer: '我就认为电子从Cu极流向Zn极。',
      executionMode: 'live' as const,
      provider: provider.id,
      model: 'stubborn-v1',
      cycleStartedAtMs: Date.now(),
    };
    const conversation: Array<{ student: string; tutor: SocraticAction }> = [];
    let lastAssistance: { kind: 'socratic'; rounds: number } | undefined;

    for (let completedRounds = 0; completedRounds < 3; completedRounds += 1) {
      const result = await runSocraticTurn({ ...base, conversation, completedRounds });
      expect(result.status).toBe('respond');
      if (result.status !== 'respond') throw new Error('expected three tutor turns');
      expect(result).not.toHaveProperty('score');
      expect(result).not.toHaveProperty('outcome');
      expect(answerLeakage(
        result.turn.content,
        answerPoints,
        config.scaffoldPolicy.socratic.answerOverlapThreshold,
        config.scaffoldPolicy.extraction.citation.commonTypos,
      ).leaked).toBe(false);
      conversation.push({ student: base.studentAnswer, tutor: result.turn });
      lastAssistance = result.assistance;
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

    const closing = await runSocraticTurn({ ...base, conversation, completedRounds: 3 });
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
    ).leaked).toBe(false);
  });
});
