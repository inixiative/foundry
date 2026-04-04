import type { AssembledContext, PromptBlock } from "../agents/context-stack";

// ---------------------------------------------------------------------------
// Messages — the universal format between assemble() and provider.complete()
// ---------------------------------------------------------------------------

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompletionOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface CompletionResult {
  readonly content: string;
  readonly model: string;
  readonly tokens?: { input: number; output: number };
  readonly finishReason?: string;
  /** Raw provider response for pass-through needs. */
  readonly raw?: unknown;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  readonly embedding: number[];
  readonly tokens?: number;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface LLMStreamEvent {
  type: "text" | "usage" | "done" | "error";
  /** Text chunk for "text" events. */
  text?: string;
  /** Token usage for "usage" events. */
  tokens?: { input: number; output: number };
  /** Error message for "error" events. */
  error?: string;
  /** Why generation stopped, for "done" events. */
  finishReason?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  readonly id: string;
  complete(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): Promise<CompletionResult>;
  stream?(
    messages: LLMMessage[],
    opts?: CompletionOpts
  ): AsyncGenerator<LLMStreamEvent>;
}

export interface EmbeddingProvider {
  readonly id: string;
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch?(texts: string[]): Promise<EmbeddingResult[]>;
}

// ---------------------------------------------------------------------------
// AssembledContext → LLMMessage[] conversion
// ---------------------------------------------------------------------------

/**
 * Convert an AssembledContext (from stack.assemble()) into LLMMessages
 * ready for any provider.
 *
 * System blocks, layer instruction blocks, and content blocks all fold
 * into the system message. The userPayload becomes the user message.
 */
export function assembledToMessages(
  assembled: AssembledContext,
  userPayload: string
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // All context blocks merge into system message
  if (assembled.blocks.length > 0) {
    const systemParts: string[] = [];

    for (const block of assembled.blocks) {
      if (block.role === "system") {
        systemParts.push(block.text);
      } else if (block.role === "layer") {
        systemParts.push(`[${block.id}]: ${block.text}`);
      } else if (block.role === "content") {
        systemParts.push(block.text);
      }
    }

    messages.push({ role: "system", content: systemParts.join("\n\n") });
  }

  messages.push({ role: "user", content: userPayload });

  return messages;
}

/**
 * Split LLMMessages into provider-friendly parts.
 * Returns the system text separately (for Anthropic/Gemini which take it
 * outside the messages array) and the non-system messages.
 */
export function splitSystemMessage(messages: LLMMessage[]): {
  system: string | undefined;
  turns: LLMMessage[];
} {
  const systemParts: string[] = [];
  const turns: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else {
      turns.push(msg);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    turns,
  };
}
