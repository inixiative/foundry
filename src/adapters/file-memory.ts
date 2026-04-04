import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";

/**
 * A simple file-based memory system.
 *
 * Stores entries as JSON files in a directory. Each entry has an id,
 * content, kind, and timestamp. No external deps — just the filesystem.
 *
 * Use this as the default built-in memory. Swap for pgvector, Redis,
 * MuninnDB, etc. in production.
 */
export class FileMemory {
  readonly dir: string;
  private _entries: Map<string, MemoryEntry> = new Map();
  private _loaded = false;

  constructor(dir: string) {
    this.dir = dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** Load all entries from disk. */
  async load(): Promise<void> {
    const files = new Bun.Glob("*.json").scanSync(this.dir);
    for (const file of files) {
      const path = join(this.dir, file);
      const data = await Bun.file(path).json();
      this._entries.set(data.id, data as MemoryEntry);
    }
    this._loaded = true;
  }

  /** Write an entry to memory. */
  async write(entry: MemoryEntry): Promise<void> {
    this._entries.set(entry.id, entry);
    const path = join(this.dir, `${entry.id}.json`);
    await Bun.write(path, JSON.stringify(entry, null, 2));
  }

  /** Read an entry by id. */
  get(id: string): MemoryEntry | undefined {
    return this._entries.get(id);
  }

  /** Get all entries, optionally filtered by kind. */
  all(kind?: string): MemoryEntry[] {
    const entries = [...this._entries.values()];
    return kind ? entries.filter((e) => e.kind === kind) : entries;
  }

  /** Search entries by content substring. */
  search(query: string): MemoryEntry[] {
    const lower = query.toLowerCase();
    return [...this._entries.values()].filter((e) =>
      e.content.toLowerCase().includes(lower)
    );
  }

  /** Delete an entry. */
  async delete(id: string): Promise<boolean> {
    if (!this._entries.has(id)) return false;
    this._entries.delete(id);
    const path = join(this.dir, `${id}.json`);
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(path);
    } catch {}
    return true;
  }

  /** Get all entries as a formatted string (for use as context). */
  toContext(): string {
    const entries = [...this._entries.values()]
      .sort((a, b) => b.timestamp - a.timestamp);

    if (entries.length === 0) return "(no entries)";

    return entries
      .map((e) => `[${e.kind}] ${e.id}: ${e.content}`)
      .join("\n");
  }

  /** Create a ContextSource that loads this memory as context. */
  asSource(id: string, kind?: string): ContextSource {
    const mem = this;
    return {
      id,
      async load() {
        if (!mem._loaded) await mem.load();
        const entries = mem.all(kind);
        if (entries.length === 0) return "";
        return entries
          .sort((a, b) => b.timestamp - a.timestamp)
          .map((e) => `[${e.kind}] ${e.id}: ${e.content}`)
          .join("\n");
      },
    };
  }

  /** Create a HydrationAdapter for this memory system. */
  asAdapter(): HydrationAdapter {
    const mem = this;
    return {
      system: "file-memory",
      async hydrate(ref: ContextRef): Promise<string> {
        if (!mem._loaded) await mem.load();
        const entry = mem.get(ref.locator);
        return entry ? entry.content : "";
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        if (!mem._loaded) await mem.load();
        return refs.map((r) => {
          const entry = mem.get(r.locator);
          return entry ? entry.content : "";
        });
      },
    };
  }

  /**
   * Create a signal handler that writes signals to this memory.
   * Wire this into the SignalBus to auto-persist signals.
   */
  signalWriter() {
    const mem = this;
    return async (signal: Signal): Promise<void> => {
      const entry: MemoryEntry = {
        id: signal.id,
        kind: signal.kind,
        content:
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content),
        source: signal.source,
        timestamp: signal.timestamp,
        meta: { confidence: signal.confidence, refs: signal.refs },
      };
      await mem.write(entry);
    };
  }
}

export interface MemoryEntry {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
}

/**
 * Simple file-based doc source — reads a file and returns its content.
 */
export function fileSource(id: string, path: string): ContextSource {
  return {
    id,
    async load() {
      const file = Bun.file(path);
      if (!(await file.exists())) return "";
      return file.text();
    },
  };
}

/**
 * Inline source — just returns a static string. Useful for testing.
 */
export function inlineSource(id: string, content: string): ContextSource {
  return {
    id,
    async load() {
      return content;
    },
  };
}
