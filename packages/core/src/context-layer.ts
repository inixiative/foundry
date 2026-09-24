import type { OwnershipScope } from "./scope";

/**
 * A source that can provide content to a layer.
 * Intentionally minimal — could be docs, memory, corpus, API, whatever.
 */
/** Per-load hint a layer may pass to sources that select content for a message. */
/**
 * Conflict kind a selecting source reports when required context (a pinned
 * record) cannot be carried and no retrieval exists. The executor refuses
 * provider execution while any included layer reports it.
 */
export const REQUIRED_CONTEXT_BLOCKED = "required-context-blocked";

/** Logical request identity, independent of dispatches and native sessions. */
export interface LogicalMessageIdentity extends OwnershipScope {
  readonly messageId: string;
  readonly threadId: string;
}

/** Own only the identity fields; callers cannot change a pending load by reference. */
export function copyMessageIdentity(identity: LogicalMessageIdentity | undefined): LogicalMessageIdentity | undefined {
  return identity?.messageId && identity.threadId ? Object.freeze({
    messageId: identity.messageId, threadId: identity.threadId,
    ...(identity.projectId ? { projectId: identity.projectId } : {}),
  }) : undefined;
}

function sameMessage(a: LogicalMessageIdentity | undefined, b: LogicalMessageIdentity | undefined): boolean {
  return a?.messageId === b?.messageId && a?.threadId === b?.threadId && a?.projectId === b?.projectId;
}

export interface SourceLoadHint {
  /** The current message, so a selecting source can retrieve what is relevant to it. */
  readonly focus?: string;
  /** Exclude only this owned logical message's automatic audit context, when known. */
  readonly currentMessage?: LogicalMessageIdentity;
}

/**
 * What a selecting source chose and left out on its last load. Complete
 * records stay in the source; this is the inspectable account of the
 * automatic selection, never a substitute for the retained log.
 */
export interface SourceSelectionReport {
  readonly selected: Array<{
    readonly id: string;
    readonly reason: string;
    readonly chars: number;
    readonly kind?: string;
    readonly timestamp?: number;
    readonly truncated?: boolean; ranges?: Array<readonly [number, number]>;
    readonly matched?: string[];
  }>;
  readonly omitted: Array<{ readonly id: string; readonly reason: string; readonly chars: number; readonly kind?: string;
    readonly excludedFor?: LogicalMessageIdentity }>;
  /** Records the reader was allowed to see. */
  readonly considered: number;
  /** Everything retained in the source for this reader, injected or not. */
  readonly retained: { readonly count: number; readonly chars: number };
  readonly budget: { readonly chars: number; readonly used: number; readonly exceeded: boolean };
  readonly conflicts: Array<{ readonly kind: string; readonly ids: string[]; readonly detail: string }>;
  readonly focus?: { readonly hash: string; readonly terms: number };
  readonly currentMessage?: LogicalMessageIdentity;
}

export interface ContextSource {
  readonly id: string;
  /** Load content. Sources that select for a message may use the hint; others ignore it. */
  load(hint?: SourceLoadHint): Promise<string>;
  /**
   * Return a copy of this source bound to an ownership scope. Sources whose
   * data is owned per thread or project (memory, signal logs) implement this
   * so a thread's layer only loads what that thread may see. Unbound sources
   * expose only knowledge published to everyone.
   */
  bind?(scope: OwnershipScope): ContextSource;
  /** True when a changed focus should make the owning layer reload this source. */
  readonly focusable?: boolean;
  /** The selection report of the last load, when this source selects rather than dumps. */
  report?(): SourceSelectionReport | undefined;
}

/** Selection provenance carried on a layer instance for inspection. */
export interface LayerSelectionState {
  readonly focusHash?: string;
  readonly currentMessage?: LogicalMessageIdentity;
  readonly sources: Array<{ readonly sourceId: string; readonly report: SourceSelectionReport }>;
}

// ---------------------------------------------------------------------------
// Layer Definition — the blueprint (shared across threads, lives in config)
// ---------------------------------------------------------------------------

/**
 * Semantic segment of a layer's CONTENT in the reading view: where the content
 * originates, independent of the layer's id or prompt. The layer prompt is always
 * an instruction. "domain-knowledge" is a configured/published domain cache;
 * "thread-knowledge" is generated, thread-private state. Undefined means the
 * layer predates this metadata or was never classified; consumers then fall back
 * to their legacy id heuristic and must not present that as verified provenance.
 */
export type LayerSegment = "domain-knowledge" | "thread-knowledge";
export const LAYER_SEGMENTS: readonly LayerSegment[] = Object.freeze(["domain-knowledge", "thread-knowledge"]);
export function isLayerSegment(value: unknown): value is LayerSegment {
  return typeof value === "string" && (LAYER_SEGMENTS as readonly string[]).includes(value);
}

/**
 * A layer definition is the blueprint for a domain's context layer.
 * It describes the POLICY — what sources feed it, how it ages, its token
 * budget. Definitions live in settings.json and are shared.
 */
export interface LayerDefinition {
  /** Unique identifier (e.g., "conventions", "security", "thread-state"). */
  readonly id: string;
  /** Which domain this layer belongs to. Agents reference this to find their layers. */
  domain?: string;
  /** Semantic segment of this layer's content. Optional for backward compatibility. */
  segment?: LayerSegment;
  /** Source IDs that feed this layer (resolved at instantiation). */
  sourceIds?: string[];
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
  projectId?: string;
  /**
   * Content segment of the instance that produced this snapshot, when it carried
   * one. Absent on legacy snapshots; readers must not infer it from the id and
   * present the inference as recorded provenance.
   */
  segment?: LayerSegment;
  content: string;
  hash: string;
  state: LayerState;
  lastWarmed: number | null;
  lastAccessed: number | null;
  /** What selecting sources chose and omitted for this content, when any did. */
  selection?: LayerSelectionState;
  /**
   * The owner's version mark for exactly this content, when the owner supplied one. A revision is
   * never inferred from the content hash; consumers must check `version.hash === hash`.
   */
  version?: LayerVersionMark;
}

/** An owner-declared version of a layer's content: revision number and the hash of the bytes it marks. */
export interface LayerVersionMark {
  readonly revision: number;
  readonly hash: string;
  readonly author?: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly domain?: string;
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
 *   Agent prompts change, model selections shift.
 *   "We changed the Convention Librarian's prompt — did violations go down?"
 *   Connects to Oracle eval: config version A scored 0.72, version B scored 0.81.
 *   Keep indefinitely.
 *
 * INSTANCE VERSIONS (high volume, short-term debug value):
 *   Thread-state changes every message.
 *   "Why did security guard fire on message 23 but not 22?"
 *   These are events in the Session Store — the store IS the instance history.
 *   Discard after retention window.
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
  readonly owner?: OwnershipScope;
  /** Optional definition this instance was created from. */
  definition?: LayerDefinition;
  sources?: ContextSource[];
  staleness?: number;
  maxTokens?: number;
  /** Instruction explaining how this layer's content should be used. */
  prompt?: string;
  /** Semantic segment of the content; overrides the definition's segment when given. */
  segment?: LayerSegment;
}

export type LayerState = "cold" | "warming" | "warm" | "stale" | "compressing";

/** Emitted on any write to a layer instance. The Session Store captures these. */
export interface LayerMutationEvent {
  layerId: string;
  /** What changed: "content", "state", "staleness", "prompt". */
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
  readonly owner?: OwnershipScope;

  /** The definition this instance was created from (if any). */
  readonly definition: LayerDefinition | undefined;

  /**
   * Construction metadata, not runtime state: where this layer's content
   * originates. Immutable for the instance's lifetime; copied by clone(),
   * recorded by snapshotInstance(), never rewritten by restoreInstance().
   */
  readonly segment: LayerSegment | undefined;

  private _content: string = "";
  private _state: LayerState = "cold";
  private _hash: string = "";
  private _lastWarmed: number | null = null;
  private _lastAccessed: number | null = null;
  private _sources: ContextSource[];
  private _staleness: number | undefined;
  private _maxTokens: number | undefined;
  private _prompt: string | undefined;
  private _focus: string | undefined;
  private _currentMessage: LogicalMessageIdentity | undefined;
  private _selection: LayerSelectionState | undefined;
  private _version?: LayerVersionMark;
  private _warmingPromise: Promise<void> | null = null;

  private _listeners: Array<(state: LayerState, layer: ContextLayer) => void> =
    [];

  /**
   * Mutation listeners — called on any write to this layer (content, state).
   * Used by the Session Store to capture instance history as events.
   * Unlike onStateChange (which only fires on state transitions), this fires
   * on content changes and any other mutation.
   */
  private _mutationListeners: Array<
    (event: LayerMutationEvent) => void
  > = [];

  constructor(config: ContextLayerConfig) {
    this.id = config.id;
    this.owner = config.owner ? Object.freeze({ ...config.owner }) : undefined;
    this.definition = config.definition;
    this._sources = config.sources ?? [];
    this._staleness = config.staleness ?? config.definition?.staleness;
    this._maxTokens = config.maxTokens ?? config.definition?.maxTokens;
    this._prompt = config.prompt ?? config.definition?.prompt;
    const segment = config.segment ?? config.definition?.segment;
    if (segment !== undefined && !isLayerSegment(segment)) throw new Error(`Unknown layer segment "${String(segment)}" for layer "${config.id}"`);
    this.segment = segment;
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
      owner: overrides?.owner,
      staleness: overrides?.staleness ?? definition.staleness,
      maxTokens: overrides?.maxTokens ?? definition.maxTokens,
      prompt: overrides?.prompt ?? definition.prompt,
      ...(overrides?.segment !== undefined ? { segment: overrides.segment } : {}),
    });
  }

  /** Snapshot the current instance state for persistence/recovery. */
  snapshotInstance(threadId?: string): LayerInstanceState {
    return {
      definitionId: this.definition?.id ?? this.id,
      threadId: this.owner?.threadId ?? threadId,
      ...(this.owner?.projectId ? { projectId: this.owner.projectId } : {}),
      // Present only when the instance carries a segment, so legacy snapshots and
      // their consumers keep their exact prior shape.
      ...(this.segment !== undefined ? { segment: this.segment } : {}),
      content: this._content,
      hash: this._hash,
      state: this._state,
      lastWarmed: this._lastWarmed,
      lastAccessed: this._lastAccessed,
      ...(this._selection ? { selection: structuredClone(this._selection) } : {}),
      ...(this._version ? { version: { ...this._version } } : {}),
    };
  }

  /**
   * Create an independent instance with the same definition, sources, and
   * current warm state. Listeners are not copied; sources are shared because
   * they are loaders, not state. Used to give each thread its own layer.
   *
   * When a scope is given, sources that support binding are bound to it so
   * the clone loads only what that thread/project owns or was published to.
   */
  clone(scope?: OwnershipScope): ContextLayer {
    const copy = new ContextLayer({
      id: this.id,
      owner: scope ?? this.owner,
      definition: this.definition,
      sources: this._sources.map((source) => (scope && source.bind ? source.bind(scope) : source)),
      staleness: this._staleness,
      maxTokens: this._maxTokens,
      prompt: this._prompt,
      segment: this.segment,
    });
    copy._focus = this._focus;
    copy._currentMessage = this._currentMessage;
    if (this._state !== "cold") {
      copy.restoreInstance(this.snapshotInstance());
    }
    return copy;
  }

  /** Restore instance state (e.g., from Session Store replay). */
  restoreInstance(snapshot: LayerInstanceState): void {
    this._content = snapshot.content;
    this._hash = snapshot.hash;
    this._lastWarmed = snapshot.lastWarmed;
    this._lastAccessed = snapshot.lastAccessed;
    this._selection = snapshot.selection ? structuredClone(snapshot.selection) : undefined;
    this._version = undefined;
    if (snapshot.definitionId === (this.definition?.id ?? this.id)
      && (!this.owner || snapshot.threadId === this.owner.threadId && snapshot.projectId === this.owner.projectId)
      && snapshot.version && this._validVersion(snapshot.version)) this._version = Object.freeze({ ...snapshot.version });
    const state = snapshot.state === "warming" ? "warm" : snapshot.state;
    // Restored content carries the focus it was selected for. If this layer is now focused
    // elsewhere, the content is real but answers another message: stale, not warm.
    this._setState(state === "warm" && this._focusMismatch() ? "stale" : state);
  }

  /** True when a focusable source's recorded selection focus differs from the current focus. */
  private _focusMismatch(): boolean {
    if (!this._sources.some((source) => source.focusable)) return false;
    const current = this._focus ? computeHash(this._focus) : undefined;
    return (this._selection?.focusHash ?? undefined) !== current ||
      !sameMessage(this._selection?.currentMessage, this._currentMessage);
  }

  // -- Focus --

  /** The message this layer's selecting sources are focused on, if any. */
  get focus(): string | undefined {
    return this._focus;
  }

  /**
   * Point selecting sources at the current message. Changed text or identity makes a
   * warm layer stale only when a source declares it focusable; other layers
   * keep their content and never reload for focus alone.
   */
  setFocus(focus: string | undefined, currentMessage?: LogicalMessageIdentity): void {
    const next = focus?.trim() ? focus : undefined;
    const identity = copyMessageIdentity(currentMessage);
    if (next === this._focus && sameMessage(identity, this._currentMessage)) return;
    this._focus = next;
    // Omitting identity deliberately clears it: direct/background work must
    // never inherit the preceding request just because its text is identical.
    this._currentMessage = identity;
    if (this._sources.some((source) => source.focusable) && this._state === "warm") {
      this._setState("stale");
    }
  }

  /** Selection provenance from the last warm, when any source reported one. */
  get selection(): LayerSelectionState | undefined {
    return this._selection ? structuredClone(this._selection) : undefined;
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
      // A load is labelled with the focus it was asked for. If a focusable source's focus moves
      // while it is loading, that result answers the previous message: reload for the current
      // one (bounded), and if the focus keeps moving leave the layer visibly stale rather than
      // labelling old input as fresh.
      for (let attempt = 0; ; attempt++) {
        const focus = this._focus;
        const currentMessage = this._currentMessage;
        const hint: SourceLoadHint | undefined = focus || currentMessage
          ? Object.freeze({ ...(focus ? { focus } : {}), ...(currentMessage ? { currentMessage } : {}) }) : undefined;
        const parts: string[] = [];
        const reports: LayerSelectionState["sources"] = [];
        for (const source of this._sources) {
          parts.push(await source.load(hint));
          const report = source.report?.();
          if (report) reports.push({ sourceId: source.id, report: structuredClone(report) });
        }

        this._content = parts.join("\n\n");
        this._hash = computeHash(this._content);
        this._version = undefined; // even identical unversioned source bytes are a new write
        this._selection = reports.length
          ? { ...(focus ? { focusHash: computeHash(focus) } : {}), ...(currentMessage ? { currentMessage } : {}), sources: reports }
          : undefined;
        this._lastWarmed = Date.now();

        const focusMoved = (this._focus !== focus || !sameMessage(this._currentMessage, currentMessage)) &&
          this._sources.some((source) => source.focusable);
        if (!focusMoved) { this._setState("warm"); return; }
        if (attempt >= 2) { this._setState("stale"); return; }
      }
    } catch (err) {
      // Revert to previous state so the layer isn't stuck in "warming". Content and selection
      // provenance are whatever the last successful load left; a stale label stays stale.
      const reverted = previousState === "warming" ? "cold" : previousState;
      // Content from the last good load stays, but it answers the focus it was
      // selected for. If the focus has moved since, warm would be a lie.
      this._setState(reverted === "warm" && this._focusMismatch() ? "stale" : reverted);
      throw err;
    }
  }

  set(content: string, author: string = "system"): void {
    const previous = this._content;
    this._content = content;
    this._hash = computeHash(content);
    this._selection = undefined; // manual content has no selection provenance
    this._version = undefined; // a new write carries no version until its owner marks it
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

  private _validVersion(mark: LayerVersionMark): boolean {
    return Number.isSafeInteger(mark.revision) && mark.revision >= 0 && mark.hash === this._hash && mark.hash === computeHash(this._content)
      && (mark.domain === undefined || typeof mark.domain === "string" && mark.domain.length > 0)
      && [mark.threadId, mark.projectId, mark.author].every(value => value === undefined || typeof value === "string" && value.length > 0)
      && (!this.owner || mark.threadId === this.owner.threadId && mark.projectId === this.owner.projectId);
  }

  /** A rejected mark never replaces the current valid owner mark. */
  markVersion(mark: LayerVersionMark): void {
    if (!mark || !this._validVersion(mark)) throw new Error("Layer version mark does not describe the current content and owner");
    this._version = Object.freeze({ ...mark });
  }

  get version(): LayerVersionMark | undefined {
    return this._version;
  }

  clear(): void {
    this._content = "";
    this._hash = "";
    this._lastWarmed = null;
    this._selection = undefined;
    this._version = undefined;
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
