import { Thread, type FanResult } from "./thread";
import type { ExecutionResult } from "./base-agent";
import type { Decision } from "./decider";
import type { Classification } from "./classifier";
import type { Route } from "./router";
import type { LayerFilter } from "./context-stack";

/**
 * An incoming message to the harness — the external entry point.
 */
export interface Message<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly meta?: Record<string, unknown>;
}

/**
 * The result after a message flows through the harness pipeline.
 */
export interface HarnessResult<T = unknown> {
  readonly messageId: string;
  readonly classification?: Decision<Classification>;
  readonly route?: Decision<Route>;
  readonly result: ExecutionResult<T>;
  readonly timestamp: number;
}

/**
 * Pipeline step — a named stage in the harness flow.
 * Each step can transform the payload, short-circuit, or continue.
 */
export interface PipelineStep<TIn = unknown, TOut = unknown> {
  readonly id: string;
  run(input: TIn, harness: Harness): Promise<TOut>;
}

/**
 * The Harness is the entry point for external callers.
 *
 * External systems (API, CLI, webhook, other agents) call harness.send(message).
 * The Harness owns a Thread and orchestrates the flow:
 *
 *   Message in → classify → route → dispatch → writeback → response out
 *
 * The pipeline is configurable — you can set a classifier agent,
 * a router agent, and a default executor, or wire up custom pipeline steps.
 *
 * The Harness also provides a simpler direct dispatch for cases where
 * the caller already knows which agent to target.
 */
export class Harness {
  readonly thread: Thread;

  private _classifierId: string | null = null;
  private _routerId: string | null = null;
  private _defaultExecutorId: string | null = null;
  private _pipeline: PipelineStep[] = [];

  constructor(thread: Thread) {
    this.thread = thread;
  }

  // -- Configuration --

  /** Set the classifier agent used in the auto pipeline. */
  setClassifier(agentId: string): void {
    this._classifierId = agentId;
  }

  /** Set the router agent used in the auto pipeline. */
  setRouter(agentId: string): void {
    this._routerId = agentId;
  }

  /** Set the default executor for when the router has no opinion. */
  setDefaultExecutor(agentId: string): void {
    this._defaultExecutorId = agentId;
  }

  /** Add a custom pipeline step. Steps run in order. */
  addStep(step: PipelineStep): void {
    this._pipeline.push(step);
  }

  removeStep(id: string): boolean {
    const idx = this._pipeline.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this._pipeline.splice(idx, 1);
    return true;
  }

  // -- Entry points --

  /**
   * Send a message through the full pipeline: classify → route → dispatch.
   *
   * If no classifier/router is configured, those steps are skipped.
   * The pipeline adapts to what's wired up.
   */
  async send<T>(message: Message<T>): Promise<HarnessResult> {
    let classification: Decision<Classification> | undefined;
    let route: Decision<Route> | undefined;
    let targetAgent: string | undefined;
    let filterOverride: LayerFilter | undefined;

    // 1. Classify (if configured)
    if (this._classifierId) {
      const classifyResult = await this.thread.dispatch(
        this._classifierId,
        message.payload
      );
      classification = classifyResult.output as Decision<Classification>;
    }

    // 2. Route (if configured)
    if (this._routerId) {
      const routePayload = classification
        ? { payload: message.payload, classification: classification.value }
        : message.payload;

      const routeResult = await this.thread.dispatch(this._routerId, routePayload);
      route = routeResult.output as Decision<Route>;
      targetAgent = route.value.destination;

      // Build a layer filter from the route's contextSlice hint
      if (route.value.contextSlice) {
        const sliceIds = new Set(route.value.contextSlice);
        filterOverride = (layer) => sliceIds.has(layer.id);
      }
    }

    // 3. Determine target
    const agentId = targetAgent ?? this._defaultExecutorId;
    if (!agentId) {
      throw new Error(
        "No target agent: router returned no destination and no default executor is configured"
      );
    }

    // 4. Dispatch
    const result = await this.thread.dispatch(agentId, message.payload, filterOverride);

    return {
      messageId: message.id,
      classification,
      route,
      result,
      timestamp: Date.now(),
    };
  }

  /**
   * Direct dispatch — bypass classify/route, go straight to a specific agent.
   * Still runs through Thread middleware.
   */
  async dispatch<T>(
    agentId: string,
    payload: T,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult> {
    return this.thread.dispatch(agentId, payload, filterOverride);
  }

  /**
   * Fan out a message to multiple agents.
   */
  async fan<T>(
    agentIds: string[],
    payload: T,
    filterOverride?: LayerFilter
  ): Promise<FanResult[]> {
    return this.thread.fan(agentIds, payload, filterOverride);
  }

  /**
   * Run the custom pipeline on an input.
   * Each step receives the output of the previous step.
   */
  async runPipeline<T>(input: T): Promise<unknown> {
    let current: unknown = input;
    for (const step of this._pipeline) {
      current = await step.run(current, this);
    }
    return current;
  }
}
