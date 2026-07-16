// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import type { LLMProvider } from '../server/llm/types';
import { App } from '../src/App';
import { defaultRuntime } from '../src/runtime/api';

const apiToken = 'm4-runbook-e2e-token';
const routeTransitionTimeout = { timeout: 5_000 };

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

beforeEach(() => {
  installStorage();
  window.history.replaceState({}, '', '/pretest');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.__LQ_API_TOKEN__ = undefined;
});

describe('M4.2 competition runbook click path', () => {
  it('follows the documented labels through the real routes from the versioned demo start', async () => {
    const runbook = await readFile(
      path.join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-07-16-competition-runbook.md'),
      'utf8',
    );
    for (const literal of ['演示回放', '请老师提示一下', '单生证据', '班级汇总', '/model']) {
      expect(runbook).toContain(literal);
    }
    const provider: LLMProvider = {
      id: 'offline-provider-spy',
      chat: vi.fn(async () => { throw new Error('demo must not call chat'); }),
      vision: vi.fn(async () => { throw new Error('demo must not call vision'); }),
      structured: vi.fn(async () => { throw new Error('demo must not call structured'); }),
    };
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'offline-v1' },
      lockDemo: true,
      apiToken,
    });
    installHonoFetch(app);
    const png = await readFile(path.join(
      process.cwd(),
      'tests',
      'fixtures',
      'red-team',
      'hand-drawing-prompt-injection.png',
    ));
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue(`data:image/png;base64,${png.toString('base64')}`);
    const classSources = await Promise.all([1, 2, 3].map((index) =>
      readFile(path.join(
        process.cwd(),
        'recordings',
        'demo',
        'class',
        `student-${String(index).padStart(2, '0')}.json`,
      ), 'utf8')));
    const user = userEvent.setup();

    render(<App runtime={defaultRuntime} />);
    const demoSwitch = await screen.findByRole(
      'switch',
      { name: '演示回放' },
      routeTransitionTimeout,
    );
    expect(await screen.findByText(
      'executionMode=demo',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(demoSwitch).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('link', { name: '训练' }));
    expect(await screen.findByRole(
      'heading',
      { name: '本轮证据批注' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByText('先定位发生氧化的场所，再沿外电路检查你写的方向。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '请老师提示一下' }));
    expect(await screen.findByText(
      '回到你写的路径，检查载流粒子经过的是外电路还是内电路，并说明依据。',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByText('第 2 / 3 轮')).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '前测' }));
    expect(await screen.findByRole(
      'heading',
      { name: '手绘你的通用模型' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交手绘点评' }));
    expect(await screen.findByText(
      '失电子场所和得电子场所已经分开；请再检查外电路与内电路的载流粒子标注是否各自清楚。',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '教师视图' }));
    expect(await screen.findByRole(
      'heading',
      { name: '诊断证据链' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /P4 分数/u })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '班级汇总' }));
    await user.upload(
      screen.getByLabelText('批量导入班级会话 JSON'),
      classSources.map((source, index) => new File(
        [source],
        `private-student-name-${index + 1}.json`,
        { type: 'application/json' },
      )),
    );
    expect(await screen.findByText(
      '3 名学生参与汇总',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.queryByText(/private-student-name/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '外显' }));
    expect(await screen.findByRole(
      'heading',
      { name: '电化学统一认知模型' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(window.location.pathname).toBe('/model');
    expect(provider.chat).not.toHaveBeenCalled();
    expect(provider.vision).not.toHaveBeenCalled();
    expect(provider.structured).not.toHaveBeenCalled();
  }, 20_000);
});
