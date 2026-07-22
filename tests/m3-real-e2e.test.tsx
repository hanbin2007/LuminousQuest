// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { assembleGalvanicCell } from './helpers/assemble-cell';
import type { LLMProvider, LLMRequest } from '../server/llm/types';
import type { CaseConfig } from '../shared/config/schemas';
import type { StudentSession } from '../shared/session';
import { App } from '../src/App';
import { defaultRuntime } from '../src/runtime/api';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';

const apiToken = 'm3-real-e2e-token';
const routeTransitionTimeout = { timeout: 5_000 };

class TestSessionStore {
  readonly values = new Map<string, StudentSession>();
  get(id: string) { return this.values.get(id); }
  set(session: StudentSession) { this.values.set(session.id, session); }
}

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

async function addTrainingCases(root: string) {
  await Promise.all(['aluminum-air', 'hydrogen-oxygen'].map(async (caseId) => {
    const assetRoot = path.join(root, 'assets', 'cases', caseId);
    await mkdir(assetRoot, { recursive: true });
    await Promise.all([
      copyFile(
        path.join(process.cwd(), 'config', 'cases', `${caseId}.json`),
        path.join(root, 'config', 'cases', `${caseId}.json`),
      ),
      copyFile(
        path.join(process.cwd(), 'assets', 'cases', caseId, 'schematic.png'),
        path.join(assetRoot, 'schematic.png'),
      ),
      copyFile(
        path.join(process.cwd(), 'assets', 'cases', caseId, 'cross-section.png'),
        path.join(assetRoot, 'cross-section.png'),
      ),
    ]);
  }));
}

function evidence(answer: string, quote: string) {
  const start = answer.indexOf(quote);
  if (start < 0) throw new Error(`E2E answer does not contain ${quote}`);
  return { quote, start, end: start + quote.length };
}

function assessmentProvider(root: string, requests: LLMRequest[]): LLMProvider {
  return {
    id: 'm3-real-e2e-provider',
    async chat() { throw new Error('not used'); },
    async vision() { throw new Error('not used'); },
    async structured(request) {
      requests.push(request);
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
      return { content: JSON.stringify(value), structured: value, model: 'm3-real-e2e.v1' };
    },
  };
}

function answerText(trainingCase: CaseConfig) {
  return trainingCase.evidencePaths
    .filter((entry) => entry.source === 'answer')
    .flatMap((entry) => entry.factRequirements.map((requirement) => requirement.acceptedValues[0]))
    .join(' ');
}

function fillTrainingCase(trainingCase: CaseConfig) {
  const labels = {
    negative: '负极反应式',
    positive: '正极反应式',
    overall: '总反应式',
  } as const;
  const equationInputs = new Set<HTMLElement>();
  for (const equation of trainingCase.equationSets) {
    const input = screen.getByRole('textbox', { name: labels[equation.electrode] });
    equationInputs.add(input);
    fireEvent.change(input, { target: { value: equation.accepted[0] } });
  }
  for (const input of screen.getAllByRole('textbox')) {
    if (!equationInputs.has(input)) {
      fireEvent.change(input, { target: { value: answerText(trainingCase) } });
    }
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  globalThis.__LQ_API_TOKEN__ = undefined;
});

describe('real M3 route chain', () => {
  it('completes pretest, three training cases, and cold transfer through defaultRuntime and one Hono app', async () => {
    installStorage();
    window.history.replaceState({}, '', '/pretest');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root, { includeTransfer: true });
    await addTrainingCases(root);
    const requests: LLMRequest[] = [];
    const provider = assessmentProvider(root, requests);
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[provider.id, provider]]),
      sessions,
      workflow: { executionMode: 'live', provider: provider.id, model: 'm3-real-e2e.v1' },
    });
    installHonoFetch(app);
    const privateConfig = await loadAllConfig(root);
    const user = userEvent.setup();
    render(<App runtime={defaultRuntime} />);

    expect(await screen.findByRole(
      'heading',
      { name: '前测诊断' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    await assembleGalvanicCell(user);
    await user.click(screen.getByRole('button', { name: '提交搭建' }));

    await user.click(await screen.findByLabelText(/^A\./, {}, routeTransitionTimeout));
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    const zinc = privateConfig.cases.find((entry) => entry.id === 'zinc-copper')!;
    const pretestAnswer = `${answerText(zinc)} ${zinc.equationSets
      .map((entry) => entry.accepted[0]).join('；')}`;
    fireEvent.change(await screen.findByLabelText('简答作答', {}, routeTransitionTimeout), {
      target: { value: pretestAnswer },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));
    await user.click(await screen.findByLabelText(/^A\./, {}, routeTransitionTimeout));
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    const examChoicePrompts = [
      /电极 a、b 分别为什么极/,
      /外电路中电子的流向/,
      /消耗 K 与消耗 O₂/,
    ];
    for (const prompt of examChoicePrompts) {
      await screen.findByText(prompt, {}, routeTransitionTimeout);
      await user.click(await screen.findByLabelText(/^A\./, {}, routeTransitionTimeout));
      await user.click(screen.getByRole('button', { name: '提交作答' }));
    }
    await screen.findByText(/隔膜能否通过 O₂/, {}, routeTransitionTimeout);
    fireEvent.change(await screen.findByLabelText('简答作答', {}, routeTransitionTimeout), {
      target: { value: '不能。防止 K 与 O₂ 直接反应，两个半反应必须分隔在两个场所。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));
    await user.click(await screen.findByRole(
      'button',
      { name: '跳过手绘，查看诊断' },
      routeTransitionTimeout,
    ));
    expect(await screen.findByRole(
      'heading',
      { name: '诊断结果' },
      routeTransitionTimeout,
    )).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '训练' }));
    for (const trainingCase of privateConfig.cases.filter((entry) => entry.caseType === 'training')) {
      expect(await screen.findByRole(
        'heading',
        { name: trainingCase.title },
        routeTransitionTimeout,
      )).toBeInTheDocument();
      fillTrainingCase(trainingCase);
      fireEvent.click(screen.getByRole('button', { name: '提交案例作答' }));
      expect(await screen.findByText(
        '本案例达到过关条件',
        {},
        routeTransitionTimeout,
      )).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '进入下一案例' }));
    }

    const transferCase = privateConfig.cases.find((entry) => entry.caseType === 'transfer')!;
    expect(await screen.findByRole(
      'heading',
      { name: transferCase.title },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    fillTrainingCase(transferCase);
    fireEvent.click(screen.getByRole('button', { name: '提交冷迁移作答' }));
    expect(await screen.findByRole(
      'heading',
      { name: '训练前后对比' },
      routeTransitionTimeout,
    )).toBeInTheDocument();

    expect(requests.length).toBeGreaterThanOrEqual(5);
    expect(requests.every((request) => request.prompt.id === 'structured-assessment')).toBe(true);
    const serverSession = [...sessions.values.values()][0]!;
    const stageIds = new Set(serverSession.events.map((event) => event.stageId));
    expect(stageIds).toEqual(new Set(['assessment', 'training', 'transfer']));
    expect(new Set(serverSession.events.map((event) => event.caseId))).toEqual(new Set([
      'pretest',
      'zinc-copper',
      'aluminum-air',
      'hydrogen-oxygen',
      'methane-fuel',
    ]));
  }, 15_000);
});
