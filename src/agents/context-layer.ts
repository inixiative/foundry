/**
 * A source that can provide content to a layer.
 * Intentionally minimal — could be docs, memory, corpus, API, whatever.
 */
export interface ContextSource {
  readonly id: string;
  load(): Promise<string>;
}

export interface ContextLayerConfig {
  /** Unique identifier for this layer */
  readonly id: string;

  /** Ordered sources this layer loads from */
  sources?: ContextSource[];

  /** How long (ms) before this layer is considered stale. undefined = never stale. */
  staleness?: number;

  /**
   * Trust level — higher means content is less likely to be compressed or evicted.
   * The stack uses this to decide compression order. No fixed scale — relative ordering.
   */
  trust?: number;

  /** Maximum token budget for this layer. undefined = unbounded. */
  maxTokens?: number;
}

export type LayerState = "cold" | "warming" | "warm" | "stale" | "compressing";

export class ContextLayer {
  readonly id: string;

  private _content: string = "";
  private _state: LayerState = "cold";
  private _hash: string = "";
  private _lastWarmed: number | null = null;
  private _sources: ContextSource[];
  private _staleness: number | undefined;
  private _trust: number;
  private _maxTokens: number | undefined;

  private _listeners: Array<(state: LayerState, layer: ContextLayer) => void> =
    [];

  constructor(config: ContextLayerConfig) {
    this.id = config.id;
    this._sources = config.sources ?? [];
    this._staleness = config.staleness;
    this._trust = config.trust ?? 0;
    this._maxTokens = config.maxTokens;
  }

  // -- Accessors --

  get content(): string {
    return this._content;
  }

  get state(): LayerState {
    if (
      this._state === "warm" &&
      this._staleness !== undefined &&
      this._lastWarmed !== null
    ) {
      if (Date.now() - this._lastWarmed > this._staleness) {
        this._setState("stale");
      }
    }
    return this._state;
  }

  get hash(): string {
    return this._hash;
  }

  get trust(): number {
    return this._trust;
  }

  get lastWarmed(): number | null {
    return this._lastWarmed;
  }

  get isWarm(): boolean {
    return this.state === "warm";
  }

  get isStale(): boolean {
    return this.state === "stale";
  }

  // -- Lifecycle --

  async warm(): Promise<void> {
    this._setState("warming");

    const parts: string[] = [];
    for (const source of this._sources) {
      parts.push(await source.load());
    }

    this._content = parts.join("\n\n");
    this._hash = ContextLayer.computeHash(this._content);
    this._lastWarmed = Date.now();
    this._setState("warm");
  }

  set(content: string): void {
    this._content = content;
    this._hash = ContextLayer.computeHash(content);
    this._lastWarmed = Date.now();
    this._setState("warm");
  }

  invalidate(): void {
    if (this._state !== "cold") {
      this._setState("stale");
    }
  }

  clear(): void {
    this._content = "";
    this._hash = "";
    this._lastWarmed = null;
    this._setState("cold");
  }

  addSource(source: ContextSource): void {
    this._sources.push(source);
  }

  removeSource(id: string): boolean {
    const idx = this._sources.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this._sources.splice(idx, 1);
    return true;
  }

  // -- Observation --

  onStateChange(
    listener: (state: LayerState, layer: ContextLayer) => void
  ): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  // -- Configuration --

  get staleness(): number | undefined {
    return this._staleness;
  }

  set staleness(value: number | undefined) {
    this._staleness = value;
  }

  get maxTokens(): number | undefined {
    return this._maxTokens;
  }

  set maxTokens(value: number | undefined) {
    this._maxTokens = value;
  }

  set trust(value: number) {
    this._trust = value;
  }

  // -- Internal --

  private _setState(state: LayerState): void {
    if (this._state === state) return;
    this._state = state;
    for (const listener of this._listeners) {
      listener(state, this);
    }
  }

  static computeHash(content: string): string {
    const hash = Bun.hash(content);
    return hash.toString(16).slice(0, 16);
  }
}
