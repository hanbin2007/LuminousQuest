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
          { id: 'electron-from', value: 'Zn' },
          { id: 'electron-to', value: 'Cu' },
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
    )) as { category: string };
    expect(persisted.category).toBe('citation-mismatch');
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

    const result = await runAssessmentExtraction({
      ...runInput(parts),
      answer: `student@example.com ${answer}`,
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
    expect(persisted).toContain('[REDACTED_EMAIL]');
  });
});
