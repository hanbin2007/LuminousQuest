import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  resolveLiveEvalProvider,
  runEvalCli,
  selectEvalCasesForRun,
  WaitingForApiKeyError,
} from '../eval/cli';
import { importEvalCandidates } from '../eval/import-candidates';
import {
  assertEvalSetIsolation,
  EVAL_COVERAGE_REQUIREMENTS,
  inspectEvalCoverage,
  loadHoldoutEvalCases,
  loadEvalConfig,
  loadEvalCases,
  validateEvalCoverage,
} from '../eval/load';
import { loadAllConfig } from '../server/config/loader';
import { loadPrompt } from '../server/prompts/loader';
import { createTemporaryDirectory } from './helpers/content-fixture';

describe('eval golden data', () => {
  it('loads the committed synthetic seed and enforces extraction-node coverage', async () => {
    const [cases, evalConfig, productionConfig] = await Promise.all([
      loadEvalCases({ contentRoot: process.cwd() }),
      loadEvalConfig(process.cwd()),
      loadAllConfig(process.cwd()),
    ]);
    const coverage = inspectEvalCoverage({
      cases,
      productionConfig,
    });

    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(cases.every((evalCase) => evalCase.source === 'synthetic')).toBe(true);
    expect(cases.every((evalCase) =>
      evalCase.reviewStatus === 'reviewed'
      && evalCase.annotator !== evalCase.reviewer
      && evalCase.expectedDisagreement === false
      && evalCase.rationale.rubricRefs.length > 0
      && evalCase.rationale.adjudicationRefs.length > 0)).toBe(true);
    expect(evalConfig.corpus.stage).toBe('seed');
    expect(coverage.complete).toBe(false);
    expect(coverage.requirements).toEqual(EVAL_COVERAGE_REQUIREMENTS);
    expect(() => validateEvalCoverage({ cases, productionConfig })).toThrow(/150/);
    expect(coverage.excludedDeterministicNodeIds).toEqual([]);
    const tags = new Set(cases.flatMap((evalCase) => evalCase.tags));
    for (const boundary of [
      'blank',
      'off-topic',
      'colloquial',
      'typo',
      'double-negation',
      'partial',
      'contradiction',
      'beyond-syllabus-correct',
    ]) expect(tags.has(boundary)).toBe(true);
    expect(cases.filter((entry) => entry.tags.includes('adversarial'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tags: expect.arrayContaining(['prompt-injection']) }),
        expect.objectContaining({ tags: expect.arrayContaining(['rubric-gaming']) }),
        expect.objectContaining({ tags: expect.arrayContaining(['sycophancy']) }),
      ]),
    );
    expect(cases.find((entry) => entry.id === 'synthetic-e1-m2-stored-electricity'))
      .toMatchObject({ expectedScore: 'miss', expectedExtraction: { slots: [] } });
    expect(cases.filter((entry) => entry.tags.includes('following-error'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          questionRef: expect.objectContaining({ nodeId: 'P4' }),
          expectedScore: 'hit',
          expectedExtraction: expect.objectContaining({ anchors: expect.any(Array) }),
        }),
        expect.objectContaining({
          questionRef: expect.objectContaining({ nodeId: 'P5' }),
          expectedScore: 'hit',
          expectedExtraction: expect.objectContaining({ anchors: expect.any(Array) }),
        }),
      ]),
    );
    expect(cases.filter((entry) => entry.evaluationPath === 'equation').every((entry) =>
      entry.expectedExtraction.errorIds.length > 0)).toBe(true);
    expect(selectEvalCasesForRun({
      mode: 'live',
      liveStage: 'pilot',
      cases,
      pilotCases: evalConfig.live.pilotCases,
    })).toHaveLength(5);
    expect(selectEvalCasesForRun({
      mode: 'live',
      liveStage: 'full',
      cases,
      pilotCases: evalConfig.live.pilotCases,
    })).toHaveLength(cases.length);
  });

  it('loads holdout only through its hash manifest and rejects train/holdout duplicates', async () => {
    const root = await createTemporaryDirectory();
    const trainDirectory = path.join(root, 'eval', 'cases', 'synthetic');
    const holdoutDirectory = path.join(root, 'eval', 'holdout');
    const holdoutCasesDirectory = path.join(holdoutDirectory, 'cases');
    await Promise.all([
      mkdir(trainDirectory, { recursive: true }),
      mkdir(holdoutCasesDirectory, { recursive: true }),
    ]);
    const seed = JSON.parse(await readFile(
      path.join(process.cwd(), 'eval', 'cases', 'synthetic', 'seed.json'),
      'utf8',
    )) as Array<Record<string, unknown>>;
    await writeFile(path.join(trainDirectory, 'train.json'), JSON.stringify(seed[0]));
    const holdoutSource = `${JSON.stringify(seed[1], null, 2)}\n`;
    await writeFile(path.join(holdoutCasesDirectory, 'holdout.json'), holdoutSource);
    await writeFile(path.join(holdoutDirectory, 'manifest.json'), JSON.stringify({
      version: 'eval-holdout-manifest.v1',
      files: [{
        path: 'cases/holdout.json',
        sha256: createHash('sha256').update(holdoutSource).digest('hex'),
      }],
    }));

    const train = await loadEvalCases({ contentRoot: root });
    const holdout = await loadHoldoutEvalCases({ contentRoot: root });
    expect(train).toHaveLength(1);
    expect(holdout).toHaveLength(1);
    expect(assertEvalSetIsolation({ train, holdout })).toMatchObject({ isolated: true });
    expect(() => assertEvalSetIsolation({ train, holdout: [train[0]] })).toThrow(/id duplicates/i);
    expect(() => assertEvalSetIsolation({
      train,
      holdout: [{ ...train[0], id: 'different-id' }],
    })).toThrow(/duplicates training content/i);

    await writeFile(path.join(holdoutCasesDirectory, 'holdout.json'), `${holdoutSource} `);
    await expect(loadHoldoutEvalCases({ contentRoot: root })).rejects.toThrow(/content hash/i);
    await expect(loadEvalCases({
      contentRoot: root,
      casesDirectory: holdoutCasesDirectory,
    })).rejects.toThrow(/dedicated holdout loader/i);
  });

  it('rejects undeclared holdout cases even when the manifest is empty', async () => {
    const root = await createTemporaryDirectory();
    const holdoutDirectory = path.join(root, 'eval', 'holdout');
    const holdoutCasesDirectory = path.join(holdoutDirectory, 'cases');
    await mkdir(holdoutCasesDirectory, { recursive: true });
    const seed = JSON.parse(await readFile(
      path.join(process.cwd(), 'eval', 'cases', 'synthetic', 'seed.json'),
      'utf8',
    )) as unknown[];
    await writeFile(path.join(holdoutCasesDirectory, 'undeclared.json'), JSON.stringify(seed[0]));
    await writeFile(path.join(holdoutDirectory, 'manifest.json'), JSON.stringify({
      version: 'eval-holdout-manifest.v1',
      files: [],
    }));

    await expect(loadHoldoutEvalCases({ contentRoot: root }))
      .rejects.toThrow(/absent from the hash manifest/i);
  });

  it('loads object or array files recursively and rejects duplicate ids', async () => {
    const root = await createTemporaryDirectory();
    const directory = path.join(root, 'eval', 'cases', 'synthetic');
    await mkdir(directory, { recursive: true });
    const seed = JSON.parse(await readFile(
      path.join(process.cwd(), 'eval', 'cases', 'synthetic', 'seed.json'),
      'utf8',
    )) as unknown[];
    await writeFile(path.join(directory, 'one.json'), JSON.stringify(seed[0]));
    await writeFile(path.join(directory, 'many.json'), JSON.stringify([seed[1], seed[2]]));

    const loaded = await loadEvalCases({ contentRoot: root });
    expect(loaded.map((evalCase) => evalCase.id).sort()).toEqual(
      (seed.slice(0, 3) as Array<{ id: string }>).map((evalCase) => evalCase.id).sort(),
    );

    await writeFile(path.join(directory, 'duplicate.json'), JSON.stringify(seed[0]));
    await expect(loadEvalCases({ contentRoot: root })).rejects.toThrow(/duplicate eval case id/i);
  });
});

describe('M1b candidate importer', () => {
  it('reclassifies with current thresholds and replaces stale provenance in a pending case', async () => {
    const root = await createTemporaryDirectory();
    const candidates = path.join(root, 'recordings', 'eval-candidates');
    const output = path.join(root, 'eval', 'cases', 'imported');
    await mkdir(candidates, { recursive: true });
    await writeFile(path.join(candidates, 'candidate.json'), JSON.stringify({
      version: 'eval-candidate.v2',
      recordedAt: '2026-07-15T00:00:00.000Z',
      stableHash: 'b'.repeat(64),
      category: 'citation-mismatch',
      provenance: {
        configDigest: 'stale-config',
        thresholds: {
          maxEditDistanceRatio: 0.9,
          normalizationCandidateMaxEditDistanceRatio: 0.9,
        },
        prompt: { id: 'structured-assessment', version: 'stale-prompt' },
        schemaVersion: 'structured-assessment.v3',
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
      sample: {
        answer: '电子由负机流往正极。',
        modelQuote: '电子由负极流向正极。',
      },
      context: {
        caseId: 'zinc-copper',
        nodeId: 'P4',
        evidenceIndex: 0,
      },
      distribution: { requiresHumanAudit: true },
    }));
    const [productionConfig, prompt] = await Promise.all([
      loadAllConfig(process.cwd()),
      loadPrompt(process.cwd(), 'structured-assessment'),
    ]);
    if (!prompt) throw new Error('test prompt missing');

    const result = await importEvalCandidates({
      contentRoot: process.cwd(),
      candidateDirectory: candidates,
      outputDirectory: output,
    });

    expect(result.imported).toHaveLength(1);
    const pending = JSON.parse(await readFile(result.imported[0], 'utf8')) as Record<string, any>;
    expect(pending).toMatchObject({
      annotationStatus: 'pending',
      expectedExtraction: null,
      expectedScore: null,
      annotator: null,
      source: 'human',
      candidateImport: {
        originalCategory: 'citation-mismatch',
        currentCategory: 'normalization-insufficient',
        requiresHumanAudit: true,
        provenance: {
          configDigest: productionConfig.configVersion,
          thresholds: {
            maxEditDistanceRatio:
              productionConfig.scaffoldPolicy.extraction.citation.maxEditDistanceRatio,
            normalizationCandidateMaxEditDistanceRatio:
              productionConfig.scaffoldPolicy.extraction.citation
                .normalizationCandidateMaxEditDistanceRatio,
          },
          prompt: { id: prompt.id, version: prompt.version },
          schemaVersion: 'structured-assessment.v4',
          provider: 'deepseek',
          model: 'deepseek-chat',
        },
      },
    });
    expect(JSON.stringify(pending)).not.toContain('stale-config');
    expect(JSON.stringify(pending)).not.toContain('stale-prompt');
  });
});

describe('eval live provider guard', () => {
  it('reports a missing supported-provider key as waiting instead of exposing a stack', () => {
    expect(() => resolveLiveEvalProvider({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      environment: {},
    })).toThrow(new WaitingForApiKeyError('等待 API key: 请设置 DEEPSEEK_API_KEY'));
  });

  it('returns the same concise waiting message from the live CLI', async () => {
    const errors: string[] = [];
    const exitCode = await runEvalCli({
      argv: ['--mode', 'live'],
      environment: {},
      contentRoot: process.cwd(),
      output: {
        log() {},
        error(message) { errors.push(String(message)); },
      },
    });

    expect(exitCode).toBe(2);
    expect(errors).toEqual(['等待 API key: 请设置 DEEPSEEK_API_KEY']);
    expect(errors[0]).not.toContain('at ');
  });
});
