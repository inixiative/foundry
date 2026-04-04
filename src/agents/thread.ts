import { ContextStack } from "./context-stack";
import type { LayerFilter } from "./context-stack";
import { CacheLifecycle } from "./cache-lifecycle";
import { BaseAgent, type ExecutionResult } from "./base-agent";
import { MiddlewareChain, type Middleware, type DispatchContext } from "./middleware";
import { SignalBus, type Signal } from "./signal";

export interface Dispatch<T = unknown> {
  readonly agentId: string;
  readonly timestamp: number;
  readonly contextHash: string;
  readonly result: ExecutionResult<T>;
  readonly durationMs: number;
}

export interface FanResult {
  readonly agentId: string;
  readonly status: "fulfilled" | "rejected";
  readonly result?: ExecutionResult;
  readonly error?: unknown;
}

/**
 * The Thread is the orchestrator.
 *
 * It owns the ContextStack, manages agents, runs dispatch through
 * a middleware chain, keeps a bounded dispatch log, and hosts the signal bus.
 */
export class Thread {
  readonly id: string;
  readonly stack: ContextStack;
  readonly lifecycle: CacheLifecycle;
  readonly middleware: MiddlewareChain;
  readonly signals: SignalBus;

  private _agents: Map<string, BaseAgent<any, any>> = new Map();
  private _dispatches: Dispatch[] = [];
  private _maxDispatches: number;

  constructor(
    id: string,
    stack: ContextStack,
    opts?: { maxDispatches?: number; maxSignalHistory?: number }
  ) {
    this.id = id;
    this.stack = stack;
    this.lifecycle = new CacheLifecycle(stack);
    this.middleware = new MiddlewareChain();
    this.signals = new SignalBus(opts?.maxSignalHistory ?? 1000);
    this._maxDispatches = opts?.maxDispatches ?? 10000;
  }

  // -- Agent management --

  register(agent: BaseAgent<any, any>): void {
    this._agents.set(agent.id, agent);
  }

  unregister(id: string): boolean {
    return this._agents.delete(id);
  }

  getAgent(id: string): BaseAgent<any, any> | undefined {
    return this._agents.get(id);
  }

  get agents(): ReadonlyMap<string, BaseAgent<any, any>> {
    return this._agents;
  }

  // -- Dispatching (with middleware) --

  async dispatch<TPayload>(
    agentId: string,
    payload: TPayload,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult> {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const ctx: DispatchContext<TPayload> = {
      agentId,
      payload,
      timestamp: Date.now(),
      annotations: {},
    };

    const start = performance.now();

    // Run through middleware chain, with the actual agent.run as the final handler
    const result = await this.middleware.execute(ctx, () =>
      agent.run(payload, filterOverride)
    );

    const durationMs = performance.now() - start;

    this._dispatches.push({
      agentId,
      timestamp: ctx.timestamp,
      contextHash: result.contextHash,
      result,
      durationMs,
    });

    // Bounded history
    if (this._dispatches.length > this._maxDispatches) {
      this._dispatches.shift();
    }

    return result;
  }

  /**
   * Dispatch to multiple agents in parallel.
   * Uses allSettled — one failure doesn't kill the rest.
   */
  async fan<TPayload>(
    agentIds: string[],
    payload: TPayload,
    filterOverride?: LayerFilter
  ): Promise<FanResult[]> {
    const settled = await Promise.allSettled(
      agentIds.map((id) => this.dispatch(id, payload, filterOverride))
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") {
        return { agentId: agentIds[i], status: "fulfilled" as const, result: s.value };
      } else {
        return { agentId: agentIds[i], status: "rejected" as const, error: s.reason };
      }
    });
  }

  // -- History --

  get dispatches(): ReadonlyArray<Dispatch> {
    return this._dispatches;
  }

  start(): void {
    this.lifecycle.start();
  }

  stop(): void {
    this.lifecycle.stop();
  }
}
