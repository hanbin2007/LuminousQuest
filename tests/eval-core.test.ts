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
    version: 'eval-case.v1',
    annotationStatus: 'labeled',
    id: 'zc-p4-reversed',
    questionRef: { caseId: 'zinc-copper', nodeId: 'P4' },
    studentAnswer: '小明认为电子由铜极流向锌极。',
    expectedExtraction: {
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
    extractionExact: true,
    resultSignature: 'miss:fixture',
    source: 'provider',
    latencyMs: 12,
    inputTokens: 10,
    outputTokens: 5,
    estimatedCostUsd: 0.00002,
    citationHallucination: false,
    schemaFailure: false,
    ...input,
  };
}

const config = evalConfigSchema.parse({
  version: 'eval-config.v1',
  defaultRuns: 3,
  temperature: 0.1,
  thresholds: {
    nodeMacroAccuracy: 0.9,
    severeFalseMasteryRate: 0.02,
    citationHallucinationRate: 0.02,
    schemaFailureRate: 0.02,
    metamorphicInvariantRate: 0.9,
  },
  metamorphic: { enabled: true, variants: ['paraphrase', 'noise', 'rename-person'] },
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
  coverage: {
    minimumCases: 40,
    minimumCasesPerNode: 2,
    minimumCasesPerMisconception: 1,
  },
  live: { provider: 'deepseek', model: 'deepseek-chat' },
});

describe('eval case and metric contracts', () => {
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
      version: 'eval-case.v1',
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
      hit: 1,
      partial: 1,
      miss: 2,
      unanswered: 1,
      'needs-review': 1,
    });
    expect(metrics.severeFalseMastery).toEqual({ numeratorCases: 1, denominatorCases: 2, rate: 0.5 });
    expect(metrics.schemaFailureRate).toBe(0);
    expect(metrics.tokenUsage).toMatchObject({ inputTokens: 60, outputTokens: 30 });
    expect(metrics.gates.find((gate) => gate.id === 'severe-false-mastery')).toMatchObject({
      passed: false,
      actual: 0.5,
    });
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
    });

    const variants = generateMetamorphicVariants(blank);

    expect(variants).toHaveLength(3);
    expect(variants.every((variant) => variant.case.expectedScore === 'unanswered')).toBe(true);
  });
});
