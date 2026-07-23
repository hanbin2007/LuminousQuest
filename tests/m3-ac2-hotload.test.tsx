// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import type { CaseConfig } from '../shared/config/schemas';
import type { AssessmentCompletedEvent, StudentSession } from '../shared/session';
import { App } from '../src/App';
import { defaultRuntime } from '../src/runtime/api';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'ac2', '7e9fd74');
const apiToken = 'ac2-test-token';
const routeTransitionTimeout = { timeout: 5_000 };
const historicalRubricPatch = `diff --git a/config/rubrics.json b/config/rubrics.json
index 4d5042b..71c37e1 100644
--- a/config/rubrics.json
+++ b/config/rubrics.json
@@ -53,7 +53,7 @@
       }
     },
     "weakness": {
-      "threshold": 0.6,
+      "threshold": 0.61,
       "partialVisualization": "half-lit"
     },
     "repeatedAnswers": {
`;

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

function installHonoFetch(app: ReturnType<typeof createServerApp>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input.url : input.toString();
    const url = new URL(source, 'http://localhost');
    return app.request(`${url.pathname}${url.search}`, init);
  }));
}

async function writeThreeCaseBaseline(root: string) {
  const baselineCases = ['aluminum-air', 'hydrogen-oxygen'] as const;
  await Promise.all(baselineCases.map(async (caseId) => {
    const assetRoot = path.join(root, 'assets', 'cases', caseId);
    await mkdir(assetRoot, { recursive: true });
    await Promise.all([
      copyFile(
        path.join(process.cwd(), 'config', 'cases', `${caseId}.json`),
        path.join(root, 'config', 'cases', `${caseId}.json`),
      ),
      ...['schematic.png', 'cross-section.png'].map((asset) => copyFile(
        path.join(process.cwd(), 'assets', 'cases', caseId, asset),
        path.join(assetRoot, asset),
      )),
    ]);
  }));
  const rubricFile = path.join(root, 'config', 'rubrics.json');
  const rubrics = JSON.parse(await readFile(rubricFile, 'utf8'));
  rubrics.policy.weakness.threshold = 0.6;
  await writeFile(rubricFile, `${JSON.stringify(rubrics, null, 2)}\n`);
}

async function applyHistoricalAc2Change(root: string) {
  const methaneSource = await readFile(path.join(fixtureRoot, 'methane-fuel.json'), 'utf8');
  const rubricPatch = await readFile(path.join(fixtureRoot, 'rubrics.patch'), 'utf8');
  if (rubricPatch !== historicalRubricPatch) throw new Error('AC2 rubric patch fixture drifted');
  await writeFile(path.join(root, 'config', 'cases', 'methane-fuel.json'), methaneSource);
  const assetDirectory = path.join(root, 'assets', 'cases', 'methane-fuel');
  await mkdir(assetDirectory, { recursive: true });
  await copyFile(
    path.join(process.cwd(), 'assets', 'cases', 'methane-fuel', 'schematic.png'),
    path.join(assetDirectory, 'schematic.png'),
  );
  const rubricFile = path.join(root, 'config', 'rubrics.json');
  const rubrics = JSON.parse(await readFile(rubricFile, 'utf8'));
  if (rubrics.policy.weakness.threshold !== 0.6) throw new Error('AC2 baseline threshold drifted');
  rubrics.policy.weakness.threshold = 0.61;
  await writeFile(rubricFile, `${JSON.stringify(rubrics, null, 2)}\n`);
}

function evidence(answer: string, quote: string) {
  const start = answer.indexOf(quote);
  if (start < 0) throw new Error(`AC2 answer does not contain ${quote}`);
  return { quote, start, end: start + quote.length };
}

function faithfulAssessmentProvider(root: string): LLMProvider {
  return {
    id: 'ac2-provider',
    async chat() { throw new Error('not used'); },
    async vision() { throw new Error('not used'); },
    async structured(request: LLMRequest) {
      if (request.prompt.id === 'llm-health') {
        return { content: '{"ok":true}', structured: { ok: true }, model: 'ac2.v1' };
      }
      if (request.prompt.id !== 'structured-assessment') throw new Error('unexpected prompt');
      const input = request.input as {
        answer: string;
        caseId: string;
        targetNodeIds: string[];
        assistance: { kind: 'none' | 'hint' | 'socratic'; rounds: number };
      };
      const config = await loadAllConfig(root);
      const trainingCase = config.cases.find((entry) => entry.id === input.caseId)!;
      const assessments = input.targetNodeIds.map((nodeId) => {
        const pathConfig = trainingCase.evidencePaths.find((entry) =>
          entry.nodeId === nodeId && entry.source === 'answer')!;
        return {
          nodeId,
          errorIds: [],
          facts: {
            response: 'substantive',
            terminology: 'model',
            syllabus: 'within',
            contradiction: false,
            typo: 'none',
            slots: pathConfig.factRequirements.map((requirement) => {
              const value = requirement.acceptedValues[0];
              return { id: requirement.id, value, evidence: evidence(input.answer, value) };
            }),
          },
          evidence: [{ quote: input.answer, start: 0, end: input.answer.length }],
          assistance: input.assistance,
        };
      });
      const value = { anchors: [], assessments };
      return { content: JSON.stringify(value), structured: value, model: 'ac2-provider.v1' };
    },
  };
}

function answerText(trainingCase: CaseConfig) {
  return trainingCase.evidencePaths
    .filter((entry) => entry.source === 'answer')
    .flatMap((entry) => entry.factRequirements.flatMap((requirement) => requirement.acceptedValues[0]))
    .join(' ');
}

function fillCase(trainingCase: CaseConfig) {
  const equationLabels = {
    negative: '负极反应式',
    positive: '正极反应式',
    overall: '总反应式',
  } as const;
  const equationInputs = new Set<HTMLElement>();
  for (const equationSet of trainingCase.equationSets) {
    const input = screen.getByRole('textbox', { name: equationLabels[equationSet.electrode] });
    equationInputs.add(input);
    fireEvent.change(input, { target: { value: equationSet.accepted[0] } });
  }
  for (const input of screen.getAllByRole('textbox')) {
    if (!equationInputs.has(input)) {
      fireEvent.change(input, { target: { value: answerText(trainingCase) } });
    }
  }
}

function rawEquationAssessment(session: StudentSession, attemptId: string) {
  return [...session.events].reverse().find((event): event is AssessmentCompletedEvent =>
    event.kind === 'assessment.completed'
    && event.attemptId === attemptId
    && event.ruleDecision.status !== 'unanswered'
    && 'engine' in event.ruleDecision
    && event.ruleDecision.engine.id === 'equation-scoring');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.__LQ_API_TOKEN__ = undefined;
});

describe('AC2 config-only hot loading', () => {
  it('replays the exact 7e9fd74 fixture through frozen defaultRuntime and one Hono app', async () => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    await writeThreeCaseBaseline(root);
    const provider = faithfulAssessmentProvider(root);
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'ac2-provider.v1' },
    });
    installHonoFetch(app);

    const before = await defaultRuntime.loadConfig();
    expect(before.cases.map((entry) => entry.id)).toEqual([
      'zinc-copper',
      'aluminum-air',
      'hydrogen-oxygen',
    ]);
    expect(before.rubrics.policy.weakness.threshold).toBe(0.6);

    await applyHistoricalAc2Change(root);

    const methaneSource = await readFile(path.join(fixtureRoot, 'methane-fuel.json'));
    expect(createHash('sha256').update(methaneSource).digest('hex'))
      .toBe('483b3ecb760e8ddda5dd5d199e2ed9cc3ce1b667821d9f1f598789c6dacb99d9');
    const after = await defaultRuntime.loadConfig();
    expect(after.configVersion).not.toBe(before.configVersion);
    expect(after.rubrics.policy.weakness.threshold).toBe(0.61);
    expect(after.cases.map((entry) => entry.id)).toEqual([
      'zinc-copper',
      'aluminum-air',
      'hydrogen-oxygen',
      'methane-fuel',
    ]);
    expect(after.cases[3]).toMatchObject({
      id: 'methane-fuel',
      caseType: 'transfer',
      medium: 'acidic',
      materials: [{ materialRef: 'assets/cases/methane-fuel/schematic.png' }],
      tutoring: [],
    });

    const privateConfig = await loadAllConfig(root);
    render(<App runtime={defaultRuntime} />);
    for (const trainingCase of privateConfig.cases.filter((entry) => entry.caseType === 'training')) {
      expect(await screen.findByRole(
        'heading',
        { name: trainingCase.title },
        routeTransitionTimeout,
      )).toBeInTheDocument();
      fillCase(trainingCase);
      fireEvent.click(screen.getByRole('button', { name: '提交案例作答' }));
      expect(await screen.findByRole(
        'button',
        { name: '进入下一案例' },
        routeTransitionTimeout,
      )).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '进入下一案例' }));
    }

    const methane = privateConfig.cases.find((entry) => entry.id === 'methane-fuel')!;
    expect(await screen.findByRole(
      'heading',
      { name: '酸性甲烷燃料电池冷迁移' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByText('三级 · 冷迁移独立作答')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '请老师提示一下' })).not.toBeInTheDocument();
    fillCase(methane);
    fireEvent.click(screen.getByRole('button', { name: '提交冷迁移作答' }));
    expect(await screen.findByRole(
      'heading',
      { name: '训练前后对比' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByText('前测未测')).toBeInTheDocument();
  }, 15_000);

  it('scores equivalent, multiplied, and near-error methane equations through the real route', async () => {
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    await writeThreeCaseBaseline(root);
    await applyHistoricalAc2Change(root);
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
    });
    installHonoFetch(app);
    await defaultRuntime.loadConfig();
    const cases = [
      ['equivalent', 'CH4 + 2H2O -> 8e^- + CO2 + 8H^+', 'hit'],
      ['multiple', '2CH4 + 4H2O -> 2CO2 + 16H^+ + 16e^-', 'hit'],
      ['near-error', 'CH4 + 2H2O -> CO2 + 5H^+ + 6e^-', 'miss'],
    ] as const;

    for (const [name, equation, expected] of cases) {
      const result = await defaultRuntime.assessEquation({
        sessionId: `ac2-route-${name}`,
        caseId: 'methane-fuel',
        equationSetId: 'methane-negative',
        equation,
        submissionId: `attempt-${name}`,
      });
      expect(rawEquationAssessment(result.session!, `attempt-${name}`)).toMatchObject({
        ruleDecision: { status: expected },
        score: { outcome: expected },
      });
    }
  });
});
