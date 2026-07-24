import { createHash } from 'node:crypto';

import {
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';
import { appendSessionEvent } from '../../shared/session/session';
import type { SessionCommandEnvelope } from '../../shared/session/sync';

export type { SessionCommandEnvelope } from '../../shared/session/sync';

export interface SessionSyncResult {
  status: 'hydrated' | 'already-current';
  replayed: boolean;
  sequence: number;
  session: StudentSession;
}

export class SessionSequenceConflictError extends Error {
  constructor(
    readonly expectedSequence: number,
    readonly actualSequence: number,
  ) {
    super(`Expected session sequence ${expectedSequence}, found ${actualSequence}`);
    this.name = 'SessionSequenceConflictError';
  }
}

export class SessionPrefixConflictError extends Error {
  constructor(readonly eventIndex?: number) {
    super(eventIndex === undefined
      ? 'Uploaded session metadata does not match the server session'
      : `Uploaded event prefix differs at sequence ${eventIndex}`);
    this.name = 'SessionPrefixConflictError';
  }
}

export class SessionIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used for a different command`);
    this.name = 'SessionIdempotencyConflictError';
  }
}

export interface ServerSessionStore {
  get(sessionId: string): StudentSession | undefined;
  set(session: StudentSession): void;
}

export interface CoordinatedServerSessionStore extends ServerSessionStore {
  withSessionLock<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T>;
  synchronize(
    uploadedSession: StudentSession,
    command: SessionCommandEnvelope,
  ): Promise<SessionSyncResult>;
}

interface StoredIdempotencyResult {
  fingerprint: string;
  result: SessionSyncResult;
}

interface CoordinationState {
  mutexes: Map<string, Promise<void>>;
  idempotency: Map<string, Map<string, StoredIdempotencyResult>>;
  commandIdempotency: Map<string, Map<string, StoredCommandResult>>;
}

interface StoredCommandResult {
  fingerprint: string;
  value: unknown;
}

const coordinationStates = new WeakMap<ServerSessionStore, CoordinationState>();

function coordinationState(store: ServerSessionStore) {
  const existing = coordinationStates.get(store);
  if (existing) return existing;
  const created: CoordinationState = {
    mutexes: new Map(),
    idempotency: new Map(),
    commandIdempotency: new Map(),
  };
  coordinationStates.set(store, created);
  return created;
}

export type SessionCommandName =
  | 'choice'
  | 'extract'
  | 'equation'
  | 'tutor'
  | 'agent-turn'
  | 'agent-answer';

export interface ExecuteSessionCommandInput<T> {
  store: ServerSessionStore;
  sessionId: string;
  commandName: SessionCommandName;
  expectedSequence: number;
  idempotencyKey: string;
  request: unknown;
  initialize: () => StudentSession;
  execute: (
    session: StudentSession,
  ) => Promise<{ session: StudentSession; value: T }> | {
    session: StudentSession;
    value: T;
  };
}

export interface ExecuteSessionCommandResult<T> {
  session: StudentSession;
  value: T | undefined;
  replayed: boolean;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function commandFingerprint(input: {
  commandName: SessionCommandName;
  expectedSequence: number;
  request: unknown;
}) {
  return `sha256:${createHash('sha256')
    .update(canonicalJson(input))
    .digest('hex')}`;
}

function rebuiltCommandResults(session: StudentSession) {
  return new Map<string, StoredCommandResult>(session.events
    .flatMap((event) => {
      const command = event.command ?? (
        event.kind === 'session.command.executed'
          ? {
              idempotencyKey: event.idempotencyKey,
              requestFingerprint: event.requestFingerprint,
            }
          : undefined
      );
      return command ? [[
        command.idempotencyKey,
        {
          fingerprint: command.requestFingerprint,
          value: undefined,
        } satisfies StoredCommandResult,
      ] as const] : [];
    }));
}

/**
 * Single-machine classroom deployments intentionally keep command coordination
 * in process: there is no DB or WAL. After a process crash, recovery depends on
 * the Phase 3 client sync hydrate path replaying this event stream.
 */
export function executeSessionCommand<T>(
  input: ExecuteSessionCommandInput<T>,
): Promise<ExecuteSessionCommandResult<T>> {
  return withStoreSessionLock(input.store, input.sessionId, async () => {
    const state = coordinationState(input.store);
    const current = sessionSchema.parse(
      input.store.get(input.sessionId) ?? input.initialize(),
    );
    if (current.id !== input.sessionId) {
      throw new Error('Session initializer returned a different session id');
    }
    const fingerprint = commandFingerprint({
      commandName: input.commandName,
      expectedSequence: input.expectedSequence,
      request: input.request,
    });
    const rebuilt = rebuiltCommandResults(current);
    const remembered = state.commandIdempotency.get(input.sessionId);
    remembered?.forEach((entry, key) => {
      const fromStream = rebuilt.get(key);
      if (!fromStream || fromStream.fingerprint === entry.fingerprint) {
        rebuilt.set(key, entry);
      }
    });
    state.commandIdempotency.set(input.sessionId, rebuilt);
    const previous = rebuilt.get(input.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new SessionIdempotencyConflictError(input.idempotencyKey);
      }
      return {
        session: current,
        value: previous.value as T | undefined,
        replayed: true,
      };
    }
    if (input.expectedSequence !== current.events.length) {
      throw new SessionSequenceConflictError(
        input.expectedSequence,
        current.events.length,
      );
    }

    const executed = await input.execute(current);
    const next = sessionSchema.parse(executed.session);
    if (!sameMetadata(current, next)) {
      throw new SessionPrefixConflictError();
    }
    for (let index = 0; index < current.events.length; index += 1) {
      if (JSON.stringify(current.events[index]) !== JSON.stringify(next.events[index])) {
        throw new SessionPrefixConflictError(index);
      }
    }
    const resultEventIds = next.events
      .slice(current.events.length)
      .map((event) => event.id);
    const markerDigest = createHash('sha256')
      .update(`${input.sessionId}\u0000${input.idempotencyKey}`)
      .digest('hex')
      .slice(0, 32);
    const commandMetadata = {
      commandName: input.commandName,
      idempotencyKey: input.idempotencyKey,
      expectedSequence: input.expectedSequence,
      resultingSequence: next.events.length,
      requestFingerprint: fingerprint,
    } as const;
    let recoveryEventIndex = -1;
    for (
      let index = next.events.length - 1;
      index >= current.events.length;
      index -= 1
    ) {
      const event = next.events[index];
      if (
        event
        && event.kind !== 'agent.judgment.recorded'
        && event.kind !== 'agent.divergence.changed'
      ) {
        recoveryEventIndex = index;
        break;
      }
    }
    const completed = recoveryEventIndex >= current.events.length
      ? sessionSchema.parse({
          ...next,
          events: next.events.map((event, index) =>
            index === recoveryEventIndex
              ? { ...event, command: commandMetadata }
              : event),
        })
      : appendSessionEvent(next, {
          id: `command-${markerDigest}`,
          occurredAt: next.updatedAt,
          kind: 'session.command.executed',
          pipelineStage: 'command',
          caseId: next.events.at(-1)?.caseId ?? 'session',
          stageId: next.events.at(-1)?.stageId ?? 'command',
          attemptId: input.idempotencyKey,
          commandName: input.commandName,
          idempotencyKey: input.idempotencyKey,
          expectedSequence: input.expectedSequence,
          resultingSequence: next.events.length + 1,
          requestFingerprint: fingerprint,
          resultEventIds,
        });
    const persisted = sessionSchema.parse({
      ...completed,
      serverSequence: completed.events.length,
    });
    input.store.set(persisted);
    rebuilt.set(input.idempotencyKey, {
      fingerprint,
      value: executed.value,
    });
    return {
      session: persisted,
      value: executed.value,
      replayed: false,
    };
  });
}

function sameMetadata(left: StudentSession, right: StudentSession) {
  return left.schemaVersion === right.schemaVersion
    && left.agentContractRevision === right.agentContractRevision
    && left.toolsetDigest === right.toolsetDigest
    && left.contextBuilderVersion === right.contextBuilderVersion
    && left.id === right.id
    && left.anonymousStudentId === right.anonymousStudentId
    && left.startedAt === right.startedAt
    && JSON.stringify(left.configVersions) === JSON.stringify(right.configVersions);
}

async function withStoreSessionLock<T>(
  store: ServerSessionStore,
  sessionId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  const state = coordinationState(store);
  const previous = state.mutexes.get(sessionId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  state.mutexes.set(sessionId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (state.mutexes.get(sessionId) === tail) {
      state.mutexes.delete(sessionId);
    }
  }
}

function synchronizeStore(
  store: ServerSessionStore,
  uploadedSession: StudentSession,
  command: SessionCommandEnvelope,
) {
  const parsed = sessionSchema.parse(uploadedSession);
  return withStoreSessionLock(store, parsed.id, () => {
    const state = coordinationState(store);
    const fingerprint = JSON.stringify({
      expectedSequence: command.expectedSequence,
      session: parsed,
    });
    const sessionIdempotency = state.idempotency.get(parsed.id)
      ?? new Map<string, StoredIdempotencyResult>();
    const previousCommand = sessionIdempotency.get(command.idempotencyKey);
    if (previousCommand && previousCommand.fingerprint === fingerprint) {
      return {
        ...previousCommand.result,
        replayed: true,
      };
    }
    // 指纹不同不视为冲突:sync 是前缀调和,同 key 携带演进后的会话属预期
    // (客户端跨启动重放、updatedAt 漂移)。按新尝试正常执行并覆盖记录;
    // 真正的分叉由下方 sequence/prefix 校验拦截。

    const current = store.get(parsed.id);
    const actualSequence = current?.events.length ?? 0;
    if (command.expectedSequence !== actualSequence) {
      throw new SessionSequenceConflictError(command.expectedSequence, actualSequence);
    }
    if (current) {
      if (!sameMetadata(current, parsed)) {
        throw new SessionPrefixConflictError();
      }
      if (parsed.events.length < current.events.length) {
        throw new SessionPrefixConflictError(parsed.events.length);
      }
      for (let index = 0; index < current.events.length; index += 1) {
        if (JSON.stringify(current.events[index]) !== JSON.stringify(parsed.events[index])) {
          throw new SessionPrefixConflictError(index);
        }
      }
    }

    const persisted = sessionSchema.parse({
      ...parsed,
      serverSequence: parsed.events.length,
    });
    store.set(persisted);
    const result: SessionSyncResult = {
      status: !current || parsed.events.length > current.events.length
        ? 'hydrated'
        : 'already-current',
      replayed: false,
      sequence: parsed.events.length,
      session: persisted,
    };
    sessionIdempotency.set(command.idempotencyKey, {
      fingerprint,
      result,
    });
    state.idempotency.set(parsed.id, sessionIdempotency);
    return result;
  });
}

export function coordinateSessionStore(
  store: ServerSessionStore,
): CoordinatedServerSessionStore {
  const candidate = store as Partial<CoordinatedServerSessionStore>;
  if (
    typeof candidate.withSessionLock === 'function'
    && typeof candidate.synchronize === 'function'
  ) {
    return store as CoordinatedServerSessionStore;
  }
  return {
    get: (sessionId) => store.get(sessionId),
    set: (session) => store.set(session),
    withSessionLock: (sessionId, operation) =>
      withStoreSessionLock(store, sessionId, operation),
    synchronize: (session, command) => synchronizeStore(store, session, command),
  };
}

export class InMemorySessionStore implements CoordinatedServerSessionStore {
  private readonly sessions = new Map<string, StudentSession>();

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  set(session: StudentSession) {
    const parsed = sessionSchema.parse(session);
    this.sessions.set(parsed.id, parsed);
  }

  withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T> | T,
  ) {
    return withStoreSessionLock(this, sessionId, operation);
  }

  synchronize(
    uploadedSession: StudentSession,
    command: SessionCommandEnvelope,
  ) {
    return synchronizeStore(this, uploadedSession, command);
  }
}
