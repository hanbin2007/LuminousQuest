// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { LocalSessionStore } from '../shared/session/local-storage';
import {
  createSession,
  exportSession,
  sessionConfigVersions,
} from '../shared/session';
import { App } from '../src/App';
import { RuntimeHttpError, type AppRuntime } from '../src/runtime/api';

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
  window.history.pushState({}, '', '/pretest');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    provider: 'mock',
    model: 'mock',
    status: 'ok',
    detail: 'test',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function runtimeWithSync(
  config: Awaited<ReturnType<typeof loadAllConfig>>,
  syncSession: NonNullable<AppRuntime['syncSession']>,
): AppRuntime {
  return {
    loadConfig: vi.fn(async () => config),
    assessChoice: vi.fn(async () => ({ session: null })),
    extractAssessment: vi.fn(async () => ({ session: null })),
    assessEquation: vi.fn(async () => ({ session: null })),
    tutorTurn: vi.fn(),
    reviewDrawing: vi.fn(),
    syncSession,
  } as AppRuntime;
}

describe('M6 Phase 3 session hydrate wiring', () => {
  it('hydrates the restored session at startup and shows a readable non-blocking failure', async () => {
    const config = await loadAllConfig(process.cwd());
    const restored = createSession({
      id: 'startup-hydrate-session',
      anonymousStudentId: 'anon-HYDRATE1',
      now: '2026-07-23T21:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(restored);
    const syncSession = vi.fn(async () => {
      throw new Error('server offline');
    });

    render(<App initialConfig={config} runtime={runtimeWithSync(config, syncSession)} />);

    await waitFor(() => expect(syncSession).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: restored.id }),
      expectedSequence: 0,
    })));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '会话同步失败，本机记录仍可查看',
    );
  });

  it('hydrates an imported session before reporting the import complete', async () => {
    const config = await loadAllConfig(process.cwd());
    const initial = createSession({
      id: 'hydrate-import-initial',
      anonymousStudentId: 'anon-HYDRATE2',
      now: '2026-07-23T21:00:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    const imported = createSession({
      id: 'hydrate-import-target',
      anonymousStudentId: 'anon-HYDRATE3',
      now: '2026-07-23T21:01:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(initial);
    const syncSession = vi.fn(async ({ session }) => ({
      status: 'hydrated' as const,
      replayed: false,
      sequence: session.events.length,
      session,
    }));
    const user = userEvent.setup();

    render(<App initialConfig={config} runtime={runtimeWithSync(config, syncSession)} />);
    await waitFor(() => expect(syncSession).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: '课程与会话工具' }));
    await user.upload(
      screen.getByLabelText('导入会话 JSON 文件'),
      new File([exportSession(imported)], 'session.json', { type: 'application/json' }),
    );

    await waitFor(() => expect(syncSession).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: imported.id }),
      expectedSequence: 0,
    })));
    expect(await screen.findByText('会话已导入')).toBeInTheDocument();
  });

  it('forks a divergent local session instead of leaving a prefix conflict blocking it', async () => {
    const config = await loadAllConfig(process.cwd());
    const restored = createSession({
      id: 'prefix-conflict-session',
      anonymousStudentId: 'anon-HYDRATE4',
      now: '2026-07-23T21:02:00.000Z',
      configVersions: sessionConfigVersions(config),
    });
    new LocalSessionStore(window.localStorage).save(restored);
    const syncSession = vi.fn(async ({ session }) => {
      if (session.id === restored.id) {
        throw new RuntimeHttpError(
          'session-prefix-conflict',
          409,
          { error: 'session-prefix-conflict', eventIndex: 0 },
        );
      }
      return {
        status: 'hydrated' as const,
        replayed: false,
        sequence: session.events.length,
        session,
      };
    });

    render(<App initialConfig={config} runtime={runtimeWithSync(config, syncSession)} />);

    await waitFor(() => expect(syncSession).toHaveBeenCalledTimes(2));
    expect(syncSession.mock.calls[1]?.[0]).toMatchObject({
      session: {
        id: expect.stringMatching(/^recovered-/),
        anonymousStudentId: restored.anonymousStudentId,
      },
      expectedSequence: 0,
    });
    expect(screen.queryByText(/session-prefix-conflict/)).not.toBeInTheDocument();
  });
});
