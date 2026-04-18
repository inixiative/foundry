// ---------------------------------------------------------------------------
// ExperimentRunner — orchestrates fixtures × configs × repetitions
// ---------------------------------------------------------------------------

import {
  ContextStack,
  Harness,
  TokenTracker,
  BudgetExceededError,
  type LLMProvider,
} from "@inixiative/foundry-core";
import { ThreadFactory, buildLayers, buildAgents, type SourceResolver } from "../agents/thread-factory";
import { inlineSource } from "../adapters";
import type { FoundryConfig } from "../viewer/config";
import { applyVariation } from "./config-gen";
import { Judge } from "./judge";
import type {
  Fixture,
  ConfigVariation,
  SingleRunResult,
  FixtureResult,
  ConfigResult,
  ExperimentReport,
  ExperimentConfig,
  CompositeWeights,
} from "./types";
import { DEFAULT_EXPERIMENT_CONFIG } from "./types";

// ---------------------------------------------------------------------------
// Provider registry — creates provider instances per provider ID
// ---------------------------------------------------------------------------

export type ProviderFactory = (providerId: string, config: FoundryConfig) => LLMProvider;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  /** Base config to clone and vary. */
  baseConfig: FoundryConfig;
  /** Creates LLM provider instances by provider ID. */
  providerFactory: ProviderFactory;
  /** Provider for the judge (can be same as main). */
  judgeProvider: LLMProvider;
  /** Experiment settings. */
  experimentConfig?: Partial<ExperimentConfig>;
  /** Source resolver for building context layers. */
  sourceResolver: SourceResolver;
  /** Optional progress callback. */
  onProgress?: (msg: string) => void;
}

export class ExperimentRunner {
  private _deps: RunnerDeps;
  private _config: ExperimentConfig;
  private _judge: Judge;
  private _aborted = false;

  constructor(deps: RunnerDeps) {
    this._deps = deps;
    this._config = { ...DEFAULT_EXPERIMENT_CONFIG, ...deps.experimentConfig };
    this._judge = new Judge({
      provider: deps.judgeProvider,
      model: this._config.judgeModel,
    });
  }

  /** Run the full experiment: all variations × all fixtures × repetitions. */
  async run(
    variations: ConfigVariation[],
    fixtures: Fixture[],
  ): Promise<ExperimentReport> {
    const startedAt = Date.now();
    const totalRuns = variations.length * fixtures.length * this._config.repetitions;
    let completedRuns = 0;

    this._log(`Starting experiment: ${variations.length} configs × ${fixtures.length} fixtures × ${this._config.repetitions} reps = ${totalRuns} runs`);

    const experimentTracker = new TokenTracker({
      budget: this._config.maxCost ? { maxCost: this._config.maxCost } : undefined,
    });

    const configResults: ConfigResult[] = [];

    for (const variation of variations) {
      if (this._aborted) break;

      this._log(`\n── Config: ${variation.description} ──`);

      try {
        const result = await this._runVariation(
          variation,
          fixtures,
          experimentTracker,
          () => {
            completedRuns++;
            if (completedRuns % 10 === 0 || completedRuns === totalRuns) {
              this._log(`  Progress: ${completedRuns}/${totalRuns} runs (${((completedRuns / totalRuns) * 100).toFixed(0)}%)`);
            }
          },
        );
        configResults.push(result);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          this._log(`\n⚠ Budget exceeded after ${configResults.length} configs. Stopping.`);
          break;
        }
        this._log(`  Error on config ${variation.id}: ${(err as Error).message}`);
      }
    }

    // Rank by composite score
    const ranked = configResults
      .sort((a, b) => b.compositeScore - a.compositeScore)
      .map((c, i) => ({
        configId: c.configId,
        compositeScore: c.compositeScore,
        rank: i + 1,
      }));

    const summary = experimentTracker.summary();
    const completedAt = Date.now();

    return {
      id: `exp_${startedAt.toString(36)}`,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      baseConfig: this._deps.baseConfig,
      fixtures,
      configs: configResults,
      ranking: ranked,
      weights: this._config.weights,
      totalCost: summary.totalCost,
      totalTokens: summary.totalTokens,
    };
  }

  /** Abort the experiment gracefully. */
  abort(): void {
    this._aborted = true;
  }

  // ---------------------------------------------------------------------------
  // Internal: run one config variation across all fixtures
  // ---------------------------------------------------------------------------

  private async _runVariation(
    variation: ConfigVariation,
    fixtures: Fixture[],
    experimentTracker: TokenTracker,
    onRunComplete: () => void,
  ): Promise<ConfigResult> {
    const varConfig = applyVariation(this._deps.baseConfig, variation);

    // Create provider for this variation's default provider
    const provider = this._deps.providerFactory(
      varConfig.defaults.provider,
      varConfig,
    );

    // Create a per-variation token tracker
    const varTracker = new TokenTracker();

    // Build project state for this variation (skip warming for speed)
    const layers = buildLayers(varConfig, { sourceResolver: this._deps.sourceResolver });
    const stack = new ContextStack(layers);
    const agents = buildAgents(varConfig, stack, { provider, tokenTracker: varTracker });
    const factory = new ThreadFactory({ stack, agents });
    const thread = factory.create(`research-${variation.id}`);

    const harness = new Harness(thread);

    // Wire classifier/router/executor from config
    for (const [id, agentCfg] of Object.entries(varConfig.agents)) {
      if (!agentCfg.enabled) continue;
      if (agentCfg.kind === "classifier") harness.setClassifier(id);
      else if (agentCfg.kind === "router") harness.setRouter(id);
    }
    harness.setDefaultExecutor(
      Object.entries(varConfig.agents).find(([_, a]) => a.kind === "executor" && a.enabled)?.[0]
      ?? "executor-answer",
    );
    harness.loadModes(varConfig.agents, varConfig.layers);

    // Run all fixtures
    const fixtureResults: FixtureResult[] = [];

    for (const fixture of fixtures) {
      if (this._aborted) break;

      const runs: SingleRunResult[] = [];

      for (let rep = 0; rep < this._config.repetitions; rep++) {
        if (this._aborted) break;

        const run = await this._runSingle(harness, fixture, variation.id, rep);
        runs.push(run);

        // Record tokens into experiment-wide tracker
        if (run.tokens.input > 0 || run.tokens.output > 0) {
          experimentTracker.record({
            provider: varConfig.defaults.provider,
            model: varConfig.defaults.model,
            agentId: "research",
            tokens: run.tokens,
          });
        }

        onRunComplete();

        // Inter-request delay
        if (this._config.delayMs > 0) {
          await sleep(this._config.delayMs);
        }
      }

      fixtureResults.push(aggregateFixture(fixture.id, variation.id, runs));
    }

    // Clean up thread
    thread.stop();

    return aggregateConfig(variation.id, variation.description, fixtureResults, this._config.weights);
  }

  // ---------------------------------------------------------------------------
  // Internal: run one fixture once
  // ---------------------------------------------------------------------------

  private async _runSingle(
    harness: Harness,
    fixture: Fixture,
    configId: string,
    runIndex: number,
  ): Promise<SingleRunResult> {
    const startTime = performance.now();

    try {
      const result = await harness.send({
        id: `${fixture.id}-${configId}-${runIndex}`,
        payload: fixture.input,
      });

      const latencyMs = performance.now() - startTime;

      // Extract classification
      const category = result.classification?.value?.category || "unknown";
      const destination = result.route?.value?.destination || "unknown";
      const output = typeof result.result.output === "string"
        ? result.result.output
        : JSON.stringify(result.result.output);

      // Extract timing breakdown from trace
      const latencyBreakdown: Record<string, number> = {};
      for (const stage of result.trace.summary().stages) {
        if (stage.durationMs != null) {
          latencyBreakdown[stage.name] = stage.durationMs;
        }
      }

      // Extract tokens from trace spans
      let totalInput = 0;
      let totalOutput = 0;
      for (const span of result.trace.spans) {
        if (span.tokens) {
          totalInput += span.tokens.input;
          totalOutput += span.tokens.output;
        }
      }

      // Judge quality
      const judgeResult = await this._judge.score(
        fixture.input,
        output,
        fixture.qualityRubric,
      );

      return {
        fixtureId: fixture.id,
        configId,
        runIndex,
        classification: {
          category,
          expected: fixture.expectedCategory,
          correct: category === fixture.expectedCategory,
        },
        route: {
          destination,
          expected: fixture.expectedRoute,
          correct: destination === fixture.expectedRoute,
        },
        output,
        qualityScore: judgeResult.score,
        qualityReasoning: judgeResult.reasoning,
        latencyMs,
        latencyBreakdown,
        tokens: { input: totalInput, output: totalOutput },
        estimatedCost: 0, // computed by tracker
        timestamp: Date.now(),
      };
    } catch (err) {
      return {
        fixtureId: fixture.id,
        configId,
        runIndex,
        classification: { category: "error", expected: fixture.expectedCategory, correct: false },
        route: { destination: "error", expected: fixture.expectedRoute, correct: false },
        output: `Error: ${(err as Error).message}`,
        qualityScore: 0,
        qualityReasoning: `Run failed: ${(err as Error).message}`,
        latencyMs: performance.now() - startTime,
        latencyBreakdown: {},
        tokens: { input: 0, output: 0 },
        estimatedCost: 0,
        error: (err as Error).message,
        timestamp: Date.now(),
      };
    }
  }

  private _log(msg: string): void {
    if (this._deps.onProgress) {
      this._deps.onProgress(msg);
    } else {
      console.log(`[research] ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function aggregateFixture(
  fixtureId: string,
  configId: string,
  runs: SingleRunResult[],
): FixtureResult {
  const classCorrect = runs.filter((r) => r.classification.correct).length;
  const routeCorrect = runs.filter((r) => r.route.correct).length;
  const qualities = runs.map((r) => r.qualityScore);
  const latencies = runs.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    fixtureId,
    configId,
    runs,
    classificationAccuracy: runs.length > 0 ? classCorrect / runs.length : 0,
    routeAccuracy: runs.length > 0 ? routeCorrect / runs.length : 0,
    qualityMean: mean(qualities),
    qualityStdDev: stddev(qualities),
    latencyP50: percentile(latencies, 50),
    latencyP95: percentile(latencies, 95),
    totalTokens: runs.reduce((s, r) => s + r.tokens.input + r.tokens.output, 0),
    totalCost: runs.reduce((s, r) => s + r.estimatedCost, 0),
  };
}

function aggregateConfig(
  configId: string,
  description: string,
  fixtures: FixtureResult[],
  weights: CompositeWeights,
): ConfigResult {
  const allLatencies = fixtures
    .flatMap((f) => f.runs.map((r) => r.latencyMs))
    .sort((a, b) => a - b);

  const classAcc = mean(fixtures.map((f) => f.classificationAccuracy));
  const routeAcc = mean(fixtures.map((f) => f.routeAccuracy));
  const qualityMean = mean(fixtures.map((f) => f.qualityMean));
  const latP50 = percentile(allLatencies, 50);
  const latP95 = percentile(allLatencies, 95);
  const totalTokens = fixtures.reduce((s, f) => s + f.totalTokens, 0);
  const totalCost = fixtures.reduce((s, f) => s + f.totalCost, 0);

  // Composite score: higher is better for quality/correctness, lower is better for cost/latency
  // Normalize each dimension to 0-1 range
  const correctness = (classAcc + routeAcc) / 2;
  const quality = qualityMean / 10; // 0-10 → 0-1
  // Cost/latency: invert so lower = better → higher score
  // Use log scale for latency since differences are often orders of magnitude
  const latencyScore = 1 / (1 + Math.log1p(latP50 / 1000)); // 1s → ~0.59, 5s → ~0.36
  const costScore = totalCost > 0 ? 1 / (1 + totalCost) : 1;

  const compositeScore =
    weights.quality * quality +
    weights.correctness * correctness +
    weights.cost * costScore +
    weights.latency * latencyScore;

  return {
    configId,
    description,
    fixtures,
    overallClassificationAccuracy: classAcc,
    overallRouteAccuracy: routeAcc,
    overallQualityMean: qualityMean,
    overallLatencyP50: latP50,
    overallLatencyP95: latP95,
    totalTokens,
    totalCost,
    compositeScore,
  };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
