// ---------------------------------------------------------------------------
// Flow Orchestrator — wires the five FLOW.md roles into a coherent pipeline
//
// Pre-message flow:
//   1. Context routing  — Cartographer routes message to layers
//   2. Domain advising  — relevant domain librarians advise
//   3. Merge            — assemble minimal context injection
//
// Post-action flow:
//   4. Correctness checking — Librarian trigger-gates, domain librarians guard
//   5. Signal reconciliation — Librarian already handles via signal bus
//
// The goal: minimize what's in the executor's context. The executor starts
// with only what the pre-message flow decides it needs. MCP is the fallback
// for mid-session gaps. Nothing is frontloaded speculatively.
// ---------------------------------------------------------------------------

import {
  type ContextStack,
  type SignalBus,
  type Signal,
} from "@inixiative/foundry-core";

import type { Cartographer, RouteResult } from "./cartographer";
import type {
  DomainLibrarian,
  ToolObservation,
  GuardFinding,
  AdviseResult,
} from "./domain-librarian";
import type { Librarian } from "./librarian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of the pre-message flow — what to inject into the session. */
export interface InjectionPlan {
  /** Layer IDs to hydrate and include. */
  layers: string[];
  /** Inline snippets from domain librarians (small enough to include directly). */
  snippets: string[];
  /** Which domains were consulted. */
  domainsConsulted: string[];
  /** Overall routing confidence. */
  confidence: number;
  /** Time taken for the full pre-message flow (ms). */
  elapsed: number;
  /** Whether this plan was generated fresh or is a reuse of a previous plan. */
  fresh: boolean;
}

/** Result of delta-aware hydration — only the content the thread doesn't already have. */
export interface HydrationResult {
  /** Assembled context string for injection. */
  content: string;
  /** Layers that were actually injected (new or changed). */
  injected: string[];
  /** Layers that were skipped (already in session with same hash). */
  skipped: string[];
  /** Layers whose content changed since last injection (re-injected). */
  reinjected: string[];
}

/** Event emitted when the orchestrator detects a state change that invalidates the current plan. */
export interface InvalidationEvent {
  /** What triggered the invalidation. */
  reason: "eviction" | "rehydration" | "map_rebuild";
  /** Layer IDs affected. */
  affectedLayers: string[];
  /** Timestamp of the invalidation. */
  timestamp: number;
}

/** Result of the post-action flow — findings from guard checks. */
export interface GuardReport {
  /** All findings across all domains. */
  findings: GuardFinding[];
  /** Critical findings that should be pushed to the session immediately. */
  critical: GuardFinding[];
  /** Advisory findings that feed into writeback. */
  advisory: GuardFinding[];
  /** Which domain guards ran. */
  domainsChecked: string[];
  /** Time taken for the full guard flow (ms). */
  elapsed: number;
}

/** Configuration for the flow orchestrator. */
export interface FlowOrchestratorConfig {
  /** The context routing agent. */
  cartographer: Cartographer;
  /** Domain librarians, keyed by domain name. */
  domainLibrarians: Map<string, DomainLibrarian>;
  /** The signal reconciliation coordinator. */
  librarian: Librarian;
  /** The thread's context stack. */
  stack: ContextStack;
  /** Signal bus for emitting orchestration events. */
  signals: SignalBus;
  /**
   * Maximum domains to consult per message in advise mode.
   * Prevents runaway LLM calls on broad messages. Default: 5.
   */
  maxAdviseParallel?: number;
}

// ---------------------------------------------------------------------------
// Flow Orchestrator
// ---------------------------------------------------------------------------

export class FlowOrchestrator {
  private _cartographer: Cartographer;
  private _domains: Map<string, DomainLibrarian>;
  private _librarian: Librarian;
  private _stack: ContextStack;
  private _signals: SignalBus;
  private _maxAdviseParallel: number;

  /** The last injection plan produced by preMessage(). */
  private _lastPlan: InjectionPlan | null = null;
  /** The last message that was routed (for re-firing after invalidation). */
  private _lastMessage: string | null = null;
  /** Whether the current plan has been invalidated by eviction/rehydration. */
  private _invalidated = false;
  /** Accumulated invalidation events since last preMessage(). */
  private _pendingInvalidations: InvalidationEvent[] = [];
  /** Listeners for invalidation events. */
  private _invalidationListeners: Array<(event: InvalidationEvent) => void> = [];
  /** Signal bus unsubscribe handles. */
  private _unsubscribes: Array<() => void> = [];

  constructor(config: FlowOrchestratorConfig) {
    this._cartographer = config.cartographer;
    this._domains = config.domainLibrarians;
    this._librarian = config.librarian;
    this._stack = config.stack;
    this._signals = config.signals;
    this._maxAdviseParallel = config.maxAdviseParallel ?? 5;

    // Subscribe to signals that invalidate the current plan
    this._unsubscribes.push(
      this._signals.onAny((signal) => this._handleInvalidation(signal)),
    );
  }

  /** Whether the current injection plan is stale and should be re-fired. */
  get isInvalidated(): boolean {
    return this._invalidated;
  }

  /** Pending invalidation events since last preMessage(). */
  get pendingInvalidations(): ReadonlyArray<InvalidationEvent> {
    return this._pendingInvalidations;
  }

  /** Register a listener for invalidation events (e.g., to trigger re-injection). */
  onInvalidation(listener: (event: InvalidationEvent) => void): () => void {
    this._invalidationListeners.push(listener);
    return () => {
      const idx = this._invalidationListeners.indexOf(listener);
      if (idx !== -1) this._invalidationListeners.splice(idx, 1);
    };
  }

  /** Stop listening to signals. */
  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
  }

  // -----------------------------------------------------------------------
  // Pre-message flow — context routing + domain advising
  // -----------------------------------------------------------------------

  /**
   * Run the pre-message flow: route the message, advise from relevant
   * domains, and produce an injection plan with minimum viable context.
   *
   * The full message is passed to routing and advising — no compression,
   * no digestion. Flash-tier models handle large inputs (repos, transcripts)
   * cheaply with their large context windows. Layers are decorators and
   * routers around the message, not summaries of it.
   */
  async preMessage(message: string): Promise<InjectionPlan> {
    const plan = await this._runPreMessage(message);
    plan.fresh = true;

    // Track for re-firing after invalidation
    this._lastPlan = plan;
    this._lastMessage = message;
    this._invalidated = false;
    this._pendingInvalidations = [];

    return plan;
  }

  /**
   * Re-fire the pre-message flow for the last message.
   * Call this after eviction or rehydration invalidates the current plan.
   * Returns null if there's no previous message to re-fire for.
   */
  async refire(): Promise<InjectionPlan | null> {
    if (!this._lastMessage) return null;

    const plan = await this._runPreMessage(this._lastMessage);
    plan.fresh = false;

    this._lastPlan = plan;
    this._invalidated = false;
    this._pendingInvalidations = [];

    return plan;
  }

  private async _runPreMessage(message: string): Promise<InjectionPlan> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;

    // Step 1: Context routing — Cartographer decides which domains/layers
    const route = await this._cartographer.route(message, threadState);

    // Step 2: Domain advising — only consult the domains the router selected
    const domainsToConsult = this._selectDomains(route);
    const adviseResults = await this._adviseParallel(
      domainsToConsult,
      message,
      threadState,
    );

    // Step 3: Merge — combine routing + advise into minimal injection
    const plan = this._mergeIntoInjectionPlan(route, adviseResults, start);

    // Note: context_loaded signals are emitted during hydrateDelta(),
    // not here — the plan lists what's WANTED, hydration determines
    // what's actually SENT (after diffing against the ledger).

    return plan;
  }

  /**
   * Hydrate the layers from an injection plan and return the assembled context.
   * This is the content that goes into .foundry-context.md.
   *
   * @deprecated Use hydrateDelta() for delta-aware injection.
   */
  async hydrate(plan: InjectionPlan): Promise<string> {
    const result = await this.hydrateDelta(plan);
    return result.content;
  }

  /**
   * Delta-aware hydration — only injects what the thread doesn't already have.
   *
   * Reads the Librarian's injection ledger (injectedLayers) and compares hashes.
   * Three cases per layer:
   *   1. Not in ledger → new, inject it
   *   2. In ledger, same hash → skip (session already has this content)
   *   3. In ledger, different hash → re-inject (content changed since last injection)
   *
   * Emits context_loaded signals with hashes so the Librarian tracks what was sent.
   */
  async hydrateDelta(plan: InjectionPlan): Promise<HydrationResult> {
    const layerIds = new Set(plan.layers);
    const ledger = this._librarian.state.injectedLayers;
    const ledgerMap = new Map(ledger.map((r) => [r.id, r]));

    // Warm only layers we need that aren't warm yet
    const toWarm = this._stack.layers.filter(
      (l) => layerIds.has(l.id) && !l.isWarm,
    );
    if (toWarm.length > 0) {
      await Promise.all(toWarm.map((l) => l.warm()));
    }

    // Diff against ledger
    const injected: string[] = [];
    const skipped: string[] = [];
    const reinjected: string[] = [];
    const parts: string[] = [];

    for (const id of plan.layers) {
      const layer = this._stack.getLayer(id);
      if (!layer?.isWarm || !layer.content) continue;

      const prev = ledgerMap.get(id);

      if (prev && prev.hash === layer.hash) {
        // Same content — session already has this, skip
        skipped.push(id);
        continue;
      }

      // New or changed — include in injection
      parts.push(layer.content);

      if (prev) {
        reinjected.push(id);
      } else {
        injected.push(id);
      }

      // Emit signal with hash so Librarian's ledger stays current
      await this._signals.emit({
        id: `flow-inject-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        kind: "context_loaded",
        source: "flow-orchestrator",
        content: { layerId: id, hash: layer.hash },
        timestamp: Date.now(),
      });
    }

    if (plan.snippets.length > 0) {
      parts.push(plan.snippets.join("\n"));
    }

    return {
      content: parts.join("\n\n---\n\n"),
      injected,
      skipped,
      reinjected,
    };
  }

  // -----------------------------------------------------------------------
  // Post-action flow — correctness checking
  // -----------------------------------------------------------------------

  /**
   * Run the post-action flow: trigger-gate the observation to the right
   * domain librarians and collect findings.
   */
  async postAction(observation: ToolObservation): Promise<GuardReport> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;

    // The Librarian decides which domain librarians fire
    const domainsToCheck: DomainLibrarian[] = [];
    for (const [, domainLib] of this._domains) {
      if (domainLib.shouldGuard(observation.tool)) {
        domainsToCheck.push(domainLib);
      }
    }

    // Run guards in parallel
    const results = await Promise.all(
      domainsToCheck.map((d) => d.guard(observation, threadState)),
    );

    // Collect findings
    const findings: GuardFinding[] = [];
    const domainsChecked: string[] = [];
    for (let i = 0; i < domainsToCheck.length; i++) {
      domainsChecked.push(domainsToCheck[i].domain);
      if (results[i].ran) {
        findings.push(...results[i].findings);
      }
    }

    const critical = findings.filter((f) => f.severity === "critical");
    const advisory = findings.filter((f) => f.severity === "advisory");

    // Emit tool observation signal for the Librarian's thread-state
    await this._signals.emit({
      id: `flow-obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "tool_observation",
      source: "flow-orchestrator",
      content: {
        tool: observation.tool,
        input: observation.input,
        filesAffected: observation.filesAffected,
        guardsRan: domainsChecked,
        findingsCount: findings.length,
        criticalCount: critical.length,
      },
      timestamp: Date.now(),
    });

    return {
      findings,
      critical,
      advisory,
      domainsChecked,
      elapsed: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Select which domain librarians to consult based on the route result.
   * If the Cartographer returned specific domains, use those.
   * Otherwise, consult all registered domains (capped).
   */
  private _selectDomains(route: RouteResult): DomainLibrarian[] {
    const selected: DomainLibrarian[] = [];

    if (route.domains.length > 0) {
      // Cartographer told us which domains — use them
      for (const domain of route.domains) {
        const lib = this._domains.get(domain);
        if (lib) selected.push(lib);
      }
    } else if (route.confidence < 0.3) {
      // Low confidence routing — consult all domains as fallback
      for (const [, lib] of this._domains) {
        selected.push(lib);
      }
    }

    return selected.slice(0, this._maxAdviseParallel);
  }

  /**
   * Run advise mode on selected domain librarians in parallel.
   */
  private async _adviseParallel(
    domains: DomainLibrarian[],
    message: string,
    threadState: string,
  ): Promise<Map<string, AdviseResult>> {
    const results = new Map<string, AdviseResult>();

    const settled = await Promise.all(
      domains.map(async (d) => {
        try {
          const result = await d.advise(message, threadState);
          return { domain: d.domain, result };
        } catch {
          return { domain: d.domain, result: { layers: [], snippets: [], confidence: 0 } };
        }
      }),
    );

    for (const { domain, result } of settled) {
      results.set(domain, result);
    }

    return results;
  }

  /**
   * Merge routing + advise results into a single injection plan.
   * Deduplicates layer IDs.
   */
  private _mergeIntoInjectionPlan(
    route: RouteResult,
    advise: Map<string, AdviseResult>,
    startTime: number,
  ): InjectionPlan {
    const layerSet = new Set<string>(route.layers);
    const snippets: string[] = [];
    const domainsConsulted: string[] = [...route.domains];

    for (const [domain, result] of advise) {
      if (!domainsConsulted.includes(domain)) {
        domainsConsulted.push(domain);
      }
      for (const layer of result.layers) {
        layerSet.add(layer);
      }
      for (const snippet of result.snippets) {
        snippets.push(snippet);
      }
    }

    return {
      layers: [...layerSet],
      snippets,
      domainsConsulted,
      confidence: route.confidence,
      elapsed: Date.now() - startTime,
      fresh: true,
    };
  }

  // -----------------------------------------------------------------------
  // Invalidation — eviction/rehydration awareness
  // -----------------------------------------------------------------------

  private _handleInvalidation(signal: Signal): void {
    if (!this._lastPlan) return; // no plan to invalidate

    let event: InvalidationEvent | null = null;

    switch (signal.kind) {
      case "context_evicted": {
        const layerId = (signal.content as any)?.layerId;
        if (layerId && this._lastPlan.layers.includes(layerId)) {
          // A layer we injected just got evicted — plan is invalid
          event = {
            reason: "eviction",
            affectedLayers: [layerId],
            timestamp: Date.now(),
          };
        }
        break;
      }
      case "context_loaded": {
        // A layer was loaded — if it's one we wanted but didn't have, routing may improve
        const layerId = (signal.content as any)?.layerId;
        if (layerId && signal.source !== "flow-orchestrator") {
          // External rehydration (not our own injection) — check if it matters
          const layer = this._stack.getLayer(layerId);
          if (layer && !this._lastPlan.layers.includes(layerId)) {
            event = {
              reason: "rehydration",
              affectedLayers: [layerId],
              timestamp: Date.now(),
            };
          }
        }
        break;
      }
    }

    if (event) {
      this._invalidated = true;
      this._pendingInvalidations.push(event);
      for (const listener of this._invalidationListeners) {
        listener(event);
      }
    }
  }
}
