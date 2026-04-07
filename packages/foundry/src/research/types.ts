// ---------------------------------------------------------------------------
// Auto-Research Types — experiment definitions, results, and reports
// ---------------------------------------------------------------------------

import type { AgentSettingsConfig, LayerSettingsConfig, FoundryConfig } from "../viewer/config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A single test input with evaluation criteria. */
export interface Fixture {
  readonly id: string;
  readonly description: string;
  /** The user message to send through the pipeline. */
  readonly input: string;
  /** Expected classification category (for correctness scoring). */
  readonly expectedCategory: string;
  /** Expected route destination (for correctness scoring). */
  readonly expectedRoute: string;
  /** Rubric for judging executor output quality (free text for LLM judge). */
  readonly qualityRubric: string;
  /** Tags for filtering/grouping fixtures. */
  readonly tags?: string[];
}

// ---------------------------------------------------------------------------
// Config variations
// ---------------------------------------------------------------------------

/** A parameter variation to test. */
export interface ConfigVariation {
  readonly id: string;
  readonly description: string;
  /** Agent-level overrides: which agents get which settings. */
  readonly agentOverrides: Record<string, Partial<AgentSettingsConfig>>;
  /** Layer-level overrides (optional). */
  readonly layerOverrides?: Record<string, Partial<LayerSettingsConfig>>;
  /** Global default overrides (optional). */
  readonly defaultOverrides?: Partial<FoundryConfig["defaults"]>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Result of running one fixture through one config once. */
export interface SingleRunResult {
  readonly fixtureId: string;
  readonly configId: string;
  readonly runIndex: number;
  readonly classification: {
    readonly category: string;
    readonly expected: string;
    readonly correct: boolean;
  };
  readonly route: {
    readonly destination: string;
    readonly expected: string;
    readonly correct: boolean;
  };
  readonly output: string;
  readonly qualityScore: number;
  readonly qualityReasoning: string;
  readonly latencyMs: number;
  readonly latencyBreakdown: Record<string, number>;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly estimatedCost: number;
  readonly error?: string;
  readonly timestamp: number;
}

/** Aggregated result for one fixture across all runs of one config. */
export interface FixtureResult {
  readonly fixtureId: string;
  readonly configId: string;
  readonly runs: SingleRunResult[];
  readonly classificationAccuracy: number;
  readonly routeAccuracy: number;
  readonly qualityMean: number;
  readonly qualityStdDev: number;
  readonly latencyP50: number;
  readonly latencyP95: number;
  readonly totalTokens: number;
  readonly totalCost: number;
}

/** Aggregated result for one config across all fixtures. */
export interface ConfigResult {
  readonly configId: string;
  readonly description: string;
  readonly fixtures: FixtureResult[];
  readonly overallClassificationAccuracy: number;
  readonly overallRouteAccuracy: number;
  readonly overallQualityMean: number;
  readonly overallLatencyP50: number;
  readonly overallLatencyP95: number;
  readonly totalTokens: number;
  readonly totalCost: number;
  readonly compositeScore: number;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Full experiment output. */
export interface ExperimentReport {
  readonly id: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly baseConfig: FoundryConfig;
  readonly fixtures: Fixture[];
  readonly configs: ConfigResult[];
  readonly ranking: Array<{
    readonly configId: string;
    readonly compositeScore: number;
    readonly rank: number;
  }>;
  readonly weights: CompositeWeights;
  readonly totalCost: number;
  readonly totalTokens: number;
}

/** Weights for composite scoring. */
export interface CompositeWeights {
  readonly quality: number;
  readonly correctness: number;
  readonly cost: number;
  readonly latency: number;
}

/** Top-level experiment configuration. */
export interface ExperimentConfig {
  /** How many times to run each fixture per config. */
  readonly repetitions: number;
  /** Max concurrent harness sends (rate limit protection). */
  readonly concurrency: number;
  /** Delay between sends in ms (rate limit protection). */
  readonly delayMs: number;
  /** Composite score weights. */
  readonly weights: CompositeWeights;
  /** Which provider to use for the judge agent. */
  readonly judgeProvider?: string;
  /** Which model to use for the judge agent. */
  readonly judgeModel?: string;
  /** Budget cap for the entire experiment in dollars. */
  readonly maxCost?: number;
}

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  repetitions: 3,
  concurrency: 1,
  delayMs: 500,
  weights: { quality: 0.4, correctness: 0.2, cost: 0.2, latency: 0.2 },
  maxCost: 10.0,
};
