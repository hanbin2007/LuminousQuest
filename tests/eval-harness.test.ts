import { access } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runEvalHarness } from '../eval/harness';
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
    version: 'eval-case.v1',
    annotationStatus: 'labeled',
    id: 'zc-p2-partial',
    questionRef: { caseId: 'zinc-copper', nodeId: 'P2' },
    studentAnswer: answer,
    expectedExtraction: {
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
    rubricVersion: 'rubrics.v1.1',
    source: 'synthetic',
    misconceptionIds: [],
    tags: ['partial'],
    seriousMisjudgmentOpportunity: false,
  });
}

function harnessConfig(defaultRuns = 1) {
  return evalConfigSchema.parse({
    version: 'eval-config.v1',
    defaultRuns,
    temperature: 0.1,
    thresholds: {
      nodeMacroAccuracy: 0.9,
      severeFalseMasteryRate: 0.02,
      citationHallucinationRate: 0.02,
      schemaFailureRate: 0.02,
      metamorphicInvariantRate: 0.9,
    },
    metamorphic: { enabled: false, variants: ['paraphrase', 'noise', 'rename-person'] },
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
    coverage: {
      minimumCases: 1,
      minimumCasesPerNode: 1,
      minimumCasesPerMisconception: 1,
    },
    live: { provider: 'fixture', model: 'fixture-v1' },
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
    expect(result.metrics.consistencyRate).toBe(1);
    expect(result.metrics.passed).toBe(true);
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
    expect(markdown).toContain('全错判掌握率');
    expect(markdown).toContain('denominatorCases');
    expect(markdown).toContain('| expected \\ predicted | hit | partial | miss | unanswered | needs-review |');
    expect(markdown).toContain('P95');
    expect(markdown).toContain('Token');
  });
});
