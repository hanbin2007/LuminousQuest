// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { LocalSessionStore } from '../shared/session/local-storage';
import { createSession, exportSession, sessionConfigVersions } from '../shared/session/session';
import { App, type AppRuntime } from '../src/App';
import { recordChoiceAssessment } from '../src/features/pretest/choice-assessment';
import { QuestionCard } from '../src/features/pretest/QuestionCard';

describe('M2 pretest route', () => {
  beforeEach(() => {
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
    window.history.replaceState({}, '', '/pretest');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty('--dur-eflow-answer');
    document.documentElement.style.removeProperty('--delay-eflow-answer');
  });

  it('submits a pretest choice without revealing whether it is correct', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((candidate) => candidate.type === 'choice');
    if (!question || question.type !== 'choice') throw new Error('Expected a configured choice question');
    const onSubmit = vi.fn();
    const view = render(
      <QuestionCard
        question={question}
        dimensionLabel="原理"
        onAnswerChange={() => undefined}
        answer={question.options.find((option) => option.correct)?.id}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '提交作答' }));

    expect(view.container.querySelector('.question-card')).not.toHaveClass('question-card--correct');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('uses the configured dimension label and does not infer judgment type from two options', async () => {
    const config = await loadAllConfig(process.cwd());
    const configured = config.pretest.questions.find((question) => question.type === 'choice');
    if (!configured || configured.type !== 'choice') throw new Error('Expected a choice question');
    const question = {
      ...configured,
      dimensionId: 'device' as const,
      options: configured.options.slice(0, 2),
    };
    render(
      <QuestionCard
        question={question}
        dimensionLabel="装置"
        onAnswerChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByText('装置')).toBeInTheDocument();
    expect(screen.getByText('选择题')).toBeInTheDocument();
    expect(screen.queryByText('判断题')).not.toBeInTheDocument();
  });

  it('completes builder, three configured questions, and reaches traceable diagnosis under a mock runtime', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
      assessChoice: vi.fn(async () => ({ session: null })),
      extractAssessment: vi.fn(async () => ({ session: null })),
      reviewDrawing: vi.fn(async () => '线条清楚；再检查电子路径与离子路径是否分别闭合。'),
    };
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '前测诊断' })).toBeInTheDocument();
    for (const label of [
      '导体棒 A',
      '金属连接件',
      '可导电液体或离子通道',
      '导体棒 B',
      '电子方向箭头',
      '阳离子方向箭头',
      '阴离子方向箭头',
    ]) {
      await user.click(screen.getByRole('button', { name: `添加 ${label}` }));
    }

    const canvas = screen.getByTestId('builder-canvas');
    const node = (label: string) => within(canvas).getByRole('button', {
      name: new RegExp(`画布组件.*${label}`),
    });
    await user.selectOptions(screen.getByLabelText('导体棒 A 的功能角色'), 'oxidation-site');
    await user.selectOptions(screen.getByLabelText('金属连接件 的功能角色'), 'electron-conductor');
    await user.selectOptions(screen.getByLabelText('可导电液体或离子通道 的功能角色'), 'ion-conductor');
    await user.selectOptions(screen.getByLabelText('导体棒 B 的功能角色'), 'reduction-site');
    await user.click(screen.getByRole('button', { name: '电子路径' }));
    await user.click(node('导体棒 A'));
    await user.click(node('金属连接件'));
    await user.click(node('金属连接件'));
    await user.click(node('导体棒 B'));
    await user.click(screen.getByRole('button', { name: '离子路径' }));
    await user.selectOptions(screen.getByLabelText('方向载流粒子'), 'cation');
    await user.click(node('可导电液体或离子通道'));
    await user.click(node('导体棒 B'));
    await user.selectOptions(screen.getByLabelText('方向载流粒子'), 'anion');
    await user.click(node('可导电液体或离子通道'));
    await user.click(node('导体棒 A'));
    await user.click(screen.getByRole('button', { name: '提交搭建' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(await screen.findByLabelText(/^A\./));
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    const answer = await screen.findByLabelText('简答作答');
    await user.type(answer, 'Zn - 2e⁻ = Zn²⁺；电子由锌极流向铜极。');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.extractAssessment).toHaveBeenCalledTimes(1);
    expect(runtime.extractAssessment).toHaveBeenCalledWith(expect.objectContaining({
      targetNodeIds: ['P3', 'P4', 'P5', 'P6', 'P7'],
    }));

    await user.click(await screen.findByLabelText(/^A\./));
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    await user.click(await screen.findByRole('button', { name: '跳过手绘，查看诊断' }));

    expect(await screen.findByRole('heading', { name: '诊断结果' })).toBeInTheDocument();
    expect(screen.getAllByText(/失电子场所.*电子导体.*离子导体.*得电子场所/).length).toBeGreaterThan(0);
    expect(screen.getByText('rubric-d1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出会话 JSON' })).toBeInTheDocument();
  });

  it('routes to the training, model, and teacher placeholders without losing the shell', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    render(<App initialConfig={config} />);

    await user.click(screen.getByRole('link', { name: '训练' }));
    expect(await screen.findByRole('heading', { name: '思维模型训练' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '外显' }));
    expect(await screen.findByRole('heading', { name: '3D 思维模型外显' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '教师视图' }));
    expect(await screen.findByRole('heading', { name: '教师视图' })).toBeInTheDocument();
    expect(screen.getByLabelText('电子流进度')).toBeInTheDocument();
  });

  it('restores global pretest progress on a direct training route', async () => {
    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'completed-pretest-session',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(session);
    window.localStorage.setItem(`luminous-quest:pretest-complete.v1:${session.id}`, 'true');
    window.history.replaceState({}, '', '/training');

    render(<App initialConfig={config} />);

    expect(await screen.findByRole('heading', { name: '思维模型训练' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '前测' }).closest('li')).toHaveAttribute('data-complete', 'true');
  });

  it('restores the current builder draft from the shared local session identity', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const first = render(<App initialConfig={config} />);
    await user.click(await screen.findByRole('button', { name: '添加 导体棒 A' }));
    expect(screen.getByRole('button', { name: /画布组件.*导体棒 A/ })).toBeInTheDocument();
    first.unmount();

    render(<App initialConfig={config} />);
    expect(await screen.findByRole('button', { name: /画布组件.*导体棒 A/ })).toBeInTheDocument();
  });

  it('imports a version-compatible shared session JSON through the shell control', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const imported = createSession({
      id: 'imported-m2-session',
      anonymousStudentId: 'anon-IMPORTED',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    render(<App initialConfig={config} />);

    await user.upload(
      screen.getByLabelText('导入会话 JSON 文件'),
      new File([exportSession(imported)], 'm2-session.json', { type: 'application/json' }),
    );

    expect(await screen.findByText('anon-IMPORTED')).toBeInTheDocument();
    expect(screen.getByText('会话已导入')).toBeInTheDocument();
  });

  it('rejects a schema-valid import whose scoring trace fails learner-profile validation', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) => entry.type === 'choice');
    if (!question || question.type !== 'choice') throw new Error('choice question missing');
    const imported = createSession({
      id: 'tampered-m2-session',
      anonymousStudentId: 'anon-TAMPERED',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const assessed = recordChoiceAssessment({
      session: imported,
      config,
      question,
      optionId: question.options[0].id,
    }).session;
    const assessment = assessed.events.find((event) => event.kind === 'assessment.completed');
    if (!assessment || assessment.kind !== 'assessment.completed') throw new Error('assessment missing');
    assessment.rubric.id = 'rubric-p3';
    render(<App initialConfig={config} />);

    await user.upload(
      screen.getByLabelText('导入会话 JSON 文件'),
      new File([exportSession(assessed)], 'tampered.json', { type: 'application/json' }),
    );

    expect(await screen.findByText('会话内容未通过深度校验，请确认文件未损坏或篡改。'))
      .toBeInTheDocument();
    expect(screen.queryByText('anon-TAMPERED')).not.toBeInTheDocument();
  });
});
