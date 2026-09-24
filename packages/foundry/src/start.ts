#!/usr/bin/env bun
import { createSubscriptionDecisions } from "./providers/subscription-decisions";
import { resolveSubscriptionPolicy } from "./providers/subscription-policy";
import { SubscriptionAuthentication } from "./providers/subscription-authentication";
import { nativeTextEnvironment } from "./providers/native-text-environment";
import { createDecisionProvider, DECISION_MODEL } from "./providers/decision-provider";
import { KastleAuthentication } from "./providers/kastle-authentication";
import { NativeAuthentication } from "./providers/native-authentication";
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
  ThreadRuntimeManager,
  DEFAULT_THREAD_DOMAINS,
  buildLayers,
  buildAgents,
  createSourceResolver,
} from "./agents";
import { ContextStack, ToolRegistry, type SignalBus } from "@inixiative/foundry-core";
import { resolveLearningSettings } from "./agents/learning-config";
import { runStartupSelfTest, startupSelfTestEnabled } from "./startup-self-test";
import { FileMemory, PostgresMemory } from "./adapters";
import { MemoryToolAdapter } from "./tools/memory-adapter";
import { registerKastleAccess } from "./tools/kastle-access";
import { BashShell } from "./tools/bash-shell";
import { BunScript } from "./tools/bun-script";
import { rtk as rtkFilter } from "./tools/output-filters";
import {
  AnthropicProvider,
  OpenAIProvider,
  GeminiProvider,
  ClaudeCodeProvider,
  GatedProvider,
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  FileExternalSessionStore,
  SessionBackedProvider,
  type SessionAdapter,
} from "./providers";
import type { LLMProvider } from "./providers";
import { startViewer } from "./viewer/server";
import { RuntimeJobRegistry } from "./providers/runtime-job-handler";
import {
  ConfigStore,
  createProject,
  defaultProjectAgents,
  defaultProjectLayers,
  defaultProjectSources,
  starterConfig,
  type FoundryConfig,
} from "./viewer/config";
import { DOCS_ADVISE_PROMPT } from "./setup/scan-docs";
import { createQueue, setQueue, initializeWorker, shutdownWorker } from "./jobs";
import { existsSync, mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// Load config (auto-bootstrap on first run)
// ---------------------------------------------------------------------------

const FOUNDRY_DIR = ".foundry";
const selfTestRequested = startupSelfTestEnabled(process.env.FOUNDRY_STARTUP_SELF_TEST);

const configStore = new ConfigStore(FOUNDRY_DIR);
let config: FoundryConfig;

function hasEntries(record: Record<string, unknown> | undefined): boolean {
  return !!record && Object.keys(record).length > 0;
}

function ensureRunnableLocalConfig(config: FoundryConfig): boolean {
  let changed = false;
  const projectPath = process.cwd();

  if (!hasEntries(config.agents)) {
    config.agents = defaultProjectAgents(config.defaults.provider, config.defaults.model, config.defaults.classifierProvider, config.defaults.classifierModel);
    changed = true;
  }

  if (!hasEntries(config.layers)) {
    config.layers = defaultProjectLayers();
    changed = true;
  }

  if (!hasEntries(config.sources)) {
    config.sources = defaultProjectSources(projectPath);
    changed = true;
  }

  if (!hasEntries(config.projects)) {
    const project = createProject(projectPath, {
      label: "Foundry",
    });
    config.projects = { [project.id]: project };
    changed = true;
  }

  return changed;
}

if (!existsSync(`${FOUNDRY_DIR}/settings.json`)) {
  // First run — generate a runnable local config.
  console.log("No config found — generating starter config...");
  config = starterConfig("claude-code", "fable");
  ensureRunnableLocalConfig(config);
  await configStore.save(config);

  // Ensure directories exist
  mkdirSync(`${FOUNDRY_DIR}/memory`, { recursive: true });
  mkdirSync(`${FOUNDRY_DIR}/analytics`, { recursive: true });

  console.log("Starter config generated — setup wizard will open in the viewer.");
} else {
  config = await configStore.load();
  if (ensureRunnableLocalConfig(config)) {
    await configStore.save(config);
    console.log("Updated starter config with default local agents, layers, and project.");
  }
}

// Subscription-only unless settings opt in with apiTokens: true. Only the opt-in constructs API providers.
const subscription = resolveSubscriptionPolicy(config, { startup: true });
if (subscription) {
  config = subscription.config;
  console.log(`Subscription-only: worker claude-code (${subscription.worker.profileDirectory}), decisions ${subscription.decision.runtime} ${subscription.policy.model} (${subscription.decision.profileDirectory}); no API providers`);
  if (subscription.rerouted.length) console.log(`Decision roles use subscription decisions: ${subscription.rerouted.join(", ")}`);
}
const decisions = subscription ? createSubscriptionDecisions({ ...subscription.policy, source: subscription.decision }) : undefined;
const flowLlm = decisions?.provider ?? createDecisionProvider(!!config.providers.openai?.enabled, process.env.OPENAI_API_KEY);
const decisionModel = subscription?.policy.model ?? DECISION_MODEL;

console.log(`Foundry starting — provider: ${config.defaults.provider}, model: ${config.defaults.model}`);

// ---------------------------------------------------------------------------
// Compose project identity files (CLAUDE.md, .cursorrules, etc.)
// ---------------------------------------------------------------------------

import { writeComposed, RUNTIME_OUTPUT_FILES } from "./prompts/composer";

for (const project of Object.values(config.projects)) {
  if (!project.prompts || !project.path) continue;
  try {
    const written = await writeComposed(project.path, project.prompts);
    if (written.size > 0) {
      const files = [...written.keys()].map(rt => RUNTIME_OUTPUT_FILES[rt]).join(", ");
      console.log(`Composed identity files for ${project.label || project.id}: ${files}`);
    }
  } catch (err) {
    console.warn(`Failed to compose prompts for ${project.label || project.id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Create LLM provider
// ---------------------------------------------------------------------------

function createProvider(config: FoundryConfig): {
  provider: LLMProvider;
  sessionAdapter?: SessionAdapter;
} {
  const providerId = config.defaults.provider;
  const sessionStore = FileExternalSessionStore.forProject(process.cwd());
  const authentication = subscription ? new SubscriptionAuthentication(`${process.cwd()}/.foundry/runtime-profiles`, subscription.worker) : config.defaults.kastleId || Object.keys(config.kastleAssignments ?? {}).length
    ? new KastleAuthentication({ directory: `${process.cwd()}/.foundry/kastle`, sources: config.kastles ?? [], defaultKastleId: config.defaults.kastleId, assignments: config.kastleAssignments })
    : config.defaults.nativeAuthenticationId || Object.keys(config.nativeAuthenticationSelections ?? {}).length ? new NativeAuthentication({
    directory: `${process.cwd()}/.foundry/runtime-profiles`, sources: config.nativeAuthentication ?? [],
    defaultSourceId: config.defaults.nativeAuthenticationId,
  }) : undefined;
  if (authentication && !["claude-code", "codex"].includes(providerId)) throw Error("Native authentication requires a native runtime provider");
  if (authentication instanceof NativeAuthentication) for (const [threadId, sourceId] of Object.entries(config.nativeAuthenticationSelections ?? {})) authentication.select(threadId, sourceId);
  const selectedAuth = config.nativeAuthentication?.find(source => source.id === config.defaults.nativeAuthenticationId);
  if (!subscription && selectedAuth?.mode === "native-profile" && !(config.providers.openai?.enabled && process.env.OPENAI_API_KEY)) {
    throw Error("A native profile has one refresh owner. Configure the separate OpenAI decision provider or use a gateway authentication source before starting Foundry.");
  }

  switch (providerId) {
    case "claude-code": {
      const sessionAdapter = new ClaudeCodeSessionAdapter({
        contextBudget: config.providers[providerId]?.contextBudget,
        store: sessionStore,
        authentication,
        defaults: {
          model: config.defaults.model,
          ...(subscription ? { spawn: (argv: string[], options: { cwd: string; env: Record<string, string | undefined> }) => Bun.spawn(argv, { ...options, env: nativeTextEnvironment(options.env), stdin: "pipe", stdout: "pipe", stderr: "pipe" }) } : {}),
        },
      });
      return {
        sessionAdapter,
        provider: new SessionBackedProvider({
          id: "claude-code",
          adapter: sessionAdapter,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case "codex": {
      const sessionAdapter = new CodexSessionAdapter({
        store: sessionStore,
        authentication,
        engine: config.defaults.codexEngine,
        defaults: {
          model: config.defaults.model,
          effort: config.defaults.codexEffort,
        },
      });
      return {
        sessionAdapter,
        provider: new SessionBackedProvider({
          id: "codex",
          adapter: sessionAdapter,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        console.error("ANTHROPIC_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return {
        provider: new AnthropicProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case "openai": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        console.error("OPENAI_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return {
        provider: new OpenAIProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        console.error("GEMINI_API_KEY not set. Add it to .env.local or environment.");
        process.exit(1);
      }
      return {
        provider: new GeminiProvider({
          apiKey: key,
          defaultModel: config.defaults.model,
        }),
      };
    }
    default:
      console.error(`Unknown provider: ${providerId}`);
      process.exit(1);
  }
}

const providerSetup = createProvider(config);
const rawProvider = providerSetup.provider;
let sessionAdapter: SessionAdapter | undefined = providerSetup.sessionAdapter;

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

// Source resolver — turns config source IDs into ContextSources. Memory-backed
// sources are scope-aware: the template warms with globally published
// knowledge only, and each thread's clone binds them to that thread.
const sourceResolver = createSourceResolver({ memory, configDir: FOUNDRY_DIR });

// ---------------------------------------------------------------------------
// Tool registry — agents discover and use registered tools during execution
// ---------------------------------------------------------------------------

const tools = new ToolRegistry();
registerKastleAccess(tools, config.kastleAccess);

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
// Build project-scoped layers and agents (shared across all threads)
// ---------------------------------------------------------------------------

// The template stack and agents are the project baseline. They are never
// registered on a thread directly: ThreadFactory clones them per thread so
// each thread owns independent layer and agent instances.
const templateStack = new ContextStack(buildLayers(config, { sourceResolver }));
await templateStack.warmAll();

const templateAgents = buildAgents(config, templateStack, { provider, tokenTracker, tools });

// ---------------------------------------------------------------------------
// Per-thread runtime — Librarian, Cartographer, Wardens, orchestrator, bridges
// ---------------------------------------------------------------------------

const eventStream = new EventStream();

// atlasRoot: first atlas-mapped project (has .atlas/ or MAP.md), else the cwd.
const atlasRoot =
  Object.values(config.projects)
    .map((p) => p.path)
    .filter((p): p is string => !!p)
    .find((p) => existsSync(`${p}/.atlas`) || existsSync(`${p}/MAP.md`)) ??
  (existsSync(".atlas") || existsSync("MAP.md") ? process.cwd() : undefined);

// Every factory-created thread (main included) gets its own Librarian,
// Cartographer, Wardens, FlowOrchestrator, reactive rules, event bridges and
// persistence sinks; archiving the thread disposes them.
const runtimeManager = new ThreadRuntimeManager({
  config,
  llm: flowLlm,
  providers: new Map([[rawProvider.id, rawProvider], ...(!subscription ? [["openai", flowLlm] as const] : []), [flowLlm.id, flowLlm]]),
  // Review uses its explicit phase profile, otherwise the configured flow policy.
  // No provider is constructed and no live binding/settings are changed by this resolver.
  learning: resolveLearningSettings(config.learning, new Map([[rawProvider.id, rawProvider], ...(!subscription ? [["openai", flowLlm] as const] : []), [flowLlm.id, flowLlm]]), flowLlm,
    decisionModel),
  eventStream,
  atlasRoot,
  // Docs warden uses the probe-validated topology-aware prompt from
  // setup/scan-docs.ts (single source of truth for generated configs too).
  legacyDomains: DEFAULT_THREAD_DOMAINS.map((d) =>
    d.domain === "docs" ? { ...d, advisePrompt: DOCS_ADVISE_PROMPT } : d,
  ),
  signalSinks: [memory.signalWriter()],
  // Native session lifecycle (compaction) binds per thread: central session
  // to the thread bus, auxiliaries (classifier/router/cartographer/wardens)
  // to a side bus that never invalidates the central ledger.
  sessionAdapter,
});

const factory = new ThreadFactory({ stack: templateStack, agents: templateAgents, runtime: runtimeManager, nativeTools: tools,
  configuration: { config, layers: { sourceResolver }, agents: { provider, tokenTracker, tools,
    // Preserve the central gate while refusing an unavailable explicit project
    // provider; only these providers have actually been constructed above.
    providers: new Map([...(!subscription ? [["openai", flowLlm] as const] : []), [flowLlm.id, flowLlm], [rawProvider.id, provider]]),
  } },
});

// ---------------------------------------------------------------------------
// Create main thread (lightweight handle over shared project state)
// ---------------------------------------------------------------------------

// Main joins the first enabled project at construction, so its runtime's learning owner
// (captured when the runtime is built) matches the project it is later listed under.
const mainProjectId = Object.values(config.projects ?? {}).find(project => project.enabled !== false)?.id;
const thread = factory.create("main", {
  description: "Main conversation thread",
  ...(mainProjectId ? { projectId: mainProjectId } : {}),
});

// Main's own stack. Everything below (reactive rules, Librarian, Cartographer,
// Wardens, FlowOrchestrator) binds to this instance, not to the template, so
// main's thread-state and cache writes stay private to main.
const stack = thread.stack;

const signals = thread.signals;
const mainRuntime = runtimeManager.get(thread.id)!;

// ---------------------------------------------------------------------------
// Session adapter — long-lived HarnessSession factory with crash recovery
//
// Only meaningful for runtime-backed providers (claude-code, codex). The
// adapter:
//   - Persists (threadId → native session ID) to .foundry/sessions.json so
//     Foundry restarts resume native sessions instead of abandoning them.
//   - Bridges session_compact events from the runtime into the signal bus
//     as `session_compacted` signals, which the FlowOrchestrator observes
//     to clear the Librarian's injection ledger and re-hydrate next turn.
// ---------------------------------------------------------------------------

if (sessionAdapter) {
  factory.attachSessionAdapter(sessionAdapter);
  console.log(`Session adapter: ${sessionAdapter.runtime} (store: ${FOUNDRY_DIR}/sessions.json)`);
}

// ---------------------------------------------------------------------------
// Flow — main's Cartographer, Wardens, Librarian and FlowOrchestrator are
// owned by its ThreadRuntime (see agents/thread-runtime.ts). Every other
// factory-created thread gets the same wiring automatically.
// ---------------------------------------------------------------------------

console.log(`Flow: Cartographer + ${mainRuntime.domainLibrarians.size} domain librarians + Librarian (${flowLlm.id}) per thread`);

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
    runtimeManager.addSignalSink(pgMemory.signalWriter());
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
    runtimeManager.addSignalSink(muninn.signalWriter());

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

    await initializeWorker({
      queue,
      redisUrl,
      db: pgMemory,
      concurrency: 10,
      // Runtime-owned live stacks: every attached thread, dropped on dispose.
      stacks: runtimeManager.stacks,
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

// Lifecycle/signal bridges into eventStream and thread.start() are owned by
// each thread's runtime (attached at factory.create).

const interventions = new InterventionLog(signals);

// -- Project registry --
const projectRegistry = new ProjectRegistry();

// Load projects from config and register them
if (config.projects) {
  projectRegistry.loadFromConfigs(config.projects);
  // Associate the main thread with the first project so it shows up in the viewer
  const firstProject = projectRegistry.all.values().next().value;
  if (firstProject) {
    firstProject.addThread(thread);
  }
  console.log(`Projects: ${[...projectRegistry.all.keys()].join(", ") || "(none)"}`);
}

const port = parseInt(process.env.VIEWER_PORT || "4400");

const viewer = await startViewer({
  harness,
  eventStream,
  interventions,
  port,
  configDir: FOUNDRY_DIR,
  assistProvider: provider,
  assistModel: config.defaults.model,
  tokenTracker,
  analyticsDir: `${FOUNDRY_DIR}/analytics`,
  projectRegistry,
  db: pgMemory,
  threadFactory: factory,
  configStore,
  actionQueue,
  assistTools: tools,
  runtimeJobs: new RuntimeJobRegistry(),
});

console.log(`Viewer: http://localhost:${port}`);
console.log(`Provider: ${provider.id} (${config.defaults.model})`);
console.log(`Agents: ${[...thread.agents.keys()].join(", ")}`);
console.log(`Layers: ${stack.layers.map((l) => l.id).join(", ")}`);
console.log(`Persistence: local SQLite${pgMemory ? " + postgres mirror" : ""}${process.env.MUNINN_URL ? " + muninn" : ""}`);
console.log();

// ---------------------------------------------------------------------------
// Startup self-test — verify the LLM provider actually works
// ---------------------------------------------------------------------------

await runStartupSelfTest({ enabled: selfTestRequested, provider: decisions?.provider ?? rawProvider, model: decisions ? decisionModel : config.defaults.model, cwd: process.cwd(),
  log: console.log, warn: console.warn, error: console.error });

console.log();
console.log("Ready. Send messages through the harness API or viewer.");

// ---------------------------------------------------------------------------
// Keep alive
// ---------------------------------------------------------------------------

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  // Native processes must exit before their profile locks (in ~/.claude, ~/.codex) are released.
  await Promise.race([Promise.all([sessionAdapter?.releaseAll?.(), decisions?.shutdown()]), Bun.sleep(5_000)]);
  runtimeManager.disposeAll();
  viewer.server.stop();
  viewer.localStore?.close();
  await shutdownWorker();
  await viewer.analyticsStore?.flush();
  process.exit(0);
});
