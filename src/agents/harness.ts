import { Thread, type FanResult, type BackgroundHandle } from "./thread";
import type { ExecutionResult } from "./base-agent";
import type { Decision } from "./decider";
import type { Classification } from "./classifier";
import type { Route } from "./router";
import type { LayerFilter } from "./context-stack";
import type { ContextLayer } from "./context-layer";
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

export interface BackgroundResult {
  readonly messageId: string;
  readonly agentId: string;
  readonly stage: FlowStage;
  readonly result: ExecutionResult;
  readonly durationMs: number;
  readonly error?: Error;
}

export type BackgroundResultHandler = (result: BackgroundResult) => void;

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
  /**
   * Run this stage in the background (fire-and-forget).
   * The stage dispatches but doesn't block the pipeline response.
   * Useful for post-dispatch observers, reviewers, distillers.
   */
  background?: boolean;
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
  /** Results from prior stages (keyed by agentId). */
  readonly stageResults: ReadonlyMap<string, unknown>;
  /** Arbitrary data passed between stages — stages can read/write freely. */
  readonly data: Map<string, unknown>;
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
    const classTags = classification.value.tags ?? [];
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
 * Supports two configuration styles that both execute through a single
 * flow pipeline:
 *
 * 1. **Classic sugar** (setClassifier/setRouter/setDefaultExecutor) —
 *    internally builds a FlowConfig with classify → route → execute stages.
 *
 * 2. **Explicit flow** (setFlow) — full control over pipeline stages with
 *    invocation modes (always/on-demand/conditional).
 *
 * Every message gets a Trace — a full record of its journey
 * with timing, layer visibility, inputs/outputs at each stage.
 */
export class Harness {
  readonly thread: Thread;

  // Classic mode fields — used to build a FlowConfig on demand
  private _classifierId: string | null = null;
  private _routerId: string | null = null;
  private _defaultExecutorId: string | null = null;

  // Explicit flow config (takes precedence over classic fields)
  private _explicitFlow: FlowConfig | null = null;

  // Agent/layer invocation metadata (from config)
  private _agentModes: Map<string, { invocation: string; condition?: InvocationCondition }> = new Map();
  private _layerModes: Map<string, { activation: string; condition?: InvocationCondition }> = new Map();

  private _pipeline: PipelineStep[] = [];
  private _traces: Trace[] = [];
  private _maxTraces: number;
  private _backgroundHandlers: BackgroundResultHandler[] = [];

  constructor(thread: Thread, opts?: { maxTraces?: number }) {
    this.thread = thread;
    this._maxTraces = opts?.maxTraces ?? 1000;
  }

  // -- Classic configuration (sugar for flow) --

  setClassifier(agentId: string): void {
    this._classifierId = agentId;
  }

  setRouter(agentId: string): void {
    this._routerId = agentId;
  }

  setDefaultExecutor(agentId: string): void {
    this._defaultExecutorId = agentId;
  }

  // -- Explicit flow configuration --

  setFlow(flow: FlowConfig): void {
    this._explicitFlow = flow;
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

  // -- Background stage callbacks --

  /**
   * Subscribe to background stage completions.
   * Returns an unsubscribe function.
   *
   * Background stages (FlowStage.background=true) fire-and-forget —
   * they don't block the pipeline response. Use this to observe their
   * results for logging, signal emission, UI updates, etc.
   */
  onBackground(handler: BackgroundResultHandler): () => void {
    this._backgroundHandlers.push(handler);
    return () => {
      const idx = this._backgroundHandlers.indexOf(handler);
      if (idx !== -1) this._backgroundHandlers.splice(idx, 1);
    };
  }

  private _emitBackground(result: BackgroundResult): void {
    for (const handler of [...this._backgroundHandlers]) {
      try {
        handler(result);
      } catch {
        // handler errors shouldn't break the background pipeline
      }
    }
  }

  // -- Entry point --

  async send<T>(message: Message<T>): Promise<HarnessResult> {
    const flow = this._resolveFlow();
    return this._runFlow(message, flow);
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

  // -- Resolve effective flow --

  /**
   * If an explicit flow is set, use it. Otherwise build one from classic
   * setClassifier/setRouter/setDefaultExecutor fields + conditional agents
   * from _agentModes.
   */
  private _resolveFlow(): FlowConfig {
    if (this._explicitFlow) return this._explicitFlow;

    const stages: FlowStage[] = [];

    // Classify stage
    if (this._classifierId) {
      stages.push({
        agentId: this._classifierId,
        role: "classify",
        invocation: "always",
      });
    }

    // Route stage
    if (this._routerId) {
      stages.push({
        agentId: this._routerId,
        role: "route",
        invocation: "always",
      });
    }

    // Conditional agents from _agentModes (enrich role)
    for (const [agentId, mode] of this._agentModes) {
      // Skip classifier/router/executor — they have explicit stages
      if (agentId === this._classifierId) continue;
      if (agentId === this._routerId) continue;
      if (agentId === this._defaultExecutorId) continue;

      if (mode.invocation === "conditional") {
        stages.push({
          agentId,
          role: "enrich",
          invocation: "conditional",
          condition: mode.condition,
        });
      } else if (mode.invocation === "on-demand") {
        stages.push({
          agentId,
          role: "enrich",
          invocation: "on-demand",
        });
      }
    }

    // Execute stage (uses routed destination or default)
    stages.push({
      agentId: "routed",
      role: "execute",
      invocation: "always",
    });

    return {
      stages,
      defaultExecutor: this._defaultExecutorId ?? undefined,
    };
  }

  // -- Unified flow pipeline --

  private async _runFlow<T>(message: Message<T>, flow: FlowConfig): Promise<HarnessResult> {
    const trace = new Trace(message.id);
    const invokedAgents: Array<{ id: string; mode: string }> = [];

    const requestedAgents = new Set<string>();
    const requestedLayers = new Set<string>();
    const stageResults = new Map<string, ExecutionResult>();
    const data = new Map<string, unknown>();

    let classification: Decision<Classification> | undefined;
    let route: Decision<Route> | undefined;
    let lastExecuteAgentId: string | undefined;

    // Build request context for middleware
    const reqCtx: RequestContext = {
      get classification() { return classification; },
      get route() { return route; },
      requestAgent: (id) => requestedAgents.add(id),
      requestLayer: (id) => requestedLayers.add(id),
      get requestedAgents() { return requestedAgents; },
      get requestedLayers() { return requestedLayers; },
      get stageResults() { return stageResults; },
      data,
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

        if (!agentId) {
          if (stage.role === "execute") {
            throw new Error(
              "No target agent: router returned no destination and no default executor is configured",
            );
          }
          continue;
        }
        if (!this.thread.getAgent(agentId)) continue;

        // Build layer filter for this dispatch
        const layerFilter = this.buildLayerFilter(classification, route, requestedLayers);

        // Background stages — fire-and-forget, report via onBackground callback
        if (stage.background) {
          const bgStart = performance.now();
          const msgId = message.id;
          const bgStage = stage;
          const { promise } = this.thread.dispatchBackground(agentId, message.payload, layerFilter);
          invokedAgents.push({ id: agentId, mode: "background" });

          // Wire callback — runs when the background dispatch completes
          promise.then((result) => {
            this._emitBackground({
              messageId: msgId,
              agentId: agentId!,
              stage: bgStage,
              result,
              durationMs: performance.now() - bgStart,
            });
          });

          continue; // don't block the pipeline
        }

        // Trace and dispatch (foreground — blocks pipeline)
        trace.start(`${stage.role}:${agentId}`, stage.role as any, {
          agentId,
          input: message.payload,
          annotations: { invocation: stage.invocation },
        });

        const result = await this.thread.dispatch(agentId, message.payload, layerFilter);
        invokedAgents.push({ id: agentId, mode: stage.invocation });
        stageResults.set(agentId, result);

        // Track the last execute-role agent for final result extraction
        if (stage.role === "execute") {
          lastExecuteAgentId = agentId;
        }

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
        stageResults.set(agentId, result);
        trace.end(result.output);
      }

      trace.finish();
      this._recordTrace(trace);

      // Final result: from last execute-role agent, or last invoked agent
      const finalAgentId = lastExecuteAgentId
        ?? invokedAgents[invokedAgents.length - 1]?.id;
      const finalResult = (finalAgentId ? stageResults.get(finalAgentId) : undefined)
        ?? { output: null, contextHash: "" } as ExecutionResult;

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
    return this._explicitFlow;
  }

  /** Get the effective flow (explicit or built from classic settings). */
  get effectiveFlow(): FlowConfig {
    return this._resolveFlow();
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
