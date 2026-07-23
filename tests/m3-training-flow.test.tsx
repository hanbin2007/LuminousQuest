// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { App } from '../src/App';
import { createTrainingRuntime, withImmediatePromotion } from './helpers/training-runtime';

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

async function fillVisibleAnswers(user: ReturnType<typeof userEvent.setup>) {
  for (const textbox of screen.getAllByRole('textbox')) {
    await user.type(textbox, '作答');
  }
}

describe('M3 training flow', () => {
  beforeEach(() => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(cleanup);

  it('runs all three scaffold presentations through the mock assessment provider', async () => {
    const user = userEvent.setup();
    const config = withImmediatePromotion(await loadAllConfig(process.cwd()));
    const { runtime, extractAssessment, assessEquation } = createTrainingRuntime(config);

    const view = render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '思维模型训练' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '锌铜原电池' })).toBeInTheDocument();
    expect(screen.getByText('一级 · 完整引导')).toBeInTheDocument();
    expect(screen.getAllByText('D5 · 场所与反应物四连问')).toHaveLength(4);
    // 一级脚手架逐题字段(限定作答区,避免命中实时认知模型面板的节点芯片)
    const answerFields = within(view.container.querySelector('.training-answer-fields') as HTMLElement);
    expect(answerFields.getByText('P2')).toBeInTheDocument();
    expect(answerFields.getByText('P3')).toBeInTheDocument();
    expect(answerFields.getByText('P4')).toBeInTheDocument();
    expect(answerFields.getByText('P5')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '锌铜原电池 装置简图' })).toHaveAttribute(
      'src',
      '/assets/cases/zinc-copper/schematic.png',
    );
    expect(screen.getAllByLabelText('方程式符号条')).toHaveLength(3);

    await fillVisibleAnswers(user);
    await user.click(screen.getAllByRole('button', { name: '插入 e⁻' })[0]!);
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));

    expect(await screen.findAllByText('答对了什么')).not.toHaveLength(0);
    expect(view.container.querySelector('.training-electron-flow[data-active="true"]')).not.toBeNull();
    expect(screen.getByText('连续 1 次无辅助答对，下一案例进入二级脚手架。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '进入下一案例' }));

    expect(await screen.findByRole('heading', { name: '碱性铝-空气电池' })).toBeInTheDocument();
    expect(screen.getByText('二级 · 三维度标题')).toBeInTheDocument();
    expect(screen.getByLabelText('装置维度作答')).toBeInTheDocument();
    expect(screen.getByLabelText('原理维度作答')).toBeInTheDocument();
    expect(screen.getByLabelText('能量维度作答')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看结构剖面' })).not.toBeInTheDocument();

    await fillVisibleAnswers(user);
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));
    expect(await screen.findByText('连续 1 次无辅助答对，下一案例进入三级脚手架。')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/training/aluminum-air');
    await user.click(screen.getByRole('button', { name: '查看结构剖面' }));
    expect(window.location.pathname).toBe('/training/aluminum-air');
    expect(await screen.findByRole('img', { name: '碱性铝-空气电池 结构剖面图' })).toHaveAttribute(
      'src',
      '/assets/cases/aluminum-air/cross-section.png',
    );
    await user.click(screen.getByRole('button', { name: '进入下一案例' }));

    expect(await screen.findByRole('heading', { name: '酸性氢氧燃料电池' })).toBeInTheDocument();
    expect(screen.getByText('三级 · 独立作答')).toBeInTheDocument();
    expect(screen.getByLabelText('独立分析')).toBeInTheDocument();
    await fillVisibleAnswers(user);
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));

    expect(await screen.findByText('三个训练案例已完成')).toBeInTheDocument();
    expect(extractAssessment).toHaveBeenCalledTimes(3);
    expect(assessEquation).toHaveBeenCalledTimes(9);
  });

  it('shows per-section completion and locates the first missing response', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const { runtime } = createTrainingRuntime(config);
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByText('本案例完成度')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: /本案例已完成/ });
    expect(progress).toHaveAttribute('value', '0');
    const firstAnswer = screen.getAllByRole('textbox')[0]!;
    await user.click(screen.getByRole('button', { name: /定位未完成项/ }));
    expect(firstAnswer).toHaveFocus();
    await user.type(firstAnswer, '作答');
    expect(progress).toHaveAttribute('value', '1');
  });

  it('does not expose the next case until the shared case-pass policy passes', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const { runtime } = createTrainingRuntime(config, { outcome: 'miss' });
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '锌铜原电池' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));

    expect(await screen.findByText('尚未达到本案例过关条件')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '进入下一案例' })).not.toBeInTheDocument();
  });

  it('closes a final tutor round and distinguishes replay degradation from a preset fallback', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const { runtime } = createTrainingRuntime(config, {
      outcome: 'miss',
      tutorFinalRound: true,
      tutorSource: 'development-cache',
    });
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '锌铜原电池' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));
    const trigger = (await screen.findAllByRole('button', { name: '请老师提示一下' }))[0]!;
    const feedbackItem = trigger.closest<HTMLElement>('.training-feedback-item')!;
    await user.click(trigger);

    expect(await within(feedbackItem).findByText(config.scaffoldPolicy.socratic.fallback.closing))
      .toBeInTheDocument();
    expect(within(feedbackItem).getByText('回放降级')).toBeInTheDocument();
    expect(within(feedbackItem).queryByRole('button', { name: '请老师提示一下' }))
      .not.toBeInTheDocument();
  });
});
