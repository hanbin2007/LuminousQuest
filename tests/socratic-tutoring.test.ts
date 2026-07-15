import { describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import { loadAllPrompts } from '../server/prompts/loader';
import { runSocraticTurn } from '../server/workflows/socratic-tutoring';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import { answerLeakage } from '../shared/workflows/socratic';
import { createTemporaryDirectory } from './helpers/content-fixture';

async function fixture(provider: LLMProvider) {
  const root = await createTemporaryDirectory();
  const [config, prompts] = await Promise.all([
    loadAllConfig(process.cwd()),
    loadAllPrompts(process.cwd()),
  ]);
  return {
    config,
    prompt: prompts['socratic-tutoring'],
    service: new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    }),
  };
}

function providerWith(value: unknown, capture?: (request: LLMRequest) => void): LLMProvider {
  return {
    id: 'tutor-fixture',
    async chat() { throw new Error('not used'); },
    async vision() { throw new Error('not used'); },
    async structured(request) {
      capture?.(request);
      return { content: JSON.stringify(value), structured: value, model: 'tutor-fixture-v1' };
    },
  };
}

function turnInput(parts: Awaited<ReturnType<typeof fixture>>, nowMs: number) {
  return {
    ...parts,
    caseId: 'zinc-copper',
    nodeId: 'P4',
    studentAnswer: '电子从Cu极流向Zn极，我坚持这个答案。',
    conversation: [],
    completedRounds: 0,
    cycleStartedAtMs: nowMs,
    now: () => nowMs,
    executionMode: 'live' as const,
    provider: 'tutor-fixture',
    model: 'tutor-fixture-v1',
  };
}

describe('bounded Socratic tutoring loop', () => {
  it('accepts only a structured action and content without making a score decision', async () => {
    const nowMs = 10_000;
    let request: LLMRequest | undefined;
    const parts = await fixture(providerWith(
      { action: 'probe', content: '你先说说：哪一极发生失电子反应？' },
      (value) => { request = value; },
    ));

    const result = await runSocraticTurn(turnInput(parts, nowMs));

    expect(result).toMatchObject({
      status: 'respond',
      turn: { action: 'probe', content: '你先说说：哪一极发生失电子反应？' },
      assistance: { kind: 'socratic', rounds: 1 },
      source: 'provider',
      degraded: false,
    });
    expect(result).not.toHaveProperty('score');
    expect(result).not.toHaveProperty('outcome');
    expect(request).toMatchObject({ capability: 'structured' });
    expect(request?.schema).toMatchObject({
      additionalProperties: false,
      required: ['action', 'content'],
      properties: { action: { enum: ['probe', 'hint', 'check'] } },
    });
  });

  it('consumes the section 15/16 policy while leaving a wrong answer as miss', async () => {
    const nowMs = 20_000;
    const parts = await fixture(providerWith({
      action: 'check',
      content: '把你的方向判断与失电子的电极再对照一次。',
    }));
    const turn = await runSocraticTurn({
      ...turnInput(parts, nowMs),
      completedRounds: 2,
    });
    expect(turn.status).toBe('respond');
    if (turn.status !== 'respond') throw new Error('expected tutor response');

    const corrected = resolveRubricDecision({
      rubrics: parts.config.rubrics,
      scaffoldPolicy: parts.config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'hit',
      assistance: turn.assistance,
    });
    const stubborn = resolveRubricDecision({
      rubrics: parts.config.rubrics,
      scaffoldPolicy: parts.config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'miss',
      assistance: turn.assistance,
    });

    expect(corrected.score.outcome).toBe(parts.config.scaffoldPolicy.socratic.correctedOutcome);
    expect(stubborn.score.outcome).toBe('miss');
  });

  it('forces a configured close without another model call after three rounds', async () => {
    const nowMs = 30_000;
    let attempts = 0;
    const provider = providerWith({ action: 'probe', content: '不应被调用' }, () => { attempts += 1; });
    const parts = await fixture(provider);

    const result = await runSocraticTurn({
      ...turnInput(parts, nowMs),
      completedRounds: 3,
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({
      status: 'advance',
      reason: 'max-rounds',
      content: parts.config.scaffoldPolicy.socratic.fallback.closing,
      assistance: { kind: 'socratic', rounds: 3 },
      source: 'preset',
    });
  });

  it('forces advance when the configured cycle deadline is already exhausted', async () => {
    const nowMs = 50_000;
    let attempts = 0;
    const parts = await fixture(providerWith(
      { action: 'probe', content: '不应被调用' },
      () => { attempts += 1; },
    ));

    const result = await runSocraticTurn({
      ...turnInput(parts, nowMs),
      completedRounds: 1,
      cycleStartedAtMs: nowMs - parts.config.scaffoldPolicy.socratic.forceAdvanceAfterMs,
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({ status: 'advance', reason: 'deadline', source: 'preset' });
  });

  it('detects reference-answer overlap above the configured threshold', async () => {
    const parts = await fixture(providerWith({ action: 'probe', content: 'unused' }));
    const answerPoint = parts.config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .scaffold[0].answerPoints[2];

    expect(answerLeakage(
      answerPoint,
      [answerPoint],
      parts.config.scaffoldPolicy.socratic.answerOverlapThreshold,
      parts.config.scaffoldPolicy.extraction.citation.commonTypos,
    )).toMatchObject({ leaked: true, overlap: 1 });
    expect(answerLeakage(
      '先找到发生失电子反应的场所，再说出判断依据。',
      [answerPoint],
      parts.config.scaffoldPolicy.socratic.answerOverlapThreshold,
      parts.config.scaffoldPolicy.extraction.citation.commonTypos,
    ).leaked).toBe(false);
  });

  it('treats empty and short comparison text deterministically', () => {
    expect(answerLeakage('', [], 0.5, {})).toEqual({
      leaked: false,
      overlap: 0,
      matchedPointIndex: null,
    });
    expect(answerLeakage('A', ['Ａ'], 0.5, {})).toEqual({
      leaked: true,
      overlap: 1,
      matchedPointIndex: 0,
    });
  });
});
