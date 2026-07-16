// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { App } from '../src/App';
import { createTrainingRuntime } from './helpers/training-runtime';

const injectedFailures = [
  'timeout',
  'http-error',
  'schema-invalid',
  'action-not-allowed',
  'unsafe-content',
  'demo-step-missing',
] as const;

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

describe('M3 tutor fault injection through the training UI', () => {
  beforeEach(() => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(cleanup);

  it.each(injectedFailures)('shows the visible preset fallback for %s', async (reason) => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const { runtime, tutorTurn } = createTrainingRuntime(config, { outcome: 'miss', tutorReason: reason });
    render(<App initialConfig={config} runtime={runtime} />);

    await screen.findByRole('heading', { name: '锌铜原电池' });
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));
    const promptButtons = await screen.findAllByRole('button', { name: '请老师提示一下' });
    await user.click(promptButtons[0]!);

    expect(await screen.findByText('先判断当前节点里的对象，再说明方向依据。')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 3 轮')).toBeInTheDocument();
    expect(screen.getByText('预设回退')).toBeInTheDocument();
    expect(screen.getByText(`故障状态：${reason}`)).toBeInTheDocument();
    expect(tutorTurn).toHaveBeenCalledTimes(1);
  });
});
