// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  appendSessionEvent,
  importSession,
  type StudentSession,
} from '../shared/session';
import { LocalSessionStore } from '../shared/session/local-storage';
import { App } from '../src/App';
import { buildTeacherStudentReport } from '../src/features/teacher/teacher-data';
import type { AppRuntime } from '../src/runtime/api';

const fixturePath = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'teacher',
  'session-a.json',
);

function withAgentDivergence(source: StudentSession) {
  const trigger = source.events.at(-1)!;
  const assessment = source.events.find((event) =>
    event.kind === 'assessment.completed' && event.id === 'a-assessment-p4');
  if (!assessment || assessment.kind !== 'assessment.completed') {
    throw new Error('P4 assessment fixture missing');
  }
  let session = appendSessionEvent(source, {
    id: 'teacher-agent-turn',
    occurredAt: '2026-07-23T22:00:00.000Z',
    kind: 'agent.turn.completed',
    pipelineStage: 'agent',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'teacher-agent-attempt',
    turnId: 'teacher-agent-turn-id',
    triggerEventId: trigger.id,
    contextThroughSequence: trigger.sequence,
    requestHash: `sha256:${'a'.repeat(64)}`,
    source: 'provider',
    model: 'teacher-audit-model',
    orderedActions: [{
      callId: 'teacher-agent-conclusion',
      name: 'conclude_node',
      arguments: {
        nodeId: 'P4',
        verdict: 'hit',
        rationale: '学生已经说明电子从负极流向正极。',
      },
    }, {
      callId: 'teacher-agent-end',
      name: 'end_session',
      arguments: { summary: '本轮已完成。' },
    }],
    terminalAction: { callId: 'teacher-agent-end', name: 'end_session' },
    provenance: {
      adapter: 'openai-compatible',
      adapterVersion: 'teacher-audit.v1',
    },
  });
  session = appendSessionEvent(session, {
    id: 'teacher-agent-judgment',
    occurredAt: '2026-07-23T22:00:01.000Z',
    kind: 'agent.judgment.recorded',
    pipelineStage: 'agent',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'teacher-agent-attempt',
    turnId: 'teacher-agent-turn-id',
    nodeId: 'P4',
    verdict: 'hit',
    rationale: '学生已经说明电子从负极流向正极。',
    basisThroughSequence: trigger.sequence,
    basisEventIds: [assessment.id],
    provenance: {
      adapter: 'openai-compatible',
      adapterVersion: 'teacher-audit.v1',
    },
  });
  return appendSessionEvent(session, {
    id: 'teacher-agent-divergence',
    occurredAt: '2026-07-23T22:00:02.000Z',
    kind: 'agent.divergence.changed',
    pipelineStage: 'agent',
    caseId: 'zinc-copper',
    stageId: 'training',
    attemptId: 'teacher-agent-attempt',
    judgmentEventId: 'teacher-agent-judgment',
    shadowAssessmentEventId: assessment.id,
    agentVerdict: 'hit',
    shadowVerdict: 'miss',
    status: 'detected',
    comparisonPolicyVersion: 'agent-shadow-comparison.v1',
  });
}

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear() { values.clear(); },
      getItem(key: string) { return values.get(key) ?? null; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      removeItem(key: string) { values.delete(key); },
      setItem(key: string, value: string) { values.set(key, value); },
    } satisfies Storage,
  });
  window.history.pushState({}, '', '/teacher');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    provider: 'mock',
    model: 'mock',
    status: 'ok',
    detail: 'test',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('M6 Phase 3 teacher agent audit', () => {
  it('lists judgments and divergences and counts unresolved divergence in needsReview', async () => {
    const config = await loadAllConfig(process.cwd());
    const session = withAgentDivergence(importSession(await readFile(fixturePath, 'utf8')));
    const report = buildTeacherStudentReport(session, config);

    expect(report.agentAudit.judgments).toEqual([
      expect.objectContaining({
        eventId: 'teacher-agent-judgment',
        nodeId: 'P4',
        verdict: 'hit',
      }),
    ]);
    expect(report.agentAudit.divergences).toEqual([
      expect.objectContaining({
        eventId: 'teacher-agent-divergence',
        nodeId: 'P4',
        status: 'detected',
        unresolved: true,
      }),
    ]);
    expect(report.needsReview).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'divergence',
        nodeId: 'P4',
        agentVerdict: 'hit',
        shadowVerdict: 'miss',
      }),
    ]));
    expect(report.agentEventChain.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        'a-assessment-p4',
        'teacher-agent-turn',
        'teacher-agent-judgment',
        'teacher-agent-divergence',
      ]),
    );

    new LocalSessionStore(window.localStorage).save(session);
    const runtime = {
      loadConfig: vi.fn(async () => config),
      assessChoice: vi.fn(),
      extractAssessment: vi.fn(),
      assessEquation: vi.fn(),
      tutorTurn: vi.fn(),
      reviewDrawing: vi.fn(),
    } as unknown as AppRuntime;
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '双轨判断与分歧审计' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent 相关事件链' }))
      .toBeInTheDocument();
    expect(screen.getAllByText('原始事件').length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText('审计轨只留痕，不改写主记录轨')).toBeInTheDocument();
    expect(screen.getByText('学生已经说明电子从负极流向正极。')).toBeInTheDocument();
    expect(screen.getAllByText('Agent 命中 · 判分引擎 未命中')).toHaveLength(2);
    expect(screen.getByLabelText('1 条双轨分歧待复核')).toBeInTheDocument();
  });
});
