import { ContextLayer, computeHash } from "./context-layer";

export interface Compressor {
  compress(content: string, targetRatio: number): Promise<string>;
}

export type LayerFilter = (layer: ContextLayer) => boolean;

export interface ContextSnapshot {
  readonly hash: string;
  readonly content: string;
  readonly layerHashes: Record<string, string>;
  readonly timestamp: number;
}

export type LayerAddedCallback = (layer: ContextLayer) => void;

export class ContextStack {
  private _layers: ContextLayer[] = [];
  private _compressor: Compressor | null = null;
  private _onLayerAdded: LayerAddedCallback[] = [];

  constructor(layers?: ContextLayer[], compressor?: Compressor) {
    if (layers) this._layers = [...layers];
    if (compressor) this._compressor = compressor;
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

  // -- Compression --

  setCompressor(compressor: Compressor): void {
    this._compressor = compressor;
  }

  async compress(targetTokens: number, ratio: number = 0.5): Promise<void> {
    if (!this._compressor) {
      throw new Error("No compressor set on this stack");
    }

    const byTrust = [...this._layers]
      .filter((l) => l.isWarm)
      .sort((a, b) => a.trust - b.trust);

    // Track running total instead of re-merging every iteration
    let totalTokens = this.estimateTokens();

    for (const layer of byTrust) {
      if (totalTokens <= targetTokens) break;

      const oldLen = layer.content.length;
      const compressed = await this._compressor.compress(layer.content, ratio);
      layer.set(compressed);
      // Adjust running total by the delta
      totalTokens -= Math.ceil((oldLen - compressed.length) / 4);
    }
  }

  async compressLayer(id: string, ratio: number = 0.5): Promise<void> {
    if (!this._compressor) {
      throw new Error("No compressor set on this stack");
    }

    const layer = this.getLayer(id);
    if (!layer) throw new Error(`Layer not found: ${id}`);
    if (!layer.isWarm) throw new Error(`Layer not warm: ${id}`);

    const compressed = await this._compressor.compress(layer.content, ratio);
    layer.set(compressed);
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
