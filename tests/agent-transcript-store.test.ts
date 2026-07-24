import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileAgentTranscriptStore } from '../server/agent/transcript-store';

describe('Agent SDK transcript store', () => {
  it('round-trips opaque entries, deduplicates UUIDs, and survives a new store instance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lq-agent-transcript-'));
    const key = {
      projectKey: 'luminous-quest',
      sessionId: '00000000-0000-4000-8000-000000000001',
    };
    const first = new FileAgentTranscriptStore(root);
    await first.append(key, [
      { type: 'user', uuid: 'entry-1', timestamp: '2026-07-24T08:00:00.000Z', value: 1 },
      { type: 'marker', value: 'kept-without-uuid' },
    ]);
    await first.append(key, [
      { type: 'user', uuid: 'entry-1', timestamp: '2026-07-24T08:00:00.000Z', value: 1 },
      { type: 'assistant', uuid: 'entry-2', timestamp: '2026-07-24T08:00:01.000Z' },
    ]);

    const second = new FileAgentTranscriptStore(root);
    expect(await second.load(key)).toEqual([
      { type: 'user', uuid: 'entry-1', timestamp: '2026-07-24T08:00:00.000Z', value: 1 },
      { type: 'marker', value: 'kept-without-uuid' },
      { type: 'assistant', uuid: 'entry-2', timestamp: '2026-07-24T08:00:01.000Z' },
    ]);
    expect((await second.listSessions?.('luminous-quest'))?.[0]?.sessionId)
      .toBe(key.sessionId);
    expect((await readFile(path.join(root, 'luminous-quest', `${key.sessionId}.json`), 'utf8')))
      .toContain('entry-2');
  });

  it('keeps project and session keys inside the configured root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lq-agent-transcript-safe-'));
    const store = new FileAgentTranscriptStore(root);
    await expect(store.append({
      projectKey: '../outside',
      sessionId: '00000000-0000-4000-8000-000000000001',
    }, [{ type: 'user' }])).rejects.toThrow(/invalid transcript key/i);
  });
});
