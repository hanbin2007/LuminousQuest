import {
  sessionSchema,
  type StudentSession,
} from '../../shared/session/schema';
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
}

const coordinationStates = new WeakMap<ServerSessionStore, CoordinationState>();

function coordinationState(store: ServerSessionStore) {
  const existing = coordinationStates.get(store);
  if (existing) return existing;
  const created: CoordinationState = {
    mutexes: new Map(),
    idempotency: new Map(),
  };
  coordinationStates.set(store, created);
  return created;
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
    if (previousCommand) {
      if (previousCommand.fingerprint !== fingerprint) {
        throw new SessionIdempotencyConflictError(command.idempotencyKey);
      }
      return {
        ...previousCommand.result,
        replayed: true,
      };
    }

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

    store.set(parsed);
    const result: SessionSyncResult = {
      status: !current || parsed.events.length > current.events.length
        ? 'hydrated'
        : 'already-current',
      replayed: false,
      sequence: parsed.events.length,
      session: parsed,
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
