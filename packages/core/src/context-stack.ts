import { ContextLayer, computeHash, type LayerState } from "./context-layer";

export type LayerFilter = (layer: ContextLayer) => boolean;

/**
 * Read-only view of a ContextStack for middleware introspection.
 *
 * Middleware needs to know what a thread already knows — which layers
 * are present, what they contain, and whether they're warm — without
 * being able to mutate the stack. This interface provides exactly that.
 */
export interface ContextStackView {
  /** Check if a specific layer exists and is warm. */
  hasLayer(id: string): boolean;
  /** Get a layer's current content (returns empty string if not warm). */
  getContent(id: string): string;
  /** Get a layer's current state. */
  getState(id: string): LayerState | undefined;
  /** List all layer IDs. */
  readonly layerIds: readonly string[];
  /** Estimated total tokens across all warm layers. */
  readonly estimatedTokens: number;
}

/** A single block in the assembled prompt output. */
export interface PromptBlock {
  readonly role: "system" | "layer" | "content";
  readonly id?: string;
  readonly text: string;
}

/** Structured prompt assembled from agent prompt + layer prompts + layer content. */
export interface AssembledContext {
  readonly blocks: PromptBlock[];
  /** Convenience: all blocks joined into a single string. */
  readonly text: string;
}

export interface ContextSnapshot {
  readonly hash: string;
  readonly content: string;
  readonly layerHashes: Record<string, string>;
  readonly timestamp: number;
}

export type LayerAddedCallback = (layer: ContextLayer) => void;

export class ContextStack {
  private _layers: ContextLayer[] = [];
  private _onLayerAdded: LayerAddedCallback[] = [];

  constructor(layers?: ContextLayer[]) {
    if (layers) this._layers = [...layers];
  }

  // -- Layer management --

  get layers(): ReadonlyArray<ContextLayer> {
    return this._layers;
  }

  /** Register a callback for when layers are added (used by CacheLifecycle). */
  onLayerAdded(cb: LayerAddedCallback): () => void {
    this._onLayerAdded.push(cb);
    return () => {
      const idx = this._onLayerAdded.indexOf(cb);
      if (idx !== -1) this._onLayerAdded.splice(idx, 1);
    };
  }

  addLayer(layer: ContextLayer, position?: number): void {
    if (position !== undefined) {
      this._layers.splice(position, 0, layer);
    } else {
      this._layers.push(layer);
    }
    for (const cb of this._onLayerAdded) cb(layer);
  }

  removeLayer(id: string): boolean {
    const idx = this._layers.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    this._layers.splice(idx, 1);
    return true;
  }

  getLayer(id: string): ContextLayer | undefined {
    return this._layers.find((l) => l.id === id);
  }

  reorder(ids: string[]): void {
    const layerMap = new Map(this._layers.map((l) => [l.id, l]));
    const ordered: ContextLayer[] = [];
    const seen = new Set<string>();

    for (const id of ids) {
      const layer = layerMap.get(id);
      if (layer) {
        ordered.push(layer);
        seen.add(id);
      }
    }
    for (const layer of this._layers) {
      if (!seen.has(layer.id)) ordered.push(layer);
    }
    this._layers = ordered;
  }

  // -- Warming --

  async warmAll(): Promise<void> {
    // Check staleness before deciding what to warm
    for (const l of this._layers) l.checkStaleness();
    await Promise.all(
      this._layers.filter((l) => !l.isWarm).map((l) => l.warm())
    );
  }

  async refresh(): Promise<void> {
    for (const l of this._layers) l.checkStaleness();
    await Promise.all(
      this._layers.filter((l) => l.isStale).map((l) => l.warm())
    );
  }

  // -- Merging --

  merge(filter?: LayerFilter): string {
    const layers = filter ? this._layers.filter(filter) : this._layers;
    return layers
      .filter((l) => l.isWarm && l.content.length > 0)
      .map((l) => l.content)
      .join("\n\n");
  }

  slice(filter: LayerFilter): string {
    return this.merge(filter);
  }

  sliceByIds(...ids: string[]): string {
    const idSet = new Set(ids);
    return this.merge((l) => idSet.has(l.id));
  }

  /**
   * Assemble structured prompt blocks from an optional agent system prompt,
   * layer prompts, and layer content. Each layer with a prompt gets a
   * prompt block followed by its content block. Layers without prompts
   * get just a content block.
   */
  assemble(agentPrompt?: string, filter?: LayerFilter): AssembledContext {
    const blocks: PromptBlock[] = [];

    if (agentPrompt) {
      blocks.push({ role: "system", text: agentPrompt });
    }

    const layers = filter ? this._layers.filter(filter) : this._layers;

    for (const layer of layers) {
      if (!layer.isWarm || layer.content.length === 0) continue;

      if (layer.prompt) {
        blocks.push({ role: "layer", id: layer.id, text: layer.prompt });
      }
      blocks.push({ role: "content", id: layer.id, text: layer.content });
    }

    const text = blocks.map((b) => b.text).join("\n\n");
    return { blocks, text };
  }

  // -- Snapshots --

  snapshot(): ContextSnapshot {
    const content = this.merge();
    const layerHashes: Record<string, string> = {};
    for (const layer of this._layers) {
      if (layer.isWarm) {
        layerHashes[layer.id] = layer.hash;
      }
    }

    return {
      hash: computeHash(content),
      content,
      layerHashes,
      timestamp: Date.now(),
    };
  }

  // -- Utilities --

  estimateTokens(): number {
    return Math.ceil(this.merge().length / 4);
  }

  invalidateAll(): void {
    for (const layer of this._layers) {
      layer.invalidate();
    }
  }
}
