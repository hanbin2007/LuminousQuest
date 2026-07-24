// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { createSession, sessionConfigVersions } from '../shared/session/session';
import { AgentActivityProvider } from '../src/agent/AgentActivityContext';
import { AppContext } from '../src/app/AppContext';
import { AppShell } from '../src/app/AppShell';
import type { AppRuntime } from '../src/runtime/api';

function runtime(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  executionMode: 'live' | 'development' = 'live',
): AppRuntime {
  return {
    loadConfig: vi.fn(async () => config),
    getRuntimeState: vi.fn(async () => ({ executionMode })),
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
    reviewDrawing: vi.fn(async () => ''),
  };
}

describe('AppShell LLM provider badge', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: 'live',
      executionMode: 'live' as const,
      health: {
        provider: 'modelverse',
        model: 'glm-5.2',
        status: 'ok',
        detail: '实时 AI 通道可用',
      },
      label: 'AI 通道状态：live',
      className: 'llm-provider-badge--live',
      title: 'modelverse / glm-5.2：实时 AI 通道可用',
    },
    {
      name: 'demo',
      executionMode: 'development' as const,
      health: {
        provider: 'mock',
        model: 'mock-v1',
        status: 'degraded',
        detail: 'Mock 演示通道已启用，未调用在线 AI',
      },
      label: 'AI 通道状态：demo',
      className: 'llm-provider-badge--demo',
      title: 'Mock 演示通道已启用，未调用在线 AI',
    },
    {
      name: 'fault',
      executionMode: 'live' as const,
      health: {
        provider: 'modelverse',
        model: 'glm-5.2',
        status: 'down',
        detail: 'Modelverse 账户余额不足或已欠费，请充值后重试',
      },
      label: 'AI 通道状态：故障',
      className: 'llm-provider-badge--fault',
      title: 'AI 通道不可用，作答将转人工复核。',
    },
  ])('shows the $name state', async ({ executionMode, health, label, className, title }) => {
    const config = await loadAllConfig(process.cwd());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const appRuntime = runtime(config, executionMode);
    const session = createSession({
      id: 'provider-badge-session',
      now: '2026-07-23T00:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });

    render(
      <AgentActivityProvider>
        <AppContext.Provider value={{
          config,
          runtime: appRuntime,
          session,
          setSession: vi.fn() as never,
          persistenceError: null,
          historicalSessions: [],
          pretestComplete: false,
          setPretestComplete: vi.fn(),
          trainingComplete: false,
          setTrainingComplete: vi.fn(),
          executionMode,
          demoModePending: false,
          demoModeError: null,
          toggleDemoMode: vi.fn(async () => executionMode),
          testNavigation: false,
          activateDevelopmentPretest: vi.fn(),
        }}>
          <MemoryRouter initialEntries={['/pretest']}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/pretest" element={<main>Pretest</main>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AppContext.Provider>
      </AgentActivityProvider>,
    );

    const badge = await screen.findByLabelText(label);
    expect(badge).toHaveClass('llm-provider-badge', className);
    expect(badge).toHaveAttribute('title', title);
  });
});
