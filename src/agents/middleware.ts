import type { ExecutionResult } from "./base-agent";

/**
 * Context passed through the middleware chain for each dispatch.
 */
export interface DispatchContext<TPayload = unknown> {
  readonly agentId: string;
  readonly payload: TPayload;
  readonly timestamp: number;

  /** Mutable bag for middleware to annotate — downstream middleware and the final handler can read it. */
  annotations: Record<string, unknown>;
}

/**
 * The result after a dispatch completes (passed to after-hooks).
 */
export interface DispatchOutcome<TResult = unknown> {
  readonly context: DispatchContext;
  readonly result: ExecutionResult<TResult>;
  readonly durationMs: number;
}

/**
 * Next function — call to continue the chain.
 * The returned ExecutionResult flows back through after-hooks.
 */
export type MiddlewareNext = () => Promise<ExecutionResult>;

/**
 * A middleware function.
 *
 * - Before the dispatch: inspect/modify the context, short-circuit by returning early
 * - Call next() to continue to the agent
 * - After next() resolves: inspect/modify the result, trigger writeback, etc.
 *
 * This is where the Herald sits — it sees every dispatch, can cross-pollinate,
 * detect contradictions, deduplicate, or block.
 */
export type Middleware = (
  ctx: DispatchContext,
  next: MiddlewareNext
) => Promise<ExecutionResult>;

/**
 * A composable middleware chain.
 *
 * Middleware runs in registration order on the way in,
 * and reverse order on the way out (like Express/Koa).
 */
export class MiddlewareChain {
  private _middleware: Array<{ id: string; fn: Middleware }> = [];

  use(id: string, fn: Middleware): void {
    this._middleware.push({ id, fn });
  }

  remove(id: string): boolean {
    const idx = this._middleware.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this._middleware.splice(idx, 1);
    return true;
  }

  /**
   * Execute the chain with a final handler (the actual agent dispatch).
   */
  async execute(
    ctx: DispatchContext,
    handler: MiddlewareNext
  ): Promise<ExecutionResult> {
    let idx = 0;
    const stack = this._middleware;

    const run = async (): Promise<ExecutionResult> => {
      if (idx >= stack.length) {
        return handler();
      }
      const current = stack[idx++];
      return current.fn(ctx, run);
    };

    return run();
  }

  get size(): number {
    return this._middleware.length;
  }
}
