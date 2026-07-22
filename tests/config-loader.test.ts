import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ConfigValidationError, loadAllConfig } from '../server/config/loader';
import { loadAllPrompts } from '../server/prompts/loader';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

describe('configuration loading', () => {
  it('loads the complete valid external configuration tree', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);

    const loaded = await loadAllConfig(root);

    expect(loaded.knowledgeModel.version).toBe('knowledge-model.v1.2');
    expect(loaded.pretest.version).toBe('pretest.v1.2');
    expect(loaded.pretest.questions).toHaveLength(7);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.configVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('warns about normalized fact alias collisions without rejecting the config', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const file = path.join(root, 'config', 'scaffold-policy.json');
    const policy = JSON.parse(await readFile(file, 'utf8'));
    policy.extraction.factValueAliases['collision-a'] = ['ＳＨＡＲＥＤ'];
    policy.extraction.factValueAliases['collision-b'] = ['shared'];
    await writeFile(file, JSON.stringify(policy));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const loaded = await loadAllConfig(root);
      expect(loaded.scaffoldPolicy.extraction.factValueAliases).toHaveProperty('collision-a');
      const messages = warning.mock.calls.flat().join('\n');
      expect(messages).toContain('shared');
      expect(messages).toContain('collision-a');
      expect(messages).toContain('collision-b');
    } finally {
      warning.mockRestore();
    }
  });

  it('derives one aggregate config digest from every config file', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const first = await loadAllConfig(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8')) as { title: string };
    trainingCase.title = 'Changed without bumping a declared version';
    await writeFile(caseFile, JSON.stringify(trainingCase));

    const second = await loadAllConfig(root);

    expect(second.configVersion).not.toBe(first.configVersion);
  });

  it('loads optional grouped-question metadata when its figure exists', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const file = path.join(root, 'config', 'pretest.json');
    const pretest = JSON.parse(await readFile(file, 'utf8'));
    pretest.questions[0].group = {
      id: 'exam-fixture',
      title: '高考真题',
      stimulus: '共享题干',
      figure: 'assets/cases/zinc-copper/schematic.png',
    };
    await writeFile(file, JSON.stringify(pretest));

    const loaded = await loadAllConfig(root);

    expect(loaded.pretest.questions[0]?.group).toEqual(pretest.questions[0].group);
  });

  it('rejects grouped-question metadata whose figure is missing', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const file = path.join(root, 'config', 'pretest.json');
    const pretest = JSON.parse(await readFile(file, 'utf8'));
    pretest.questions[0].group = {
      id: 'exam-fixture',
      title: '高考真题',
      stimulus: '共享题干',
      figure: 'assets/exam/missing.png',
    };
    await writeFile(file, JSON.stringify(pretest));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/pretest.json',
      field: 'questions.0.group.figure',
      reason: expect.stringContaining('missing'),
    });
  });

  it('hot-loads prompt markdown and derives its version from content', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const promptFile = path.join(root, 'prompts', 'test.md');
    const first = await loadAllPrompts(root);
    await writeFile(promptFile, 'Server-owned prompt v2');

    const second = await loadAllPrompts(root);

    expect(first.test.text).toBe('Server-owned prompt v1');
    expect(second.test.text).toBe('Server-owned prompt v2');
    expect(second.test.version).not.toBe(first.test.version);
  });

  it('reports the file, field, and reason for an invalid field', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const file = path.join(root, 'config', 'rubrics.json');
    const rubrics = JSON.parse(await readFile(file, 'utf8'));
    rubrics.rubrics[0].id = '';
    await writeFile(file, JSON.stringify(rubrics));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      name: 'ConfigValidationError',
      file: 'config/rubrics.json',
      field: expect.stringContaining('rubrics.0'),
      reason: expect.any(String),
    });
  });

  it('identifies missing and empty configuration files', async () => {
    const absentRoot = await createTemporaryDirectory();
    await expect(loadAllConfig(absentRoot)).rejects.toMatchObject({
      file: 'config',
      reason: expect.stringContaining('missing'),
    });

    const missingRoot = await createTemporaryDirectory();
    await mkdir(path.join(missingRoot, 'config'), { recursive: true });

    await expect(loadAllConfig(missingRoot)).rejects.toMatchObject({
      file: 'config/knowledge-model.json',
      reason: expect.stringContaining('missing'),
    });

    const emptyRoot = await createTemporaryDirectory();
    await writeValidContentTree(emptyRoot);
    await writeFile(path.join(emptyRoot, 'config', 'pretest.json'), '');

    await expect(loadAllConfig(emptyRoot)).rejects.toMatchObject({
      file: 'config/pretest.json',
      reason: expect.stringContaining('empty'),
    });
  });

  it('rejects unknown config keys instead of silently stripping them', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const file = path.join(root, 'config', 'knowledge-model.json');
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    value.typo = true;
    await writeFile(file, JSON.stringify(value));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/knowledge-model.json',
      reason: expect.stringContaining('Unrecognized key'),
    });
  });

  it.each([
    {
      name: 'duplicate ids',
      file: 'knowledge-model.json',
      mutate(value: any) {
        value.dimensions[1].id = value.dimensions[0].id;
      },
      field: 'dimensions.1.id',
      reason: 'duplicate',
    },
    {
      name: 'duplicate knowledge axes',
      file: 'knowledge-model.json',
      mutate(value: any) {
        value.dimensions[1].axis = value.dimensions[0].axis;
      },
      field: 'dimensions.1.axis',
      reason: 'duplicate axis',
    },
    {
      name: 'duplicate rule ids across rubrics',
      file: 'rubrics.json',
      mutate(value: any) {
        const duplicate = structuredClone(value.rubrics[1]);
        duplicate.id = 'rubric-second';
        duplicate.rules[0].id = value.rubrics[0].rules[0].id;
        value.rubrics.push(duplicate);
      },
      field: 'rubrics.15.rules.0.id',
      reason: 'duplicate id',
    },
    {
      name: 'rubric scores over their maximum',
      file: 'rubrics.json',
      mutate(value: any) {
        value.rubrics[0].rules[0].score = value.rubrics[0].maxScore + 1;
      },
      field: 'rubrics.0.rules.0.score',
      reason: 'maxScore',
    },
    {
      name: 'unknown builder component references',
      file: 'pretest.json',
      mutate(value: any) {
        value.builder.structuralRules[0].requiredComponentIds = ['missing-component'];
      },
      field: 'builder.structuralRules.0.requiredComponentIds.0',
      reason: 'unknown component',
    },
  ])('rejects $name', async ({ file, mutate, field, reason }) => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const absoluteFile = path.join(root, 'config', file);
    const value = JSON.parse(await readFile(absoluteFile, 'utf8'));
    mutate(value);
    await writeFile(absoluteFile, JSON.stringify(value));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      field,
      reason: expect.stringContaining(reason),
    });
  });

  it('rejects duplicate case ids across files', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const original = await readFile(path.join(root, 'config', 'cases', 'zinc-copper.json'), 'utf8');
    await writeFile(path.join(root, 'config', 'cases', 'duplicate.json'), original);

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: 'id',
      reason: expect.stringContaining('duplicate'),
    });
  });

  it('rejects an invalid configured electrode-equation equivalence entry', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    trainingCase.equationSets[0].accepted[0] = 'Zn + -> Zn^2+';
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: 'equationSets.0.accepted.0',
      reason: expect.stringContaining('equation-parse-miss'),
    });
  });

  it('requires exactly one negative, positive, and overall equation group', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    trainingCase.equationSets[2].electrode = 'positive';
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: expect.stringContaining('equationSets'),
      reason: expect.stringContaining('exactly one'),
    });
  });

  it('requires configured half reactions to merge into an accepted overall equation', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    const overall = trainingCase.equationSets.find((entry: { electrode: string }) =>
      entry.electrode === 'overall');
    overall.accepted = ['2H2 + O2 -> 2H2O'];
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: 'equationSets',
      reason: expect.stringContaining('do not match'),
    });
  });

  it('requires every case target to have deterministic evidence', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    trainingCase.evidencePaths = trainingCase.evidencePaths.filter(
      (entry: { nodeId: string }) => entry.nodeId !== 'E3',
    );
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: expect.stringContaining('targetNodeIds'),
      reason: expect.stringContaining('no evidence path'),
    });
  });

  it('rejects answer evidence that has no policy-readable fact requirements', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    const answerEvidence = trainingCase.evidencePaths.find(
      (entry: { source: string }) => entry.source === 'answer',
    );
    answerEvidence.factRequirements = [];
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: expect.stringContaining('factRequirements'),
      reason: expect.stringContaining('deterministic'),
    });
  });

  it('rejects answer evidence without node-specific tutoring reference points', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    const answerEvidence = trainingCase.evidencePaths.find(
      (entry: { source: string }) => entry.source === 'answer',
    );
    answerEvidence.referenceAnswerPoints = [];
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: expect.stringContaining('referenceAnswerPoints'),
      reason: expect.stringContaining('node-specific'),
    });
  });

  it('requires explicitly tutorable nodes to have a non-empty deterministic leak set', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8'));
    trainingCase.tutoring = [...(trainingCase.tutoring ?? []), { nodeId: 'P6' }];
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      file: 'config/cases/zinc-copper.json',
      field: expect.stringContaining('tutoring'),
      reason: expect.stringContaining('anti-leak'),
    });
  });

  it('rejects missing and escaping materialRef assets', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8')) as {
      materials: Array<{ materialRef: string | null; status: string }>;
    };
    trainingCase.materials[0].materialRef = 'assets/missing.png';
    trainingCase.materials[0].status = 'ready';
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      field: 'materials.0.materialRef',
      reason: expect.stringContaining('missing'),
    });

    trainingCase.materials[0].materialRef = '../outside.png';
    await writeFile(caseFile, JSON.stringify(trainingCase));
    await expect(loadAllConfig(root)).rejects.toMatchObject({
      field: 'materials.0.materialRef',
      reason: expect.stringContaining('assets/'),
    });
  });
});
