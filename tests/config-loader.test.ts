import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadAllConfig } from '../server/config/loader';
import { loadAllPrompts } from '../server/prompts/loader';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

describe('configuration loading', () => {
  it('loads the complete valid external configuration tree', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);

    const loaded = await loadAllConfig(root);

    expect(loaded.knowledgeModel.version).toBe('knowledge-model.v1');
    expect(loaded.pretest.questions).toHaveLength(3);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.configVersion).toMatch(/^sha256:[a-f0-9]{64}$/);
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
    await writeFile(
      path.join(root, 'config', 'rubrics.json'),
      JSON.stringify({ version: 'rubrics.v1', rubrics: [{ id: '', nodeId: 'D1' }] }),
    );

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
        value.rubrics.push({
          ...value.rubrics[0],
          id: 'rubric-second',
          rules: [{ ...value.rubrics[0].rules[0] }],
        });
      },
      field: 'rubrics.1.rules.0.id',
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

  it('rejects missing and escaping materialRef assets', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const caseFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
    const trainingCase = JSON.parse(await readFile(caseFile, 'utf8')) as { materialRefs: string[] };
    trainingCase.materialRefs = ['assets/missing.png'];
    await writeFile(caseFile, JSON.stringify(trainingCase));

    await expect(loadAllConfig(root)).rejects.toMatchObject({
      field: 'materialRefs.0',
      reason: expect.stringContaining('missing'),
    });

    trainingCase.materialRefs = ['../outside.png'];
    await writeFile(caseFile, JSON.stringify(trainingCase));
    await expect(loadAllConfig(root)).rejects.toMatchObject({
      field: 'materialRefs.0',
      reason: expect.stringContaining('assets/'),
    });
  });
});
