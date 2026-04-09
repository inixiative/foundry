import type {
  LayerSnapshot,
  CompactionPlan,
  CompactionOpts,
  CompactionStrategy,
  CompactionLLMProvider,
} from "@inixiative/foundry-core";

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

export class TrustBasedStrategy implements CompactionStrategy {
  readonly id = "trust-based";

  select(layers: ReadonlyArray<LayerSnapshot>, budget: number): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;
    if (overage <= 0) return { targets: [], evict: [], estimatedSavings: 0 };

    const sorted = [...layers].sort((a, b) => {
      if (a.trust !== b.trust) return a.trust - b.trust;
      return a.lastAccessed - b.lastAccessed;
    });

    const targets: CompactionPlan["targets"] = [];
    const evict: string[] = [];
    let savings = 0;

    for (const layer of sorted) {
      if (savings >= overage) break;
      if (layer.trust === 0 && layer.state === "stale") {
        evict.push(layer.id);
        savings += layer.tokens;
        continue;
      }
      const targetTokens = Math.max(1, Math.floor(layer.tokens * 0.5));
      targets.push({ layerId: layer.id, targetTokens });
      savings += layer.tokens - targetTokens;
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

export class LRUStrategy implements CompactionStrategy {
  readonly id = "lru";
  private _frequencyWeight: number;

  constructor(opts?: { frequencyWeight?: number }) {
    this._frequencyWeight = opts?.frequencyWeight ?? 0.3;
  }

  select(layers: ReadonlyArray<LayerSnapshot>, budget: number): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;
    if (overage <= 0) return { targets: [], evict: [], estimatedSavings: 0 };

    const now = Date.now();
    const maxAge = Math.max(1, ...layers.map((l) => now - l.lastAccessed));
    const maxCount = Math.max(1, ...layers.map((l) => l.accessCount));

    const scored = layers.map((l) => {
      const recencyScore = 1 - (now - l.lastAccessed) / maxAge;
      const frequencyScore = l.accessCount / maxCount;
      return { layer: l, score: recencyScore * (1 - this._frequencyWeight) + frequencyScore * this._frequencyWeight };
    });
    scored.sort((a, b) => a.score - b.score);

    const evict: string[] = [];
    const targets: CompactionPlan["targets"] = [];
    let savings = 0;

    for (const { layer } of scored) {
      if (savings >= overage) break;
      if (savings + layer.tokens <= overage * 1.5) {
        evict.push(layer.id);
        savings += layer.tokens;
      } else {
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

export class SummarizeStrategy implements CompactionStrategy {
  readonly id = "summarize";
  private _provider: CompactionLLMProvider;
  private _ratio: number;
  private _defaultPrompt: string;

  constructor(provider: CompactionLLMProvider, opts?: { ratio?: number; prompt?: string }) {
    this._provider = provider;
    this._ratio = opts?.ratio ?? 0.25;
    this._defaultPrompt = opts?.prompt ?? DEFAULT_COMPACTION_PROMPT;
  }

  select(layers: ReadonlyArray<LayerSnapshot>, budget: number): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;
    if (overage <= 0) return { targets: [], evict: [], estimatedSavings: 0 };

    const sorted = [...layers].sort((a, b) => b.tokens - a.tokens);
    const targets: CompactionPlan["targets"] = [];
    let savings = 0;

    for (const layer of sorted) {
      if (savings >= overage) break;
      const targetTokens = Math.max(1, Math.floor(layer.tokens * this._ratio));
      targets.push({ layerId: layer.id, targetTokens });
      savings += layer.tokens - targetTokens;
    }

    return { targets, evict: [], estimatedSavings: savings };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    const prompt = opts.prompt ?? this._defaultPrompt;
    const preserveSection = opts.preserveKeys?.length
      ? `\n\nIMPORTANT: Preserve these key terms and concepts: ${opts.preserveKeys.join(", ")}`
      : "";

    const fullPrompt = `${prompt}${preserveSection}\nTarget length: approximately ${opts.targetTokens} tokens (${opts.targetTokens * 4} characters).\n---\n${content}`;
    const result = await this._provider.complete(fullPrompt);

    if (estimateTokens(result) > opts.targetTokens * 1.2) {
      return truncateToTokens(result, opts.targetTokens);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// HybridStrategy
// ---------------------------------------------------------------------------

export interface HybridThresholds {
  lowTrust?: number;
  highTrust?: number;
}

export class HybridStrategy implements CompactionStrategy {
  readonly id = "hybrid";
  private _trustBased: TrustBasedStrategy;
  private _lru: LRUStrategy;
  private _summarize: SummarizeStrategy;
  private _lowThreshold: number;
  private _highThreshold: number;

  constructor(provider: CompactionLLMProvider, opts?: { thresholds?: HybridThresholds; summarizeRatio?: number; frequencyWeight?: number }) {
    this._trustBased = new TrustBasedStrategy();
    this._lru = new LRUStrategy({ frequencyWeight: opts?.frequencyWeight });
    this._summarize = new SummarizeStrategy(provider, { ratio: opts?.summarizeRatio });
    this._lowThreshold = opts?.thresholds?.lowTrust ?? 0.3;
    this._highThreshold = opts?.thresholds?.highTrust ?? 0.7;
  }

  select(layers: ReadonlyArray<LayerSnapshot>, budget: number): CompactionPlan {
    const totalTokens = layers.reduce((sum, l) => sum + l.tokens, 0);
    const overage = totalTokens - budget;
    if (overage <= 0) return { targets: [], evict: [], estimatedSavings: 0 };

    const low = layers.filter((l) => l.trust < this._lowThreshold);
    const mid = layers.filter((l) => l.trust >= this._lowThreshold && l.trust < this._highThreshold);
    const high = layers.filter((l) => l.trust >= this._highThreshold);

    const lowPlan = this._trustBased.select(low, budget);
    let remaining = overage - lowPlan.estimatedSavings;

    let midPlan: CompactionPlan = { targets: [], evict: [], estimatedSavings: 0 };
    if (remaining > 0) {
      midPlan = this._lru.select(mid, mid.reduce((s, l) => s + l.tokens, 0) - remaining);
      remaining -= midPlan.estimatedSavings;
    }

    let highPlan: CompactionPlan = { targets: [], evict: [], estimatedSavings: 0 };
    if (remaining > 0) {
      highPlan = this._summarize.select(high, high.reduce((s, l) => s + l.tokens, 0) - remaining);
    }

    return {
      targets: [...lowPlan.targets, ...midPlan.targets, ...highPlan.targets],
      evict: [...lowPlan.evict, ...midPlan.evict, ...highPlan.evict],
      estimatedSavings: lowPlan.estimatedSavings + midPlan.estimatedSavings + highPlan.estimatedSavings,
    };
  }

  async compact(content: string, opts: CompactionOpts): Promise<string> {
    return this._summarize.compact(content, opts);
  }

  get strategies() {
    return {
      trustBased: this._trustBased as CompactionStrategy,
      lru: this._lru as CompactionStrategy,
      summarize: this._summarize as CompactionStrategy,
    } as const;
  }
}
