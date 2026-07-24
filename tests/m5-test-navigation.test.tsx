// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { App, type AppRuntime } from '../src/App';

function memoryStorage() {
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

function stubRuntime(config: Awaited<ReturnType<typeof loadAllConfig>>, testNavigation: boolean): AppRuntime {
  return {
    loadConfig: vi.fn(async () => config),
    getRuntimeState: vi.fn(async () => ({ executionMode: 'development' as const, testNavigation })),
    assessChoice: vi.fn(async () => ({ session: null })),
    extractAssessment: vi.fn(async () => ({ session: null })),
    assessEquation: vi.fn(async () => ({ session: null })),
    tutorTurn: vi.fn(async () => ({
      status: 'none' as const,
      reason: 'no-assessment' as const,
      session: null as never,
      assistance: { kind: 'none' as const, rounds: 0 },
      source: 'preset' as const,
      degraded: false,
    })),
    reviewDrawing: vi.fn(async () => '')
  };
}

describe('test-stage manual navigation', () => {
  beforeEach(() => {
    memoryStorage();
    window.history.replaceState({}, '', '/pretest');
  });

  afterEach(cleanup);

  it('exposes the flag from /api/runtime only when enabled and never under a demo lock', async () => {
    const config = await loadAllConfig(process.cwd());
    const base = { contentRoot: process.cwd(), clientRoot: process.cwd(), apiToken: 'token' };
    const off = createServerApp(base);
    const on = createServerApp({ ...base, testNavigation: true });
    const locked = createServerApp({ ...base, testNavigation: true, lockDemo: true });
    expect(config.cases.length).toBeGreaterThan(0);

    expect(await (await off.request('/api/runtime')).json()).toMatchObject({ testNavigation: false });
    expect(await (await on.request('/api/runtime')).json()).toMatchObject({ testNavigation: true });
    expect(await (await locked.request('/api/runtime')).json()).toMatchObject({ testNavigation: false });
  });

  it('hides the palette by default', async () => {
    const config = await loadAllConfig(process.cwd());
    render(<App initialConfig={config} runtime={stubRuntime(config, false)} />);

    expect(await screen.findByRole('heading', { name: '前测诊断' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '测试' })).not.toBeInTheDocument();
  });

  it('jumps across pretest stages and training cases through the palette', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    render(<App initialConfig={config} runtime={stubRuntime(config, true)} />);

    await user.click(await screen.findByRole('button', { name: '测试' }));
    await user.click(screen.getByRole('button', { name: '手绘' }));
    expect(await screen.findByRole('heading', { name: '手绘你的通用模型' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '测试' }));
    await user.click(screen.getByRole('button', { name: '案例2' }));
    // 训练页为懒加载路由:全量套件下首次 import 可超过 findBy 默认 1s,放宽避免偶发超时
    expect(await screen.findByRole('heading', { name: '思维模型训练' }, { timeout: 5000 })).toBeInTheDocument();
    const secondCase = [...config.cases].sort((a, b) => a.sequence - b.sequence)[1]!;
    expect(await screen.findByRole('heading', { name: secondCase.title }, { timeout: 5000 })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '测试' }));
    await user.click(screen.getByRole('button', { name: '冷迁移' }));
    expect(await screen.findByText(/冷迁移后测不显示即时对错/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it('loads the ready-made pretest fixture and lands on the manual Agent start', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const runtime = {
      ...stubRuntime(config, true),
      runAgentTurn: vi.fn(),
      submitAgentAnswer: vi.fn(),
    } as unknown as AppRuntime;
    render(<App initialConfig={config} runtime={runtime} />);

    await user.click(await screen.findByRole('button', { name: '课程与会话工具' }));
    await user.click(screen.getByRole('button', { name: '载入调试前测' }));

    expect(await screen.findByRole(
      'button',
      { name: '开始 Agent 对话' },
      { timeout: 5000 },
    )).toBeInTheDocument();
    expect(window.location.pathname).toBe('/training/zinc-copper');
    await waitFor(() => {
      expect(screen.getByRole('link', { name: '前测' }).closest('li'))
        .toHaveAttribute('data-complete', 'true');
    });
  });
});
