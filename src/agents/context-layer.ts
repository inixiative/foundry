/**
 * A source that can provide content to a layer.
 * Intentionally minimal — could be docs, memory, corpus, API, whatever.
 */
export interface ContextSource {
  readonly id: string;
  load(): Promise<string>;
}

export interface ContextLayerConfig {
  readonly id: string;
  sources?: ContextSource[];
  staleness?: number;
  trust?: number;
  maxTokens?: number;
  /** Instruction explaining how this layer's content should be used. */
  prompt?: string;
}

export type LayerState = "cold" | "warming" | "warm" | "stale" | "compressing";

export function computeHash(content: string): string {
  return Bun.hash(content).toString(16).slice(0, 16);
}

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
  private _prompt: string | undefined;
  private _warmingPromise: Promise<void> | null = null;

  private _listeners: Array<(state: LayerState, layer: ContextLayer) => void> =
    [];

  constructor(config: ContextLayerConfig) {
    this.id = config.id;
    this._sources = config.sources ?? [];
    this._staleness = config.staleness;
    this._trust = config.trust ?? 0;
    this._maxTokens = config.maxTokens;
    this._prompt = config.prompt;
  }

  // -- Accessors --

  get content(): string {
    return this._content;
  }

  /** Returns current state. Call checkStaleness() explicitly to trigger stale transitions. */
  get state(): LayerState {
    return this._state;
  }

  /** Check if this layer has become stale. Triggers state transition if so. */
  checkStaleness(): LayerState {
    if (
      this._state === "warm" &&
      this._staleness !== undefined &&
      this._lastWarmed !== null &&
      Date.now() - this._lastWarmed > this._staleness
    ) {
      this._setState("stale");
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
    return this._state === "warm";
  }

  get isStale(): boolean {
    this.checkStaleness();
    return this._state === "stale";
  }

  // -- Lifecycle --

  /** Load content from all sources. Re-entrant safe — concurrent calls coalesce. */
  async warm(): Promise<void> {
    if (this._warmingPromise) return this._warmingPromise;

    this._warmingPromise = this._doWarm();
    try {
      await this._warmingPromise;
    } finally {
      this._warmingPromise = null;
    }
  }

  private async _doWarm(): Promise<void> {
    const previousState = this._state;
    this._setState("warming");

    try {
      const parts: string[] = [];
      for (const source of this._sources) {
        parts.push(await source.load());
      }

      this._content = parts.join("\n\n");
      this._hash = computeHash(this._content);
      this._lastWarmed = Date.now();
      this._setState("warm");
    } catch (err) {
      // Revert to previous state so the layer isn't stuck in "warming"
      this._setState(previousState === "warming" ? "cold" : previousState);
      throw err;
    }
  }

  set(content: string): void {
    this._content = content;
    this._hash = computeHash(content);
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

  get prompt(): string | undefined {
    return this._prompt;
  }

  set prompt(value: string | undefined) {
    this._prompt = value;
  }

  // -- Internal --

  private _setState(state: LayerState): void {
    if (this._state === state) return;
    this._state = state;
    // Snapshot listeners to avoid mutation during iteration
    const snapshot = [...this._listeners];
    for (const listener of snapshot) {
      listener(state, this);
    }
  }
}
