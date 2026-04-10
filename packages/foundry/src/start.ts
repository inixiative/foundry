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
  ActionQueue,
  CapabilityGate,
  SUPERVISED_POLICY,
  UNATTENDED_POLICY,
  ProjectRegistry,
  ThreadFactory,
  ReactiveMiddleware,
  lowConfidenceRule,
  Librarian,
  Cartographer,
  DomainLibrarian,
  FlowOrchestrator,
  type SourceResolver,
} from "./agents";
import { ToolRegistry } from "@inixiative/foundry-core";
import { FileMemory, inlineSource, PostgresMemory } from "./adapters";
import { MemoryToolAdapter } from "./tools/memory-adapter";
import { BashShell } from "./tools/bash-shell";
import { BunScript } from "./tools/bun-script";
import { rtk as rtkFilter } from "./tools/output-filters";
import { AnthropicProvider, OpenAIProvider, GeminiProvider, ClaudeCodeProvider, GatedProvider } from "./providers";
import type { LLMProvider } from "./providers";
import { startViewer } from "./viewer/server";
import { ConfigStore, starterConfig, type FoundryConfig } from "./viewer/config";
import { createQueue, setQueue, initializeWorker, shutdownWorker } from "./jobs";
import { existsSync, mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// Load config (auto-bootstrap on first run)
// ---------------------------------------------------------------------------

const FOUNDRY_DIR = ".foundry";

const configStore = new ConfigStore(FOUNDRY_DIR);
let config: FoundryConfig;

if (!existsSync(`${FOUNDRY_DIR}/settings.json`)) {
  // First run — generate minimal starter config (providers + defaults only)
  console.log("No config found — generating starter config...");
  config = starterConfig("claude-code", "sonnet");
  await configStore.save(config);

  // Ensure directories exist
  mkdirSync(`${FOUNDRY_DIR}/memory`, { recursive: true });
  mkdirSync(`${FOUNDRY_DIR}/analytics`, { recursive: true });

  console.log("Starter config generated — setup wizard will open in the viewer.");
} else {
  config = await configStore.load();
}

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

const rawProvider = createProvider(config);

// ---------------------------------------------------------------------------
// Capability gate + action queue
// ---------------------------------------------------------------------------

const actionQueue = new ActionQueue();

const supervised = (process.env.FOUNDRY_MODE || "supervised") === "supervised";
const gate = new CapabilityGate(supervised ? SUPERVISED_POLICY : UNATTENDED_POLICY, actionQueue);

const provider: LLMProvider = supervised
  ? new GatedProvider({ provider: rawProvider, gate, threadId: "main" })
  : rawProvider;

console.log(`Mode: ${supervised ? "supervised" : "unattended"} (${supervised ? "writes prompt for approval" : "auto-allow all"})`);

// ---------------------------------------------------------------------------
// Token tracker
// ---------------------------------------------------------------------------

const maxCost = parseFloat(process.env.FOUNDRY_MAX_COST || "") || (config as any).budget?.maxCost || 10.0;
const tokenTracker = new TokenTracker({
  budget: { maxCost },
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
// Tool registry — agents discover and use registered tools during execution
// ---------------------------------------------------------------------------

const tools = new ToolRegistry();

// Memory as a queryable tool (agents search on demand, not just passive layers)
const memoryTool = MemoryToolAdapter.fromFileMemory(memory);
tools.register(memoryTool, "Project memory — search conventions, signals, learnings");

// Real shell — executes against the actual filesystem with RTK output filtering
const shellTool = new BashShell({
  cwd: process.cwd(),
  outputFilter: rtkFilter,
});
tools.register(shellTool, "Execute shell commands — file I/O, git, tests, builds");

// TypeScript execution environment (Bun subprocess isolation)
const scriptTool = new BunScript({ timeout: 15_000 });
tools.register(scriptTool, "Execute TypeScript/JS in isolated Bun subprocess");

// Tools log deferred until after optional Postgres/Redis registration

// ---------------------------------------------------------------------------
// Thread factory — stamps out threads with independent layer/agent instances
// ---------------------------------------------------------------------------

const factory = new ThreadFactory({
  provider,
  tokenTracker,
  sourceResolver,
  tools,
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
});

// Built-in rule: emit signal on low-confidence results (Librarian reconciles)
reactive.addRule(lowConfidenceRule(0.5));

thread.middleware.use("reactive", reactive.asMiddleware());

// ---------------------------------------------------------------------------
// Flow Orchestrator — pre-message context routing + post-action guard checks
// ---------------------------------------------------------------------------

// Lightweight LLM for Cartographer and domain librarians (cheap, fast, no tools)
const flowLlm = (() => {
  // Prefer Gemini Flash for lightweight agents — cheapest option
  if (config.providers.gemini?.enabled && process.env.GEMINI_API_KEY) {
    return new GeminiProvider({
      apiKey: process.env.GEMINI_API_KEY,
      defaultModel: "gemini-3.1-flash-lite-preview",
    });
  }
  // Fall back to the default provider
  return rawProvider;
})();

// Librarian — sole writer to thread-state layer, signal reconciler
const librarian = new Librarian({
  signals,
  stack,
});

// Cartographer — context routing, reads topology map, routes context slices
const cartographer = new Cartographer({
  stack,
  signals,
  llm: flowLlm,
  llmOpts: { maxTokens: 256, temperature: 0 },
});

// Build initial topology map
cartographer.buildMap();

// Domain Librarians — one per domain, advise + guard
const domainLibrarians = new Map<string, DomainLibrarian>();

const domainConfigs: Array<{
  domain: string;
  layerId: string;
  guardTriggers: string[];
  advisePrompt?: string;
  guardPrompt?: string;
  programmaticGuard?: boolean;
}> = [
  {
    domain: "docs",
    layerId: "docs",
    guardTriggers: ["file_write", "Write"],
  },
  {
    domain: "conventions",
    layerId: "conventions",
    guardTriggers: ["file_write", "Write", "Edit"],
  },
  {
    domain: "security",
    layerId: "security",
    guardTriggers: ["file_write", "Write", "Edit", "Bash", "bash"],
  },
  {
    domain: "architecture",
    layerId: "architecture",
    guardTriggers: ["file_write", "Write"],
  },
  {
    domain: "memory",
    layerId: "memory",
    guardTriggers: [],
    programmaticGuard: true,
  },
];

for (const dc of domainConfigs) {
  const cacheLayer = stack.getLayer(dc.layerId);
  if (!cacheLayer) continue; // Layer not configured — skip this domain

  const domLib = new DomainLibrarian({
    domain: dc.domain,
    cache: cacheLayer,
    signals,
    llm: flowLlm,
    llmOpts: { maxTokens: 512, temperature: 0 },
    guardTriggers: dc.guardTriggers,
    advisePrompt: dc.advisePrompt,
    guardPrompt: dc.guardPrompt,
    programmaticGuard: dc.programmaticGuard,
  });
  domainLibrarians.set(dc.domain, domLib);
}

// Wire the FlowOrchestrator
const flowOrchestrator = new FlowOrchestrator({
  cartographer,
  domainLibrarians,
  librarian,
  stack,
  signals,
});

// Pre-message middleware: run context routing before execution
thread.middleware.use("flow-pre-message", async (ctx, next) => {
  // Only run pre-message for the executor (the Artificer)
  const agentCfg = config.agents[ctx.agentId];
  if (agentCfg?.kind !== "executor") return next();

  try {
    const plan = await flowOrchestrator.preMessage(ctx.payload as string);
    if (plan.layers.length > 0) {
      // Hydrate the planned layers so they're warm for the executor
      await flowOrchestrator.hydrate(plan);
      console.log(`  [flow] pre-message: ${plan.domainsConsulted.join(", ")} → ${plan.layers.length} layers (${plan.elapsed}ms)`);
    }
  } catch (err) {
    console.warn(`  [flow] pre-message failed:`, (err as Error).message);
  }

  return next();
});

// Post-action: listen for tool observation signals and run guard checks
signals.onAny(async (signal) => {
  if (signal.kind !== "tool_observation") return;
  if (signal.source === "flow-orchestrator") return; // Don't re-process our own signals

  const content = signal.content as any;
  if (!content?.tool) return;

  try {
    const report = await flowOrchestrator.postAction({
      tool: content.tool,
      input: content.input ?? {},
      output: content.output,
      filesAffected: content.filesAffected,
    });

    if (report.critical.length > 0) {
      console.warn(`  [flow] CRITICAL findings (${report.domainsChecked.join(", ")}):`);
      for (const f of report.critical) {
        console.warn(`    ⚠ ${f.description}${f.location ? ` at ${f.location}` : ""}`);
      }
    } else if (report.findings.length > 0) {
      console.log(`  [flow] guard: ${report.findings.length} advisory findings from ${report.domainsChecked.join(", ")} (${report.elapsed}ms)`);
    }
  } catch (err) {
    console.warn(`  [flow] post-action failed:`, (err as Error).message);
  }
});

console.log(`Flow: Cartographer + ${domainLibrarians.size} domain librarians + Librarian (${flowLlm.id})`);

// ---------------------------------------------------------------------------
// Build harness
// ---------------------------------------------------------------------------

const harness = new Harness(thread);

// Auto-detect classifier/router/executor from config agent kinds
for (const [id, agentCfg] of Object.entries(config.agents)) {
  if (!agentCfg.enabled) continue;
  if (agentCfg.kind === "classifier") harness.setClassifier(id);
  else if (agentCfg.kind === "router") harness.setRouter(id);
}
harness.setDefaultExecutor(
  Object.entries(config.agents).find(([_, a]) => a.kind === "executor" && a.enabled)?.[0]
  ?? "artificer"
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
    // Also register as a queryable tool for agents
    const pgTool = MemoryToolAdapter.from("postgres", {
      write: (e) => pgMemory!.writeEntry(e),
      get: (id) => pgMemory!.getEntry(id).then((r) => r ? { id: r.id, kind: r.kind, content: r.content, timestamp: r.timestamp?.getTime?.() ?? Date.now(), meta: r.meta as any } : undefined),
      search: (q, limit) => pgMemory!.searchEntries(q, limit).then((rows) => rows.map((r: any) => ({ id: r.id, kind: r.kind, content: r.content, timestamp: r.timestamp?.getTime?.() ?? Date.now(), meta: r.meta }))),
      recent: (limit, kind) => pgMemory!.recentEntries(limit, kind).then((rows) => rows.map((r: any) => ({ id: r.id, kind: r.kind, content: r.content, timestamp: r.timestamp?.getTime?.() ?? Date.now(), meta: r.meta }))),
      delete: (id) => pgMemory!.deleteEntry(id),
    });
    tools.register(pgTool, "Persistent memory — postgres-backed signals, threads, history");
    console.log(`Postgres: connected (${process.env.DATABASE_URL.replace(/\/\/.*@/, "//***@")})`);
  } catch (err) {
    console.warn(`Postgres: unavailable (${(err as Error).message}). Running in-memory only.`);
  }
}

// ---------------------------------------------------------------------------
// MuninnDB neural memory (optional — requires MUNINN_URL)
// ---------------------------------------------------------------------------

if (process.env.MUNINN_URL) {
  try {
    const { MuninnMemory } = await import("./adapters/muninn-memory");
    const muninn = new MuninnMemory({
      baseUrl: process.env.MUNINN_URL,
      vault: process.env.MUNINN_VAULT ?? "foundry",
      token: process.env.MUNINN_TOKEN,
    });

    // Wire signal persistence to MuninnDB
    signals.onAny(muninn.signalWriter());

    // Register as queryable tool for agents
    const muninnTool = MemoryToolAdapter.fromMuninnMemory(muninn);
    tools.register(muninnTool, "Neural memory — MuninnDB with decay, strengthening, associations");

    console.log(`MuninnDB: connected (${process.env.MUNINN_URL})`);
  } catch (err) {
    console.warn(`MuninnDB: unavailable (${(err as Error).message}). Running without neural memory.`);
  }
}

// ---------------------------------------------------------------------------
// BullMQ job queue (optional — requires REDIS_URL)
// ---------------------------------------------------------------------------

const redisUrl = process.env.REDIS_URL;
if (redisUrl && pgMemory) {
  try {
    const queue = createQueue(redisUrl);
    setQueue(queue);

    // Registry of live stacks for in-process jobs (warmLayers, etc.)
    const liveStacks = new Map<string, typeof stack>();
    liveStacks.set("main", stack);

    await initializeWorker({
      queue,
      redisUrl,
      db: pgMemory,
      concurrency: 10,
      stacks: liveStacks,
    });

    // Wire signal persistence through the job queue instead of direct DB writes
    // (The direct pgMemory.signalWriter() above is kept as a fast-path fallback)
    console.log(`Jobs: BullMQ connected (${redisUrl.replace(/\/\/.*@/, "//***@")})`);
  } catch (err) {
    console.warn(`Jobs: BullMQ unavailable (${(err as Error).message}). Persistence via direct DB writes.`);
  }
} else if (redisUrl && !pgMemory) {
  console.log("Jobs: Redis available but no database — skipping worker (no persistence target)");
} else {
  console.log("Jobs: No REDIS_URL — persistence via direct DB writes");
}

console.log(`Tools: ${tools.list().map((t) => t.id).join(", ")}`);

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
  actionQueue,
});

console.log(`Viewer: http://localhost:${port}`);
console.log(`Provider: ${provider.id} (${config.defaults.model})`);
console.log(`Agents: ${[...thread.agents.keys()].join(", ")}`);
console.log(`Layers: ${stack.layers.map((l) => l.id).join(", ")}`);
console.log(`Persistence: ${pgMemory ? "postgres" : "in-memory only"}${process.env.MUNINN_URL ? " + muninn" : ""}`);
console.log();

// ---------------------------------------------------------------------------
// Startup self-test — verify the LLM provider actually works
// ---------------------------------------------------------------------------

async function selfTest() {
  console.log("Running provider self-test...");
  try {
    const result = await rawProvider.complete(
      [{ role: "user", content: "Respond with exactly: FOUNDRY_OK" }],
      { maxTokens: 32 },
    );
    if (result.content.includes("FOUNDRY_OK")) {
      console.log(`Self-test: PASSED (${config.defaults.provider}/${config.defaults.model})`);
    } else {
      console.warn(`Self-test: provider responded but unexpected output: "${result.content.slice(0, 60)}"`);
    }
  } catch (err) {
    console.error(`Self-test: FAILED — ${(err as Error).message}`);
    console.error("The viewer will still start, but LLM calls will fail.");
    console.error("Check: is Claude Code logged in? Run 'claude' interactively to verify.");
  }
}

await selfTest();

console.log();
console.log("Ready. Send messages through the harness API or viewer.");

// ---------------------------------------------------------------------------
// Keep alive
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  flowOrchestrator.dispose();
  cartographer.dispose();
  librarian.dispose();
  thread.stop();
  await shutdownWorker();
  process.exit(0);
});
