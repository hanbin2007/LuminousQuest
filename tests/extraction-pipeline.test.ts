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
import { runAssessmentExtraction } from '../server/workflows/assessment-extraction';
import { createTemporaryDirectory } from './helpers/content-fixture';

const answer = '电子由Zn极流向Cu极。';

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
        schemaVersion: 'structured-assessment.v4',
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
