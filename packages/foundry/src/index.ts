// ---------------------------------------------------------------------------
// @inixiative/foundry — opinionated agent orchestration framework
// ---------------------------------------------------------------------------
// Re-exports everything from core + foundry-specific additions.
// ---------------------------------------------------------------------------

// HarnessSession + ClaudeCodeSession — re-exported from @inixiative/agent-session
// (the single source of truth for agent-driving sessions across the ecosystem).
export {
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
  CodexSession,
  type CodexSessionConfig,
  type HarnessSession,
  type SessionArtifact,
  type SessionEvent,
  type SessionEventHandler,
  type SessionEventKind,
  type SessionResult,
  type SessionTokens,
} from '@inixiative/agent-session';
// Everything from core (engine primitives)
export * from '@inixiative/foundry-core';
export {
  type MuninnConfig,
  MuninnMemory,
} from './adapters/muninn-memory';
export { PostgresMemory } from './adapters/postgres-memory';
// Heavy-infra adapters
export {
  type RedisClient,
  type RedisEntry,
  RedisMemory,
} from './adapters/redis-memory';
export {
  SupermemoryAdapter,
  type SupermemoryConfig,
} from './adapters/supermemory';
// Foundry agents (re-exports core + adds foundry-specific agents)
export {
  type AdviseResult,
  type BuildAgentsDeps,
  type BuildLayersDeps,
  budgetGuardHook,
  buildAgents,
  buildLayers,
  // Cartographer (context routing)
  Cartographer,
  type CartographerConfig,
  type CompiledCorpus,
  ContradictionDetector,
  ConvergenceDetector,
  // Corpus Compiler
  CorpusCompiler,
  type CorpusCompilerConfig,
  type CorpusTier,
  CrossPollinationDetector,
  classificationOverrideRule,
  type DocState,
  // Domain Librarian (advise + guard pattern)
  DomainLibrarian,
  type DomainLibrarianConfig,
  DuplicationDetector,
  emitOnPatternRule,
  // Flow Orchestrator (wires the five FLOW.md roles)
  FlowOrchestrator,
  type FlowOrchestratorConfig,
  type FluidEntry,
  type FormalDoc,
  fromSettingsConfig,
  type GuardFinding,
  type GuardReport,
  type GuardResult,
  // Herald
  Herald,
  type HeraldConfig,
  type HeraldPattern,
  type HeraldRecommendation,
  type HookTokenTracker,
  type InjectionPlan,
  type InvalidationEvent,
  keywordClassify,
  keywordRoute,
  type LayerInheritance,
  type LayerVisibility,
  // Librarian (signal reconciliation)
  Librarian,
  type LibrarianConfig,
  lowConfidenceRule,
  type MapEntry,
  type PatternDetector,
  type Plan,
  type PlanExecutionResult,
  // Planner
  Planner,
  type PlannerConfig,
  type PlanStep,
  // Project
  Project,
  type ProjectConfig,
  ProjectRegistry,
  type ProjectStatus,
  type ProjectSummary,
  parseJSON,
  // Built-in hooks
  planModeHook,
  type ReactionContext,
  type ReactionRule,
  // Reactive Middleware
  ReactiveMiddleware,
  type ReactiveMiddlewareConfig,
  ResourceImbalanceDetector,
  type RouteResult,
  resolveAgentOpts,
  rewarmOnAgentRule,
  // Sessions
  SessionManager,
  type SourceResolver,
  type ThreadBlueprint,
  // Thread Factory
  ThreadFactory,
  type ThreadFactoryDeps,
  type ThreadSnapshot,
  type ThreadState,
  type ToolObservation,
  type TopologyMap,
  type VisibilityTier,
} from './agents';
// Git — worktree detection for thread→branch assignment
export {
  diffStat,
  findByBranch,
  findByPath,
  type GitWorktree,
  getCurrentBranch,
  listWorktrees,
} from './git';
// Jobs — BullMQ background job system
export {
  createQueue,
  enqueueJob,
  initializeWorker,
  type JobHandler,
  JobHandlerName,
  type JobOptions,
  type JobPayloads,
  type JobsQueue,
  makeJob,
  makeSingletonJob,
  setQueue,
  shutdownWorker,
  type WorkerContext,
} from './jobs';
// Logger
export { initLogger, type Logger, type LogLevel, log } from './logger';
// MCP — mid-session bridge (FLOW.md Loop 2)
export {
  createFoundryMcpServer,
  createSseTransport,
  type FoundryMcpConfig,
  startStdioTransport,
} from './mcp';
// Prompts — project identity composition
export {
  compose as composePrompts,
  type DecomposedSections,
  decompose as decomposePrompts,
  decomposeBack,
  RUNTIME_OUTPUT_FILES,
  readFileRef,
  writeComposed as writeComposedPrompts,
  writeFileRef,
} from './prompts';
export {
  type AnthropicConfig,
  AnthropicProvider,
  VoyageEmbeddingProvider,
} from './providers/anthropic';
// LLM Providers
export {
  type ClaudeCodeConfig as ClaudeCodeProviderConfig,
  ClaudeCodeProvider,
} from './providers/claude-code';
export type { ClaudeContextBudget } from './providers/claude-context-budget';
export {
  type GeminiConfig,
  GeminiEmbeddingProvider,
  GeminiProvider,
} from './providers/gemini';
export {
  KingdomAuthentication,
  type KingdomInferenceAssignment,
  type KingdomInferenceSource,
} from './providers/kingdom-authentication';
export {
  KingdomClient,
  type KingdomRunEnvelope,
  type KingdomSelection,
} from './providers/kingdom-client';
export {
  NativeAuthentication,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationSource,
} from './providers/native-authentication';
export {
  createCursorProvider,
  createOllamaProvider,
  type OpenAIConfig,
  OpenAIEmbeddingProvider,
  OpenAIProvider,
} from './providers/openai';

// Runtime Adapters (context injection)
export {
  ClaudeCodeRuntime,
  CodexRuntime,
  type ContextInjection,
  CursorRuntime,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventHandler,
  type RuntimeEventKind,
} from './providers/runtime';
// SessionAdapter — maps Foundry thread IDs ↔ runtime native session IDs
export {
  ClaudeCodeSessionAdapter,
  type ClaudeCodeSessionAdapterConfig,
  CodexSessionAdapter,
  type CodexSessionAdapterConfig,
  type CreateSessionOpts,
  type ExternalSessionStore,
  FileExternalSessionStore,
  InMemoryExternalSessionStore,
  type SessionAdapter,
} from './providers/session-adapter';
export {
  formatMessagesForNativeSession,
  SessionBackedProvider,
  type SessionBackedProviderConfig,
} from './providers/session-backed';
export {
  BashShell,
  type BashShellConfig,
} from './tools/bash-shell';
export {
  BunScript,
  type BunScriptConfig,
} from './tools/bun-script';
export {
  HttpApi,
  type HttpApiConfig,
} from './tools/http-api';
export {
  JustBashShell,
  type JustBashShellConfig,
} from './tools/just-bash-shell';
export {
  type MemoryBackend,
  MemoryToolAdapter,
  type MemoryToolAdapterConfig,
  type RichMemoryBackend,
} from './tools/memory-adapter';
export {
  builtinFilters,
  compose as composeFilters,
  rtk as rtkFilter,
} from './tools/output-filters';
// Tools — execution environment adapters
export {
  PlaywrightBrowser,
  type PlaywrightBrowserConfig,
} from './tools/playwright-browser';
export {
  ActionHandler,
  type ActionKind,
  type ActionResult,
  type OperatorAction,
} from './viewer/actions';
export {
  AIAssist,
  type AISuggestion,
  type AssistRequest,
} from './viewer/ai-assist';
export {
  type AnalyticsSnapshot,
  AnalyticsStore,
  type RollupPeriod,
  type TimeSeriesPoint,
} from './viewer/analytics';
export {
  type AgentSettingsConfig,
  type AgentSettingsOverride,
  type BrowserConfig,
  type BrowserConfigOverride,
  ConfigStore,
  createProject,
  type DataSourceConfig,
  defaultConfig,
  defaultProjectAgents,
  defaultProjectLayers,
  defaultProjectSources,
  type ExecutionEnv,
  type FoundryConfig,
  type InvocationConditionOverride,
  type LayerSettingsConfig,
  type LayerSettingsOverride,
  type ListPatch,
  PROJECT_LAYER,
  type ProjectPrompts,
  type ProjectSettingsConfig,
  projectSources,
  starterConfig,
} from './viewer/config';
export type {
  FieldProvenance,
  ResolvedLayerDefinition,
  ResolvedProjectView,
} from './viewer/config-resolve';
// Viewer
export {
  createViewer,
  startViewer,
  type ViewerConfig,
} from './viewer/server';
export {
  FoundryTunnel,
  type TunnelConfig,
  type TunnelInfo,
  tunnelAuth,
} from './viewer/tunnel';
