import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import {
  executeSessionCommand,
  InMemorySessionStore,
  SessionIdempotencyConflictError,
  SessionPrefixConflictError,
  SessionSequenceConflictError,
} from '../server/session/store';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';
import { sessionServerSequence } from '../shared/session/sync';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'm6-sync-api-token';
const apiHeaders = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

function withAnswer(session: StudentSession, input: { id: string; value: string }) {
  return appendSessionEvent(session, {
    id: input.id,
    occurredAt: '2026-07-23T15:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'pretest',
    stageId: 'assessment',
    attemptId: input.id,
    questionId: 'fixture-question',
    answer: { format: 'text', value: input.value },
  });
}

describe('/api/session/sync', () => {
  it('executes commands under one mutex and rebuilds idempotency from the event stream', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const base = createSession({
      id: 'command-boundary-session',
      anonymousStudentId: 'anon-COMMAND1',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const sessions = new InMemorySessionStore();
    sessions.set(base);
    let executions = 0;
    const run = (store: InMemorySessionStore, value: string) =>
      executeSessionCommand({
        store,
        sessionId: base.id,
        commandName: 'choice',
        expectedSequence: 0,
        idempotencyKey: 'choice-command-1',
        request: { value },
        initialize: () => base,
        execute(session) {
          executions += 1;
          return {
            session: withAnswer(session, {
              id: 'command-answer',
              value,
            }),
            value: { status: 'recorded' as const },
          };
        },
      });

    // Red-before-green: the old routes had independent race/idempotency checks.
    const concurrent = await Promise.all([
      run(sessions, 'A'),
      run(sessions, 'A'),
    ]);
    expect(executions).toBe(1);
    expect(concurrent.map((entry) => entry.replayed).sort()).toEqual([false, true]);
    expect(sessions.get(base.id)?.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
    ]);
    expect(sessions.get(base.id)?.events[0]).toMatchObject({
      command: {
        commandName: 'choice',
        idempotencyKey: 'choice-command-1',
        expectedSequence: 0,
        resultingSequence: 1,
      },
    });
    expect(sessionServerSequence(sessions.get(base.id)!)).toBe(1);

    const restarted = new InMemorySessionStore();
    restarted.set(sessions.get(base.id)!);
    const replay = await run(restarted, 'A');
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    await expect(run(restarted, 'B'))
      .rejects.toBeInstanceOf(SessionIdempotencyConflictError);
  });

  it('stores the audit ledger but returns only the student projection', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const sessions = new InMemorySessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
    });
    let audit = withAnswer(createSession({
      id: 'sync-projection-session',
      anonymousStudentId: 'anon-SYNC0004',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    }), { id: 'projection-trigger', value: '触发' });
    audit = appendSessionEvent(audit, {
      id: 'projection-turn-event',
      occurredAt: '2026-07-23T15:00:02.000Z',
      kind: 'agent.turn.completed',
      pipelineStage: 'agent',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'projection-attempt',
      turnId: 'projection-turn',
      triggerEventId: 'projection-trigger',
      contextThroughSequence: 0,
      requestHash: `sha256:${'2'.repeat(64)}`,
      source: 'provider',
      model: 'model',
      orderedActions: [
        {
          callId: 'projection-conclusion',
          name: 'conclude_node',
          arguments: {
            nodeId: 'P4',
            verdict: 'inconclusive',
            rationale: 'Insufficient evidence.',
          },
        },
        {
          callId: 'projection-end',
          name: 'end_session',
          arguments: { summary: '结束。' },
        },
      ],
      terminalAction: { callId: 'projection-end', name: 'end_session' },
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    });
    audit = appendSessionEvent(audit, {
      id: 'projection-judgment',
      occurredAt: '2026-07-23T15:00:03.000Z',
      kind: 'agent.judgment.recorded',
      pipelineStage: 'agent',
      caseId: 'pretest',
      stageId: 'assessment',
      attemptId: 'projection-attempt',
      turnId: 'projection-turn',
      nodeId: 'P4',
      verdict: 'inconclusive',
      rationale: 'Insufficient evidence.',
      basisThroughSequence: 0,
      basisEventIds: ['projection-trigger'],
      provenance: { adapter: 'openai-compatible', adapterVersion: 'agent-adapter.v1' },
    });

    const response = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: audit,
        expectedSequence: 0,
        idempotencyKey: 'projection-sync',
      }),
    });
    const payload = await response.json() as { session: StudentSession };

    expect(response.status).toBe(200);
    expect(sessions.get(audit.id)?.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
      'agent.turn.completed',
      'agent.judgment.recorded',
    ]);
    expect(payload.session.events.map((event) => event.kind)).toEqual([
      'answer.submitted',
      'agent.turn.completed',
    ]);
    const projectedTurn = payload.session.events[1];
    expect(projectedTurn).toMatchObject({
      kind: 'agent.turn.completed',
      orderedActions: [{ name: 'end_session' }],
    });
  });

  it('hydrates a full local session and replays the same idempotency key without duplicating it', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const sessions = new InMemorySessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
    });
    const local = withAnswer(createSession({
      id: 'sync-session',
      anonymousStudentId: 'anon-SYNC0001',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    }), { id: 'sync-answer-1', value: '本地答案' });
    const command = {
      session: local,
      expectedSequence: 0,
      idempotencyKey: 'sync-command-1',
    };

    const first = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(command),
    });
    const replay = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(command),
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: 'hydrated',
      replayed: false,
      sequence: 1,
      session: { id: local.id },
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: 'hydrated',
      replayed: true,
      sequence: 1,
      session: { id: local.id },
    });
    expect(sessions.get(local.id)?.events).toEqual(local.events);
  });

  it('rejects sequence races, divergent prefixes, reused keys, and config-digest drift', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const sessions = new InMemorySessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      sessions,
    });
    const base = createSession({
      id: 'sync-conflict-session',
      anonymousStudentId: 'anon-SYNC0002',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const first = withAnswer(base, { id: 'prefix-a', value: 'A' });
    await sessions.synchronize(first, {
      expectedSequence: 0,
      idempotencyKey: 'initial-sync',
    });

    const sequenceConflict = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: first,
        expectedSequence: 0,
        idempotencyKey: 'stale-sequence',
      }),
    });
    expect(sequenceConflict.status).toBe(409);
    expect(await sequenceConflict.json()).toMatchObject({
      error: 'session-sequence-conflict',
      expectedSequence: 0,
      actualSequence: 1,
    });

    const divergent = withAnswer(base, { id: 'prefix-b', value: 'B' });
    const prefixConflict = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: divergent,
        expectedSequence: 1,
        idempotencyKey: 'divergent-prefix',
      }),
    });
    expect(prefixConflict.status).toBe(409);
    expect(await prefixConflict.json()).toMatchObject({ error: 'session-prefix-conflict' });

    const reusedKey = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: { ...first, updatedAt: '2026-07-23T15:00:02.000Z' },
        expectedSequence: 0,
        idempotencyKey: 'initial-sync',
      }),
    });
    expect(reusedKey.status).toBe(409);
    expect(await reusedKey.json()).toMatchObject({ error: 'session-idempotency-conflict' });

    const wrongConfig = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: {
          ...createSession({
            id: 'wrong-config-session',
            anonymousStudentId: 'anon-SYNC0003',
            now: '2026-07-23T15:00:00.000Z',
            configVersions: sessionConfigVersions(config),
          }),
          configVersions: {
            ...sessionConfigVersions(config),
            configDigest: 'sha256:wrong',
          },
        },
        expectedSequence: 0,
        idempotencyKey: 'wrong-config',
      }),
    });
    expect(wrongConfig.status).toBe(409);
    expect(await wrongConfig.json()).toMatchObject({ error: 'session-config-digest-mismatch' });

    const invalidSchema = await app.request('/api/session/sync', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify({
        session: { ...base, schemaVersion: 'session.v1' },
        expectedSequence: 1,
        idempotencyKey: 'invalid-schema',
      }),
    });
    expect(invalidSchema.status).toBe(400);
    expect(await invalidSchema.json()).toMatchObject({ error: 'Invalid session sync request' });
  });

  it('serializes concurrent commands per session through the mutex boundary', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const sessions = new InMemorySessionStore();
    const base = createSession({
      id: 'mutex-session',
      anonymousStudentId: 'anon-MUTEX001',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const left = withAnswer(base, { id: 'mutex-left', value: 'left' });
    const right = withAnswer(base, { id: 'mutex-right', value: 'right' });

    const outcomes = await Promise.allSettled([
      sessions.synchronize(left, { expectedSequence: 0, idempotencyKey: 'mutex-left' }),
      sessions.synchronize(right, { expectedSequence: 0, idempotencyKey: 'mutex-right' }),
    ]);

    expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((entry) => entry.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(SessionSequenceConflictError),
    });
    expect(sessions.get(base.id)?.events).toHaveLength(1);
  });

  it('exposes distinct typed conflicts at the store contract', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    const sessions = new InMemorySessionStore();
    const base = createSession({
      id: 'typed-conflict-session',
      anonymousStudentId: 'anon-CONFLICT1',
      now: '2026-07-23T15:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const first = withAnswer(base, { id: 'typed-a', value: 'A' });
    await sessions.synchronize(first, { expectedSequence: 0, idempotencyKey: 'typed-initial' });

    await expect(sessions.synchronize(first, {
      expectedSequence: 0,
      idempotencyKey: 'typed-sequence',
    })).rejects.toBeInstanceOf(SessionSequenceConflictError);
    await expect(sessions.synchronize(
      withAnswer(base, { id: 'typed-b', value: 'B' }),
      { expectedSequence: 1, idempotencyKey: 'typed-prefix' },
    )).rejects.toBeInstanceOf(SessionPrefixConflictError);
    await expect(sessions.synchronize(
      { ...first, updatedAt: '2026-07-23T15:00:02.000Z' },
      { expectedSequence: 0, idempotencyKey: 'typed-initial' },
    )).rejects.toBeInstanceOf(SessionIdempotencyConflictError);
  });
});
