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
export {
  claudemdSource,
  formatInstructionFiles,
  type InstructionFile,
  type InstructionReadOptions,
  instructionImports,
  MarkdownDocs,
  readInstructionFile,
  resolveInstructionImport,
  secretInstructionPath,
  stripInstructionComments,
  withinAny,
  withinPath,
} from './adapters/markdown-docs';
export {
  dedupeHierarchy,
  dedupeHierarchySlots,
  discoverHierarchy,
  expandHierarchyPath,
  type HierarchyDedupeOptions,
  type HierarchyDiscoverOptions,
  type HierarchyDuplicate,
  type HierarchyDuplicateKind,
  type HierarchyFile,
  type HierarchyFileSource,
  type HierarchyLocation,
  type HierarchyMatch,
  type HierarchyNode,
  type HierarchyRefusal,
  type HierarchySlotDuplicate,
  type HierarchySource,
  type HierarchySpan,
  type HierarchyStack,
  type HierarchyWalkSource,
  hierarchyFingerprint,
  markdownSections,
  type SelectedHierarchyNode,
  selectHierarchyNodes,
} from './adapters/markdown-hierarchy';
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
  permissionLevel,
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
  type CompositionSnapshot,
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
  type OmittedSource,
  REQUIRED_CONTEXT_BLOCKED,
  type SourceLoadHint,
  type SourcePart,
  type SourceSegment,
  type SourceSelectionReport,
  segmentsText,
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
// Feedback: correction detection (the Prospector's), shared by Oracle, live capture and `foundry repeats`
export {
  AGAIN_CORRECTION,
  CORRECTION_CATEGORIES,
  CORRECTION_CLASSIFY_PREFIX,
  CORRECTION_CLASSIFY_PROMPT,
  CORRECTION_PATTERNS,
  type CorrectionCategory,
  type CorrectionClassification,
  type CorrectionDetection,
  type CorrectionEvent,
  type CorrectionSignal,
  correctionClassifyMessages,
  correctionId,
  detectCorrection,
  extractCorrections,
  FEEDBACK_TAGS,
  type FeedbackTag,
  parseCorrectionClassifications,
  proseOf,
  scrubSecrets,
  type TranscriptTurn,
} from './feedback/correction';
export {
  AUTHORSHIP_MARKERS,
  authorshipOf,
  evidenceSnippet,
  type FindingScope,
  parseReviewFindings,
  REUSE_HINT,
  REVIEW_FINDINGS_PROMPT,
  type ReviewFinding,
  type ReviewMoment,
  type ReviewReading,
  reviewFindingMessages,
  SCOPE_WEIGHT,
  type SessionEvidence,
  styleOf,
} from './feedback/review-findings';
export {
  type DomainAgreement,
  fixtureProbe,
  labelAgreement,
  type ParsedWardenLabels,
  parseWardenLabels,
  type UnlabelledFixture,
  WARDEN_LABEL_PROMPT,
  type WardenFixture,
  type WardenLabel,
  type WardenRosterEntry,
  type WardenTriggerKind,
  wardenLabelMessages,
  wardenLabelPrefix,
} from './feedback/warden-labels';
export {
  PREFILTER_CONTEXT_CHARS,
  PREFILTER_DESCRIPTION_CHARS,
  PREFILTER_MOMENT_CHARS,
  PREFILTER_SWEEP,
  type PrefilterPair,
  type PrefilterPoint,
  type PrefilterScore,
  type PrefilterTrigger,
  percentiles,
  prefilterConsistency,
  prefilterDescription,
  prefilterQuestion,
  prefilterSkips,
  prefilterState,
  scorePrefilter,
} from './feedback/warden-prefilter';
export {
  type Authorship,
  type CharterScore,
  CONCEPT_CLUSTERS,
  CORRECTION_TARGET_PROMPT,
  type CorrectionTarget,
  correctionTargetMessages,
  MISS_KINDS,
  type MissKind,
  POINTER_LEVELS,
  type PointerLevel,
  type ProbeSource,
  parseCorrectionTargets,
  parseTargetCanonical,
  parseWardenJudgement,
  parseWardenPointerJudgement,
  probeTriggers,
  scoreCharterRun,
  TARGET_CANONICAL_PROMPT,
  targetCanonicalMessages,
  WARDEN_JUDGE_PROMPT,
  WARDEN_POINTER_JUDGE_PROMPT,
  type WardenJudgement,
  type WardenPointerJudgement,
  type WardenProbe,
  type WardenProbeAnswer,
  type WardenProbeTrigger,
  type WardenProbeTurn,
  wardenJudgeMessage,
  wardenPointerJudgeMessage,
} from './feedback/warden-probes';
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
export { type Intervention, InterventionLog, type InterventionThread } from './intervention';
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
  MAIN_THREAD_LABS,
  type MainThreadLab,
  MODEL_CAPABILITIES,
  MODEL_REGISTRY,
  MODEL_REGISTRY_UPDATED_AT,
  type ModelCapability,
  type ModelLab,
  type ModelReasoning,
  type ModelSweepOption,
  type ModelTier,
  mainThreadLab,
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
  SUBSCRIPTION_DECISION_MODELS,
} from './model-registry';
export * from './native-evidence';
// Retry middleware
export { type RetryConfig, retryMiddleware } from './retry';
export { type Route, type RouteHandler, Router, type RouterConfig } from './router';
// Ownership scope — which thread/project owns a source read or tool call
export { normalizeScope, type OwnershipScope } from './scope';
export {
  type DeliveredPart,
  layerPart,
  type SessionDelivery,
  type SessionDeliveryReport,
  type StandingPart,
  standingPart,
  standingParts,
} from './session-delivery';
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
  type ThreadSetup,
  type ThreadSpawn,
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
