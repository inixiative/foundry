import { ContextStack } from "./context-stack";
import { CacheLifecycle } from "./cache-lifecycle";
import { BaseAgent, type ExecutionResult } from "./base-agent";

/**
 * A dispatch — a record of sending a payload to an agent and getting a result.
 */
export interface Dispatch<T = unknown> {
  readonly agentId: string;
  readonly timestamp: number;
  readonly contextHash: string;
  readonly result: ExecutionResult<T>;
}

/**
 * The Thread is the orchestrator.
 *
 * It owns the ContextStack, manages agents, and dispatches payloads.
 * It holds the lifecycle manager and keeps a log of dispatches.
 *
 * The Thread doesn't make decisions about what to do — it provides
 * the infrastructure for dispatching to agents that do.
 */
export class Thread {
  readonly id: string;
  readonly stack: ContextStack;
  readonly lifecycle: CacheLifecycle;

  private _agents: Map<string, BaseAgent<any, any>> = new Map();
  private _dispatches: Dispatch[] = [];

  constructor(id: string, stack: ContextStack) {
    this.id = id;
    this.stack = stack;
    this.lifecycle = new CacheLifecycle(stack);
  }

  // -- Agent management --

  register(agent: BaseAgent<any, any>): void {
    this._agents.set(agent.id, agent);
  }

  unregister(id: string): boolean {
    return this._agents.delete(id);
  }

  getAgent<TPayload = unknown, TResult = unknown>(
    id: string
  ): BaseAgent<TPayload, TResult> | undefined {
    return this._agents.get(id);
  }

  get agents(): ReadonlyMap<string, BaseAgent<any, any>> {
    return this._agents;
  }

  // -- Dispatching --

  async dispatch<TPayload, TResult>(
    agentId: string,
    payload: TPayload
  ): Promise<ExecutionResult<TResult>> {
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    const result = await agent.run(payload);

    this._dispatches.push({
      agentId,
      timestamp: Date.now(),
      contextHash: result.contextHash,
      result,
    });

    return result as ExecutionResult<TResult>;
  }

  /** Dispatch to multiple agents in parallel. */
  async fan<TPayload>(
    agentIds: string[],
    payload: TPayload
  ): Promise<Map<string, ExecutionResult>> {
    const results = new Map<string, ExecutionResult>();

    const entries = await Promise.all(
      agentIds.map(async (id) => {
        const result = await this.dispatch(id, payload);
        return [id, result] as const;
      })
    );

    for (const [id, result] of entries) {
      results.set(id, result);
    }

    return results;
  }

  // -- History --

  get dispatches(): ReadonlyArray<Dispatch> {
    return this._dispatches;
  }

  /** Start lifecycle observation. */
  start(): void {
    this.lifecycle.start();
  }

  /** Stop lifecycle observation. */
  stop(): void {
    this.lifecycle.stop();
  }
}
