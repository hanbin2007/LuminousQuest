// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { App } from '../src/App';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';
import { createTrainingRuntime } from './helpers/training-runtime';

function installStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    } satisfies Storage,
  });
}

async function addMethaneTransferAndRubricChange(root: string) {
  const sourceFile = path.join(root, 'config', 'cases', 'zinc-copper.json');
  const methane = JSON.parse(await readFile(sourceFile, 'utf8'));
  methane.id = 'methane-fuel';
  methane.sequence = 2;
  methane.title = '甲烷燃料电池冷迁移';
  methane.caseType = 'transfer';
  methane.medium = 'acidic';
  methane.materials = [{
    id: 'apparatus',
    kind: 'apparatus-diagram',
    materialRef: 'assets/cases/methane-fuel/schematic.png',
    status: 'ready',
  }];
  methane.equationSets = [
    {
      id: 'methane-negative',
      electrode: 'negative',
      medium: 'acidic',
      expectedElectronSide: 'product',
      accepted: ['CH4 + 2H2O -> CO2 + 8H^+ + 8e^-'],
    },
    {
      id: 'oxygen-positive',
      electrode: 'positive',
      medium: 'acidic',
      expectedElectronSide: 'reactant',
      accepted: ['2O2 + 8H^+ + 8e^- -> 4H2O'],
    },
    {
      id: 'methane-overall',
      electrode: 'overall',
      medium: 'acidic',
      expectedElectronSide: 'none',
      accepted: ['CH4 + 2O2 -> CO2 + 2H2O'],
    },
  ];
  methane.tutoring = [];

  const assetDirectory = path.join(root, 'assets', 'cases', 'methane-fuel');
  await mkdir(assetDirectory, { recursive: true });
  await copyFile(
    path.join(process.cwd(), 'assets', 'cases', 'methane-fuel', 'schematic.png'),
    path.join(assetDirectory, 'schematic.png'),
  );
  await writeFile(
    path.join(root, 'config', 'cases', 'methane-fuel.json'),
    JSON.stringify(methane, null, 2),
  );

  const rubricFile = path.join(root, 'config', 'rubrics.json');
  const rubrics = JSON.parse(await readFile(rubricFile, 'utf8'));
  rubrics.version = 'rubrics.v1.2';
  rubrics.policy.weakness.threshold = 0.61;
  await writeFile(rubricFile, JSON.stringify(rubrics, null, 2));
}

afterEach(cleanup);

describe('AC2 config-only hot loading', () => {
  it('discovers an added acidic methane transfer case and runs it without rebuilding the app', async () => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });

    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const baselineRubricFile = path.join(root, 'config', 'rubrics.json');
    const baselineRubrics = JSON.parse(await readFile(baselineRubricFile, 'utf8'));
    baselineRubrics.version = 'rubrics.v1.1';
    baselineRubrics.policy.weakness.threshold = 0.6;
    await writeFile(baselineRubricFile, JSON.stringify(baselineRubrics, null, 2));
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken: 'ac2-test-token',
    });

    const beforeResponse = await app.request('/api/config');
    const before = await beforeResponse.json() as {
      configVersion: string;
      cases: Array<{ id: string }>;
      rubrics: { version: string; policy: { weakness: { threshold: number } } };
    };
    expect(before.cases.map((entry) => entry.id)).toEqual(['zinc-copper']);
    expect(before.rubrics.policy.weakness.threshold).toBe(0.6);

    await addMethaneTransferAndRubricChange(root);

    const afterResponse = await app.request('/api/config');
    const after = await afterResponse.json() as typeof before & {
      cases: Array<{
        id: string;
        caseType: string;
        medium: string;
        materials: Array<{ materialRef: string }>;
        tutoring: unknown[];
      }>;
    };
    expect(after.configVersion).not.toBe(before.configVersion);
    expect(after.rubrics).toMatchObject({
      version: 'rubrics.v1.2',
      policy: { weakness: { threshold: 0.61 } },
    });
    expect(after.cases[1]).toMatchObject({
      id: 'methane-fuel',
      caseType: 'transfer',
      medium: 'acidic',
      materials: [{ materialRef: 'assets/cases/methane-fuel/schematic.png' }],
      tutoring: [],
    });

    const config = await loadAllConfig(root);
    const { runtime } = createTrainingRuntime(config);
    const user = userEvent.setup();
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '锌铜原电池' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));
    await screen.findAllByText('答对了什么');
    await user.click(screen.getByRole('button', { name: '进入下一案例' }));

    expect(screen.getByRole('heading', { name: '甲烷燃料电池冷迁移' })).toBeInTheDocument();
    expect(screen.getByText('三级 · 冷迁移独立作答')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '请老师提示一下' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交冷迁移作答' }));

    expect(await screen.findByRole('heading', { name: '训练前后对比' })).toBeInTheDocument();
    expect(screen.getByText('前测未测')).toBeInTheDocument();
  });
});
