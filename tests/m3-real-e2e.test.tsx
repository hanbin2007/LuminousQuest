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
import { withoutAgentConversation } from './helpers/training-runtime';

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
      if (request.prompt.id === 'llm-health') {
        return { content: '{"ok":true}', structured: { ok: true }, model: 'm3-real-e2e.v1' };
      }
      requests.push(request);
      if (request.prompt.id === 'direct-assessment') {
        const input = request.input as {
          answer: string;
          nodes: Array<{ id: string }>;
        };
        const value = {
          assessments: input.nodes.map((node) => ({
            nodeId: node.id,
            verdict: 'hit',
            misconceptionIds: [],
            rationale: `${node.id} is supported by the submitted answer.`,
            confidence: 0.99,
            reviewReason: null,
            evidence: [{ quote: input.answer, start: 0, end: input.answer.length }],
          })),
        };
        return { content: JSON.stringify(value), structured: value, model: 'm3-real-e2e.v1' };
      }
      const input = request.input as {
        answer: string;
        caseId: string;
        targetNodeIds: string[];
        assistance: { kind: 'none' | 'hint' | 'socratic'; rounds: number };
      };
      const config = await loadAllConfig(root);
      const trainingCase = config.cases.find((entry) => entry.id === input.caseId)!;
      const assessments = input.targetNodeIds.map((nodeId) => {
        if (input.answer.includes('CuO 将葡萄糖氧化')) {
          const q4Slots = {
            D5: [
              { id: 'cuo-role', value: 'catalyst', evidence: evidence(input.answer, '催化作用') },
              {
                id: 'cuo-regenerated',
                value: 'cuo-regenerated',
                evidence: evidence(input.answer, '又生成'),
              },
            ],
            P2: [{
              id: 'glucose-oxidized',
              value: 'glucose-oxidized',
              evidence: evidence(input.answer, '将葡萄糖氧化'),
            }],
          } as const;
          return {
            nodeId,
            errorIds: [],
            facts: {
              response: 'substantive',
              terminology: 'model',
              syllabus: 'within',
              contradiction: false,
              typo: 'none',
              slots: q4Slots[nodeId as keyof typeof q4Slots],
            },
            evidence: [{ quote: input.answer, start: 0, end: input.answer.length }],
            assistance: input.assistance,
          };
        }
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
    render(<App runtime={withoutAgentConversation(defaultRuntime)} />);

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
    fireEvent.change(await screen.findByLabelText(
      '电极 a 的极性',
      {},
      routeTransitionTimeout,
    ), { target: { value: '负' } });
    fireEvent.change(screen.getByLabelText('电极 b 的极性'), {
      target: { value: '正' },
    });
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      '电子流出电极',
      {},
      routeTransitionTimeout,
    ), { target: { value: 'a' } });
    fireEvent.change(screen.getByLabelText('电子流入电极'), {
      target: { value: 'b' },
    });
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      'K 与 O₂ 的物质的量之比',
      {},
      routeTransitionTimeout,
    ), { target: { value: '1:1' } });
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    await screen.findByText(/隔膜能否通过 O₂/, {}, routeTransitionTimeout);
    fireEvent.change(await screen.findByLabelText('简答作答', {}, routeTransitionTimeout), {
      target: { value: '不能。防止 K 与 O₂ 直接反应，两个半反应必须分隔在两个场所。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      '电极 a 的极性',
      {},
      routeTransitionTimeout,
    ), { target: { value: '正' } });
    fireEvent.change(screen.getByLabelText('电极 b 的极性'), {
      target: { value: '负' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText('简答作答', {}, routeTransitionTimeout), {
      target: { value: 'O₂ + 2H₂O + 4e⁻ = 4OH⁻' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      'b 电极的电极材料',
      {},
      routeTransitionTimeout,
    ), { target: { value: 'CuO' } });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      'b 电极实际失电子的物质',
      {},
      routeTransitionTimeout,
    ), { target: { value: 'Cu₂O' } });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText('简答作答', {}, routeTransitionTimeout), {
      target: {
        value: 'CuO 将葡萄糖氧化为葡萄糖酸，自身被还原为 Cu₂O；Cu₂O 在 b 电极失电子又生成 CuO；CuO 起催化作用。',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    fireEvent.change(await screen.findByLabelText(
      'a 电极流入电子的物质的量',
      {},
      routeTransitionTimeout,
    ), { target: { value: '2×10⁻¹' } });
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
    expect(new Set(requests.map((request) => request.prompt.id))).toEqual(new Set([
      'direct-assessment',
      'structured-assessment',
    ]));
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
