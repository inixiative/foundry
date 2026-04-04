import { ContextLayer } from "./context-layer";
import { ContextStack } from "./context-stack";
import { CacheLifecycle } from "./cache-lifecycle";
import type { SignalBus, Signal } from "./signal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessRecord {
  layerId: string;
  timestamp: number;
  agentId?: string;
  outcome: "used" | "overridden" | "ignored";
}

export interface CompetitionResult {
  winner: string;
  loser: string;
  reason: string;
  trustDelta: number;
}

export interface ActiveMemoryConfig {
  /** Trust gained per successful use. Default 1. */
  useBoost?: number;
  /** Trust lost per override. Default 3. */
  overridePenalty?: number;
  /** Trust lost per ignore (layer read but output didn't reference it). Default 0.5. */
  ignorePenalty?: number;
  /** Minimum trust before a layer is candidate for dissolution. Default 5. */
  dissolutionThreshold?: number;
  /** Enable competition between layers with overlapping content. Default true. */
  enableCompetition?: boolean;
}

export interface LayerStats {
  layerId: string;
  accessCount: number;
  useCount: number;
  overrideCount: number;
  ignoreCount: number;
  lastAccessed: number;
  trustTrajectory: "rising" | "stable" | "falling" | "dissolving";
  currentTrust: number;
}

// ---------------------------------------------------------------------------
// Internal tracking
// ---------------------------------------------------------------------------

interface LayerTracking {
  accessCount: number;
  useCount: number;
  overrideCount: number;
  ignoreCount: number;
  lastAccessed: number;
  /** Recent trust deltas for trajectory calculation (last N adjustments). */
  recentDeltas: number[];
}

// ---------------------------------------------------------------------------
// ActiveMemory
// ---------------------------------------------------------------------------

/**
 * Levin-inspired active memory system.
 *
 * "Every recall is a rewrite. Memories are agents, not data.
 *  Memory survives by adapting, not persisting."
 *
 * When context layers are accessed, they adapt: layers that get used gain
 * trust, layers that get overridden lose trust, and layers compete for
 * influence. Below a dissolution threshold, layers are removed.
 */
export class ActiveMemory {
  private _stack: ContextStack;
  private _lifecycle: CacheLifecycle;
  private _tracking: Map<string, LayerTracking> = new Map();

  private _useBoost: number;
  private _overridePenalty: number;
  private _ignorePenalty: number;
  private _dissolutionThreshold: number;
  private _enableCompetition: boolean;

  /** Max recent deltas tracked for trajectory calculation. */
  private static readonly TRAJECTORY_WINDOW = 5;

  constructor(
    stack: ContextStack,
    lifecycle: CacheLifecycle,
    config?: ActiveMemoryConfig
  ) {
    this._stack = stack;
    this._lifecycle = lifecycle;
    this._useBoost = config?.useBoost ?? 1;
    this._overridePenalty = config?.overridePenalty ?? 3;
    this._ignorePenalty = config?.ignorePenalty ?? 0.5;
    this._dissolutionThreshold = config?.dissolutionThreshold ?? 5;
    this._enableCompetition = config?.enableCompetition ?? true;
  }

  // -- Access tracking --

  /** Record that a layer was accessed during a dispatch. */
  recordAccess(record: AccessRecord): void {
    const tracking = this._ensureTracking(record.layerId);

    tracking.accessCount++;
    tracking.lastAccessed = record.timestamp;

    const layer = this._stack.getLayer(record.layerId);
    if (!layer) return;

    let delta = 0;

    switch (record.outcome) {
      case "used":
        tracking.useCount++;
        delta = this._useBoost;
        break;
      case "overridden":
        tracking.overrideCount++;
        delta = -this._overridePenalty;
        break;
      case "ignored":
        tracking.ignoreCount++;
        delta = -this._ignorePenalty;
        break;
    }

    // Apply delta, clamped to [0, 100]
    layer.trust = Math.min(100, Math.max(0, layer.trust + delta));

    // Track recent deltas for trajectory
    tracking.recentDeltas.push(delta);
    if (tracking.recentDeltas.length > ActiveMemory.TRAJECTORY_WINDOW) {
      tracking.recentDeltas.shift();
    }
  }

  /** Process a correction signal — the layer's content was wrong/overridden. */
  recordCorrection(
    layerId: string,
    _correction: unknown,
    agentId?: string
  ): void {
    this.recordAccess({
      layerId,
      timestamp: Date.now(),
      agentId,
      outcome: "overridden",
    });
  }

  // -- Competition --

  /** Run competition between overlapping layers. Returns results. */
  compete(): CompetitionResult[] {
    if (!this._enableCompetition) return [];

    const results: CompetitionResult[] = [];
    const warmLayers = this._stack.layers.filter(
      (l) => l.isWarm && l.content.length > 0
    );

    // Compare each pair for content overlap
    for (let i = 0; i < warmLayers.length; i++) {
      for (let j = i + 1; j < warmLayers.length; j++) {
        const a = warmLayers[i];
        const b = warmLayers[j];

        const overlap = this._computeOverlap(a.content, b.content);
        if (overlap < 0.3) continue; // Not enough overlap to compete

        const trackA = this._ensureTracking(a.id);
        const trackB = this._ensureTracking(b.id);

        // The more-accessed layer wins
        if (trackA.accessCount === trackB.accessCount) continue;

        const winner =
          trackA.accessCount > trackB.accessCount ? a : b;
        const loser = winner === a ? b : a;

        const delta = Math.round(overlap * 2 * 10) / 10; // Scale by overlap

        winner.trust = Math.min(100, winner.trust + delta);
        loser.trust = Math.max(0, loser.trust - delta);

        // Update trajectory tracking
        const winTracking = this._ensureTracking(winner.id);
        const loseTracking = this._ensureTracking(loser.id);
        winTracking.recentDeltas.push(delta);
        loseTracking.recentDeltas.push(-delta);
        if (winTracking.recentDeltas.length > ActiveMemory.TRAJECTORY_WINDOW) {
          winTracking.recentDeltas.shift();
        }
        if (loseTracking.recentDeltas.length > ActiveMemory.TRAJECTORY_WINDOW) {
          loseTracking.recentDeltas.shift();
        }

        results.push({
          winner: winner.id,
          loser: loser.id,
          reason: `${winner.id} accessed ${Math.max(trackA.accessCount, trackB.accessCount)} times vs ${Math.min(trackA.accessCount, trackB.accessCount)} with ${Math.round(overlap * 100)}% overlap`,
          trustDelta: delta,
        });
      }
    }

    return results;
  }

  // -- Dissolution --

  /** Get layers below dissolution threshold — candidates for removal. */
  get dissolving(): ReadonlyArray<ContextLayer> {
    return this._stack.layers.filter(
      (l) => l.trust < this._dissolutionThreshold
    );
  }

  /** Dissolve (remove) layers that have fallen below threshold. */
  dissolve(): string[] {
    const candidates = this.dissolving;
    const removed: string[] = [];

    for (const layer of candidates) {
      this._stack.removeLayer(layer.id);
      this._lifecycle.emit({
        type: "layer:dissolved",
        layerId: layer.id,
        timestamp: Date.now(),
        meta: { trust: layer.trust, threshold: this._dissolutionThreshold },
      });
      removed.push(layer.id);
    }

    return removed;
  }

  // -- Stats --

  /** Get access stats for a layer. */
  stats(layerId: string): LayerStats {
    const tracking = this._ensureTracking(layerId);
    const layer = this._stack.getLayer(layerId);
    const currentTrust = layer?.trust ?? 0;

    return {
      layerId,
      accessCount: tracking.accessCount,
      useCount: tracking.useCount,
      overrideCount: tracking.overrideCount,
      ignoreCount: tracking.ignoreCount,
      lastAccessed: tracking.lastAccessed,
      trustTrajectory: this._computeTrajectory(tracking, currentTrust),
      currentTrust,
    };
  }

  // -- Signal integration --

  /** Wire into a thread's signal bus to auto-process corrections. */
  connectSignals(signals: SignalBus): () => void {
    return signals.on("correction", (signal: Signal) => {
      // Find the layer referenced by this correction signal
      const layerId = this._resolveLayerFromSignal(signal);
      if (layerId) {
        this.recordCorrection(layerId, signal.content, signal.source);
      }
    });
  }

  /** Wire into lifecycle to track layer accesses automatically. */
  connectLifecycle(): () => void {
    // Track when layers transition to "warm" as an access event
    const unsub = this._lifecycle.on("layer:warm", (event) => {
      const tracking = this._ensureTracking(event.layerId);
      tracking.accessCount++;
      tracking.lastAccessed = event.timestamp;
    });

    return unsub;
  }

  // -- Private helpers --

  private _ensureTracking(layerId: string): LayerTracking {
    let tracking = this._tracking.get(layerId);
    if (!tracking) {
      tracking = {
        accessCount: 0,
        useCount: 0,
        overrideCount: 0,
        ignoreCount: 0,
        lastAccessed: 0,
        recentDeltas: [],
      };
      this._tracking.set(layerId, tracking);
    }
    return tracking;
  }

  private _computeTrajectory(
    tracking: LayerTracking,
    currentTrust: number
  ): LayerStats["trustTrajectory"] {
    if (currentTrust < this._dissolutionThreshold) return "dissolving";
    if (tracking.recentDeltas.length === 0) return "stable";

    const avg =
      tracking.recentDeltas.reduce((s, d) => s + d, 0) /
      tracking.recentDeltas.length;

    if (avg > 0.1) return "rising";
    if (avg < -0.1) return "falling";
    return "stable";
  }

  /**
   * Compute word-level overlap ratio between two content strings.
   * Returns 0..1 where 1 = identical word sets.
   */
  private _computeOverlap(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let shared = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) shared++;
    }

    // Jaccard similarity
    const union = new Set([...wordsA, ...wordsB]).size;
    return union === 0 ? 0 : shared / union;
  }

  /**
   * Resolve a signal to a layer ID. Checks signal refs for layer references,
   * falls back to finding the most recently accessed layer.
   */
  private _resolveLayerFromSignal(signal: Signal): string | undefined {
    // Check refs for a direct layer reference
    if (signal.refs) {
      for (const ref of signal.refs) {
        if (ref.system === "layer") return ref.locator;
      }
    }

    // Fallback: find the most recently accessed layer
    let bestId: string | undefined;
    let bestTime = 0;
    for (const [id, tracking] of this._tracking) {
      if (tracking.lastAccessed > bestTime && this._stack.getLayer(id)) {
        bestTime = tracking.lastAccessed;
        bestId = id;
      }
    }

    return bestId;
  }
}
