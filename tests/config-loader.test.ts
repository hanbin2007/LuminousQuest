import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigValidationError, loadAllConfig } from '../server/config/loader';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

describe('configuration loading', () => {
  it('loads the complete valid external configuration tree', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);

    const loaded = await loadAllConfig(root);

    expect(loaded.knowledgeModel.version).toBe('knowledge-model.v1');
    expect(loaded.pretest.questions).toHaveLength(3);
    expect(loaded.cases).toHaveLength(1);
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
});
