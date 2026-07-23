// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import pretestJson from '../config/pretest.json';
import { loadAllConfig } from '../server/config/loader';
import { pretestSchema } from '../shared/config/schemas';
import { LocalSessionStore } from '../shared/session/local-storage';
import { createSession, sessionConfigVersions } from '../shared/session/session';
import { App } from '../src/App';
import { AppErrorBoundary } from '../src/app/AppErrorBoundary';
import { loadPretestDraft } from '../src/features/pretest/draft';
import { mergeServerSession } from '../src/features/pretest/session-merge';

const pretest = pretestSchema.parse(pretestJson);
const originalStorage = window.localStorage;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'localStorage', { configurable: true, value: originalStorage });
});

describe('M2 draft and render resilience', () => {
  it('filters unknown components and every connection that points to one', () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify({
        step: 0,
        builder: {
          components: [
            { instanceId: 'known', componentId: 'site-a', x: 24, y: 24 },
            { instanceId: 'removed', componentId: 'old-component', x: 48, y: 48 },
          ],
          connections: [
            { id: 'dangling', from: 'known', to: 'removed', kind: 'electron-path' },
          ],
        },
        answers: {},
      })),
    };

    expect(loadPretestDraft(storage, 'session-1', pretest)).toEqual({
      step: 0,
      builder: {
        components: [{ instanceId: 'known', componentId: 'site-a', x: 24, y: 24 }],
        connections: [],
      },
      answers: {},
    });
  });

  it('offers Chinese recovery actions when a descendant render crashes', async () => {
    const user = userEvent.setup();
    const session = createSession({
      id: 'boundary-session',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: {
        configDigest: 'sha256:test',
        knowledgeModel: 'knowledge-model.v1',
        rubrics: 'rubrics.v1',
        pretest: 'pretest.v1',
        scaffoldPolicy: 'scaffold-policy.v1',
        cases: {},
        grammar: 'grammar.v1',
        engines: { rubric: 'r.v1', topology: 't.v1', equation: 'e.v1' },
      },
    });
    const onReset = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:boundary'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    function Broken(): never {
      throw new Error('render exploded');
    }

    render(
      <AppErrorBoundary session={session} onReset={onReset}>
        <Broken />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('heading', { name: '页面暂时无法继续' })).toBeInTheDocument();
    expect(screen.queryByText('render exploded')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导出会话' }));
    await user.click(screen.getByRole('button', { name: '重置' }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest timestamp when merging a server session', () => {
    const versions = {
      configDigest: 'sha256:test',
      knowledgeModel: 'knowledge-model.v1',
      rubrics: 'rubrics.v1',
      pretest: 'pretest.v1',
      scaffoldPolicy: 'scaffold-policy.v1',
      cases: {},
      grammar: 'grammar.v1',
      engines: { rubric: 'r.v1', topology: 't.v1', equation: 'e.v1' },
    };
    const local = createSession({ id: 'merge-session', now: '2026-07-15T12:00:00.000Z', configVersions: versions });
    const incoming = createSession({ id: 'merge-session', now: '2026-07-15T12:05:00.000Z', configVersions: versions });

    expect(mergeServerSession(local, incoming).updatedAt).toBe('2026-07-15T12:05:00.000Z');
  });

  it('keeps the app usable and asks for export when local persistence fails', async () => {
    const user = userEvent.setup();
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        get length() { return values.size; },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); },
      } satisfies Storage,
    });
    const config = await loadAllConfig(process.cwd());

    render(<App initialConfig={config} />);

    await user.click(await screen.findByRole('button', { name: '课程与会话工具' }));
    expect(await screen.findByText('本地保存失败，请导出会话。')).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: '导出会话 JSON' })).toBeInTheDocument();
  });

  it('offers a version-mismatched historical session for export after another reload', async () => {
    const user = userEvent.setup();
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
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:history'), configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const config = await loadAllConfig(process.cwd());
    const historical = createSession({
      id: 'historical-session',
      anonymousStudentId: 'anon-HISTORY1',
      now: '2026-07-15T12:00:00.000Z',
      configVersions: {
        ...sessionConfigVersions(config),
        configDigest: 'sha256:previous-content',
      },
    });
    new LocalSessionStore(window.localStorage).save(historical);

    const first = render(<App initialConfig={config} />);
    await user.click(await screen.findByRole('button', { name: '课程与会话工具' }));
    expect(await screen.findByLabelText('历史会话')).toHaveValue(historical.id);
    first.unmount();

    render(<App initialConfig={config} />);
    await user.click(await screen.findByRole('button', { name: '课程与会话工具' }));
    expect(await screen.findByLabelText('历史会话')).toHaveValue(historical.id);
    await user.click(screen.getByRole('button', { name: '导出历史会话' }));

    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(anchorClick.mock.instances[0]).toHaveProperty(
      'download',
      `luminous-quest-history-${historical.id}.json`,
    );
  });
});
