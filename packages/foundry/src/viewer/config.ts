import { resolveSubscriptionPolicy, type SubscriptionPolicy } from "../providers/subscription-policy";
import type { CredentialReference } from '@inixiative/foundry-core';
import { kingdomRuntimeSchema, type KingdomRuntimeSettings } from "../providers/kingdom-runtime-connection";
import { KastleAuthentication, type KastleSource, type KastleAssignment } from "../providers/kastle-authentication";
import { validateKastleAccess, type KastleAccessSource } from "../providers/kastle-access-client";
import { NativeAuthentication, type NativeAuthenticationSource } from "../providers/native-authentication";
import type { ClaudeContextBudget } from "../providers/claude-context-budget";
import { mkdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { newId, validateMemorySelection, type Harness, type LLMProvider, type MemorySelectionPolicy } from "@inixiative/foundry-core";
import { providerConfigsFromRegistry } from "../models/registry";
import { resolveProjectView, type ResolvedLayerDefinition, type ResolvedProjectView } from "./config-resolve";
import { validateLearningSettings, type LearningSettings } from "../agents/learning-config";

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
  subscriptionOnly?: SubscriptionPolicy;
  /** Credential references only; do not put tokens in settings. */
  nativeAuthentication?: NativeAuthenticationSource[];
  kastles?: KastleSource[];
  /** Project-scoped integration grants. Independent of inference resource selection. Restart to apply. */
  kastleAccess?: KastleAccessSource[];
  kastleAssignments?: Record<string, KastleAssignment>;
  /** Explicit thread-to-source UUID assignments, applied on Foundry startup. */
  nativeAuthenticationSelections?: Record<string, string>;
  /** Background domain review phase; does not override classifier/router or executor profiles. */
  learning?: LearningSettings;
  /** Global defaults — executor provider/model + classifier provider/model. */
  defaults: {
    provider: string;
    model: string;
    nativeAuthenticationId?: string;
    kastleId?: string;
    /** Explicit native selection; MCP stays default. Applies on construction only. */
    codexEngine?: "mcp" | "app-server";
    codexEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
  kingdomRuntime?: KingdomRuntimeSettings;

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
  /** Claude Code native compaction policy; defaults to 200k / 80%. */
  contextBudget?: ClaudeContextBudget | false;
  id: string;
  type: "anthropic" | "openai" | "gemini" | "claude-code" | "codex" | "custom";
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
   */
  ownedLayers?: string[];
  /** Tool names that trigger this configured Warden's post-action guard. [] disables guards. */
  guardTriggers?: string[];
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
  extends Omit<Partial<AgentSettingsConfig>, "visibleLayers" | "ownedLayers" | "guardTriggers" | "peers" | "browser" | "condition" | "description"> {
  /** Override description file path for this project. */
  description?: string;
  visibleLayers?: ListPatch<string>;
  ownedLayers?: ListPatch<string>;
  guardTriggers?: ListPatch<string>;
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
 *   "conventions should include X" → update this config.
 * - Feedback that changes an instance affects only that thread:
 *   "this thread's convention cache is stale" → runtime mutation, not config.
 *
 * Agents relate to layers as readers, writers, or both:
 * - Cartographer: READS doc/architecture layers to route context
 * - Domain Librarians: READ + WRITE their own domain layer (warm it, guard it)
 * - Librarian: WRITES the thread-state layer (sole writer)
 * - Executor (Claude Code): READS assembled context from all active layers
 */
export interface LayerSettingsConfig {
  id: string;
  /** Domain knowledge ownership. An enabled domain-advising agent must explicitly
   * own this layer to register a custom expert; passive layers do not spawn actors. */
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
  /**
   * Semantic segment of the layer's CONTENT in the reading view. Optional: a
   * configured layer without it keeps the legacy id-based classification. Only
   * "domain-knowledge" (configured/published cache) or "thread-knowledge"
   * (generated, thread-private) are accepted; the prompt is always an instruction.
   */
  segment?: "domain-knowledge" | "thread-knowledge";
  /** Data source IDs that feed this layer. */
  sourceIds: string[];
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
  type: "file" | "sqlite" | "postgres" | "redis" | "http" | "markdown" | "inline" | "supermemory" | "archive";
  archive?: { projectId: string; kind?: "archive" | "kingdom"; kastleId?: string; keepId?: string; connectionId?: string; tokenEnv?: string; credential?: CredentialReference; budget?: number };
  label: string;
  /** Connection string, file path, URL — depends on type. */
  uri: string;
  /** Whether this source is enabled. */
  enabled: boolean;
  /**
   * Memory-backed ("file") sources only. Widest visibility this source
   * exposes to a thread: "thread" (default) = the thread's own captures plus
   * project/global publications; "project" = publications only;
   * "global" = globally published knowledge, identical for every project.
   */
  scope?: "thread" | "project" | "global";
  /**
   * Memory-backed sources only. Also expose unowned legacy records written
   * before ownership existed. Off by default: legacy records are preserved
   * on disk but never become shared knowledge implicitly.
   */
  includeUnowned?: boolean;
  /**
   * Memory-backed sources only. Bounded automatic selection is on by default:
   * pinned kinds always, records relevant to the current message, a few recent
   * captures, and an explicit account of what was left out. Override fields of
   * the policy here, or set `false` to inject the full formatted log.
   */
  selection?: false | Partial<MemorySelectionPolicy>;
}

export interface TunnelSettingsConfig {
  /** Whether the tunnel is enabled. */
  enabled: boolean;
  /** Tunnel provider. Default: "localtunnel". */
  provider?: "localtunnel" | "cloudflared";
  /** Subdomain hint (localtunnel only, not guaranteed). */
  subdomain?: string;

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
    id: newId("proj"),
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
      provider: "claude-code",
      model: "fable",
    },
    providers: providerConfigsFromRegistry(),
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
      staleness: 0,
      enabled: true,
    },
    conventions: {
      id: "conventions",
      prompt: "Project conventions and coding standards.",
      sourceIds: ["conventions-src"],
      staleness: 60_000,
      enabled: true,
    },
    memory: {
      id: "memory",
      prompt: "Working memory — recent context, signals, decisions.",
      sourceIds: ["memory-src"],
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

function mergeProviderConfigs(
  defaults: Record<string, ProviderConfig>,
  saved?: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const merged: Record<string, ProviderConfig> = {};

  for (const [id, provider] of Object.entries(defaults)) {
    const existing = saved?.[id];
    merged[id] = {
      ...provider,
      ...existing,
      models: provider.models,
      enabled: existing?.enabled ?? provider.enabled,
      baseUrl: existing?.baseUrl ?? provider.baseUrl,
    };
  }

  for (const [id, provider] of Object.entries(saved ?? {})) {
    if (!(id in merged)) merged[id] = provider;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// ConfigStore — persists settings to disk
// ---------------------------------------------------------------------------

/**
 * Runtime validation of operator/persisted configuration at every write
 * boundary. Only memory selection policies carry semantics the TypeScript
 * shapes cannot protect; validate them wherever a source may be declared:
 * global sources and each project's source overrides.
 */
/** A layer's content segment must be absent or exactly one of the two bounded values. Applied
 * to global definitions and every project override before any live or persisted publication. */
function validateLayerSegment(owner: string, id: string, layer: unknown): void {
  const segment = (layer as { segment?: unknown } | null | undefined)?.segment;
  if (segment !== undefined && segment !== "domain-knowledge" && segment !== "thread-knowledge")
    throw new Error(`invalid layer ${JSON.stringify(id)} in ${owner}: segment must be "domain-knowledge" or "thread-knowledge"`);
}

/**
 * Validators for settings owned by modules outside the framework. A module that augments
 * FoundryConfig registers its check here; nothing in config.ts knows the field.
 */
const configValidators: ((config: FoundryConfig) => void)[] = [];
export function registerConfigValidator(validate: (config: FoundryConfig) => void): void { configValidators.push(validate); }

export function validateConfig(config: FoundryConfig): void {
  resolveSubscriptionPolicy(config);
  if (config.kingdomRuntime) kingdomRuntimeSchema.parse(config.kingdomRuntime);
  for (const validate of configValidators) validate(config);
  if (config.tunnel && "password" in config.tunnel) throw Error("Inline tunnel passwords are not supported; use the private tunnel-token file and remove tunnel.password from settings");
  for (const source of validateKastleAccess(config.kastleAccess ?? [])) {
    if (source.projectIds.some(id => !config.projects[id] || config.projects[id]!.enabled === false))
      throw Error("Kastle access references an unavailable project");
  }
  if (config.kastles || config.defaults.kastleId || config.kastleAssignments) {
    if (config.defaults.nativeAuthenticationId || Object.keys(config.nativeAuthenticationSelections ?? {}).length) throw Error("Choose Kastle bindings or local native sources for this Foundry instance");
    if (!["claude-code", "codex"].includes(config.defaults.provider)) throw Error("Kastle bindings require a native runtime provider");
    new KastleAuthentication({ directory: join(process.cwd(), ".foundry", "kastle"), sources: config.kastles ?? [], defaultKastleId: config.defaults.kastleId, assignments: config.kastleAssignments });
  }
  if (config.nativeAuthentication || config.defaults.nativeAuthenticationId || config.nativeAuthenticationSelections) {
    const authentication = new NativeAuthentication({ directory: join(process.cwd(), ".foundry", "runtime-profiles"),
      sources: config.nativeAuthentication ?? [], defaultSourceId: config.defaults.nativeAuthenticationId });
    for (const [threadId, sourceId] of Object.entries(config.nativeAuthenticationSelections ?? {})) authentication.select(threadId, sourceId);
    if (config.defaults.nativeAuthenticationId && !["claude-code", "codex"].includes(config.defaults.provider)) throw Error("Native authentication requires a native runtime provider");
  }
  validateLearningSettings(config.learning);
  for (const [id, layer] of Object.entries(config.layers ?? {})) validateLayerSegment("global layers", id, layer);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    for (const [id, layer] of Object.entries((project as { layers?: Record<string, unknown> } | null | undefined)?.layers ?? {}))
      validateLayerSegment(`project ${JSON.stringify(pid)} layers`, id, layer);
  const check = (owner: string, sources: Record<string, DataSourceConfig> | undefined) => {
    for (const [id, src] of Object.entries(sources ?? {})) {
      if (!src || src.selection === undefined || src.selection === false) continue;
      try { validateMemorySelection(src.selection); }
      catch (err) { throw new Error(`invalid source ${JSON.stringify(id)} in ${owner}: ${(err as Error).message}`); }
    }
  };
  check("global sources", config.sources);
  for (const [pid, project] of Object.entries(config.projects ?? {})) check(`project ${JSON.stringify(pid)} sources`, project?.sources as Record<string, DataSourceConfig> | undefined);
}

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

  get directory(): string { return this._dir; }

  /** Load config from disk, merging with defaults. */
  async load(): Promise<FoundryConfig> {
    const path = join(this._dir, "settings.json");
    const file = Bun.file(path);
    if (await file.exists()) {
      const saved = await file.json() as Partial<FoundryConfig>;
      const defaults = defaultConfig();
      // Merge saved over defaults into a candidate; validate before it becomes live.
      // An invalid persisted policy fails loudly, keeps the last working live
      // configuration, and leaves the file untouched for the operator to repair.
      const candidate: FoundryConfig = {
        ...defaults,
        ...saved,
        providers: mergeProviderConfigs(defaults.providers, saved.providers),
        projects: { ...saved.projects },
      };
      try { validateConfig(candidate); }
      catch (err) { throw new Error(`settings.json at ${path} was not loaded: ${(err as Error).message}`); }
      this._config = candidate;
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
    validateConfig(config);
    this._config = config;
    await this._write();
  }

  /** Patch a section of the config. */
  async patch(section: string, data: Record<string, unknown>): Promise<FoundryConfig> {
    // Build the candidate on a copy; live and persisted settings change only after validation.
    const next: FoundryConfig = { ...this._config };
    if (section === "defaults") {
      next.defaults = { ...this._config.defaults, ...data } as FoundryConfig["defaults"];
    } else if (section === "providers") {
      next.providers = { ...this._config.providers, ...data } as FoundryConfig["providers"];
    } else if (section === "agents") {
      next.agents = { ...this._config.agents, ...data } as FoundryConfig["agents"];
    } else if (section === "layers") {
      next.layers = { ...this._config.layers, ...data } as FoundryConfig["layers"];
    } else if (section === "sources") {
      next.sources = { ...this._config.sources, ...data } as FoundryConfig["sources"];
    } else if (section === "projects") {
      next.projects = { ...this._config.projects, ...data } as FoundryConfig["projects"];
    } else if (section === "mcp") {
      next.mcp = { ...this._config.mcp, ...data } as McpSettingsConfig;
    } else if (section === "learning") {
      next.learning = { ...this._config.learning, ...data } as LearningSettings;
    }
    validateConfig(next);
    this._config = next;
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
        // A newly discovered layer carries its construction segment when it has one;
        // an existing configured definition is never overwritten and no absent field is added.
        this._config.layers[layer.id] = {
          id: layer.id,
          prompt: layer.prompt ?? "",
          sourceIds: layer.sources.map((s) => s.id),
          staleness: layer.staleness ?? 0,
          enabled: true,
          ...(layer.segment ? { segment: layer.segment } : {}),
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
