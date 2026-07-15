import { access } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalHarness } from '../eval/harness';
import { loadEvalCases } from '../eval/load';
import { renderEvalMarkdownReport } from '../eval/report';
import {
  evalConfigSchema,
  labeledEvalCaseSchema,
  type LabeledEvalCase,
} from '../eval/schema';
import type { LLMProvider, LLMRequest, LLMResponse } from '../server/llm/types';
import { createTemporaryDirectory } from './helpers/content-fixture';

const answer = '锌是还原剂。';

function partialCase(): LabeledEvalCase {
  return labeledEvalCaseSchema.parse({
    version: 'eval-case.v2',
    annotationStatus: 'labeled',
    id: 'zc-p2-partial',
    questionRef: { caseId: 'zinc-copper', nodeId: 'P2' },
    studentAnswer: answer,
    expectedExtraction: {
      anchors: [],
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      errorIds: [],
      slots: [{ id: 'reducing-agent', value: 'Zn', evidenceQuote: '锌' }],
      evidenceQuotes: [answer],
    },
    expectedScore: 'partial',
    annotator: 'test-annotator',
    reviewer: 'test-reviewer',
    reviewStatus: 'reviewed',
    adjudicationVersion: 'adjudication-table.v1.1',
    rationale: {
      rubricRefs: ['p2-partial'],
      adjudicationRefs: ['§1'],
      text: 'Only one reagent role is identified.',
    },
    expectedDisagreement: false,
    metamorphicReview: {
      reviewer: 'test-reviewer',
      status: 'approved',
      variants: {
        paraphrase: { status: 'approved', rationale: 'Approved paraphrase.' },
        noise: { status: 'approved', rationale: 'Approved irrelevant suffix.' },
        'rename-person': { status: 'approved', rationale: 'Approved wrapper rename.' },
      },
    },
    rubricVersion: 'rubrics.v1.1',
    source: 'synthetic',
    misconceptionIds: [],
    tags: ['partial'],
    seriousMisjudgmentOpportunity: false,
  });
}

function equationCase(): LabeledEvalCase {
  const equation = 'Zn + Cu^2+ -> Zn^2+ + Cu + e^-';
  return labeledEvalCaseSchema.parse({
    version: 'eval-case.v2',
    annotationStatus: 'labeled',
    evaluationPath: 'equation',
    id: 'zc-p7-electron-remains',
    questionRef: {
      caseId: 'zinc-copper',
      nodeId: 'P7',
      equationSetId: 'zinc-copper-overall',
    },
    studentAnswer: equation,
    expectedExtraction: {
      anchors: [],
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: false,
      typo: 'none',
      errorIds: ['P7-M2'],
      slots: [{ id: 'equation', value: equation, evidenceQuote: equation }],
      evidenceQuotes: [equation],
    },
    expectedScore: 'miss',
    annotator: 'test-annotator',
    reviewer: 'test-reviewer',
    reviewStatus: 'reviewed',
    adjudicationVersion: 'adjudication-table.v1.1',
    rationale: {
      rubricRefs: ['p7-miss'],
      adjudicationRefs: ['§1', '§9'],
      text: 'An overall equation cannot retain electrons.',
    },
    expectedDisagreement: false,
    metamorphicReview: {
      reviewer: 'test-reviewer',
      status: 'approved',
      variants: {
        paraphrase: { status: 'approved', rationale: 'Equivalent arrow style.' },
        noise: { status: 'not-applicable', rationale: 'Whitespace is a parser no-op.' },
        'rename-person': { status: 'not-applicable', rationale: 'Equation has no person.' },
      },
    },
    rubricVersion: 'rubrics.v1.1',
    source: 'synthetic',
    misconceptionIds: ['P7-M2'],
    tags: ['equation'],
    seriousMisjudgmentOpportunity: true,
  });
}

function seriousContradictionCase(): LabeledEvalCase {
  const studentAnswer = '电子由Zn极流向Cu极，但也会由Cu极流回Zn极；阴离子向Zn极，阳离子向Cu极。';
  return labeledEvalCaseSchema.parse({
    version: 'eval-case.v2',
    evaluationPath: 'structured-assessment',
    annotationStatus: 'labeled',
    id: 'zc-p4-contradiction-negative-provider',
    questionRef: { caseId: 'zinc-copper', nodeId: 'P4' },
    studentAnswer,
    expectedExtraction: {
      anchors: [],
      response: 'substantive',
      terminology: 'model',
      syllabus: 'within',
      contradiction: true,
      typo: 'none',
      errorIds: [],
      slots: [
        { id: 'electron-from', value: 'Zn', evidenceQuote: 'Zn极' },
        { id: 'electron-to', value: 'Cu', evidenceQuote: 'Cu极' },
        { id: 'anion-toward', value: 'Zn', evidenceQuote: 'Zn极' },
        { id: 'cation-toward', value: 'Cu', evidenceQuote: 'Cu极' },
      ],
      evidenceQuotes: [studentAnswer],
    },
    expectedScore: 'miss',
    annotator: 'test-annotator',
    reviewer: 'test-reviewer',
    reviewStatus: 'reviewed',
    adjudicationVersion: 'adjudication-table.v1.1',
    rationale: {
      rubricRefs: ['p4-miss'],
      adjudicationRefs: ['§5'],
      text: 'The answer contradicts itself and is a ground-truth miss.',
    },
    expectedDisagreement: false,
    metamorphicReview: {
      reviewer: 'test-reviewer',
      status: 'approved',
      variants: {
        paraphrase: { status: 'approved', rationale: 'Approved paraphrase.' },
        noise: { status: 'approved', rationale: 'Approved irrelevant suffix.' },
        'rename-person': { status: 'approved', rationale: 'Approved wrapper rename.' },
      },
    },
    rubricVersion: 'rubrics.v1.1',
    source: 'synthetic',
    misconceptionIds: [],
    tags: ['contradiction'],
    seriousMisjudgmentOpportunity: true,
  });
}

function harnessConfig(defaultRuns = 1) {
  return evalConfigSchema.parse({
    version: 'eval-config.v2',
    defaultRuns,
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
      provider: 'fixture',
      model: 'fixture-v1',
      pilotCases: 5,
      minimumClosedSetComplianceRate: 0.95,
    },
  });
}

function response(): LLMResponse {
  const structured = {
    anchors: [],
    assessments: [{
      nodeId: 'P2',
      errorIds: [],
      facts: {
        response: 'substantive',
        terminology: 'model',
        syllabus: 'within',
        contradiction: false,
        typo: 'none',
        slots: [{
          id: 'reducing-agent',
          value: 'Zn',
          evidence: { quote: '锌', start: 0, end: 1 },
        }],
      },
      evidence: [{ quote: answer, start: 0, end: answer.length }],
      assistance: { kind: 'none', rounds: 0 },
    }],
  };
  return {
    content: JSON.stringify(structured),
    structured,
    model: 'fixture-v1',
    usage: { inputTokens: 11, outputTokens: 7 },
  };
}

describe('eval harness production-path execution', () => {
  it('runs the golden mock through extraction and deterministic scoring N times', async () => {
    const result = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [partialCase()],
      config: harnessConfig(3),
      mode: 'mock',
      providerId: 'eval-mock',
      model: 'eval-mock-v1',
      includeMetamorphic: false,
    });

    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((entry) => entry.predictedScore === 'partial')).toBe(true);
    expect(result.observations.every((entry) => entry.extractionExact)).toBe(true);
    expect(result.metrics.scoreConsistency.rate).toBe(1);
    expect(result.harnessSelfCheck.passed).toBe(true);
    expect(result.metrics.qualityGateEligible).toBe(false);
    expect(result.metrics.passed).toBe(false);
  });

  it('uses the production equation engine for deterministic P3/P6/P7 golden cases', async () => {
    const result = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [equationCase()],
      config: harnessConfig(2),
      mode: 'mock',
      providerId: 'eval-mock',
      model: 'eval-mock-v1',
      includeMetamorphic: true,
    });

    expect(result.observations).toHaveLength(3);
    expect(result.observations.every((entry) => entry.predictedScore === 'miss')).toBe(true);
    expect(result.observations.every((entry) => entry.source === 'deterministic-engine')).toBe(true);
    expect(result.observations.every((entry) => entry.errorIdsExact)).toBe(true);
    expect(result.observations.every((entry) =>
      entry.predictedErrorIds.includes('P7-M2'))).toBe(true);
    expect(result.metrics.metamorphic.rate).toBe(1);
    expect(result.metrics.tokenUsage.totalTokens).toBe(0);
  });

  it('compares golden anchors and grants configured following credit for P4/P5', async () => {
    const cases = (await loadEvalCases({ contentRoot: process.cwd() }))
      .filter((entry) => entry.tags.includes('following-error'));

    const result = await runEvalHarness({
      contentRoot: process.cwd(),
      cases,
      config: harnessConfig(3),
      mode: 'mock',
      providerId: 'eval-mock',
      model: 'eval-mock-v1',
      includeMetamorphic: false,
    });

    expect(cases.map((entry) => entry.questionRef.nodeId).sort()).toEqual(['P4', 'P5']);
    expect(result.observations.every((entry) => entry.predictedScore === 'hit')).toBe(true);
    expect(result.observations.every((entry) => entry.extractionExact)).toBe(true);
  });

  it('passes the configured low temperature to the provider and records every response for replay', async () => {
    const root = await createTemporaryDirectory();
    const recordingsRoot = path.join(root, 'eval-recordings');
    const temperatures: Array<number | undefined> = [];
    const provider: LLMProvider = {
      id: 'fixture',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request: LLMRequest) {
        temperatures.push(request.temperature);
        return response();
      },
    };

    const live = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [partialCase()],
      config: harnessConfig(),
      mode: 'live',
      providerId: provider.id,
      model: 'fixture-v1',
      provider,
      recordingsRoot,
      includeMetamorphic: false,
    });

    expect(temperatures).toEqual([0.1]);
    expect(live.observations[0]).toMatchObject({
      predictedScore: 'partial',
      inputTokens: 11,
      outputTokens: 7,
    });
    const recordingFile = live.recordingFiles[0];
    await expect(access(recordingFile)).resolves.toBeUndefined();

    const replay = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [partialCase()],
      config: harnessConfig(),
      mode: 'replay',
      providerId: provider.id,
      model: 'fixture-v1',
      recordingsRoot,
      includeMetamorphic: false,
    });

    expect(replay.observations[0]).toMatchObject({
      predictedScore: 'partial',
      extractionExact: true,
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  it('fails the quality gates when a deliberately wrong local provider corrupts extraction', async () => {
    const evalCase = seriousContradictionCase();
    const wrongStructured = {
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
          slots: [
            { id: 'electron-from', value: 'Zn', evidence: { quote: 'Zn极', start: 3, end: 6 } },
            { id: 'electron-to', value: 'Cu', evidence: { quote: 'Cu极', start: 8, end: 11 } },
            { id: 'anion-toward', value: 'Zn', evidence: { quote: 'Zn极', start: 3, end: 6 } },
            { id: 'cation-toward', value: 'Cu', evidence: { quote: 'Cu极', start: 8, end: 11 } },
          ],
        },
        evidence: [{ quote: evalCase.studentAnswer, start: 0, end: evalCase.studentAnswer.length }],
        assistance: { kind: 'none', rounds: 0 },
      }],
    };
    const provider: LLMProvider = {
      id: 'deliberately-wrong',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        return {
          content: JSON.stringify(wrongStructured),
          structured: wrongStructured,
          model: 'wrong-v1',
        };
      },
    };

    const golden = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [evalCase],
      config: harnessConfig(3),
      mode: 'mock',
      providerId: 'eval-mock',
      model: 'eval-mock-v1',
      includeMetamorphic: false,
    });
    const corrupted = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [evalCase],
      config: harnessConfig(3),
      mode: 'live',
      providerId: provider.id,
      model: 'wrong-v1',
      provider,
      includeMetamorphic: false,
    });

    expect(golden.metrics.nodeMacroAccuracy).toBe(1);
    expect(corrupted.metrics.nodeMacroAccuracy).toBe(0);
    expect(corrupted.metrics.extraction.exactRate).toBe(0);
    expect(golden.metrics.severeFalseMastery.rate).toBe(0);
    expect(corrupted.metrics.severeFalseMastery.rate).toBe(1);
    expect(corrupted.metrics.gates.find((entry) => entry.id === 'severe-false-mastery'))
      .toMatchObject({ passed: false, actual: 1 });
    expect(corrupted.metrics.gates.find((entry) => entry.id === 'node-macro-accuracy'))
      .toMatchObject({ passed: false, actual: 0 });
    expect(corrupted.metrics.passed).toBe(false);
  });

  it('marks final invalid JSON/schema fallbacks as schema failures', async () => {
    const provider: LLMProvider = {
      id: 'invalid',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        return { content: '{not json', model: 'invalid-v1' };
      },
    };

    const result = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [partialCase()],
      config: harnessConfig(),
      mode: 'live',
      providerId: provider.id,
      model: 'invalid-v1',
      provider,
      includeMetamorphic: false,
    });

    expect(result.observations[0]).toMatchObject({
      predictedScore: 'needs-review',
      schemaFailure: true,
      failureReason: 'invalid-json',
    });
    expect(result.metrics.schemaFailureRate).toBe(1);
  });

  it('renders thresholds, five-way confusion, safety denominator, latency, and token cost', async () => {
    const result = await runEvalHarness({
      contentRoot: process.cwd(),
      cases: [partialCase()],
      config: harnessConfig(),
      mode: 'mock',
      providerId: 'eval-mock',
      model: 'eval-mock-v1',
      includeMetamorphic: false,
    });

    const markdown = renderEvalMarkdownReport({
      metrics: result.metrics,
      metadata: result.metadata,
    });

    expect(markdown).toContain('逐节点宏平均命中率');
    expect(markdown).toContain('自洽性检查,非质量门禁');
    expect(markdown).not.toContain('Overall: **PASS**');
    expect(markdown).toContain('全错判掌握率');
    expect(markdown).toContain('ground-truth miss');
    expect(markdown).toContain('Extraction expected/attempted/exact');
    expect(markdown).toContain('判分一致率 / 输出一致率');
    expect(markdown).toContain('未观测 serious case');
    expect(markdown).toContain('| expected \\ predicted | hit | partial | miss | unanswered | needs-review |');
    expect(markdown).toContain('P95');
    expect(markdown).toContain('Token');

    const aggregate = renderEvalMarkdownReport({
      metrics: result.metrics,
      metadata: { ...result.metadata, mode: 'holdout', caseVisibility: 'aggregate-only' },
    });
    expect(aggregate).not.toContain('## Case Consistency');
    expect(aggregate).not.toContain(partialCase().id);
  });
});
