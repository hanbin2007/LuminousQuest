import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { EvalCandidateStore } from '../server/llm/eval-candidate-store';
import { MockProvider } from '../server/llm/providers/mock';
import { RecordingStore } from '../server/llm/recording-store';
import { LLMService } from '../server/llm/service';
import type { LLMProvider, LLMResponse } from '../server/llm/types';
import { loadAllPrompts } from '../server/prompts/loader';
import {
  createClosedExtractionSchema,
  runAssessmentExtraction,
} from '../server/workflows/assessment-extraction';
import { evaluateExtractedFacts } from '../shared/scoring/policy';
import { createSession, sessionConfigVersions } from '../shared/session';
import { recordStructuredTextAssessment } from '../shared/workflows/assessment';
import { validateAssessmentExtraction } from '../shared/workflows/extraction-validation';
import { createTemporaryDirectory } from './helpers/content-fixture';

const answer = '电子由Zn极流向Cu极。';
const p4OnlyAnswer = '电子由Zn极经外电路流向Cu极；盐桥阴离子移向Zn侧，阳离子移向Cu侧。';

function structuredResponse(quote = answer): LLMResponse {
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
        slots: [
          {
            id: 'electron-from',
            value: 'Zn',
            evidence: { quote: 'Zn', start: 3, end: 5 },
          },
          {
            id: 'electron-to',
            value: 'Cu',
            evidence: { quote: 'Cu', start: 8, end: 10 },
          },
        ],
      },
      evidence: [{ quote, start: 0, end: quote.length }],
      assistance: { kind: 'none', rounds: 0 },
    }],
  };
  return { content: JSON.stringify(extraction), structured: extraction, model: 'fixture-v1' };
}

function p4OnlyStructuredResponse(): LLMResponse {
  const evidence = (quote: string, fromIndex = 0) => {
    const start = p4OnlyAnswer.indexOf(quote, fromIndex);
    if (start < 0) throw new Error(`Missing test quote ${quote}`);
    return { quote, start, end: start + quote.length };
  };
  const secondZn = p4OnlyAnswer.indexOf('Zn', p4OnlyAnswer.indexOf('Zn') + 1);
  const secondCu = p4OnlyAnswer.indexOf('Cu', p4OnlyAnswer.indexOf('Cu') + 1);
  const extraction = {
    anchors: [],
    assessments: [
      {
        nodeId: 'P4',
        errorIds: [],
        facts: {
          response: 'substantive',
          terminology: 'model',
          syllabus: 'within',
          contradiction: false,
          typo: 'none',
          slots: [
            { id: 'electron-from', value: 'Zn', evidence: evidence('Zn') },
            { id: 'electron-to', value: 'Cu', evidence: evidence('Cu') },
            { id: 'anion-toward', value: 'Zn', evidence: evidence('Zn', secondZn) },
            { id: 'cation-toward', value: 'Cu', evidence: evidence('Cu', secondCu) },
          ],
        },
        evidence: [{ quote: p4OnlyAnswer, start: 0, end: p4OnlyAnswer.length }],
        assistance: { kind: 'none', rounds: 0 },
      },
      {
        nodeId: 'P5',
        errorIds: [],
        facts: {
          response: 'substantive',
          terminology: 'model',
          syllabus: 'within',
          contradiction: false,
          typo: 'none',
          slots: [],
        },
        evidence: [],
        assistance: { kind: 'none', rounds: 0 },
      },
    ],
  };
  return { content: JSON.stringify(extraction), structured: extraction, model: 'fixture-v1' };
}

async function fixture(root: string, providers: Map<string, LLMProvider>) {
  const [config, prompts] = await Promise.all([
    loadAllConfig(process.cwd()),
    loadAllPrompts(process.cwd()),
  ]);
  return {
    config,
    prompt: prompts['structured-assessment'],
    service: new LLMService({
      providers,
      recordings: new RecordingStore(root),
      logger: { error: vi.fn(), warn: vi.fn() },
    }),
    evalCandidates: new EvalCandidateStore(root),
  };
}

function runInput<T extends Awaited<ReturnType<typeof fixture>>>(parts: T) {
  return {
    ...parts,
    answer,
    caseId: 'zinc-copper',
    targetNodeIds: ['P4'],
    assistance: { kind: 'none' as const, rounds: 0 },
    executionMode: 'development' as const,
    provider: 'mock',
    model: 'mock-v1',
  };
}

describe('production assessment extraction pipeline', () => {
  it('uses a stable candidate hash independent of recording time and file id', async () => {
    const root = await createTemporaryDirectory();
    let tick = 0;
    const store = new EvalCandidateStore(root, undefined, () =>
      new Date(`2026-07-15T00:00:0${tick++}.000Z`));
    const candidate = {
      category: 'fact-grounding' as const,
      answer,
      detail: { nodeId: 'P4', slotId: 'electron-from', modelQuote: '电子' },
      provenance: {
        configDigest: 'config-digest',
        thresholds: {
          maxEditDistanceRatio: 0.12,
          normalizationCandidateMaxEditDistanceRatio: 0.35,
        },
        prompt: { id: 'structured-assessment', version: 'prompt.v1' },
        schemaVersion: 'structured-assessment.v4',
        provider: 'fixture',
        model: 'fixture-v1',
      },
    };

    const first = JSON.parse(await readFile(await store.record(candidate), 'utf8')) as { stableHash: string };
    const second = JSON.parse(await readFile(await store.record(candidate), 'utf8')) as { stableHash: string };

    expect(first.stableHash).toBe(second.stableHash);
  });

  it('runs the real structured capability with the no-key MockProvider', async () => {
    const root = await createTemporaryDirectory();
    const provider = new MockProvider();
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    const result = await runAssessmentExtraction(runInput(parts));

    expect(result).toMatchObject({
      status: 'extracted',
      source: 'provider',
      extraction: {
        assessments: [{ nodeId: 'P4', evidence: [{ quote: answer }] }],
      },
    });
  });

  it('keeps covered P4 scoring when a substantive answer does not address P5', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const response = p4OnlyStructuredResponse();
    const provider: LLMProvider = {
      id: 'partial-node-coverage',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return structuredClone(response);
      },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    const validated = validateAssessmentExtraction({
      extraction: response.structured,
      answer: p4OnlyAnswer,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4', 'P5'],
      config: parts.config,
    });
    expect(validated.assessments.find((assessment) => assessment.nodeId === 'P5'))
      .toMatchObject({ facts: { response: 'substantive', slots: [] }, evidence: [] });

    const p5Requirements = parts.config.cases
      .find((entry) => entry.id === 'zinc-copper')
      ?.evidencePaths.find((entry) => entry.nodeId === 'P5' && entry.source === 'answer')
      ?.factRequirements;
    if (!p5Requirements) throw new Error('Missing P5 test requirements');
    const p5 = validated.assessments.find((assessment) => assessment.nodeId === 'P5');
    if (!p5?.facts.verified) throw new Error('Expected server-verified P5 facts');
    expect(evaluateExtractedFacts({
      facts: {
        response: p5.facts.response,
        verified: p5.facts.verified,
        slots: p5.facts.slots,
      },
      requirements: p5Requirements,
      policy: parts.config.rubrics.policy,
      aliases: parts.config.scaffoldPolicy.extraction.factValueAliases,
      commonTypos: parts.config.scaffoldPolicy.extraction.citation.commonTypos,
    }).status).toBe('miss');

    const extractionResult = await runAssessmentExtraction({
      ...runInput(parts),
      answer: p4OnlyAnswer,
      targetNodeIds: ['P4', 'P5'],
      provider: provider.id,
    });
    expect(attempts).toBe(1);
    expect(extractionResult).toMatchObject({ status: 'extracted', source: 'provider' });
    if (extractionResult.status !== 'extracted') throw new Error('Expected extraction without fallback');

    const session = createSession({
      id: 'session-partial-node-coverage',
      anonymousStudentId: 'anon-A1B2C3D4',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(parts.config),
    });
    const recorded = recordStructuredTextAssessment({
      session,
      config: parts.config,
      answer: {
        id: 'answer-partial-node-coverage',
        occurredAt: '2026-07-15T12:01:00.000Z',
        caseId: 'zinc-copper',
        stageId: 'analysis',
        attemptId: 'attempt-partial-node-coverage',
        questionId: 'zinc-copper:analysis',
        value: p4OnlyAnswer,
      },
      extraction: extractionResult.extraction,
      provenance: {
        promptId: parts.prompt.id,
        promptVersion: parts.prompt.version,
        cacheKey: extractionResult.cacheKey,
        model: extractionResult.model,
      },
      assessmentEventIdPrefix: 'partial-node-coverage',
      assessedAt: '2026-07-15T12:01:01.000Z',
    });
    const assessments = recorded.session.events.filter((event) =>
      event.kind === 'assessment.completed');
    expect(assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'P4',
        objectiveOutcome: 'hit',
        extraction: expect.objectContaining({ status: 'assessed' }),
        score: expect.objectContaining({ status: 'scored', outcome: 'hit' }),
      }),
      expect.objectContaining({
        nodeId: 'P5',
        objectiveOutcome: 'miss',
        extraction: expect.objectContaining({ status: 'assessed', evidence: [] }),
        score: expect.objectContaining({ status: 'scored', outcome: 'miss' }),
      }),
    ]));
  });

  it('exposes classification evidence but not server verification flags to providers', async () => {
    const root = await createTemporaryDirectory();
    const parts = await fixture(root, new Map());
    const schema = createClosedExtractionSchema({
      config: parts.config,
      caseId: 'zinc-copper',
      targetNodeIds: ['P4'],
      assistance: { kind: 'none', rounds: 0 },
    }) as any;
    const facts = schema.properties.assessments.items.oneOf[0].properties.facts;

    expect(facts.properties.classificationEvidence).toBeDefined();
    expect(facts.properties.verified).toBeUndefined();
  });

  it.each([
    ['contradiction', true],
    ['terminology', 'colloquial'],
    ['typo', 'unambiguous'],
    ['syllabus', 'beyond'],
  ] as const)(
    'routes an ungrounded adverse %s declaration to needs-review instead of policy scoring',
    async (field, declaration) => {
      const root = await createTemporaryDirectory();
      let attempts = 0;
      const response = structuredResponse();
      const facts = (response.structured as any).assessments[0].facts;
      facts[field] = declaration;
      response.content = JSON.stringify(response.structured);
      const provider: LLMProvider = {
        id: `ungrounded-${field}`,
        async chat() { throw new Error('not used'); },
        async vision() { throw new Error('not used'); },
        async structured() {
          attempts += 1;
          return structuredClone(response);
        },
      };
      const parts = await fixture(root, new Map([[provider.id, provider]]));

      const result = await runAssessmentExtraction({
        ...runInput(parts),
        provider: provider.id,
      });

      expect(attempts).toBe(1);
      expect(result).toMatchObject({
        status: 'needs-review',
        reason: 'classification-grounding',
      });
    },
  );

  it('runs the same closed-set validator for a structured demo recording', async () => {
    const root = await createTemporaryDirectory();
    const demoRoot = path.join(root, 'recordings', 'demo');
    await mkdir(demoRoot, { recursive: true });
    await writeFile(path.join(root, 'recordings', 'demo-script.json'), JSON.stringify({
      version: 'demo-script.v2',
      steps: [{
        id: 'm1b-extraction',
        recording: 'demo/m1b-extraction.json',
        resourceRefs: [],
        configVersion: 'fixture',
        schemaVersion: 'structured-assessment.v3',
        prompt: { id: 'structured-assessment', version: 'fixture' },
      }],
    }));
    await writeFile(path.join(demoRoot, 'm1b-extraction.json'), JSON.stringify({
      version: 'llm-recording.v2',
      recordedAt: '2026-07-15T00:00:00.000Z',
      metadata: {
        configVersion: 'fixture',
        schemaVersion: 'structured-assessment.v3',
        prompt: { id: 'structured-assessment', version: 'fixture' },
      },
      request: {},
      response: structuredResponse(),
    }));
    const parts = await fixture(root, new Map());

    const result = await runAssessmentExtraction({
      ...runInput(parts),
      executionMode: 'demo',
      stepId: 'm1b-extraction',
    });

    expect(result).toMatchObject({ status: 'extracted', source: 'demo-recording' });
  });

  it('retries a hallucinated citation and records the rejected sample for eval', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'sequence',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return attempts === 1 ? structuredResponse('我声称了原文中不存在的结论') : structuredResponse();
      },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    const result = await runAssessmentExtraction({
      ...runInput(parts),
      provider: provider.id,
    });

    expect(attempts).toBe(2);
    expect(result.status).toBe('extracted');
    const files = await readdir(path.join(root, 'recordings', 'eval-candidates'));
    expect(files).toHaveLength(1);
    const persisted = JSON.parse(await readFile(
      path.join(root, 'recordings', 'eval-candidates', files[0]),
      'utf8',
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      version: 'eval-candidate.v2',
      category: 'citation-mismatch',
      stableHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: {
        configDigest: parts.config.configVersion,
        thresholds: {
          maxEditDistanceRatio: 0.12,
          normalizationCandidateMaxEditDistanceRatio: 0.35,
        },
        prompt: {
          id: parts.prompt.id,
          version: parts.prompt.version,
        },
        schemaVersion: 'structured-assessment.v5',
        provider: provider.id,
        model: 'mock-v1',
      },
      distribution: { requiresHumanAudit: true },
    });
  });

  it('logs normalization insufficiency without retrying and degrades to needs-review', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const provider: LLMProvider = {
      id: 'near-citation',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return structuredResponse('电子由Zn机流向Cu极。');
      },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));
    parts.config.scaffoldPolicy.extraction.citation.maxEditDistanceRatio = 0.03;

    const personalAnswer = [
      'student@example.com',
      'QQ:12345678',
      '微信:zhangsan_2026',
      '地址:南京市鼓楼区中山路12号',
      '南京一中高二3班',
      '学号:240031',
      answer,
    ].join(' ');
    const result = await runAssessmentExtraction({
      ...runInput(parts),
      answer: personalAnswer,
      provider: provider.id,
    });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({
      status: 'needs-review',
      reason: 'normalization-insufficient',
    });
    const files = await readdir(path.join(root, 'recordings', 'eval-candidates'));
    const persisted = await readFile(
      path.join(root, 'recordings', 'eval-candidates', files[0]),
      'utf8',
    );
    expect(persisted).not.toContain('student@example.com');
    expect(persisted).not.toContain('12345678');
    expect(persisted).not.toContain('zhangsan_2026');
    expect(persisted).not.toContain('南京市鼓楼区中山路12号');
    expect(persisted).not.toContain('南京一中高二3班');
    expect(persisted).not.toContain('240031');
    expect(persisted).toContain('[REDACTED_EMAIL]');
    expect(persisted).toContain('[REDACTED_QQ]');
    expect(persisted).toContain('[REDACTED_WECHAT]');
    expect(persisted).toContain('[REDACTED_ADDRESS]');
    expect(persisted).toContain('[REDACTED_SCHOOL_CLASS]');
    expect(persisted).toContain('[REDACTED_STUDENT_ID]');
  });

  it('degrades a slot whose quote does not express its value and records the candidate', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const response = structuredResponse();
    const structured = response.structured as {
      assessments: Array<{ facts: { slots: Array<{ evidence: { quote: string; start: number; end: number } }> } }>;
    };
    structured.assessments[0].facts.slots[0].evidence = {
      quote: '电子',
      start: 0,
      end: 2,
    };
    response.content = JSON.stringify(structured);
    const provider: LLMProvider = {
      id: 'ungrounded-slot',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return response;
      },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    const result = await runAssessmentExtraction({
      ...runInput(parts),
      provider: provider.id,
    });

    expect(attempts).toBe(1);
    expect(result).toMatchObject({ status: 'needs-review', reason: 'fact-grounding' });
    const files = await readdir(path.join(root, 'recordings', 'eval-candidates'));
    const persisted = JSON.parse(await readFile(
      path.join(root, 'recordings', 'eval-candidates', files[0]),
      'utf8',
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      category: 'fact-grounding',
      context: { nodeId: 'P4', slotId: 'electron-from', slotValue: 'Zn' },
    });
  });

  it('refuses an over-limit answer before calling the provider', async () => {
    const root = await createTemporaryDirectory();
    const provider: LLMProvider = {
      id: 'must-not-run',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() { throw new Error('provider must not be called'); },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    await expect(runAssessmentExtraction({
      ...runInput(parts),
      answer: 'a'.repeat(parts.config.scaffoldPolicy.extraction.maximumAnswerCharacters + 1),
      provider: provider.id,
    })).rejects.toMatchObject({ category: 'answer-too-long', retryable: false });
  });

  it('retries a schema-invalid extraction once, then degrades without blocking', async () => {
    const root = await createTemporaryDirectory();
    let attempts = 0;
    const invalid = { anchors: [], assessments: [{ nodeId: 'P4' }] };
    const provider: LLMProvider = {
      id: 'invalid-schema',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() {
        attempts += 1;
        return { content: JSON.stringify(invalid), structured: invalid, model: 'invalid-v1' };
      },
    };
    const parts = await fixture(root, new Map([[provider.id, provider]]));

    const result = await runAssessmentExtraction({
      ...runInput(parts),
      provider: provider.id,
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      status: 'needs-review',
      reason: 'schema-invalid',
      source: 'fallback',
      degraded: true,
    });
  });
});
