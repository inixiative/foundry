import type { LayerState } from "./context-layer";

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface LayerSnapshot {
  readonly id: string;
  readonly content: string;
  readonly tokens: number;
  readonly trust: number;
  readonly lastAccessed: number;
  readonly accessCount: number;
  readonly state: LayerState;
}

export interface CompactionPlan {
  /** Layers to compact, in order (lowest priority first). */
  targets: Array<{ layerId: string; targetTokens: number }>;
  /** Layers to evict entirely. */
  evict: string[];
  /** Expected token savings. */
  estimatedSavings: number;
}

export interface CompactionOpts {
  targetTokens: number;
  /** Custom compaction prompt for LLM-based strategies. */
  prompt?: string;
  /** Key terms/patterns to preserve during compaction. */
  preserveKeys?: string[];
}

export interface CompactionStrategy {
  readonly id: string;

  /** Select which layers to compact and in what order. */
  select(
    layers: ReadonlyArray<LayerSnapshot>,
    budget: number
  ): CompactionPlan;

  /** Compact a single layer's content. */
  compact(content: string, opts: CompactionOpts): Promise<string>;
}

/**
 * Minimal interface for LLM calls used by SummarizeStrategy.
 * Intentionally narrow — callers adapt their provider to this shape.
 */
export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateToTokens(text: string, targetTokens: number): string {
  const targetChars = targetTokens * 4;
  if (text.length <= targetChars) return text;
  return text.slice(0, targetChars);
}

// ---------------------------------------------------------------------------
// TrustBasedStrategy
// ---------------------------------------------------------------------------

/**
 * Enhanced trust-based compaction.
 *
 * Sorts layers by trust (low first), then by staleness (least recently
 * accessed first). Compacts by truncation — no LLM needed.
 */
export class TrustBasedStrategy implements CompactionStrategy {
  readonly id = "trust-based";

  select(
    layers: ReadonlyArray<LayerSnapshot>,
    budget: number
  ): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;

    if (overage <= 0) {
      return { targets: [], evict: [], estimatedSavings: 0 };
    }

    // Sort: low trust first, then oldest-accessed first
    const sorted = [...layers].sort((a, b) => {
      if (a.trust !== b.trust) return a.trust - b.trust;
      return a.lastAccessed - b.lastAccessed;
    });

    const targets: CompactionPlan["targets"] = [];
    const evict: string[] = [];
    let savings = 0;

    for (const layer of sorted) {
      if (savings >= overage) break;

      // Layers with zero trust and stale state get evicted
      if (layer.trust === 0 && layer.state === "stale") {
        evict.push(layer.id);
        savings += layer.tokens;
        continue;
      }

      // Compact to half current size, but at least 1 token
      const targetTokens = Math.max(1, Math.floor(layer.tokens * 0.5));
      const layerSavings = layer.tokens - targetTokens;
      targets.push({ layerId: layer.id, targetTokens });
      savings += layerSavings;
    }

    return { targets, evict, estimatedSavings: savings };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    return truncateToTokens(content, opts.targetTokens);
  }
}

// ---------------------------------------------------------------------------
// LRUStrategy
// ---------------------------------------------------------------------------

/**
 * Least-recently-used compaction.
 *
 * Evicts or compacts layers based on recency and access frequency.
 * Layers with low access counts and old timestamps go first.
 */
export class LRUStrategy implements CompactionStrategy {
  readonly id = "lru";

  /** Weight for access count vs. recency. Higher = count matters more. */
  private _frequencyWeight: number;

  constructor(opts?: { frequencyWeight?: number }) {
    this._frequencyWeight = opts?.frequencyWeight ?? 0.3;
  }

  select(
    layers: ReadonlyArray<LayerSnapshot>,
    budget: number
  ): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;

    if (overage <= 0) {
      return { targets: [], evict: [], estimatedSavings: 0 };
    }

    // Compute a priority score: higher = more recently/frequently used
    const now = Date.now();
    const maxAge = Math.max(
      1,
      ...layers.map((l) => now - l.lastAccessed)
    );
    const maxCount = Math.max(1, ...layers.map((l) => l.accessCount));

    const scored = layers.map((l) => {
      const recencyScore = 1 - (now - l.lastAccessed) / maxAge;
      const frequencyScore = l.accessCount / maxCount;
      const score =
        recencyScore * (1 - this._frequencyWeight) +
        frequencyScore * this._frequencyWeight;
      return { layer: l, score };
    });

    // Sort ascending — lowest priority first
    scored.sort((a, b) => a.score - b.score);

    const evict: string[] = [];
    const targets: CompactionPlan["targets"] = [];
    let savings = 0;

    for (const { layer } of scored) {
      if (savings >= overage) break;

      // Evict the lowest-priority layers entirely until overage is met
      if (savings + layer.tokens <= overage * 1.5) {
        evict.push(layer.id);
        savings += layer.tokens;
      } else {
        // Compact rather than evict — keep 50%
        const targetTokens = Math.max(1, Math.floor(layer.tokens * 0.5));
        targets.push({ layerId: layer.id, targetTokens });
        savings += layer.tokens - targetTokens;
      }
    }

    return { targets, evict, estimatedSavings: savings };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    return truncateToTokens(content, opts.targetTokens);
  }
}

// ---------------------------------------------------------------------------
// SummarizeStrategy
// ---------------------------------------------------------------------------

const DEFAULT_COMPACTION_PROMPT =
  "Summarize the following context, preserving all key facts, decisions, code patterns, and actionable information. Remove redundancy and verbose explanations.";

/**
 * LLM-powered summarization compaction.
 *
 * Sends layer content to an LLM with a compaction prompt and returns
 * the summarized result. Respects a configurable summary ratio and
 * preserves user-specified key terms.
 */
export class SummarizeStrategy implements CompactionStrategy {
  readonly id = "summarize";

  private _provider: LLMProvider;
  private _ratio: number;
  private _defaultPrompt: string;

  constructor(
    provider: LLMProvider,
    opts?: { ratio?: number; prompt?: string }
  ) {
    this._provider = provider;
    this._ratio = opts?.ratio ?? 0.25;
    this._defaultPrompt = opts?.prompt ?? DEFAULT_COMPACTION_PROMPT;
  }

  select(
    layers: ReadonlyArray<LayerSnapshot>,
    budget: number
  ): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;

    if (overage <= 0) {
      return { targets: [], evict: [], estimatedSavings: 0 };
    }

    // Sort by tokens descending — summarize the largest layers first
    // to get the most savings per compaction call
    const sorted = [...layers].sort((a, b) => b.tokens - a.tokens);

    const targets: CompactionPlan["targets"] = [];
    let savings = 0;

    for (const layer of sorted) {
      if (savings >= overage) break;

      const targetTokens = Math.max(
        1,
        Math.floor(layer.tokens * this._ratio)
      );
      targets.push({ layerId: layer.id, targetTokens });
      savings += layer.tokens - targetTokens;
    }

    return { targets, evict: [], estimatedSavings: savings };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    const prompt = opts.prompt ?? this._defaultPrompt;
    const preserveSection =
      opts.preserveKeys && opts.preserveKeys.length > 0
        ? `\n\nIMPORTANT: Preserve these key terms and concepts: ${opts.preserveKeys.join(", ")}`
        : "";

    const targetTokens = opts.targetTokens;
    const fullPrompt = [
      prompt,
      preserveSection,
      `\nTarget length: approximately ${targetTokens} tokens (${targetTokens * 4} characters).`,
      `\n---\n${content}`,
    ].join("");

    const result = await this._provider.complete(fullPrompt);

    // If the LLM returns more than target, truncate as a safety net
    if (estimateTokens(result) > targetTokens * 1.2) {
      return truncateToTokens(result, targetTokens);
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// HybridStrategy
// ---------------------------------------------------------------------------

/** Trust thresholds for hybrid routing. */
export interface HybridThresholds {
  /** Below this trust level, use trust-based truncation. Default 0.3. */
  lowTrust?: number;
  /** Above this trust level, use summarization. Default 0.7. */
  highTrust?: number;
}

/**
 * Combines strategies based on layer trust:
 *
 * - Low trust  → TrustBasedStrategy (fast truncation)
 * - Medium trust → LRUStrategy (recency/frequency eviction)
 * - High trust → SummarizeStrategy (LLM summarization)
 */
export class HybridStrategy implements CompactionStrategy {
  readonly id = "hybrid";

  private _trustBased: TrustBasedStrategy;
  private _lru: LRUStrategy;
  private _summarize: SummarizeStrategy;
  private _lowThreshold: number;
  private _highThreshold: number;

  constructor(
    provider: LLMProvider,
    opts?: {
      thresholds?: HybridThresholds;
      summarizeRatio?: number;
      frequencyWeight?: number;
    }
  ) {
    this._trustBased = new TrustBasedStrategy();
    this._lru = new LRUStrategy({
      frequencyWeight: opts?.frequencyWeight,
    });
    this._summarize = new SummarizeStrategy(provider, {
      ratio: opts?.summarizeRatio,
    });
    this._lowThreshold = opts?.thresholds?.lowTrust ?? 0.3;
    this._highThreshold = opts?.thresholds?.highTrust ?? 0.7;
  }

  select(
    layers: ReadonlyArray<LayerSnapshot>,
    budget: number
  ): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;

    if (overage <= 0) {
      return { targets: [], evict: [], estimatedSavings: 0 };
    }

    const low = layers.filter((l) => l.trust < this._lowThreshold);
    const mid = layers.filter(
      (l) => l.trust >= this._lowThreshold && l.trust < this._highThreshold
    );
    const high = layers.filter((l) => l.trust >= this._highThreshold);

    // Phase 1: trust-based on low-trust layers
    const lowPlan = this._trustBased.select(low, budget);
    let remaining = overage - lowPlan.estimatedSavings;

    // Phase 2: LRU on medium-trust layers if still over budget
    let midPlan: CompactionPlan = { targets: [], evict: [], estimatedSavings: 0 };
    if (remaining > 0) {
      const midTokens = mid.reduce((sum, l) => sum + l.tokens, 0);
      const midBudget = midTokens - remaining;
      midPlan = this._lru.select(mid, midBudget);
      remaining -= midPlan.estimatedSavings;
    }

    // Phase 3: summarize high-trust layers if still over budget
    let highPlan: CompactionPlan = { targets: [], evict: [], estimatedSavings: 0 };
    if (remaining > 0) {
      const highTokens = high.reduce((sum, l) => sum + l.tokens, 0);
      const highBudget = highTokens - remaining;
      highPlan = this._summarize.select(high, highBudget);
    }

    return {
      targets: [
        ...lowPlan.targets,
        ...midPlan.targets,
        ...highPlan.targets,
      ],
      evict: [
        ...lowPlan.evict,
        ...midPlan.evict,
        ...highPlan.evict,
      ],
      estimatedSavings:
        lowPlan.estimatedSavings +
        midPlan.estimatedSavings +
        highPlan.estimatedSavings,
    };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    // For individual compact calls, delegate to summarize for best quality
    return this._summarize.compact(content, opts);
  }

  /** Access sub-strategies for direct use. */
  get strategies() {
    return {
      trustBased: this._trustBased as CompactionStrategy,
      lru: this._lru as CompactionStrategy,
      summarize: this._summarize as CompactionStrategy,
    } as const;
  }
}
