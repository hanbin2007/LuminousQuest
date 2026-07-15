import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import {
  appendSessionEvent,
  createSession,
  exportSession,
  importSession,
  sessionSchema,
  type SessionEventInput,
} from '../shared/session';
import { buildLearnerProfile } from '../shared/scoring/profile';
import { resolveRubricDecision } from '../shared/scoring/rubric';

const now = '2026-07-15T12:00:00.000Z';

function provenance() {
  return {
    promptId: 'structured-assessment',
    promptVersion: 'sha256:prompt',
    cacheKey: 'sha256:cache',
  };
}

async function fixture() {
  const config = await loadAllConfig(process.cwd());
  const session = createSession({
    id: 'session-profile',
    anonymousStudentId: 'anon-A1B2C3D4',
    now,
    configVersions: {
      knowledgeModel: config.knowledgeModel.version,
      rubrics: config.rubrics.version,
      pretest: config.pretest.version,
      scaffoldPolicy: config.scaffoldPolicy.version,
    },
  });
  return { config, session };
}

function answerEvent(id: string, attemptId: string, answer: string): SessionEventInput {
  return {
    id,
    occurredAt: '2026-07-15T12:01:00.000Z',
    kind: 'answer.submitted',
    pipelineStage: 'answer',
    caseId: 'zinc-copper',
    stageId: 'analysis',
    attemptId,
    questionId: 'zinc-analysis',
    answer: { format: 'text', value: answer },
  };
}

describe('traceable rubric scoring and learner profile aggregation', () => {
  it('scores a following error by the coherent logical chain and persists the annotation', async () => {
    const { config } = await fixture();
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'miss',
      following: {
        anchorId: 'case-polarity',
        anchorOutcome: 'miss',
        logicalChainConsistent: true,
      },
      assistance: 'none',
    });

    expect(decision).toMatchObject({
      ruleDecision: { status: 'hit', ruleId: 'p4-hit' },
      following: {
        status: 'followed',
        anchorNodeId: 'case-polarity',
        anchorOutcome: 'miss',
        policy: 'score-logical-chain',
      },
      score: { status: 'scored', earned: 2, possible: 2, annotations: ['following'] },
    });
  });

  it('does not apply following credit when the downstream logic is inconsistent', async () => {
    const { config } = await fixture();
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'miss',
      following: {
        anchorId: 'case-polarity',
        anchorOutcome: 'miss',
        logicalChainConsistent: false,
      },
      assistance: 'none',
    });

    expect(decision).toMatchObject({
      ruleDecision: { status: 'miss', ruleId: 'p4-miss' },
      following: { status: 'not-followed' },
      score: { earned: 0, annotations: [] },
    });
  });

  it.each(['hint', 'socratic'] as const)('marks a correct %s-assisted answer as hit-with-help', async (assistance) => {
    const { config } = await fixture();
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P2',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance,
    });

    expect(decision.ruleDecision.status).toBe('hit');
    expect(decision.score).toMatchObject({ earned: 2, annotations: ['hit-with-help'] });
  });

  it('round-trips score to rubric rule to exact answer evidence and builds assessed-only radar values', async () => {
    const { config, session } = await fixture();
    const answer = '电子从锌极经导线流向铜极。';
    const quote = '电子从锌极经导线流向铜极';
    const answered = appendSessionEvent(session, answerEvent('answer-1', 'attempt-1', answer));
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    });
    const assessed = appendSessionEvent(answered, {
      id: 'assessment-1',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-1',
      sourceAnswerEventId: 'answer-1',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote, start: 0, end: quote.length }],
        model: 'mock-v1',
        provenance: provenance(),
      },
      ...decision,
    });

    const restored = importSession(exportSession(assessed));
    const profile = buildLearnerProfile(restored, config.knowledgeModel, config.rubrics);
    const p4 = profile.nodes.find((node) => node.nodeId === 'P4');

    expect(p4).toMatchObject({
      status: 'scored',
      outcome: 'hit',
      earned: 2,
      possible: 2,
      trace: {
        sourceAnswerEventId: 'answer-1',
        originalAnswer: answer,
        rubric: { id: 'rubric-p4', version: 'rubrics.v1' },
        ruleId: 'p4-hit',
        evidence: [{ quote, start: 0, end: quote.length }],
      },
    });
    expect(profile.dimensions.find((dimension) => dimension.dimensionId === 'principle')).toMatchObject({
      earned: 2,
      possible: 2,
      ratio: 1,
      assessedNodeIds: ['P4'],
    });
    expect(profile.dimensions.find((dimension) => dimension.dimensionId === 'device')?.ratio).toBeNull();
    expect(profile.nodes.filter((node) => node.status === 'unassessed')).toHaveLength(14);
  });

  it('uses the latest node score and excludes a later unassessed snapshot from the radar denominator', async () => {
    const { config, session } = await fixture();
    const answer = '电子从锌极经导线流向铜极。';
    let current = appendSessionEvent(session, answerEvent('answer-1', 'attempt-1', answer));
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    });
    current = appendSessionEvent(current, {
      id: 'assessment-1',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-1',
      sourceAnswerEventId: 'answer-1',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: answer, start: 0, end: answer.length }],
        model: 'mock-v1',
        provenance: provenance(),
      },
      ...decision,
    });
    current = appendSessionEvent(
      current,
      answerEvent('answer-2', 'attempt-2', ''),
    );
    current = appendSessionEvent(current, {
      id: 'assessment-2',
      occurredAt: '2026-07-15T12:02:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'extraction',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-2',
      sourceAnswerEventId: 'answer-2',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'unassessed',
        reason: 'empty answer',
        provenance: provenance(),
      },
      ruleDecision: { status: 'unassessed', reason: 'no evidence' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    });

    const profile = buildLearnerProfile(current, config.knowledgeModel, config.rubrics);
    const principle = profile.dimensions.find((dimension) => dimension.dimensionId === 'principle');

    expect(profile.nodes.find((node) => node.nodeId === 'P4')?.status).toBe('unassessed');
    expect(principle).toMatchObject({ earned: 0, possible: 0, ratio: null });
  });

  it('rejects a score event whose evidence quote cannot be traced to the original answer', async () => {
    const { config, session } = await fixture();
    const answer = '电子从锌极流向铜极。';
    const answered = appendSessionEvent(session, answerEvent('answer-1', 'attempt-1', answer));
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    });
    expect(() => appendSessionEvent(answered, {
      id: 'assessment-1',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-1',
      sourceAnswerEventId: 'answer-1',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: '电子经过盐桥', start: 0, end: 6 }],
        model: 'mock-v1',
        provenance: provenance(),
      },
      ...decision,
    })).toThrow(/evidence/i);
  });

  it('rejects contradictory following annotations in session v2', async () => {
    const { config } = await fixture();
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'P4',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    });
    const event = {
      schemaVersion: 'event.v2',
      id: 'assessment-invalid',
      sequence: 1,
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-1',
      sourceAnswerEventId: 'answer-1',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote: 'evidence', start: 0, end: 8 }],
        model: 'mock-v1',
        provenance: provenance(),
      },
      ...decision,
      following: {
        status: 'not-followed',
        anchorNodeId: null,
        anchorOutcome: null,
        policy: 'score-logical-chain',
      },
      score: { ...decision.score, annotations: ['following'] },
    };

    expect(sessionSchema.shape.events.element.safeParse(event).success).toBe(false);
  });
});
