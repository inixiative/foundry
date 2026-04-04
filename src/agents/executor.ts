import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";

export type ExecuteHandler<TPayload, TResult> = (
  context: string,
  payload: TPayload
) => Promise<TResult>;

export interface ExecutorConfig<TPayload = unknown, TResult = unknown>
  extends AgentConfig {
  handler: ExecuteHandler<TPayload, TResult>;
}

/**
 * An Executor takes context + payload, goes and does work, returns full results.
 *
 * This is the "go do a thing" pattern. The caller gets everything back —
 * code written, research gathered, analysis completed.
 */
export class Executor<TPayload = unknown, TResult = unknown> extends BaseAgent<
  TPayload,
  TResult
> {
  private _handler: ExecuteHandler<TPayload, TResult>;

  constructor(config: ExecutorConfig<TPayload, TResult>) {
    super(config);
    this._handler = config.handler;
  }

  async run(payload: TPayload): Promise<ExecutionResult<TResult>> {
    const context = this.getContext();
    const contextHash = this.getContextHash();
    const output = await this._handler(context, payload);

    return { output, contextHash };
  }
}
