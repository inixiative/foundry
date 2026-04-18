import { computeHash } from "./context-layer";
import { ContextStack, type LayerFilter, type AssembledContext } from "./context-stack";

export interface ExecutionResult<T = unknown> {
  readonly output: T;
  readonly tokens?: { input: number; output: number };
  readonly contextHash: string;
  readonly meta?: Record<string, unknown>;
}

/**
 * Per-agent LLM configuration.
 *
 * Each agent can specify its own provider, model, and inference settings.
 * This allows tuning each part of the composition independently:
 * - Fast/cheap models for middleware (classify, route)
 * - Powerful models for executors (code generation, planning)
 */
export interface AgentLLMConfig {
  /** Provider ID — which LLM provider to use (e.g. "anthropic", "openai", "gemini"). */
  readonly provider?: string;
  /** Model override (e.g. "claude-haiku-4-5-20251001", "gpt-4o-mini"). */
  readonly model?: string;
  /** Temperature (0 = deterministic, 1 = creative). */
  readonly temperature?: number;
  /** Max tokens for response. */
  readonly maxTokens?: number;
  /** Data source IDs this agent can access (layer filter by source). */
  readonly sources?: string[];
  /** Maximum call-chain depth to prevent infinite agent delegation. */
  readonly maxDepth?: number;
}

export interface AgentConfig {
  readonly id: string;
  stack: ContextStack;
  layerFilter?: LayerFilter;
  /** System prompt defining this agent's role. */
  prompt?: string;
  /** LLM configuration for this agent. */
  llm?: AgentLLMConfig;
  /** IDs of peer agents this agent knows about (for delegation). */
  peers?: string[];
}

/**
 * Base agent primitive.
 *
 * An agent has a context stack and receives payloads.
 * Subclasses define what happens — Executors go do work,
 * Deciders make decisions and return slim results.
 *
 * The agent doesn't own the stack — the Thread does.
 * The agent gets a reference and a filter that scopes what it sees.
 */
export abstract class BaseAgent<TPayload = unknown, TResult = unknown> {
  readonly id: string;
  readonly prompt: string | undefined;
  readonly llm: AgentLLMConfig | undefined;
  readonly peers: string[];
  protected _stack: ContextStack;
  protected _layerFilter: LayerFilter | undefined;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.prompt = config.prompt;
    this.llm = config.llm;
    this.peers = config.peers ?? [];
    this._stack = config.stack;
    this._layerFilter = config.layerFilter;
  }

  getContext(): string {
    return this._layerFilter
      ? this._stack.slice(this._layerFilter)
      : this._stack.merge();
  }

  /**
   * Assemble structured prompt blocks from agent prompt + layer prompts + content.
   * Use this instead of getContext() when you want the full prompt-layer pairing.
   */
  assembleContext(filterOverride?: LayerFilter): AssembledContext {
    const effective = filterOverride ?? this._layerFilter;
    return this._stack.assemble(this.prompt, effective);
  }

  getContextHash(): string {
    return computeHash(this.getContext());
  }

  /**
   * Run this agent with a payload and optional per-dispatch layer filter override.
   * If filterOverride is provided, it scopes context for this run only
   * without mutating the agent's permanent filter.
   * Meta carries runtime context (cwd, threadId) from the dispatching thread.
   */
  abstract run(
    payload: TPayload,
    filterOverride?: LayerFilter,
    meta?: Record<string, unknown>
  ): Promise<ExecutionResult<TResult>>;

  setLayerFilter(filter: LayerFilter): void {
    this._layerFilter = filter;
  }

  setStack(stack: ContextStack): void {
    this._stack = stack;
  }

  /** Get context with a temporary filter (doesn't mutate agent state). */
  protected getContextWith(filter?: LayerFilter): string {
    const effective = filter ?? this._layerFilter;
    return effective ? this._stack.slice(effective) : this._stack.merge();
  }
}
