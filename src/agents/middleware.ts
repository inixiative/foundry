import type { ExecutionResult } from "./base-agent";

export interface DispatchContext<TPayload = unknown> {
  readonly agentId: string;
  readonly payload: TPayload;
  readonly timestamp: number;

  /** Mutable bag for middleware to annotate. */
  annotations: Record<string, unknown>;
}

export interface DispatchOutcome<TResult = unknown> {
  readonly context: DispatchContext;
  readonly result: ExecutionResult<TResult>;
  readonly durationMs: number;
}

export type MiddlewareNext = () => Promise<ExecutionResult>;

export type Middleware = (
  ctx: DispatchContext,
  next: MiddlewareNext
) => Promise<ExecutionResult>;

/**
 * When a middleware should run.
 *
 * - "always": runs on every dispatch (logging, tracing, metrics)
 * - "conditional": runs only when its `when` predicate returns true
 *   (deep classification, expensive enrichment, guardrails)
 */
export type MiddlewareTier = "always" | "conditional";

export interface MiddlewareEntry {
  readonly id: string;
  readonly tier: MiddlewareTier;
  readonly fn: Middleware;
  readonly when?: (ctx: DispatchContext) => boolean;
}

/**
 * A composable middleware chain with tiered execution.
 *
 * "always" middleware runs on every request — lightweight, fast.
 * "conditional" middleware runs only when its predicate matches —
 * heavier, richer, only when needed.
 *
 * Both tiers compose in registration order on the way in,
 * reverse order on the way out (Koa-style).
 */
export class MiddlewareChain {
  private _middleware: MiddlewareEntry[] = [];

  /** Register always-on middleware. */
  use(id: string, fn: Middleware): void {
    this._middleware.push({ id, tier: "always", fn });
  }

  /** Register conditional middleware with a predicate. */
  useWhen(
    id: string,
    when: (ctx: DispatchContext) => boolean,
    fn: Middleware
  ): void {
    this._middleware.push({ id, tier: "conditional", fn, when });
  }

  remove(id: string): boolean {
    const idx = this._middleware.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this._middleware.splice(idx, 1);
    return true;
  }

  /** Execute the chain. Conditional middleware only runs when its predicate matches. */
  async execute(
    ctx: DispatchContext,
    handler: MiddlewareNext
  ): Promise<ExecutionResult> {
    // Build the active stack for this request
    const active = this._middleware.filter((m) => {
      if (m.tier === "always") return true;
      return m.when ? m.when(ctx) : false;
    });

    let idx = 0;

    const run = async (): Promise<ExecutionResult> => {
      if (idx >= active.length) {
        return handler();
      }
      const current = active[idx++];
      return current.fn(ctx, run);
    };

    return run();
  }

  get size(): number {
    return this._middleware.length;
  }

  /** Get entries by tier (for UI display). */
  byTier(tier: MiddlewareTier): ReadonlyArray<MiddlewareEntry> {
    return this._middleware.filter((m) => m.tier === tier);
  }
}
