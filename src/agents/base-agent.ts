import { computeHash } from "./context-layer";
import { ContextStack, type LayerFilter, type AssembledContext } from "./context-stack";

export interface ExecutionResult<T = unknown> {
  readonly output: T;
  readonly tokens?: { input: number; output: number };
  readonly contextHash: string;
  readonly meta?: Record<string, unknown>;
}

export interface AgentConfig {
  readonly id: string;
  stack: ContextStack;
  layerFilter?: LayerFilter;
  /** System prompt defining this agent's role. */
  prompt?: string;
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
  protected _stack: ContextStack;
  protected _layerFilter: LayerFilter | undefined;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.prompt = config.prompt;
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
   */
  abstract run(
    payload: TPayload,
    filterOverride?: LayerFilter
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
