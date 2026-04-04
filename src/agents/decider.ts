import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";

/**
 * A decision — the slim output of a Decider.
 * The decision is what comes back to the caller.
 * The context that informed it stays behind.
 */
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
 *
 * Deciders are the base for Classifiers and Routers.
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

  async run(payload: TPayload): Promise<ExecutionResult<Decision<TDecision>>> {
    const context = this.getContext();
    const contextHash = this.getContextHash();
    const decision = await this._handler(context, payload);

    return { output: decision, contextHash };
  }
}
