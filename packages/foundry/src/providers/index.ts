// Provider types — re-exported from core

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
export {
  assembledToMessages,
  type CompletionOpts,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  type LLMMessage,
  type LLMProvider,
  type LLMStreamEvent,
  splitSystemMessage,
} from '@inixiative/foundry-core';
export { type AnthropicConfig, AnthropicProvider, VoyageEmbeddingProvider } from './anthropic';
// LLM Providers (API-level)
export {
  type ClaudeCodeConfig as ClaudeCodeProviderConfig,
  ClaudeCodeProvider,
} from './claude-code';
export type { ClaudeContextBudget } from './claude-context-budget';
export { type GeminiConfig, GeminiEmbeddingProvider, GeminiProvider } from './gemini';
export {
  KingdomAuthentication,
  type KingdomInferenceAssignment,
  type KingdomInferenceSource,
} from './kingdom-authentication';
export { KingdomClient, type KingdomRunEnvelope, type KingdomSelection } from './kingdom-client';
export {
  NativeAuthentication,
  type NativeAuthenticationLaunch,
  type NativeAuthenticationSource,
} from './native-authentication';
export {
  createNativeTextProvider,
  type NativeTextCall,
  type NativeTextConfig,
} from './native-text-provider';
export {
  createCursorProvider,
  createOllamaProvider,
  type OpenAIConfig,
  OpenAIEmbeddingProvider,
  OpenAIProvider,
  openAiApiRoot,
} from './openai';
export {
  createRegisteredProvider,
  providerApiKey,
  providerApiRoot,
  providerReasoning,
  type RegisteredProviderConfig,
  registeredProvider,
} from './openai-compatible';
// Runtime Adapters (context injection into agent runtimes)
export {
  type ClaudeCodeConfig,
  ClaudeCodeRuntime,
  type CodexConfig,
  CodexRuntime,
  type ContextInjection,
  type CursorConfig,
  CursorRuntime,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeEventHandler,
  type RuntimeEventKind,
} from './runtime';
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
} from './session-adapter';
export {
  formatMessagesForNativeSession,
  SessionBackedProvider,
  type SessionBackedProviderConfig,
} from './session-backed';
// Typed Jev decisions and opt-in dispatch middleware.
export {
  type TypeSafeAnswer,
  type TypeSafeClientOptions,
  type TypeSafeContent,
  TypeSafeDecisionClient,
  TypeSafeError,
  type TypeSafeQuestion,
  type TypeSafeQuestions,
  type TypeSafeResult,
  type TypeSafeValue,
} from './typesafe';
export { createTypeSafeMiddleware, type TypeSafeMiddlewareOptions } from './typesafe-middleware';
export {
  type TypeSafeShadowCatalog,
  type TypeSafeShadowOptions,
  type TypeSafeShadowResult,
  TypeSafeShadowRunner,
  type TypeSafeShadowStage,
} from './typesafe-shadow';
