import { describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { scoreEquation } from '../shared/chemistry/equation';
import { buildLearnerProfile } from '../shared/scoring/profile';
import {
  evaluateExtractedFacts,
  type ExtractedAssessmentFacts,
} from '../shared/scoring/policy';
import { resolveRubricDecision } from '../shared/scoring/rubric';
import { evaluateCasePass, nextScaffoldLevel } from '../shared/scoring/scaffold';
import { assessBuilderTopology, type BuilderGraph } from '../shared/scoring/topology';
import {
  appendSessionEvent,
  createSession,
  sessionConfigVersions,
  type StudentSession,
} from '../shared/session';
import { structuredAssessmentResponseSchema } from '../shared/workflows/assessment';

const completeFacts: ExtractedAssessmentFacts = {
  response: 'substantive',
  verified: {
    colloquial: false,
    beyondSyllabus: false,
    contradiction: false,
    typo: 'none',
  },
  slots: [{ id: 'electron-from', value: 'Zn' }],
};

const oneRequirement = [{ id: 'electron-from', acceptedValues: ['Zn'] }];

function evaluateFacts(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  input: Omit<Parameters<typeof evaluateExtractedFacts>[0], 'aliases' | 'commonTypos'>,
) {
  return evaluateExtractedFacts({
    ...input,
    aliases: config.scaffoldPolicy.extraction.factValueAliases,
    commonTypos: config.scaffoldPolicy.extraction.citation.commonTypos,
  });
}

function fullBuilderGraph(): BuilderGraph {
  return {
    components: [
      { instanceId: 'negative', componentId: 'site-a', assignedRole: 'oxidation-site' },
      { instanceId: 'wire', componentId: 'electron-link', assignedRole: 'electron-conductor' },
      { instanceId: 'ions', componentId: 'ion-medium', assignedRole: 'ion-conductor' },
      { instanceId: 'positive', componentId: 'site-b', assignedRole: 'reduction-site' },
      { instanceId: 'electron-arrow', componentId: 'electron-arrow' },
      { instanceId: 'cation-arrow', componentId: 'cation-arrow' },
      { instanceId: 'anion-arrow', componentId: 'anion-arrow' },
    ],
    connections: [
      { id: 'e1', from: 'negative', to: 'wire', kind: 'electron-path', carrier: 'electron' },
      { id: 'e2', from: 'wire', to: 'positive', kind: 'electron-path', carrier: 'electron' },
      { id: 'i1', from: 'ions', to: 'positive', kind: 'ion-path', carrier: 'cation' },
      { id: 'i2', from: 'ions', to: 'negative', kind: 'ion-path', carrier: 'anion' },
    ],
  };
}

async function sessionWithScores(
  entries: Array<{ nodeId: string; outcome: 'hit' | 'partial' | 'miss' }>,
) {
  const config = await loadAllConfig(process.cwd());
  let session: StudentSession = createSession({
    id: 'session-policy-contract',
    anonymousStudentId: 'anon-A1B2C3D4',
    now: '2026-07-15T12:00:00.000Z',
    configVersions: sessionConfigVersions(config),
  });
  entries.forEach((entry, index) => {
    const answer = `evidence-${index}`;
    const answerId = `answer-${index}`;
    const stageId = `policy-${index}`;
    const attemptId = `attempt-${index}`;
    session = appendSessionEvent(session, {
      id: answerId,
      occurredAt: `2026-07-15T12:${String(index + 1).padStart(2, '0')}:00.000Z`,
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
      occurredAt: `2026-07-15T12:${String(index + 1).padStart(2, '0')}:01.000Z`,
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
          promptId: 'policy-contract',
          promptVersion: 'prompt.v2',
          cacheKey: `cache-${index}`,
        },
      },
      ...decision,
    });
  });
  return { config, session };
}

describe('runtime adjudication policy contracts', () => {
  it('keeps outcome fields out of the structured extraction contract', () => {
    const extraction = {
      anchors: [],
      assessments: [{
        nodeId: 'P4',
        errorIds: [],
        facts: {
          response: 'substantive',
          terminology: 'model',
          syllabus: 'within',
          contradiction: false,
          typo: 'none',
          slots: completeFacts.slots.map((slot) => ({
            ...slot,
            evidence: { quote: slot.value, start: 0, end: slot.value.length },
          })),
        },
        evidence: [{ quote: 'Zn', start: 0, end: 2 }],
        assistance: { kind: 'none', rounds: 0 },
      }],
    };

    expect(structuredAssessmentResponseSchema.safeParse(extraction).success).toBe(true);
    expect(structuredAssessmentResponseSchema.safeParse({
      ...extraction,
      assessments: [{ ...extraction.assessments[0], logicalOutcome: 'hit' }],
    }).success).toBe(false);
    expect(structuredAssessmentResponseSchema.safeParse({
      ...extraction,
      assessments: [{ ...extraction.assessments[0], following: { logicalChainConsistent: true } }],
    }).success).toBe(false);
  });

  it('§1: changing outcomeScale.mode changes incomplete-fact behavior', async () => {
    const config = await loadAllConfig(process.cwd());
    const requirements = [...oneRequirement, { id: 'electron-to', acceptedValues: ['Cu'] }];
    expect(evaluateFacts(config, { facts: completeFacts, requirements, policy: config.rubrics.policy }).status)
      .toBe('partial');
    const changed = structuredClone(config.rubrics.policy);
    changed.outcomeScale.mode = 'two-state';
    expect(evaluateFacts(config, { facts: completeFacts, requirements, policy: changed }).status)
      .toBe('miss');
  });

  it.each([
    {
      label: 'configured Chinese alias',
      value: '锌极',
      status: 'hit',
      matchedRequirementIds: ['electron-from'],
      missingRequirementIds: [],
    },
    {
      label: 'unconfigured Chinese value',
      value: '银极',
      status: 'miss',
      matchedRequirementIds: [],
      missingRequirementIds: ['electron-from'],
    },
    {
      label: 'configured alias with extra text',
      value: '锌极错误',
      status: 'miss',
      matchedRequirementIds: [],
      missingRequirementIds: ['electron-from'],
    },
    {
      label: 'canonical value',
      value: 'Zn',
      status: 'hit',
      matchedRequirementIds: ['electron-from'],
      missingRequirementIds: [],
    },
  ])('matches fact requirements conservatively for a $label', async ({
    value,
    status,
    matchedRequirementIds,
    missingRequirementIds,
  }) => {
    const config = await loadAllConfig(process.cwd());

    expect(evaluateFacts(config, {
      facts: {
        ...completeFacts,
        slots: [{ id: 'electron-from', value }],
      },
      requirements: oneRequirement,
      policy: config.rubrics.policy,
    })).toMatchObject({ status, matchedRequirementIds, missingRequirementIds });
  });

  it('§2: changing followingError.strategy changes downstream credit', async () => {
    const config = await loadAllConfig(process.cwd());
    const input = {
      nodeId: 'P4',
      logicalOutcome: 'hit' as const,
      objectiveOutcome: 'miss' as const,
      following: {
        anchorId: 'case-polarity',
        anchorOutcome: 'miss' as const,
        logicalChainConsistent: true,
      },
      assistance: { kind: 'none' as const, rounds: 0 },
    };
    expect(resolveRubricDecision({ ...input, rubrics: config.rubrics }).ruleDecision.status).toBe('hit');
    const changed = structuredClone(config.rubrics);
    changed.policy.followingError.strategy = 'score-objective-fact';
    expect(resolveRubricDecision({ ...input, rubrics: changed }).ruleDecision.status).toBe('miss');
  });

  it('§3: changing terminology.colloquialCorrectOutcome changes colloquial credit', async () => {
    const config = await loadAllConfig(process.cwd());
    const facts = {
      ...completeFacts,
      verified: { ...completeFacts.verified, colloquial: true },
    };
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: config.rubrics.policy }).status)
      .toBe('hit');
    const changed = structuredClone(config.rubrics.policy);
    changed.terminology.colloquialCorrectOutcome = 'partial';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: changed }).status)
      .toBe('partial');
    const strictTerms = structuredClone(config.rubrics.policy);
    strictTerms.terminology.requireModelTermsForHit = true;
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: strictTerms }).status)
      .toBe('partial');
  });

  it('§4: changing beyondSyllabus.correctOutcome changes correct beyond-syllabus credit', async () => {
    const config = await loadAllConfig(process.cwd());
    const facts = {
      ...completeFacts,
      verified: { ...completeFacts.verified, beyondSyllabus: true },
    };
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: config.rubrics.policy }).status)
      .toBe('hit');
    const changed = structuredClone(config.rubrics.policy);
    changed.beyondSyllabus.correctOutcome = 'partial';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: changed }).status)
      .toBe('partial');
  });

  it('§5: changing contradiction.outcome changes contradictory-answer behavior', async () => {
    const config = await loadAllConfig(process.cwd());
    const facts = {
      ...completeFacts,
      verified: { ...completeFacts.verified, contradiction: true },
    };
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: config.rubrics.policy }).status)
      .toBe('miss');
    const changed = structuredClone(config.rubrics.policy);
    changed.contradiction.outcome = 'partial';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: changed }).status)
      .toBe('partial');
  });

  it('§6: changing nonResponse.status changes blank-answer classification', async () => {
    const config = await loadAllConfig(process.cwd());
    const facts = { ...completeFacts, response: 'blank' as const, slots: [] };
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: config.rubrics.policy }).status)
      .toBe('unanswered');
    const changed = structuredClone(config.rubrics.policy);
    changed.nonResponse.status = 'miss';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: changed }).status)
      .toBe('miss');
  });

  it('§7: changing typos.unambiguousStrategy changes typo behavior', async () => {
    const config = await loadAllConfig(process.cwd());
    const facts = {
      ...completeFacts,
      verified: { ...completeFacts.verified, typo: 'unambiguous' as const },
    };
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: config.rubrics.policy }))
      .toMatchObject({ status: 'hit', warnings: ['unambiguous-typo'] });
    const changed = structuredClone(config.rubrics.policy);
    changed.typos.unambiguousStrategy = 'penalize';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: changed }).status)
      .toBe('partial');
    const ignored = structuredClone(config.rubrics.policy);
    ignored.typos.unambiguousStrategy = 'ignore';
    expect(evaluateFacts(config, { facts, requirements: oneRequirement, policy: ignored }))
      .toMatchObject({ status: 'hit', warnings: [] });
  });

  it('§8: changing equation.mediumMismatchOutcome changes cross-medium scoring', async () => {
    const config = await loadAllConfig(process.cwd());
    const expected = config.cases.find((entry) => entry.id === 'aluminum-air')!.equationSets
      .find((entry) => entry.id === 'oxygen-positive')!;
    const source = 'O2 + 4H^+ + 4e^- -> 2H2O';
    expect(scoreEquation(source, expected, config.rubrics.policy).outcome).toBe('partial');
    const changed = structuredClone(config.rubrics.policy);
    changed.equation.mediumMismatchOutcome = 'miss';
    expect(scoreEquation(source, expected, changed).outcome).toBe('miss');
  });

  it('§9: changing equation.acceptEqualsSign changes notation acceptance', async () => {
    const config = await loadAllConfig(process.cwd());
    const expected = config.cases.find((entry) => entry.id === 'zinc-copper')!.equationSets
      .find((entry) => entry.id === 'copper-positive')!;
    const source = 'Cu^2+ + 2e^- = Cu';
    expect(scoreEquation(source, expected, config.rubrics.policy).outcome).toBe('hit');
    const changed = structuredClone(config.rubrics.policy);
    changed.equation.acceptEqualsSign = false;
    expect(scoreEquation(source, expected, changed).outcome).toBe('miss');
  });

  it('§10: changing weighting.dimensionMode changes cross-dimension aggregation', async () => {
    const { config, session } = await sessionWithScores([
      { nodeId: 'D1', outcome: 'hit' },
      { nodeId: 'D2', outcome: 'hit' },
      { nodeId: 'E3', outcome: 'miss' },
    ]);
    expect(buildLearnerProfile(session, config).overallRatio).toBe(0.5);
    const changed = structuredClone(config);
    changed.rubrics.policy.weighting.dimensionMode = 'node-weighted';
    expect(buildLearnerProfile(session, changed).overallRatio).toBe(0.75);
  });

  it('§11: changing weakness.threshold changes weak classification', async () => {
    const { config, session } = await sessionWithScores([
      { nodeId: 'P4', outcome: 'hit' },
      { nodeId: 'P5', outcome: 'hit' },
      { nodeId: 'P2', outcome: 'miss' },
    ]);
    const threshold60 = structuredClone(config);
    threshold60.rubrics.policy.weakness.threshold = 0.60;
    const threshold61 = structuredClone(config);
    threshold61.rubrics.policy.weakness.threshold = 0.61;
    const at60 = buildLearnerProfile(session, threshold60).dimensions
      .find((dimension) => dimension.dimensionId === 'principle')!;
    const at61 = buildLearnerProfile(session, threshold61).dimensions
      .find((dimension) => dimension.dimensionId === 'principle')!;

    expect(at60).toMatchObject({ ratio: 0.6, level: 'developing', weak: false });
    expect(at61).toMatchObject({ ratio: 0.6, level: 'weak', weak: true });
  });

  it('§12: changing repeatedAnswers.strategy changes selected completed mastery', async () => {
    const { config, session } = await sessionWithScores([
      { nodeId: 'P4', outcome: 'miss' },
      { nodeId: 'P4', outcome: 'hit' },
    ]);
    expect(buildLearnerProfile(session, config).nodes.find((node) => node.nodeId === 'P4')?.outcome)
      .toBe('hit');
    const changed = structuredClone(config);
    changed.rubrics.policy.repeatedAnswers.strategy = 'worst';
    expect(buildLearnerProfile(session, changed).nodes.find((node) => node.nodeId === 'P4')?.outcome)
      .toBe('miss');
  });

  it('§13: changing promotion.consecutiveHits changes scaffold promotion', async () => {
    const config = await loadAllConfig(process.cwd());
    const scores = [
      { outcome: 'hit' as const, earned: 1, possible: 1, assistance: { kind: 'none' as const, rounds: 0 } },
      { outcome: 'hit' as const, earned: 1, possible: 1, assistance: { kind: 'none' as const, rounds: 0 } },
    ];
    expect(nextScaffoldLevel(1, scores, config.scaffoldPolicy).action).toBe('promote');
    const changed = structuredClone(config.scaffoldPolicy);
    changed.promotion.consecutiveHits = 3;
    expect(nextScaffoldLevel(1, scores, changed).action).toBe('stay');
  });

  it('§14: changing passing.minimumRatio changes case progression', async () => {
    const config = await loadAllConfig(process.cwd());
    const trainingCase = structuredClone(config.cases.find((entry) => entry.id === 'zinc-copper')!);
    trainingCase.targetNodeIds = ['P2', 'P3'];
    const scores = [
      { nodeId: 'P2', earned: 2, possible: 2, outcome: 'hit' as const, assistance: { kind: 'none' as const, rounds: 0 } },
      { nodeId: 'P3', earned: 1, possible: 2, outcome: 'partial' as const, assistance: { kind: 'none' as const, rounds: 0 } },
    ];
    expect(evaluateCasePass(scores, trainingCase, config.knowledgeModel, config.rubrics, config.scaffoldPolicy).passed)
      .toBe(true);
    const changed = structuredClone(config.scaffoldPolicy);
    changed.passing.minimumRatio = 0.8;
    expect(evaluateCasePass(scores, trainingCase, config.knowledgeModel, config.rubrics, changed).passed)
      .toBe(false);
  });

  it('§15: preset hints read assistance.correctOutcome, not the distinct Socratic value', async () => {
    const config = await loadAllConfig(process.cwd());
    const distinct = structuredClone(config.scaffoldPolicy);
    distinct.assistance.correctOutcome = 'hit';
    distinct.socratic.correctedOutcome = 'hit-with-help';
    const base = {
      rubrics: config.rubrics,
      nodeId: 'P4',
      objectiveOutcome: 'hit' as const,
      assistance: { kind: 'hint' as const, rounds: 1 },
    };
    expect(resolveRubricDecision({ ...base, scaffoldPolicy: distinct }).ruleDecision.status).toBe('hit');
    expect(resolveRubricDecision({
      ...base,
      assistance: { kind: 'socratic', rounds: 1 },
      scaffoldPolicy: distinct,
    }).ruleDecision.status).toBe('hit-with-help');
  });

  it('§16: Socratic correction reads correctedOutcome, not the distinct preset-hint value', async () => {
    const config = await loadAllConfig(process.cwd());
    const distinct = structuredClone(config.scaffoldPolicy);
    distinct.assistance.correctOutcome = 'hit';
    distinct.socratic.correctedOutcome = 'hit-with-help';
    const base = {
      rubrics: config.rubrics,
      nodeId: 'P4',
      objectiveOutcome: 'hit' as const,
      assistance: { kind: 'socratic' as const, rounds: 2 },
    };
    expect(resolveRubricDecision({ ...base, scaffoldPolicy: distinct }).ruleDecision.status)
      .toBe('hit-with-help');
    const changed = structuredClone(distinct);
    changed.socratic.correctedOutcome = 'hit';
    expect(resolveRubricDecision({ ...base, scaffoldPolicy: changed }).ruleDecision.status).toBe('hit');
  });

  it('§17: changing spontaneousRedox assignment changes the P1 profile dimension', async () => {
    const { config, session } = await sessionWithScores([]);
    expect(buildLearnerProfile(session, config).nodes.find((node) => node.nodeId === 'P1')?.dimensionId)
      .toBe('principle');
    const changed = structuredClone(config);
    changed.rubrics.policy.dimensionAssignments.spontaneousRedox = 'energy';
    expect(buildLearnerProfile(session, changed).nodes.find((node) => node.nodeId === 'P1')?.dimensionId)
      .toBe('energy');
  });

  it('§18: changing saltBridge assignment changes the emitted concept-node mapping', async () => {
    const { config, session } = await sessionWithScores([]);
    expect(buildLearnerProfile(session, config).conceptAssignments.saltBridgeNodeId).toBe('D3');
    const changed = structuredClone(config);
    changed.rubrics.policy.dimensionAssignments.saltBridge = 'D2';
    expect(buildLearnerProfile(session, changed).conceptAssignments.saltBridgeNodeId).toBe('D2');
  });

  it('§18b: changing siteReactantDistinction moves D5 out of the device axis', async () => {
    const { config, session } = await sessionWithScores([]);
    expect(buildLearnerProfile(session, config).crossAxisNodeIds).toEqual(['D5']);
    const changed = structuredClone(config);
    changed.rubrics.policy.dimensionAssignments.siteReactantDistinction = 'principle-only';
    const profile = buildLearnerProfile(session, changed);
    expect(profile.crossAxisNodeIds).toEqual([]);
    expect(profile.nodes.find((node) => node.nodeId === 'D5')?.dimensionId).toBe('principle');
  });

  it('§18c: changing the P5 node override changes its aggregation weight', async () => {
    const { config, session } = await sessionWithScores([]);
    expect(buildLearnerProfile(session, config).nodes.find((node) => node.nodeId === 'P5')?.weight).toBe(1);
    const changed = structuredClone(config);
    changed.rubrics.policy.weighting.nodeOverrides.P5 = 2;
    expect(buildLearnerProfile(session, changed).nodes.find((node) => node.nodeId === 'P5')?.weight).toBe(2);
  });

  it('§19: changing saltBridgeRequired changes the circuit result', async () => {
    const config = await loadAllConfig(process.cwd());
    expect(assessBuilderTopology(fullBuilderGraph(), config.pretest.builder).checks.closedCircuit.status)
      .toBe('hit');
    const changed = structuredClone(config.pretest.builder);
    changed.assessment.generalModel.saltBridgeRequired = true;
    expect(assessBuilderTopology(fullBuilderGraph(), changed).checks.closedCircuit.status).toBe('miss');
  });

  it('§19b: changing concreteBindingOutcome changes structured-binding assessment', async () => {
    const config = await loadAllConfig(process.cwd());
    const graph = fullBuilderGraph();
    graph.components[0].materialBinding = { materialId: 'Zn', specificity: 'specific' };
    expect(assessBuilderTopology(graph, config.pretest.builder).checks.abstraction.status).toBe('partial');
    const changed = structuredClone(config.pretest.builder);
    changed.assessment.abstraction.concreteBindingOutcome = 'miss';
    expect(assessBuilderTopology(graph, changed).checks.abstraction.status).toBe('miss');
  });

  it('§20: changing presentation.studentRadar changes the presentation payload', async () => {
    const { config, session } = await sessionWithScores([{ nodeId: 'P4', outcome: 'hit' }]);
    expect(buildLearnerProfile(session, config).presentation.studentRadar[1])
      .toHaveProperty('score');
    const changed = structuredClone(config);
    changed.rubrics.policy.presentation.studentRadar = 'level';
    const item = buildLearnerProfile(session, changed).presentation.studentRadar[1];
    expect(item).toHaveProperty('level');
    expect(item).not.toHaveProperty('score');
  });
});
