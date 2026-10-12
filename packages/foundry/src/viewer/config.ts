import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, watch } from 'node:fs';
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  computeHash,
  type Harness,
  type LLMProvider,
  type MemorySelectionPolicy,
  newId,
  type VersionEntry,
  type VersionLog,
  validateMemorySelection,
} from '@inixiative/foundry-core';
import { configuredExperts } from '../agents/configured-experts';
import { CORPUS_TIERS, type CorpusTier } from '../agents/corpus-compiler';
import { isThreadKnowledgeLayerId } from '../agents/domain-librarian';
import { type LearningSettings, validateLearningSettings } from '../agents/learning-config';
import { type FeedbackSettings, validateFeedbackSettings } from '../feedback/types';
import {
  type ModelCapability,
  type ProviderType,
  providerConfigsFromRegistry,
  subscriptionWorker,
} from '../models/registry';
import {
  COMPOSITION_SLOTS,
  type CompositionSettings,
  type CompositionSlot,
  resolveInstructionLadder,
  validateCompositionSettings,
} from '../prompts/instruction-settings';
import type { ClaudeContextBudget } from '../providers/claude-context-budget';
import { DECISION_MODEL } from '../providers/decision-provider';
import {
  type KingdomAccessSource,
  validateKingdomAccess,
} from '../providers/kingdom-access-client';
import {
  KingdomAuthentication,
  type KingdomInferenceAssignment,
  type KingdomInferenceSource,
} from '../providers/kingdom-authentication';
import {
  type KingdomIntegration,
  kingdomIntegrationsSchema,
} from '../providers/kingdom-installation-connection';
import {
  NativeAuthentication,
  type NativeAuthenticationSource,
} from '../providers/native-authentication';
import {
  assertMainThreadLabs,
  resolveSubscriptionPolicy,
  SUBSCRIPTION_DECISIONS,
  type SubscriptionSettings,
} from '../providers/subscription-policy';
import type { ToolRules } from '../turns/tool-gate';
import {
  type ResolvedLayerDefinition,
  type ResolvedProjectView,
  resolveProjectView,
} from './config-resolve';

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
  /** Opt in to API-key providers (paid tokens). Absent or false: subscription-only, and no API provider is constructed. */
  apiTokens?: boolean;
  /** Subscription-mode overrides; every field has a default. See docs/subscription-decisions.md. */
  subscriptionOnly?: SubscriptionSettings;
  /** Structural tool rules: the only tool denials, held in every permission mode (turns/tool-gate.ts). */
  toolRules?: ToolRules;
  /** Credential references only; do not put tokens in settings. */
  nativeAuthentication?: NativeAuthenticationSource[];
  kingdomInference?: KingdomInferenceSource[];
  /** Project-scoped integration grants. Independent of inference resource selection. Restart to apply. */
  kingdomAccess?: KingdomAccessSource[];
  kingdomInferenceAssignments?: Record<string, KingdomInferenceAssignment>;
  /** Explicit thread-to-source UUID assignments, applied on Foundry startup. */
  nativeAuthenticationSelections?: Record<string, string>;
  /** Background domain review phase; does not override classifier/router or executor profiles. */
  learning?: LearningSettings;
  /** The feedback lifecycle: capture, tuning prompts and the role-file changes they apply (docs/FEEDBACK-LOOP.md). */
  feedback?: FeedbackSettings;
  /**
   * The composition view: one ladder (CLAUDE.md, AGENTS.md, auto memory, role files) composes the
   * instructions and domain knowledge of every role; see docs/usage-and-context.md.
   */
  composition?: CompositionSettings;
  /** Global defaults — executor provider/model + classifier provider/model. */
  defaults: {
    provider: string;
    model: string;
    nativeAuthenticationId?: string;
    kingdomOwnerKey?: string;
    codexEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    /** Classifier/router provider. Defaults to same as executor if omitted. */
    classifierProvider?: string;
    /** Classifier/router model. Defaults to same as executor if omitted. */
    classifierModel?: string;
  };

  /** Provider configurations (keyed by provider ID). */
  providers: Record<string, ProviderConfig>;

  /**
   * Global agent templates (keyed by agent ID).
   * Projects inherit these by id; a project override of the same id wins.
   * A fresh install is seeded from defaultProjectAgents().
   */
  agents: Record<string, AgentSettingsConfig>;

  /**
   * Global layer templates (keyed by layer ID).
   * Projects inherit these by id; a project override of the same id wins.
   * A fresh install is seeded from defaultProjectLayers().
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
  /** Every Kingdom integration this Foundry is paired as, once per Kingdom + owner; Signets stay in private files. */
  kingdomIntegrations?: KingdomIntegration[];

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
  /** Opt-in maintenance; existing margins remain readable when disabled. */
  gloss?: { enabled: boolean; display: 'margin' | 'hover' | 'inline' };
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
  defaults?: Partial<FoundryConfig['defaults']>;
  /** Project tool rules: a capability here overrides the global one; protected paths add up. */
  toolRules?: ToolRules;
  /** Project feedback settings: each field overrides the global one. */
  feedback?: FeedbackSettings;
  /**
   * Base identity prompts — composed into CLAUDE.md, .cursorrules, etc.
   * This is the project's "front door" — the first thing any model reads.
   * All values are file paths relative to project root.
   */
  prompts?: ProjectPrompts;
  /**
   * Project agents. Each is standalone (a full definition, replacing any global agent of the same id)
   * or `extends` a global agent. No entry: the global agent applies unchanged.
   */
  agents?: Record<string, ProjectAgentSettings>;
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
  type: ProviderType;
  /** Display label. */
  label: string;
  /** Available models for this provider. */
  models: ModelConfig[];
  /** API root override. Seeded from the registry; edit for a proxy, a mainland endpoint, or a local port. */
  baseUrl?: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
}

export interface ModelConfig {
  id: string;
  label: string;
  /** Suggested use: "fast" for middleware, "standard" for general, "powerful" for execution. */
  tier: 'fast' | 'standard' | 'powerful';
  /** Cost tier for display. */
  costTier?: 'low' | 'medium' | 'high';
  /** Context window size. */
  contextWindow?: number;
  /** What this model is worth using for. Always includes "judgment". */
  capabilities?: ModelCapability[];
  /** The vendor trains on prompts and completions sent to this model. */
  trainsOnInput?: boolean;
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
export type ExecutionEnv = 'bash' | 'just-bash' | 'typescript' | 'browser' | 'hybrid';

/**
 * Browser-specific configuration for agents with browser access.
 */
export interface BrowserConfig {
  /** Browser interaction mode. */
  mode: 'playwright-mcp' | 'js-execute' | 'hybrid';
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

export interface BrowserConfigOverride
  extends Omit<Partial<BrowserConfig>, 'allowedUrls' | 'blockedUrls'> {
  allowedUrls?: ListPatch<string>;
  blockedUrls?: ListPatch<string>;
}

/**
 * Kinds settings may declare. Classifiers, routers and executors are thread agents; the Cartographer
 * and domain-advising Wardens (decider, domain-librarian) are runtime roles configured here. The
 * Librarian is programmatic and the Herald is not wired, so neither takes settings.
 */
export const AGENT_KINDS = [
  'executor',
  'classifier',
  'router',
  'cartographer',
  'decider',
  'domain-librarian',
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AgentSettingsConfig {
  id: string;
  kind: AgentKind;
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
   * Which layers this agent can WRITE (empty = none). The Librarian owns thread-state. A Warden owns
   * no configured layer: it writes only its generated thread-knowledge layer, and reads its
   * knowledge from the composition view.
   */
  ownedLayers?: string[];
  /**
   * Warden: source ids its domain knowledge composes from, before the composition view's files
   * (docs/usage-and-context.md, "Composition view"). A project extension appends its own.
   */
  domainKnowledge?: string[];
  /** Tool names that trigger this configured Warden's post-action guard. [] disables guards. */
  guardTriggers?: string[];
  /** Peer agent IDs for delegation. */
  peers: string[];
  /** Max call-chain depth. */
  maxDepth: number;
  /** Whether this agent can use tools (true) or is text-only (false). Default: true for executors, false for classifier/router. */
  tools?: boolean;
  /** Extended thinking / reasoning effort. "none" | "low" | "medium" | "high" | number (budget tokens). */
  thinking?: 'none' | 'low' | 'medium' | 'high' | number;
  /** Permission level for code execution runtimes. Default: "bypass". */
  permissions?: 'bypass' | 'restricted';
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
  invocation?: 'always' | 'on-demand' | 'conditional';
  /** Condition for "conditional" invocation. Ignored for other modes. */
  condition?: InvocationCondition;
}

/** Instructions and domain knowledge are the two composable chunks of a project Warden. */
export type AgentChunk = 'instructions' | 'domainKnowledge';

/**
 * A project agent composed with a global one. Instructions (`prompt`) and domain knowledge
 * (`domainKnowledge`, sources for the parent's owned layer) are appended to the parent's under
 * a heading per chunk; a chunk named in `override` replaces the parent's instead. Identity
 * (kind, role, domain, owned layer) is the parent's; other fields override, lists patch.
 */
export interface AgentExtension
  extends Omit<
    Partial<AgentSettingsConfig>,
    | 'id'
    | 'kind'
    | 'flowRole'
    | 'domain'
    | 'ownedLayers'
    | 'visibleLayers'
    | 'guardTriggers'
    | 'peers'
    | 'browser'
    | 'condition'
  > {
  /** Global agent id. */
  extends: string;
  domainKnowledge?: string[];
  override?: AgentChunk[];
  visibleLayers?: ListPatch<string>;
  guardTriggers?: ListPatch<string>;
  peers?: ListPatch<string>;
  browser?: BrowserConfigOverride | null;
  condition?: InvocationConditionOverride | null;
}

export type ProjectAgentSettings = AgentSettingsConfig | AgentExtension;

export const isAgentExtension = (agent: ProjectAgentSettings): agent is AgentExtension =>
  'extends' in agent;

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
  segment?: 'domain-knowledge' | 'thread-knowledge';
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
  activation?: 'always' | 'on-demand' | 'conditional';
  /** Condition for "conditional" activation. Ignored for other modes. */
  condition?: InvocationCondition;
}

export interface LayerSettingsOverride
  extends Omit<Partial<LayerSettingsConfig>, 'sourceIds' | 'writers' | 'condition'> {
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
  type:
    | 'file'
    | 'sqlite'
    | 'postgres'
    | 'redis'
    | 'http'
    | 'markdown'
    | 'inline'
    | 'supermemory'
    | 'archive'
    | 'instructions';
  /**
   * Instruction sources only (`uri` is unused): which of the main role's slots the source returns.
   * Default "instructions". Who it is for is `composition.roles.main.audience`.
   */
  slot?: CompositionSlot;
  /** Searches the local Archive for this project; `uri` is unused. */
  archive?: {
    projectId: string;
    budget?: number;
  };
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
  scope?: 'thread' | 'project' | 'global';
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
  provider?: 'localtunnel' | 'cloudflared';
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
  transport?: 'stdio' | 'sse';
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
  overrides?: Partial<Omit<ProjectSettingsConfig, 'id' | 'path'>>,
): ProjectSettingsConfig {
  return {
    id: newId('proj'),
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
      provider: 'claude-code',
      model: 'fable',
      classifierProvider: SUBSCRIPTION_DECISIONS,
      classifierModel: DECISION_MODEL,
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
  providerId: string = 'claude-code',
  model: string = 'fable',
): FoundryConfig {
  const config = defaultConfig();
  config.defaults.provider = providerId;
  config.defaults.model = model;
  if (!subscriptionWorker(providerId)) {
    // Subscription mode runs the worker on Claude Code or Codex; any other worker is the API-token mode.
    config.apiTokens = true;
    delete config.defaults.classifierProvider;
    delete config.defaults.classifierModel;
  }
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
      id: 'classifier',
      kind: 'classifier',
      flowRole: 'context-routing',
      prompt:
        'Classify the incoming message into exactly one category.\nCategories: bug, feature, refactor, question, convention, general.\nRespond with JSON: {"category": "...", "subcategory": "...", "reasoning": "..."}',
      provider: cp,
      model: cm,
      temperature: 0,
      tools: false,
      visibleLayers: ['system'],
      ownedLayers: [],
      peers: [],
      maxDepth: 1,
      invocation: 'always' as const,
      enabled: true,
    },
    router: {
      id: 'router',
      kind: 'router',
      flowRole: 'context-routing',
      prompt:
        'Route the classified message to the Artificer with the right context layers.\nChoose which layers are relevant to the task.\nRespond with JSON: {"destination": "artificer", "contextSlice": ["layer1"], "priority": 5, "reasoning": "..."}',
      provider: cp,
      model: cm,
      temperature: 0,
      tools: false,
      visibleLayers: ['system'],
      ownedLayers: [],
      peers: [],
      maxDepth: 1,
      invocation: 'always' as const,
      enabled: true,
    },
    artificer: {
      id: 'artificer',
      kind: 'executor',
      flowRole: 'execution',
      prompt:
        "You are the Artificer — the engineering agent.\n\nYou receive tasks that have already been classified and routed to you with the right context layers. Your job is to execute: read code, write code, run tests, fix bugs, build features, answer questions.\n\nYour workflow:\n1. Understand the task from the routed context and user message\n2. Explore the codebase to build the mental model you need\n3. Implement incrementally — build, test, iterate\n4. Verify your changes don't break existing tests\n\nFollow project conventions. Write clean, tested code. Prefer editing existing files over creating new ones. Explain your reasoning when it's non-obvious.",
      provider: providerId,
      model: executorModel,
      temperature: 0,
      tools: true,
      permissions: 'bypass' as const,
      visibleLayers: [],
      ownedLayers: [],
      peers: [],
      maxDepth: 5,
      invocation: 'on-demand' as const,
      enabled: true,
    },
  };
}

/** Default global layers. The `project` layer reads each project's own sources (see projectSources). */
export function defaultProjectLayers(): Record<string, LayerSettingsConfig> {
  return {
    system: {
      id: 'system',
      prompt: 'Core system instructions.',
      sourceIds: ['system-prompt'],
      staleness: 0,
      enabled: true,
    },
    instructions: {
      id: 'instructions',
      prompt:
        'Standing instructions: personal, organization and project instruction files, and auto memory.',
      sourceIds: ['instructions'],
      staleness: 60_000,
      enabled: true,
    },
    conventions: {
      id: 'conventions',
      prompt: 'Project conventions and coding standards.',
      sourceIds: ['conventions-src'],
      staleness: 60_000,
      enabled: true,
    },
    memory: {
      id: 'memory',
      prompt: 'Working memory — recent context, signals, decisions.',
      sourceIds: ['memory-src'],
      staleness: 30_000,
      enabled: true,
    },
    project: PROJECT_LAYER,
  };
}

/** Reads the active project's own docs and agent conventions; empty outside a project. */
export const PROJECT_LAYER: LayerSettingsConfig = {
  id: 'project',
  prompt: "This project's own documentation and agent conventions.",
  sourceIds: ['project-docs', 'project-ai'],
  staleness: 300_000,
  enabled: true,
};

/** A project's own sources: the only settings a project gets when added; everything else is inherited. */
export function projectSources(projectPath: string): Record<string, DataSourceConfig> {
  const dirs = {
    'project-docs': ['docs', 'Project docs'],
    'project-ai': ['AI', 'Project agent conventions'],
  } as const;
  return Object.fromEntries(
    Object.entries(dirs)
      .filter(([, [dir]]) => existsSync(join(projectPath, dir)))
      .map(([id, [dir, label]]) => [
        id,
        { id, type: 'markdown', label, uri: join(projectPath, dir), enabled: true },
      ]),
  );
}

/** Default global sources for a fresh install rooted at projectPath. */
export function defaultProjectSources(projectPath: string): Record<string, DataSourceConfig> {
  return {
    'system-prompt': {
      id: 'system-prompt',
      type: 'inline',
      label: 'System prompt',
      uri: 'You are a helpful engineering assistant.\nFollow project conventions. Ask clarifying questions when requirements are ambiguous.\nWrite clean, tested code.',
      enabled: true,
    },
    instructions: {
      id: 'instructions',
      type: 'instructions',
      label: 'Instruction files (CLAUDE.md, AGENTS.md, auto memory)',
      uri: '',
      enabled: true,
    },
    'conventions-src': {
      id: 'conventions-src',
      type: 'markdown',
      label: 'Project conventions',
      uri: join(projectPath, 'docs'),
      enabled: true,
    },
    'memory-src': {
      id: 'memory-src',
      type: 'file',
      label: 'Working memory',
      uri: join(projectPath, '.foundry/memory'),
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
function validateLayerDefinition(owner: string, id: string, layer: unknown): void {
  if (isThreadKnowledgeLayerId(id))
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: thread-knowledge layers are generated per thread, never configured`,
    );
  const segment = (layer as { segment?: unknown } | null | undefined)?.segment;
  if (segment !== undefined && segment !== 'domain-knowledge' && segment !== 'thread-knowledge')
    throw new Error(
      `invalid layer ${JSON.stringify(id)} in ${owner}: segment must be "domain-knowledge" or "thread-knowledge"`,
    );
}

/**
 * Validators for settings owned by modules outside the framework. A module that augments
 * FoundryConfig registers its check here; nothing in config.ts knows the field.
 */
const configValidators: ((config: FoundryConfig) => void)[] = [];
export function registerConfigValidator(validate: (config: FoundryConfig) => void): void {
  configValidators.push(validate);
}

/** Every declared agent has a kind something runs; Wardens are domain-advising. */
function validateAgentKinds(owner: string, agents: Record<string, Partial<AgentSettingsConfig>>) {
  const cartographers = Object.values(agents).filter(
    (agent) => agent.kind === 'cartographer' && agent.enabled !== false,
  );
  if (cartographers.length > 1) throw Error(`${owner}: at most one enabled cartographer`);
  for (const [id, agent] of Object.entries(agents)) {
    if (agent.kind === undefined) continue;
    if (!(AGENT_KINDS as readonly string[]).includes(agent.kind))
      throw Error(
        `${owner} agent ${JSON.stringify(id)}: kind ${JSON.stringify(agent.kind)} is not configurable (${AGENT_KINDS.join(', ')})`,
      );
    if (
      (agent.kind === 'decider' || agent.kind === 'domain-librarian') &&
      agent.flowRole !== 'domain-advising'
    )
      throw Error(`${owner} agent ${JSON.stringify(id)}: a Warden's flowRole is domain-advising`);
    // Each phase supplies its response protocol; a second shape in the instructions contradicts it.
    if (
      ['cartographer', 'decider', 'domain-librarian'].includes(agent.kind) &&
      /respond with json/i.test(agent.prompt ?? '')
    )
      throw Error(
        `${owner} agent ${JSON.stringify(id)}: instructions must not state a response format; the phase supplies it`,
      );
  }
}

export function validateConfig(config: FoundryConfig): void {
  validateAgentKinds('global', config.agents ?? {});
  assertMainThreadLabs(config);
  resolveSubscriptionPolicy(config);
  if (config.kingdomIntegrations) kingdomIntegrationsSchema.parse(config.kingdomIntegrations);
  for (const validate of configValidators) validate(config);
  if (config.tunnel && 'password' in config.tunnel)
    throw Error(
      'Inline tunnel passwords are not supported; use the private tunnel-token file and remove tunnel.password from settings',
    );
  for (const source of validateKingdomAccess(config.kingdomAccess ?? [])) {
    if (
      source.projectIds.some((id) => !config.projects[id] || config.projects[id]!.enabled === false)
    )
      throw Error('Kingdom access references an unavailable project');
  }
  if (
    config.kingdomInference ||
    config.defaults.kingdomOwnerKey ||
    config.kingdomInferenceAssignments
  ) {
    if (
      config.defaults.nativeAuthenticationId ||
      Object.keys(config.nativeAuthenticationSelections ?? {}).length
    )
      throw Error('Choose Kingdom bindings or local native sources for this Foundry instance');
    if (!['claude-code', 'codex'].includes(config.defaults.provider))
      throw Error('Kingdom bindings require a native runtime provider');
    new KingdomAuthentication({
      directory: join(process.cwd(), '.foundry', 'kingdom'),
      sources: config.kingdomInference ?? [],
      defaultOwnerKey: config.defaults.kingdomOwnerKey,
      assignments: config.kingdomInferenceAssignments,
    });
  }
  if (
    config.nativeAuthentication ||
    config.defaults.nativeAuthenticationId ||
    config.nativeAuthenticationSelections
  ) {
    const authentication = new NativeAuthentication({
      directory: join(process.cwd(), '.foundry', 'runtime-profiles'),
      sources: config.nativeAuthentication ?? [],
      defaultSourceId: config.defaults.nativeAuthenticationId,
    });
    for (const [threadId, sourceId] of Object.entries(config.nativeAuthenticationSelections ?? {}))
      authentication.select(threadId, sourceId);
    if (
      config.defaults.nativeAuthenticationId &&
      !['claude-code', 'codex'].includes(config.defaults.provider)
    )
      throw Error('Native authentication requires a native runtime provider');
  }
  validateLearningSettings(config.learning);
  validateFeedbackSettings('feedback', config.feedback);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    validateFeedbackSettings(`projects.${pid}.feedback`, project?.feedback);
  if ('instructions' in config)
    throw Error(
      'settings key "instructions" is now "composition" (docs/usage-and-context.md, "Composition view")',
    );
  validateCompositionSettings(config.composition, resolveInstructionLadder(config.composition));
  for (const [id, layer] of Object.entries(config.layers ?? {}))
    validateLayerDefinition('global layers', id, layer);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    for (const [id, layer] of Object.entries(
      (project as { layers?: Record<string, unknown> } | null | undefined)?.layers ?? {},
    ))
      validateLayerDefinition(`project ${JSON.stringify(pid)} layers`, id, layer);
  configuredExperts(config);
  for (const projectId of Object.keys(config.projects ?? {})) {
    const view = resolveProjectView(config, projectId)!.config;
    validateAgentKinds(`project ${JSON.stringify(projectId)}`, view.agents);
    // What thread construction checks, checked before the settings are saved.
    try {
      configuredExperts(view);
    } catch (error) {
      throw Error(`project ${JSON.stringify(projectId)}: ${(error as Error).message}`);
    }
  }
  const check = (owner: string, sources: Record<string, DataSourceConfig> | undefined) => {
    for (const [id, src] of Object.entries(sources ?? {})) {
      if ('audience' in (src ?? {}))
        throw new Error(
          `invalid source ${JSON.stringify(id)} in ${owner}: audience moved to composition.roles.<role>.audience`,
        );
      if (src?.slot !== undefined && !(COMPOSITION_SLOTS as readonly string[]).includes(src.slot))
        throw new Error(
          `invalid source ${JSON.stringify(id)} in ${owner}: slot must be one of ${COMPOSITION_SLOTS.join(', ')}`,
        );
      if (!src || src.selection === undefined || src.selection === false) continue;
      try {
        validateMemorySelection(src.selection);
      } catch (err) {
        throw new Error(
          `invalid source ${JSON.stringify(id)} in ${owner}: ${(err as Error).message}`,
        );
      }
    }
  };
  check('global sources', config.sources);
  for (const [pid, project] of Object.entries(config.projects ?? {}))
    check(
      `project ${JSON.stringify(pid)} sources`,
      project?.sources as Record<string, DataSourceConfig> | undefined,
    );
}

/** A mutation named a settings revision that is no longer current. */
export class ConfigRevisionError extends Error {
  constructor() {
    super('Settings changed elsewhere. Reload before saving.');
  }
}

type ConfigDraft = (draft: FoundryConfig) => FoundryConfig | void;

/** One settings definition before and after an edit. */
export interface SettingsChange {
  before: unknown;
  after: unknown;
}

/** One line of the settings history: a versioned edit to one definition. */
export interface SettingsEdit {
  /** `agent:<id>`, `layer:<id>`, `source:<id>`, `provider:<id>`, `project:<id>` or `settings:<key>`. */
  subject: string;
  /** The store revision the edit produced. */
  revision: number;
  entry: VersionEntry<SettingsChange>;
}

export type SettingsListener = (config: FoundryConfig, edits: SettingsEdit[]) => unknown;

const KEYED_SECTIONS: Record<string, string> = {
  agents: 'agent',
  layers: 'layer',
  sources: 'source',
  providers: 'provider',
  projects: 'project',
};

/** Per-definition differences between two configurations. */
export function settingsChanges(
  before: FoundryConfig,
  after: FoundryConfig,
): Array<{ subject: string } & SettingsChange> {
  const changes: Array<{ subject: string } & SettingsChange> = [];
  const differ = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const prior = before as unknown as Record<string, unknown>,
    next = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    const kind = KEYED_SECTIONS[key];
    if (!kind) {
      if (differ(prior[key], next[key]))
        changes.push({ subject: `settings:${key}`, before: prior[key], after: next[key] });
      continue;
    }
    const a = (prior[key] ?? {}) as Record<string, unknown>,
      b = (next[key] ?? {}) as Record<string, unknown>;
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (differ(a[id], b[id]))
        changes.push({ subject: `${kind}:${id}`, before: a[id], after: b[id] });
  }
  return changes;
}

export class ConfigStore {
  private _dir: string;
  private _config: FoundryConfig;
  private _loaded = false;
  private _revision = 0;
  private _queue: Promise<unknown> = Promise.resolve();
  private _listeners = new Set<SettingsListener>();
  private _notified: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this._dir = resolve(dir);
    if (!existsSync(this._dir)) {
      mkdirSync(this._dir, { recursive: true });
    }
    this._config = defaultConfig();
  }

  get directory(): string {
    return this._dir;
  }

  /** Increments whenever the committed config changes. */
  get revision(): number {
    return this._revision;
  }

  /** Load config from disk, merging with defaults. */
  load(): Promise<FoundryConfig> {
    return this._serialize(async () => {
      const path = join(this._dir, 'settings.json');
      const file = Bun.file(path);
      if (await file.exists()) {
        const saved = (await file.json()) as Partial<FoundryConfig>;
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
        try {
          validateConfig(candidate);
        } catch (err) {
          throw new Error(`settings.json at ${path} was not loaded: ${(err as Error).message}`);
        }
        if (JSON.stringify(candidate) !== JSON.stringify(this._config)) {
          const previous = this._config;
          this._revision++;
          this._config = candidate;
          // The first load reads the settings; a later one picks up an edit made to the file.
          if (this._loaded) await this._record(previous, candidate, 'file');
        }
      }
      this._loaded = true;
      return this._config;
    });
  }

  /** Called, in commit order, after each committed change. Returns an unsubscribe. */
  onChange(listener: SettingsListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Reload when settings.json is edited by hand; returns a stop function. An invalid edit is refused and logged. */
  watch(): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(this._dir, (_event, file) => {
      if (file !== 'settings.json') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.load().catch((error) => console.warn(`[settings] ${(error as Error).message}`));
      }, 200);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }

  /** Resolves once every change listener has handled the changes committed so far. */
  settled(): Promise<void> {
    return this._notified;
  }

  /** Versioned edits, oldest first, grouped by subject; one subject when given. */
  async history(subject?: string): Promise<VersionLog<SettingsChange>[]> {
    let text = '';
    try {
      text = await readFile(join(this._dir, 'settings-history.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const logs = new Map<string, VersionLog<SettingsChange>>();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let edit: SettingsEdit;
      try {
        edit = JSON.parse(line) as SettingsEdit;
      } catch {
        continue; // a torn final line from an interrupted append
      }
      if (subject !== undefined && edit.subject !== subject) continue;
      const log = logs.get(edit.subject) ?? {
        subject: edit.subject,
        scope: 'definition',
        entries: [],
      };
      log.entries.push(edit.entry);
      logs.set(edit.subject, log);
    }
    return [...logs.values()];
  }

  /** Current committed config. Read-only: change it through update/save/patch/deleteItem. */
  get config(): FoundryConfig {
    return this._config;
  }

  /**
   * Apply `fn` to a deep copy of the latest committed config. Mutations run one at a time;
   * the result becomes live only after it validates and is persisted.
   */
  update(fn: ConfigDraft, expectedRevision?: number): Promise<FoundryConfig> {
    return this._serialize(async () => {
      this._expect(expectedRevision);
      const draft = structuredClone(this._config);
      return this._commit(fn(draft) ?? draft);
    });
  }

  /** Replace the full config and persist. */
  async save(config: FoundryConfig, expectedRevision?: number): Promise<void> {
    await this.update(() => structuredClone(config), expectedRevision);
  }

  /** Patch a section of the config. */
  patch(
    section: string,
    data: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<FoundryConfig> {
    const patch = structuredClone(data);
    return this.update((next) => {
      if (section === 'defaults') {
        next.defaults = { ...next.defaults, ...patch } as FoundryConfig['defaults'];
      } else if (section === 'providers') {
        next.providers = { ...next.providers, ...patch } as FoundryConfig['providers'];
      } else if (section === 'agents') {
        next.agents = { ...next.agents, ...patch } as FoundryConfig['agents'];
      } else if (section === 'layers') {
        next.layers = { ...next.layers, ...patch } as FoundryConfig['layers'];
      } else if (section === 'sources') {
        next.sources = { ...next.sources, ...patch } as FoundryConfig['sources'];
      } else if (section === 'projects') {
        next.projects = { ...next.projects, ...patch } as FoundryConfig['projects'];
      } else if (section === 'mcp') {
        next.mcp = { ...next.mcp, ...patch } as McpSettingsConfig;
      } else if (section === 'learning') {
        next.learning = { ...next.learning, ...patch } as LearningSettings;
      } else if (section === 'composition') {
        next.composition = { ...next.composition, ...patch } as CompositionSettings;
      } else if (section === 'subscriptionOnly') {
        next.subscriptionOnly = { ...next.subscriptionOnly, ...patch } as SubscriptionSettings;
      } else if (section === 'feedback') {
        next.feedback = { ...next.feedback, ...patch } as FeedbackSettings;
      } else if (section === 'toolRules') {
        next.toolRules = { ...next.toolRules, ...patch } as ToolRules;
      } else if (section === 'apiTokens') {
        // Explicit opt-in to API-key providers; absent or false is subscription-only.
        if (patch.enabled === true) next.apiTokens = true;
        else delete next.apiTokens;
      }
    }, expectedRevision);
  }

  /** Delete an item from a section. */
  deleteItem(section: string, id: string, expectedRevision?: number): Promise<FoundryConfig> {
    return this._serialize(async () => {
      this._expect(expectedRevision);
      if (!(id in (deletableSection(this._config, section) ?? {}))) return this._config;
      const draft = structuredClone(this._config);
      delete deletableSection(draft, section)![id];
      return this._commit(draft);
    });
  }

  /**
   * The saved config plus definitions that exist only at runtime, for inspection.
   * A copy: runtime state never becomes settings.
   */
  withRuntime(harness: Harness): FoundryConfig {
    const thread = harness.thread;
    const agents = { ...this._config.agents };
    const layers = { ...this._config.layers };

    // Runtime-only agents
    for (const [id, agent] of thread.agents) {
      if (!agents[id]) {
        agents[id] = {
          id,
          kind: agent.constructor.name.toLowerCase().replace('agent', '') as AgentKind,
          prompt: agent.prompt ?? '',
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

    // Runtime-only layers
    for (const layer of thread.stack.layers) {
      if (!layers[layer.id]) {
        // A newly discovered layer carries its construction segment when it has one;
        // an existing configured definition is never overwritten and no absent field is added.
        layers[layer.id] = {
          id: layer.id,
          prompt: layer.prompt ?? '',
          sourceIds: layer.sources.map((s) => s.id),
          staleness: layer.staleness ?? 0,
          enabled: true,
          ...(layer.segment ? { segment: layer.segment } : {}),
        };
      }
    }
    return { ...this._config, agents, layers };
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

  private _serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this._queue.then(work, work);
    this._queue = next.catch(() => {});
    return next;
  }

  private _expect(revision: number | undefined): void {
    if (revision !== undefined && revision !== this._revision) throw new ConfigRevisionError();
  }

  private async _commit(candidate: FoundryConfig): Promise<FoundryConfig> {
    validateConfig(candidate);
    const path = join(this._dir, 'settings.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(candidate, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    const previous = this._config;
    this._config = candidate;
    this._revision++;
    this._loaded = true;
    await this._record(previous, candidate, 'user');
    return candidate;
  }

  /** Append the edits to the history, then notify listeners in order. */
  private async _record(previous: FoundryConfig, next: FoundryConfig, author: string) {
    const timestamp = new Date().toISOString();
    const edits: SettingsEdit[] = settingsChanges(previous, next).map(
      ({ subject, before, after }) => ({
        subject,
        revision: this._revision,
        entry: {
          hash: computeHash(JSON.stringify(after ?? null)),
          timestamp,
          trigger: 'settings',
          author,
          snapshot: { before, after },
        },
      }),
    );
    if (!edits.length) return;
    try {
      await appendFile(
        join(this._dir, 'settings-history.jsonl'),
        edits.map((edit) => JSON.stringify(edit)).join('\n') + '\n',
        { mode: 0o600 },
      );
    } catch (error) {
      console.warn(`[settings] history not written: ${(error as Error).message}`);
    }
    const config = structuredClone(next);
    for (const listener of this._listeners)
      this._notified = this._notified
        .then(() => listener(config, edits))
        .then(
          () => undefined,
          (error) => console.warn(`[settings] change not applied: ${(error as Error).message}`),
        );
  }
}

function deletableSection(
  config: FoundryConfig,
  section: string,
): Record<string, unknown> | undefined {
  if (
    section === 'providers' ||
    section === 'agents' ||
    section === 'layers' ||
    section === 'sources' ||
    section === 'projects'
  )
    return config[section];
}
