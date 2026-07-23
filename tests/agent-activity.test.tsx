// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentActivityRuntime } from '../src/agent/agent-activity';
import {
  AgentActivityProvider,
  useAgentActivityActions,
} from '../src/agent/AgentActivityContext';
import { AgentActivityPanel } from '../src/agent/AgentActivityPanel';
import type { AppRuntime, ExtractAssessmentResult } from '../src/runtime/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function runtimeWithExtraction(
  extractAssessment: AppRuntime['extractAssessment'],
): AppRuntime {
  return {
    loadConfig: vi.fn(),
    assessChoice: vi.fn(),
    extractAssessment,
    assessEquation: vi.fn(),
    tutorTurn: vi.fn(),
    reviewDrawing: vi.fn(),
  } as unknown as AppRuntime;
}

function ExtractionHarness({ runtime }: { runtime: AppRuntime }) {
  const activity = useAgentActivityActions();
  const instrumented = useMemo(
    () => createAgentActivityRuntime(runtime, activity),
    [activity, runtime],
  );
  return (
    <>
      <button
        onClick={() => {
          void instrumented.extractAssessment({
            sessionId: 'agent-panel-session',
            questionId: 'pretest-principle',
            targetNodeIds: ['P3', 'P4'],
            studentAnswer: '电子沿导线移动。',
            submissionId: 'submission-1',
          });
        }}
        type="button"
      >
        提交测试作答
      </button>
      <AgentActivityPanel />
    </>
  );
}

describe('Agent activity stream', () => {
  it('opens on submit, shows live work, and appends the real provider result', async () => {
    const result = deferred<ExtractAssessmentResult>();
    const runtime = runtimeWithExtraction(vi.fn(() => result.promise));
    const user = userEvent.setup();

    render(
      <AgentActivityProvider>
        <ExtractionHarness runtime={runtime} />
      </AgentActivityProvider>,
    );

    await user.click(screen.getByRole('button', { name: '提交测试作答' }));

    expect(screen.getByRole('complementary', { name: 'Agent 消息流' })).toBeInTheDocument();
    expect(screen.getByText('已收到提交')).toBeInTheDocument();
    expect(screen.getByText('正在读取作答、提取证据并匹配知识节点。')).toBeInTheDocument();
    expect(screen.getByText(/^正在分析 · \d+ 秒$/)).toBeInTheDocument();
    expect(screen.getByText(/2 个目标节点 · 8 字符/)).toBeInTheDocument();

    result.resolve({
      session: null,
      status: 'extracted',
      source: 'provider',
      model: 'claude-sonnet-test',
    });

    expect(await screen.findByText('评测 Agent 已返回')).toBeInTheDocument();
    expect(screen.getByText('已完成 2 个知识节点的证据抽取，诊断结果已更新。'))
      .toBeInTheDocument();
    expect(screen.getByText(/实时模型 · claude-sonnet-test/)).toBeInTheDocument();
    expect(screen.getByText('本轮已同步')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '收起 Agent 消息流' }));
    expect(screen.queryByRole('complementary', { name: 'Agent 消息流' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 Agent 消息流' })).toBeInTheDocument();
  });

  it('labels deterministic submissions without pretending an Agent was called', async () => {
    const runtime = runtimeWithExtraction(vi.fn(async (): Promise<ExtractAssessmentResult> => ({
      session: null,
      status: 'deterministic',
    })));
    const user = userEvent.setup();

    render(
      <AgentActivityProvider>
        <ExtractionHarness runtime={runtime} />
      </AgentActivityProvider>,
    );

    await user.click(screen.getByRole('button', { name: '提交测试作答' }));

    expect(await screen.findByText('规则路径完成')).toBeInTheDocument();
    expect(screen.getByText('该作答由确定性规则完成评测，无需调用 Agent。'))
      .toBeInTheDocument();
  });

  it('keeps adding honest waiting checkpoints before a slow Agent returns', async () => {
    vi.useFakeTimers();
    const result = deferred<ExtractAssessmentResult>();
    const runtime = runtimeWithExtraction(vi.fn(() => result.promise));

    render(
      <AgentActivityProvider>
        <ExtractionHarness runtime={runtime} />
      </AgentActivityProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: '提交测试作答' }));
    expect(screen.getByText('正在发起评测请求')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.getByText('正在提取作答证据')).toBeInTheDocument();
    expect(screen.getByText('已等待 0.9 秒')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(screen.getByText('仍在分析')).toBeInTheDocument();
    expect(screen.getByText('已等待 6 秒')).toBeInTheDocument();

    await act(async () => {
      result.resolve({
        session: null,
        status: 'extracted',
        source: 'provider',
        model: 'claude-sonnet-test',
      });
      await Promise.resolve();
    });
    expect(screen.getByText('评测 Agent 已返回')).toBeInTheDocument();
  });
});
