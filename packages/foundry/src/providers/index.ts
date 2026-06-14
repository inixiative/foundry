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
  type OpenAIConfig,
} from "./openai";
export { GeminiProvider, GeminiEmbeddingProvider, type GeminiConfig } from "./gemini";

// Gated provider (capability-checked wrapper)
export { GatedProvider, type GatedProviderConfig } from "./gated";

// HarnessSession + ClaudeCodeSession — re-exported from @inixiative/agent-session
// (the single source of truth for agent-driving sessions across the ecosystem).
export {
  type HarnessSession,
  type SessionEvent,
  type SessionEventKind,
  type SessionEventHandler,
  type SessionResult,
  type SessionArtifact,
  ClaudeCodeSession,
  type ClaudeCodeSessionConfig,
} from "@inixiative/agent-session";

// SessionAdapter — maps Foundry thread IDs ↔ runtime native session IDs
export {
  type SessionAdapter,
  type CreateSessionOpts,
  type ExternalSessionStore,
  InMemoryExternalSessionStore,
  FileExternalSessionStore,
  ClaudeCodeSessionAdapter,
  type ClaudeCodeSessionAdapterConfig,
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
