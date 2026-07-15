import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { ProviderHttpError } from '../server/llm/errors';
import type { LLMProvider, LLMResponse } from '../server/llm/types';
import type { StudentSession } from '../shared/session';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';
import { sessionWithAssessment } from './helpers/tutor-session';

const apiToken = 'fault-route-token';
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

class TestSessionStore {
  readonly values = new Map<string, StudentSession>();
  get(id: string) { return this.values.get(id); }
  set(session: StudentSession) { this.values.set(session.id, session); }
}

async function routeFixture(
  provider: LLMProvider,
  options: { executionMode?: 'live' | 'demo'; tutorStepId?: string; fastTimeout?: boolean } = {},
) {
  const root = await createTemporaryDirectory();
  await writeValidContentTree(root);
  if (options.fastTimeout) {
    const file = path.join(root, 'config', 'scaffold-policy.json');
    const policy = JSON.parse(await readFile(file, 'utf8'));
    policy.socratic.timeoutMs = 5;
    policy.socratic.forceAdvanceAfterMs = 50;
    await writeFile(file, JSON.stringify(policy));
  }
  const config = await loadAllConfig(root);
  const sessions = new TestSessionStore();
  const session = sessionWithAssessment({ config, sessionId: 'fault-session' });
  sessions.set(session);
  const app = createServerApp({
    contentRoot: root,
    clientRoot: path.join(root, 'client'),
    apiToken,
    providers: new Map([[provider.id, provider]]),
    sessions,
    workflow: {
      executionMode: options.executionMode ?? 'live',
      provider: provider.id,
      model: 'fault-v1',
      ...(options.tutorStepId ? { tutorStepId: options.tutorStepId } : {}),
    },
  });
  return { app, config, sessions };
}

async function tutorRequest(parts: Awaited<ReturnType<typeof routeFixture>>) {
  const response = await parts.app.request('/api/tutor/turn', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lq-api-token': apiToken,
    },
    body: JSON.stringify({
      sessionId: 'fault-session',
      nodeId: 'P4',
      studentAnswer: '电子从Cu极流向Zn极。',
    }),
  });
  return { response, payload: await response.json() as Record<string, unknown> };
}

function expectPersistedPreset(
  parts: Awaited<ReturnType<typeof routeFixture>>,
  payload: Record<string, unknown>,
  reason: string,
) {
  expect(payload).toMatchObject({
    status: 'respond',
    source: 'preset',
    degraded: true,
    reason,
    session: {
      events: expect.arrayContaining([
        expect.objectContaining({ kind: 'tutor.cycle.started' }),
        expect.objectContaining({ kind: 'tutor.turn.completed', source: 'preset' }),
      ]),
    },
  });
  const persisted = parts.sessions.get('fault-session');
  expect(persisted?.events.at(-1)).toMatchObject({
    kind: 'tutor.turn.completed',
    source: 'preset',
  });
}

describe('M1b AC4 HTTP fault injection', () => {
  it('timeout: retries once, then persists a preset without hanging', async () => {
    let attempts = 0;
    const provider = providerWith(
      () => new Promise<LLMResponse>(() => undefined),
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider, { fastTimeout: true });
    const startedAt = Date.now();

    const { response, payload } = await tutorRequest(parts);

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(attempts).toBe(2);
    expectPersistedPreset(parts, payload, 'timeout');
  });

  it('HTTP error: retries once, hides upstream detail, and persists a preset', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => { throw new ProviderHttpError('fault-provider', 503, 'private upstream outage'); },
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider);

    const { payload } = await tutorRequest(parts);

    expect(attempts).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('private upstream outage');
    expectPersistedPreset(parts, payload, 'http-error');
  });

  it('invalid JSON: retries once, then persists the schema fallback', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => ({ content: '{not-json', model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider);

    const { payload } = await tutorRequest(parts);

    expect(attempts).toBe(2);
    expectPersistedPreset(parts, payload, 'invalid-json');
  });

  it('out-of-range action: rejects the whitelist violation and persists a preset', async () => {
    let attempts = 0;
    const value = { action: 'answer', content: '电子从负极流向正极。' };
    const provider = providerWith(
      async () => ({ content: JSON.stringify(value), structured: value, model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider);

    const { payload } = await tutorRequest(parts);

    expect(attempts).toBe(2);
    expectPersistedPreset(parts, payload, 'schema-invalid');
    expect(payload).toMatchObject({ turn: { action: 'probe' } });
  });

  it('answer leakage: discards unsafe content without retry and persists a preset', async () => {
    let attempts = 0;
    const bootstrap = await routeFixture(providerWith(async () => ({ content: '{}', model: 'fault-v1' })));
    const leakedAnswer = bootstrap.config.cases
      .find((entry) => entry.id === 'zinc-copper')!
      .evidencePaths.find((entry) => entry.nodeId === 'P4')!
      .referenceAnswerPoints[0];
    const value = { action: 'hint', content: leakedAnswer };
    const provider = providerWith(
      async () => ({ content: JSON.stringify(value), structured: value, model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider);

    const { payload } = await tutorRequest(parts);

    expect(attempts).toBe(1);
    expectPersistedPreset(parts, payload, 'unsafe-content');
    expect(payload).toMatchObject({
      turn: { content: parts.config.scaffoldPolicy.socratic.fallback.probe },
    });
    expect(JSON.stringify(payload)).not.toContain(leakedAnswer);
  });

  it('missing replay: never calls a provider and persists the replay fallback', async () => {
    let attempts = 0;
    const provider = providerWith(
      async () => ({ content: '{}', model: 'fault-v1' }),
      () => { attempts += 1; },
    );
    const parts = await routeFixture(provider, {
      executionMode: 'demo',
      tutorStepId: 'missing-m1b-replay',
    });

    const { payload } = await tutorRequest(parts);

    expect(attempts).toBe(0);
    expectPersistedPreset(parts, payload, 'replay-missing');
  });
});
