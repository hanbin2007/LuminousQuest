const workspaceStorageKey = 'luminous-quest:workspace.v3';
const managedKeyPrefix = 'luminous-quest:';

interface WorkspaceEnvelope {
  schemaVersion: 'workspace.v3';
  revision: number;
  updatedAt: string;
  entries: Record<string, string>;
}

type WorkspaceListener = (changedKey: string | null) => void;

function emptyEnvelope(): WorkspaceEnvelope {
  return {
    schemaVersion: 'workspace.v3',
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    entries: {},
  };
}

function parseEnvelope(source: string | null): WorkspaceEnvelope | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as Partial<WorkspaceEnvelope>;
    if (
      value.schemaVersion !== 'workspace.v3'
      || typeof value.revision !== 'number'
      || !Number.isInteger(value.revision)
      || value.revision < 0
      || typeof value.updatedAt !== 'string'
      || !value.entries
      || typeof value.entries !== 'object'
      || Array.isArray(value.entries)
      || !Object.values(value.entries).every((entry) => typeof entry === 'string')
    ) return null;
    return value as WorkspaceEnvelope;
  } catch {
    return null;
  }
}

class MemoryBackingStore implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function browserBackingStore(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.getItem(workspaceStorageKey);
      return window.localStorage;
    }
  } catch {
    // Privacy modes can expose localStorage while denying access.
  }
  return new MemoryBackingStore();
}

/**
 * A versioned, atomic storage facade for all browser-owned application state.
 * Existing feature stores keep the Storage API while sharing one envelope,
 * one migration boundary, and one cross-tab revision stream.
 */
export class WorkspaceStorage implements Storage {
  private envelope: WorkspaceEnvelope;
  private readonly listeners = new Set<WorkspaceListener>();
  private readonly channel: BroadcastChannel | null;
  private transactionEntries: Record<string, string> | null = null;
  private transactionChangedKeys = new Set<string>();

  constructor(private readonly backing: Storage) {
    this.envelope = parseEnvelope(this.safeReadRoot()) ?? emptyEnvelope();
    this.migrateLegacyEntries();

    this.channel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
      ? new window.BroadcastChannel(workspaceStorageKey)
      : null;
    this.channel?.addEventListener('message', () => this.refreshFromBacking(null));

    if (typeof window !== 'undefined') {
      window.addEventListener('storage', this.handleStorage);
    }
  }

  get length() {
    return Object.keys(this.activeEntries()).length;
  }

  clear() {
    if (this.transactionEntries) {
      this.transactionEntries = {};
      this.transactionChangedKeys.add('*');
      return;
    }
    this.commit({}, null);
  }

  getItem(key: string) {
    return this.activeEntries()[key] ?? null;
  }

  key(index: number) {
    return Object.keys(this.activeEntries())[index] ?? null;
  }

  removeItem(key: string) {
    if (this.transactionEntries) {
      if (!(key in this.transactionEntries)) return;
      delete this.transactionEntries[key];
      this.transactionChangedKeys.add(key);
      return;
    }
    if (!(key in this.activeEntries())) return;
    const next = { ...this.latestEnvelope().entries };
    delete next[key];
    this.commit(next, key);
  }

  setItem(key: string, value: string) {
    if (this.transactionEntries) {
      this.transactionEntries[key] = String(value);
      this.transactionChangedKeys.add(key);
      return;
    }
    const next = { ...this.latestEnvelope().entries, [key]: String(value) };
    this.commit(next, key);
  }

  removeMatching(predicate: (key: string) => boolean) {
    if (this.transactionEntries) {
      Object.keys(this.transactionEntries).forEach((key) => {
        if (!predicate(key)) return;
        delete this.transactionEntries![key];
        this.transactionChangedKeys.add(key);
      });
      return;
    }
    const entries = this.latestEnvelope().entries;
    const next = Object.fromEntries(Object.entries(entries).filter(([key]) => !predicate(key)));
    if (Object.keys(next).length === Object.keys(entries).length) return;
    this.commit(next, null);
  }

  subscribe(listener: WorkspaceListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose() {
    this.channel?.close();
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', this.handleStorage);
    }
    this.listeners.clear();
  }

  transaction<T>(operation: () => T) {
    if (this.transactionEntries) return operation();
    this.transactionEntries = { ...this.latestEnvelope().entries };
    this.transactionChangedKeys.clear();
    try {
      const result = operation();
      const changedKeys = [...this.transactionChangedKeys];
      if (changedKeys.length > 0) {
        const changedKey = changedKeys.length === 1 && changedKeys[0] !== '*'
          ? changedKeys[0]!
          : null;
        this.commit(this.transactionEntries, changedKey);
      }
      return result;
    } finally {
      this.transactionEntries = null;
      this.transactionChangedKeys.clear();
    }
  }

  private readonly handleStorage = (event: StorageEvent) => {
    if (event.key === workspaceStorageKey) this.refreshFromBacking(null);
  };

  private safeReadRoot() {
    try {
      return this.backing.getItem(workspaceStorageKey);
    } catch {
      return null;
    }
  }

  private activeEntries() {
    return this.transactionEntries ?? this.envelope.entries;
  }

  private latestEnvelope() {
    const persisted = parseEnvelope(this.safeReadRoot());
    if (persisted && persisted.revision > this.envelope.revision) this.envelope = persisted;
    return this.envelope;
  }

  private commit(entries: Record<string, string>, changedKey: string | null) {
    const current = this.latestEnvelope();
    const next: WorkspaceEnvelope = {
      schemaVersion: 'workspace.v3',
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      entries,
    };
    this.backing.setItem(workspaceStorageKey, JSON.stringify(next));
    this.envelope = next;
    this.channel?.postMessage({ revision: next.revision });
  }

  private refreshFromBacking(changedKey: string | null) {
    const persisted = parseEnvelope(this.safeReadRoot());
    if (!persisted || persisted.revision <= this.envelope.revision) return;
    this.envelope = persisted;
    this.listeners.forEach((listener) => listener(changedKey));
  }

  private migrateLegacyEntries() {
    const migrated = { ...this.envelope.entries };
    const legacyKeys: string[] = [];
    try {
      for (let index = 0; index < this.backing.length; index += 1) {
        const key = this.backing.key(index);
        if (
          !key
          || key === workspaceStorageKey
          || !key.startsWith(managedKeyPrefix)
        ) continue;
        const value = this.backing.getItem(key);
        if (value === null) continue;
        if (!(key in migrated)) migrated[key] = value;
        legacyKeys.push(key);
      }
      if (legacyKeys.length === 0) return;
      this.commit(migrated, null);
      legacyKeys.forEach((key) => this.backing.removeItem(key));
    } catch {
      // A failed migration leaves legacy values untouched and readable next run.
    }
  }
}

let singleton: WorkspaceStorage | null = null;
let singletonBacking: Storage | null = null;
const memoryBacking = new MemoryBackingStore();

export function getWorkspaceStorage() {
  const backing = typeof window === 'undefined' ? memoryBacking : browserBackingStore();
  if (!singleton || singletonBacking !== backing) {
    singleton?.dispose();
    singleton = new WorkspaceStorage(backing);
    singletonBacking = backing;
  }
  return singleton;
}

export function removeSessionWorkspaceState(sessionId: string) {
  getWorkspaceStorage().removeMatching((key) => key.endsWith(`:${sessionId}`));
}
