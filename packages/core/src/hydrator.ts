/**
 * @atlas
 * @kind type
 * @partOf primitive:contextLayers
 */
/**
 * A ref is a pointer into a knowledge system.
 * It carries just enough to locate the content — not the content itself.
 * Agents pass refs around, and adapters hydrate them on demand.
 */
export interface ContextRef {
  /** Which system this ref points into (e.g. "docs", "memory", "corpus", "api") */
  readonly system: string;

  /** Location within that system (path, key, query, URI — system-specific) */
  readonly locator: string;

  /** Optional version/revision for pinning */
  readonly version?: string;

  /** Arbitrary system-specific metadata */
  readonly meta?: Record<string, unknown>;
}

/**
 * An adapter knows how to hydrate refs from a specific system.
 * Each knowledge system (docs, memory, MuninnDB, etc.) implements one.
 */
export interface HydrationAdapter {
  /** Which system this adapter handles — must match ContextRef.system */
  readonly system: string;

  /** Hydrate a single ref into content. */
  hydrate(ref: ContextRef): Promise<string>;

  /** Hydrate multiple refs (batch optimization). Default: serial hydrate. */
  hydrateBatch?(refs: ContextRef[]): Promise<string[]>;
}
