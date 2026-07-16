// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { LocalSessionStore } from '../shared/session/local-storage';
import { importSession } from '../shared/session/session';
import { App } from '../src/App';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'teacher');

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
  window.history.pushState({}, '', '/teacher');
});

afterEach(cleanup);

describe('M4 teacher page', () => {
  it('renders traceable single-student evidence and imports a class batch with file-level feedback', async () => {
    const config = await loadAllConfig(process.cwd());
    const sources = await Promise.all(['session-a.json', 'session-b.json', 'session-c.json'].map((name) =>
      readFile(path.join(fixtureRoot, name), 'utf8')));
    const current = importSession(sources[0]);
    new LocalSessionStore(window.localStorage).save(current);
    const user = userEvent.setup();

    render(<App initialConfig={config} />);

    expect(await screen.findByRole('heading', { name: '教师视图' })).toBeInTheDocument();
    expect(screen.getAllByText('anon-TEACH001').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '诊断证据链' })).toBeInTheDocument();
    expect(screen.getByText('电子从铜极经导线流向锌极。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '待复核清单' })).toBeInTheDocument();
    expect(screen.getByText('回放证据与原文无法可靠对齐')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: '班级汇总' }));
    const input = screen.getByLabelText('批量导入班级会话 JSON');
    await user.upload(input, sources.map((source, index) => new File(
      [source],
      `session-${String.fromCharCode(97 + index)}.json`,
      { type: 'application/json' },
    )));

    expect(await screen.findByText('3 份会话参与汇总')).toBeInTheDocument();
    expect(screen.getByText(/session-a\.json.*重复文件未计入/u)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /班级三维雷达/u })).toBeInTheDocument();
    const p4Bar = screen.getByTestId('node-error-P4');
    expect(within(p4Bar).getByText('100%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '高频误区 Top 5' })).toBeInTheDocument();
    expect(screen.getByText('P4-M1')).toBeInTheDocument();
  });
});
