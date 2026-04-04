import { Thread, type FanResult } from "./thread";
import type { ExecutionResult } from "./base-agent";
import type { Decision } from "./decider";
import type { Classification } from "./classifier";
import type { Route } from "./router";
import type { LayerFilter } from "./context-stack";
import { Trace } from "./trace";

export interface Message<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly meta?: Record<string, unknown>;
}

export interface HarnessResult<T = unknown> {
  readonly messageId: string;
  readonly classification?: Decision<Classification>;
  readonly route?: Decision<Route>;
  readonly result: ExecutionResult<T>;
  readonly trace: Trace;
  readonly timestamp: number;
}

export interface PipelineStep<TIn = unknown, TOut = unknown> {
  readonly id: string;
  run(input: TIn, harness: Harness, trace: Trace): Promise<TOut>;
}

/**
 * The Harness is the entry point for external callers.
 *
 * Every message that flows through send() gets a Trace — a full record
 * of its journey through classify → route → dispatch, with timing,
 * layer visibility, inputs/outputs at each stage. The UI can render
 * any message's trace as a drillable tree.
 */
export class Harness {
  readonly thread: Thread;

  private _classifierId: string | null = null;
  private _routerId: string | null = null;
  private _defaultExecutorId: string | null = null;
  private _pipeline: PipelineStep[] = [];
  private _traces: Trace[] = [];
  private _maxTraces: number;

  constructor(thread: Thread, opts?: { maxTraces?: number }) {
    this.thread = thread;
    this._maxTraces = opts?.maxTraces ?? 1000;
  }

  // -- Configuration --

  setClassifier(agentId: string): void {
    this._classifierId = agentId;
  }

  setRouter(agentId: string): void {
    this._routerId = agentId;
  }

  setDefaultExecutor(agentId: string): void {
    this._defaultExecutorId = agentId;
  }

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

  async send<T>(message: Message<T>): Promise<HarnessResult> {
    const trace = new Trace(message.id);

    let classification: Decision<Classification> | undefined;
    let route: Decision<Route> | undefined;
    let targetAgent: string | undefined;
    let filterOverride: LayerFilter | undefined;

    try {
      // 1. Classify
      if (this._classifierId) {
        trace.start("classify", "classify", {
          agentId: this._classifierId,
          input: message.payload,
        });

        const classifyResult = await this.thread.dispatch(
          this._classifierId,
          message.payload
        );
        classification = classifyResult.output as Decision<Classification>;

        trace.end(classification);
      }

      // 2. Route
      if (this._routerId) {
        const routePayload = classification
          ? { payload: message.payload, classification: classification.value }
          : message.payload;

        trace.start("route", "route", {
          agentId: this._routerId,
          input: routePayload,
        });

        const routeResult = await this.thread.dispatch(this._routerId, routePayload);
        route = routeResult.output as Decision<Route>;
        targetAgent = route.value.destination;

        if (route.value.contextSlice) {
          const sliceIds = new Set(route.value.contextSlice);
          filterOverride = (layer) => sliceIds.has(layer.id);
        }

        trace.end(route);
      }

      // 3. Determine target
      const agentId = targetAgent ?? this._defaultExecutorId;
      if (!agentId) {
        throw new Error(
          "No target agent: router returned no destination and no default executor is configured"
        );
      }

      // 4. Dispatch
      trace.start("dispatch", "dispatch", {
        agentId,
        input: message.payload,
        layerIds: route?.value.contextSlice,
      });

      const result = await this.thread.dispatch(
        agentId,
        message.payload,
        filterOverride
      );

      trace.end(result.output);

      // 5. Close trace
      trace.end(); // close ingress
      trace.finish();

      this._recordTrace(trace);

      return {
        messageId: message.id,
        classification,
        route,
        result,
        trace,
        timestamp: Date.now(),
      };
    } catch (err) {
      trace.end(undefined, err);
      trace.finish();
      this._recordTrace(trace);
      throw err;
    }
  }

  async dispatch<T>(
    agentId: string,
    payload: T,
    filterOverride?: LayerFilter
  ): Promise<ExecutionResult> {
    return this.thread.dispatch(agentId, payload, filterOverride);
  }

  async fan<T>(
    agentIds: string[],
    payload: T,
    filterOverride?: LayerFilter
  ): Promise<FanResult[]> {
    return this.thread.fan(agentIds, payload, filterOverride);
  }

  async runPipeline<T>(input: T, trace?: Trace): Promise<unknown> {
    let current: unknown = input;
    const t = trace ?? new Trace("pipeline");

    for (const step of this._pipeline) {
      t.start(step.id, "middleware", { input: current });
      current = await step.run(current, this, t);
      t.end(current);
    }

    if (!trace) t.finish();
    return current;
  }

  // -- Trace history --

  get traces(): ReadonlyArray<Trace> {
    return this._traces;
  }

  getTrace(traceId: string): Trace | undefined {
    return this._traces.find((t) => t.id === traceId);
  }

  getTraceForMessage(messageId: string): Trace | undefined {
    return this._traces.find((t) => t.messageId === messageId);
  }

  // -- Internal --

  private _recordTrace(trace: Trace): void {
    this._traces.push(trace);
    if (this._traces.length > this._maxTraces) {
      this._traces.shift();
    }
  }
}
