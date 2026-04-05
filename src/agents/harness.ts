import { Thread, type FanResult } from "./thread";
import type { ExecutionResult } from "./base-agent";
import type { Decision } from "./decider";
import type { Classification } from "./classifier";
import type { Route } from "./router";
import type { LayerFilter, ContextLayer } from "./context-stack";
import { Trace } from "./trace";
import type {
  InvocationCondition,
  AgentSettingsConfig,
  LayerSettingsConfig,
} from "../viewer/config";

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
  /** Which agents were invoked (and how: always/conditional/on-demand). */
  readonly invokedAgents?: Array<{ id: string; mode: string }>;
  /** Which layers were active in the final context. */
  readonly activeLayers?: string[];
}

export interface PipelineStep<TIn = unknown, TOut = unknown> {
  readonly id: string;
  run(input: TIn, harness: Harness, trace: Trace): Promise<TOut>;
}

// ---------------------------------------------------------------------------
// Flow configuration — defines the configurable pipeline
// ---------------------------------------------------------------------------

export interface FlowStage {
  /** Agent ID for this stage. Use "routed" to use route.destination. */
  agentId: string | "routed";
  /** Pipeline role (for tracing and UI). */
  role: "classify" | "route" | "execute" | "enrich" | "guard" | "observe";
  /**
   * When this stage runs:
   * - "always": every request
   * - "on-demand": only when explicitly requested by middleware or prior stage
   * - "conditional": when condition matches classification/route context
   */
  invocation: "always" | "on-demand" | "conditional";
  /** Condition for conditional invocation. */
  condition?: InvocationCondition;
}

export interface FlowConfig {
  /** Ordered pipeline stages. */
  stages: FlowStage[];
  /** Default executor if no route specifies a destination. */
  defaultExecutor?: string;
}

/**
 * Context available to middleware for requesting on-demand agents/layers.
 */
export interface RequestContext {
  readonly classification?: Decision<Classification>;
  readonly route?: Decision<Route>;
  /** Request an on-demand agent to run after the current stage. */
  requestAgent(agentId: string): void;
  /** Request an on-demand layer to be included in context assembly. */
  requestLayer(layerId: string): void;
  /** Check which agents/layers have been requested so far. */
  readonly requestedAgents: ReadonlySet<string>;
  readonly requestedLayers: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Condition matching
// ---------------------------------------------------------------------------

export function matchesCondition(
  condition: InvocationCondition | undefined,
  classification?: Decision<Classification>,
  route?: Decision<Route>,
): boolean {
  if (!condition) return false;

  // Match ANY field (OR across fields)
  if (condition.categories?.length && classification?.value) {
    if (condition.categories.includes(classification.value.category)) return true;
  }

  if (condition.tags?.length && classification?.value) {
    const classTags = (classification.value as any).tags ?? [];
    if (condition.tags.some((t) => classTags.includes(t))) return true;
  }

  if (condition.routes?.length && route?.value) {
    if (condition.routes.includes(route.value.destination)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * The Harness is the entry point for external callers.
 *
 * Supports three execution modes:
 *
 * 1. **Classic mode** (setClassifier/setRouter/setDefaultExecutor) —
 *    fixed classify → route → dispatch pipeline. Simple.
 *
 * 2. **Flow mode** (setFlow) — configurable pipeline stages with
 *    invocation modes (always/on-demand/conditional). Each stage
 *    defines when it runs, and middleware can request on-demand stages.
 *
 * Every message gets a Trace — a full record of its journey
 * with timing, layer visibility, inputs/outputs at each stage.
 */
export class Harness {
  readonly thread: Thread;

  // Classic mode config
  private _classifierId: string | null = null;
  private _routerId: string | null = null;
  private _defaultExecutorId: string | null = null;

  // Flow mode config
  private _flow: FlowConfig | null = null;

  // Agent/layer invocation metadata (from config)
  private _agentModes: Map<string, { invocation: string; condition?: InvocationCondition }> = new Map();
  private _layerModes: Map<string, { activation: string; condition?: InvocationCondition }> = new Map();

  private _pipeline: PipelineStep[] = [];
  private _traces: Trace[] = [];
  private _maxTraces: number;

  constructor(thread: Thread, opts?: { maxTraces?: number }) {
    this.thread = thread;
    this._maxTraces = opts?.maxTraces ?? 1000;
  }

  // -- Classic configuration --

  setClassifier(agentId: string): void {
    this._classifierId = agentId;
  }

  setRouter(agentId: string): void {
    this._routerId = agentId;
  }

  setDefaultExecutor(agentId: string): void {
    this._defaultExecutorId = agentId;
  }

  // -- Flow configuration --

  setFlow(flow: FlowConfig): void {
    this._flow = flow;
  }

  /** Register invocation mode for an agent (from config). */
  setAgentMode(agentId: string, invocation: string, condition?: InvocationCondition): void {
    this._agentModes.set(agentId, { invocation, condition });
  }

  /** Register activation mode for a layer (from config). */
  setLayerMode(layerId: string, activation: string, condition?: InvocationCondition): void {
    this._layerModes.set(layerId, { activation, condition });
  }

  /** Bulk-load modes from config. */
  loadModes(
    agents: Record<string, AgentSettingsConfig>,
    layers: Record<string, LayerSettingsConfig>,
  ): void {
    for (const [id, cfg] of Object.entries(agents)) {
      this.setAgentMode(id, cfg.invocation ?? "always", cfg.condition);
    }
    for (const [id, cfg] of Object.entries(layers)) {
      this.setLayerMode(id, cfg.activation ?? "always", cfg.condition);
    }
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
    if (this._flow) {
      return this._sendFlow(message);
    }
    return this._sendClassic(message);
  }

  /**
   * Build a layer filter that respects activation modes.
   *
   * - "always" layers: always included
   * - "conditional" layers: included when condition matches
   * - "on-demand" layers: included only if in requestedLayers or route.contextSlice
   */
  buildLayerFilter(
    classification?: Decision<Classification>,
    route?: Decision<Route>,
    requestedLayers?: ReadonlySet<string>,
  ): LayerFilter {
    const routeSlice = route?.value?.contextSlice
      ? new Set(route.value.contextSlice)
      : null;

    return (layer: ContextLayer) => {
      const mode = this._layerModes.get(layer.id);
      const activation = mode?.activation ?? "always";

      switch (activation) {
        case "always":
          return true;

        case "conditional":
          return matchesCondition(mode?.condition, classification, route);

        case "on-demand":
          // Included if router requested it via contextSlice, or middleware requested it
          if (routeSlice?.has(layer.id)) return true;
          if (requestedLayers?.has(layer.id)) return true;
          return false;

        default:
          return true;
      }
    };
  }

  // -- Classic pipeline (backwards compatible) --

  private async _sendClassic<T>(message: Message<T>): Promise<HarnessResult> {
    const trace = new Trace(message.id);
    const invokedAgents: Array<{ id: string; mode: string }> = [];

    // Track on-demand requests from middleware
    const requestedAgents = new Set<string>();
    const requestedLayers = new Set<string>();

    let classification: Decision<Classification> | undefined;
    let route: Decision<Route> | undefined;
    let targetAgent: string | undefined;

    try {
      // 1. Classify
      if (this._classifierId) {
        trace.start("classify", "classify", {
          agentId: this._classifierId,
          input: message.payload,
        });

        const classifyResult = await this.thread.dispatch(
          this._classifierId,
          message.payload,
        );
        classification = classifyResult.output as Decision<Classification>;
        invokedAgents.push({ id: this._classifierId, mode: "always" });

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
        invokedAgents.push({ id: this._routerId, mode: "always" });

        trace.end(route);
      }

      // 3. Run conditional agents that match current context
      for (const [agentId, mode] of this._agentModes) {
        if (mode.invocation !== "conditional") continue;
        if (!matchesCondition(mode.condition, classification, route)) continue;
        if (!this.thread.getAgent(agentId)) continue;

        trace.start(`conditional:${agentId}`, "enrich", { agentId });
        const result = await this.thread.dispatch(agentId, message.payload);
        invokedAgents.push({ id: agentId, mode: "conditional" });
        trace.end(result.output);
      }

      // 4. Run on-demand agents that were requested by middleware
      for (const agentId of requestedAgents) {
        if (!this.thread.getAgent(agentId)) continue;

        trace.start(`on-demand:${agentId}`, "enrich", { agentId });
        const result = await this.thread.dispatch(agentId, message.payload);
        invokedAgents.push({ id: agentId, mode: "on-demand" });
        trace.end(result.output);
      }

      // 5. Build layer filter respecting activation modes
      const layerFilter = this.buildLayerFilter(classification, route, requestedLayers);

      // 6. Determine target executor
      const agentId = targetAgent ?? this._defaultExecutorId;
      if (!agentId) {
        throw new Error(
          "No target agent: router returned no destination and no default executor is configured",
        );
      }

      // 7. Dispatch to executor with activation-aware layer filter
      trace.start("dispatch", "dispatch", {
        agentId,
        input: message.payload,
        layerIds: route?.value.contextSlice,
      });

      const result = await this.thread.dispatch(
        agentId,
        message.payload,
        layerFilter,
      );
      invokedAgents.push({ id: agentId, mode: "always" });

      trace.end(result.output);

      // 8. Close trace
      trace.finish();
      this._recordTrace(trace);

      // Collect active layer IDs
      const activeLayers = this.thread.stack.layers
        .filter(layerFilter)
        .map((l) => l.id);

      return {
        messageId: message.id,
        classification,
        route,
        result,
        trace,
        timestamp: Date.now(),
        invokedAgents,
        activeLayers,
      };
    } catch (err) {
      const current = trace.current;
      if (current && current.status === "running") {
        trace.end(undefined, err);
      }
      trace.finish();
      this._recordTrace(trace);
      throw err;
    }
  }

  // -- Flow pipeline (configurable stages) --

  private async _sendFlow<T>(message: Message<T>): Promise<HarnessResult> {
    const flow = this._flow!;
    const trace = new Trace(message.id);
    const invokedAgents: Array<{ id: string; mode: string }> = [];

    const requestedAgents = new Set<string>();
    const requestedLayers = new Set<string>();

    let classification: Decision<Classification> | undefined;
    let route: Decision<Route> | undefined;

    // Build request context for middleware
    const reqCtx: RequestContext = {
      get classification() { return classification; },
      get route() { return route; },
      requestAgent: (id) => requestedAgents.add(id),
      requestLayer: (id) => requestedLayers.add(id),
      get requestedAgents() { return requestedAgents; },
      get requestedLayers() { return requestedLayers; },
    };

    try {
      // Run each stage in order
      for (const stage of flow.stages) {
        // Should this stage run?
        if (stage.invocation === "on-demand") {
          const resolvedId = stage.agentId === "routed"
            ? route?.value?.destination
            : stage.agentId;
          if (!resolvedId || !requestedAgents.has(resolvedId)) continue;
        }

        if (stage.invocation === "conditional") {
          if (!matchesCondition(stage.condition, classification, route)) continue;
        }

        // Resolve agent ID
        const agentId = stage.agentId === "routed"
          ? (route?.value?.destination ?? flow.defaultExecutor)
          : stage.agentId;

        if (!agentId) continue;
        if (!this.thread.getAgent(agentId)) continue;

        // Build layer filter for this dispatch
        const layerFilter = this.buildLayerFilter(classification, route, requestedLayers);

        // Trace and dispatch
        trace.start(`${stage.role}:${agentId}`, stage.role as any, {
          agentId,
          input: message.payload,
          invocation: stage.invocation,
        });

        const result = await this.thread.dispatch(agentId, message.payload, layerFilter);
        invokedAgents.push({ id: agentId, mode: stage.invocation });

        // Capture classification/route from appropriate stages
        if (stage.role === "classify") {
          classification = result.output as Decision<Classification>;
        } else if (stage.role === "route") {
          route = result.output as Decision<Route>;
        }

        trace.end(result.output);
      }

      // Run any remaining on-demand agents requested by middleware
      for (const agentId of requestedAgents) {
        const alreadyRan = invokedAgents.some((a) => a.id === agentId);
        if (alreadyRan) continue;
        if (!this.thread.getAgent(agentId)) continue;

        const layerFilter = this.buildLayerFilter(classification, route, requestedLayers);
        trace.start(`on-demand:${agentId}`, "enrich", { agentId });
        const result = await this.thread.dispatch(agentId, message.payload, layerFilter);
        invokedAgents.push({ id: agentId, mode: "on-demand" });
        trace.end(result.output);
      }

      trace.finish();
      this._recordTrace(trace);

      // The last execute-role stage's result is the final output
      const lastExecute = invokedAgents.filter((a) =>
        flow.stages.find((s) =>
          (s.agentId === a.id || s.agentId === "routed") && s.role === "execute"
        ),
      );
      const finalAgentId = lastExecute.length > 0
        ? lastExecute[lastExecute.length - 1].id
        : invokedAgents[invokedAgents.length - 1]?.id;

      // Get the result from the last dispatch
      const finalResult = this.thread.dispatches.length > 0
        ? this.thread.dispatches[this.thread.dispatches.length - 1].result
        : { output: null, contextHash: "" };

      const layerFilter = this.buildLayerFilter(classification, route, requestedLayers);
      const activeLayers = this.thread.stack.layers.filter(layerFilter).map((l) => l.id);

      return {
        messageId: message.id,
        classification,
        route,
        result: finalResult,
        trace,
        timestamp: Date.now(),
        invokedAgents,
        activeLayers,
      };
    } catch (err) {
      const current = trace.current;
      if (current && current.status === "running") {
        trace.end(undefined, err);
      }
      trace.finish();
      this._recordTrace(trace);
      throw err;
    }
  }

  // -- Direct dispatch (bypass pipeline) --

  async dispatch<T>(
    agentId: string,
    payload: T,
    filterOverride?: LayerFilter,
  ): Promise<ExecutionResult> {
    return this.thread.dispatch(agentId, payload, filterOverride);
  }

  async fan<T>(
    agentIds: string[],
    payload: T,
    filterOverride?: LayerFilter,
  ): Promise<FanResult[]> {
    return this.thread.fan(agentIds, payload, filterOverride);
  }

  /** Explicitly invoke an on-demand agent (for use by middleware or external callers). */
  async invokeOnDemand<T>(
    agentId: string,
    payload: T,
    classification?: Decision<Classification>,
    route?: Decision<Route>,
  ): Promise<ExecutionResult> {
    const layerFilter = this.buildLayerFilter(classification, route);
    return this.thread.dispatch(agentId, payload, layerFilter);
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

  // -- Flow inspection --

  get flow(): FlowConfig | null {
    return this._flow;
  }

  get agentModes(): ReadonlyMap<string, { invocation: string; condition?: InvocationCondition }> {
    return this._agentModes;
  }

  get layerModes(): ReadonlyMap<string, { activation: string; condition?: InvocationCondition }> {
    return this._layerModes;
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
