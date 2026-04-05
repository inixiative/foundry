#!/usr/bin/env bun
/**
 * Foundry — production entrypoint.
 *
 * Loads .foundry/settings.json + .env.local, wires up LLM-powered agents,
 * context layers, and the viewer dashboard.
 *
 * Run with: bun run start
 * Open:     http://localhost:${VIEWER_PORT || 4400}
 */

import {
  Harness,
  EventStream,
  InterventionLog,
  TokenTracker,
  ProjectRegistry,
  ThreadFactory,
  ReactiveMiddleware,
  lowConfidenceRule,
  type SourceResolver,
} from "./agents";
import { FileMemory, inlineSource, PostgresMemory } from "./adapters";
import { AnthropicProvider, OpenAIProvider, GeminiProvider, ClaudeCodeProvider } from "./providers";
import type { LLMProvider } from "./providers";
import { startViewer } from "./viewer/server";
import { ConfigStore, type FoundryConfig } from "./viewer/config";
import { existsSync } from "fs";

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

console.log(`Foundry starting — provider: ${config.defaults.provider}, model: ${config.defaults.model}`);

// ---------------------------------------------------------------------------
// Create LLM provider
// ---------------------------------------------------------------------------

function createProvider(config: FoundryConfig): LLMProvider {
  const providerId = config.defaults.provider;

  switch (providerId) {
    case "claude-code": {
      return new ClaudeCodeProvider({
        defaultModel: config.defaults.model,
        defaultMaxTokens: config.defaults.maxTokens,
      });
    }
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        console.error("ANTHROPIC_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return new AnthropicProvider({
        apiKey: key,
        defaultModel: config.defaults.model,
        defaultMaxTokens: config.defaults.maxTokens,
      });
    }
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        console.error("OPENAI_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return new OpenAIProvider({
        apiKey: key,
        defaultModel: config.defaults.model,
      });
    }
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        console.error("GEMINI_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return new GeminiProvider({
        apiKey: key,
        defaultModel: config.defaults.model,
      });
    }
    default:
      console.error(`Unknown provider: ${providerId}`);
      process.exit(1);
  }
}

const provider = createProvider(config);

// ---------------------------------------------------------------------------
// Token tracker
// ---------------------------------------------------------------------------

const tokenTracker = new TokenTracker({
  budget: { maxCost: 10.0 },
});

// ---------------------------------------------------------------------------
// Memory + source resolver
// ---------------------------------------------------------------------------

const memory = new FileMemory(`${FOUNDRY_DIR}/memory`);
await memory.load();

console.log(`Memory loaded: ${memory.all().length} entries`);

/**
 * Source resolver — turns config source IDs into ContextSources.
 * This is the bridge between config (source IDs) and runtime (loadable sources).
 */
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
// Thread factory — stamps out threads with independent layer/agent instances
// ---------------------------------------------------------------------------

const factory = new ThreadFactory({
  provider,
  tokenTracker,
  sourceResolver,
});

// ---------------------------------------------------------------------------
// Create main thread via factory
// ---------------------------------------------------------------------------

const { thread, stack } = await factory.create("main", config, {
  description: "Main conversation thread",
  tags: ["production"],
});

// Signal bus: write to file memory
const signals = thread.signals;
signals.onAny(memory.signalWriter());

// Wire reactive middleware — dynamic behavior during runs
const reactive = new ReactiveMiddleware({
  stack,
  signals,
  threadId: "main",
});

// Built-in rule: flag low-confidence results in RunContext
reactive.addRule(lowConfidenceRule(0.5));

thread.middleware.use("reactive", reactive.asMiddleware());

// Build harness
const harness = new Harness(thread);

// Auto-detect classifier/router/executor from config agent kinds
for (const [id, agentCfg] of Object.entries(config.agents)) {
  if (!agentCfg.enabled) continue;
  if (agentCfg.kind === "classifier") harness.setClassifier(id);
  else if (agentCfg.kind === "router") harness.setRouter(id);
}
harness.setDefaultExecutor(
  Object.entries(config.agents).find(([_, a]) => a.kind === "executor" && a.enabled)?.[0]
  ?? "executor-answer"
);

// Load invocation/activation modes from config
harness.loadModes(config.agents, config.layers);

// ---------------------------------------------------------------------------
// Postgres persistence (optional — requires DATABASE_URL)
// ---------------------------------------------------------------------------

let pgMemory: PostgresMemory | undefined;

if (process.env.DATABASE_URL) {
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    pgMemory = new PostgresMemory(prisma);
    // Wire signal persistence to postgres
    signals.onAny(pgMemory.signalWriter());
    console.log(`Postgres: connected (${process.env.DATABASE_URL.replace(/\/\/.*@/, "//***@")})`);
  } catch (err) {
    console.warn(`Postgres: unavailable (${(err as Error).message}). Running in-memory only.`);
  }
}

// ---------------------------------------------------------------------------
// Event stream + viewer
// ---------------------------------------------------------------------------

const eventStream = new EventStream();

thread.lifecycle.on("layer:warm", async (event) => {
  eventStream.push({ kind: "layer", threadId: thread.id, event });
});
thread.lifecycle.on("layer:stale", async (event) => {
  eventStream.push({ kind: "layer", threadId: thread.id, event });
});
signals.onAny(async (signal) => {
  eventStream.push({ kind: "signal", threadId: thread.id, signal });
});

thread.start();

const interventions = new InterventionLog(signals);

// -- Project registry --
const projectRegistry = new ProjectRegistry();

// Load projects from config and register them
if (config.projects) {
  projectRegistry.loadFromConfigs(config.projects);
  console.log(`Projects: ${[...projectRegistry.all.keys()].join(", ") || "(none)"}`);
}

const port = parseInt(process.env.VIEWER_PORT || "4400");

startViewer({
  harness,
  eventStream,
  interventions,
  port,
  assistProvider: provider,
  assistModel: config.defaults.model,
  tokenTracker,
  analyticsDir: `${FOUNDRY_DIR}/analytics`,
  projectRegistry,
  db: pgMemory,
  threadFactory: factory,
  configStore,
});

console.log(`Viewer: http://localhost:${port}`);
console.log(`Provider: ${provider.id} (${config.defaults.model})`);
console.log(`Agents: ${[...thread.agents.keys()].join(", ")}`);
console.log(`Layers: ${stack.layers.map((l) => l.id).join(", ")}`);
console.log(`Persistence: ${pgMemory ? "postgres" : "in-memory only"}`);
console.log();
console.log("Ready. Send messages through the harness API or viewer.");

// ---------------------------------------------------------------------------
// Keep alive
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  thread.stop();
  process.exit(0);
});
