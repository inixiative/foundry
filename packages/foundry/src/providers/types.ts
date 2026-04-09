// Re-export shim — all provider types now live in @inixiative/foundry-core
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
