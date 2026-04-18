// Re-export everything from core
export {
  // Context primitives
  ContextLayer,
  computeHash,
  type ContextSource,
  type ContextLayerConfig,
  type LayerState,
  ContextStack,
  type LayerFilter,
  type ContextSnapshot,
  type PromptBlock,
  type AssembledContext,
  CacheLifecycle,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
  // Hydration
  HydrationRegistry,
  RefSource,
  type ContextRef,
  type HydrationAdapter,
  // Agent primitives
  BaseAgent,
  type ExecutionResult,
  type AgentConfig,
  type AgentLLMConfig,
  Executor,
  type ExecuteHandler,
  type ExecuteMeta,
  type ExecutorConfig,
  Decider,
  type Decision,
  type DecideHandler,
  type DeciderConfig,
  Classifier,
  type Classification,
  type ClassifyHandler,
  type ClassifierConfig,
  Router,
  type Route,
  type RouteHandler,
  type RouterConfig,
  // Middleware
  MiddlewareChain,
  type Middleware,
  type MiddlewareTier,
  type MiddlewareEntry,
  type DispatchContext,
  type DispatchOutcome,
  type MiddlewareNext,
  // Signals
  SignalBus,
  type Signal,
  type SignalKind,
  type SignalHandler,
  // Orchestration
  Thread,
  type ThreadStatus,
  type ThreadMeta,
  type ThreadConfig,
  type Dispatch,
  type FanResult,
  Harness,
  matchesCondition,
  type Message,
  type HarnessResult,
  type PipelineStep,
  type FlowStage,
  type FlowConfig,
  type RequestContext,
  // Tracing
  Trace,
  type Span,
  type SpanKind,
  type SpanStatus,
  type TraceSummary,
  type StageSummary,
  // Interventions
  InterventionLog,
  type Intervention,
  // Observability
  EventStream,
  type StreamEvent,
  type SessionEvent,
  // Token & Cost Tracking
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
  // Hooks
  HookRegistry,
  type HookPoint,
  type HookContext,
  type HookResult,
  type HookHandler,
  type PlanModeConfig,
  type PlanModeTrigger,
  // Action prompts
  ActionQueue,
  type ActionPrompt,
  type ActionResolution,
  type ActionOption,
  type PromptKind,
  type PromptUrgency,
  type PromptStatus,
  type PromptOpts,
  type PromptListener,
  type PromptPolicy,
  // Capability gate
  CapabilityGate,
  CapabilityDeniedError,
  UNATTENDED_POLICY,
  SUPERVISED_POLICY,
  RESTRICTED_POLICY,
  type Capability,
  type BuiltinCapability,
  type PermissionLevel,
  type PermissionPolicy,
  type GateContext,
} from "@inixiative/foundry-core";

// Foundry-specific: built-in hooks
export {
  planModeHook,
  budgetGuardHook,
  type HookTokenTracker,
} from "./builtin-hooks";

// Sessions
export {
  SessionManager,
  type ThreadBlueprint,
  type LayerInheritance,
} from "./session";

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
} from "./thread-factory";

// Tool-use loop
export { toolUseLoop, type ToolLoopOpts } from "./tool-loop";

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
  type VisibilityTier,
  type LayerVisibility,
  type ThreadSnapshot,
  type HeraldPattern,
  type HeraldRecommendation,
  type PatternDetector,
  type HeraldConfig,
} from "./herald";

// Librarian — sole writer to thread-state layer
export {
  Librarian,
  type ThreadState,
  type InjectedLayerRecord,
  type LibrarianConfig,
} from "./librarian";

// Domain Librarian — shared advise + guard pattern
export {
  DomainLibrarian,
  type DomainLibrarianConfig,
  type ProcessingStrategy,
  type RuleCompiler,
  type AdviseResult,
  type GuardFinding,
  type GuardResult,
  type ToolObservation,
} from "./domain-librarian";

// Cartographer — context routing (reads map, routes slices)
export {
  Cartographer,
  type CartographerConfig,
  type MapEntry,
  type TopologyMap,
  type RouteResult,
} from "./cartographer";

// Flow Orchestrator — wires the five FLOW.md roles together
export {
  FlowOrchestrator,
  type FlowOrchestratorConfig,
  type InjectionPlan,
  type HydrationResult,
  type GuardReport,
  type InvalidationEvent,
} from "./flow-orchestrator";
