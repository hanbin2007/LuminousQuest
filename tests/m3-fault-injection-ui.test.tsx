// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import path from 'node:path';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerApp } from '../server/app';
import { loadAllConfig } from '../server/config/loader';
import type { LLMProvider } from '../server/llm/types';
import type { StudentSession } from '../shared/session';
import { App } from '../src/App';
import { defaultRuntime } from '../src/runtime/api';
import { createTemporaryDirectory, writeValidContentTree } from './helpers/content-fixture';
import { createTrainingRuntime } from './helpers/training-runtime';

const apiToken = 'm3-ui-fault-token';

class TestSessionStore {
  readonly values = new Map<string, StudentSession>();
  get(id: string) { return this.values.get(id); }
  set(session: StudentSession) { this.values.set(session.id, session); }
}

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

function installHonoFetch(app: ReturnType<typeof createServerApp>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const source = input instanceof Request ? input.url : input.toString();
    const url = new URL(source, 'http://localhost');
    return app.request(`${url.pathname}${url.search}`, init);
  }));
}

describe('M3 tutor fault injection through the training UI', () => {
  beforeEach(() => {
    installStorage();
    window.history.replaceState({}, '', '/training');
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    globalThis.__LQ_API_TOKEN__ = undefined;
  });

  it.each([
    { reason: 'schema-invalid', mode: 'live' as const },
    { reason: 'replay-missing', mode: 'demo' as const },
  ])('renders the actual $reason response from the Hono tutor route', async ({ reason, mode }) => {
    const user = userEvent.setup();
    const root = await createTemporaryDirectory();
    await writeValidContentTree(root);
    const config = await loadAllConfig(root);
    let providerCalls = 0;
    const invalidProvider: LLMProvider = {
      id: 'ui-fault-provider',
      async chat() { throw new Error('not used'); },
      async vision() { throw new Error('not used'); },
      async structured(request) {
        if (request.prompt.id === 'llm-health') {
          return { content: '{"ok":true}', structured: { ok: true }, model: 'ui-fault.v1' };
        }
        providerCalls += 1;
        const value = { action: 'answer', content: 'not allowed' };
        return { content: JSON.stringify(value), structured: value, model: 'ui-fault.v1' };
      },
    };
    const sessions = new TestSessionStore();
    const app = createServerApp({
      contentRoot: root,
      clientRoot: path.join(root, 'client'),
      apiToken,
      providers: new Map([[invalidProvider.id, invalidProvider]]),
      sessions,
      workflow: {
        executionMode: mode,
        provider: invalidProvider.id,
        model: 'ui-fault.v1',
        ...(mode === 'demo' ? { tutorStepId: 'missing-m3-ui-replay' } : {}),
      },
    });
    installHonoFetch(app);
    globalThis.__LQ_API_TOKEN__ = apiToken;
    const fake = createTrainingRuntime(config, { outcome: 'miss' });
    const runtime = { ...fake.runtime, tutorTurn: defaultRuntime.tutorTurn };
    render(<App initialConfig={config} runtime={runtime} />);

    await screen.findByRole('heading', { name: '锌铜原电池' });
    await user.click(screen.getByRole('button', { name: '提交案例作答' }));
    const scored = fake.getSession();
    if (!scored) throw new Error('training session was not recorded');
    sessions.set(scored);
    await user.click((await screen.findAllByRole('button', { name: '请老师提示一下' }))[0]!);

    expect(await screen.findByText(`故障状态：${reason}`)).toBeInTheDocument();
    expect(screen.getByText('预设回退')).toBeInTheDocument();
    expect(providerCalls).toBe(mode === 'live' ? 2 : 0);
  });
});
