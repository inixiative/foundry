/**
 * @atlas
 * @kind service
 * @partOf primitive:agents
 */
import type { ExecutionResult } from './base-agent';
import { BoundedSet } from './bounded-set';
import type { ContextLayer } from './context-layer';
import type { LayerFilter } from './context-stack';
import type { FanResult, Thread } from './thread';
import { Trace } from './trace';
import type { AgentModeConfig, LayerModeConfig } from './types';

export interface Message<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly meta?: Record<string, unknown>;
}

export interface HarnessResult<T = unknown> {
  readonly messageId: string;
  readonly result: ExecutionResult<T>;
  readonly trace: Trace;
  readonly timestamp: number;
  /** Which agents were invoked (and how: always/on-demand/background). */
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
  /** Agent ID for this stage. */
  agentId: string;
  /** Pipeline role (for tracing and UI). */
  role: 'execute' | 'enrich' | 'guard' | 'observe';
  /**
   * When this stage runs:
   * - "always": every request
   * - "on-demand": only when explicitly requested by middleware or prior stage
   */
  invocation: 'always' | 'on-demand';
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
}

/**
 * Context available to middleware for requesting on-demand agents/layers.
 */
export interface RequestContext {
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
// Harness
// ---------------------------------------------------------------------------

interface SendOptions {
  nativeObservation?: import('./thread').DispatchOptions['nativeObservation'];
  onDelta?: (text: string) => void;
  /** Final trace for this attempt, independent of the bounded history cache. */
  onTrace?: (trace: Trace) => void;
  /**
   * The executor has prepared its input after every middleware ran and is handing it to its
   * provider. Fires once per message, before any provider call.
   */
  onExecutorInput?: () => void;
  /** The payload the execute stage's agent receives instead of `message.payload` (see DispatchOptions.agentPayload). */
  executorPayload?: unknown;
  /** Images sent with the message; only the execute stage's agent receives them. */
  images?: readonly import('./types').ImageInput[];
}

/**
 * The Harness is the entry point for external callers.
 *
 * Supports two configuration styles that both execute through a single
 * flow pipeline:
 *
 * 1. **Default executor** (setDefaultExecutor) — internally builds a FlowConfig
 *    with the on-demand agents from the configured modes and one execute stage.
 *
 * 2. **Explicit flow** (setFlow) — full control over pipeline stages with
 *    invocation modes (always/on-demand).
 *
 * Every message gets a Trace — a full record of its journey
 * with timing, layer visibility, inputs/outputs at each stage.
 */
export class Harness {
  readonly thread: Thread;

  private _defaultExecutorId: string | null = null;

  // Explicit flow config (takes precedence over classic fields)
  private _explicitFlow: FlowConfig | null = null;

  // Agent/layer invocation metadata (from config)
  private _agentModes: Map<string, { invocation: string }> = new Map();
  private _layerModes: Map<string, { activation: string }> = new Map();

  private _pipeline: PipelineStep[] = [];
  private _traces: Trace[] = [];
  private _maxTraces: number;
  private _backgroundHandlers: BackgroundResultHandler[] = [];

  // Idempotency
  private _seenMessages: BoundedSet<string>;
  private _resultCache: Map<string, HarnessResult> = new Map();
  private _dedupCapacity: number;

  constructor(thread: Thread, opts?: { maxTraces?: number; dedup?: boolean | number }) {
    this.thread = thread;
    this._maxTraces = opts?.maxTraces ?? 1000;

    this._dedupCapacity =
      opts?.dedup === true ? 1000 : typeof opts?.dedup === 'number' ? opts.dedup : 0;
    this._seenMessages = new BoundedSet<string>(Math.max(this._dedupCapacity, 1));
  }

  setDefaultExecutor(agentId: string): void {
    this._defaultExecutorId = agentId;
  }

  // -- Explicit flow configuration --

  setFlow(flow: FlowConfig): void {
    this._explicitFlow = flow;
  }

  /** Register invocation mode for an agent (from config). */
  setAgentMode(agentId: string, invocation: string): void {
    this._agentModes.set(agentId, { invocation });
  }

  /** Register activation mode for a layer (from config). */
  setLayerMode(layerId: string, activation: string): void {
    this._layerModes.set(layerId, { activation });
  }

  /** Bulk-load modes from config. */
  loadModes(
    agents: Record<string, AgentModeConfig>,
    layers: Record<string, LayerModeConfig>,
  ): void {
    for (const [id, cfg] of Object.entries(agents)) {
      this.setAgentMode(id, cfg.invocation ?? 'always');
    }
    for (const [id, cfg] of Object.entries(layers)) {
      this.setLayerMode(id, cfg.activation ?? 'always');
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

  async send<T>(message: Message<T>, opts?: SendOptions): Promise<HarnessResult> {
    // Idempotency: return cached result for duplicate messages
    if (this._dedupCapacity > 0 && this._seenMessages.has(message.id)) {
      const cached = this._resultCache.get(message.id);
      if (cached) return cached;
    }

    const flow = this._resolveFlow();
    const result = await this._runFlow(message, flow, opts);

    // Cache for dedup
    if (this._dedupCapacity > 0) {
      this._seenMessages.add(message.id);
      this._resultCache.set(message.id, result);

      // Prune cache to match bounded set capacity
      if (this._resultCache.size > this._dedupCapacity) {
        const oldest = this._resultCache.keys().next().value;
        if (oldest) this._resultCache.delete(oldest);
      }
    }

    return result;
  }

  /**
   * Stream a message — yields text deltas as they arrive from the executor,
   * then a final "done" event with the full HarnessResult. Deltas are
   * gathered from the executor's provider.stream() path (when available);
   * callers should concatenate deltas to reconstruct the text, or just use
   * the done event's result.
   */
  async *sendStream<T>(
    message: Message<T>,
    opts?: Pick<SendOptions, 'onTrace' | 'nativeObservation'>,
  ): AsyncGenerator<{ kind: 'delta'; text: string } | { kind: 'done'; result: HarnessResult }> {
    // Bounded buffer so deltas emitted while we're yielding don't get lost.
    const pending: string[] = [];
    let resolveWaiter: (() => void) | null = null;

    const onDelta = (text: string) => {
      pending.push(text);
      if (resolveWaiter) {
        const r = resolveWaiter;
        resolveWaiter = null;
        r();
      }
    };

    let done = false;
    let finalResult: HarnessResult | undefined;
    let thrown: unknown;
    let failed = false;

    const runPromise = this.send(message, { ...opts, onDelta })
      .then((r) => {
        finalResult = r;
      })
      .catch((e) => {
        failed = true;
        thrown = e;
      })
      .finally(() => {
        done = true;
        if (resolveWaiter) {
          const r = resolveWaiter;
          resolveWaiter = null;
          r();
        }
      });

    while (!done || pending.length > 0) {
      if (pending.length > 0) {
        yield { kind: 'delta', text: pending.shift()! };
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        resolveWaiter = r;
      });
    }

    await runPromise;
    if (failed) throw thrown;
    if (finalResult) yield { kind: 'done', result: finalResult };
  }

  /**
   * Build a layer filter that respects activation modes: "always" layers are always included,
   * "on-demand" layers only when middleware requested them for this message.
   */
  buildLayerFilter(requestedLayers?: ReadonlySet<string>): LayerFilter {
    return (layer: ContextLayer) => {
      const activation = this._layerModes.get(layer.id)?.activation ?? 'always';
      if (activation === 'on-demand') return !!requestedLayers?.has(layer.id);
      return true;
    };
  }

  // -- Resolve effective flow --

  /**
   * If an explicit flow is set, use it. Otherwise build one from the on-demand agents in
   * _agentModes and the default executor.
   */
  private _resolveFlow(): FlowConfig {
    if (this._explicitFlow) return this._explicitFlow;

    const stages: FlowStage[] = [];
    for (const [agentId, mode] of this._agentModes) {
      if (agentId === this._defaultExecutorId) continue;
      if (mode.invocation === 'on-demand')
        stages.push({ agentId, role: 'enrich', invocation: 'on-demand' });
    }
    stages.push({ agentId: this._defaultExecutorId ?? '', role: 'execute', invocation: 'always' });
    return { stages };
  }

  // -- Unified flow pipeline --

  private async _runFlow<T>(
    message: Message<T>,
    flow: FlowConfig,
    opts?: SendOptions,
  ): Promise<HarnessResult> {
    const trace = new Trace(message.id, {
      input: structuredClone(message.payload),
      threadId: this.thread.id,
    });
    const invokedAgents: Array<{ id: string; mode: string }> = [];

    const requestedAgents = new Set<string>();
    const requestedLayers = new Set<string>();
    const stageResults = new Map<string, ExecutionResult>();
    let executorInput = false;

    let lastExecuteAgentId: string | undefined;

    try {
      for (const stage of flow.stages) {
        if (stage.invocation === 'on-demand' && !requestedAgents.has(stage.agentId)) continue;

        const agentId = stage.agentId;
        if (!agentId) {
          if (stage.role === 'execute') throw new Error('No default executor is configured');
          continue;
        }
        if (!this.thread.getAgent(agentId)) {
          if (stage.role === 'execute')
            throw new Error(`Execution target "${agentId}" is not registered`);
          continue;
        }

        // Build layer filter for this dispatch
        const layerFilter = this.buildLayerFilter(requestedLayers);

        // Background stages — fire-and-forget, report via onBackground callback
        if (stage.background) {
          const bgStart = performance.now();
          const msgId = message.id;
          const bgStage = stage;
          const { promise } = this.thread.dispatchBackground(
            agentId,
            message.payload,
            layerFilter,
            {
              role: stage.role,
              messageId: message.id,
              invocation: 'background',
            },
          );
          invokedAgents.push({ id: agentId, mode: 'background' });

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
        const stageSpan = trace.start(`${stage.role}:${agentId}`, stage.role, {
          agentId,
          threadId: this.thread.id,
          input: message.payload,
          annotations: { invocation: stage.invocation },
        });

        // The thread observes this dispatch once at its boundary; the stage
        // only contributes correlation. Only the execute stage streams deltas:
        // enricher output isn't user-visible content.
        const result = await this.thread.dispatch(agentId, message.payload, layerFilter, {
          onDelta: stage.role === 'execute' ? opts?.onDelta : undefined,
          requestLayer: (layerId) => requestedLayers.add(layerId),
          role: stage.role,
          messageId: message.id,
          invocation: stage.invocation,
          ...(stage.role === 'execute' && opts?.executorPayload !== undefined
            ? { agentPayload: opts.executorPayload }
            : {}),
          ...(stage.role === 'execute' && opts?.images?.length ? { images: opts.images } : {}),
          recordInjection: (artifact) => {
            stageSpan.annotations.injection = artifact;
            if (stage.role === 'execute' && !executorInput) {
              executorInput = true;
              opts?.onExecutorInput?.();
            }
          },
          nativeObservation: opts?.nativeObservation,
          recordNative: (evidence) => {
            stageSpan.annotations.native = evidence;
          },
          recordCompleted: (output) => {
            stageSpan.annotations.executorCompletion = { output };
          },
        });
        invokedAgents.push({ id: agentId, mode: stage.invocation });
        stageResults.set(agentId, result);

        // Track the last execute-role agent for final result extraction
        if (stage.role === 'execute') {
          lastExecuteAgentId = agentId;
        }

        if (trace.current && result.meta?.injection) {
          trace.current.annotations.injection = result.meta.injection;
        }
        trace.end(result.output);
      }

      // Run any remaining on-demand agents requested by middleware
      for (const agentId of requestedAgents) {
        const alreadyRan = invokedAgents.some((a) => a.id === agentId);
        if (alreadyRan) continue;
        if (!this.thread.getAgent(agentId)) continue;

        const layerFilter = this.buildLayerFilter(requestedLayers);
        trace.start(`on-demand:${agentId}`, 'enrich', { agentId });
        const result = await this.thread.dispatch(agentId, message.payload, layerFilter, {
          role: 'enrich',
          messageId: message.id,
          invocation: 'on-demand',
        });
        invokedAgents.push({ id: agentId, mode: 'on-demand' });
        stageResults.set(agentId, result);
        trace.end(result.output);
      }

      trace.finish();
      this._recordTrace(trace, opts?.onTrace);

      // Final result: from last execute-role agent, or last invoked agent
      const finalAgentId = lastExecuteAgentId ?? invokedAgents[invokedAgents.length - 1]?.id;
      const finalResult =
        (finalAgentId ? stageResults.get(finalAgentId) : undefined) ??
        ({ output: null, contextHash: '' } as ExecutionResult);

      const layerFilter = this.buildLayerFilter(requestedLayers);
      const activeLayers = this.thread.stack.layers.filter(layerFilter).map((l) => l.id);

      return {
        messageId: message.id,
        result: finalResult,
        trace,
        timestamp: Date.now(),
        invokedAgents,
        activeLayers,
      };
    } catch (err) {
      const error =
        err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) };
      while (trace.current) trace.end(undefined, error);
      trace.finish();
      this._recordTrace(trace, opts?.onTrace);
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

  async fan<T>(agentIds: string[], payload: T, filterOverride?: LayerFilter): Promise<FanResult[]> {
    return this.thread.fan(agentIds, payload, filterOverride);
  }

  /** Explicitly invoke an on-demand agent (for use by middleware or external callers). */
  async invokeOnDemand<T>(agentId: string, payload: T): Promise<ExecutionResult> {
    const layerFilter = this.buildLayerFilter();
    return this.thread.dispatch(agentId, payload, layerFilter, {
      role: 'enrich',
      invocation: 'on-demand',
    });
  }

  async runPipeline<T>(input: T, trace?: Trace): Promise<unknown> {
    let current: unknown = input;
    const t = trace ?? new Trace('pipeline');

    for (const step of this._pipeline) {
      t.start(step.id, 'middleware', { input: current });
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

  /** Get the effective flow (explicit or built from the default executor). */
  get effectiveFlow(): FlowConfig {
    return this._resolveFlow();
  }

  get agentModes(): ReadonlyMap<string, { invocation: string }> {
    return this._agentModes;
  }

  get layerModes(): ReadonlyMap<string, { activation: string }> {
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

  private _recordTrace(trace: Trace, onTrace?: (trace: Trace) => void): void {
    this._traces.push(trace);
    if (this._traces.length > this._maxTraces) {
      this._traces.shift();
    }
    try {
      onTrace?.(trace);
    } catch (error) {
      console.warn('[Harness] trace observer failed:', error);
    }
  }
}
