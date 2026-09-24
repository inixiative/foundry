// Provider types — re-exported from core
export {
  type LLMProvider,
  type LLMMessage,
  type CompletionOpts,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  type LLMStreamEvent,
  assembledToMessages,
  splitSystemMessage,
} from "@inixiative/foundry-core";

// LLM Providers (API-level)
export { ClaudeCodeProvider, type ClaudeCodeConfig as ClaudeCodeProviderConfig } from "./claude-code";
export { AnthropicProvider, VoyageEmbeddingProvider, type AnthropicConfig } from "./anthropic";
export {
  OpenAIProvider,
  OpenAIEmbeddingProvider,
  createCursorProvider,
  createOllamaProvider,
  openAiApiRoot,
  type OpenAIConfig,
} from "./openai";
export {
  createRegisteredProvider,
  providerApiRoot,
  providerApiKey,
  providerReasoning,
  registeredProvider,
  type RegisteredProviderConfig,
} from "./openai-compatible";
export { GeminiProvider, GeminiEmbeddingProvider, type GeminiConfig } from "./gemini";

// Gated provider (capability-checked wrapper)
export { GatedProvider, type GatedProviderConfig } from "./gated";
export { SessionBackedProvider, formatMessagesForNativeSession, type SessionBackedProviderConfig } from "./session-backed";

// HarnessSession + ClaudeCodeSession — re-exported from @inixiative/agent-session
// (the single source of truth for agent-driving sessions across the ecosystem).
export {
  type HarnessSession,
  type SessionEvent,
  type SessionEventKind,
  type SessionEventHandler,
  type SessionResult,
  type SessionTokens,
  type SessionArtifact,
  ClaudeCodeSession,
  CodexSession,
  type ClaudeCodeSessionConfig,
  type CodexSessionConfig,
} from "@inixiative/agent-session";

// SessionAdapter — maps Foundry thread IDs ↔ runtime native session IDs
export {
  type SessionAdapter,
  type CreateSessionOpts,
  type ExternalSessionStore,
  InMemoryExternalSessionStore,
  FileExternalSessionStore,
  ClaudeCodeSessionAdapter,
  CodexSessionAdapter,
  type ClaudeCodeSessionAdapterConfig,
  type CodexSessionAdapterConfig,
} from "./session-adapter";

// Runtime Adapters (context injection into agent runtimes)
export {
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventKind,
  type RuntimeEventHandler,
  type ContextInjection,
  ClaudeCodeRuntime,
  CodexRuntime,
  CursorRuntime,
  type ClaudeCodeConfig,
  type CodexConfig,
  type CursorConfig,
} from "./runtime";

export { NativeAuthentication, type NativeAuthenticationSource, type NativeAuthenticationLaunch } from "./native-authentication";

export { KastleAuthentication, type KastleSource, type KastleAssignment } from "./kastle-authentication";
export { KastleClient, type KastleSelection, type KastleRunEnvelope } from "./kastle-client";

// Typed Jev decisions and opt-in dispatch middleware.
export { TypeSafeDecisionClient, TypeSafeError, type TypeSafeClientOptions, type TypeSafeContent, type TypeSafeValue, type TypeSafeQuestion, type TypeSafeQuestions, type TypeSafeAnswer, type TypeSafeResult } from "./typesafe";
export { createTypeSafeMiddleware, type TypeSafeMiddlewareOptions } from "./typesafe-middleware";
export { TypeSafeShadowRunner, type TypeSafeShadowOptions, type TypeSafeShadowCatalog, type TypeSafeShadowResult, type TypeSafeShadowStage } from "./typesafe-shadow";

export { createNativeTextProvider, type NativeTextConfig, type NativeTextCall } from "./native-text-provider";
export { type ClaudeContextBudget } from "./claude-context-budget";
