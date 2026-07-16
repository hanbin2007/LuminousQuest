// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { App } from '../src/App';
import { createTrainingRuntime, withTransferFixture } from './helpers/training-runtime';

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

describe('M3 cold-transfer flow', () => {
  beforeEach(() => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(cleanup);

  it('uses a fresh session, fixes transfer at level three, and withholds all coaching feedback', async () => {
    const user = userEvent.setup();
    const config = withTransferFixture(await loadAllConfig(process.cwd()));
    const { runtime, tutorTurn } = createTrainingRuntime(config);
    const view = render(<App initialConfig={config} runtime={runtime} />);

    for (const title of ['锌铜原电池', '碱性铝-空气电池', '酸性氢氧燃料电池']) {
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '提交案例作答' }));
      await screen.findAllByText('答对了什么');
      await user.click(screen.getByRole('button', { name: '进入下一案例' }));
    }

    expect(screen.getByRole('heading', { name: '陌生燃料电池' })).toBeInTheDocument();
    expect(screen.getByText('三级 · 冷迁移独立作答')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: '请老师提示一下' })).not.toBeInTheDocument();
    expect(screen.queryByText(/预设提示|预设回退/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '提交冷迁移作答' }));

    expect(await screen.findByRole('heading', { name: '训练前后对比' })).toBeInTheDocument();
    expect(screen.getByText('前测未测')).toBeInTheDocument();
    expect(screen.queryByText('答对了什么')).not.toBeInTheDocument();
    expect(view.container.querySelector('.training-electron-flow[data-active="true"]')).toBeNull();
    expect(tutorTurn).not.toHaveBeenCalled();
  });
});

