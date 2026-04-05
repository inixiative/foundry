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
  ContextLayer,
  ContextStack,
  Classifier,
  Router,
  Executor,
  Thread,
  Harness,
  EventStream,
  InterventionLog,
  TokenTracker,
  ProjectRegistry,
  type Decision,
  type Classification,
  type Route,
} from "./agents";
import { FileMemory, inlineSource } from "./adapters";
import { AnthropicProvider, OpenAIProvider, GeminiProvider, ClaudeCodeProvider } from "./providers";
import type { LLMProvider, LLMMessage, CompletionResult } from "./providers";
import { startViewer } from "./viewer/server";
import { ConfigStore, type FoundryConfig, type AgentSettingsConfig } from "./viewer/config";
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
      // Uses the claude CLI — no API key needed (subscription auth)
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
  budget: { maxCostUSD: 10.0 },
});

// Wrap provider to track usage
function tracked(p: LLMProvider, agentId: string): typeof p.complete {
  return async (messages: LLMMessage[], opts?: Parameters<typeof p.complete>[1]) => {
    const result = await p.complete(messages, opts);
    if (result.tokens) {
      tokenTracker.record({
        provider: p.id,
        model: result.model || config.defaults.model,
        agentId,
        input: result.tokens.input,
        output: result.tokens.output,
      });
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Memory + sources
// ---------------------------------------------------------------------------

const memory = new FileMemory(`${FOUNDRY_DIR}/memory`);
await memory.load();

console.log(`Memory loaded: ${memory.all().length} entries`);

// ---------------------------------------------------------------------------
// Build context layers
// ---------------------------------------------------------------------------

function buildLayers(config: FoundryConfig): ContextLayer[] {
  const layers: ContextLayer[] = [];

  for (const [id, layerCfg] of Object.entries(config.layers)) {
    if (!layerCfg.enabled) continue;

    // Resolve sources for this layer
    const sources = layerCfg.sourceIds
      .map((srcId) => {
        const srcCfg = config.sources[srcId];
        if (!srcCfg || !srcCfg.enabled) return null;

        switch (srcCfg.type) {
          case "inline":
            return inlineSource(srcCfg.id, srcCfg.uri);
          case "file":
            // Filter by kind based on source naming convention
            if (srcCfg.id.includes("convention")) {
              return memory.asSource(srcCfg.id, "convention");
            }
            return memory.asSource(srcCfg.id);
          default:
            return inlineSource(srcCfg.id, `[${srcCfg.type} source: ${srcCfg.uri}]`);
        }
      })
      .filter(Boolean) as Array<{ id: string; load: () => Promise<string> }>;

    layers.push(
      new ContextLayer({
        id,
        trust: layerCfg.trust * 10, // Config uses 0-1, ContextLayer uses 0-10
        staleness: layerCfg.staleness || undefined,
        maxTokens: layerCfg.maxTokens || undefined,
        sources,
      }),
    );
  }

  // Fallback: if no layers configured, create a basic system layer
  if (layers.length === 0) {
    layers.push(
      new ContextLayer({
        id: "system",
        trust: 10,
        sources: [
          inlineSource("default", "You are a helpful engineering assistant."),
        ],
      }),
    );
  }

  return layers;
}

const layers = buildLayers(config);
const stack = new ContextStack(layers);
await stack.warmAll();

console.log(`Stack: ${stack.layers.length} layers, ~${stack.estimateTokens()} tokens`);

// ---------------------------------------------------------------------------
// Build agents (LLM-powered)
// ---------------------------------------------------------------------------

function llmComplete(agentId: string) {
  return tracked(provider, agentId);
}

// -- Classifier --
const classifierCfg = config.agents["classifier"];
const classifier = new Classifier<string>({
  id: "classifier",
  stack,
  handler: async (ctx, payload) => {
    if (!classifierCfg?.enabled) {
      // Fallback: keyword classification
      return keywordClassify(payload);
    }

    try {
      const complete = llmComplete("classifier");
      const result = await complete(
        [
          { role: "system", content: `${ctx}\n\n${classifierCfg.prompt}` },
          { role: "user", content: payload },
        ],
        { temperature: 0, maxTokens: classifierCfg.maxTokens || 256 },
      );
      const parsed = parseJSON(result.content);
      return {
        value: { category: parsed.category || "general", subcategory: parsed.subcategory },
        confidence: 0.9,
        reasoning: parsed.reasoning || "LLM classification",
      } satisfies Decision<Classification>;
    } catch (err) {
      console.warn("  [classifier] LLM failed, falling back to keywords:", (err as Error).message);
      return keywordClassify(payload);
    }
  },
});

// -- Router --
const routerCfg = config.agents["router"];
const router = new Router<{ payload: string; classification: Classification }>({
  id: "router",
  stack,
  handler: async (ctx, input) => {
    if (!routerCfg?.enabled) {
      return keywordRoute(input.classification);
    }

    try {
      const complete = llmComplete("router");
      const result = await complete(
        [
          { role: "system", content: `${ctx}\n\n${routerCfg.prompt}` },
          {
            role: "user",
            content: `Classification: ${JSON.stringify(input.classification)}\nMessage: ${input.payload}`,
          },
        ],
        { temperature: 0, maxTokens: routerCfg.maxTokens || 256 },
      );
      const parsed = parseJSON(result.content);
      return {
        value: {
          destination: parsed.destination || "executor-answer",
          contextSlice: parsed.contextSlice || layers.map((l) => l.id),
          priority: parsed.priority ?? 5,
        },
        confidence: 0.9,
        reasoning: parsed.reasoning || "LLM routing",
      } satisfies Decision<Route>;
    } catch (err) {
      console.warn("  [router] LLM failed, falling back to rules:", (err as Error).message);
      return keywordRoute(input.classification);
    }
  },
});

// -- Executors --
function createExecutor(id: string): Executor<string, string> {
  const agentCfg = config.agents[id];
  return new Executor<string, string>({
    id,
    stack,
    handler: async (ctx, payload) => {
      const prompt = agentCfg?.prompt || "You are a helpful assistant.";
      try {
        const complete = llmComplete(id);
        const result = await complete(
          [
            { role: "system", content: `${ctx}\n\n${prompt}` },
            { role: "user", content: payload },
          ],
          {
            temperature: agentCfg?.temperature ?? 0,
            maxTokens: agentCfg?.maxTokens ?? config.defaults.maxTokens,
          },
        );
        return result.content;
      } catch (err) {
        return `[${id}] Error: ${(err as Error).message}`;
      }
    },
  });
}

const executorFix = createExecutor("executor-fix");
const executorBuild = createExecutor("executor-build");
const executorAnswer = createExecutor("executor-answer");

// ---------------------------------------------------------------------------
// Thread + harness
// ---------------------------------------------------------------------------

const thread = new Thread("main", stack, {
  description: "Main conversation thread",
  tags: ["production"],
});

thread.register(classifier);
thread.register(router);
thread.register(executorFix);
thread.register(executorBuild);
thread.register(executorAnswer);

// Middleware: log dispatches
thread.middleware.use("logger", async (ctx, next) => {
  const start = performance.now();
  const result = await next();
  const ms = (performance.now() - start).toFixed(1);
  console.log(`  [dispatch] ${ctx.agentId} (${ms}ms)`);
  return result;
});

// Signal bus: write to memory
const signals = thread.signals;
signals.onAny(memory.signalWriter());

const harness = new Harness(thread);
harness.setClassifier("classifier");
harness.setRouter("router");
harness.setDefaultExecutor("executor-answer");

// Load invocation/activation modes from config
harness.loadModes(config.agents, config.layers);

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
});

console.log(`Viewer: http://localhost:${port}`);
console.log(`Provider: ${provider.id} (${config.defaults.model})`);
console.log(`Agents: ${[...thread.agents.keys()].join(", ")}`);
console.log(`Layers: ${stack.layers.map((l) => l.id).join(", ")}`);
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

// ---------------------------------------------------------------------------
// Fallback handlers (no LLM needed)
// ---------------------------------------------------------------------------

function keywordClassify(payload: string): Decision<Classification> {
  const lower = payload.toLowerCase();
  let category = "general";
  if (lower.includes("bug") || lower.includes("fix") || lower.includes("error")) category = "bug";
  else if (lower.includes("feature") || lower.includes("add") || lower.includes("build")) category = "feature";
  else if (lower.includes("refactor") || lower.includes("clean")) category = "refactor";
  else if (lower.includes("question") || lower.includes("how") || lower.includes("why")) category = "question";
  else if (lower.includes("convention") || lower.includes("style")) category = "convention";
  return { value: { category }, confidence: 0.7, reasoning: `keyword: ${category}` };
}

function keywordRoute(classification: Classification): Decision<Route> {
  const routeMap: Record<string, { dest: string; layers: string[] }> = {
    bug: { dest: "executor-fix", layers: layers.map((l) => l.id) },
    feature: { dest: "executor-build", layers: ["system", "conventions"] },
    refactor: { dest: "executor-build", layers: ["system", "conventions"] },
    question: { dest: "executor-answer", layers: ["system", "memory"] },
    convention: { dest: "executor-answer", layers: ["conventions", "memory"] },
    general: { dest: "executor-answer", layers: ["system"] },
  };
  const route = routeMap[classification.category] ?? routeMap.general;
  return {
    value: { destination: route.dest, contextSlice: route.layers, priority: 5 },
    confidence: 0.8,
    reasoning: `rule: ${classification.category} → ${route.dest}`,
  };
}

function parseJSON(text: string): Record<string, unknown> {
  // Try to extract JSON from LLM response (may have markdown fences)
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Try to find first { ... } block
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced) {
      try {
        return JSON.parse(braced[0]);
      } catch {
        /* fall through */
      }
    }
    return { category: "general", reasoning: "parse failure" };
  }
}
