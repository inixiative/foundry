/**
 * A source that can provide content to a layer.
 * Intentionally minimal — could be docs, memory, corpus, API, whatever.
 */
export interface ContextSource {
  readonly id: string;
  load(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Layer Definition — the blueprint (shared across threads, lives in config)
// ---------------------------------------------------------------------------

/**
 * A layer definition is the blueprint for a domain's context layer.
 * It describes the POLICY — what sources feed it, how it ages, its default
 * trust, its token budget. Definitions live in settings.json and are shared.
 *
 * Feedback that changes a definition affects all future instances:
 * "conventions should default to trust 0.9" → definition change.
 */
export interface LayerDefinition {
  /** Unique identifier (e.g., "conventions", "security", "thread-state"). */
  readonly id: string;
  /** Which domain this layer belongs to. Agents reference this to find their layers. */
  domain?: string;
  /** Source IDs that feed this layer (resolved at instantiation). */
  sourceIds?: string[];
  /** Default trust score for new instances (0-100). */
  defaultTrust?: number;
  /** Staleness threshold in ms. After this, the instance is considered stale. */
  staleness?: number;
  /** Token budget ceiling. */
  maxTokens?: number;
  /** Instruction explaining how this layer's content should be used. */
  prompt?: string;
  /** When this layer is activated: always, on-demand, or conditionally. */
  activation?: "always" | "on-demand" | "conditional";
  /** Who can write to instances of this layer. Undefined = anyone. */
  writers?: string[];
}

// ---------------------------------------------------------------------------
// Layer Instance State — runtime snapshot (per-thread, mutable)
// ---------------------------------------------------------------------------

/**
 * Serializable snapshot of a layer instance's runtime state.
 * Used for persistence, crash recovery, and thread restart from Session Store.
 *
 * Feedback that changes an instance affects only this thread:
 * "this convention cache is stale" → instance change.
 */
export interface LayerInstanceState {
  definitionId: string;
  threadId?: string;
  content: string;
  hash: string;
  state: LayerState;
  trust: number;
  lastWarmed: number | null;
  lastAccessed: number | null;
}

// ---------------------------------------------------------------------------
// Version History — tracking changes to definitions and instances
// ---------------------------------------------------------------------------

/**
 * A versioned snapshot of a definition or instance.
 *
 * Two use cases, very different data profiles:
 *
 * DEFINITION VERSIONS (low volume, long-term value):
 *   Agent prompts change, model selections shift, trust defaults get tuned.
 *   "We changed the Convention Librarian's prompt — did violations go down?"
 *   Connects to Oracle eval: config version A scored 0.72, version B scored 0.81.
 *   Keep indefinitely.
 *
 * INSTANCE VERSIONS (high volume, short-term debug value):
 *   Thread-state changes every message. Trust mutates on writeback.
 *   "Why did security guard fire on message 23 but not 22?"
 *   These are events in the Session Store — the store IS the instance history.
 *   Compact or discard after retention window.
 */
export interface VersionEntry<T = unknown> {
  /** Content hash of the versioned payload. */
  hash: string;
  /** ISO timestamp. */
  timestamp: string;
  /** What caused this version: "manual", "writeback", "warm", "feedback", etc. */
  trigger: string;
  /** Who made the change: agent ID, "user", "system". */
  author: string;
  /** Optional human-readable note. */
  note?: string;
  /** The actual snapshot. For definitions: the full definition. For instances: LayerInstanceState. */
  snapshot: T;
}

/**
 * Version log for a single definition or instance.
 * Append-only. Entries are ordered by timestamp.
 */
export interface VersionLog<T = unknown> {
  /** What is being versioned: "layer:conventions", "agent:librarian", etc. */
  subject: string;
  /** "definition" or "instance". */
  scope: "definition" | "instance";
  /** Ordered version entries, newest last. */
  entries: VersionEntry<T>[];
}

// ---------------------------------------------------------------------------
// Backwards-compatible config (still works for direct construction)
// ---------------------------------------------------------------------------

export interface ContextLayerConfig {
  readonly id: string;
  /** Optional definition this instance was created from. */
  definition?: LayerDefinition;
  sources?: ContextSource[];
  staleness?: number;
  trust?: number;
  maxTokens?: number;
  /** Instruction explaining how this layer's content should be used. */
  prompt?: string;
}

export type LayerState = "cold" | "warming" | "warm" | "stale" | "compressing";

/** Emitted on any write to a layer instance. The Session Store captures these. */
export interface LayerMutationEvent {
  layerId: string;
  /** What changed: "content", "trust", "state", "staleness", "prompt". */
  field: string;
  /** Previous value (serializable). */
  previous: unknown;
  /** New value (serializable). */
  current: unknown;
  /** Who caused the mutation: agent ID, "system", "warm", etc. */
  author: string;
  timestamp: number;
}

export function computeHash(content: string): string {
  return Bun.hash(content).toString(16).slice(0, 16);
}

export class ContextLayer {
  readonly id: string;

  /** The definition this instance was created from (if any). */
  readonly definition: LayerDefinition | undefined;

  private _content: string = "";
  private _state: LayerState = "cold";
  private _hash: string = "";
  private _lastWarmed: number | null = null;
  private _lastAccessed: number | null = null;
  private _sources: ContextSource[];
  private _staleness: number | undefined;
  private _trust: number;
  private _maxTokens: number | undefined;
  private _prompt: string | undefined;
  private _warmingPromise: Promise<void> | null = null;

  private _listeners: Array<(state: LayerState, layer: ContextLayer) => void> =
    [];

  /**
   * Mutation listeners — called on any write to this layer (content, trust, state).
   * Used by the Session Store to capture instance history as events.
   * Unlike onStateChange (which only fires on state transitions), this fires
   * on content changes, trust adjustments, and any other mutation.
   */
  private _mutationListeners: Array<
    (event: LayerMutationEvent) => void
  > = [];

  constructor(config: ContextLayerConfig) {
    this.id = config.id;
    this.definition = config.definition;
    this._sources = config.sources ?? [];
    this._staleness = config.staleness ?? config.definition?.staleness;
    this._trust = config.trust ?? config.definition?.defaultTrust ?? 0;
    this._maxTokens = config.maxTokens ?? config.definition?.maxTokens;
    this._prompt = config.prompt ?? config.definition?.prompt;
  }

  // -- Factory --

  /** Create a layer instance from a definition + resolved sources. */
  static fromDefinition(
    definition: LayerDefinition,
    sources: ContextSource[],
    overrides?: Partial<ContextLayerConfig>,
  ): ContextLayer {
    return new ContextLayer({
      id: definition.id,
      definition,
      sources,
      staleness: overrides?.staleness ?? definition.staleness,
      trust: overrides?.trust ?? definition.defaultTrust,
      maxTokens: overrides?.maxTokens ?? definition.maxTokens,
      prompt: overrides?.prompt ?? definition.prompt,
    });
  }

  /** Snapshot the current instance state for persistence/recovery. */
  snapshotInstance(threadId?: string): LayerInstanceState {
    return {
      definitionId: this.definition?.id ?? this.id,
      threadId,
      content: this._content,
      hash: this._hash,
      state: this._state,
      trust: this._trust,
      lastWarmed: this._lastWarmed,
      lastAccessed: this._lastAccessed,
    };
  }

  /** Restore instance state (e.g., from Session Store replay). */
  restoreInstance(snapshot: LayerInstanceState): void {
    this._content = snapshot.content;
    this._hash = snapshot.hash;
    this._trust = snapshot.trust;
    this._lastWarmed = snapshot.lastWarmed;
    this._lastAccessed = snapshot.lastAccessed;
    this._setState(snapshot.state === "warming" ? "warm" : snapshot.state);
  }

  // -- Accessors --

  get content(): string {
    this._lastAccessed = Date.now();
    return this._content;
  }

  get lastAccessed(): number | null {
    return this._lastAccessed;
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

  set(content: string, author: string = "system"): void {
    const previous = this._content;
    this._content = content;
    this._hash = computeHash(content);
    this._lastWarmed = Date.now();
    this._setState("warm");
    if (previous !== content) {
      this._emitMutation("content", previous, content, author);
    }
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
    const previous = this._staleness;
    this._staleness = value;
    if (previous !== value) {
      this._emitMutation("staleness", previous, value, "system");
    }
  }

  get maxTokens(): number | undefined {
    return this._maxTokens;
  }

  set maxTokens(value: number | undefined) {
    this._maxTokens = value;
  }

  /** Set trust with attribution. Use setTrust() for author tracking, or the setter for backwards compat. */
  set trust(value: number) {
    this.setTrust(value, "system");
  }

  /** Set trust with explicit author attribution — for writeback, active memory, etc. */
  setTrust(value: number, author: string): void {
    const previous = this._trust;
    this._trust = value;
    if (previous !== value) {
      this._emitMutation("trust", previous, value, author);
    }
  }

  get prompt(): string | undefined {
    return this._prompt;
  }

  set prompt(value: string | undefined) {
    const previous = this._prompt;
    this._prompt = value;
    if (previous !== value) {
      this._emitMutation("prompt", previous, value, "system");
    }
  }

  /** Read-only view of the sources feeding this layer. */
  get sources(): ReadonlyArray<ContextSource> {
    return this._sources;
  }

  // -- Mutation observation --

  /**
   * Subscribe to all mutations on this layer instance.
   * The Session Store hooks into this to build instance history.
   * Returns an unsubscribe function.
   */
  onMutation(listener: (event: LayerMutationEvent) => void): () => void {
    this._mutationListeners.push(listener);
    return () => {
      const idx = this._mutationListeners.indexOf(listener);
      if (idx !== -1) this._mutationListeners.splice(idx, 1);
    };
  }

  // -- Internal --

  private _emitMutation(
    field: string,
    previous: unknown,
    current: unknown,
    author: string,
  ): void {
    if (this._mutationListeners.length === 0) return;
    const event: LayerMutationEvent = {
      layerId: this.id,
      field,
      previous,
      current,
      author,
      timestamp: Date.now(),
    };
    const snapshot = [...this._mutationListeners];
    for (const listener of snapshot) {
      listener(event);
    }
  }

  private _setState(state: LayerState): void {
    if (this._state === state) return;
    const previous = this._state;
    this._state = state;
    // Snapshot listeners to avoid mutation during iteration
    const snapshot = [...this._listeners];
    for (const listener of snapshot) {
      listener(state, this);
    }
    // Also emit as mutation for instance history
    this._emitMutation("state", previous, state, "system");
  }
}
