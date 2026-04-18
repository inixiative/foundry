// ---------------------------------------------------------------------------
// SessionAdapter — mapping between Foundry threads and external session IDs
// ---------------------------------------------------------------------------
//
// A HarnessSession's `externalSessionId` is the runtime's native ID (e.g. the
// UUID in ~/.claude/projects/<id>.jsonl). A SessionAdapter maps between
// Foundry's internal thread ID and this external ID.
//
// Two concerns:
//
// 1. ExternalSessionStore — persists the mapping so it survives Foundry
//    process restarts. Without this, crash recovery is impossible because
//    the runtime's native session would be abandoned.
//
// 2. SessionAdapter — creates (or resumes) a HarnessSession for a Foundry
//    thread. On first call for a thread, the session starts fresh and its
//    native ID is captured + persisted. On subsequent calls (e.g. after
//    Foundry restarts), the adapter loads the native ID from the store and
//    constructs a session that resumes (via --resume) rather than starts
//    a new one.
// ---------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { HarnessSession } from "./harness-session";
import { ClaudeCodeSession, type ClaudeCodeSessionConfig } from "./claude-code-session";

// ---------------------------------------------------------------------------
// ExternalSessionStore — persists (threadId, runtime) → externalSessionId
// ---------------------------------------------------------------------------

export interface ExternalSessionStore {
  /** Load the external session ID for a thread on a given runtime. */
  load(threadId: string, runtime: string): Promise<string | null>;
  /** Persist the external session ID. Overwrites any existing mapping. */
  save(threadId: string, runtime: string, externalSessionId: string): Promise<void>;
  /** Remove the mapping (e.g. on thread archive). */
  clear(threadId: string, runtime: string): Promise<void>;
  /** List all mappings (for diagnostics / viewer). */
  all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>>;
}

// ---------------------------------------------------------------------------
// InMemoryExternalSessionStore — for tests and ephemeral usage
// ---------------------------------------------------------------------------

export class InMemoryExternalSessionStore implements ExternalSessionStore {
  private _map = new Map<string, string>();

  private _key(threadId: string, runtime: string): string {
    return `${runtime}:${threadId}`;
  }

  async load(threadId: string, runtime: string): Promise<string | null> {
    return this._map.get(this._key(threadId, runtime)) ?? null;
  }

  async save(threadId: string, runtime: string, id: string): Promise<void> {
    this._map.set(this._key(threadId, runtime), id);
  }

  async clear(threadId: string, runtime: string): Promise<void> {
    this._map.delete(this._key(threadId, runtime));
  }

  async all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>> {
    const out: Array<{ threadId: string; runtime: string; externalSessionId: string }> = [];
    for (const [key, id] of this._map) {
      const idx = key.indexOf(":");
      out.push({
        runtime: key.slice(0, idx),
        threadId: key.slice(idx + 1),
        externalSessionId: id,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// FileExternalSessionStore — JSON file, survives Foundry restarts
// ---------------------------------------------------------------------------
//
// Format: { [runtime]: { [threadId]: externalSessionId } }
//
// Writes are atomic (temp file + rename) so a crash mid-write doesn't
// corrupt the store. This is the default store for production use —
// it's the critical piece for crash recovery.
// ---------------------------------------------------------------------------

type FileStoreData = Record<string, Record<string, string>>;

export class FileExternalSessionStore implements ExternalSessionStore {
  private _path: string;
  private _cache: FileStoreData | null = null;
  private _writeLock: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this._path = path;
  }

  /** Default path: `<projectRoot>/.foundry/sessions.json`. */
  static forProject(projectRoot: string): FileExternalSessionStore {
    return new FileExternalSessionStore(
      join(projectRoot, ".foundry", "sessions.json"),
    );
  }

  private async _read(): Promise<FileStoreData> {
    if (this._cache) return this._cache;
    try {
      const raw = await readFile(this._path, "utf-8");
      this._cache = JSON.parse(raw) as FileStoreData;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") {
        this._cache = {};
      } else {
        throw err;
      }
    }
    return this._cache!;
  }

  /**
   * Serialize mutations end-to-end. The mutator runs inside the lock and
   * receives the freshest cache, so concurrent save/clear calls compose
   * correctly instead of all racing against the same stale snapshot.
   */
  private async _mutate(fn: (data: FileStoreData) => FileStoreData | null): Promise<void> {
    const prev = this._writeLock;
    let release!: () => void;
    this._writeLock = new Promise<void>((r) => { release = r; });
    try {
      await prev;
      const current = await this._read();
      const next = fn(current);
      if (next === null) return; // no-op (e.g. clear on missing key)
      await mkdir(dirname(this._path), { recursive: true });
      const tmp = `${this._path}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(tmp, JSON.stringify(next, null, 2), "utf-8");
      await rename(tmp, this._path);
      this._cache = next;
    } finally {
      release();
    }
  }

  async load(threadId: string, runtime: string): Promise<string | null> {
    const data = await this._read();
    return data[runtime]?.[threadId] ?? null;
  }

  async save(threadId: string, runtime: string, id: string): Promise<void> {
    await this._mutate((data) => ({
      ...data,
      [runtime]: { ...(data[runtime] ?? {}), [threadId]: id },
    }));
  }

  async clear(threadId: string, runtime: string): Promise<void> {
    await this._mutate((data) => {
      if (!data[runtime] || !(threadId in data[runtime])) return null;
      const bucket = { ...data[runtime] };
      delete bucket[threadId];
      const next: FileStoreData = { ...data, [runtime]: bucket };
      if (Object.keys(bucket).length === 0) delete next[runtime];
      return next;
    });
  }

  async all(): Promise<Array<{ threadId: string; runtime: string; externalSessionId: string }>> {
    const data = await this._read();
    const out: Array<{ threadId: string; runtime: string; externalSessionId: string }> = [];
    for (const [runtime, bucket] of Object.entries(data)) {
      for (const [threadId, externalSessionId] of Object.entries(bucket)) {
        out.push({ runtime, threadId, externalSessionId });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// SessionAdapter — per-runtime factory for HarnessSessions with ID mapping
// ---------------------------------------------------------------------------

export interface CreateSessionOpts {
  /** Foundry's internal thread ID. */
  threadId: string;
  /** Working directory for the session. */
  cwd: string;
  /** Stable base context injected at process startup. */
  baseContext?: string;
}

export interface SessionAdapter {
  readonly runtime: string;

  /**
   * Create (or resume) a HarnessSession for a Foundry thread. If the store
   * has a mapping for this thread+runtime, the session spawns with --resume
   * and continues the native session. Otherwise a fresh native session is
   * created on first turn; its ID is captured and persisted automatically.
   *
   * The returned session is UNSTARTED — caller must call session.start().
   */
  createSession(opts: CreateSessionOpts): Promise<HarnessSession>;

  /** Get the persisted external session ID for a thread (if any). */
  getExternalSessionId(threadId: string): Promise<string | null>;

  /** Remove the mapping (e.g. on thread archive). */
  clearSession(threadId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// ClaudeCodeSessionAdapter
// ---------------------------------------------------------------------------

export interface ClaudeCodeSessionAdapterConfig {
  /** Where to persist the (thread, external ID) mapping. */
  store: ExternalSessionStore;
  /** Defaults applied to every session. Merged per createSession(). */
  defaults?: Omit<ClaudeCodeSessionConfig, "cwd" | "baseContext" | "externalSessionId">;
}

export class ClaudeCodeSessionAdapter implements SessionAdapter {
  readonly runtime = "claude-code";
  private _store: ExternalSessionStore;
  private _defaults: ClaudeCodeSessionAdapterConfig["defaults"];

  constructor(config: ClaudeCodeSessionAdapterConfig) {
    this._store = config.store;
    this._defaults = config.defaults;
  }

  async createSession(opts: CreateSessionOpts): Promise<HarnessSession> {
    const existing = await this._store.load(opts.threadId, this.runtime);

    const session = new ClaudeCodeSession({
      ...this._defaults,
      cwd: opts.cwd,
      baseContext: opts.baseContext,
      externalSessionId: existing ?? undefined,
    });

    // Capture + persist the external ID once the session learns it.
    // If `existing` was set, this just confirms the same ID; if not, the
    // runtime assigns a new ID on its first turn and we persist it so a
    // future Foundry restart can resume.
    let lastPersisted = existing ?? undefined;
    session.onEvent((_event) => {
      const current = session.externalSessionId;
      if (!current || current === lastPersisted) return;
      lastPersisted = current;
      // Fire-and-forget — a persistence failure shouldn't crash the session.
      // Emit an error event so the caller can observe it.
      void this._store
        .save(opts.threadId, this.runtime, current)
        .catch((err) => {
          console.warn(
            "[ClaudeCodeSessionAdapter] failed to persist external session id:",
            (err as Error).message,
          );
        });
    });

    return session;
  }

  async getExternalSessionId(threadId: string): Promise<string | null> {
    return this._store.load(threadId, this.runtime);
  }

  async clearSession(threadId: string): Promise<void> {
    return this._store.clear(threadId, this.runtime);
  }
}
