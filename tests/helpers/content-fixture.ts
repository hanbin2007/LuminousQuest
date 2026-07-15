import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const validConfigs = {
  'knowledge-model.json': {
    version: 'knowledge-model.v1',
    dimensions: [
      { id: 'device', label: '装置', axis: 'x' },
      { id: 'principle', label: '原理', axis: 'y' },
      { id: 'energy', label: '能量', axis: 'z' },
    ],
    nodes: [
      {
        id: 'D1',
        dimensionId: 'device',
        statement: '失电子场所是氧化半反应发生的场所。',
        misconceptions: ['把场所和反应物混为一谈'],
        weight: 2,
        position: { x: 0, y: 0, z: 0 },
        dependsOn: [],
      },
    ],
    edges: [],
  },
  'rubrics.json': {
    version: 'rubrics.v1',
    rubrics: [
      {
        id: 'rubric-d1',
        nodeId: 'D1',
        maxScore: 2,
        evidenceRequirements: ['指出氧化反应发生场所'],
        rules: [
          { id: 'd1-hit', outcome: 'hit', score: 2, description: '完整指出场所功能' },
          { id: 'd1-miss', outcome: 'miss', score: 0, description: '未建立对应' },
        ],
      },
    ],
  },
  'pretest.json': {
    version: 'pretest.v1',
    builder: {
      components: [{ id: 'electrode', label: '电极', kind: 'electrode' }],
      structuralRules: [{ id: 'has-electrode', description: '包含电极', requiredComponentIds: ['electrode'] }],
    },
    questions: [
      { id: 'q1', type: 'builder', prompt: '搭建通用模型', rubricIds: ['rubric-d1'] },
      { id: 'q2', type: 'text', prompt: '说明电子方向', rubricIds: ['rubric-d1'] },
      { id: 'q3', type: 'text', prompt: '说明能量转化', rubricIds: ['rubric-d1'] },
    ],
  },
  'scaffold-policy.json': {
    version: 'scaffold-policy.v1',
    levels: [
      { level: 1, label: '完整引导', promptCount: 4 },
      { level: 2, label: '部分引导', promptCount: 2 },
      { level: 3, label: '独立作答', promptCount: 0 },
    ],
    promotion: { consecutiveHits: 2 },
    demotion: { consecutiveMisses: 1 },
    selection: { weakNodeThreshold: 0.6, recentCaseWindow: 3 },
  },
};

const validCase = {
  version: 'case.v1',
  id: 'zinc-copper',
  title: '锌铜原电池',
  type: 'analysis',
  materialRefs: [],
  scaffold: [
    {
      level: 1,
      questions: ['失电子场所的材料是什么?'],
      answerPoints: ['锌是失电子场所'],
    },
  ],
  targetNodeIds: ['D1'],
};

export async function createTemporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'luminous-quest-test-'));
}

export async function writeValidContentTree(root: string) {
  const configRoot = path.join(root, 'config');
  const casesRoot = path.join(configRoot, 'cases');
  await mkdir(casesRoot, { recursive: true });

  await Promise.all(
    Object.entries(validConfigs).map(([file, value]) =>
      writeFile(path.join(configRoot, file), JSON.stringify(value)),
    ),
  );
  await writeFile(path.join(casesRoot, 'zinc-copper.json'), JSON.stringify(validCase));
}

