import { Database } from "bun:sqlite";
import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";

/**
 * SQLite-backed memory system.
 *
 * Zero external deps — uses bun:sqlite. Supports full-text search
 * via SQLite FTS5. Good for local dev and single-machine deployments.
 */
export class SqliteMemory {
  readonly db: Database;

  constructor(path: string = ":memory:") {
    this.db = new Database(path, { create: true });
    this._init();
  }

  private _init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        timestamp INTEGER NOT NULL,
        meta TEXT
      )
    `);

    // FTS5 for full-text search
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
      USING fts5(id, kind, content, content=entries, content_rowid=rowid)
    `);

    // Triggers to keep FTS in sync
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, id, kind, content) VALUES (NEW.rowid, NEW.id, NEW.kind, NEW.content);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, id, kind, content) VALUES ('delete', OLD.rowid, OLD.id, OLD.kind, OLD.content);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, id, kind, content) VALUES ('delete', OLD.rowid, OLD.id, OLD.kind, OLD.content);
        INSERT INTO entries_fts(rowid, id, kind, content) VALUES (NEW.rowid, NEW.id, NEW.kind, NEW.content);
      END
    `);
  }

  /** Write an entry. Upserts. */
  write(entry: SqliteEntry): void {
    this.db.run(
      `INSERT OR REPLACE INTO entries (id, kind, content, source, timestamp, meta) VALUES (?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.kind, entry.content, entry.source ?? null, entry.timestamp, entry.meta ? JSON.stringify(entry.meta) : null]
    );
  }

  /** Read by id. */
  get(id: string): SqliteEntry | undefined {
    const row = this.db.query("SELECT * FROM entries WHERE id = ?").get(id) as any;
    return row ? this._rowToEntry(row) : undefined;
  }

  /** Get all entries, optionally filtered by kind. */
  all(kind?: string): SqliteEntry[] {
    const query = kind
      ? this.db.query("SELECT * FROM entries WHERE kind = ? ORDER BY timestamp DESC")
      : this.db.query("SELECT * FROM entries ORDER BY timestamp DESC");
    const rows = kind ? query.all(kind) : query.all();
    return (rows as any[]).map(this._rowToEntry);
  }

  /** Full-text search. */
  search(query: string, limit: number = 20): SqliteEntry[] {
    const rows = this.db
      .query(
        `SELECT entries.* FROM entries_fts JOIN entries ON entries_fts.id = entries.id WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(query, limit);
    return (rows as any[]).map(this._rowToEntry);
  }

  /** Delete by id. */
  delete(id: string): boolean {
    const result = this.db.run("DELETE FROM entries WHERE id = ?", [id]);
    return result.changes > 0;
  }

  /** Count entries, optionally by kind. */
  count(kind?: string): number {
    const query = kind
      ? this.db.query("SELECT COUNT(*) as c FROM entries WHERE kind = ?")
      : this.db.query("SELECT COUNT(*) as c FROM entries");
    const row = (kind ? query.get(kind) : query.get()) as any;
    return row.c;
  }

  /** Recent entries. */
  recent(limit: number = 50, kind?: string): SqliteEntry[] {
    const query = kind
      ? this.db.query("SELECT * FROM entries WHERE kind = ? ORDER BY timestamp DESC LIMIT ?")
      : this.db.query("SELECT * FROM entries ORDER BY timestamp DESC LIMIT ?");
    const rows = kind ? query.all(kind, limit) : query.all(limit);
    return (rows as any[]).map(this._rowToEntry);
  }

  /** Create a ContextSource that loads entries as context. */
  asSource(id: string, kind?: string, limit: number = 100): ContextSource {
    const mem = this;
    return {
      id,
      async load() {
        const entries = mem.recent(limit, kind);
        if (entries.length === 0) return "";
        return entries
          .map((e) => `[${e.kind}] ${e.id}: ${e.content}`)
          .join("\n");
      },
    };
  }

  /** Create a HydrationAdapter. */
  asAdapter(): HydrationAdapter {
    const mem = this;
    return {
      system: "sqlite",
      async hydrate(ref: ContextRef): Promise<string> {
        const entry = mem.get(ref.locator);
        return entry ? entry.content : "";
      },
      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        return refs.map((r) => {
          const entry = mem.get(r.locator);
          return entry ? entry.content : "";
        });
      },
    };
  }

  /** Signal handler that writes signals to SQLite. */
  signalWriter() {
    const mem = this;
    return async (signal: Signal): Promise<void> => {
      mem.write({
        id: signal.id,
        kind: signal.kind,
        content:
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content),
        source: signal.source,
        timestamp: signal.timestamp,
        meta: { confidence: signal.confidence, refs: signal.refs },
      });
    };
  }

  close(): void {
    this.db.close();
  }

  private _rowToEntry(row: any): SqliteEntry {
    return {
      id: row.id,
      kind: row.kind,
      content: row.content,
      source: row.source ?? undefined,
      timestamp: row.timestamp,
      meta: row.meta ? JSON.parse(row.meta) : undefined,
    };
  }
}

export interface SqliteEntry {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly source?: string;
  readonly timestamp: number;
  readonly meta?: Record<string, unknown>;
}
