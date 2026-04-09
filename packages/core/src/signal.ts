/**
 * Signal kinds — the Librarian's taxonomy.
 * Extensible via string union, not a closed enum.
 */
export type SignalKind =
  | "correction"
  | "convention"
  | "taste"
  | "ci_rule"
  | "adr"
  | "security"
  | (string & {});

/**
 * A signal — a typed piece of information flowing through the system.
 * Signals are the atoms of the capture → classify → route → verify loop.
 */
export interface Signal<T = unknown> {
  readonly id: string;
  readonly kind: SignalKind;
  readonly source: string; // agent id or "user" or system id
  readonly content: T;
  readonly confidence?: number;
  readonly timestamp: number;
  readonly refs?: Array<{ system: string; locator: string }>; // pointers to related knowledge
}

export type SignalHandler<T = unknown> = (signal: Signal<T>) => void | Promise<void>;

/**
 * A pub/sub bus for signals.
 *
 * Agents emit signals as side-channel information.
 * Observers (Librarian, Herald, writeback rules) subscribe
 * to signal kinds and act on them.
 *
 * Separate from dispatch — signals are observations about what happened,
 * not the primary output.
 */
export class SignalBus {
  private _handlers: Map<string, SignalHandler[]> = new Map();
  private _globalHandlers: SignalHandler[] = [];
  private _history: Signal[] = [];
  private _maxHistory: number;

  constructor(maxHistory: number = 1000) {
    this._maxHistory = maxHistory;
  }

  /** Subscribe to a specific signal kind. */
  on(kind: SignalKind, handler: SignalHandler): () => void {
    if (!this._handlers.has(kind)) {
      this._handlers.set(kind, []);
    }
    this._handlers.get(kind)!.push(handler);

    return () => {
      const handlers = this._handlers.get(kind);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  /** Subscribe to ALL signals. */
  onAny(handler: SignalHandler): () => void {
    this._globalHandlers.push(handler);
    return () => {
      const idx = this._globalHandlers.indexOf(handler);
      if (idx !== -1) this._globalHandlers.splice(idx, 1);
    };
  }

  /** Emit a signal. Notifies kind-specific and global handlers. One handler failure doesn't kill the rest. */
  async emit(signal: Signal): Promise<void> {
    // Record history
    this._history.push(signal);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Snapshot handler arrays to avoid mutation during iteration
    const kindHandlers = [...(this._handlers.get(signal.kind) ?? [])];
    const globalHandlers = [...this._globalHandlers];

    // Run all handlers — one failure doesn't block the rest
    for (const handler of kindHandlers) {
      try {
        await handler(signal);
      } catch (err) {
        console.warn(`[SignalBus] handler error for signal "${signal.kind}":`, (err as Error).message ?? err);
      }
    }

    for (const handler of globalHandlers) {
      try {
        await handler(signal);
      } catch (err) {
        console.warn(`[SignalBus] global handler error for signal "${signal.kind}":`, (err as Error).message ?? err);
      }
    }
  }

  /** Get recent signals, optionally filtered by kind. */
  recent(kind?: SignalKind, limit: number = 50): ReadonlyArray<Signal> {
    const filtered = kind
      ? this._history.filter((s) => s.kind === kind)
      : this._history;
    return filtered.slice(-limit);
  }

  /** Clear history. */
  clearHistory(): void {
    this._history = [];
  }
}
