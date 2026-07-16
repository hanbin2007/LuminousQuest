import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
} from '../shared/session/session';
import type { StudentSession } from '../shared/session/schema';
import { buildModelScene } from '../src/features/model/lighting';

async function sceneWith(entries: Array<{ nodeId: string; outcome: 'hit' | 'partial' | 'miss' }>) {
  const config = await loadAllConfig(process.cwd());
  let session: StudentSession = createSession({
    id: 'session-model-lighting',
    anonymousStudentId: 'anon-3D3D3D3D',
    now: '2026-07-16T09:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  entries.forEach((entry, index) => {
    const answer = `作答证据-${index}`;
    const answerId = `answer-${index}`;
    const stageId = `model-${index}`;
    const attemptId = `attempt-${index}`;
    session = appendSessionEvent(session, {
      id: answerId,
      occurredAt: `2026-07-16T09:${String(index + 1).padStart(2, '0')}:00.000Z`,
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: 'zinc-copper',
      stageId,
      attemptId,
      questionId: `question-${index}`,
      answer: { format: 'text', value: answer },
    });
    const rubric = config.rubrics.rubrics.find((item) => item.nodeId === entry.nodeId)!;
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      scaffoldPolicy: config.scaffoldPolicy,
      nodeId: entry.nodeId,
      objectiveOutcome: entry.outcome,
      assistance: { kind: 'none', rounds: 0 },
    });
    session = appendSessionEvent(session, {
      id: `assessment-${index}`,
      occurredAt: `2026-07-16T09:${String(index + 1).padStart(2, '0')}:01.000Z`,
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId,
      attemptId,
      sourceAnswerEventId: answerId,
      nodeId: entry.nodeId,
      rubric: { id: rubric.id, version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'fact-policy',
        provenance: {
          promptId: 'model-lighting',
          promptVersion: 'prompt.v2',
          cacheKey: `cache-${index}`,
        },
      },
      ...decision,
    });
  });
  return buildModelScene(session, config);
}

describe('module 3 model scene lighting', () => {
  it('maps grading outcomes to lighting states and keeps unassessed distinct from miss', async () => {
    const scene = await sceneWith([
      { nodeId: 'D1', outcome: 'hit' },
      { nodeId: 'P4', outcome: 'partial' },
      { nodeId: 'E1', outcome: 'miss' },
    ]);
    const byId = new Map(scene.nodes.map((node) => [node.id, node]));

    expect(byId.get('D1')?.light).toBe('full-lit');
    expect(['half-lit', 'dark']).toContain(byId.get('P4')?.light); // partial 可视化随裁量 §11
    expect(byId.get('E1')?.light).toBe('dark');
    expect(byId.get('P6')?.light).toBe('unassessed');
    expect(byId.get('E1')?.light).not.toBe(byId.get('P6')?.light);
    expect(scene.totalCount).toBe(15);
  });

  it('orders ignition by assessment sequence and exposes cross-axis D5 edges', async () => {
    const scene = await sceneWith([
      { nodeId: 'P2', outcome: 'hit' },
      { nodeId: 'D5', outcome: 'hit' },
      { nodeId: 'D1', outcome: 'hit' },
    ]);
    const litOrder = scene.nodes
      .filter((node) => node.ignitionIndex !== null)
      .sort((a, b) => a.ignitionIndex! - b.ignitionIndex!)
      .map((node) => node.id);
    expect(litOrder).toEqual(['P2', 'D5', 'D1']);

    const crossEdge = scene.edges.find((edge) => edge.from === 'D5' && edge.to === 'P2');
    expect(crossEdge).toBeDefined();
    expect(crossEdge?.crossAxis).toBe(true);
    expect(crossEdge?.bothLit).toBe(true);

    expect(scene.radar).toHaveLength(3);
    expect(scene.radar.map((entry) => entry.id)).toEqual(['device', 'principle', 'energy']);
    expect(scene.radar.find((entry) => entry.id === 'energy')?.value).toBeNull();
  });
});
