import type { ContextSource } from "../agents/context-layer";
import type { HydrationAdapter, ContextRef } from "../agents/hydrator";
import type { Signal } from "../agents/signal";

/**
 * Supermemory adapter — hosted memory + RAG engine.
 *
 * Connects Foundry's context layer system to supermemory.ai for:
 * - Persistent memory across conversations (auto-extracted facts)
 * - User profiles (static + dynamic context)
 * - Hybrid search (memories + document chunks)
 * - Multi-modal document storage (text, PDF, images, code)
 *
 * Zero SDK — uses fetch directly against the REST API.
 * Requires a SUPERMEMORY_API_KEY.
 *
 * @see https://docs.supermemory.ai
 */
export class SupermemoryAdapter {
  private _apiKey: string;
  private _baseUrl: string;
  private _timeout: number;

  /** Default container tag for scoping memories. */
  readonly containerTag: string;

  constructor(opts: SupermemoryConfig) {
    this._apiKey = opts.apiKey;
    this._baseUrl = (opts.baseUrl ?? "https://api.supermemory.ai").replace(/\/$/, "");
    this._timeout = opts.timeout ?? 15_000;
    this.containerTag = opts.containerTag ?? "default";
  }

  // ---------------------------------------------------------------------------
  // Low-level API
  // ---------------------------------------------------------------------------

  private async _fetch(
    path: string,
    init?: RequestInit & { params?: Record<string, string> }
  ): Promise<Response> {
    const url = new URL(path, this._baseUrl);
    if (init?.params) {
      for (const [k, v] of Object.entries(init.params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      ...init,
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: AbortSignal.timeout(this._timeout),
    });

    if (!res.ok) {
      // Read body for status context but sanitize — never leak auth headers or tokens
      const body = await res.text().catch(() => "");
      const safeBody = body.length > 200 ? body.slice(0, 200) + "…" : body;
      // Strip anything that looks like a Bearer token or API key from error output
      const sanitized = safeBody.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/[a-zA-Z0-9_-]{32,}/g, "[REDACTED]");
      throw new Error(`supermemory ${res.status}: ${res.statusText} ${sanitized}`);
    }

    return res;
  }

  // ---------------------------------------------------------------------------
  // Documents (store)
  // ---------------------------------------------------------------------------

  /** Add content to supermemory. Returns the document ID. */
  async add(opts: {
    content: string;
    containerTag?: string;
    customId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const res = await this._fetch("/v3/documents", {
      method: "POST",
      body: JSON.stringify({
        content: opts.content,
        containerTag: opts.containerTag ?? this.containerTag,
        customId: opts.customId,
        metadata: opts.metadata,
      }),
    });
    const data = await res.json() as { id: string };
    return data.id;
  }

  /** Get a document by ID. Returns null on 404 or network error. */
  async getDocument(id: string): Promise<SupermemoryDocument | null> {
    try {
      const res = await this._fetch(`/v3/documents/${encodeURIComponent(id)}`);
      return await res.json() as SupermemoryDocument;
    } catch (err) {
      import("../logger").then(({ log }) => log.warn(`[supermemory] getDocument(${id}) failed:`, (err as Error).message));
      return null;
    }
  }

  /** Delete a document by ID. Returns false on error. */
  async deleteDocument(id: string): Promise<boolean> {
    try {
      await this._fetch(`/v3/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return true;
    } catch (err) {
      import("../logger").then(({ log }) => log.warn(`[supermemory] deleteDocument(${id}) failed:`, (err as Error).message));
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------------

  /** Search memories (extracted facts). */
  async searchMemories(
    query: string,
    opts?: {
      containerTag?: string;
      limit?: number;
      threshold?: number;
      searchMode?: "memories" | "hybrid" | "documents";
    }
  ): Promise<SupermemorySearchResult[]> {
    const res = await this._fetch("/v4/search", {
      method: "POST",
      body: JSON.stringify({
        q: query,
        containerTag: opts?.containerTag ?? this.containerTag,
        limit: opts?.limit ?? 10,
        threshold: opts?.threshold ?? 0.5,
        searchMode: opts?.searchMode ?? "memories",
      }),
    });
    const data = await res.json() as { results: SupermemorySearchResult[] };
    return data.results ?? [];
  }

  /** Search document chunks (RAG). */
  async searchDocuments(
    query: string,
    opts?: {
      containerTag?: string;
      limit?: number;
    }
  ): Promise<SupermemorySearchResult[]> {
    return this.searchMemories(query, { ...opts, searchMode: "documents" });
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  /** Get the auto-maintained user profile for a container. */
  async profile(
    containerTag?: string,
    query?: string
  ): Promise<SupermemoryProfile> {
    const body: Record<string, unknown> = {
      containerTag: containerTag ?? this.containerTag,
    };
    if (query) body.q = query;

    const res = await this._fetch("/v4/profile", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return await res.json() as SupermemoryProfile;
  }

  // ---------------------------------------------------------------------------
  // Foundry adapter interface — ContextSource
  // ---------------------------------------------------------------------------

  /**
   * Create a ContextSource that loads the user profile + recent memories.
   *
   * This is the primary integration point — drop this into a ContextLayer
   * and it will inject supermemory's extracted facts as context.
   */
  asSource(
    id: string,
    opts?: {
      containerTag?: string;
      /** Optional search query to scope the context. */
      query?: string;
      /** Max memories to include. Default 20. */
      limit?: number;
      /** Include profile? Default true. */
      includeProfile?: boolean;
    }
  ): ContextSource {
    const sm = this;
    const tag = opts?.containerTag ?? this.containerTag;
    const limit = opts?.limit ?? 20;
    const includeProfile = opts?.includeProfile !== false;

    return {
      id,
      async load(): Promise<string> {
        const parts: string[] = [];

        try {
          // Fetch profile and memories in parallel
          const [profileData, memories] = await Promise.all([
            includeProfile ? sm.profile(tag, opts?.query) : null,
            sm.searchMemories(opts?.query ?? "", { containerTag: tag, limit }),
          ]);

          // Profile section
          if (profileData?.profile) {
            const p = profileData.profile;
            if (p.static?.length) {
              parts.push("## User Context\n" + p.static.join("\n"));
            }
            if (p.dynamic?.length) {
              parts.push("## Recent Activity\n" + p.dynamic.join("\n"));
            }
          }

          // Memories section
          if (memories.length > 0) {
            const memLines = memories.map((m) => {
              const text = m.memory ?? m.content ?? "";
              return `- ${text}`;
            });
            parts.push("## Memories\n" + memLines.join("\n"));
          }
        } catch (err) {
          import("../logger").then(({ log }) => log.warn(`[Supermemory] source load failed for "${id}":`, (err as Error).message));
          return "";
        }

        return parts.join("\n\n");
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
   * - A document ID → fetches the document
   * - A search query prefixed with "?" → searches and returns top result
   */
  asAdapter(system: string = "supermemory"): HydrationAdapter {
    const sm = this;
    return {
      system,
      async hydrate(ref: ContextRef): Promise<string> {
        try {
          const tag = (ref.meta?.containerTag as string) ?? sm.containerTag;

          if (ref.locator.startsWith("?")) {
            // Search mode — locator is a query
            const query = ref.locator.slice(1);
            const results = await sm.searchMemories(query, {
              containerTag: tag,
              limit: 1,
            });
            return results[0]?.memory ?? results[0]?.content ?? "";
          }

          // Direct document fetch
          const doc = await sm.getDocument(ref.locator);
          return doc?.content ?? doc?.summary ?? "";
        } catch (err) {
          import("../logger").then(({ log }) => log.warn(`[Supermemory] hydrate failed for "${ref.locator}":`, (err as Error).message));
          return "";
        }
      },

      async hydrateBatch(refs: ContextRef[]): Promise<string[]> {
        // Parallel hydration
        return Promise.all(refs.map((ref) => this.hydrate(ref)));
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Foundry adapter interface — signal writer
  // ---------------------------------------------------------------------------

  /**
   * Create a signal handler that stores signals as supermemory documents.
   *
   * Wire into SignalBus to auto-persist corrections, conventions, ADRs, etc.
   * Supermemory will automatically extract facts and build the memory graph.
   */
  signalWriter(opts?: {
    containerTag?: string;
    /** Signal kinds to persist. Default: all. */
    kinds?: string[];
  }) {
    const sm = this;
    const tag = opts?.containerTag ?? this.containerTag;
    const allowedKinds = opts?.kinds ? new Set(opts.kinds) : null;

    return async (signal: Signal): Promise<void> => {
      if (allowedKinds && !allowedKinds.has(signal.kind)) return;

      try {
        const content = typeof signal.content === "string"
          ? signal.content
          : JSON.stringify(signal.content);

        await sm.add({
          content: `[${signal.kind}] ${content}`,
          containerTag: tag,
          customId: signal.id,
          metadata: {
            kind: signal.kind,
            source: signal.source,
            confidence: signal.confidence,
            timestamp: signal.timestamp,
          },
        });
      } catch (err) {
        import("../logger").then(({ log }) => log.warn(`[Supermemory] signal write failed for "${signal.kind}":`, (err as Error).message));
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupermemoryConfig {
  apiKey: string;
  /** API base URL. Default: https://api.supermemory.ai */
  baseUrl?: string;
  /** Container tag for scoping memories (per-user, per-project). Default: "default" */
  containerTag?: string;
  /** Request timeout in ms. Default: 15000 */
  timeout?: number;
}

export interface SupermemoryDocument {
  id: string;
  customId?: string;
  containerTag?: string;
  content?: string;
  title?: string;
  summary?: string;
  type?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface SupermemorySearchResult {
  id?: string;
  memory?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface SupermemoryProfile {
  profile?: {
    static?: string[];
    dynamic?: string[];
  };
  searchResults?: SupermemorySearchResult[];
}
