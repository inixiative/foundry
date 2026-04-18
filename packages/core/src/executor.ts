import { computeHash } from "./context-layer";
import { BaseAgent, type AgentConfig, type ExecutionResult } from "./base-agent";
import type { LayerFilter } from "./context-stack";

/** Runtime metadata passed to executor handlers at dispatch time. */
export interface ExecuteMeta {
  /** Working directory for this dispatch (from the thread's worktree). */
  cwd?: string;
  /** Thread ID that dispatched this execution. */
  threadId?: string;
  /** Arbitrary annotations from middleware. */
  annotations?: Record<string, unknown>;
}

export type ExecuteHandler<TPayload, TResult> = (
  context: string,
  payload: TPayload,
  meta?: ExecuteMeta
) => Promise<TResult>;

export interface ExecutorConfig<TPayload = unknown, TResult = unknown>
  extends AgentConfig {
  handler: ExecuteHandler<TPayload, TResult>;
}

/**
 * An Executor takes context + payload, goes and does work, returns full results.
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

  async run(
    payload: TPayload,
    filterOverride?: LayerFilter,
    meta?: ExecuteMeta
  ): Promise<ExecutionResult<TResult>> {
    const context = this.getContextWith(filterOverride);
    const contextHash = computeHash(context);
    const output = await this._handler(context, payload, meta);

    return { output, contextHash };
  }
}
