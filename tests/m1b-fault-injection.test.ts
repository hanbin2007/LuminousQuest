import { describe, expect, it, vi } from 'vitest';

import { ProviderHttpError } from '../server/llm/errors';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider, LLMResponse } from '../server/llm/types';
import { loadAllConfig } from '../server/config/loader';
import { loadAllPrompts } from '../server/prompts/loader';
import { runSocraticTurn } from '../server/workflows/socratic-tutoring';
import { createTemporaryDirectory } from './helpers/content-fixture';
import { sessionWithAssessment } from './helpers/tutor-session';

type StructuredHandler = () => Promise<LLMResponse>;

function providerWith(handler: StructuredHandler, onCall = () => undefined): LLMProvider {
  return {
    id: 'fault-provider',
    async chat() { throw new Error('not used'); },
    async vision() { throw new Error('not used'); },
    async structured() {
      onCall();
      return handler();
    },
  };
}

async function inputFor(provider: LLMProvider) {
  const root = await createTemporaryDirectory();
  const [config, prompts] = await Promise.all([
    loadAllConfig(process.cwd()),
    loadAllPrompts(process.cwd()),
  ]);
  return {
    service: new LLMService({
      providers: new Map([[provider.id, provider]]),
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    }),
    config,
    prompt: prompts['socratic-tutoring'],
    session: sessionWithAssessment({ config }),
    nodeId: 'P4',
    studentAnswer: '电子从Cu极流向Zn极。',
    executionMode: 'live' as const,
    provider: provider.id,
    model: 'fault-v1',
  };
}

describe('M1b AC4 fault injection', () => {
  it('timeout: retries once, then returns a preset without hanging', async () => {
    let attempts = 0;
    const provider = providerWith(
      () => new Promise<LLMResponse>(() => undefined),
      () => { attempts += 1; },
    );
    const input = await inputFor(provider);
    input.config.scaffoldPolicy.socratic.timeoutMs = 5;
    input.config.scaffoldPolicy.socratic.forceAdvanceAfterMs = 50;
    const startedAt = Date.now();

    const result = await runSocraticTurn(input);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      status: 'respond',
      source: 'preset',
      degraded: true,
      reason: 'timeout',
    });
  });

  it('HTTP error: retries once, hides upstream detail, and uses a preset', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => { throw new ProviderHttpError('fault-provider', 503, 'private upstream outage'); },
      () => { attempts += 1; },
    );
    const result = await runSocraticTurn(await inputFor(provider));

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ status: 'respond', source: 'preset', reason: 'http-error' });
    expect(JSON.stringify(result)).not.toContain('private upstream outage');
  });

  it('invalid JSON: retries once, then follows the schema fallback path', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => ({ content: '{not-json', model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const result = await runSocraticTurn(await inputFor(provider));

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ status: 'respond', source: 'preset', reason: 'invalid-json' });
  });

  it('out-of-range action: rejects the action whitelist violation and uses a preset', async () => {
    let attempts = 0;
    const value = { action: 'answer', content: '电子从负极流向正极。' };
    const provider = providerWith(
      async () => ({ content: JSON.stringify(value), structured: value, model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const result = await runSocraticTurn(await inputFor(provider));

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ status: 'respond', source: 'preset', reason: 'schema-invalid' });
    if (result.status !== 'respond') throw new Error('expected fallback response');
    expect(result.turn.action).toBe('probe');
  });

  it('answer leakage: discards the unsafe content without retry and substitutes a preset', async () => {
    let attempts = 0;
    const input = await inputFor(providerWith(async () => ({
      content: '{}',
      model: 'fault-v1',
    })));
    const leakedAnswer = input.config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .evidencePaths.find((entry) => entry.nodeId === 'P4')!
      .referenceAnswerPoints[0];
    const value = { action: 'hint', content: leakedAnswer };
    const provider = providerWith(
      async () => ({ content: JSON.stringify(value), structured: value, model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const actualInput = await inputFor(provider);

    const result = await runSocraticTurn(actualInput);

    expect(attempts).toBe(1);
    expect(result).toMatchObject({ status: 'respond', source: 'preset', reason: 'unsafe-content' });
    if (result.status !== 'respond') throw new Error('expected fallback response');
    expect(result.turn.content).not.toBe(leakedAnswer);
    expect(result.turn.content).toBe(actualInput.config.scaffoldPolicy.socratic.fallback.probe);
  });

  it('missing replay: never calls a provider and immediately substitutes a preset', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => ({ content: '{}', model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const input = await inputFor(provider);

    const result = await runSocraticTurn({
      ...input,
      executionMode: 'demo',
      stepId: 'missing-m1b-replay',
    });

    expect(attempts).toBe(0);
    expect(result).toMatchObject({ status: 'respond', source: 'preset', reason: 'replay-missing' });
  });
});
