// ---------------------------------------------------------------------------
// @inixiative/foundry — opinionated agent orchestration framework
// ---------------------------------------------------------------------------
// Re-exports everything from core + foundry-specific additions.
// ---------------------------------------------------------------------------

// Everything from core (engine primitives)
export * from "@inixiative/foundry-core";

// Foundry agents (re-exports core + adds foundry-specific agents)
export {
  // Built-in hooks
  planModeHook,
  budgetGuardHook,
  type HookTokenTracker,
  // Sessions
  SessionManager,
  type ThreadBlueprint,
  type LayerInheritance,
  // Planner
  Planner,
  type Plan,
  type PlanStep,
  type PlannerConfig,
  type PlanExecutionResult,
  // Active Memory
  ActiveMemory,
  type AccessRecord,
  type CompetitionResult,
  type ActiveMemoryConfig,
  type LayerStats,
  // Corpus Compiler
  CorpusCompiler,
  type FluidEntry,
  type FormalDoc,
  type DocState,
  type CompiledCorpus,
  type CorpusTier,
  type CorpusCompilerConfig,
  // Project
  Project,
  ProjectRegistry,
  fromSettingsConfig,
  type ProjectConfig,
  type ProjectStatus,
  type ProjectSummary,
  // Thread Factory
  ThreadFactory,
  buildLayers,
  buildAgents,
  keywordClassify,
  keywordRoute,
  parseJSON,
  resolveAgentOpts,
  type SourceResolver,
  type BuildLayersDeps,
  type BuildAgentsDeps,
  type ThreadFactoryDeps,
  // Reactive Middleware
  ReactiveMiddleware,
  lowConfidenceRule,
  classificationOverrideRule,
  rewarmOnAgentRule,
  emitOnPatternRule,
  type ReactionRule,
  type ReactionContext,
  type ReactiveMiddlewareConfig,
  // Herald
  Herald,
  DuplicationDetector,
  ContradictionDetector,
  ConvergenceDetector,
  CrossPollinationDetector,
  ResourceImbalanceDetector,
  type VisibilityTier,
  type LayerVisibility,
  type ThreadSnapshot,
  type HeraldPattern,
  type HeraldRecommendation,
  type PatternDetector,
  type HeraldConfig,
  // Librarian (signal reconciliation)
  Librarian,
  type ThreadState,
  type LibrarianConfig,
  // Domain Librarian (advise + guard pattern)
  DomainLibrarian,
  type DomainLibrarianConfig,
  type AdviseResult,
  type GuardFinding,
  type GuardResult,
  type ToolObservation,
  // Cartographer (context routing)
  Cartographer,
  type CartographerConfig,
  type MapEntry,
  type TopologyMap,
  type RouteResult,
  // Flow Orchestrator (wires the five FLOW.md roles)
  FlowOrchestrator,
  type FlowOrchestratorConfig,
  type InjectionPlan,
  type GuardReport,
  type InvalidationEvent,
} from "./agents";

// Tools — execution environment adapters
export {
  PlaywrightBrowser,
  type PlaywrightBrowserConfig,
} from "./tools/playwright-browser";
export {
  HttpApi,
  type HttpApiConfig,
} from "./tools/http-api";
export {
  BashShell,
  type BashShellConfig,
} from "./tools/bash-shell";
export {
  BunScript,
  type BunScriptConfig,
} from "./tools/bun-script";
export {
  JustBashShell,
  type JustBashShellConfig,
} from "./tools/just-bash-shell";
export {
  MemoryToolAdapter,
  type MemoryBackend,
  type RichMemoryBackend,
  type MemoryToolAdapterConfig,
} from "./tools/memory-adapter";
export {
  builtinFilters,
  compose as composeFilters,
  rtk as rtkFilter,
} from "./tools/output-filters";

// Heavy-infra adapters
export {
  RedisMemory,
  type RedisClient,
  type RedisEntry,
} from "./adapters/redis-memory";
export { PostgresMemory } from "./adapters/postgres-memory";
export {
  SupermemoryAdapter,
  type SupermemoryConfig,
} from "./adapters/supermemory";
export {
  MuninnMemory,
  type MuninnConfig,
} from "./adapters/muninn-memory";

// Gated Provider (capability-checked LLM wrapper)
export {
  GatedProvider,
  type GatedProviderConfig,
} from "./providers/gated";

// LLM Providers
export {
  ClaudeCodeProvider,
  type ClaudeCodeConfig as ClaudeCodeProviderConfig,
} from "./providers/claude-code";
// HarnessSession — long-lived agent subprocess interface
export {
  type HarnessSession,
  type SessionEvent,
  type SessionEventKind,
  type SessionEventHandler,
  type SessionResult,
  type SessionArtifact,
} from "./providers/harness-session";
export {
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
} from "./providers/claude-code-session";

// SessionAdapter — maps Foundry thread IDs ↔ runtime native session IDs
export {
  type SessionAdapter,
  type CreateSessionOpts,
  type ExternalSessionStore,
  InMemoryExternalSessionStore,
  FileExternalSessionStore,
  ClaudeCodeSessionAdapter,
  type ClaudeCodeSessionAdapterConfig,
} from "./providers/session-adapter";
export {
  AnthropicProvider,
  VoyageEmbeddingProvider,
  type AnthropicConfig,
} from "./providers/anthropic";
export {
  OpenAIProvider,
  OpenAIEmbeddingProvider,
  createCursorProvider,
  createOllamaProvider,
  type OpenAIConfig,
} from "./providers/openai";
export {
  GeminiProvider,
  GeminiEmbeddingProvider,
  type GeminiConfig,
} from "./providers/gemini";

// Runtime Adapters (context injection)
export {
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeEventHandler,
  type ContextInjection,
  ClaudeCodeRuntime,
  CodexRuntime,
  CursorRuntime,
} from "./providers/runtime";

// Viewer
export {
  createViewer,
  startViewer,
  type ViewerConfig,
} from "./viewer/server";
export {
  ActionHandler,
  type OperatorAction,
  type ActionResult,
  type ActionKind,
} from "./viewer/actions";
export {
  ConfigStore,
  defaultConfig,
  starterConfig,
  defaultProjectAgents,
  defaultProjectLayers,
  defaultProjectSources,
  createProject,
  type FoundryConfig,
  type ListPatch,
  type AgentSettingsConfig,
  type AgentSettingsOverride,
  type LayerSettingsConfig,
  type LayerSettingsOverride,
  type DataSourceConfig,
  type ProjectSettingsConfig,
  type ProjectPrompts,
  type ExecutionEnv,
  type BrowserConfig,
  type BrowserConfigOverride,
  type InvocationConditionOverride,
} from "./viewer/config";
export {
  type FieldProvenance,
  type ResolvedLayerDefinition,
  type ResolvedProjectView,
} from "./viewer/config-resolve";
export {
  AIAssist,
  type AISuggestion,
  type AssistRequest,
} from "./viewer/ai-assist";
export {
  AnalyticsStore,
  type AnalyticsSnapshot,
  type TimeSeriesPoint,
  type RollupPeriod,
} from "./viewer/analytics";
export {
  FoundryTunnel,
  tunnelAuth,
  type TunnelConfig,
  type TunnelInfo,
} from "./viewer/tunnel";

// Jobs — BullMQ background job system
export {
  createQueue,
  enqueueJob,
  setQueue,
  initializeWorker,
  shutdownWorker,
  JobHandlerName,
  makeJob,
  makeSingletonJob,
  type JobsQueue,
  type WorkerContext,
  type JobHandler,
  type JobOptions,
  type JobPayloads,
} from "./jobs";

// Logger
export { log, initLogger, type LogLevel, type Logger } from "./logger";

// Research — auto-research for optimal agent configurations
export {
  ExperimentRunner,
  Judge,
  BUILTIN_FIXTURES,
  getAllFixtures,
  loadFixtures,
  modelSweep,
  temperatureSweep,
  toolsSweep,
  dimensionSweep,
  oneAtATime,
  applyVariation,
  writeReport,
  generateMarkdown,
  DEFAULT_EXPERIMENT_CONFIG,
  type Fixture,
  type ConfigVariation,
  type SingleRunResult,
  type FixtureResult,
  type ConfigResult,
  type ExperimentReport,
  type ExperimentConfig,
  type CompositeWeights,
  type ProviderFactory,
  type RunnerDeps,
  type JudgeResult,
  type JudgeConfig,
  type DimensionSweepOpts,
} from "./research";

// Git — worktree detection for thread→branch assignment
export {
  listWorktrees,
  findByBranch,
  findByPath,
  getCurrentBranch,
  diffStat,
  type GitWorktree,
} from "./git";

// Prompts — project identity composition
export {
  compose as composePrompts,
  decompose as decomposePrompts,
  writeComposed as writeComposedPrompts,
  decomposeBack,
  readFileRef,
  writeFileRef,
  RUNTIME_OUTPUT_FILES,
  type DecomposedSections,
} from "./prompts";

// MCP — mid-session bridge (FLOW.md Loop 2)
export {
  createFoundryMcpServer,
  startStdioTransport,
  createSseTransport,
  type FoundryMcpConfig,
} from "./mcp";
