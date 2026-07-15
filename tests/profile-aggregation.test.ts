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

async function scoredFixture() {
  const { config, session } = await fixture();
  const answer = '电子从锌极经导线流向铜极。';
  const answered = appendSessionEvent(session, answerEvent('answer-trace', 'attempt-trace', answer));
  const decision = resolveRubricDecision({
    rubrics: config.rubrics,
    nodeId: 'P4',
    logicalOutcome: 'hit',
    objectiveOutcome: 'hit',
    assistance: 'none',
  });
  const assessed = appendSessionEvent(answered, {
    id: 'assessment-trace',
    occurredAt: '2026-07-15T12:01:01.000Z',
    kind: 'assessment.completed',
    pipelineStage: 'score',
    caseId: 'zinc-copper',
    stageId: 'analysis',
    attemptId: 'attempt-trace',
    sourceAnswerEventId: 'answer-trace',
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
  return { config, assessed };
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

  it('fails closed when a node rubric or requested outcome rule is missing', async () => {
    const { config } = await fixture();
    const missingRubric = structuredClone(config.rubrics);
    missingRubric.rubrics = missingRubric.rubrics.filter((rubric) => rubric.nodeId !== 'P2');
    expect(() => resolveRubricDecision({
      rubrics: missingRubric,
      nodeId: 'P2',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    })).toThrow(/No rubric/);

    const missingRule = structuredClone(config.rubrics);
    const p2 = missingRule.rubrics.find((rubric) => rubric.nodeId === 'P2')!;
    p2.rules = p2.rules.filter((rule) => rule.outcome !== 'hit');
    expect(() => resolveRubricDecision({
      rubrics: missingRule,
      nodeId: 'P2',
      logicalOutcome: 'hit',
      objectiveOutcome: 'hit',
      assistance: 'none',
    })).toThrow(/has no hit rule/);
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

  it('rejects knowledge-model and rubric version drift before aggregation', async () => {
    const { config, session } = await fixture();
    const changedKnowledge = structuredClone(config.knowledgeModel);
    changedKnowledge.version = 'knowledge-model.v2';
    const changedRubrics = structuredClone(config.rubrics);
    changedRubrics.version = 'rubrics.v2';

    expect(() => buildLearnerProfile(session, changedKnowledge, config.rubrics))
      .toThrow(/knowledge model version/);
    expect(() => buildLearnerProfile(session, config.knowledgeModel, changedRubrics))
      .toThrow(/rubric version/);
  });

  it('keeps provider-review events out of radar scoring and marks the node for review', async () => {
    const { config, session } = await fixture();
    const answered = appendSessionEvent(
      session,
      answerEvent('answer-review', 'attempt-review', '表述不清'),
    );
    const pending = appendSessionEvent(answered, {
      id: 'assessment-review',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'extraction',
      caseId: 'zinc-copper',
      stageId: 'analysis',
      attemptId: 'attempt-review',
      sourceAnswerEventId: 'answer-review',
      nodeId: 'P4',
      rubric: { id: 'rubric-p4', version: config.rubrics.version },
      extraction: {
        status: 'needs-review',
        reason: 'ambiguous extraction',
        model: 'mock-v1',
        provenance: provenance(),
      },
      ruleDecision: { status: 'unassessed', reason: 'awaiting extraction' },
      following: { status: 'unassessed' },
      score: { status: 'unassessed' },
    });

    const profile = buildLearnerProfile(pending, config.knowledgeModel, config.rubrics);
    expect(profile.nodes.find((node) => node.nodeId === 'P4')?.status).toBe('needs-review');
    expect(profile.dimensions.find((entry) => entry.dimensionId === 'principle'))
      .toMatchObject({ ratio: null, needsReviewNodeIds: ['P4'] });
  });

  it('fails closed for tampered rubric, rule, and persisted score traces', async () => {
    const { config, assessed } = await scoredFixture();
    const tamper = (update: (event: Extract<(typeof assessed.events)[number], { kind: 'assessment.completed' }>) => void) => {
      const copy = structuredClone(assessed);
      const event = copy.events.find((entry) => entry.kind === 'assessment.completed')!;
      update(event);
      return copy;
    };

    expect(() => buildLearnerProfile(
      tamper((event) => { event.rubric.id = 'rubric-p3'; }),
      config.knowledgeModel,
      config.rubrics,
    )).toThrow(/Rubric trace/);
    expect(() => buildLearnerProfile(
      tamper((event) => {
        if ('ruleId' in event.ruleDecision) event.ruleDecision.ruleId = 'p4-miss';
      }),
      config.knowledgeModel,
      config.rubrics,
    )).toThrow(/Rubric rule trace/);
    expect(() => buildLearnerProfile(
      tamper((event) => {
        if (event.score.status === 'scored') event.score.earned = 1;
      }),
      config.knowledgeModel,
      config.rubrics,
    )).toThrow(/Persisted score/);
  });

  it('preserves the original serialized builder answer in a score trace', async () => {
    const { config, session } = await fixture();
    const value = {
      components: [{ instanceId: 'negative', componentId: 'site-a', x: 0, y: 0 }],
      connections: [],
    };
    const serialized = JSON.stringify(value);
    const quote = '"componentId":"site-a"';
    let current = appendSessionEvent(session, {
      id: 'answer-builder',
      occurredAt: '2026-07-15T12:01:00.000Z',
      kind: 'answer.submitted',
      pipelineStage: 'answer',
      caseId: 'zinc-copper',
      stageId: 'builder',
      attemptId: 'attempt-builder',
      questionId: 'builder-model',
      answer: { format: 'builder', value },
    });
    const decision = resolveRubricDecision({
      rubrics: config.rubrics,
      nodeId: 'D1',
      logicalOutcome: 'partial',
      objectiveOutcome: 'partial',
      assistance: 'none',
    });
    current = appendSessionEvent(current, {
      id: 'assessment-builder',
      occurredAt: '2026-07-15T12:01:01.000Z',
      kind: 'assessment.completed',
      pipelineStage: 'score',
      caseId: 'zinc-copper',
      stageId: 'builder',
      attemptId: 'attempt-builder',
      sourceAnswerEventId: 'answer-builder',
      nodeId: 'D1',
      rubric: { id: 'rubric-d1', version: config.rubrics.version },
      extraction: {
        status: 'assessed',
        evidence: [{ quote, start: serialized.indexOf(quote), end: serialized.indexOf(quote) + quote.length }],
        model: 'topology.v1',
        provenance: provenance(),
      },
      ...decision,
    });

    expect(buildLearnerProfile(current, config.knowledgeModel, config.rubrics)
      .nodes.find((node) => node.nodeId === 'D1')?.trace?.originalAnswer).toBe(serialized);
  });
});
