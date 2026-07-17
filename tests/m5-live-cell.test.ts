import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import type { LoadedConfig } from '../shared/config/schemas';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';
import { buildLiveCellState, electrodeLabel } from '../src/features/model/live-cell';

function baseSession(config: LoadedConfig) {
  return createSession({
    id: 'live-cell-session',
    anonymousStudentId: 'anon-CELL0001',
    now: '2026-07-16T12:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
}

function withAssessment(
  session: StudentSession,
  config: LoadedConfig,
  input: { nodeId: string; outcome: 'hit' | 'partial' | 'miss'; caseId?: string; suffix?: string },
) {
  const caseId = input.caseId ?? 'zinc-copper';
  const key = `${caseId}-${input.nodeId}${input.suffix ?? ''}`;
  const answer = '电子从锌极流向铜极。';
  const withAnswer = appendSessionEvent(session, {
    id: `answer-${key}`,
    occurredAt: '2026-07-16T12:00:01.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId,
    stageId: 'training',
    attemptId: `attempt-${key}`,
    questionId: `question-${key}`,
    answer: { format: 'text', value: answer },
  });
  const rubric = config.rubrics.rubrics.find((entry) => entry.nodeId === input.nodeId)!;
  const decision = resolveRubricDecision({
    rubrics: config.rubrics,
    scaffoldPolicy: config.scaffoldPolicy,
    nodeId: input.nodeId,
    objectiveOutcome: input.outcome,
    assistance: { kind: 'none', rounds: 0 },
  });
  return appendSessionEvent(withAnswer, {
    id: `assessment-${key}`,
    occurredAt: '2026-07-16T12:00:02.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId,
    stageId: 'training',
    attemptId: `attempt-${key}`,
    sourceAnswerEventId: `answer-${key}`,
    nodeId: input.nodeId,
    rubric: { id: rubric.id, version: config.rubrics.version },
    objectiveOutcome: input.outcome,
    extraction: {
      status: 'assessed',
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      model: 'fixture-v1',
      provenance: {
        promptId: 'structured-assessment',
        promptVersion: 'prompt.v1',
        cacheKey: `cache-${key}`,
      },
    },
    ...decision,
  });
}

function withPolarity(
  session: StudentSession,
  input: {
    outcome: 'hit' | 'miss';
    sourceAnswerEventId: string;
    attemptId: string;
    caseId?: string;
    correctValue?: string;
  },
) {
  const caseId = input.caseId ?? 'zinc-copper';
  return appendSessionEvent(session, {
    id: `polarity-${caseId}-${input.outcome}`,
    occurredAt: '2026-07-16T12:00:03.000Z',
    kind: 'polarity.assessed',
    pipelineStage: 'rule',
    caseId,
    stageId: 'training',
    attemptId: input.attemptId,
    sourceAnswerEventId: input.sourceAnswerEventId,
    anchorId: 'case-polarity',
    facts: [{ id: 'negative', value: 'Zn', evidence: { quote: '锌极', start: 3, end: 5 } }],
    extractedValue: 'negative=Zn',
    correctValue: input.correctValue ?? 'negative=Zn;positive=Cu',
    outcome: input.outcome,
    evidence: [{ quote: '锌极', start: 3, end: 5 }],
    engine: { id: 'case-anchor-policy', version: 'rubric-policy.v2' },
  });
}

describe('live cell state derivation', () => {
  it('starts fully unassessed without leaking electrode identities', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    const state = buildLiveCellState(baseSession(config), config, trainingCase);

    expect(state.litCount).toBe(0);
    expect(state.totalCount).toBe(config.knowledgeModel.nodes.length);
    expect(state.nodes.every((node) => node.light === 'unassessed')).toBe(true);
    expect(state.polarityLit).toBe(false);
    expect(state.electrodes.negative.label).toBeNull();
    expect(state.electrodes.positive.label).toBeNull();
  });

  it('maps hit/partial/miss to full/half/dark and orders ignition by sequence', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    let session = baseSession(config);
    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'hit' });
    session = withAssessment(session, config, { nodeId: 'D1', outcome: 'partial' });
    session = withAssessment(session, config, { nodeId: 'P5', outcome: 'miss' });

    const state = buildLiveCellState(session, config, trainingCase);
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    expect(byId.get('P4')?.light).toBe('full-lit');
    expect(byId.get('D1')?.light).toBe('half-lit');
    expect(byId.get('P5')?.light).toBe('dark');
    expect(byId.get('E1')?.light).toBe('unassessed');
    expect(byId.get('P4')?.ignitionIndex).toBe(0);
    expect(byId.get('D1')?.ignitionIndex).toBe(1);
    expect(byId.get('P5')?.ignitionIndex).toBeNull();
    expect(state.litCount).toBe(2);
  });

  it('keeps the latest assessment per node and lights polarity from the anchor outcome', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    let session = baseSession(config);
    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'miss' });
    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'hit', suffix: '-retry' });
    session = withPolarity(session, {
      outcome: 'hit',
      sourceAnswerEventId: 'answer-zinc-copper-P4-retry',
      attemptId: 'attempt-zinc-copper-P4-retry',
    });

    const state = buildLiveCellState(session, config, trainingCase);
    expect(state.nodes.find((node) => node.id === 'P4')?.light).toBe('full-lit');
    expect(state.polarityLit).toBe(true);
    expect(state.electrodes.negative.label).toBe('锌');
    expect(state.electrodes.positive.label).toBe('铜');
  });

  it('never reveals electrode identities after a missed polarity judgement', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    let session = baseSession(config);
    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'miss' });
    session = withPolarity(session, {
      outcome: 'miss',
      sourceAnswerEventId: 'answer-zinc-copper-P4',
      attemptId: 'attempt-zinc-copper-P4',
    });

    const state = buildLiveCellState(session, config, trainingCase);
    expect(state.polarityLit).toBe(false);
    expect(state.electrodes.negative.label).toBeNull();
    expect(state.electrodes.positive.label).toBeNull();
  });

  it('ignores events from other cases and changes the signature when lights change', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = config.cases.find((entry) => entry.id === 'zinc-copper')!;
    let session = baseSession(config);
    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'hit', caseId: 'aluminum-air' });

    const before = buildLiveCellState(session, config, trainingCase);
    expect(before.litCount).toBe(0);

    session = withAssessment(session, config, { nodeId: 'P4', outcome: 'hit' });
    const after = buildLiveCellState(session, config, trainingCase);
    expect(after.litCount).toBe(1);
    expect(after.litSignature).not.toBe(before.litSignature);
  });

  it('binds electrode display labels per case once polarity is earned', async () => {
    const config = await loadAllConfig(process.cwd());
    const expectations: Record<string, [string, string]> = {
      'zinc-copper': ['锌', '铜'],
      'aluminum-air': ['铝', '多孔碳'],
      'hydrogen-oxygen': ['H₂ · Pt', 'O₂ · Pt'],
      'methane-fuel': ['CH₄ 侧', 'O₂ 侧'],
    };
    for (const trainingCase of config.cases) {
      let session = baseSession(config);
      session = withAssessment(session, config, { nodeId: 'P4', outcome: 'hit', caseId: trainingCase.id });
      session = withPolarity(session, {
        outcome: 'hit',
        caseId: trainingCase.id,
        correctValue: trainingCase.followingAnchors[0]!.correctValue,
        sourceAnswerEventId: `answer-${trainingCase.id}-P4`,
        attemptId: `attempt-${trainingCase.id}-P4`,
      });
      const state = buildLiveCellState(session, config, trainingCase);
      const [negative, positive] = expectations[trainingCase.id]!;
      expect(state.electrodes.negative.label).toBe(negative);
      expect(state.electrodes.positive.label).toBe(positive);
    }
    expect(electrodeLabel('unknown-token')).toBe('unknown-token');
  });
});
