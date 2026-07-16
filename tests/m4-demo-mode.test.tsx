// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import { importSession } from '../shared/session/session';
import { App } from '../src/App';
import type { AppRuntime } from '../src/runtime/api';

const apiToken = 'm4-demo-test-token';
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
      session: { id: 'teacher-fixture-session-a', anonymousStudentId: 'anon-TEACH001' },
      progress: { pretestComplete: true, trainingComplete: false },
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
    const activateDemo = vi.fn(async () => ({
      executionMode: 'demo' as const,
      session: demoSession,
      progress: { pretestComplete: true, trainingComplete: false },
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
    const toggle = await screen.findByRole('switch', { name: '演示回放' });
    await user.click(toggle);

    expect(activateDemo).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('executionMode=demo')).toBeInTheDocument();
    expect(screen.getAllByText('anon-TEACH001').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: '思维模型训练' })).toBeInTheDocument();

    await user.click(toggle);
    expect(setExecutionMode).toHaveBeenCalledWith('development');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
