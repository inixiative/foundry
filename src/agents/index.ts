// Context primitives
export {
  ContextLayer,
  computeHash,
  type ContextSource,
  type ContextLayerConfig,
  type LayerState,
} from "./context-layer";

export {
  ContextStack,
  type Compressor,
  type LayerFilter,
  type ContextSnapshot,
  type PromptBlock,
  type AssembledContext,
} from "./context-stack";

export {
  CacheLifecycle,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
} from "./cache-lifecycle";

// Hydration
export {
  HydrationRegistry,
  RefSource,
  type ContextRef,
  type HydrationAdapter,
} from "./hydrator";

// Agent primitives
export {
  BaseAgent,
  type ExecutionResult,
  type AgentConfig,
  type AgentLLMConfig,
} from "./base-agent";

export {
  Executor,
  type ExecuteHandler,
  type ExecutorConfig,
} from "./executor";

export {
  Decider,
  type Decision,
  type DecideHandler,
  type DeciderConfig,
} from "./decider";

export {
  Classifier,
  type Classification,
  type ClassifyHandler,
  type ClassifierConfig,
} from "./classifier";

export {
  Router,
  type Route,
  type RouteHandler,
  type RouterConfig,
} from "./router";

export {
  Clarifier,
  type ClarifyPayload,
  type ClarificationResult,
  type ClarifyHandler,
  type ClarifierConfig,
} from "./clarifier";

// Middleware
export {
  MiddlewareChain,
  type Middleware,
  type MiddlewareTier,
  type MiddlewareEntry,
  type DispatchContext,
  type DispatchOutcome,
  type MiddlewareNext,
} from "./middleware";

// Signals
export {
  SignalBus,
  type Signal,
  type SignalKind,
  type SignalHandler,
} from "./signal";

// Orchestration
export {
  Thread,
  type ThreadStatus,
  type ThreadMeta,
  type ThreadConfig,
  type Dispatch,
  type FanResult,
} from "./thread";
export {
  Harness,
  matchesCondition,
  type Message,
  type HarnessResult,
  type PipelineStep,
  type FlowStage,
  type FlowConfig,
  type RequestContext,
} from "./harness";

// Tracing
export {
  Trace,
  type Span,
  type SpanKind,
  type SpanStatus,
  type TraceSummary,
  type StageSummary,
} from "./trace";

// Sessions
export {
  SessionManager,
  type ThreadBlueprint,
  type LayerInheritance,
  type SessionEvent,
} from "./session";

// Interventions
export {
  InterventionLog,
  type Intervention,
} from "./intervention";

// Observability
export {
  EventStream,
  type StreamEvent,
} from "./event-stream";

// Token & Cost Tracking
export {
  TokenTracker,
  BudgetExceededError,
  estimateTokens,
  DEFAULT_COST_TABLE,
  type TokenUsage,
  type UsageEntry,
  type ModelPricing,
  type CostTable,
  type BudgetConfig,
  type BudgetStatus,
  type UsageBreakdown,
  type UsageSummary,
} from "./token-tracker";

// Compaction Strategies
export {
  TrustBasedStrategy,
  LRUStrategy,
  SummarizeStrategy,
  HybridStrategy,
  type CompactionStrategy,
  type CompactionPlan,
  type CompactionOpts,
  type LayerSnapshot,
  type LLMProvider as CompactionLLMProvider,
  type HybridThresholds,
} from "./compaction";

// Lifecycle Hooks
export {
  HookRegistry,
  type HookPoint,
  type HookContext,
  type HookResult,
  type HookHandler,
  type PlanModeConfig,
  type PlanModeTrigger,
} from "./hooks";

// Planner Agent
export {
  Planner,
  type Plan,
  type PlanStep,
  type PlannerConfig,
  type PlanExecutionResult,
} from "./planner";

// Active Memory (Levin-inspired)
export {
  ActiveMemory,
  type AccessRecord,
  type CompetitionResult,
  type ActiveMemoryConfig,
  type LayerStats,
} from "./active-memory";

// Corpus Compiler
export {
  CorpusCompiler,
  type FluidEntry,
  type FormalDoc,
  type DocState,
  type CompiledCorpus,
  type CorpusTier,
  type CorpusCompilerConfig,
} from "./corpus-compiler";

// Project — top-level container above threads
export {
  Project,
  ProjectRegistry,
  fromSettingsConfig,
  type ProjectConfig,
  type ProjectStatus,
  type ProjectSummary,
} from "./project";

// Thread Factory
export {
  ThreadFactory,
  keywordClassify,
  keywordRoute,
  parseJSON,
  type SourceResolver,
  type ThreadFactoryDeps,
} from "./thread-factory";

// Reactive Middleware
export {
  ReactiveMiddleware,
  lowConfidenceRule,
  classificationOverrideRule,
  rewarmOnAgentRule,
  emitOnPatternRule,
  type ReactionRule,
  type ReactionContext,
  type ReactiveMiddlewareConfig,
} from "./reactive";

// Herald — cross-agent observation & coordination
export {
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
} from "./herald";
