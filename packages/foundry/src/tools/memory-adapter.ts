// ---------------------------------------------------------------------------
// MemoryToolAdapter — wraps any Foundry memory backend into a MemoryTool
//
// All Foundry memory adapters (FileMemory, SqliteMemory, RedisMemory,
// PostgresMemory, SupermemoryAdapter, MuninnMemory) share the same shape:
//   write/get/search/delete + asSource + signalWriter
//
// Ownership: a thread reaches the tool through ToolRegistry.dispatch with its
// scope, and the registry only accepts tools that implement `scoped()`. This
// adapter scopes through the backend's `view(scope)` when it has one
// (FileMemory). Backends without views cannot honor a scope, so their scoped
// tool refuses reads and deletes instead of leaking the whole store. Unscoped
// use (no thread) sees only globally published knowledge.
//
// Usage:
//   const fileMemory = new FileMemory(".foundry/memory");
//   const tool = MemoryToolAdapter.fromFileMemory(fileMemory);
//   tools.register(tool, "Project memory");
// ---------------------------------------------------------------------------

import type {
  MemoryTool,
  MemoryEntry,
  MemoryReadScope,
  MemorySearchOpts,
  OwnershipScope,
  ToolResult,
} from "@inixiative/foundry-core";

/**
 * Minimal interface that all Foundry memory adapters implement.
 * If your adapter has these methods, it can be wrapped as a MemoryTool.
 */
export interface MemoryBackend {
  /** Write an entry. */
  write(entry: MemoryEntry): Promise<void>;
  /** Read by ID. May return undefined or the entry. */
  get(id: string): MemoryEntry | undefined | Promise<MemoryEntry | undefined>;
  /** Search by query string. */
  search(query: string, limit?: number): MemoryEntry[] | Promise<MemoryEntry[]>;
  /** Get all entries, optionally filtered by kind. */
  all?(kind?: string): MemoryEntry[] | Promise<MemoryEntry[]>;
  /** Get recent entries. */
  recent?(limit?: number, kind?: string): MemoryEntry[] | Promise<MemoryEntry[]>;
  /** Delete by ID. */
  delete?(id: string): boolean | Promise<boolean>;
  /**
   * A backend restricted to one reader scope. Backends that store ownership
   * (FileMemory) implement this; the adapter routes every scoped call here.
   */
  view?(scope: MemoryReadScope): MemoryBackend;
}

/**
 * Extended backend for adapters with richer query capabilities
 * (Postgres, Supermemory, etc.)
 */
export interface RichMemoryBackend extends MemoryBackend {
  /** Scored search results (Supermemory, pgvector, etc.) */
  searchMemories?(query: string, opts?: { limit?: number; containerTag?: string }): Promise<Array<{ content: string; score?: number; metadata?: any }>>;
  /** Full-text search with ranking (SqliteMemory FTS5, etc.) */
  searchEntries?(query: string, limit?: number): Promise<MemoryEntry[]>;
}

export interface MemoryToolAdapterConfig {
  /** Tool ID. Default: "memory-{system}". */
  id?: string;
  /** System name (e.g., "file", "sqlite", "redis", "postgres", "supermemory"). */
  system: string;
  /** The memory backend to wrap. */
  backend: MemoryBackend;
  /**
   * Internal: the scope this adapter was created for. Set by `scoped()`;
   * an adapter with a scope and a backend that cannot view refuses reads.
   */
  scope?: OwnershipScope;
}

export class MemoryToolAdapter implements MemoryTool {
  readonly id: string;
  readonly kind = "memory" as const;
  readonly system: string;
  readonly capabilities = {
    read: "data:read" as const,
    write: "data:write" as const,
    delete: "data:delete" as const,
  };

  private _backend: MemoryBackend;
  private _root: MemoryBackend;
  private _scope: OwnershipScope | undefined;

  constructor(config: MemoryToolAdapterConfig) {
    this.id = config.id ?? `memory-${config.system}`;
    this.system = config.system;
    this._root = config.backend;
    this._scope = config.scope;
    // Unscoped adapters over an ownership-aware backend see only global
    // publications: the whole store is the operator's, never a tool's.
    this._backend = config.backend.view ? config.backend.view(config.scope ?? {}) : config.backend;
  }

  /** The tool as seen by one thread/project. */
  scoped(scope: OwnershipScope): MemoryToolAdapter {
    return new MemoryToolAdapter({ id: this.id, system: this.system, backend: this._root, scope });
  }

  /** Whether this adapter can honor its scope. */
  private _cannotScope(): ToolResult<never> | null {
    if (this._scope && !this._root.view) {
      return {
        ok: false,
        summary: `${this.system} memory cannot scope reads to thread "${this._scope.threadId ?? "?"}"`,
        error: "Backend stores no ownership; scoped reads refused",
      };
    }
    return null;
  }

  async search(query: string, opts?: MemorySearchOpts): Promise<ToolResult<MemoryEntry[]>> {
    const refused = this._cannotScope();
    if (refused) return refused;
    try {
      const limit = opts?.limit ?? 20;
      let results: MemoryEntry[];

      const rich = this._backend as RichMemoryBackend;
      if (rich.searchMemories) {
        const scored = await rich.searchMemories(query, { limit });
        results = scored
          .filter((r) => !opts?.minScore || (r.score ?? 1) >= opts.minScore)
          .map((r, i) => ({
            id: `search-${i}`,
            kind: "memory",
            content: typeof r.content === "string" ? r.content : JSON.stringify(r.content),
            timestamp: Date.now(),
            meta: { score: r.score, ...r.metadata },
          }));
      } else if (rich.searchEntries) {
        results = await rich.searchEntries(query, limit);
      } else {
        const all = await this._backend.search(query, limit);
        results = Array.isArray(all) ? all.slice(0, limit) : [];
      }

      if (opts?.kind) {
        results = results.filter((e) => e.kind === opts.kind);
      }

      const summary = results.length > 0
        ? `Found ${results.length} entries for "${query}" in ${this.system}`
        : `No entries found for "${query}" in ${this.system}`;

      return {
        ok: true,
        data: results,
        summary,
        estimatedTokens: results.reduce((t, e) => t + Math.ceil(e.content.length / 4), 0),
      };
    } catch (err) {
      return {
        ok: false,
        summary: `Memory search failed in ${this.system}`,
        error: (err as Error).message,
      };
    }
  }

  async get(id: string): Promise<ToolResult<MemoryEntry | null>> {
    const refused = this._cannotScope();
    if (refused) return refused;
    try {
      const entry = await this._backend.get(id);
      if (!entry) {
        return { ok: true, data: null, summary: `No entry "${id}" in ${this.system}` };
      }
      return {
        ok: true,
        data: entry,
        summary: `[${entry.kind}] ${entry.id}: ${entry.content.slice(0, 80)}...`,
        estimatedTokens: Math.ceil(entry.content.length / 4),
      };
    } catch (err) {
      return { ok: false, summary: `Memory get failed`, error: (err as Error).message };
    }
  }

  async recent(limit = 20, kind?: string): Promise<ToolResult<MemoryEntry[]>> {
    const refused = this._cannotScope();
    if (refused) return refused;
    try {
      let entries: MemoryEntry[];

      if (this._backend.recent) {
        entries = await this._backend.recent(limit, kind);
      } else if (this._backend.all) {
        entries = (await this._backend.all(kind))
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
      } else {
        entries = (await this._backend.search("", limit)).slice(0, limit);
      }

      return {
        ok: true,
        data: entries,
        summary: `${entries.length} recent entries from ${this.system}${kind ? ` (kind: ${kind})` : ""}`,
        estimatedTokens: entries.reduce((t, e) => t + Math.ceil(e.content.length / 4), 0),
      };
    } catch (err) {
      return { ok: false, summary: `Memory recent failed`, error: (err as Error).message };
    }
  }

  /**
   * Write an entry. Through a scoped view the entry is owned by the scope and
   * private unless `visibility` publishes it. Without an ownership-aware
   * backend the entry is stored as given.
   */
  async write(entry: MemoryEntry): Promise<ToolResult<{ id: string }>> {
    try {
      await this._backend.write(entry);
      const visibility = this._root.view ? ` (${entry.visibility ?? "thread"})` : "";
      return {
        ok: true,
        data: { id: entry.id },
        summary: `Wrote [${entry.kind}] "${entry.id}" to ${this.system}${visibility}`,
      };
    } catch (err) {
      return { ok: false, summary: `Memory write failed`, error: (err as Error).message };
    }
  }

  async delete(id: string): Promise<ToolResult<{ deleted: boolean }>> {
    const refused = this._cannotScope();
    if (refused) return refused;
    try {
      if (!this._backend.delete) {
        return { ok: false, summary: `${this.system} doesn't support delete`, error: "Not implemented" };
      }
      const deleted = await this._backend.delete(id);
      return {
        ok: true,
        data: { deleted: !!deleted },
        summary: deleted ? `Deleted "${id}" from ${this.system}` : `"${id}" not found in ${this.system}`,
      };
    } catch (err) {
      return { ok: false, summary: `Memory delete failed`, error: (err as Error).message };
    }
  }

  /** Wrap a FileMemory instance. */
  static fromFileMemory(memory: MemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "file", backend: memory, id });
  }

  /** Wrap a SqliteMemory instance. */
  static fromSqliteMemory(memory: MemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "sqlite", backend: memory, id });
  }

  /** Wrap a RedisMemory instance. */
  static fromRedisMemory(memory: MemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "redis", backend: memory, id });
  }

  /** Wrap a PostgresMemory instance. */
  static fromPostgresMemory(memory: MemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "postgres", backend: memory, id });
  }

  /** Wrap a SupermemoryAdapter instance. */
  static fromSupermemory(memory: RichMemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "supermemory", backend: memory, id });
  }

  /** Wrap a MuninnMemory instance. */
  static fromMuninnMemory(memory: RichMemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system: "muninn", backend: memory, id });
  }

  /** Wrap any backend — the generic escape hatch. */
  static from(system: string, backend: MemoryBackend, id?: string): MemoryToolAdapter {
    return new MemoryToolAdapter({ system, backend, id });
  }
}
