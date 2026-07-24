import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOLSET_DIGEST,
} from '../shared/agent/contracts';
import { sessionSchema } from '../shared/session/schema';
import { createSession } from '../shared/session/session';
import {
  coordinateSessionStore,
  InMemorySessionStore,
} from '../server/session/store';

const versions = {
  configDigest: 'sha256:config-digest-fixture',
  knowledgeModel: 'knowledge.v1',
  rubrics: 'rubrics.v1',
  pretest: 'pretest.v1',
  scaffoldPolicy: 'scaffold.v1',
  cases: { 'zinc-copper': 'case.v1' },
  grammar: 'grammar.v1',
  engines: { rubric: 'rubric.v1', topology: 'topology.v1', equation: 'equation.v1' },
};

function fixtureSession(overrides: Record<string, unknown> = {}) {
  const session = createSession({
    id: 'sync-hardening-session',
    now: '2026-07-23T12:00:00.000Z',
    configVersions: versions,
  });
  return sessionSchema.parse({ ...session, ...overrides });
}

describe('session sync idempotency hardening', () => {
  it('re-executes instead of conflicting when the same key carries an evolved session', async () => {
    // 回归:修复前,同 key + 会话内容漂移(updatedAt) → 409 永久锁死
    // (生产复现:sync:startup:<id>:<seq> 跨页面加载复用)。
    const store = coordinateSessionStore(new InMemorySessionStore());
    const key = 'sync:startup:sync-hardening-session:0';
    const base = fixtureSession();
    const first = await store.synchronize(base, {
      expectedSequence: 0,
      idempotencyKey: key,
    });
    expect(first.status).toBe('hydrated');

    const drifted = sessionSchema.parse({ ...base, updatedAt: '2026-07-23T12:34:56.000Z' });
    const second = await store.synchronize(drifted, {
      expectedSequence: 0,
      idempotencyKey: key,
    });
    expect(second.replayed).toBe(false);
    expect(second.status).toBe('already-current');

    // 同 key 同指纹仍然按重放返回(网络重试语义保留)
    const replay = await store.synchronize(drifted, {
      expectedSequence: 0,
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
  });
});

describe('session contract marker tolerance', () => {
  it('parses sessions persisted by an older toolset build instead of deleting them', () => {
    // 回归:修复前 toolsetDigest 是 z.literal,旧 digest 会话 parse 失败,
    // restoreLatest 会直接删档(静默数据丢失)。
    const stale = {
      ...fixtureSession(),
      toolsetDigest: 'sha256:0123456789abcdef0123456789abcdef',
      agentContractRevision: 'agent-contract.v0',
      contextBuilderVersion: 'agent-context-builder.v0',
    };
    const parsed = sessionSchema.parse(stale);
    expect(parsed.toolsetDigest).toBe('sha256:0123456789abcdef0123456789abcdef');
    expect(parsed.toolsetDigest).not.toBe(AGENT_TOOLSET_DIGEST);
  });

  it('still stamps current markers onto newly created sessions', () => {
    expect(fixtureSession().toolsetDigest).toBe(AGENT_TOOLSET_DIGEST);
  });
});
