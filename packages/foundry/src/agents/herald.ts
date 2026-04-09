// ---------------------------------------------------------------------------
// Herald — cross-agent observation & coordination middleware
// ---------------------------------------------------------------------------

import type { SessionManager } from "./session";
import type { Thread, ThreadStatus, Dispatch } from "@inixiative/foundry-core";
import type { Signal, SignalKind } from "@inixiative/foundry-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Frozen snapshot of a single thread's state at a point in time. */
export interface ThreadSnapshot {
  threadId: string;
  timestamp: number;
  status: ThreadStatus;
  description: string;
  tags: string[];
  agents: string[];
  layerIds: string[];
  contextHash: string;
  recentDispatches: Array<{
    agentId: string;
    timestamp: number;
    contextHash: string;
    durationMs: number;
    tokens?: { input: number; output: number };
  }>;
  recentSignals: Array<{
    kind: string;
    source: string;
    content: unknown;
    timestamp: number;
  }>;
}

/** A detected cross-cutting pattern. */
export interface HeraldPattern {
  id: string;
  kind:
    | "duplication"
    | "contradiction"
    | "convergence"
    | "cross_pollination"
    | "resource_imbalance";
  severity: "info" | "warning" | "critical";
  threads: string[];
  description: string;
  recommendation: string;
  evidence: unknown;
  timestamp: number;
}

/** A recommendation the Herald injects back into a thread. */
export interface HeraldRecommendation {
  targetThreadId: string;
  pattern: HeraldPattern;
  action: "pause" | "redirect" | "inject_context" | "merge" | "inform";
  payload?: unknown;
}

/** Pluggable pattern detector — implement one per cross-cutting concern. */
export interface PatternDetector {
  readonly id: string;
  readonly kind: HeraldPattern["kind"];
  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[];
}

/** Herald configuration. */
export interface HeraldConfig {
  /** How often to snapshot (ms). Default 5000. */
  snapshotInterval?: number;
  /** Max snapshots retained per thread. Default 20. */
  maxSnapshots?: number;
  /** Max patterns in history. Default 500. */
  maxHistory?: number;
  /** Whether Herald can inject signals into threads. Default true. */
  canInject?: boolean;
  /** Custom pattern detectors to add. */
  detectors?: PatternDetector[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _patternCounter = 0;
function nextPatternId(kind: string): string {
  return `herald_${kind}_${++_patternCounter}_${Date.now().toString(36)}`;
}

/** Dedup window: same kind + same set of threads within this ms = duplicate. */
const DEDUP_WINDOW_MS = 30_000;

function sameThreadSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted1 = [...a].sort();
  const sorted2 = [...b].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}

// ---------------------------------------------------------------------------
// Built-in Pattern Detectors
// ---------------------------------------------------------------------------

/**
 * Detects when two or more threads dispatch to the same agent type within a
 * short time window, or share identical context hashes.
 */
export class DuplicationDetector implements PatternDetector {
  readonly id = "builtin:duplication";
  readonly kind = "duplication" as const;

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();
    const WINDOW_MS = 10_000;

    // Check for same agent dispatched from multiple threads in a short window
    const agentThreadMap = new Map<string, string[]>();
    for (const snap of snapshots) {
      for (const d of snap.recentDispatches) {
        if (now - d.timestamp < WINDOW_MS) {
          const threads = agentThreadMap.get(d.agentId) ?? [];
          if (!threads.includes(snap.threadId)) {
            threads.push(snap.threadId);
          }
          agentThreadMap.set(d.agentId, threads);
        }
      }
    }

    for (const [agentId, threads] of agentThreadMap) {
      if (threads.length >= 2) {
        patterns.push({
          id: nextPatternId("dup"),
          kind: "duplication",
          severity: "warning",
          threads,
          description: `Agent "${agentId}" dispatched from ${threads.length} threads simultaneously`,
          recommendation: "Pause redundant threads to avoid duplicate work",
          evidence: { agentId, threadCount: threads.length },
          timestamp: now,
        });
      }
    }

    // Check for matching contextHashes across threads
    for (let i = 0; i < snapshots.length; i++) {
      for (let j = i + 1; j < snapshots.length; j++) {
        const a = snapshots[i];
        const b = snapshots[j];
        if (
          a.contextHash &&
          b.contextHash &&
          a.contextHash === b.contextHash &&
          a.contextHash !== "" // skip empty hashes
        ) {
          patterns.push({
            id: nextPatternId("dup"),
            kind: "duplication",
            severity: "info",
            threads: [a.threadId, b.threadId],
            description: `Threads "${a.threadId}" and "${b.threadId}" share identical context`,
            recommendation:
              "Consider merging these threads or sharing a context layer",
            evidence: { contextHash: a.contextHash },
            timestamp: now,
          });
        }
      }
    }

    return patterns;
  }
}

/**
 * Detects contradictory signals between threads.
 * Looks for correction signals that may conflict with another thread's output.
 */
export class ContradictionDetector implements PatternDetector {
  readonly id = "builtin:contradiction";
  readonly kind = "contradiction" as const;

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();

    // Check for correction signals that contradict another thread
    for (let i = 0; i < snapshots.length; i++) {
      const corrections = snapshots[i].recentSignals.filter(
        (s) => s.kind === "correction"
      );
      if (corrections.length === 0) continue;

      for (let j = 0; j < snapshots.length; j++) {
        if (i === j) continue;
        const other = snapshots[j];
        // If this thread emitted a correction and the other thread has recent
        // dispatches by the same source, flag it
        for (const corr of corrections) {
          const conflicting = other.recentDispatches.some(
            (d) => d.agentId === corr.source
          );
          if (conflicting) {
            patterns.push({
              id: nextPatternId("contra"),
              kind: "contradiction",
              severity: "warning",
              threads: [snapshots[i].threadId, other.threadId],
              description: `Correction in "${snapshots[i].threadId}" may contradict output in "${other.threadId}" from agent "${corr.source}"`,
              recommendation:
                "Inform both threads of the contradiction so they can reconcile",
              evidence: {
                correctionSource: corr.source,
                correctionContent: corr.content,
              },
              timestamp: now,
            });
          }
        }
      }
    }

    return patterns;
  }
}

/**
 * Detects when 3+ threads target overlapping context layers or produce
 * dispatches with matching context hashes despite different descriptions.
 */
export class ConvergenceDetector implements PatternDetector {
  readonly id = "builtin:convergence";
  readonly kind = "convergence" as const;

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();

    // Check for overlapping layerIds across 3+ threads
    const layerToThreads = new Map<string, string[]>();
    for (const snap of snapshots) {
      for (const layerId of snap.layerIds) {
        const threads = layerToThreads.get(layerId) ?? [];
        threads.push(snap.threadId);
        layerToThreads.set(layerId, threads);
      }
    }

    // Find layers shared by 3+ threads
    const convergentThreads = new Set<string>();
    const convergentLayers: string[] = [];
    for (const [layerId, threads] of layerToThreads) {
      if (threads.length >= 3) {
        convergentLayers.push(layerId);
        for (const t of threads) convergentThreads.add(t);
      }
    }

    if (convergentThreads.size >= 3) {
      patterns.push({
        id: nextPatternId("conv"),
        kind: "convergence",
        severity: "info",
        threads: [...convergentThreads],
        description: `${convergentThreads.size} threads converging on layers: ${convergentLayers.join(", ")}`,
        recommendation:
          "Consider merging these threads or creating a shared context layer",
        evidence: { layers: convergentLayers },
        timestamp: now,
      });
    }

    // Check for different descriptions but matching contextHashes in dispatches
    for (let i = 0; i < snapshots.length; i++) {
      for (let j = i + 1; j < snapshots.length; j++) {
        const a = snapshots[i];
        const b = snapshots[j];
        if (a.description === b.description) continue; // same description is not interesting
        if (a.description === "" || b.description === "") continue;

        const aHashes = new Set(a.recentDispatches.map((d) => d.contextHash));
        const overlap = b.recentDispatches.filter((d) =>
          aHashes.has(d.contextHash)
        );
        if (overlap.length > 0) {
          patterns.push({
            id: nextPatternId("conv"),
            kind: "convergence",
            severity: "info",
            threads: [a.threadId, b.threadId],
            description: `Threads "${a.threadId}" and "${b.threadId}" have different goals but matching dispatch contexts`,
            recommendation:
              "These threads may benefit from coordination or merging",
            evidence: {
              descriptions: [a.description, b.description],
              matchingHashes: overlap.length,
            },
            timestamp: now,
          });
        }
      }
    }

    return patterns;
  }
}

/**
 * Detects when a signal emitted by one thread is relevant to another thread
 * based on tag matching.
 */
export class CrossPollinationDetector implements PatternDetector {
  readonly id = "builtin:cross_pollination";
  readonly kind = "cross_pollination" as const;

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();

    for (const source of snapshots) {
      for (const signal of source.recentSignals) {
        for (const target of snapshots) {
          if (source.threadId === target.threadId) continue;
          // Check if signal kind matches any of the target's tags
          const tagMatch = target.tags.some(
            (tag) => tag === signal.kind || signal.kind.includes(tag)
          );
          if (tagMatch) {
            patterns.push({
              id: nextPatternId("xpol"),
              kind: "cross_pollination",
              severity: "info",
              threads: [source.threadId, target.threadId],
              description: `Signal "${signal.kind}" from "${source.threadId}" is relevant to "${target.threadId}" (matching tags)`,
              recommendation: `Inject context from "${source.threadId}" into "${target.threadId}"`,
              evidence: {
                signalKind: signal.kind,
                signalSource: signal.source,
                matchingTags: target.tags.filter(
                  (tag) => tag === signal.kind || signal.kind.includes(tag)
                ),
              },
              timestamp: now,
            });
          }
        }
      }
    }

    return patterns;
  }
}

/**
 * Detects resource imbalance — one thread has many more dispatches than others,
 * or is idle while peers with similar work are active.
 */
export class ResourceImbalanceDetector implements PatternDetector {
  readonly id = "builtin:resource_imbalance";
  readonly kind = "resource_imbalance" as const;

  detect(
    snapshots: ReadonlyArray<ThreadSnapshot>,
    _history: ReadonlyArray<HeraldPattern>
  ): HeraldPattern[] {
    const patterns: HeraldPattern[] = [];
    const now = Date.now();

    if (snapshots.length < 2) return patterns;

    // Compare dispatch counts
    const counts = snapshots.map((s) => ({
      threadId: s.threadId,
      count: s.recentDispatches.length,
      status: s.status,
      description: s.description,
    }));

    const avg =
      counts.reduce((sum, c) => sum + c.count, 0) / counts.length;

    // Flag threads with 3x average dispatches (overloaded)
    for (const c of counts) {
      if (avg > 0 && c.count >= avg * 3 && c.count >= 3) {
        const underloaded = counts
          .filter((o) => o.count < avg && o.threadId !== c.threadId)
          .map((o) => o.threadId);

        if (underloaded.length > 0) {
          patterns.push({
            id: nextPatternId("imbal"),
            kind: "resource_imbalance",
            severity: "warning",
            threads: [c.threadId, ...underloaded],
            description: `Thread "${c.threadId}" is overloaded (${c.count} dispatches vs avg ${avg.toFixed(1)})`,
            recommendation: "Redirect some work to underutilized threads",
            evidence: {
              overloaded: c.threadId,
              overloadedCount: c.count,
              average: avg,
              underutilized: underloaded,
            },
            timestamp: now,
          });
        }
      }
    }

    // Idle thread while others with similar descriptions are active
    const idle = counts.filter((c) => c.status === "idle" && c.description);
    const active = counts.filter(
      (c) => c.status === "active" && c.description
    );
    for (const i of idle) {
      for (const a of active) {
        if (i.description === a.description) {
          patterns.push({
            id: nextPatternId("imbal"),
            kind: "resource_imbalance",
            severity: "info",
            threads: [i.threadId, a.threadId],
            description: `Thread "${i.threadId}" is idle while "${a.threadId}" is active with similar work`,
            recommendation: `Redirect work from "${a.threadId}" to idle thread "${i.threadId}"`,
            evidence: {
              idleThread: i.threadId,
              activeThread: a.threadId,
              sharedDescription: i.description,
            },
            timestamp: now,
          });
        }
      }
    }

    return patterns;
  }
}

// ---------------------------------------------------------------------------
// Herald
// ---------------------------------------------------------------------------

/**
 * The Herald is the nervous system that observes multiple threads/agents
 * simultaneously and detects cross-cutting patterns. It operates on frozen
 * snapshots — read-many, write-none on agent state.
 *
 * Detectors are pluggable: implement PatternDetector and register via
 * addDetector() or the config.detectors array. The built-in detectors cover
 * duplication, contradiction, convergence, cross-pollination, and resource
 * imbalance.
 *
 * The Herald can optionally inject recommendations as signals into target
 * threads (controlled by canInject).
 */
export class Herald {
  private _session: SessionManager;
  private _config: Required<
    Omit<HeraldConfig, "detectors">
  >;
  private _detectors: PatternDetector[] = [];
  private _patterns: HeraldPattern[] = [];
  private _recommendations: HeraldRecommendation[] = [];
  private _snapshots: Map<string, ThreadSnapshot[]> = new Map();
  private _interval: ReturnType<typeof setInterval> | null = null;

  private _patternHandlers: Array<(pattern: HeraldPattern) => void> = [];
  private _recHandlers: Array<(rec: HeraldRecommendation) => void> = [];

  constructor(session: SessionManager, config?: HeraldConfig) {
    this._session = session;
    this._config = {
      snapshotInterval: config?.snapshotInterval ?? 5000,
      maxSnapshots: config?.maxSnapshots ?? 20,
      maxHistory: config?.maxHistory ?? 500,
      canInject: config?.canInject ?? true,
    };

    // Register built-in detectors
    this._detectors = [
      new DuplicationDetector(),
      new ContradictionDetector(),
      new ConvergenceDetector(),
      new CrossPollinationDetector(),
      new ResourceImbalanceDetector(),
    ];

    // Add custom detectors
    if (config?.detectors) {
      for (const d of config.detectors) {
        this._detectors.push(d);
      }
    }
  }

  // -- Lifecycle --

  /** Begin periodic snapshotting and pattern detection. */
  start(): void {
    if (this._interval) return; // already running
    this._interval = setInterval(() => {
      this.observe();
    }, this._config.snapshotInterval);
  }

  /** Stop periodic snapshotting. */
  stop(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  // -- Manual trigger --

  /**
   * Take a snapshot of all active threads, run all detectors, deduplicate
   * patterns, generate recommendations, and optionally inject signals.
   * Returns newly detected patterns.
   */
  async observe(): Promise<HeraldPattern[]> {
    const snapshots = this.snapshotAll();
    if (snapshots.length === 0) return [];

    // Run each detector
    let newPatterns: HeraldPattern[] = [];
    for (const detector of this._detectors) {
      const detected = detector.detect(snapshots, this._patterns);
      newPatterns.push(...detected);
    }

    // Deduplicate: same kind + same thread set within DEDUP_WINDOW_MS
    newPatterns = this._dedup(newPatterns);

    // Store patterns in bounded history
    this._patterns.push(...newPatterns);
    while (this._patterns.length > this._config.maxHistory) {
      this._patterns.shift();
    }

    // Generate recommendations for warning/critical patterns
    const newRecs: HeraldRecommendation[] = [];
    for (const pattern of newPatterns) {
      if (pattern.severity === "info") continue;

      const recs = this._recommend(pattern);
      newRecs.push(...recs);
    }

    this._recommendations.push(...newRecs);

    // Notify pattern handlers
    for (const pattern of newPatterns) {
      for (const handler of this._patternHandlers) {
        try {
          handler(pattern);
        } catch {
          // Don't let one bad handler break the herald
        }
      }
    }

    // Notify recommendation handlers and inject if enabled
    for (const rec of newRecs) {
      for (const handler of this._recHandlers) {
        try {
          handler(rec);
        } catch {
          // silently continue
        }
      }

      if (this._config.canInject) {
        this.inject(rec);
      }
    }

    return newPatterns;
  }

  // -- Snapshot management --

  /** Capture a single thread's frozen state. */
  snapshot(thread: Thread): ThreadSnapshot {
    const now = Date.now();
    const dispatches = thread.dispatches.slice(-10);
    const signals = [...thread.signals.recent(undefined, 20)];
    const stackSnap = thread.stack.snapshot();

    const snap: ThreadSnapshot = {
      threadId: thread.id,
      timestamp: now,
      status: thread.meta.status,
      description: thread.meta.description,
      tags: [...thread.meta.tags],
      agents: [...thread.agents.keys()],
      layerIds: thread.stack.layers.map((l) => l.id),
      contextHash: stackSnap.hash,
      recentDispatches: dispatches.map((d) => ({
        agentId: d.agentId,
        timestamp: d.timestamp,
        contextHash: d.contextHash,
        durationMs: d.durationMs,
        tokens: d.result.tokens
          ? { input: d.result.tokens.input, output: d.result.tokens.output }
          : undefined,
      })),
      recentSignals: signals.map((s) => ({
        kind: s.kind,
        source: s.source,
        content: s.content,
        timestamp: s.timestamp,
      })),
    };

    // Store snapshot history per thread
    const history = this._snapshots.get(thread.id) ?? [];
    history.push(snap);
    while (history.length > this._config.maxSnapshots) {
      history.shift();
    }
    this._snapshots.set(thread.id, history);

    return snap;
  }

  /** Capture all active threads. */
  snapshotAll(): ThreadSnapshot[] {
    const threads = this._session.active;
    return threads.map((t) => this.snapshot(t));
  }

  // -- Pattern history --

  get patterns(): ReadonlyArray<HeraldPattern> {
    return this._patterns;
  }

  get recommendations(): ReadonlyArray<HeraldRecommendation> {
    return this._recommendations;
  }

  // -- Detectors --

  addDetector(detector: PatternDetector): void {
    this._detectors.push(detector);
  }

  removeDetector(id: string): boolean {
    const idx = this._detectors.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this._detectors.splice(idx, 1);
    return true;
  }

  // -- Events --

  /** Subscribe to new patterns. Returns unsubscribe function. */
  onPattern(handler: (pattern: HeraldPattern) => void): () => void {
    this._patternHandlers.push(handler);
    return () => {
      const idx = this._patternHandlers.indexOf(handler);
      if (idx !== -1) this._patternHandlers.splice(idx, 1);
    };
  }

  /** Subscribe to new recommendations. Returns unsubscribe function. */
  onRecommendation(handler: (rec: HeraldRecommendation) => void): () => void {
    this._recHandlers.push(handler);
    return () => {
      const idx = this._recHandlers.indexOf(handler);
      if (idx !== -1) this._recHandlers.splice(idx, 1);
    };
  }

  // -- Injection --

  /** Push a recommendation signal into the target thread's signal bus. */
  inject(rec: HeraldRecommendation): void {
    if (!this._config.canInject) return;

    const thread = this._session.get(rec.targetThreadId);
    if (!thread) return;

    thread.signals.emit({
      id: `herald_${Date.now().toString(36)}`,
      kind: "herald" as SignalKind,
      source: "herald",
      content: rec,
      confidence: rec.pattern.severity === "critical" ? 1.0 : 0.7,
      timestamp: Date.now(),
    });
  }

  // -- Internal --

  /** Deduplicate patterns: same kind + same thread set within dedup window. */
  private _dedup(newPatterns: HeraldPattern[]): HeraldPattern[] {
    const result: HeraldPattern[] = [];

    for (const pattern of newPatterns) {
      const isDup = this._patterns.some(
        (existing) =>
          existing.kind === pattern.kind &&
          sameThreadSet(existing.threads, pattern.threads) &&
          pattern.timestamp - existing.timestamp < DEDUP_WINDOW_MS
      );

      // Also check within the current batch
      const isDupInBatch = result.some(
        (r) =>
          r.kind === pattern.kind &&
          sameThreadSet(r.threads, pattern.threads)
      );

      if (!isDup && !isDupInBatch) {
        result.push(pattern);
      }
    }

    return result;
  }

  /** Generate recommendations from a pattern. */
  private _recommend(pattern: HeraldPattern): HeraldRecommendation[] {
    const recs: HeraldRecommendation[] = [];

    const actionMap: Record<HeraldPattern["kind"], HeraldRecommendation["action"]> = {
      duplication: "pause",
      contradiction: "inform",
      convergence: "merge",
      cross_pollination: "inject_context",
      resource_imbalance: "redirect",
    };

    const action = actionMap[pattern.kind];

    // Generate a recommendation for each involved thread
    for (const threadId of pattern.threads) {
      recs.push({
        targetThreadId: threadId,
        pattern,
        action,
        payload: pattern.evidence,
      });
    }

    return recs;
  }
}
