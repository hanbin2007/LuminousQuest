// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { loadAllConfig } from '../server/config/loader';
import { LocalSessionStore } from '../shared/session/local-storage';
import { createSession, sessionConfigVersions } from '../shared/session/session';
import {
  pretestStepPath,
  resolvePretestStep,
  resolveTrainingCaseId,
  trainingCasePath,
} from '../src/app/route-config';
import { readStageProgress } from '../src/persistence/stage-progress';
import { WorkspaceStorage } from '../src/persistence/workspace-storage';

class MapStorage implements Storage {
  readonly values = new Map<string, string>();
  failWrites = false;

  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('write failed');
    this.values.set(key, value);
  }
}

describe('central route configuration', () => {
  it('round-trips stable pretest steps and training cases through URLs', async () => {
    const config = await loadAllConfig(process.cwd());
    for (let step = 0; step <= config.pretest.questions.length + 2; step += 1) {
      expect(resolvePretestStep(config, pretestStepPath(config, step))).toBe(step);
    }
    for (const trainingCase of config.cases) {
      expect(resolveTrainingCaseId(config, trainingCasePath(trainingCase.id))).toBe(trainingCase.id);
    }
    expect(resolvePretestStep(config, '/pretest/question/not-configured')).toBeNull();
    expect(resolveTrainingCaseId(config, '/training/not-configured')).toBeNull();
  });
});

describe('WorkspaceStorage', () => {
  it('migrates legacy keys into one versioned envelope without breaking LocalSessionStore', async () => {
    const config = await loadAllConfig(process.cwd());
    const session = createSession({
      id: 'workspace-migration',
      configVersions: sessionConfigVersions(config),
    });
    const backing = new MapStorage();
    new LocalSessionStore(backing).save(session);
    backing.setItem(`luminous-quest:pretest-ui.v1:${session.id}`, '{"step":2}');

    const workspace = new WorkspaceStorage(backing);
    expect(new LocalSessionStore(workspace).restoreLatest()?.id).toBe(session.id);
    expect(workspace.getItem(`luminous-quest:pretest-ui.v1:${session.id}`)).toBe('{"step":2}');
    expect(backing.getItem('luminous-quest:session.v2:latest')).toBeNull();
    expect(JSON.parse(backing.getItem('luminous-quest:workspace.v3')!)).toMatchObject({
      schemaVersion: 'workspace.v3',
      revision: 1,
    });
    workspace.dispose();
  });

  it('commits multi-key transactions once and keeps the prior snapshot when the write fails', () => {
    const backing = new MapStorage();
    const workspace = new WorkspaceStorage(backing);
    workspace.transaction(() => {
      workspace.setItem('luminous-quest:a', '1');
      workspace.setItem('luminous-quest:b', '2');
    });
    expect(JSON.parse(backing.getItem('luminous-quest:workspace.v3')!).revision).toBe(1);

    backing.failWrites = true;
    expect(() => workspace.transaction(() => {
      workspace.setItem('luminous-quest:a', 'changed');
      workspace.removeItem('luminous-quest:b');
    })).toThrow('write failed');
    expect(workspace.getItem('luminous-quest:a')).toBe('1');
    expect(workspace.getItem('luminous-quest:b')).toBe('2');
    workspace.dispose();
  });

  it('refreshes another instance through the cross-tab storage event', () => {
    const backing = new MapStorage();
    const first = new WorkspaceStorage(backing);
    const second = new WorkspaceStorage(backing);
    const listener = vi.fn();
    second.subscribe(listener);

    first.setItem('luminous-quest:shared', 'next');
    window.dispatchEvent(new StorageEvent('storage', { key: 'luminous-quest:workspace.v3' }));

    expect(second.getItem('luminous-quest:shared')).toBe('next');
    expect(listener).toHaveBeenCalledTimes(1);
    first.dispose();
    second.dispose();
  });

  it('upgrades legacy progress flags into one stage progress record', () => {
    const backing = new MapStorage();
    backing.setItem('luminous-quest:pretest-complete.v1:progress-session', 'true');
    const workspace = new WorkspaceStorage(backing);

    expect(readStageProgress(workspace, 'progress-session')).toMatchObject({
      pretestComplete: true,
      trainingComplete: false,
    });
    expect(workspace.getItem('luminous-quest:pretest-complete.v1:progress-session')).toBeNull();
    expect(workspace.getItem('luminous-quest:progress.v3:progress-session')).not.toBeNull();
    workspace.dispose();
  });
});
