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

// Runtime Adapters (harness-level hooks for agent runtimes)
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
