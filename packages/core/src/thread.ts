import { ContextStack } from "./context-stack";
import type { LayerFilter, ContextStackView } from "./context-stack";
import { CacheLifecycle } from "./cache-lifecycle";
import { BaseAgent, type ExecutionResult } from "./base-agent";
import { MiddlewareChain, type DispatchContext } from "./middleware";
import { SignalBus } from "./signal";
import type { TokenTracker } from "./token-tracker";

export type ThreadStatus = "idle" | "active" | "waiting" | "archived";

export interface ThreadMeta {
  /** Living description — what this thread is doing right now. */
  description: string;

  /** Classification tags — what kind of work this thread handles. */
  tags: string[];

  /** Current status. */
  status: ThreadStatus;

  /** When this thread was created. */
  readonly createdAt: number;

  /** Last time a dispatch happened on this thread. */
  lastActiveAt: number;

  /** When the thread was archived (if applicable). */
  archivedAt?: number;
}

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

export interface BackgroundHandle {
  readonly agentId: string;
  readonly promise: Promise<ExecutionResult>;
}

export interface ThreadConfig {
  maxDispatches?: number;
  maxSignalHistory?: number;
  description?: string;
  tags?: string[];
  /** Optional token tracker — auto-records costs for every dispatch. */
  tokenTracker?: TokenTracker;
}

/**
 * The Thread is the orchestrator.
 *
 * It owns the ContextStack, manages agents, runs dispatch through
 * a middleware chain, keeps a bounded dispatch log, and hosts the signal bus.
 *
 * Threads are self-describing — they carry a living description,
 * classification tags, and a status that updates as work happens.
 */
export class Thread {
  readonly id: string;
  readonly stack: ContextStack;
  readonly lifecycle: CacheLifecycle;
  readonly middleware: MiddlewareChain;
  readonly signals: SignalBus;
  readonly meta: ThreadMeta;

  private _agents: Map<string, BaseAgent<any, any>> = new Map();
  private _dispatches: Dispatch[] = [];
  private _maxDispatches: number;
  private _tokenTracker?: TokenTracker;

  constructor(id: string, stack: ContextStack, opts?: ThreadConfig) {
    this.id = id;
    this.stack = stack;
    this.lifecycle = new CacheLifecycle(stack);
    this.middleware = new MiddlewareChain();
    this.signals = new SignalBus(opts?.maxSignalHistory ?? 1000);
    this._maxDispatches = opts?.maxDispatches ?? 10000;
    this._tokenTracker = opts?.tokenTracker;

    const now = Date.now();
    this.meta = {
      description: opts?.description ?? "",
      tags: opts?.tags ?? [],
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
    };
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

  // -- Metadata --

  /** Update the living description. */
  describe(description: string): void {
    this.meta.description = description;
  }

  /** Update tags. */
  tag(...tags: string[]): void {
    for (const t of tags) {
      if (!this.meta.tags.includes(t)) this.meta.tags.push(t);
    }
  }

  /** Archive this thread. */
  archive(): void {
    this.meta.status = "archived";
    this.meta.archivedAt = Date.now();
    this.stop();
  }

  // -- Dispatching (with middleware) --

  async dispatch<TPayload>(
    agentId: string,
    payload: TPayload,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult> {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    this.meta.status = "active";
    this.meta.lastActiveAt = Date.now();

    const ctx: DispatchContext<TPayload> = {
      agentId,
      payload,
      timestamp: Date.now(),
      annotations: {},
      threadId: this.id,
      stack: this._createStackView(),
    };

    const start = performance.now();

    try {
      const result = await this.middleware.execute(ctx, () =>
        agent.run(payload, filterOverride)
      );

      const durationMs = performance.now() - start;

      // Auto-record token usage if tracker is configured
      if (this._tokenTracker && result.tokens) {
        const llm = agent.llm;
        this._tokenTracker.record({
          provider: llm?.provider ?? "unknown",
          model: llm?.model ?? "unknown",
          agentId,
          threadId: this.id,
          tokens: result.tokens,
        });
      }

      this._dispatches.push({
        agentId,
        timestamp: ctx.timestamp,
        contextHash: result.contextHash,
        result,
        durationMs,
      });

      if (this._dispatches.length > this._maxDispatches) {
        this._dispatches.shift();
      }

      return result;
    } finally {
      this.meta.status = "idle";
    }
  }

  /**
   * Fire-and-forget dispatch. Returns a handle with the promise
   * but does not block the caller. Errors are logged, not thrown.
   */
  dispatchBackground<TPayload>(
    agentId: string,
    payload: TPayload,
    filterOverride?: LayerFilter
  ): BackgroundHandle {
    const promise = this.dispatch(agentId, payload, filterOverride).catch(
      async (err) => {
        const { log } = await import("../logger");
        log.warn(`[Thread] background dispatch "${agentId}" failed:`, (err as Error).message);
        return { output: null, contextHash: "" } as ExecutionResult;
      }
    );
    return { agentId, promise };
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

  // -- Stack view --

  /** Create a live read-only view of the context stack for middleware. */
  private _createStackView(): ContextStackView {
    const stack = this.stack;
    return {
      hasLayer: (id) => {
        const l = stack.getLayer(id);
        return l ? l.isWarm : false;
      },
      getContent: (id) => {
        const l = stack.getLayer(id);
        return l?.isWarm ? l.content : "";
      },
      getState: (id) => stack.getLayer(id)?.state,
      get layerIds() { return stack.layers.map((l) => l.id); },
      get estimatedTokens() { return stack.estimateTokens(); },
    };
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
