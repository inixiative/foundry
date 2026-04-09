import type { ContextSource } from "./context-layer";

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

/**
 * A ContextSource backed by refs + adapters.
 * Drop this into a ContextLayer as a source — it hydrates on warm().
 */
export class RefSource implements ContextSource {
  readonly id: string;
  private _refs: ContextRef[];
  private _registry: HydrationRegistry;

  constructor(id: string, refs: ContextRef[], registry: HydrationRegistry) {
    this.id = id;
    this._refs = refs;
    this._registry = registry;
  }

  async load(): Promise<string> {
    return this._registry.hydrateAll(this._refs);
  }

  get refs(): ReadonlyArray<ContextRef> {
    return this._refs;
  }

  addRef(ref: ContextRef): void {
    this._refs.push(ref);
  }

  removeRef(locator: string): boolean {
    const idx = this._refs.findIndex((r) => r.locator === locator);
    if (idx === -1) return false;
    this._refs.splice(idx, 1);
    return true;
  }
}

/**
 * Registry of hydration adapters.
 *
 * You register one adapter per system. When refs come in,
 * the registry routes each ref to the right adapter and hydrates.
 * Refs from different systems in the same batch are hydrated
 * in parallel (one batch per system).
 */
export class HydrationRegistry {
  private _adapters: Map<string, HydrationAdapter> = new Map();

  register(adapter: HydrationAdapter): void {
    this._adapters.set(adapter.system, adapter);
  }

  unregister(system: string): boolean {
    return this._adapters.delete(system);
  }

  getAdapter(system: string): HydrationAdapter | undefined {
    return this._adapters.get(system);
  }

  /** Hydrate a single ref. */
  async hydrate(ref: ContextRef): Promise<string> {
    const adapter = this._adapters.get(ref.system);
    if (!adapter) {
      throw new Error(`No hydration adapter registered for system: ${ref.system}`);
    }
    return adapter.hydrate(ref);
  }

  /**
   * Hydrate multiple refs, grouped by system for batch efficiency.
   * Returns concatenated content in ref order.
   */
  async hydrateAll(refs: ContextRef[]): Promise<string> {
    if (refs.length === 0) return "";

    // Group by system
    const bySystem = new Map<string, { idx: number; ref: ContextRef }[]>();
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!bySystem.has(ref.system)) bySystem.set(ref.system, []);
      bySystem.get(ref.system)!.push({ idx: i, ref });
    }

    // Hydrate each system's batch in parallel
    const results: string[] = new Array(refs.length);

    await Promise.all(
      [...bySystem.entries()].map(async ([system, entries]) => {
        const adapter = this._adapters.get(system);
        if (!adapter) {
          throw new Error(`No hydration adapter registered for system: ${system}`);
        }

        if (adapter.hydrateBatch && entries.length > 1) {
          const batchResults = await adapter.hydrateBatch(
            entries.map((e) => e.ref)
          );
          for (let i = 0; i < entries.length; i++) {
            results[entries[i].idx] = batchResults[i];
          }
        } else {
          await Promise.all(
            entries.map(async (entry) => {
              results[entry.idx] = await adapter.hydrate(entry.ref);
            })
          );
        }
      })
    );

    return results.join("\n\n");
  }
}
