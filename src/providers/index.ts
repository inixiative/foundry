// Provider types
export {
  type LLMProvider,
  type LLMMessage,
  type CompletionOpts,
  type CompletionResult,
  type EmbeddingProvider,
  type EmbeddingResult,
  assembledToMessages,
  splitSystemMessage,
} from "./types";

// LLM Providers (API-level)
export { AnthropicProvider, VoyageEmbeddingProvider, type AnthropicConfig } from "./anthropic";
export {
  OpenAIProvider,
  OpenAIEmbeddingProvider,
  createCursorProvider,
  createOllamaProvider,
  type OpenAIConfig,
} from "./openai";
export { GeminiProvider, GeminiEmbeddingProvider, type GeminiConfig } from "./gemini";

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
