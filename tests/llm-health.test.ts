import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { ProviderHttpError, ProviderTimeoutError } from '../server/llm/errors';
import {
  classifyLLMHealthError,
  LLMHealthMonitor,
} from '../server/llm/health';
import type { LLMProvider } from '../server/llm/types';
import {
  AgentTurnAdapterError,
  type AgentTurnAdapter,
} from '../server/agent/adapters/adapter';

describe('LLM health route', () => {
  it('probes a native Agent adapter without requiring a legacy completion provider', async () => {
    const execute = vi.fn<AgentTurnAdapter['execute']>(async (request) => {
      const action = {
        callId: 'agent-only-health-call',
        name: 'end_case' as const,
        arguments: { summary: 'health-canary' },
      };
      await request.executeTool?.(action);
      return {
        source: 'provider',
        model: request.model,
        orderedActions: [action],
        terminalAction: { callId: action.callId, name: action.name },
        usage: {},
      };
    });
    const adapter: AgentTurnAdapter = {
      id: 'claude-agent',
      execute,
    };
    const monitor = new LLMHealthMonitor({
      providers: new Map(),
      agentAdapters: new Map([['claude-agent', adapter]]),
      configuration: () => ({
        executionMode: 'live',
        provider: 'claude-agent',
        model: 'agent-model',
      }),
    });

    await expect(monitor.get()).resolves.toMatchObject({
      status: 'ok',
      detail: '实时 AI 工具调用通道可用',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('requires a real native tool call when an agent adapter is configured', async () => {
    const structured = vi.fn(async () => {
      throw new Error('legacy completion probe must not run');
    });
    const provider: LLMProvider = {
      id: 'agent-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      structured,
    };
    const execute = vi.fn<AgentTurnAdapter['execute']>(async (request) => {
      expect(request.tools.map((tool) => tool.name)).toEqual(['end_case']);
      const action = {
        callId: 'health-call',
        name: 'end_case' as const,
        arguments: { summary: 'health-canary' },
      };
      await request.executeTool?.(action);
      return {
        source: 'provider',
        model: request.model,
        orderedActions: [action],
        terminalAction: { callId: action.callId, name: action.name },
        usage: {},
      };
    });
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      execute,
    };
    const monitor = new LLMHealthMonitor({
      providers: new Map([[provider.id, provider]]),
      agentAdapters: new Map([[provider.id, adapter]]),
      configuration: () => ({
        executionMode: 'live',
        provider: provider.id,
        model: 'agent-model',
      }),
    });

    await expect(monitor.get()).resolves.toEqual({
      provider: provider.id,
      model: 'agent-model',
      status: 'ok',
      detail: '实时 AI 工具调用通道可用',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(structured).not.toHaveBeenCalled();
  });

  it('rejects an agent health trace that did not execute the canary tool', async () => {
    const provider: LLMProvider = {
      id: 'agent-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured() { throw new Error('not used'); },
    };
    const adapter: AgentTurnAdapter = {
      id: 'openai-compatible',
      async execute(request) {
        const action = {
          callId: 'fabricated-health-call',
          name: 'end_case' as const,
          arguments: { summary: 'health-canary' },
        };
        return {
          source: 'provider',
          model: request.model,
          orderedActions: [action],
          terminalAction: { callId: action.callId, name: action.name },
          usage: {},
        };
      },
    };
    const monitor = new LLMHealthMonitor({
      providers: new Map([[provider.id, provider]]),
      agentAdapters: new Map([[provider.id, adapter]]),
      configuration: () => ({
        executionMode: 'live',
        provider: provider.id,
        model: 'agent-model',
      }),
    });

    await expect(monitor.get()).resolves.toMatchObject({
      status: 'down',
      detail: expect.stringContaining('通道不可用'),
    });
  });

  it('classifies an overdue response from the native tool canary without exposing it', () => {
    const result = classifyLLMHealthError(
      'modelverse',
      new AgentTurnAdapterError(
        'upstream request failed',
        'http-error',
        403,
        'Access forbidden: account overdue, please recharge',
      ),
    );

    expect(result).toEqual({
      status: 'down',
      detail: 'Modelverse 账户余额不足或已欠费，请充值后重试',
    });
    expect(result.detail).not.toContain('Access forbidden');
  });

  it('probes the minimal structured capability used by application workflows', async () => {
    const structured = vi.fn(async () => ({
      content: '{"ok":true}',
      structured: { ok: true },
      model: 'live-v1',
    }));
    const provider: LLMProvider = {
      id: 'live-provider',
      async chat() { throw new Error('health must use structured'); },
      async vision() { throw new Error('not used'); },
      structured,
    };
    const monitor = new LLMHealthMonitor({
      providers: new Map([[provider.id, provider]]),
      configuration: () => ({
        executionMode: 'live',
        provider: provider.id,
        model: 'live-v1',
      }),
    });

    await expect(monitor.get()).resolves.toMatchObject({ status: 'ok' });
    expect(structured).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'structured',
      input: {},
      schema: expect.objectContaining({ required: ['ok'] }),
    }));
  });

  it('returns the configured live provider status and reuses the probe for 60 seconds', async () => {
    const structured = vi.fn(async () => ({
      content: '{"ok":true}',
      structured: { ok: true },
      model: 'live-v1',
    }));
    const provider: LLMProvider = {
      id: 'live-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      structured,
    };
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
      workflow: {
        executionMode: 'live',
        provider: provider.id,
        model: 'live-v1',
      },
    });

    const first = await app.request('/api/llm/health');
    const second = await app.request('/api/llm/health');

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      provider: 'live-provider',
      model: 'live-v1',
      status: 'ok',
      detail: '实时 AI 通道可用',
    });
    expect(await second.json()).toEqual({
      provider: 'live-provider',
      model: 'live-v1',
      status: 'ok',
      detail: '实时 AI 通道可用',
    });
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it('expires a cached probe at 60 seconds', async () => {
    let now = 1_000;
    const structured = vi.fn(async () => ({
      content: '{"ok":true}',
      structured: { ok: true },
      model: 'live-v1',
    }));
    const provider: LLMProvider = {
      id: 'live-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      structured,
    };
    const monitor = new LLMHealthMonitor({
      providers: new Map([[provider.id, provider]]),
      configuration: () => ({
        executionMode: 'live',
        provider: provider.id,
        model: 'live-v1',
      }),
      now: () => now,
    });

    await monitor.get();
    now += 59_999;
    await monitor.get();
    expect(structured).toHaveBeenCalledTimes(1);

    now += 1;
    await monitor.get();
    expect(structured).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: 'an overdue Modelverse account',
      error: new ProviderHttpError(
        'modelverse',
        403,
        '{"error":{"message":"Account overdue. Please recharge."}}',
      ),
      expected: {
        status: 'down',
        detail: 'Modelverse 账户余额不足或已欠费，请充值后重试',
      },
    },
    {
      name: 'a provider timeout',
      error: new ProviderTimeoutError(20_000),
      expected: {
        status: 'degraded',
        detail: 'modelverse 探活超时，请稍后重试',
      },
    },
  ])('classifies $name without exposing the upstream body', async ({ error, expected }) => {
    const structured = vi.fn(async () => {
      throw error;
    });
    const provider: LLMProvider = {
      id: 'modelverse',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      structured,
    };
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
      workflow: {
        executionMode: 'live',
        provider: provider.id,
        model: 'glm-5.2',
      },
    });

    const response = await app.request('/api/llm/health');
    await app.request('/api/llm/health');
    const payload = await response.json() as { detail: string };

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      provider: 'modelverse',
      model: 'glm-5.2',
      ...expected,
    });
    expect(payload.detail).not.toContain('Account overdue');
    expect(structured).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      executionMode: 'demo' as const,
      provider: 'live-provider',
      detail: '演示回放模式，未调用在线 AI',
    },
    {
      executionMode: 'development' as const,
      provider: 'mock',
      detail: 'Mock 演示通道已启用，未调用在线 AI',
    },
  ])('does not probe in $executionMode/$provider mode', async ({ executionMode, provider, detail }) => {
    const structured = vi.fn(async () => ({
      content: '{"ok":true}',
      structured: { ok: true },
      model: 'test-v1',
    }));
    const monitor = new LLMHealthMonitor({
      providers: new Map([[
        provider,
        {
          id: provider,
          async chat() { throw new Error('not used'); },
          async vision() { throw new Error('not used'); },
          structured,
        },
      ]]),
      configuration: () => ({ executionMode, provider, model: 'test-v1' }),
    });

    await expect(monitor.get()).resolves.toMatchObject({
      provider,
      status: 'degraded',
      detail,
    });
    expect(structured).not.toHaveBeenCalled();
  });
});
