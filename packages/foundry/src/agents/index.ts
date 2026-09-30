// Re-export everything from core
export {
  type ActionOption,
  type ActionPrompt,
  // Action prompts
  ActionQueue,
  type ActionResolution,
  type AgentConfig,
  type AgentLLMConfig,
  type AssembledContext,
  // Agent primitives
  BaseAgent,
  type BudgetConfig,
  BudgetExceededError,
  type BudgetStatus,
  type BuiltinCapability,
  CacheLifecycle,
  type Capability,
  CapabilityDeniedError,
  // Capability gate
  CapabilityGate,
  type Classification,
  Classifier,
  type ClassifierConfig,
  type ClassifyHandler,
  // Context primitives
  ContextLayer,
  type ContextLayerConfig,
  type ContextRef,
  type ContextSnapshot,
  type ContextSource,
  ContextStack,
  type CostTable,
  computeHash,
  DEFAULT_COST_TABLE,
  type DecideHandler,
  Decider,
  type DeciderConfig,
  type Decision,
  type Dispatch,
  type DispatchContext,
  type DispatchOutcome,
  // Observability
  EventStream,
  type ExecuteHandler,
  type ExecuteMeta,
  type ExecutionResult,
  Executor,
  type ExecutorConfig,
  estimateTokens,
  type FanResult,
  type FlowConfig,
  type FlowStage,
  type GateContext,
  Harness,
  type HarnessResult,
  type HookContext,
  type HookHandler,
  type HookPoint,
  // Hooks
  HookRegistry,
  type HookResult,
  type HydrationAdapter,
  // Hydration
  HydrationRegistry,
  type Intervention,
  // Interventions
  InterventionLog,
  type LayerFilter,
  type LayerState,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
  type Message,
  type Middleware,
  // Middleware
  MiddlewareChain,
  type MiddlewareEntry,
  type MiddlewareNext,
  type MiddlewareTier,
  type ModelPricing,
  matchesCondition,
  type PermissionLevel,
  type PermissionPolicy,
  type PipelineStep,
  type PlanModeConfig,
  type PlanModeTrigger,
  type PromptBlock,
  type PromptKind,
  type PromptListener,
  type PromptOpts,
  type PromptPolicy,
  type PromptStatus,
  type PromptUrgency,
  RESTRICTED_POLICY,
  RefSource,
  type RequestContext,
  type Route,
  type RouteHandler,
  Router,
  type RouterConfig,
  type SessionEvent,
  type Signal,
  // Signals
  SignalBus,
  type SignalHandler,
  type SignalKind,
  type Span,
  type SpanKind,
  type SpanStatus,
  type StageSummary,
  type StreamEvent,
  // Orchestration
  Thread,
  type ThreadConfig,
  type ThreadMeta,
  type ThreadStatus,
  // Token & Cost Tracking
  TokenTracker,
  type TokenUsage,
  // Tracing
  Trace,
  type TraceSummary,
  type UsageBreakdown,
  type UsageEntry,
  type UsageSummary,
} from '@inixiative/foundry-core';

// Foundry-specific: built-in hooks
export {
  budgetGuardHook,
  type HookTokenTracker,
  planModeHook,
} from './builtin-hooks';
// Cartographer — context routing (reads map, routes slices)
export {
  Cartographer,
  type CartographerConfig,
  type MapEntry,
  type RouteResult,
  type TopologyMap,
} from './cartographer';
// Corpus Compiler
export {
  type CompiledCorpus,
  CorpusCompiler,
  type CorpusCompilerConfig,
  type CorpusTier,
  type DocState,
  type FluidEntry,
  type FormalDoc,
} from './corpus-compiler';
// Domain Librarian — shared advise + guard pattern
export {
  type AdviseOpts,
  type AdviseResult,
  DomainLibrarian,
  type DomainLibrarianConfig,
  type GuardFinding,
  type GuardResult,
  type KnowledgeEvidence,
  type KnowledgeOwner,
  type LearningDecision,
  type LearningRecord,
  type ProcessingStrategy,
  type ReviewInput,
  type ReviewResult,
  type RuleCompiler,
  ThreadKnowledge,
  type ThreadKnowledgeSnapshot,
  type ToolObservation,
} from './domain-librarian';
// Flow Orchestrator — wires the five FLOW.md roles together
export {
  type ContributionDecision,
  type ContributionProvenance,
  type ContributionSegments,
  type DeliveryEvidence,
  type DomainContribution,
  FlowOrchestrator,
  type FlowOrchestratorConfig,
  type FlowTimingConfig,
  type GuardReport,
  type HydrationResult,
  type InjectionPlan,
  type InvalidationEvent,
  type LayerRevision,
  type OutstandingCall,
  type PlanInput,
  type RoutingOutcome,
  type RoutingStatus,
} from './flow-orchestrator';
// Herald — cross-agent observation & coordination
export {
  ContradictionDetector,
  ConvergenceDetector,
  CrossPollinationDetector,
  DuplicationDetector,
  Herald,
  type HeraldConfig,
  type HeraldPattern,
  type HeraldRecommendation,
  type LayerVisibility,
  type PatternDetector,
  ResourceImbalanceDetector,
  type ThreadSnapshot,
  type VisibilityTier,
} from './herald';
// Librarian — sole writer to thread-state layer
export {
  type InjectedLayerRecord,
  Librarian,
  type LibrarianConfig,
  type ThreadState,
} from './librarian';
// Planner Agent
export {
  type Plan,
  type PlanExecutionResult,
  Planner,
  type PlannerConfig,
  type PlanStep,
} from './planner';
// Project — top-level container above threads
export {
  fromSettingsConfig,
  Project,
  type ProjectConfig,
  ProjectRegistry,
  type ProjectStatus,
  type ProjectSummary,
} from './project';
// Reactive Middleware
export {
  classificationOverrideRule,
  emitOnPatternRule,
  lowConfidenceRule,
  type ReactionContext,
  type ReactionRule,
  ReactiveMiddleware,
  type ReactiveMiddlewareConfig,
  rewarmOnAgentRule,
} from './reactive';
// Sessions
export {
  type LayerInheritance,
  SessionManager,
  type ThreadBlueprint,
} from './session';
// Thread Factory
export {
  type BuildAgentsDeps,
  type BuildLayersDeps,
  buildAgents,
  buildLayers,
  createSourceResolver,
  keywordClassify,
  keywordRoute,
  parseJSON,
  resolveAgentOpts,
  type SourceResolver,
  type SourceResolverDeps,
  ThreadFactory,
  type ThreadFactoryDeps,
} from './thread-factory';
// Thread Runtime — per-thread Librarian, Cartographer, Wardens, orchestrator, bridges
export {
  auxiliarySessionId,
  type CorrelatedToolObservation,
  DEFAULT_THREAD_DOMAINS,
  type LearningConfig,
  type ScopedProviderIdentity,
  type SignalSink,
  scopedProvider,
  type ThreadDomainConfig,
  type ThreadKnowledgeBundle,
  type ThreadRuntime,
  type ThreadRuntimeDeps,
  ThreadRuntimeManager,
  type ToolEvidenceState,
} from './thread-runtime';
// Tool-use loop
export { type ToolLoopOpts, toolUseLoop } from './tool-loop';

// Workstream-overload detector (Herald PatternDetector for intra-thread topology)
export {
  DEFAULT_CONTEXT_HASH_DIVERGENCE,
  DEFAULT_DISTINCT_AGENT_THRESHOLD,
  DEFAULT_DISTINCT_SIGNAL_SOURCES,
  DEFAULT_WINDOW_MS as WORKSTREAM_DETECTOR_DEFAULT_WINDOW_MS,
  WORKSTREAM_DETECTOR_PROMPT,
  WorkstreamOverloadDetector,
  type WorkstreamOverloadEvidence,
  type WorkstreamOverloadOptions,
} from './workstream-detector';
