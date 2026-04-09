// ---------------------------------------------------------------------------
// @inixiative/foundry — opinionated agent orchestration framework
// ---------------------------------------------------------------------------
// Re-exports everything from core + foundry-specific additions.
// ---------------------------------------------------------------------------

// Everything from core (engine primitives)
export * from "@inixiative/foundry-core";

// Foundry agents (re-exports core + adds foundry-specific agents)
export {
  // Compaction strategies
  TrustBasedStrategy,
  LRUStrategy,
  SummarizeStrategy,
  HybridStrategy,
  type HybridThresholds,
  // Built-in hooks
  planModeHook,
  budgetGuardHook,
  autoCompactHook,
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
  keywordClassify,
  keywordRoute,
  parseJSON,
  type SourceResolver,
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
  type ThreadSnapshot,
  type HeraldPattern,
  type HeraldRecommendation,
  type PatternDetector,
  type HeraldConfig,
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
  BunScript,
  type BunScriptConfig,
} from "./tools/bun-script";
export {
  JustBashShell,
  type JustBashShellConfig,
} from "./tools/just-bash-shell";

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

// Runtime Adapters
export {
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventKind,
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
  type FoundryConfig,
  type AgentSettingsConfig,
  type LayerSettingsConfig,
  type SourceSettingsConfig,
  type ProjectSettingsConfig,
  type ExecutionEnv,
  type BrowserConfig,
} from "./viewer/config";
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

// MCP — mid-session bridge (FLOW.md Loop 2)
export {
  createFoundryMcpServer,
  startStdioTransport,
  createSseTransport,
  type FoundryMcpConfig,
} from "./mcp";
