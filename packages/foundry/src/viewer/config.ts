import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { Harness, LLMProvider } from "@inixiative/foundry-core";
import { resolveProjectView, type ResolvedLayerDefinition, type ResolvedProjectView } from "./config-resolve";

// ---------------------------------------------------------------------------
// Settings config model — serializable representation of system configuration
// ---------------------------------------------------------------------------

/**
 * The full settings config. Serialized to disk as JSON.
 * Everything the UI can configure lives here.
 *
 * Two-tier model:
 * - Global level: defaults, providers, agents, layers, sources — shared baseline
 * - Project level: each project can inherit global settings or override per-field
 */
export interface FoundryConfig {
  /** Global defaults — executor provider/model + classifier provider/model. */
  defaults: {
    provider: string;
    model: string;
    /** Classifier/router provider. Defaults to same as executor if omitted. */
    classifierProvider?: string;
    /** Classifier/router model. Defaults to same as executor if omitted. */
    classifierModel?: string;
  };

  /** Provider configurations (keyed by provider ID). */
  providers: Record<string, ProviderConfig>;

  /**
   * Global agent templates (keyed by agent ID).
   * Projects inherit these as starting points. On a fresh install this is empty —
   * agents are created per-project via defaultProjectAgents().
   */
  agents: Record<string, AgentSettingsConfig>;

  /**
   * Global layer templates (keyed by layer ID).
   * Projects inherit these as starting points. On a fresh install this is empty —
   * layers are created per-project via defaultProjectLayers().
   */
  layers: Record<string, LayerSettingsConfig>;

  /**
   * Global data source templates (keyed by source ID).
   * On a fresh install this is empty — sources are project-scoped.
   */
  sources: Record<string, DataSourceConfig>;

  /** Registered projects (keyed by project ID). */
  projects: Record<string, ProjectSettingsConfig>;

  /** Tunnel configuration — expose the viewer over a public URL. */
  tunnel?: TunnelSettingsConfig;

  /** MCP server configuration — mid-session bridge for Claude Code. */
  mcp?: McpSettingsConfig;

  /** Whether the initial setup wizard has been completed. */
  setupComplete?: boolean;
}

/**
 * Project configuration — points to a directory. That's it.
 *
 * The only required input is `path`. Everything else is derived:
 * - id: derived from directory basename (e.g., "/Users/me/my-app" → "my-app")
 * - label: derived from id or package.json name
 * - tags: auto-detected from project contents (has package.json → "node", etc.)
 *
 * Provider/runtime is NOT a project concern — threads and agents choose that.
 * Projects just say "here's a directory" and optionally override agents/layers.
 */
/**
 * Base identity prompts — composed into runtime-specific files (CLAUDE.md, .cursorrules, etc.).
 * All values are file paths relative to the project root.
 */
export interface ProjectPrompts {
  /** Shared base identity — all models/runtimes see this. File ref relative to project root. */
  common: string;
  /** Per-runtime additions (keyed by runtime ID: "claude", "cursor", "codex", "gemini"). */
  overrides?: Record<string, string>;
}

export interface ProjectSettingsConfig {
  /** Auto-generated UUID. Never manually specified. */
  id: string;
  /** Path to project root directory. The only truly required field. */
  path: string;
  /** Display label. Defaults to id. */
  label?: string;
  /** Categorization tags. Auto-detected if omitted. */
  tags?: string[];
  /** Optional description. */
  description?: string;
  /** Override global defaults for this project. Omitted fields inherit from global. */
  defaults?: Partial<FoundryConfig["defaults"]>;
  /**
   * Base identity prompts — composed into CLAUDE.md, .cursorrules, etc.
   * This is the project's "front door" — the first thing any model reads.
   * All values are file paths relative to project root.
   */
  prompts?: ProjectPrompts;
  /**
   * Project-specific agent overrides (merged over global agents).
   * Scalar fields override directly.
   * List fields use explicit patch objects: { replace } or { append/remove }.
   */
  agents?: Record<string, AgentSettingsOverride>;
  /**
   * Project-specific layer overrides (merged over global layers).
   * Scalar fields override directly.
   * List fields use explicit patch objects: { replace } or { append/remove }.
   */
  layers?: Record<string, LayerSettingsOverride>;
  /** Project-specific sources (merged over global sources). */
  sources?: Record<string, DataSourceConfig>;
  /** Whether this project is enabled. Default: true. */
  enabled?: boolean;
}

/**
 * Explicit patch operations for list-valued project overrides.
 * Use `replace` to own the full list, or `append`/`remove` to modify the inherited list.
 */
export type ListPatch<T> =
  | { replace: T[] }
  | { append: T[]; remove?: T[] }
  | { append?: T[]; remove: T[] };

export interface ProviderConfig {
  id: string;
  type: "anthropic" | "openai" | "gemini" | "claude-code" | "custom";
  /** Display label. */
  label: string;
  /** Available models for this provider. */
  models: ModelConfig[];
  /** Base URL override (e.g. for Cursor, Ollama, Azure). */
  baseUrl?: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
}

export interface ModelConfig {
  id: string;
  label: string;
  /** Suggested use: "fast" for middleware, "standard" for general, "powerful" for execution. */
  tier: "fast" | "standard" | "powerful";
  /** Cost tier for display. */
  costTier?: "low" | "medium" | "high";
  /** Context window size. */
  contextWindow?: number;
}

/**
 * Execution environment — where an agent runs its tool calls.
 *
 * - "bash": Direct shell access (default for Claude Code provider). Full system access.
 * - "just-bash": Virtualized bash via just-bash (isolated, no real filesystem).
 *   Use for sandboxed agents that need shell semantics without system access.
 * - "typescript": TypeScript/JS execution in isolate (V8/Bun). Agents write code
 *   to filter data, call APIs, transform results — fewer tokens than bash pipelines.
 * - "browser": Browser automation via Playwright MCP or JS execution in page.
 *   Two modes: click-based (Playwright snapshot → click/fill) or code-based
 *   (agent writes JS executed in page context — more token-efficient).
 * - "hybrid": Multiple environments available. Agent chooses per-task.
 *
 * See docs/EXECUTION_ENVIRONMENTS.md for guidance on when to use each.
 */
export type ExecutionEnv = "bash" | "just-bash" | "typescript" | "browser" | "hybrid";

/**
 * Browser-specific configuration for agents with browser access.
 */
export interface BrowserConfig {
  /** Browser interaction mode. */
  mode: "playwright-mcp" | "js-execute" | "hybrid";
  /** Whether to share authenticated browser sessions across agents. */
  shareSession?: boolean;
  /** Allowed URL patterns (glob). Empty = allow all. */
  allowedUrls?: string[];
  /** Blocked URL patterns (glob). Takes precedence over allowedUrls. */
  blockedUrls?: string[];
  /** Whether to capture screenshots for context. */
  screenshots?: boolean;
  /** Max page loads per dispatch (prevent runaway navigation). */
  maxNavigations?: number;
}

export interface BrowserConfigOverride extends Omit<Partial<BrowserConfig>, "allowedUrls" | "blockedUrls"> {
  allowedUrls?: ListPatch<string>;
  blockedUrls?: ListPatch<string>;
}

export interface AgentSettingsConfig {
  id: string;
  /** What kind of agent: executor, classifier, router, decider. */
  kind: string;
  /** FLOW.md role: context-routing, domain-advising, execution, correctness-checking, signal-reconciliation. */
  flowRole?: string;
  /** Domain this agent operates in (e.g., "docs", "security", "cross-thread"). */
  domain?: string;
  /**
   * Human-readable description of this agent's role and responsibilities.
   * File path relative to project root (e.g., ".foundry/agents/security-librarian.md").
   * Explains: what this agent does, which layers it reads/writes, who it delegates to, why.
   */
  description?: string;
  /** System prompt for this agent. */
  prompt: string;
  /** LLM settings — provider/model default to global if omitted. */
  provider?: string;
  model?: string;
  /** Temperature — set per agent. Classifiers/routers want 0, creative agents want higher. */
  temperature?: number;
  /**
   * Which layers this agent can READ (empty = all).
   * These are the layers whose content appears in this agent's assembled context.
   */
  visibleLayers: string[];
  /**
   * Which layers this agent can WRITE (empty = none).
   * Domain librarians own their domain layer. The Librarian owns thread-state.
   * Writeback agents may write to multiple layers (trust scores, content).
   */
  ownedLayers?: string[];
  /** Peer agent IDs for delegation. */
  peers: string[];
  /** Max call-chain depth. */
  maxDepth: number;
  /** Whether this agent can use tools (true) or is text-only (false). Default: true for executors, false for classifier/router. */
  tools?: boolean;
  /** Extended thinking / reasoning effort. "none" | "low" | "medium" | "high" | number (budget tokens). */
  thinking?: "none" | "low" | "medium" | "high" | number;
  /** Permission level for code execution runtimes. Default: "bypass" for unattended, "supervised" for interactive. */
  permissions?: "bypass" | "supervised" | "restricted";
  /**
   * Execution environment for this agent's tool calls.
   * Default: "bash" (via Claude Code provider).
   * See ExecutionEnv type for options.
   */
  executionEnv?: ExecutionEnv;
  /** Browser-specific config. Only relevant when executionEnv includes browser access. */
  browser?: BrowserConfig;
  /** Per-call timeout in ms. */
  timeout?: number;
  /** Enable prompt caching for this agent. */
  cacheControl?: boolean;
  /** Whether this agent is active. */
  enabled: boolean;
  /**
   * When this agent runs in the pipeline:
   * - "always": runs on every request (default for classifier, router)
   * - "on-demand": available but only invoked when middleware/router explicitly requests it
   * - "conditional": runs when its condition matches the current classification/route context
   */
  invocation?: "always" | "on-demand" | "conditional";
  /** Condition for "conditional" invocation. Ignored for other modes. */
  condition?: InvocationCondition;
}

export interface AgentSettingsOverride
  extends Omit<Partial<AgentSettingsConfig>, "visibleLayers" | "ownedLayers" | "peers" | "browser" | "condition" | "description"> {
  /** Override description file path for this project. */
  description?: string;
  visibleLayers?: ListPatch<string>;
  ownedLayers?: ListPatch<string>;
  peers?: ListPatch<string>;
  browser?: BrowserConfigOverride | null;
  condition?: InvocationConditionOverride | null;
}

/**
 * Layer definition in settings — the blueprint for a domain's context layer.
 *
 * This is the DEFINITION (policy, sources, defaults). At runtime, the ThreadFactory
 * creates ContextLayer INSTANCES from these definitions. The distinction matters:
 *
 * - Feedback that changes a definition affects all future instances:
 *   "conventions should default to trust 0.9" → update this config.
 * - Feedback that changes an instance affects only that thread:
 *   "this thread's convention cache is stale" → runtime mutation, not config.
 *
 * Agents relate to layers as readers, writers, or both:
 * - Cartographer: READS doc/architecture layers to route context
 * - Domain Librarians: READ + WRITE their own domain layer (warm it, guard it)
 * - Librarian: WRITES the thread-state layer (sole writer)
 * - Executor (Claude Code): READS assembled context from all active layers
 * - Writeback: WRITES trust scores, content updates across layers
 */
export interface LayerSettingsConfig {
  id: string;
  /** Which domain this layer belongs to. Domain librarians find their layers by this. */
  domain?: string;
  /**
   * Human-readable description of this layer's job in the system.
   * File path relative to project root (e.g., ".foundry/layers/conventions.md").
   * Explains: what knowledge domain it covers, when it's relevant, who writes to it,
   * what the warmed content looks like.
   */
  description?: string;
  /**
   * What shape the warmed content takes — helps humans and agents understand what's inside.
   * E.g., "JSON array of convention objects", "Markdown documentation index", "Compact thread-state JSON".
   */
  contentShape?: string;
  /** Instruction prompt for this layer. */
  prompt: string;
  /** Data source IDs that feed this layer. */
  sourceIds: string[];
  /** Default trust score (0-1) for new instances. Writeback may adjust per-thread. */
  trust: number;
  /** Staleness threshold in ms (0 = never stale). */
  staleness: number;
  /** Agent IDs that can write to this layer. Undefined = any agent. */
  writers?: string[];
  /** Whether this layer definition is enabled. */
  enabled: boolean;
  /**
   * When instances of this layer are included in context assembly:
   * - "always": included on every request (default for system, conventions)
   * - "on-demand": only included when explicitly requested via route.contextSlice or middleware
   * - "conditional": included when its condition matches classification/route context
   */
  activation?: "always" | "on-demand" | "conditional";
  /** Condition for "conditional" activation. Ignored for other modes. */
  condition?: InvocationCondition;
}

export interface LayerSettingsOverride
  extends Omit<Partial<LayerSettingsConfig>, "sourceIds" | "writers" | "condition"> {
  sourceIds?: ListPatch<string>;
  writers?: ListPatch<string>;
  condition?: InvocationConditionOverride | null;
}

/**
 * Condition for conditional invocation/activation.
 * Matches when ANY specified field matches (OR across fields, OR within arrays).
 */
export interface InvocationCondition {
  /** Match if classification.category is one of these. */
  categories?: string[];
  /** Match if any classification tag overlaps with these. */
  tags?: string[];
  /** Match if route.destination is one of these. */
  routes?: string[];
}

export interface InvocationConditionOverride {
  categories?: ListPatch<string>;
  tags?: ListPatch<string>;
  routes?: ListPatch<string>;
}

export interface DataSourceConfig {
  id: string;
  type: "file" | "sqlite" | "postgres" | "redis" | "http" | "markdown" | "inline" | "supermemory";
  label: string;
  /** Connection string, file path, URL — depends on type. */
  uri: string;
  /** Whether this source is enabled. */
  enabled: boolean;
}

export interface TunnelSettingsConfig {
  /** Whether the tunnel is enabled. */
  enabled: boolean;
  /** Tunnel provider. Default: "localtunnel". */
  provider?: "localtunnel" | "cloudflared";
  /** Subdomain hint (localtunnel only, not guaranteed). */
  subdomain?: string;
  /**
   * User-chosen password for tunnel access.
   * If unset, an auto-generated token is used.
   */
  password?: string;
}

export interface McpSettingsConfig {
  /** Whether the MCP server is enabled. */
  enabled: boolean;
  /**
   * Transport mode:
   * - "stdio": Claude Code spawns `bun run mcp/cli.ts` as a subprocess (default).
   *   Each Claude Code session gets its own MCP server instance.
   * - "sse": The viewer embeds the MCP server and exposes `/mcp` endpoints.
   *   Single server shared across sessions. Requires the viewer to be running.
   */
  transport?: "stdio" | "sse";
  /**
   * Projects where `.mcp.json` has been written for Claude Code auto-discovery.
   * Keyed by project ID. Value is the absolute path to the `.mcp.json` file.
   */
  installedProjects?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Project creation helper — just give it a path
// ---------------------------------------------------------------------------

/** Create a project config from just a path. Everything else is derived. */
export function createProject(
  projectPath: string,
  overrides?: Partial<Omit<ProjectSettingsConfig, "id" | "path">>,
): ProjectSettingsConfig {
  return {
    id: randomUUID(),
    path: projectPath,
    label: overrides?.label ?? basename(projectPath),
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default config with sensible starting values
// ---------------------------------------------------------------------------

export function defaultConfig(): FoundryConfig {
  return {
    defaults: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    },
    providers: {
      "claude-code": {
        id: "claude-code",
        type: "claude-code",
        label: "Claude Code (CLI subscription)",
        models: [
          { id: "sonnet", label: "Sonnet 4.6", tier: "standard", costTier: "medium", contextWindow: 200000 },
          { id: "opus", label: "Opus 4.7", tier: "powerful", costTier: "high", contextWindow: 200000 },
          { id: "haiku", label: "Haiku 4.5", tier: "fast", costTier: "low", contextWindow: 200000 },
        ],
        enabled: true,
      },
      anthropic: {
        id: "anthropic",
        type: "anthropic",
        label: "Anthropic (API key)",
        models: [
          { id: "claude-opus-4-7", label: "Opus 4.7", tier: "powerful", costTier: "high", contextWindow: 1000000 },
          { id: "claude-opus-4-6", label: "Opus 4.6", tier: "powerful", costTier: "high", contextWindow: 1000000 },
          { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "standard", costTier: "medium", contextWindow: 1000000 },
          { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", tier: "fast", costTier: "low", contextWindow: 200000 },
        ],
        enabled: true,
      },
      openai: {
        id: "openai",
        type: "openai",
        label: "OpenAI",
        models: [
          { id: "gpt-5.4", label: "GPT-5.4", tier: "powerful", costTier: "high", contextWindow: 1000000 },
          { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", tier: "standard", costTier: "medium", contextWindow: 400000 },
          { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", tier: "powerful", costTier: "high", contextWindow: 400000 },
          { id: "o4-mini", label: "o4-mini", tier: "fast", costTier: "low", contextWindow: 200000 },
        ],
        enabled: true,
      },
      gemini: {
        id: "gemini",
        type: "gemini",
        label: "Google Gemini",
        models: [
          { id: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", tier: "fast", costTier: "low", contextWindow: 1000000 },
          { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", tier: "standard", costTier: "medium", contextWindow: 1000000 },
          { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", tier: "powerful", costTier: "high", contextWindow: 1000000 },
        ],
        enabled: true,
      },
    },
    agents: {},
    layers: {},
    sources: {},
    projects: {},
  };
}

/**
 * Starter config — minimal bootstrap for new installations.
 * Only sets providers + model defaults. NO agents, layers, or sources.
 * Those are project-scoped and created when a project is added.
 * Used by auto-bootstrap when no config exists.
 */
export function starterConfig(
  providerId: string = "claude-code",
  model: string = "sonnet",
): FoundryConfig {
  const config = defaultConfig();
  config.defaults.provider = providerId;
  config.defaults.model = model;
  config.setupComplete = false;
  return config;
}

/**
 * Default project agents — created when a project is added.
 * Provider/model filled from project or global defaults.
 */
export function defaultProjectAgents(
  providerId: string,
  executorModel: string,
  classifierProvider?: string,
  classifierModel?: string,
): Record<string, AgentSettingsConfig> {
  const cp = classifierProvider ?? providerId;
  const cm = classifierModel ?? executorModel;
  return {
    classifier: {
      id: "classifier",
      kind: "classifier",
      flowRole: "context-routing",
      prompt: "Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {\"category\": \"...\", \"subcategory\": \"...\", \"reasoning\": \"...\"}",
      provider: cp,
      model: cm,
      temperature: 0,
      tools: false,
      visibleLayers: ["system"],
      ownedLayers: [],
      peers: [],
      maxDepth: 1,
      invocation: "always" as const,
      enabled: true,
    },
    router: {
      id: "router",
      kind: "router",
      flowRole: "context-routing",
      prompt: "Route the classified message to the Artificer with the right context layers.\nChoose which layers are relevant to the task.\nRespond with JSON: {\"destination\": \"artificer\", \"contextSlice\": [\"layer1\"], \"priority\": 5, \"reasoning\": \"...\"}",
      provider: cp,
      model: cm,
      temperature: 0,
      tools: false,
      visibleLayers: ["system"],
      ownedLayers: [],
      peers: [],
      maxDepth: 1,
      invocation: "always" as const,
      enabled: true,
    },
    artificer: {
      id: "artificer",
      kind: "executor",
      flowRole: "execution",
      prompt: "You are the Artificer — the engineering agent.\n\nYou receive tasks that have already been classified and routed to you with the right context layers. Your job is to execute: read code, write code, run tests, fix bugs, build features, answer questions.\n\nYour workflow:\n1. Understand the task from the routed context and user message\n2. Explore the codebase to build the mental model you need\n3. Implement incrementally — build, test, iterate\n4. Verify your changes don't break existing tests\n\nFollow project conventions. Write clean, tested code. Prefer editing existing files over creating new ones. Explain your reasoning when it's non-obvious.",
      provider: providerId,
      model: executorModel,
      temperature: 0,
      tools: true,
      permissions: "bypass" as const,
      visibleLayers: [],
      ownedLayers: [],
      peers: [],
      maxDepth: 5,
      invocation: "on-demand" as const,
      enabled: true,
    },
  };
}

/** Default project layers — created when a project is added. */
export function defaultProjectLayers(): Record<string, LayerSettingsConfig> {
  return {
    system: {
      id: "system",
      prompt: "Core system instructions.",
      sourceIds: ["system-prompt"],
      trust: 1.0,
      staleness: 0,
      enabled: true,
    },
    conventions: {
      id: "conventions",
      prompt: "Project conventions and coding standards.",
      sourceIds: ["conventions-src"],
      trust: 0.8,
      staleness: 60_000,
      enabled: true,
    },
    memory: {
      id: "memory",
      prompt: "Working memory — recent context, signals, decisions.",
      sourceIds: ["memory-src"],
      trust: 0.3,
      staleness: 30_000,
      enabled: true,
    },
  };
}

/** Default project sources — paths relative to project root. */
export function defaultProjectSources(projectPath: string): Record<string, DataSourceConfig> {
  return {
    "system-prompt": {
      id: "system-prompt",
      type: "inline",
      label: "System prompt",
      uri: "You are a helpful engineering assistant.\nFollow project conventions. Ask clarifying questions when requirements are ambiguous.\nWrite clean, tested code.",
      enabled: true,
    },
    "conventions-src": {
      id: "conventions-src",
      type: "markdown",
      label: "Project conventions",
      uri: join(projectPath, "docs"),
      enabled: true,
    },
    "memory-src": {
      id: "memory-src",
      type: "file",
      label: "Working memory",
      uri: join(projectPath, ".foundry/memory"),
      enabled: true,
    },
  };
}

// ---------------------------------------------------------------------------
// ConfigStore — persists settings to disk
// ---------------------------------------------------------------------------

export class ConfigStore {
  private _dir: string;
  private _config: FoundryConfig;
  private _loaded = false;

  constructor(dir: string) {
    this._dir = resolve(dir);
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
    this._config = defaultConfig();
  }

  /** Load config from disk, merging with defaults. */
  async load(): Promise<FoundryConfig> {
    const path = join(this._dir, "settings.json");
    const file = Bun.file(path);
    if (await file.exists()) {
      const saved = await file.json() as Partial<FoundryConfig>;
      // Merge saved over defaults
      this._config = {
        ...defaultConfig(),
        ...saved,
        providers: { ...defaultConfig().providers, ...saved.providers },
        projects: { ...saved.projects },
      };
    }
    this._loaded = true;
    return this._config;
  }

  /** Get current config. */
  get config(): FoundryConfig {
    return this._config;
  }

  /** Update the full config and persist. */
  async save(config: FoundryConfig): Promise<void> {
    this._config = config;
    await this._write();
  }

  /** Patch a section of the config. */
  async patch(section: string, data: Record<string, unknown>): Promise<FoundryConfig> {
    if (section === "defaults") {
      this._config.defaults = { ...this._config.defaults, ...data } as FoundryConfig["defaults"];
    } else if (section === "providers") {
      this._config.providers = { ...this._config.providers, ...data } as FoundryConfig["providers"];
    } else if (section === "agents") {
      this._config.agents = { ...this._config.agents, ...data } as FoundryConfig["agents"];
    } else if (section === "layers") {
      this._config.layers = { ...this._config.layers, ...data } as FoundryConfig["layers"];
    } else if (section === "sources") {
      this._config.sources = { ...this._config.sources, ...data } as FoundryConfig["sources"];
    } else if (section === "projects") {
      this._config.projects = { ...this._config.projects, ...data } as FoundryConfig["projects"];
    } else if (section === "mcp") {
      this._config.mcp = { ...this._config.mcp, ...data } as McpSettingsConfig;
    }
    await this._write();
    return this._config;
  }

  /** Delete an item from a section. */
  async deleteItem(section: string, id: string): Promise<FoundryConfig> {
    const sectionMap: Record<string, Record<string, unknown>> = {
      providers: this._config.providers,
      agents: this._config.agents,
      layers: this._config.layers,
      sources: this._config.sources,
      projects: this._config.projects,
    };
    const map = sectionMap[section];
    if (map && id in map) {
      delete map[id];
      await this._write();
    }
    return this._config;
  }

  /**
   * Sync current runtime state into config.
   * Reads agents, layers, etc. from the harness and updates config to match.
   */
  syncFromHarness(harness: Harness): void {
    const thread = harness.thread;

    // Sync agents
    for (const [id, agent] of thread.agents) {
      if (!this._config.agents[id]) {
        this._config.agents[id] = {
          id,
          kind: agent.constructor.name.toLowerCase().replace("agent", ""),
          prompt: agent.prompt ?? "",
          provider: agent.llm?.provider ?? this._config.defaults.provider,
          model: agent.llm?.model ?? this._config.defaults.model,
          temperature: agent.llm?.temperature,
          visibleLayers: agent.llm?.sources ?? [],
          peers: agent.peers,
          maxDepth: agent.llm?.maxDepth ?? 3,
          enabled: true,
        };
      }
    }

    // Sync layers
    for (const layer of thread.stack.layers) {
      if (!this._config.layers[layer.id]) {
        this._config.layers[layer.id] = {
          id: layer.id,
          prompt: layer.prompt ?? "",
          sourceIds: layer.sources.map((s) => s.id),
          trust: layer.trust,
          staleness: layer.staleness ?? 0,
          enabled: true,
        };
      }
    }
  }

  /**
   * Resolve effective config for a project.
   * Inherits global defaults, agents, layers, sources — then merges project overrides.
   */
  resolveProject(projectId: string): FoundryConfig | null {
    return this.resolveProjectView(projectId)?.config ?? null;
  }

  /** Resolve project config and include layer provenance for inspection/debugging. */
  resolveProjectView(projectId: string): ResolvedProjectView | null {
    return resolveProjectView(this._config, projectId);
  }

  /** Inspect only the resolved layer definitions for a project. */
  inspectResolvedLayers(projectId: string): ResolvedLayerDefinition[] | null {
    return this.resolveProjectView(projectId)?.layers ?? null;
  }

  private async _write(): Promise<void> {
    const path = join(this._dir, "settings.json");
    await Bun.write(path, JSON.stringify(this._config, null, 2));
  }
}
