// ---------------------------------------------------------------------------
// @inixiative/foundry-core — the engine
// ---------------------------------------------------------------------------

// Shared types
export type {
  InvocationCondition,
  AgentModeConfig,
  LayerModeConfig,
  LLMMessage,
  CompletionOpts,
  CompletionResult,
  ToolDefinition,
  ToolCall,
  ToolCallResult,
  EmbeddingResult,
  LLMStreamEvent,
  LLMProvider,
  EmbeddingProvider,
} from "./types";

// Message utilities
export { assembledToMessages, splitSystemMessage } from "./messages";

// Context primitives
export {
  ContextLayer,
  computeHash,
  type ContextSource,
  type ContextLayerConfig,
  type LayerDefinition,
  type LayerInstanceState,
  type LayerMutationEvent,
  type LayerState,
  type VersionEntry,
  type VersionLog,
} from "./context-layer";

export {
  ContextStack,
  type Compressor,
  type LayerFilter,
  type ContextSnapshot,
  type ContextStackView,
  type PromptBlock,
  type AssembledContext,
} from "./context-stack";

export {
  CacheLifecycle,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
} from "./cache-lifecycle";

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

export { Executor, type ExecuteHandler, type ExecutorConfig } from "./executor";
export { Decider, type Decision, type DecideHandler, type DeciderConfig } from "./decider";
export { Classifier, type Classification, type ClassifyHandler, type ClassifierConfig } from "./classifier";
export { Router, type Route, type RouteHandler, type RouterConfig } from "./router";

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
export { SignalBus, type Signal, type SignalKind, type SignalHandler } from "./signal";

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
export { Trace, type Span, type SpanKind, type SpanStatus, type TraceSummary, type StageSummary } from "./trace";

// Interventions
export { InterventionLog, type Intervention } from "./intervention";

// Observability
export { EventStream, type StreamEvent, type SessionEvent } from "./event-stream";

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

// Compaction interfaces (strategies in @inixiative/foundry)
export type {
  CompactionStrategy,
  CompactionPlan,
  CompactionOpts,
  LayerSnapshot,
  CompactionLLMProvider,
} from "./compaction";

// Lifecycle Hooks (registry only — built-in hooks in @inixiative/foundry)
export {
  HookRegistry,
  type HookPoint,
  type HookContext,
  type HookResult,
  type HookHandler,
  type PlanModeConfig,
  type PlanModeTrigger,
} from "./hooks";

// Action Prompts (agent→human interaction)
export {
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
} from "./action-prompt";

// Capabilities (permission flags + gating)
export {
  CapabilityGate,
  CapabilityDeniedError,
  UNATTENDED_POLICY,
  SUPERVISED_POLICY,
  RESTRICTED_POLICY,
  BROWSER_POLICY,
  type Capability,
  type BuiltinCapability,
  type PermissionLevel,
  type PermissionPolicy,
  type GateContext,
} from "./capability";

// Lightweight adapters (zero external deps)
export {
  FileMemory,
  inlineSource,
  fileSource,
  type MemoryEntry,
} from "./adapters/file-memory";

export { SqliteMemory, type SqliteEntry } from "./adapters/sqlite-memory";
export { HttpMemory } from "./adapters/http-memory";
export { MarkdownDocs, claudemdSource } from "./adapters/markdown-docs";

// Tools — typed execution interfaces
export {
  ToolRegistry,
  type Tool,
  type ToolKind,
  type ToolInfo,
  type ToolResult,
  type BrowserTool,
  type PageSnapshot,
  type PageElement,
  type NavigateOpts,
  type ApiTool,
  type ApiRequest,
  type ApiResponse,
  type ApiToolConfig,
  type ShellTool,
  type ShellResult,
  type ShellOpts,
  type OutputFilter,
  type ScriptTool,
  type ScriptResult,
  type ScriptOpts,
  type MemoryTool,
  type MemoryEntry as ToolMemoryEntry,
  type MemorySearchOpts,
} from "./tools";

// Bounded data structures
export { BoundedSet } from "./bounded-set";

// Retry middleware
export { retryMiddleware, type RetryConfig } from "./retry";

// Permission middleware
export {
  permissionMiddleware,
  type PermissionMiddlewareConfig,
  type PermissionCheck,
  type PermissionCheckResult,
} from "./permission-middleware";
