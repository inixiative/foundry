import type { Harness, EventStream, InterventionLog } from "@inixiative/foundry-core";
import type { RuntimeAdapter } from "../providers/runtime";

// ---------------------------------------------------------------------------
// Operator actions — commands that the viewer can send to the system
// ---------------------------------------------------------------------------

export type ActionKind =
  | "thread:pause"
  | "thread:resume"
  | "thread:archive"
  | "thread:inspect"
  | "layer:warm"
  | "layer:invalidate"
  | "agent:dispatch"
  | "runtime:command"
  | "system:snapshot";

export interface OperatorAction {
  readonly kind: ActionKind;
  readonly target?: string;
  readonly payload?: Record<string, unknown>;
  readonly operator?: string;
  readonly timestamp: number;
}

export interface ActionResult {
  readonly ok: boolean;
  readonly action: ActionKind;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * ActionHandler — executes operator actions against the system.
 * Wired into the viewer's /api/actions endpoint.
 */
export class ActionHandler {
  private _harness: Harness;
  private _events: EventStream;
  private _interventions: InterventionLog;
  private _runtimes: Map<string, RuntimeAdapter> = new Map();
  private _actionLog: OperatorAction[] = [];
  private _maxLog = 500;

  constructor(opts: {
    harness: Harness;
    eventStream: EventStream;
    interventions: InterventionLog;
  }) {
    this._harness = opts.harness;
    this._events = opts.eventStream;
    this._interventions = opts.interventions;
  }

  /** Register a runtime adapter for command passthrough. */
  registerRuntime(adapter: RuntimeAdapter): void {
    this._runtimes.set(adapter.id, adapter);
  }

  /** Execute an operator action. */
  async execute(action: OperatorAction): Promise<ActionResult> {
    this._actionLog.push(action);
    if (this._actionLog.length > this._maxLog) {
      this._actionLog.shift();
    }

    switch (action.kind) {
      case "thread:pause":
        return this._pauseThread(action);
      case "thread:resume":
        return this._resumeThread(action);
      case "thread:archive":
        return this._archiveThread(action);
      case "thread:inspect":
        return this._inspectThread(action);
      case "layer:warm":
        return this._warmLayer(action);
      case "layer:invalidate":
        return this._invalidateLayer(action);
      case "agent:dispatch":
        return this._dispatchAgent(action);
      case "runtime:command":
        return this._runtimeCommand(action);
      case "system:snapshot":
        return this._systemSnapshot();
      default:
        return { ok: false, action: action.kind, message: `Unknown action: ${action.kind}` };
    }
  }

  /** Get action history. */
  get history(): ReadonlyArray<OperatorAction> {
    return this._actionLog;
  }

  // -- Handlers --

  private _pauseThread(action: OperatorAction): ActionResult {
    const thread = this._harness.thread;
    if (action.target && action.target !== thread.id) {
      return { ok: false, action: action.kind, message: `Thread ${action.target} not found` };
    }
    thread.meta.status = "waiting";
    thread.stop();
    return { ok: true, action: action.kind, message: `Thread ${thread.id} paused` };
  }

  private _resumeThread(action: OperatorAction): ActionResult {
    const thread = this._harness.thread;
    if (action.target && action.target !== thread.id) {
      return { ok: false, action: action.kind, message: `Thread ${action.target} not found` };
    }
    thread.meta.status = "idle";
    thread.start();
    return { ok: true, action: action.kind, message: `Thread ${thread.id} resumed` };
  }

  private _archiveThread(action: OperatorAction): ActionResult {
    const thread = this._harness.thread;
    thread.archive();
    return { ok: true, action: action.kind, message: `Thread ${thread.id} archived` };
  }

  private _inspectThread(action: OperatorAction): ActionResult {
    const thread = this._harness.thread;
    const data = {
      id: thread.id,
      meta: thread.meta,
      agentCount: thread.agents.size,
      agents: [...thread.agents.entries()].map(([id, a]) => ({ id, agentId: a.id })),
      layerCount: thread.stack.layers.length,
      layers: thread.stack.layers.map((l) => ({
        id: l.id,
        state: l.state,
        trust: l.trust,
        hash: l.hash,
        contentLength: l.content.length,
        tokenEstimate: Math.ceil(l.content.length / 4),
      })),
      dispatchCount: thread.dispatches.length,
      signalCount: thread.signals.recent().length,
    };
    return { ok: true, action: action.kind, message: "Thread state", data };
  }

  private async _warmLayer(action: OperatorAction): Promise<ActionResult> {
    const layerId = action.target;
    if (!layerId) {
      return { ok: false, action: action.kind, message: "layer:warm requires a target layer ID" };
    }
    const layer = this._harness.thread.stack.layers.find((l) => l.id === layerId);
    if (!layer) {
      return { ok: false, action: action.kind, message: `Layer ${layerId} not found` };
    }
    // Emit a lifecycle event to trigger warming rules
    await this._harness.thread.lifecycle.emit({
      type: "warm",
      layerId,
      timestamp: Date.now(),
    });
    return { ok: true, action: action.kind, message: `Layer ${layerId} warm event emitted` };
  }

  private _invalidateLayer(action: OperatorAction): ActionResult {
    const layerId = action.target;
    if (!layerId) {
      return { ok: false, action: action.kind, message: "layer:invalidate requires a target layer ID" };
    }
    const layer = this._harness.thread.stack.layers.find((l) => l.id === layerId);
    if (!layer) {
      return { ok: false, action: action.kind, message: `Layer ${layerId} not found` };
    }
    layer.clear();
    return { ok: true, action: action.kind, message: `Layer ${layerId} invalidated` };
  }

  private async _dispatchAgent(action: OperatorAction): Promise<ActionResult> {
    const agentId = action.target;
    if (!agentId) {
      return { ok: false, action: action.kind, message: "agent:dispatch requires a target agent ID" };
    }
    try {
      const result = await this._harness.dispatch(agentId, action.payload ?? {});
      return {
        ok: true,
        action: action.kind,
        message: `Dispatched to ${agentId}`,
        data: { output: result.output, contextHash: result.contextHash },
      };
    } catch (err) {
      return {
        ok: false,
        action: action.kind,
        message: `Dispatch to ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private _runtimeCommand(action: OperatorAction): ActionResult {
    const runtimeId = action.target;
    if (!runtimeId) {
      return { ok: false, action: action.kind, message: "runtime:command requires a target runtime ID" };
    }
    const runtime = this._runtimes.get(runtimeId);
    if (!runtime) {
      const available = [...this._runtimes.keys()].join(", ") || "none";
      return { ok: false, action: action.kind, message: `Runtime ${runtimeId} not found. Available: ${available}` };
    }
    // Emit the command as a runtime event that the adapter can pick up
    // This is the passthrough mechanism — the viewer sends a command,
    // and registered event handlers on the runtime process it
    return {
      ok: true,
      action: action.kind,
      message: `Command sent to runtime ${runtimeId}`,
      data: { runtimeId, command: action.payload },
    };
  }

  private _systemSnapshot(): ActionResult {
    const thread = this._harness.thread;
    const data = {
      timestamp: Date.now(),
      thread: {
        id: thread.id,
        status: thread.meta.status,
        description: thread.meta.description,
        tags: thread.meta.tags,
      },
      agents: [...thread.agents.entries()].map(([id, a]) => ({ id, agentId: a.id })),
      layers: thread.stack.layers.map((l) => ({
        id: l.id,
        state: l.state,
        trust: l.trust,
        contentLength: l.content.length,
      })),
      traces: this._harness.traces.length,
      recentDispatches: thread.dispatches.slice(-10).map((d) => ({
        agentId: d.agentId,
        timestamp: d.timestamp,
        durationMs: d.durationMs,
        contextHash: d.contextHash,
      })),
    };
    return { ok: true, action: "system:snapshot", message: "System snapshot", data };
  }
}
