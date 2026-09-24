import { computeHash } from "./context-layer";
import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";
import type { ContextStack, LayerFilter } from "./context-stack";
import type { ExecuteMeta } from "./executor";

export interface Decision<T = unknown> {
  readonly value: T;
  readonly confidence?: number;
  readonly reasoning?: string;
}

/**
 * Decision handlers receive the same dispatch metadata as executors (thread
 * id, cwd, annotations) so session-aware providers can give each thread's
 * auxiliary decisions their own identity instead of a shared default session.
 */
export type DecideHandler<TPayload, TDecision> = (
  context: string,
  payload: TPayload,
  meta?: ExecuteMeta
) => Promise<Decision<TDecision>>;

export interface DeciderConfig<TPayload = unknown, TDecision = unknown>
  extends AgentConfig {
  handler: DecideHandler<TPayload, TDecision>;
}

/**
 * A Decider takes context + payload, makes a decision, and returns
 * ONLY the decision — not the context it used to make it.
 *
 * This is the "trusted authority" pattern. The Decider has rich context
 * (docs, memory, taxonomy, whatever) but the caller just gets back a
 * slim decision. The caller trusts the Decider because it had the context.
 */
export class Decider<TPayload = unknown, TDecision = unknown> extends BaseAgent<
  TPayload,
  Decision<TDecision>
> {
  protected _handler: DecideHandler<TPayload, TDecision>;

  constructor(config: DeciderConfig<TPayload, TDecision>) {
    super(config);
    this._handler = config.handler;
  }

  withStack(stack: ContextStack): Decider<TPayload, TDecision> {
    return new Decider<TPayload, TDecision>({ ...this.agentConfig(stack), handler: this._handler });
  }

  async run(
    payload: TPayload,
    filterOverride?: LayerFilter,
    meta?: ExecuteMeta
  ): Promise<ExecutionResult<Decision<TDecision>>> {
    const context = this.getContextWith(filterOverride);
    const contextHash = computeHash(context);
    const decision = await this._handler(context, payload, meta);

    return { output: decision, contextHash };
  }
}
