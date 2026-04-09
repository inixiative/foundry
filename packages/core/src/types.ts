// ---------------------------------------------------------------------------
// Shared types — used by harness for conditional invocation/activation
// ---------------------------------------------------------------------------

/**
 * Condition for conditional invocation/activation.
 * Matches when ANY specified field matches (OR across fields, OR within arrays).
 */
export interface InvocationCondition {
  /** Match if classification.category is one of these. */
  categories?: string[];
  /** Match if any classification tag overlaps with these. */
  tags?: string[];
  /** Match if route.destination is one of these. */
  routes?: string[];
}

/**
 * Minimal agent mode config — what the harness needs from config.
 * Full AgentSettingsConfig lives in @inixiative/foundry.
 */
export interface AgentModeConfig {
  invocation?: "always" | "on-demand" | "conditional";
  condition?: InvocationCondition;
}

/**
 * Minimal layer mode config — what the harness needs from config.
 * Full LayerSettingsConfig lives in @inixiative/foundry.
 */
export interface LayerModeConfig {
  activation?: "always" | "on-demand" | "conditional";
  condition?: InvocationCondition;
}

// ---------------------------------------------------------------------------
// LLM provider interface — the abstraction, not implementations
// ---------------------------------------------------------------------------

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/** Tool definition sent to the LLM so it can call tools. */
export interface ToolDefinition {
  /** Tool name (e.g., "shell_exec", "memory_search"). */
  name: string;
  /** Short description for the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
}

/** A tool call returned by the LLM. */
export interface ToolCall {
  /** Provider-assigned call ID (for matching results). */
  id: string;
  /** Tool name to invoke. */
  name: string;
  /** Parsed input arguments. */
  input: Record<string, unknown>;
}

/** Result of executing a tool call, fed back to the LLM. */
export interface ToolCallResult {
  /** Matches the ToolCall.id. */
  toolCallId: string;
  /** Serialized result content. */
  content: string;
  /** Whether the tool call succeeded. */
  isError?: boolean;
}

export interface CompletionOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  /** Max agentic turns (for runtimes that support tool use). */
  maxTurns?: number;
  /** Enable/disable tool use. False = pure text completion. */
  tools?: boolean;
  /** Tool definitions for the LLM to call. Providers map to native format. */
  toolDefinitions?: ToolDefinition[];

  // -- Extended knobs (providers map these to their native APIs) --

  /**
   * Extended thinking / reasoning effort level.
   * Providers translate: Anthropic → thinking.budget_tokens, OpenAI → reasoning_effort.
   * "none" = no thinking, "low"/"medium"/"high" = increasing effort, number = explicit budget tokens.
   */
  thinking?: "none" | "low" | "medium" | "high" | number;
  /** Permission level for code execution runtimes (claude-code, codex). */
  permissions?: "bypass" | "supervised" | "restricted";
  /** Per-call timeout in ms. Provider uses its own default if omitted. */
  timeout?: number;
  /** Enable prompt caching where supported. */
  cacheControl?: boolean;
  /** Thread ID — used by session-aware providers (e.g. ClaudeCode) to resume sessions. */
  threadId?: string;
}

export interface CompletionResult {
  readonly content: string;
  readonly model: string;
  readonly tokens?: { input: number; output: number };
  readonly finishReason?: string;
  /** Tool calls requested by the LLM (present when finishReason is "tool_use"). */
  readonly toolCalls?: ToolCall[];
  readonly raw?: unknown;
}

export interface EmbeddingResult {
  readonly embedding: number[];
  readonly tokens?: number;
}

export interface LLMStreamEvent {
  type: "text" | "usage" | "done" | "error";
  text?: string;
  tokens?: { input: number; output: number };
  error?: string;
  finishReason?: string;
}

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
