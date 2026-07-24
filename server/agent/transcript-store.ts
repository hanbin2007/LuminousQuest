import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import {
  normalizedAgentActionSchema,
  terminalAgentActionNameSchema,
  type NormalizedAgentAction,
} from '../../shared/agent/contracts';

function safeSegment(value: string) {
  if (
    value === '.'
    || value === '..'
    || !/^[A-Za-z0-9._-]{1,240}$/.test(value)
  ) {
    throw new Error('Invalid transcript key');
  }
  return value;
}

export class FileAgentTranscriptStore implements SessionStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    const file = this.fileFor(key);
    const previous = this.tails.get(file) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.read(file);
      const uuids = new Set(current.flatMap((entry) =>
        typeof entry.uuid === 'string' ? [entry.uuid] : []));
      const merged = [...current];
      for (const entry of entries) {
        if (typeof entry.uuid === 'string') {
          if (uuids.has(entry.uuid)) continue;
          uuids.add(entry.uuid);
        }
        merged.push(structuredClone(entry));
      }
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(merged)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporary, file);
    });
    this.tails.set(file, operation);
    try {
      await operation;
    } finally {
      if (this.tails.get(file) === operation) this.tails.delete(file);
    }
  }

  async load(key: SessionKey) {
    const file = this.fileFor(key);
    await this.tails.get(file);
    const entries = await this.read(file);
    return entries.length > 0 ? entries : null;
  }

  async listSessions(projectKey: string) {
    const directory = path.join(this.root, safeSegment(projectKey));
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => ({
        sessionId: file.slice(0, -'.json'.length),
        mtime: (await stat(path.join(directory, file))).mtimeMs,
      })));
  }

  async hasSessionId(sessionId: string) {
    const safeSessionId = safeSegment(sessionId);
    let projects: string[];
    try {
      projects = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    for (const project of projects) {
      if (!/^[A-Za-z0-9._-]{1,240}$/.test(project)) continue;
      try {
        const info = await stat(path.join(this.root, project, `${safeSessionId}.json`));
        if (info.isFile()) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return false;
  }

  private fileFor(key: SessionKey) {
    const subpath = key.subpath
      ? key.subpath.split('/').map(safeSegment)
      : [];
    return path.join(
      this.root,
      safeSegment(key.projectKey),
      ...(
        subpath.length === 0
          ? [`${safeSegment(key.sessionId)}.json`]
          : [safeSegment(key.sessionId), ...subpath.slice(0, -1), `${subpath.at(-1)}.json`]
      ),
    );
  }

  private async read(file: string): Promise<SessionStoreEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('Transcript file must contain an array');
      return parsed.map((entry) => {
        if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
          throw new Error('Transcript entry is invalid');
        }
        return entry as SessionStoreEntry;
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export class InMemoryAgentTranscriptStore implements SessionStore {
  private readonly entries = new Map<string, SessionStoreEntry[]>();
  private readonly modified = new Map<string, number>();

  async append(key: SessionKey, entries: SessionStoreEntry[]) {
    const storageKey = this.storageKey(key);
    const current = this.entries.get(storageKey) ?? [];
    const uuids = new Set(current.flatMap((entry) =>
      typeof entry.uuid === 'string' ? [entry.uuid] : []));
    for (const entry of entries) {
      if (typeof entry.uuid === 'string') {
        if (uuids.has(entry.uuid)) continue;
        uuids.add(entry.uuid);
      }
      current.push(structuredClone(entry));
    }
    this.entries.set(storageKey, current);
    this.modified.set(storageKey, Date.now());
  }

  async load(key: SessionKey) {
    const entries = this.entries.get(this.storageKey(key));
    return entries ? structuredClone(entries) : null;
  }

  async listSessions(projectKey: string) {
    const prefix = `${safeSegment(projectKey)}\u0000`;
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(prefix) && key.split('\u0000').length === 3)
      .map((key) => ({
        sessionId: key.split('\u0000')[1]!,
        mtime: this.modified.get(key) ?? 0,
      }));
  }

  async hasSessionId(sessionId: string) {
    const marker = `\u0000${safeSegment(sessionId)}\u0000`;
    return [...this.entries.keys()].some((key) => key.includes(marker));
  }

  private storageKey(key: SessionKey) {
    return [
      safeSegment(key.projectKey),
      safeSegment(key.sessionId),
      key.subpath ?? '',
    ].join('\u0000');
  }
}

export async function readAgentSessionMessages(sessionId: string, store: SessionStore) {
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
  return getSessionMessages(sessionId, { sessionStore: store });
}

export async function recoverCompletedAgentActions(input: {
  sessionId: string;
  pendingInputId: string;
  store: SessionStore;
}): Promise<NormalizedAgentAction[] | null> {
  let messages;
  try {
    messages = await readAgentSessionMessages(input.sessionId, input.store);
  } catch {
    return null;
  }
  let afterPendingInput = false;
  const actions: NormalizedAgentAction[] = [];
  for (const entry of messages) {
    const message = entry.message as {
      role?: unknown;
      content?: unknown;
    } | null;
    if (!message || typeof message !== 'object') continue;
    if (entry.type === 'user') {
      const content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content);
      afterPendingInput = content.includes(input.pendingInputId);
      if (afterPendingInput) actions.length = 0;
      continue;
    }
    if (!afterPendingInput || entry.type !== 'assistant') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (
        !block
        || typeof block !== 'object'
        || (block as { type?: unknown }).type !== 'tool_use'
      ) continue;
      const candidate = block as {
        id?: unknown;
        name?: unknown;
        input?: unknown;
      };
      const name = typeof candidate.name === 'string'
        ? candidate.name.replace(/^mcp__lq__/, '')
        : '';
      const parsed = normalizedAgentActionSchema.safeParse({
        callId: candidate.id,
        name,
        arguments: candidate.input,
      });
      if (parsed.success) actions.push(parsed.data);
    }
  }
  const terminal = actions.at(-1);
  return terminal && terminalAgentActionNameSchema.safeParse(terminal.name).success
    ? actions
    : null;
}
