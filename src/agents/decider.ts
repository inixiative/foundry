import { computeHash } from "./context-layer";
import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";
import type { LayerFilter } from "./context-stack";

export interface Decision<T = unknown> {
  readonly value: T;
  readonly confidence?: number;
  readonly reasoning?: string;
}

export type DecideHandler<TPayload, TDecision> = (
  context: string,
  payload: TPayload
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
  private _handler: DecideHandler<TPayload, TDecision>;

  constructor(config: DeciderConfig<TPayload, TDecision>) {
    super(config);
    this._handler = config.handler;
  }

  async run(
    payload: TPayload,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult<Decision<TDecision>>> {
    const context = this.getContextWith(filterOverride);
    const contextHash = computeHash(context);
    const decision = await this._handler(context, payload);

    return { output: decision, contextHash };
  }
}
