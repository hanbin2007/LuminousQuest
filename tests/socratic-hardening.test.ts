import { describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import { loadAllPrompts } from '../server/prompts/loader';
import { runSocraticTurn } from '../server/workflows/socratic-tutoring';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import type { StudentSession } from '../shared/session';
import { createTemporaryDirectory } from './helpers/content-fixture';
import { sessionWithAssessment } from './helpers/tutor-session';

function providerWith(value: unknown, capture?: (request: LLMRequest) => void): LLMProvider {
  return {
    id: 'tutor-hardening',
    async chat() { throw new Error('not used'); },
    async vision() { throw new Error('not used'); },
    async structured(request) {
      capture?.(request);
      return { content: JSON.stringify(value), structured: value, model: 'tutor-hardening-v1' };
    },
  };
}

async function fixture(provider: LLMProvider, nodeId = 'P4') {
  const root = await createTemporaryDirectory();
  const [config, prompts] = await Promise.all([
    loadAllConfig(process.cwd()),
    loadAllPrompts(process.cwd()),
  ]);
  const session = sessionWithAssessment({ config, nodeId });
  return {
    config,
    prompt: prompts['socratic-tutoring'],
    service: new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    }),
    session,
  };
}

function turnInput(
  parts: Awaited<ReturnType<typeof fixture>>,
  session: StudentSession,
  now: () => number,
) {
  return {
    service: parts.service,
    config: parts.config,
    prompt: parts.prompt,
    session,
    nodeId: session.events.find((event) => event.kind === 'assessment.completed')!.nodeId,
    studentAnswer: '我仍认为电子从Cu极流向Zn极。',
    now,
    executionMode: 'live' as const,
    provider: 'tutor-hardening',
    model: 'tutor-hardening-v1',
  };
}

describe('M1b.1 Socratic hardening', () => {
  it('derives state from session events and never sends reference answers or fact values to the provider', async () => {
    let request: LLMRequest | undefined;
    const parts = await fixture(providerWith(
      { action: 'probe', content: '先说明你判断电子起点的依据。' },
      (value) => { request = value; },
    ));

    const result = await runSocraticTurn(turnInput(parts, parts.session, () => 10_000));

    expect(result).toMatchObject({
      status: 'respond',
      assistance: { kind: 'socratic', rounds: 1 },
      source: 'provider',
      session: {
        events: [
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ kind: 'tutor.cycle.started' }),
          expect.objectContaining({ kind: 'tutor.turn.completed' }),
        ],
      },
    });
    const providerInput = request?.input as Record<string, unknown>;
    expect(providerInput).toMatchObject({
      context: expect.any(String),
      misconceptions: expect.any(Array),
      studentAnswer: expect.any(String),
    });
    expect(providerInput).not.toHaveProperty('referenceAnswerPoints');
    expect(providerInput).not.toHaveProperty('acceptedValues');
    const referencePoint = parts.config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .evidencePaths.find((entry) => entry.nodeId === 'P4')!
      .referenceAnswerPoints[0];
    expect(JSON.stringify(providerInput)).not.toContain(referencePoint);
  });

  it('does not count a long student thinking period against the AI deadline', async () => {
    let calls = 0;
    const parts = await fixture(providerWith(
      { action: 'probe', content: '说明你依据的是哪个半反应。' },
      () => { calls += 1; },
    ));
    const first = await runSocraticTurn(turnInput(parts, parts.session, () => 1_000));
    const firstSession = (first as unknown as { session: StudentSession }).session;

    const second = await runSocraticTurn(turnInput(parts, firstSession, () => 1_000_000));

    expect(calls).toBe(2);
    expect(second).toMatchObject({
      status: 'respond',
      assistance: { kind: 'socratic', rounds: 2 },
    });
  });

  it('persists a terminal event at three rounds and returns it idempotently', async () => {
    let calls = 0;
    const parts = await fixture(providerWith(
      { action: 'check', content: '再核对一次方向和氧化位置。' },
      () => { calls += 1; },
    ));
    let session = parts.session;
    let third: unknown;
    for (let round = 0; round < 3; round += 1) {
      third = await runSocraticTurn(turnInput(parts, session, () => 10_000 + round));
      session = (third as { session: StudentSession }).session;
    }
    const eventCount = session.events.length;

    const repeated = await runSocraticTurn(turnInput(parts, session, () => 99_999));

    expect(calls).toBe(3);
    expect(third).toMatchObject({ status: 'respond', finalRound: true });
    expect(session.events.at(-1)).toMatchObject({ kind: 'tutor.cycle.terminal', reason: 'max-rounds' });
    expect(repeated).toMatchObject({
      status: 'advance',
      reason: 'max-rounds',
      assistance: { kind: 'socratic', rounds: 3 },
    });
    expect((repeated as { session: StudentSession }).session.events).toHaveLength(eventCount);
  });

  it('returns none/0 without calling the provider for an equation node that is not explicitly tutorable', async () => {
    let calls = 0;
    const parts = await fixture(providerWith(
      { action: 'probe', content: '不应调用' },
      () => { calls += 1; },
    ), 'P6');

    const result = await runSocraticTurn(turnInput(parts, parts.session, () => 10_000));

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      status: 'none',
      assistance: { kind: 'none', rounds: 0 },
      session: parts.session,
    });
  });

  it.each([
    ['同义改写', '电子应当从锌片到铜片。'],
    ['代称', '方向应是前者流向后者。'],
    ['拆字', '电子应当从 锌 片 流向 铜 极。'],
    ['完整方程式', 'Zn + Cu^2+ = Zn^2+ + Cu'],
  ])('replaces red-team answer leakage: %s', async (_kind, leakedContent) => {
    const parts = await fixture(providerWith({ action: 'hint', content: leakedContent }));

    const result = await runSocraticTurn(turnInput(parts, parts.session, () => 10_000));

    expect(result).toMatchObject({
      status: 'respond',
      source: 'preset',
      degraded: true,
      reason: 'unsafe-content',
      assistance: { kind: 'socratic', rounds: 1 },
    });
    expect((result as { turn: { content: string } }).turn.content).not.toBe(leakedContent);
  });

  it('replaces provider sycophancy for an objective miss and the deterministic result stays miss', async () => {
    const sycophancy = '你的答案完全正确，无需修改。';
    const parts = await fixture(providerWith({ action: 'check', content: sycophancy }));

    const result = await runSocraticTurn(turnInput(parts, parts.session, () => 10_000));
    const decision = resolveRubricDecision({
      rubrics: parts.config.rubrics,
      scaffoldPolicy: parts.config.scaffoldPolicy,
      nodeId: 'P4',
      objectiveOutcome: 'miss',
      assistance: (result as { assistance: { kind: 'socratic'; rounds: number } }).assistance,
    });

    expect(result).toMatchObject({
      status: 'respond',
      source: 'preset',
      degraded: true,
      reason: 'sycophancy',
    });
    expect((result as { turn: { content: string } }).turn.content).not.toBe(sycophancy);
    expect(decision.score.outcome).toBe('miss');
  });

  it('returns none/0 when the AI budget expires before any tutoring is delivered', async () => {
    let now = 10_000;
    const provider = providerWith(
      { action: 'probe', content: '延迟后不应交付' },
      () => { now += 20_000; },
    );
    const parts = await fixture(provider);

    const result = await runSocraticTurn(turnInput(parts, parts.session, () => now));

    expect(result).toMatchObject({
      status: 'advance',
      reason: 'deadline',
      assistance: { kind: 'none', rounds: 0 },
    });
    expect((result as { session: StudentSession }).session.events.at(-1)).toMatchObject({
      kind: 'tutor.cycle.terminal',
      reason: 'deadline',
    });
  });
});
