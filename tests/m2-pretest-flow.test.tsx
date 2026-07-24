// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { assembleGalvanicCell } from './helpers/assemble-cell';
import { LocalSessionStore } from '../shared/session/local-storage';
import { createSession, exportSession, sessionConfigVersions } from '../shared/session/session';
import { App, type AppRuntime } from '../src/App';
import { recordChoiceAssessment } from '../shared/workflows/choice-assessment';
import { QuestionCard } from '../src/features/pretest/QuestionCard';
import { emptyPretestDraft, savePretestDraft } from '../src/features/pretest/draft';

async function openUtilityMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '课程与会话工具' }));
}

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

  it('offers a skip action without submitting the current answer', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((candidate) => candidate.type === 'choice');
    if (!question) throw new Error('Expected a configured choice question');
    const onSkip = vi.fn();
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        question={question}
        dimensionLabel="原理"
        onAnswerChange={() => undefined}
        onSkip={onSkip}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '跳过' }));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps question geometry owned by LuminousQuest primitives', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((candidate) => candidate.type === 'choice');
    if (!question || question.type !== 'choice') throw new Error('Expected a choice question');
    const view = render(
      <QuestionCard
        question={question}
        dimensionLabel="原理"
        answer={question.options[0].id}
        onAnswerChange={() => undefined}
        onPrevious={() => undefined}
        onSkip={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByRole('article')).toHaveClass('ds-frame', 'ds-frame--paper');
    expect(view.container.querySelector(
      '[data-slot="glass-card"], [data-slot="glass-button"], [data-slot="glass-input"]',
    )).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一题' })).toHaveClass('ds-control');
    expect(screen.getByRole('button', { name: '跳过' })).toHaveClass('ds-control');
    expect(screen.getByRole('button', { name: '提交作答' })).toHaveClass('ds-control');
  });

  it('distinguishes answered questions and omits diagnosis from the step rail', async () => {
    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'session-pretest-step-states',
      now: '2026-07-22T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(session);
    savePretestDraft(window.localStorage, session.id, {
      ...emptyPretestDraft(),
      step: 1,
      answers: {
        [config.pretest.questions[0].id]: 'A',
      },
    });

    render(<App initialConfig={config} />);

    expect(await screen.findByRole('button', { name: '跳转到题目 1，已作答' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳转到题目 2，未作答' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /诊断结果/ })).not.toBeInTheDocument();
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

  it('renders the original grouped exam as a continuous fill-in flow', async () => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) =>
      entry.id === 'pretest-exam1-polarity');
    if (!question?.group) throw new Error('Expected the grouped exam question');

    render(
      <QuestionCard
        question={question}
        dimensionLabel="装置"
        groupProgress={[
          { id: question.id, label: '1-1', answered: false, current: true },
          { id: 'pretest-exam1-electron-flow', label: '1-2', answered: false, current: false },
          { id: 'pretest-exam1-stoichiometry', label: '1-3', answered: false, current: false },
          { id: 'pretest-exam1-membrane', label: '1-4', answered: false, current: false },
        ]}
        onAnswerChange={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(screen.getByText('高考真题')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'K—O₂ 电池' })).toBeInTheDocument();
    expect(screen.getByText(question.group.stimulus.replace(/^【高考真题】/, '')))
      .toBeInTheDocument();
    expect(screen.getByRole('img', { name: '高考真题装置图' }))
      .toHaveAttribute('src', '/assets/exam/q1-k-o2.png');
    expect(screen.getByText('填空题')).toBeInTheDocument();
    expect(screen.getByLabelText('电极 a 的极性')).toBeInTheDocument();
    expect(screen.getByLabelText('电极 b 的极性')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1-1，未作答' })).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('renders the Q4 choice-backed questions as polarity, substance, and amount blanks', async () => {
    const config = await loadAllConfig(process.cwd());
    const renderQuestion = (questionId: string) => {
      const question = config.pretest.questions.find((entry) => entry.id === questionId);
      if (!question) throw new Error(`Expected ${questionId}`);
      return render(
        <QuestionCard
          question={question}
          dimensionLabel={question.dimensionId === 'device' ? '装置' : '原理'}
          onAnswerChange={() => undefined}
          onSubmit={() => undefined}
        />,
      );
    };

    const polarity = renderQuestion('pretest-exam4-polarity');
    expect(screen.getByRole('heading', { name: '血糖微型电池' })).toBeInTheDocument();
    expect(screen.getByLabelText('电极 a 的极性')).toBeInTheDocument();
    expect(screen.getByLabelText('电极 b 的极性')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    polarity.unmount();

    const material = renderQuestion('pretest-exam4-material');
    expect(screen.getByLabelText('b 电极的电极材料')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    material.unmount();

    renderQuestion('pretest-exam4-electron-loser');
    expect(screen.getByLabelText('b 电极实际失电子的物质')).toBeInTheDocument();
    cleanup();

    renderQuestion('pretest-exam4-stoichiometry');
    expect(screen.getByLabelText('a 电极流入电子的物质的量')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it.each([
    ['pretest-exam1-polarity', 'B', ['D1-M1', 'D4-M2']],
    ['pretest-exam1-electron-flow', 'C', ['P4-M2', 'D3-M1']],
    ['pretest-exam1-stoichiometry', 'D', ['P6-M1']],
  ])('scores %s distractors with the configured misconception mapping', async (
    questionId,
    optionId,
    misconceptionIds,
  ) => {
    const config = await loadAllConfig(process.cwd());
    const question = config.pretest.questions.find((entry) => entry.id === questionId);
    if (!question || question.type !== 'choice') throw new Error(`Missing choice ${questionId}`);
    const session = createSession({
      id: `session-${questionId}`,
      now: '2026-07-22T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });

    const result = recordChoiceAssessment({ session, config, question, optionId });
    const assessments = result.session.events.filter((event) =>
      event.kind === 'assessment.completed');

    expect(result.correct).toBe(false);
    expect(question.options.find((option) => option.id === optionId)?.misconceptionIds)
      .toEqual(misconceptionIds);
    expect(assessments).toHaveLength(question.targetNodeIds.length);
    expect(assessments.every((event) =>
      event.kind === 'assessment.completed'
      && event.ruleDecision.status === 'miss'
      && event.score.status === 'scored'
      && event.score.outcome === 'miss')).toBe(true);
  });

  it('routes the K-O2 membrane response through the configured extraction mock path', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'session-exam1-membrane',
      now: '2026-07-22T12:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(session);
    savePretestDraft(window.localStorage, session.id, {
      ...emptyPretestDraft(),
      step: config.pretest.questions.findIndex((question) =>
        question.id === 'pretest-exam1-membrane') + 1,
    });
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
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
      reviewDrawing: vi.fn(async () => '已收到手绘。'),
    };
    render(<App initialConfig={config} runtime={runtime} />);

    const answer = '不能。防止 K 与 O₂ 直接反应，两个半反应必须分隔。';
    await user.type(await screen.findByLabelText('简答作答'), answer);
    await user.click(screen.getByRole('button', { name: '提交作答' }));

    expect(runtime.extractAssessment).toHaveBeenCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-membrane',
      targetNodeIds: ['D3', 'P1'],
      studentAnswer: answer,
    }));
  });

  it('submits a skipped choice to the server before advancing', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const questionIndex = config.pretest.questions.findIndex((question) =>
      question.id === 'pretest-exam1-polarity');
    const session = createSession({
      id: 'session-pretest-skip',
      now: '2026-07-24T00:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(session);
    savePretestDraft(window.localStorage, session.id, {
      ...emptyPretestDraft(),
      step: questionIndex + 1,
    });
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
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
      reviewDrawing: vi.fn(async () => '已收到手绘。'),
    };
    render(<App initialConfig={config} runtime={runtime} />);

    await user.type(await screen.findByLabelText('电极 a 的极性'), '正');
    await user.click(await screen.findByRole('button', { name: '跳过' }));

    expect(runtime.assessChoice).toHaveBeenCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-polarity',
      rawAnswer: '',
      submissionKind: 'skip',
    }));
    await user.click(await screen.findByRole('button', { name: '上一题' }));
    expect(await screen.findByLabelText('电极 a 的极性')).toHaveValue('');
  });

  it('completes builder, thirteen configured questions, and reaches traceable diagnosis under a mock runtime', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
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
      reviewDrawing: vi.fn(async () => '线条清楚；再检查电子路径与离子路径是否分别闭合。'),
    };
    render(<App initialConfig={config} runtime={runtime} />);

    expect(await screen.findByRole('heading', { name: '前测诊断' })).toBeInTheDocument();
    await assembleGalvanicCell(user);
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

    await user.type(await screen.findByLabelText('电极 a 的极性'), '负');
    await user.type(screen.getByLabelText('电极 b 的极性'), '正');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-polarity',
      optionId: 'A',
    }));

    await user.type(await screen.findByLabelText('电子流出电极'), 'a');
    await user.type(screen.getByLabelText('电子流入电极'), 'b');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-electron-flow',
      optionId: 'A',
    }));

    await user.type(await screen.findByLabelText('K 与 O₂ 的物质的量之比'), '1:1');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-stoichiometry',
      optionId: 'A',
    }));

    const membraneAnswer = await screen.findByLabelText('简答作答');
    await user.type(membraneAnswer, '不能，防止钾与氧气直接反应。');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.extractAssessment).toHaveBeenCalledTimes(2);
    expect(runtime.extractAssessment).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam1-membrane',
      targetNodeIds: ['D3', 'P1'],
    }));

    await user.type(await screen.findByLabelText('电极 a 的极性'), '正');
    await user.type(screen.getByLabelText('电极 b 的极性'), '负');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-polarity',
      optionId: 'A',
    }));

    const cathodeEquation = await screen.findByLabelText('简答作答');
    await user.type(cathodeEquation, 'O₂ + 2H₂O + 4e⁻ = 4OH⁻');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.extractAssessment).toHaveBeenCalledTimes(3);
    expect(runtime.extractAssessment).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-cathode-equation',
      targetNodeIds: ['P6'],
    }));

    await user.type(await screen.findByLabelText('b 电极的电极材料'), 'CuO');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-material',
      optionId: 'A',
    }));

    await user.type(await screen.findByLabelText('b 电极实际失电子的物质'), 'Cu₂O');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-electron-loser',
      optionId: 'A',
    }));

    const processAnswer = await screen.findByLabelText('简答作答');
    await user.type(
      processAnswer,
      'CuO 将葡萄糖氧化为葡萄糖酸，Cu₂O 失电子又生成 CuO，CuO 起催化作用。',
    );
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.extractAssessment).toHaveBeenCalledTimes(4);
    expect(runtime.extractAssessment).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-process',
      targetNodeIds: ['D5', 'P2'],
    }));

    await user.type(await screen.findByLabelText('a 电极流入电子的物质的量'), '.2');
    await user.click(screen.getByRole('button', { name: '提交作答' }));
    expect(runtime.assessChoice).toHaveBeenLastCalledWith(expect.objectContaining({
      questionId: 'pretest-exam4-stoichiometry',
      optionId: 'A',
    }));
    await user.click(await screen.findByRole('button', { name: '跳过手绘，查看诊断' }));

    expect(await screen.findByRole('heading', { name: '诊断结果' })).toBeInTheDocument();
    expect(screen.getAllByText(/失电子场所.*电子导体.*离子导体.*得电子场所/).length).toBeGreaterThan(0);
    expect(screen.getByText('rubric-d1')).toBeInTheDocument();
    await openUtilityMenu(user);
    expect(screen.getByRole('button', { name: '导出会话 JSON' })).toBeInTheDocument();
  });

  it('routes to the training, model, and teacher placeholders without losing the shell', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    render(<App initialConfig={config} />);

    await user.click(screen.getByRole('link', { name: '训练' }));
    expect(await screen.findByRole('heading', { name: '思维模型训练' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '外显' }));
    expect(await screen.findByRole('heading', { name: '电化学统一认知模型' })).toBeInTheDocument();
    await openUtilityMenu(user);
    await user.click(screen.getByRole('link', { name: '教师视图' }));
    expect(await screen.findByRole('heading', { name: '教师视图' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '课程与会话工具' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('电子流进度')).toBeInTheDocument();
  });

  it('opens the glasscn material lab and records a selected official variant in the URL', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    window.history.replaceState({}, '', '/glass-lab');

    render(<App initialConfig={config} />);

    expect(await screen.findByRole('heading', { name: '毛玻璃方案预览' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.getByText('当前使用 Frosted')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '选择方案 E Liquid Refract' }));
    expect(screen.getByText('当前使用 Liquid Refract')).toBeInTheDocument();
    expect(window.location.search).toBe('?variant=liquid-refract');
  });

  it('dismisses the controlled utility menu with Escape and restores trigger focus', async () => {
    const user = userEvent.setup();
    const config = await loadAllConfig(process.cwd());
    render(<App initialConfig={config} />);

    await openUtilityMenu(user);
    expect(screen.getByRole('dialog', { name: '课程与会话工具' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    const trigger = screen.getByRole('button', { name: '课程与会话工具' });
    expect(screen.queryByRole('dialog', { name: '课程与会话工具' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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

    await openUtilityMenu(user);
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

    await openUtilityMenu(user);
    await user.upload(
      screen.getByLabelText('导入会话 JSON 文件'),
      new File([exportSession(assessed)], 'tampered.json', { type: 'application/json' }),
    );

    expect(await screen.findByText('会话内容未通过深度校验，请确认文件未损坏或篡改。'))
      .toBeInTheDocument();
    expect(screen.queryByText('anon-TAMPERED')).not.toBeInTheDocument();
  });
});
