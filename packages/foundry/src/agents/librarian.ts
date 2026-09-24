// ---------------------------------------------------------------------------
// Librarian — sole writer to the thread-state layer (FLOW.md)
//
// Consumes all signals from the signal bus, reconciles them into a coherent
// thread-state snapshot, and writes it to a ContextLayer. All middleware
// predicates read this layer to decide "should I run?" — zero LLM calls,
// zero dispatch log scanning.
//
// The Librarian is mostly a programmatic reducer:
// - Last classification wins for domain
// - Append-only for recentActivity (capped ring buffer)
// - Union for flags and inContext
// - LLM call only when signals genuinely conflict (rare)
// ---------------------------------------------------------------------------

import {
  ContextLayer,
  type Signal,
  type SignalBus,
  type ContextStack,
} from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Thread State shape — the materialized view (~200-500 tokens)
// ---------------------------------------------------------------------------

/**
 * Record of a layer injection — what the session has already seen.
 * Used by the FlowOrchestrator to compute deltas (only send what changed).
 */
export interface InjectedLayerRecord {
  /** Layer ID. */
  id: string;
  /** Content hash at injection time. If the layer's hash differs now, re-inject. */
  hash: string;
  /** Message number when this was last injected. */
  messageNum: number;
  /** Timestamp of injection. */
  injectedAt: number;
}

export interface ThreadState {
  /** Current primary domain (e.g., "auth", "payments", "testing") */
  domain: string;
  /** Recent activity descriptions (ring buffer, max 10) */
  recentActivity: string[];
  /** Layer IDs currently in context (convenience — derived from injectedLayers). */
  inContext: string[];
  /**
   * Full injection ledger — tracks what the session has seen, with hashes.
   * Pre-message hooks diff against this to compute deltas.
   * Post-action hooks read this to understand the session's context window.
   */
  injectedLayers: InjectedLayerRecord[];
  /** Last classification result */
  lastClassification: {
    category: string;
    tags: string[];
  } | null;
  /** Total messages processed */
  messageCount: number;
  /** Active flags (e.g., "security-concern-active", "cross-module") */
  flags: string[];
  /** Timestamp of last update */
  lastUpdated: number;
}

/** Fresh empty state — must be a function to avoid shared array references. */
function emptyState(): ThreadState {
  return {
    domain: "",
    recentActivity: [],
    inContext: [],
    injectedLayers: [],
    lastClassification: null,
    messageCount: 0,
    flags: [],
    lastUpdated: 0,
  };
}

const MAX_RECENT_ACTIVITY = 10;

/** Render signal content for activity: strings as-is, objects as bounded JSON, never "[object Object]". */
function describeContent(content: unknown, max = 80): string {
  if (typeof content === "string") return content.slice(0, max);
  if (content === undefined || content === null) return String(content);
  try {
    return JSON.stringify(content).slice(0, max);
  } catch {
    return String(content).slice(0, max);
  }
}

// ---------------------------------------------------------------------------
// Librarian
// ---------------------------------------------------------------------------

export interface LibrarianConfig {
  /** The thread's signal bus to subscribe to. */
  signals: SignalBus;
  /** The thread's context stack (to read layer IDs). */
  stack: ContextStack;
  /** ID for the thread-state layer. Defaults to "thread-state". */
  layerId?: string;
}

export class Librarian {
  private _state: ThreadState;
  private _layer: ContextLayer;
  private _stack: ContextStack;
  private _unsubscribe: (() => void) | null = null;

  constructor(config: LibrarianConfig) {
    this._state = { ...emptyState(), lastUpdated: Date.now() };
    this._stack = config.stack;

    // Create the thread-state layer — always warm
    const layerId = config.layerId ?? "thread-state";
    this._layer = new ContextLayer({
      id: layerId,
      prompt: "Current thread state. Use this to determine what the thread is working on, what context is loaded, and what flags are active.",
      // Generated per-thread state, whatever id the configuration chose for it.
      segment: "thread-knowledge",
    });

    // Set initial content
    this._writeLayer();

    // Add to stack at position 0 (highest priority)
    config.stack.addLayer(this._layer, 0);

    // Subscribe to ALL signals
    this._unsubscribe = config.signals.onAny((signal) => {
      this._reconcile(signal);
    });
  }

  /** Current thread state (read-only snapshot). */
  get state(): Readonly<ThreadState> {
    return this._state;
  }

  /** The thread-state layer. */
  get layer(): ContextLayer {
    return this._layer;
  }

  /** Check if the domain has shifted from the current state. */
  domainShifted(newCategory: string): boolean {
    return this._state.domain !== "" && this._state.domain !== newCategory;
  }

  /** Stop listening to signals. */
  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  // -----------------------------------------------------------------------
  // Signal reconciliation — the core reducer
  // -----------------------------------------------------------------------

  private _reconcile(signal: Signal): void {
    const { kind, content, source } = signal;

    // Route signal to the appropriate reducer
    switch (kind) {
      case "classification":
        this._handleClassification(content as any);
        break;

      case "dispatch":
        this._handleDispatch(content as any);
        break;

      case "tool_observation":
        if (source === "flow-orchestrator") this._handleGuardObservation(content as any);
        else this._handleToolObservation(content as any);
        break;

      case "context_loaded":
        this._handleContextLoaded(content as any);
        break;

      case "context_evicted":
        this._handleContextEvicted(content as any);
        break;

      case "security_concern":
        this._addFlag("security-concern-active");
        this._pushActivity(`Security: ${describeContent(content)}`);
        break;

      case "correction":
        this._pushActivity(`Correction from ${source}: ${describeContent(content)}`);
        break;

      case "architecture_observation":
        if (describeContent(content, 400).toLowerCase().includes("cross-module")) {
          this._addFlag("cross-module");
        }
        this._pushActivity(`Architecture: ${describeContent(content)}`);
        break;

      case "domain_learning": {
        const data = content as { domain?: string; decision?: string; revision?: number; reason?: string } | undefined;
        const rev = data?.revision !== undefined ? ` rev ${data.revision}` : "";
        const why = data?.reason ? ` (${String(data.reason).slice(0, 60)})` : "";
        this._pushActivity(`Learning (${data?.domain ?? "?"}): ${data?.decision ?? "?"}${rev}${why}`);
        break;
      }

      default:
        // Unknown signal kinds just get logged as activity
        this._pushActivity(`[${kind}] ${describeContent(content)}`);
        break;
    }

    this._state.lastUpdated = Date.now();
    this._writeLayer();
  }

  // -----------------------------------------------------------------------
  // Per-signal-kind handlers
  // -----------------------------------------------------------------------

  private _handleClassification(data: { category?: string; tags?: string[] }): void {
    if (!data) return;

    const category = data.category ?? "";
    const tags = data.tags ?? [];

    // Domain shift detection: last classification wins
    if (category && category !== this._state.domain) {
      this._state.domain = category;
    }

    this._state.lastClassification = { category, tags };
    this._state.messageCount++;

    // Clear stale flags on domain shift
    if (this.domainShifted(category)) {
      // Keep persistent flags (security), clear transient ones
      this._state.flags = this._state.flags.filter((f) =>
        f.startsWith("security") || f === "cross-module"
      );
    }
  }

  private _handleDispatch(data: { agentId?: string; payload?: string; ok?: boolean; error?: string }): void {
    if (!data) return;
    const target = data.agentId ?? "agent";
    const on = data.payload ? ` on ${String(data.payload).slice(0, 50)}` : "";
    const desc = data.ok === false
      ? `Failed: ${target}${on} (${String(data.error ?? "unknown error").slice(0, 80)})`
      : `Dispatched: ${target}${on}`;
    this._pushActivity(desc);
  }

  private _handleGuardObservation(data?: { guardOutcomes?: Array<{ domain?: string; status?: string; findings?: number }> }): void {
    if (!Array.isArray(data?.guardOutcomes)) {
      this._pushActivity("Guard review: outcome not recorded");
      return;
    }
    if (data.guardOutcomes.length === 0) {
      this._pushActivity("Guard review: no domains checked");
      return;
    }
    // Shared activity carries outcome metadata, not private guard inputs or error payloads.
    for (const outcome of data.guardOutcomes) {
      const domain = typeof outcome?.domain === "string" ? outcome.domain.slice(0, 60) : "unknown";
      const status = ["completed", "skipped", "cold-cache", "provider-error", "invalid-response"].includes(outcome?.status ?? "")
        ? outcome.status : "outcome not recorded";
      const count = status === "completed" && Number.isSafeInteger(outcome.findings) && outcome.findings! >= 0
        ? `; ${outcome.findings} findings` : "";
      this._pushActivity(`Guard (${domain}): ${status}${count}`);
    }
  }

  private _handleToolObservation(data: { tool?: string; input?: any; inputSummary?: string; ok?: boolean; output?: any }): void {
    if (!data) return;
    const tool = data.tool ?? "unknown";
    let target = "";
    if (data.input?.file_path) target = ` ${data.input.file_path}`;
    else if (data.input?.command) target = ` ${String(data.input.command).slice(0, 60)}`;
    else if (data.input?.pattern) target = ` ${data.input.pattern}`;
    else if (typeof data.inputSummary === "string") target = ` ${data.inputSummary.slice(0, 60)}`;
    const status = data.ok === false ? " (failed)" : "";

    this._pushActivity(`${tool}${target}${status}`);
  }

  private _handleContextLoaded(data: { layerId?: string; hash?: string }): void {
    if (!data?.layerId) return;

    const record: InjectedLayerRecord = {
      id: data.layerId,
      hash: data.hash ?? "",
      messageNum: this._state.messageCount,
      injectedAt: Date.now(),
    };

    // Upsert — replace existing record for this layer (re-injection with new hash)
    const idx = this._state.injectedLayers.findIndex((r) => r.id === data.layerId);
    if (idx !== -1) {
      this._state.injectedLayers[idx] = record;
    } else {
      this._state.injectedLayers.push(record);
    }

    // Keep convenience array in sync
    this._state.inContext = this._state.injectedLayers.map((r) => r.id);
  }

  private _handleContextEvicted(data: { layerId?: string }): void {
    if (!data?.layerId) return;
    this._state.injectedLayers = this._state.injectedLayers.filter((r) => r.id !== data.layerId);
    this._state.inContext = this._state.injectedLayers.map((r) => r.id);
  }

  /**
   * Clear the injection ledger — used when the session's context is reset
   * (e.g., Claude Code auto-compaction, Codex session restart). After a
   * reset the session no longer holds previously-injected layers, so the
   * next turn must re-inject from scratch.
   *
   * Returns the list of layer IDs that were cleared (for caller-side
   * invalidation reporting).
   */
  clearInjectionLedger(): string[] {
    const cleared = this._state.injectedLayers.map((r) => r.id);
    this._state.injectedLayers = [];
    this._state.inContext = [];
    this._state.lastUpdated = Date.now();
    this._writeLayer();
    return cleared;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private _pushActivity(desc: string): void {
    this._state.recentActivity.push(desc);
    if (this._state.recentActivity.length > MAX_RECENT_ACTIVITY) {
      this._state.recentActivity.shift();
    }
  }

  private _addFlag(flag: string): void {
    if (!this._state.flags.includes(flag)) {
      this._state.flags.push(flag);
    }
  }

  /** Serialize state to JSON and write to the layer. */
  private _writeLayer(): void {
    const json = JSON.stringify(this._state, null, 2);
    this._layer.set(json);
  }
}
