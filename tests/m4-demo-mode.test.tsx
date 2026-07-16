// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { RecordingStore } from '../server/llm/recording-store';
import { loadAllPrompts } from '../server/prompts/loader';
import { importSession } from '../shared/session/session';
import { LocalSessionStore } from '../shared/session/local-storage';
import { App } from '../src/App';
import type { AppRuntime } from '../src/runtime/api';

const apiToken = 'm4-demo-test-token';
const routeTransitionTimeout = { timeout: 5_000 };
const protectedHeaders = {
  'content-type': 'application/json',
  'x-lq-api-token': apiToken,
};

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      clear() { values.clear(); },
      getItem(key: string) { return values.get(key) ?? null; },
      key(index: number) { return [...values.keys()][index] ?? null; },
      removeItem(key: string) { values.delete(key); },
      setItem(key: string, value: string) { values.set(key, value); },
    } satisfies Storage,
  });
  window.history.replaceState({}, '', '/pretest');
});

afterEach(cleanup);

describe('M4 demo execution mode', () => {
  it('activates the scripted session and replays tutoring without calling a network provider', async () => {
    const [config, prompts] = await Promise.all([
      loadAllConfig(process.cwd()),
      loadAllPrompts(process.cwd()),
    ]);
    const warn = vi.fn();
    await new RecordingStore(process.cwd()).validateDemoAssets({
      configVersion: config.configVersion,
      prompts,
      warn,
    });
    expect(warn).not.toHaveBeenCalled();
    const provider = {
      id: 'offline-provider',
      chat: vi.fn(async () => { throw new Error('network must stay offline'); }),
      vision: vi.fn(async () => { throw new Error('network must stay offline'); }),
      structured: vi.fn(async () => { throw new Error('network must stay offline'); }),
    };
    const app = createServerApp({
      contentRoot: process.cwd(),
      clientRoot: path.join(process.cwd(), 'dist', 'client'),
      providers: new Map([[provider.id, provider]]),
      workflow: { executionMode: 'live', provider: provider.id, model: 'offline-v1' },
      apiToken,
    });

    const activated = await app.request('/api/runtime/demo', {
      method: 'POST', headers: protectedHeaders, body: '{}',
    });
    expect(activated.status).toBe(200);
    const activation = await activated.json() as any;
    expect(activation).toMatchObject({
      executionMode: 'demo',
      session: { id: 'demo-primary-session', anonymousStudentId: 'anon-DEMO0001' },
      progress: { pretestComplete: true, trainingComplete: false },
      uiState: {
        version: 'demo-start-state.v1',
        route: '/training',
        training: { feedbackRound: { caseId: 'zinc-copper', attemptIds: ['demo-p4-1'] } },
      },
    });

    const tutor = await app.request('/api/tutor/turn', {
      method: 'POST',
      headers: protectedHeaders,
      body: JSON.stringify({
        sessionId: activation.session.id,
        nodeId: 'P4',
        studentAnswer: '我还是觉得电子应该经过盐桥。',
      }),
    });
    expect(tutor.status).toBe(200);
    expect(await tutor.json()).toMatchObject({
      status: 'respond',
      source: 'demo-recording',
      degraded: false,
      completedRounds: 2,
    });
    expect(provider.structured).not.toHaveBeenCalled();

    const state = await app.request('/api/runtime');
    expect(await state.json()).toEqual({ executionMode: 'demo' });
  });

  it('switches the UI to executionMode=demo in one action and preserves the previous session for exit', async () => {
    const config = await loadAllConfig(process.cwd());
    const demoSource = await readFile(
      path.join(process.cwd(), 'recordings', 'demo', 'session.json'),
      'utf8',
    );
    const demoSession = importSession(demoSource);
    const startState = JSON.parse(await readFile(
      path.join(process.cwd(), 'recordings', 'demo', 'start-state.json'),
      'utf8',
    ));
    const activateDemo = vi.fn(async () => ({
      executionMode: 'demo' as const,
      session: demoSession,
      progress: { pretestComplete: true, trainingComplete: false },
      uiState: {
        version: 'demo-start-state.v1' as const,
        route: '/training' as const,
        pretest: startState.pretest,
        training: startState.training,
      },
    }));
    const setExecutionMode = vi.fn(async () => ({ executionMode: 'development' as const }));
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
      assessChoice: vi.fn(async () => ({ session: null })),
      extractAssessment: vi.fn(async () => ({ session: null })),
      assessEquation: vi.fn(async () => ({ session: null })),
      tutorTurn: vi.fn(),
      reviewDrawing: vi.fn(),
      getRuntimeState: vi.fn(async () => ({ executionMode: 'development' as const })),
      activateDemo,
      setExecutionMode,
    };
    const user = userEvent.setup();

    render(<App initialConfig={config} runtime={runtime} />);
    const toggle = await screen.findByRole(
      'switch',
      { name: '演示回放' },
      routeTransitionTimeout,
    );
    await user.click(toggle);

    expect(activateDemo).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('executionMode=demo')).toBeInTheDocument();
    expect(screen.getAllByText('anon-DEMO0001').length).toBeGreaterThan(0);
    expect(await screen.findByRole(
      'heading',
      { name: '思维模型训练' },
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '本轮证据批注' })).toBeInTheDocument();
    expect(screen.getByText('先定位发生氧化的场所，再沿外电路检查你写的方向。')).toBeInTheDocument();

    await user.click(toggle);
    expect(setExecutionMode).toHaveBeenCalledWith('development');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  }, 15_000);

  it('keeps demo transient across refresh and restores the prior latest session and mode', async () => {
    const config = await loadAllConfig(process.cwd());
    const [demoSession, originalSession, startState] = await Promise.all([
      readFile(path.join(process.cwd(), 'recordings', 'demo', 'session.json'), 'utf8')
        .then(importSession),
      readFile(path.join(process.cwd(), 'tests', 'fixtures', 'teacher', 'session-b.json'), 'utf8')
        .then(importSession),
      readFile(path.join(process.cwd(), 'recordings', 'demo', 'start-state.json'), 'utf8')
        .then((source) => JSON.parse(source)),
    ]);
    const store = new LocalSessionStore(window.localStorage);
    store.save(originalSession);
    let serverMode: 'development' | 'demo' = 'development';
    const runtime: AppRuntime = {
      loadConfig: vi.fn(async () => config),
      assessChoice: vi.fn(async () => ({ session: null })),
      extractAssessment: vi.fn(async () => ({ session: null })),
      assessEquation: vi.fn(async () => ({ session: null })),
      tutorTurn: vi.fn(),
      reviewDrawing: vi.fn(),
      getRuntimeState: vi.fn(async () => ({ executionMode: serverMode })),
      activateDemo: vi.fn(async () => {
        serverMode = 'demo';
        return {
          executionMode: 'demo' as const,
          session: demoSession,
          progress: startState.progress,
          uiState: {
            version: 'demo-start-state.v1' as const,
            route: '/training' as const,
            pretest: startState.pretest,
            training: startState.training,
          },
        };
      }),
      setExecutionMode: vi.fn(async (mode) => {
        serverMode = mode === 'demo' ? 'demo' : 'development';
        return { executionMode: serverMode };
      }),
    };
    const user = userEvent.setup();

    const first = render(<App initialConfig={config} runtime={runtime} />);
    await user.click(await screen.findByRole(
      'switch',
      { name: '演示回放' },
      routeTransitionTimeout,
    ));
    expect(await screen.findByText(
      'executionMode=demo',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(window.localStorage.getItem('luminous-quest:session.v2:latest')).toBe(originalSession.id);
    first.unmount();

    render(<App initialConfig={config} runtime={runtime} />);
    const restoredToggle = await screen.findByRole(
      'switch',
      { name: '演示回放' },
      routeTransitionTimeout,
    );
    expect(await screen.findByText(
      'executionMode=demo',
      {},
      routeTransitionTimeout,
    )).toBeInTheDocument();
    expect(screen.getAllByText('anon-DEMO0001').length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('luminous-quest:session.v2:latest')).toBe(originalSession.id);

    await user.click(restoredToggle);
    expect(restoredToggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByText(originalSession.anonymousStudentId).length).toBeGreaterThan(0);
    expect(window.localStorage.getItem('luminous-quest:session.v2:latest')).toBe(originalSession.id);
  }, 15_000);
});
