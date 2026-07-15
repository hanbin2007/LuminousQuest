import { describe, expect, it } from 'vitest';

import { computeEvalMetrics } from '../eval/metrics';
import { generateMetamorphicVariants } from '../eval/metamorphic';
import {
  evalCaseSchema,
  evalConfigSchema,
  labeledEvalCaseSchema,
  type EvalObservation,
  type LabeledEvalCase,
} from '../eval/schema';

function labeledCase(overrides: Partial<LabeledEvalCase> = {}): LabeledEvalCase {
  return labeledEvalCaseSchema.parse({
    version: 'eval-case.v2',
    annotationStatus: 'labeled',
    id: 'zc-p4-reversed',
    questionRef: { caseId: 'zinc-copper', nodeId: 'P4' },
    studentAnswer: '小明认为电子由铜极流向锌极。',
    expectedExtraction: {
      anchors: [],
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      errorIds: ['P4-M1'],
      slots: [
        { id: 'electron-from', value: 'Cu', evidenceQuote: '铜极' },
        { id: 'electron-to', value: 'Zn', evidenceQuote: '锌极' },
      ],
      evidenceQuotes: ['电子由铜极流向锌极'],
    },
    expectedScore: 'miss',
    annotator: 'codex-synthetic-seed',
    reviewer: 'independent-reviewer',
    reviewStatus: 'reviewed',
    adjudicationVersion: 'adjudication-table.v1.1',
    rationale: {
      rubricRefs: ['p4-miss'],
      adjudicationRefs: ['§1'],
      text: 'P4 direction is reversed under the frozen rubric.',
    },
    expectedDisagreement: false,
    metamorphicReview: {
      reviewer: 'independent-reviewer',
      status: 'approved',
      variants: {
        paraphrase: { status: 'approved', rationale: 'Semantic paraphrase approved.' },
        noise: { status: 'approved', rationale: 'Irrelevant suffix approved.' },
        'rename-person': { status: 'approved', rationale: 'Person rename approved.' },
      },
    },
    rubricVersion: 'rubrics.v1.1',
    source: 'synthetic',
    misconceptionIds: ['P4-M1'],
    tags: ['reversed-direction'],
    seriousMisjudgmentOpportunity: true,
    ...overrides,
  });
}

function observation(input: Partial<EvalObservation> = {}): EvalObservation {
  return {
    caseId: 'zc-p4-reversed',
    nodeId: 'P4',
    variant: 'base',
    iteration: 1,
    expectedScore: 'miss',
    predictedScore: 'miss',
    expectedErrorIds: ['P4-M1'],
    predictedErrorIds: ['P4-M1'],
    errorIdsExact: true,
    extractionAttempted: true,
    extractionExact: true,
    resultSignature: 'miss:fixture',
    source: 'provider',
    latencyMs: 12,
    inputTokens: 10,
    outputTokens: 5,
    estimatedCostUsd: 0.00002,
    citationHallucination: false,
    schemaFailure: false,
    closedSetFailure: false,
    ...input,
  };
}

const config = evalConfigSchema.parse({
  version: 'eval-config.v2',
  defaultRuns: 3,
  thresholds: {
    nodeMacroAccuracy: 0.9,
    severeFalseMasteryRate: 0.02,
    citationHallucinationRate: 0.02,
    schemaFailureRate: 0.02,
    metamorphicInvariantRate: 0.9,
    scoreConsistencyRate: 0.95,
  },
  metamorphic: { enabled: true, variants: ['paraphrase', 'noise', 'rename-person'] },
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
  corpus: { stage: 'seed' },
  live: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    pilotCases: 5,
    minimumClosedSetComplianceRate: 0.95,
  },
});

describe('eval case and metric contracts', () => {
  it('keeps the 150/5/3 corpus gate outside configurable eval JSON', () => {
    expect(evalConfigSchema.safeParse({
      ...config,
      coverage: {
        minimumCases: 1,
        minimumCasesPerNode: 1,
        minimumCasesPerMisconception: 1,
      },
    }).success).toBe(false);
  });

  it('requires the complete labeled golden-case contract and allows pending imports', () => {
    expect(labeledCase().expectedExtraction.slots[0]).toEqual({
      id: 'electron-from',
      value: 'Cu',
      evidenceQuote: '铜极',
    });

    const invalid = {
      ...labeledCase(),
      expectedExtraction: { ...labeledCase().expectedExtraction, slots: undefined },
    };
    expect(evalCaseSchema.safeParse(invalid).success).toBe(false);

    expect(evalCaseSchema.parse({
      version: 'eval-case.v2',
      annotationStatus: 'pending',
      id: 'candidate-abc',
      questionRef: { caseId: 'zinc-copper', nodeId: 'P4' },
      studentAnswer: '电子从铜到锌。',
      expectedExtraction: null,
      expectedScore: null,
      annotator: null,
      rubricVersion: 'rubrics.v1.1',
      source: 'human',
      misconceptionIds: [],
      tags: ['imported-eval-candidate'],
      seriousMisjudgmentOpportunity: false,
      candidateImport: {
        stableHash: 'a'.repeat(64),
        originalCategory: 'citation-mismatch',
        currentCategory: 'normalization-insufficient',
        requiresHumanAudit: true,
        provenance: {
          configDigest: 'current-config',
          thresholds: {
            maxEditDistanceRatio: 0.12,
            normalizationCandidateMaxEditDistanceRatio: 0.35,
          },
          prompt: { id: 'structured-assessment', version: 'prompt.v2' },
          schemaVersion: 'structured-assessment.v4',
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      },
    }).annotationStatus).toBe('pending');
  });

  it('uses case count as the severe false-mastery denominator and emits all five outcomes', () => {
    const second = labeledCase({ id: 'zc-p4-second' });
    const observations = [
      observation({ predictedScore: 'hit', resultSignature: 'hit:first' }),
      observation({ iteration: 2 }),
      observation({ iteration: 3 }),
      observation({ caseId: second.id, predictedScore: 'partial', resultSignature: 'partial' }),
      observation({ caseId: second.id, iteration: 2, predictedScore: 'unanswered', resultSignature: 'unanswered' }),
      observation({ caseId: second.id, iteration: 3, predictedScore: 'needs-review', resultSignature: 'needs-review' }),
    ];

    const metrics = computeEvalMetrics({ cases: [labeledCase(), second], observations, config });

    expect(metrics.confusionMatrix.miss).toEqual({
      hit: 0,
      partial: 0,
      miss: 1,
      unanswered: 0,
      'needs-review': 1,
    });
    expect(metrics.severeFalseMastery).toMatchObject({
      numeratorCases: 0,
      denominatorCases: 2,
      rate: 0,
    });
    expect(metrics.schemaFailureRate).toBe(0);
    expect(metrics.tokenUsage).toMatchObject({ inputTokens: 60, outputTokens: 30 });
    expect(metrics.gates.find((gate) => gate.id === 'severe-false-mastery')).toMatchObject({
      passed: true,
      actual: 0,
    });
  });

  it('counts extraction failures as non-exact and reports expected, attempted, and exact side by side', () => {
    const observations = [
      observation(),
      observation({ iteration: 2, extractionExact: false }),
      observation({
        iteration: 3,
        extractionAttempted: false,
        extractionExact: false,
        predictedScore: 'needs-review',
      }),
    ];

    const metrics = computeEvalMetrics({ cases: [labeledCase()], observations, config });

    expect(metrics.extraction).toEqual({
      expected: 3,
      attempted: 2,
      exact: 1,
      attemptRate: 2 / 3,
      exactRate: 1 / 3,
    });
  });

  it('gates on all-run score agreement while reporting exact-output agreement separately', () => {
    const observations = [
      observation({ resultSignature: 'output-a' }),
      observation({ iteration: 2, resultSignature: 'output-b' }),
      observation({ iteration: 3, resultSignature: 'output-c' }),
    ];

    const metrics = computeEvalMetrics({ cases: [labeledCase()], observations, config });

    expect(metrics.scoreConsistency).toMatchObject({ consistentCases: 1, totalCases: 1, rate: 1 });
    expect(metrics.outputConsistency).toMatchObject({ consistentCases: 0, totalCases: 1, rate: 0 });
    expect(metrics.gates.find((entry) => entry.id === 'score-consistency')).toMatchObject({
      passed: true,
      actual: 1,
    });
  });

  it('fails a formal evaluation when any case has fewer than three base runs', () => {
    const metrics = computeEvalMetrics({
      cases: [labeledCase()],
      observations: [observation()],
      config,
      mode: 'live',
    });

    expect(metrics.gates.find((entry) => entry.id === 'minimum-runs-per-case'))
      .toMatchObject({ passed: false, actual: 0 });
    expect(metrics.passed).toBe(false);
  });

  it('uses one majority vote per case for macro accuracy and serious false mastery', () => {
    const second = labeledCase({ id: 'zc-p4-second' });
    const observations = [
      observation({ predictedScore: 'hit' }),
      observation({ iteration: 2, predictedScore: 'hit' }),
      observation({ iteration: 3, predictedScore: 'miss' }),
      observation({ caseId: second.id, predictedScore: 'miss' }),
      observation({ caseId: second.id, iteration: 2, predictedScore: 'miss' }),
      observation({ caseId: second.id, iteration: 3, predictedScore: 'hit' }),
    ];

    const metrics = computeEvalMetrics({ cases: [labeledCase(), second], observations, config });

    expect(metrics.perNode.P4).toEqual({ correct: 1, total: 2, accuracy: 0.5 });
    expect(metrics.confusionMatrix.miss.hit).toBe(1);
    expect(metrics.confusionMatrix.miss.miss).toBe(1);
    expect(metrics.severeFalseMastery).toMatchObject({
      numeratorCases: 1,
      denominatorCases: 2,
      rate: 0.5,
    });
  });

  it('fails every unobserved rate gate instead of treating an empty denominator as 100%', () => {
    const metrics = computeEvalMetrics({ cases: [labeledCase()], observations: [], config });

    expect(metrics.gates).not.toHaveLength(0);
    expect(metrics.gates.every((entry) => entry.passed === false)).toBe(true);
    expect(metrics.scoreConsistency.rate).toBe(0);
    expect(metrics.outputConsistency.rate).toBe(0);
    expect(metrics.metamorphic.rate).toBe(0);
  });

  it('keeps metamorphic invariance independent from golden accuracy', () => {
    const base = observation({ predictedScore: 'partial', resultSignature: 'partial' });
    const observations = [
      base,
      observation({ variant: 'paraphrase', predictedScore: 'partial', resultSignature: 'partial:p' }),
      observation({ variant: 'noise', predictedScore: 'partial', resultSignature: 'partial:n' }),
      observation({ variant: 'rename-person', predictedScore: 'miss', resultSignature: 'miss:r' }),
    ];

    const metrics = computeEvalMetrics({ cases: [labeledCase()], observations, config });

    expect(metrics.metamorphic).toEqual({ passed: 2, total: 3, rate: 2 / 3 });
    expect(metrics.accuracy).toBe(0);
  });
});

describe('metamorphic case generator', () => {
  it('creates paraphrase, irrelevant-noise, and renamed-person variants without changing labels', () => {
    const variants = generateMetamorphicVariants(labeledCase());

    expect(variants.map((variant) => variant.variant)).toEqual([
      'paraphrase',
      'noise',
      'rename-person',
    ]);
    expect(variants.every((variant) => variant.case.expectedScore === 'miss')).toBe(true);
    expect(variants[0].case.studentAnswer).toContain('觉得');
    expect(variants[1].case.studentAnswer).toContain('这和答案无关');
    expect(variants[2].case.studentAnswer).toContain('李同学');
    expect(variants[2].case.studentAnswer).not.toContain('小明');
  });

  it('still generates score-preserving variants for an empty answer', () => {
    const blank = labeledCase({
      id: 'blank',
      studentAnswer: '',
      expectedExtraction: {
        anchors: [],
        response: 'blank',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'none',
        errorIds: [],
        slots: [],
        evidenceQuotes: [],
      },
      expectedScore: 'unanswered',
      seriousMisjudgmentOpportunity: false,
      metamorphicReview: {
        reviewer: 'independent-reviewer',
        status: 'approved',
        variants: {
          paraphrase: { status: 'not-applicable', rationale: 'Blank answer has no paraphrase.' },
          noise: { status: 'not-applicable', rationale: 'Noise changes blank response semantics.' },
          'rename-person': { status: 'not-applicable', rationale: 'Blank answer has no person.' },
        },
      },
    });

    const variants = generateMetamorphicVariants(blank);

    expect(variants).toHaveLength(0);
  });

  it('skips equation whitespace and person no-ops so they never enter the denominator', () => {
    const value = 'Zn + Cu^2+ -> Zn^2+ + Cu + e^-';
    const equation = labeledCase({
      id: 'equation-noops',
      evaluationPath: 'equation',
      questionRef: {
        caseId: 'zinc-copper',
        nodeId: 'P7',
        equationSetId: 'zinc-copper-overall',
      },
      studentAnswer: value,
      expectedExtraction: {
        anchors: [],
        response: 'substantive',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'none',
        errorIds: ['P7-M2'],
        slots: [{ id: 'equation', value, evidenceQuote: value }],
        evidenceQuotes: [value],
      },
      expectedScore: 'miss',
      misconceptionIds: ['P7-M2'],
      rationale: {
        rubricRefs: ['p7-miss'],
        adjudicationRefs: ['§1', '§9'],
        text: 'The total equation retains an electron.',
      },
      metamorphicReview: {
        reviewer: 'independent-reviewer',
        status: 'approved',
        variants: {
          paraphrase: { status: 'approved', rationale: 'Arrow replacement is equivalent.' },
          noise: { status: 'not-applicable', rationale: 'Whitespace is a parser no-op.' },
          'rename-person': { status: 'not-applicable', rationale: 'No person occurs in an equation.' },
        },
      },
    });

    const variants = generateMetamorphicVariants(equation);
    expect(variants.map((entry) => entry.variant)).toEqual(['paraphrase']);
    expect(variants[0].semanticReview.reviewer).toBe('independent-reviewer');
  });
});
