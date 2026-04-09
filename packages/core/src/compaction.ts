import type { LayerState } from "./context-layer";

// ---------------------------------------------------------------------------
// Core interfaces — no behavioral opinions
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
 * Minimal interface for LLM calls used by summarize-based strategies.
 * Intentionally narrow — callers adapt their provider to this shape.
 */
export interface CompactionLLMProvider {
  complete(prompt: string): Promise<string>;
}
