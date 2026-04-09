import type {
  ContextSource,
  HydrationAdapter,
  ContextRef,
  Signal,
  MemoryEntry,
} from "@inixiative/foundry-core";

/**
 * MuninnDB adapter — cognitive database with neural memory primitives.
 *
 * Connects Foundry's context layer system to a self-hosted MuninnDB for:
 * - Ebbinghaus decay (memories fade when unused)
 * - Hebbian learning (memories strengthen on access)
 * - Bayesian confidence (probabilistic truth tracking)
 * - Automatic associations (engram linking)
 *
 * Zero SDK — uses fetch directly against the REST API (port 8475).
 * Self-hosted via Docker: ghcr.io/scrypster/muninndb:latest
 *
 * @see https://muninndb.com/docs/api/rest
 */
export class MuninnMemory {
  private _baseUrl: string;
  private _timeout: number;
  private _token: string | undefined;

  /** Default vault for scoping memories. */
  readonly vault: string;

  constructor(opts: MuninnConfig) {
    this._baseUrl = (opts.baseUrl ?? "http://localhost:8475").replace(/\/$/, "") + "/api";
    this._timeout = opts.timeout ?? 15_000;
    this._token = opts.token;
    this.vault = opts.vault ?? "default";
  }

  // ---------------------------------------------------------------------------
  // Low-level API
  // ---------------------------------------------------------------------------

  private async _fetch(
    path: string,
    init?: RequestInit & { params?: Record<string, string> },
  ): Promise<Response> {
    const url = new URL(path, this._baseUrl.endsWith("/") ? this._baseUrl : this._baseUrl + "/");
    if (init?.params) {
      for (const [k, v] of Object.entries(init.params)) {
        url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string>),
    };
    if (this._token) {
      headers["Authorization"] = `Bearer ${this._token}`;
    }

    const res = await fetch(url.toString(), {
      ...init,
      headers,
      signal: AbortSignal.timeout(this._timeout),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const safeBody = body.length > 200 ? body.slice(0, 200) + "…" : body;
      const sanitized = safeBody
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/mk_[a-zA-Z0-9_-]{8,}/g, "[REDACTED]");
      throw new Error(`muninn ${res.status}: ${res.statusText} ${sanitized}`);
    }

    return res;
  }

  // ---------------------------------------------------------------------------
  // Engrams (store)
  // ---------------------------------------------------------------------------

  /** Store a memory entry as an engram. */
  async write(entry: MemoryEntry): Promise<void> {
    await this._fetch("engrams", {
      method: "POST",
      body: JSON.stringify({
        vault: this.vault,
        concept: entry.kind ?? "memory",
        content: entry.content,
        tags: entry.meta?.tags ?? [],
        confidence: entry.meta?.confidence ?? 1.0,
        metadata: {
          foundry_id: entry.id,
          source: entry.source,
          timestamp: entry.timestamp,
          ...entry.meta,
        },
      }),
    });
  }

  /** Batch-write entries (up to 50 per call, auto-chunks). */
  async writeBatch(entries: MemoryEntry[]): Promise<void> {
    const CHUNK_SIZE = 50;
    for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
      const chunk = entries.slice(i, i + CHUNK_SIZE);
      const engrams = chunk.map((entry) => ({
        vault: this.vault,
        concept: entry.kind ?? "memory",
        content: entry.content,
        tags: entry.meta?.tags ?? [],
        confidence: entry.meta?.confidence ?? 1.0,
        metadata: {
          foundry_id: entry.id,
          source: entry.source,
          timestamp: entry.timestamp,
          ...entry.meta,
        },
      }));
      await this._fetch("engrams/bulk", {
        method: "POST",
        body: JSON.stringify({ engrams }),
      });
    }
  }

  /** Retrieve a single engram by ID. Returns undefined on 404. */
  async get(id: string): Promise<MemoryEntry | undefined> {
    try {
      const res = await this._fetch(`engrams/${encodeURIComponent(id)}`, {
        params: { vault: this.vault },
      });
      const engram = (await res.json()) as MuninnEngram;
      return this._toEntry(engram);
    } catch (err) {
      if ((err as Error).message?.includes("404")) return undefined;
      console.warn(`[muninn] get(${id}) failed:`, (err as Error).message);
      return undefined;
    }
  }

  /** Soft-delete an engram (archived, restorable for 7 days). */
  async delete(id: string): Promise<boolean> {
    try {
      await this._fetch(`engrams/${encodeURIComponent(id)}`, {
        method: "DELETE",
        params: { vault: this.vault },
      });
      return true;
    } catch (err) {
      console.warn(`[muninn] delete(${id}) failed:`, (err as Error).message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Activation (cognitive recall)
  // ---------------------------------------------------------------------------

  /**
   * Search via MuninnDB's 6-phase cognitive pipeline.
   * Returns MemoryEntry[] for MemoryBackend compatibility.
   */
  async search(query: string, limit?: number): Promise<MemoryEntry[]> {
    const results = await this._activate(query, limit);
    return results.map((r) => this._activationToEntry(r));
  }

  /**
   * Search with scores preserved — RichMemoryBackend.
   * MemoryToolAdapter prefers this over search() when available.
   */
  async searchMemories(
    query: string,
    opts?: { limit?: number },
  ): Promise<Array<{ content: string; score?: number; metadata?: any }>> {
    const results = await this._activate(query, opts?.limit);
    return results.map((r) => ({
      content: r.content,
      score: r.score,
      metadata: {
        concept: r.concept,
        why: r.why,
        hop_path: r.hop_path,
      },
    }));
  }

  /** List recent engrams. */
  async recent(limit: number = 20, kind?: string): Promise<MemoryEntry[]> {
    try {
      const params: Record<string, string> = {
        vault: this.vault,
        limit: String(limit),
      };
      if (kind) params.tags = kind;

      const res = await this._fetch("engrams", { params });
      const data = (await res.json()) as MuninnEngram[];
      const engrams = Array.isArray(data) ? data : [];
      return engrams.map((e) => this._toEntry(e));
    } catch (err) {
      console.warn("[muninn] recent() failed:", (err as Error).message);
      return [];
    }
  }

  /** Get all entries (alias for recent with high limit). */
  async all(kind?: string): Promise<MemoryEntry[]> {
    return this.recent(1000, kind);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async _activate(
    query: string,
    limit?: number,
  ): Promise<MuninnActivationResult[]> {
    try {
      const res = await this._fetch("activate", {
        method: "POST",
        body: JSON.stringify({
          vault: this.vault,
          context: [query],
          max_results: limit ?? 20,
        }),
      });
      const data = (await res.json()) as MuninnActivationResult[];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.warn("[muninn] activate failed:", (err as Error).message);
      return [];
    }
  }

  private _toEntry(engram: MuninnEngram): MemoryEntry {
    return {
      id: engram.id,
      kind: engram.concept ?? "memory",
      content: engram.content,
      timestamp: engram.created_at
        ? new Date(engram.created_at).getTime()
        : Date.now(),
      meta: {
        strength: engram.strength,
        decay_rate: engram.decay_rate,
        confidence: engram.confidence,
        associations: engram.associations,
        tags: engram.tags,
        ...engram.metadata,
      },
    };
  }

  private _activationToEntry(result: MuninnActivationResult): MemoryEntry {
    return {
      id: result.id ?? `activation-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: result.concept ?? "memory",
      content: result.content,
      timestamp: Date.now(),
      meta: {
        score: result.score,
        why: result.why,
        hop_path: result.hop_path,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Foundry adapter interface — ContextSource
  // ---------------------------------------------------------------------------

  /**
   * Create a ContextSource that loads recent engrams from a vault.
   * Drop this into a ContextLayer to inject MuninnDB memories as context.
   */
  asSource(id: string, kind?: string, limit: number = 20): ContextSource {
    const muninn = this;

    return {
      id,
      async load(): Promise<string> {
        try {
          const entries = await muninn.recent(limit, kind);
          if (entries.length === 0) return "";

          const lines = entries.map((e) => {
            const confidence = e.meta?.confidence != null
              ? ` (conf: ${Number(e.meta.confidence).toFixed(2)})`
              : "";
            return `- [${e.kind}] ${e.content}${confidence}`;
          });

          return `## MuninnDB Memories\n${lines.join("\n")}`;
        } catch (err) {
          console.warn(`[MuninnDB] source load failed for "${id}":`, (err as Error).message);
          return "";
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Foundry adapter interface — HydrationAdapter
  // ---------------------------------------------------------------------------

  /**
   * Create a HydrationAdapter for ref-based hydration.
   *
   * Ref locators can be:
   * - An engram ULID → fetches the engram directly
   * - A query prefixed with "?" → activates and returns top result
   */
  asAdapter(system: string = "muninn"): HydrationAdapter {
    const muninn = this;
    return {
      system,
      async hydrate(ref: ContextRef): Promise<string> {
        try {
          if (ref.locator.startsWith("?")) {
            const query = ref.locator.slice(1);
            const results = await muninn.search(query, 1);
            return results[0]?.content ?? "";
          }

          const entry = await muninn.get(ref.locator);
          return entry?.content ?? "";
        } catch (err) {
          console.warn(`[MuninnDB] hydrate failed for "${ref.locator}":`, (err as Error).message);
          return "";
        }
      },

      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        return Promise.all(refs.map((ref) => this.hydrate(ref)));
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Foundry adapter interface — signal writer
  // ---------------------------------------------------------------------------

  /**
   * Create a signal handler that stores signals as MuninnDB engrams.
   *
   * Wire into SignalBus to auto-persist corrections, conventions, ADRs, etc.
   * MuninnDB will automatically decay unused signals and strengthen relevant ones.
   */
  signalWriter(opts?: {
    /** Signal kinds to persist. Default: all. */
    kinds?: string[];
  }) {
    const muninn = this;
    const allowedKinds = opts?.kinds ? new Set(opts.kinds) : null;

    return async (signal: Signal): Promise<void> => {
      if (allowedKinds && !allowedKinds.has(signal.kind)) return;

      try {
        const content =
          typeof signal.content === "string"
            ? signal.content
            : JSON.stringify(signal.content);

        await muninn.write({
          id: signal.id,
          kind: signal.kind,
          content: `[${signal.kind}] ${content}`,
          timestamp: signal.timestamp,
          source: signal.source,
          meta: {
            confidence: signal.confidence,
            refs: signal.refs,
          },
        });
      } catch (err) {
        console.warn(`[MuninnDB] signal write failed for "${signal.kind}":`, (err as Error).message);
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MuninnConfig {
  /** REST API base URL. Default: http://localhost:8475 */
  baseUrl?: string;
  /** Vault for scoping memories (per-project, per-user). Default: "default" */
  vault?: string;
  /** Bearer token for authentication. Optional for local deployments. */
  token?: string;
  /** Request timeout in ms. Default: 15000 */
  timeout?: number;
}

/** Raw engram as returned by MuninnDB's REST API. */
export interface MuninnEngram {
  id: string;
  concept?: string;
  content: string;
  tags?: string[];
  confidence?: number;
  strength?: number;
  decay_rate?: number;
  associations?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

/** Result from the /activate cognitive pipeline. */
export interface MuninnActivationResult {
  id?: string;
  score: number;
  concept?: string;
  content: string;
  why?: Record<string, unknown>;
  hop_path?: string;
}
