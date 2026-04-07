#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Research CLI — run experiments to find optimal agent configurations
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import type { LLMProvider } from "@inixiative/foundry-core";
import { ConfigStore, type FoundryConfig } from "../viewer/config";
import { AnthropicProvider, OpenAIProvider, GeminiProvider, ClaudeCodeProvider } from "../providers";
import { FileMemory, inlineSource } from "../adapters";
import type { SourceResolver } from "../agents/thread-factory";
import { ExperimentRunner, type ProviderFactory } from "./runner";
import { modelSweep, temperatureSweep, manual } from "./config-gen";
import { getAllFixtures } from "./fixtures";
import { writeReport } from "./report";
import type { ConfigVariation, ExperimentConfig } from "./types";
import { DEFAULT_EXPERIMENT_CONFIG } from "./types";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const found = args.find((a) => a.startsWith(flag));
  return found ? found.slice(flag.length) : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const phase = parseInt(getArg("phase") || "1");
const reps = parseInt(getArg("reps") || "3");
const maxCost = parseFloat(getArg("max-cost") || "10.0");
const concurrency = parseInt(getArg("concurrency") || "1");
const delayMs = parseInt(getArg("delay") || "500");
const fixtureDir = getArg("fixtures");
const variationsFile = getArg("config");

if (hasFlag("help")) {
  console.log(`
Foundry Research — find optimal agent configurations

Usage:
  bun run research                     Run Phase 1 model sweep
  bun run research --phase=2           Run Phase 2 temperature sweep (uses Phase 1 results)
  bun run research --phase=3           Run Phase 3 best composite (uses Phase 1+2 results)

Options:
  --phase=N          Sweep phase: 1 (models), 2 (temperature), 3 (composite)
  --reps=N           Repetitions per fixture per config (default: 3)
  --max-cost=N       Budget cap in dollars (default: 10.00)
  --concurrency=N    Max parallel API calls (default: 1)
  --delay=N          Delay between calls in ms (default: 500)
  --fixtures=DIR     Custom fixture directory (JSON files)
  --config=FILE      Custom config variations JSON file
  --help             Show this help
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const FOUNDRY_DIR = ".foundry";

if (!existsSync(`${FOUNDRY_DIR}/settings.json`)) {
  console.error("No .foundry/settings.json found. Run `bun run setup` first.");
  process.exit(1);
}

const configStore = new ConfigStore(FOUNDRY_DIR);
const config = await configStore.load();

console.log(`Research starting — base provider: ${config.defaults.provider}, model: ${config.defaults.model}`);

// ---------------------------------------------------------------------------
// Provider factory — creates provider instances by ID
// ---------------------------------------------------------------------------

function createProvider(providerId: string, cfg: FoundryConfig): LLMProvider {
  switch (providerId) {
    case "claude-code":
      return new ClaudeCodeProvider({
        defaultModel: cfg.defaults.model,
        defaultMaxTokens: cfg.defaults.maxTokens,
      });
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");
      return new AnthropicProvider({ apiKey: key, defaultModel: cfg.defaults.model });
    }
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      return new OpenAIProvider({ apiKey: key, defaultModel: cfg.defaults.model });
    }
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY not set");
      return new GeminiProvider({ apiKey: key, defaultModel: cfg.defaults.model });
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

const providerFactory: ProviderFactory = createProvider;

// Judge uses cheapest available provider
const judgeProvider = createProvider(
  process.env.ANTHROPIC_API_KEY ? "anthropic" : config.defaults.provider,
  config,
);

// ---------------------------------------------------------------------------
// Memory + source resolver
// ---------------------------------------------------------------------------

const memory = new FileMemory(`${FOUNDRY_DIR}/memory`);
await memory.load();

const sourceResolver: SourceResolver = (sourceId, cfg) => {
  const srcCfg = cfg.sources[sourceId];
  if (!srcCfg || !srcCfg.enabled) return null;
  switch (srcCfg.type) {
    case "inline":
      return inlineSource(srcCfg.id, srcCfg.uri);
    case "file":
      if (srcCfg.id.includes("convention")) {
        return memory.asSource(srcCfg.id, "convention");
      }
      return memory.asSource(srcCfg.id);
    default:
      return inlineSource(srcCfg.id, `[${srcCfg.type} source: ${srcCfg.uri}]`);
  }
};

// ---------------------------------------------------------------------------
// Build fixtures
// ---------------------------------------------------------------------------

const customFixtureDir = fixtureDir || `${FOUNDRY_DIR}/research/fixtures`;
const fixtures = getAllFixtures(existsSync(customFixtureDir) ? customFixtureDir : undefined);
console.log(`Fixtures: ${fixtures.length} (${fixtures.map((f) => f.id).join(", ")})`);

// ---------------------------------------------------------------------------
// Build variations
// ---------------------------------------------------------------------------

let variations: ConfigVariation[];

if (variationsFile) {
  // Custom variations from file
  const raw = await Bun.file(variationsFile).json();
  variations = manual(Array.isArray(raw) ? raw : [raw]);
  console.log(`Custom variations: ${variations.length}`);
} else if (phase === 1) {
  variations = modelSweep(config);
  console.log(`Phase 1 (model sweep): ${variations.length} variations`);
} else if (phase === 2) {
  // Load Phase 1 results to get winners
  const resultsDir = `${FOUNDRY_DIR}/research/results`;
  const winners = await loadPhase1Winners(resultsDir);
  if (!winners) {
    console.error("No Phase 1 results found. Run --phase=1 first.");
    process.exit(1);
  }
  variations = temperatureSweep(config, winners);
  console.log(`Phase 2 (temperature sweep): ${variations.length} variations`);
} else if (phase === 3) {
  console.error("Phase 3 (composite) requires manual config. Use --config=file.json");
  process.exit(1);
} else {
  console.error(`Unknown phase: ${phase}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Run experiment
// ---------------------------------------------------------------------------

const experimentConfig: Partial<ExperimentConfig> = {
  repetitions: reps,
  concurrency,
  delayMs,
  maxCost,
  judgeModel: "claude-haiku-4-5-20251001",
};

const runner = new ExperimentRunner({
  baseConfig: config,
  providerFactory,
  judgeProvider,
  experimentConfig,
  sourceResolver,
  onProgress: (msg) => console.log(msg),
});

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log("\nAborting experiment...");
  runner.abort();
});

console.log(`\nStarting experiment (${variations.length} configs × ${fixtures.length} fixtures × ${reps} reps = ${variations.length * fixtures.length * reps} runs)`);
console.log(`Budget: $${maxCost.toFixed(2)}, Concurrency: ${concurrency}, Delay: ${delayMs}ms\n`);

const report = await runner.run(variations, fixtures);

// ---------------------------------------------------------------------------
// Write results
// ---------------------------------------------------------------------------

const resultsDir = `${FOUNDRY_DIR}/research/results`;
const { jsonPath, mdPath } = await writeReport(report, resultsDir);

console.log(`\n${"=".repeat(60)}`);
console.log(`EXPERIMENT COMPLETE`);
console.log(`${"=".repeat(60)}`);
console.log(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
console.log(`Configs tested: ${report.configs.length}`);
console.log(`Total cost: $${report.totalCost.toFixed(4)}`);
console.log(`Total tokens: ${report.totalTokens.toLocaleString()}`);
console.log();

// Print top 5
console.log("Top configs:");
for (const entry of report.ranking.slice(0, 5)) {
  const cfg = report.configs.find((c) => c.configId === entry.configId);
  if (!cfg) continue;
  console.log(`  #${entry.rank} ${cfg.description} — score: ${entry.compositeScore.toFixed(3)}, quality: ${cfg.overallQualityMean.toFixed(1)}/10, class: ${(cfg.overallClassificationAccuracy * 100).toFixed(0)}%, p50: ${(cfg.overallLatencyP50 / 1000).toFixed(1)}s`);
}

console.log(`\nFull report: ${mdPath}`);
console.log(`Raw data: ${jsonPath}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadPhase1Winners(
  resultsDir: string,
): Promise<Record<string, { model?: string; provider?: string }> | null> {
  if (!existsSync(resultsDir)) return null;

  // Find most recent experiment report
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(resultsDir)
    .filter((f: string) => f.endsWith(".json") && f.startsWith("exp_"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const report = await Bun.file(`${resultsDir}/${files[0]}`).json();

  // Extract best config per agent role from the ranking
  const winners: Record<string, { model?: string; provider?: string }> = {};
  const best = report.ranking?.[0];
  if (!best) return null;

  const bestConfig = report.configs?.find((c: any) => c.configId === best.configId);
  if (bestConfig) {
    // Parse the configId to extract agent and model info
    // Format: "agentId-modelLabel" from modelSweep
    const parts = bestConfig.configId.split("-");
    if (parts.length >= 2) {
      const agentId = parts[0];
      winners[agentId] = {};
    }
  }

  // Return at least the baseline agents with their current models
  for (const [id, agent] of Object.entries(report.baseConfig?.agents || {})) {
    const a = agent as any;
    if (a.enabled) {
      winners[id] = { model: a.model, provider: a.provider };
    }
  }

  return winners;
}
