// ---------------------------------------------------------------------------
// @inixiative/foundry-core — the engine
// ---------------------------------------------------------------------------

// Action Prompts (agent→human interaction)
export {
  type ActionOption,
  type ActionPrompt,
  ActionQueue,
  type ActionResolution,
  type PromptKind,
  type PromptListener,
  type PromptOpts,
  type PromptPolicy,
  type PromptStatus,
  type PromptUrgency,
} from './action-prompt';
// Lightweight adapters (zero external deps)
export {
  DEFAULT_MEMORY_SELECTION,
  entryVisibleTo,
  FileMemory,
  fileSource,
  focusTerms,
  inlineSource,
  type MemoryEntry,
  type MemoryReadScope,
  type MemorySelectionPolicy,
  type MemorySelectionReport,
  type MemorySourceOpts,
  MemoryView,
  selectMemory,
  validateMemorySelection,
} from './adapters/file-memory';
export { HttpMemory } from './adapters/http-memory';
export { claudemdSource, MarkdownDocs } from './adapters/markdown-docs';
export { type SqliteEntry, SqliteMemory } from './adapters/sqlite-memory';
// Agent primitives
export {
  type AgentConfig,
  type AgentLLMConfig,
  BaseAgent,
  type ExecutionResult,
} from './base-agent';
// Bounded data structures
export { BoundedSet } from './bounded-set';
export {
  CacheLifecycle,
  type LifecycleEvent,
  type LifecycleHandler,
  type LifecycleRule,
} from './cache-lifecycle';
// Capabilities (permission flags + gating)
export {
  BROWSER_POLICY,
  type BuiltinCapability,
  type Capability,
  CapabilityDeniedError,
  CapabilityGate,
  type GateContext,
  type PermissionLevel,
  type PermissionPolicy,
  RESTRICTED_POLICY,
} from './capability';
export {
  type ClarificationResult,
  Clarifier,
  type ClarifierConfig,
  type ClarifyHandler,
  type ClarifyPayload,
} from './clarifier';
export {
  type Classification,
  Classifier,
  type ClassifierConfig,
  type ClassifyHandler,
} from './classifier';
// Context primitives
export {
  ContextLayer,
  type ContextLayerConfig,
  type ContextSource,
  computeHash,
  copyMessageIdentity,
  isLayerSegment,
  LAYER_SEGMENTS,
  type LayerDefinition,
  type LayerInstanceState,
  type LayerMutationEvent,
  type LayerSegment,
  type LayerSelectionState,
  type LayerState,
  type LayerVersionMark,
  type LogicalMessageIdentity,
  REQUIRED_CONTEXT_BLOCKED,
  type SourceLoadHint,
  type SourceSelectionReport,
  type VersionEntry,
  type VersionLog,
} from './context-layer';
export {
  type AssembledContext,
  type ContextSnapshot,
  ContextStack,
  type ContextStackView,
  type LayerFilter,
  type PromptBlock,
} from './context-stack';
export type { CredentialReference, CredentialResolver, CredentialScope } from './credentials';
export { type DecideHandler, Decider, type DeciderConfig, type Decision } from './decider';
export type {
  DeliveryOwner,
  ExpertDeliveryProof,
  ProviderBoundaryReceipt,
} from './delivery-evidence';
export {
  assemblyDigest,
  boundaryReceipt,
  evidenceDigest,
  verifyExpertDelivery,
} from './delivery-evidence';
// Observability
export { EventStream, type SessionEvent, type StreamEvent } from './event-stream';
export { type ExecuteHandler, type ExecuteMeta, Executor, type ExecutorConfig } from './executor';
export {
  type FlowConfig,
  type FlowStage,
  Harness,
  type HarnessResult,
  type Message,
  matchesCondition,
  type PipelineStep,
  type RequestContext,
} from './harness';

// Lifecycle Hooks (registry only — built-in hooks in @inixiative/foundry)
export {
  type HookContext,
  type HookHandler,
  type HookPoint,
  HookRegistry,
  type HookResult,
  type PlanModeConfig,
  type PlanModeTrigger,
} from './hooks';
export {
  type ContextRef,
  type HydrationAdapter,
  HydrationRegistry,
  RefSource,
} from './hydrator';
// IDs (UUID v7 — carries its own creation timestamp)
export { idAtTime, newId, timeFromId } from './id';
// Interventions
export { type Intervention, InterventionLog } from './intervention';
// Message utilities
export {
  assembledToMessages,
  type BuildInjectionArtifactOpts,
  buildInjectionArtifact,
  type DecorationParticipant,
  type DeliveryRecord,
  type InjectionArtifact,
  type InjectionBlock,
  type InjectionSegmentKind,
  type MessageDecoration,
  type ParticipantRequest,
  splitSystemMessage,
} from './messages';
// Middleware
export {
  type DispatchContext,
  type DispatchOutcome,
  type Middleware,
  MiddlewareChain,
  type MiddlewareEntry,
  type MiddlewareNext,
  type MiddlewareTier,
} from './middleware';
export {
  type CostTier,
  DECISION_MODEL,
  DECISION_PROVIDER,
  type DecisionModelDefaults,
  type FoundryModelInfo,
  type FoundryProviderInfo,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  type ModelCapability,
  type ModelReasoning,
  type ModelSweepOption,
  type ModelTier,
  modelCapabilities,
  modelHasCapability,
  modelOptionsByCapability,
  type ProviderCredential,
  type ProviderType,
  providersWithCapability,
  type ReasoningEffort,
  type RuntimeKind,
  registryModel,
  resolveDecisionModel,
} from './model-registry';
export * from './native-evidence';
// Permission middleware
export {
  type PermissionCheck,
  type PermissionCheckResult,
  type PermissionMiddlewareConfig,
  permissionMiddleware,
} from './permission-middleware';
// Retry middleware
export { type RetryConfig, retryMiddleware } from './retry';
export { type Route, type RouteHandler, Router, type RouterConfig } from './router';
// Ownership scope — which thread/project owns a source read or tool call
export { normalizeScope, type OwnershipScope } from './scope';
// Signals
export { type Signal, SignalBus, type SignalHandler, type SignalKind } from './signal';
// Orchestration
export {
  type Dispatch,
  type DispatchObservation,
  type DispatchOptions,
  type FanResult,
  Thread,
  type ThreadConfig,
  type ThreadContext,
  type ThreadMeta,
  type ThreadName,
  type ThreadReference,
  type ThreadStatus,
  threadTitle,
} from './thread';
export { sumTokenCounts, type TokenCounts, totalTokenCount } from './token-counts';
// Token & Cost Tracking
export {
  type BudgetConfig,
  BudgetExceededError,
  type BudgetStatus,
  type CostTable,
  DEFAULT_COST_TABLE,
  estimateTokens,
  type ModelPricing,
  TokenTracker,
  type TokenUsage,
  type UsageBreakdown,
  type UsageEntry,
  type UsageSummary,
} from './token-tracker';
// Tools — typed execution interfaces
export {
  type ApiRequest,
  type ApiResponse,
  type ApiTool,
  type ApiToolConfig,
  type BrowserTool,
  type MemoryEntry as ToolMemoryEntry,
  type MemorySearchOpts,
  type MemoryTool,
  type MemoryVisibility,
  type NavigateOpts,
  type OutputFilter,
  type PageElement,
  type PageSnapshot,
  type ScriptOpts,
  type ScriptResult,
  type ScriptTool,
  type ShellOpts,
  type ShellResult,
  type ShellTool,
  type Tool,
  type ToolCallObservation,
  type ToolInfo,
  type ToolKind,
  ToolRegistry,
  type ToolResult,
} from './tools';
// Tracing
export {
  type Span,
  type SpanKind,
  type SpanStatus,
  type StageSummary,
  Trace,
  type TraceSummary,
} from './trace';
// Shared types
export type {
  AgentModeConfig,
  CompletionOpts,
  CompletionResult,
  EmbeddingProvider,
  EmbeddingResult,
  InvocationCondition,
  LayerModeConfig,
  LLMMessage,
  LLMProvider,
  LLMStreamEvent,
  ToolCall,
  ToolCallResult,
  ToolDefinition,
} from './types';
