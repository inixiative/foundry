/**
 * @atlas
 * @kind service
 * @partOf feature:viewer, primitive:settings
 */
import type { EventStream, Harness, InterventionLog, Thread } from '@inixiative/foundry-core';

// ---------------------------------------------------------------------------
// Operator actions — commands that the viewer can send to the system
// ---------------------------------------------------------------------------

export type ActionKind =
  | 'thread:pause'
  | 'thread:resume'
  | 'thread:archive'
  | 'thread:unarchive'
  | 'thread:inspect'
  | 'layer:warm'
  | 'layer:invalidate'
  | 'agent:dispatch'
  | 'system:snapshot';

export interface OperatorAction {
  readonly kind: ActionKind;
  readonly target?: string;
  readonly threadId?: string;
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
  private _actionLog: OperatorAction[] = [];
  private _maxLog = 500;
  private _resolveThread: (id: string) => Thread | undefined;
  private _onThreadChange?: (thread: Thread) => void;
  private _reopenThread?: (id: string) => boolean;
  private _childrenOf: (id: string) => Thread[];

  constructor(opts: {
    harness: Harness;
    eventStream: EventStream;
    interventions: InterventionLog;
    resolveThread?: (id: string) => Thread | undefined;
    onThreadChange?: (thread: Thread) => void;
    /** Bring an archived thread back (the turn service's reopen: rebuilt with its journal and binding). */
    reopenThread?: (id: string) => boolean;
    /** A thread's subagent threads (`meta.spawn` under `meta.parentThreadId`): archiving a thread archives them too. */
    childrenOf?: (id: string) => Thread[];
  }) {
    this._harness = opts.harness;
    this._events = opts.eventStream;
    this._interventions = opts.interventions;
    this._resolveThread =
      opts.resolveThread ??
      ((id) => (id === opts.harness.thread.id ? opts.harness.thread : undefined));
    this._onThreadChange = opts.onThreadChange;
    this._reopenThread = opts.reopenThread;
    this._childrenOf = opts.childrenOf ?? (() => []);
  }

  /** Execute an operator action. */
  async execute(action: OperatorAction): Promise<ActionResult> {
    this._actionLog.push(action);
    if (this._actionLog.length > this._maxLog) {
      this._actionLog.shift();
    }

    const threadAction = action.kind.startsWith('thread:');
    if (threadAction && action.target && action.threadId && action.target !== action.threadId) {
      return { ok: false, action: action.kind, message: 'Conflicting thread targets' };
    }
    const threadId =
      (threadAction ? action.target : undefined) ?? action.threadId ?? this._harness.thread.id;
    const thread = this._resolveThread(threadId);
    if (!thread) return { ok: false, action: action.kind, message: `Thread ${threadId} not found` };
    // Undoing an archive: the reopen rebuilds the thread and records it open.
    if (action.kind === 'thread:unarchive') {
      if (!thread.disposed)
        return { ok: true, action: action.kind, message: `Thread ${threadId} is open` };
      // The subagents archived with it (they carry its archive time) come back with it.
      const archivedAt = thread.meta.archivedAt;
      const subagents = this._subagentsOf(thread.id).filter(
        (s) => s.disposed && archivedAt !== undefined && s.meta.archivedAt === archivedAt,
      );
      const reopened = this._reopenThread?.(threadId) ?? false;
      if (!reopened)
        return { ok: false, action: action.kind, message: `Thread ${threadId} can't be reopened` };
      const back = subagents.filter((s) => this._reopenThread?.(s.id)).length;
      return {
        ok: true,
        action: action.kind,
        message: `Thread ${threadId} reopened${back ? ` with ${back} subagent${back === 1 ? '' : 's'}` : ''}`,
      };
    }
    if (thread.disposed && action.kind !== 'thread:inspect' && action.kind !== 'system:snapshot') {
      return {
        ok: false,
        action: action.kind,
        message: `Thread ${threadId} is disposed; create a new thread to restore it`,
      };
    }
    const result = await this._executeThread(action, thread);
    if (result.ok) this._onThreadChange?.(thread);
    return result;
  }

  private async _executeThread(action: OperatorAction, thread: Thread): Promise<ActionResult> {
    switch (action.kind) {
      case 'thread:pause':
        return this._pauseThread(action, thread);
      case 'thread:resume':
        return this._resumeThread(action, thread);
      case 'thread:archive':
        return this._archiveThread(action, thread);
      case 'thread:inspect':
        return this._inspectThread(action, thread);
      case 'layer:warm':
        return this._warmLayer(action, thread);
      case 'layer:invalidate':
        return this._invalidateLayer(action, thread);
      case 'agent:dispatch':
        return this._dispatchAgent(action, thread);
      case 'system:snapshot':
        return this._systemSnapshot(thread);
      default:
        return { ok: false, action: action.kind, message: `Unknown action: ${action.kind}` };
    }
  }

  /** Get action history. */
  get history(): ReadonlyArray<OperatorAction> {
    return this._actionLog;
  }

  // -- Handlers --

  private _pauseThread(action: OperatorAction, thread: Thread): ActionResult {
    thread.meta.status = 'waiting';
    thread.stop();
    return {
      ok: true,
      action: action.kind,
      message: `Thread ${thread.id} cache lifecycle paused; current work is not interrupted`,
    };
  }

  private _resumeThread(action: OperatorAction, thread: Thread): ActionResult {
    thread.start();
    thread.meta.status = thread.activeDispatches > 0 ? 'active' : 'idle';
    return { ok: true, action: action.kind, message: `Thread ${thread.id} resumed` };
  }

  /**
   * Archive the thread and every open subagent under it, children before their parent. Each subagent
   * takes the parent's archive time, so undoing the archive knows which ones went with it.
   */
  private _archiveThread(action: OperatorAction, thread: Thread): ActionResult {
    const subagents = this._subagentsOf(thread.id)
      .filter((s) => !s.disposed)
      .reverse();
    for (const subagent of subagents) subagent.archive();
    thread.archive();
    for (const subagent of subagents) {
      subagent.meta.archivedAt = thread.meta.archivedAt;
      this._onThreadChange?.(subagent);
    }
    const n = subagents.length;
    return {
      ok: true,
      action: action.kind,
      message: `Thread ${thread.id} archived${n ? ` with ${n} subagent${n === 1 ? '' : 's'}` : ''}`,
    };
  }

  /** Every subagent under a thread, at any depth, each parent before its children. */
  private _subagentsOf(rootId: string): Thread[] {
    const found: Thread[] = [];
    const seen = new Set<string>([rootId]);
    const walk = (id: string) => {
      for (const child of this._childrenOf(id)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        found.push(child);
        walk(child.id);
      }
    };
    walk(rootId);
    return found;
  }

  private _inspectThread(action: OperatorAction, thread: Thread): ActionResult {
    const data = {
      id: thread.id,
      meta: thread.meta,
      agentCount: thread.agents.size,
      agents: [...thread.agents.entries()].map(([id, a]) => ({ id, agentId: a.id })),
      layerCount: thread.stack.layers.length,
      layers: thread.stack.layers.map((l) => ({
        id: l.id,
        state: l.state,
        hash: l.hash,
        contentLength: l.content.length,
        tokenEstimate: Math.ceil(l.content.length / 4),
      })),
      dispatchCount: thread.dispatches.length,
      signalCount: thread.signals.recent().length,
    };
    return { ok: true, action: action.kind, message: 'Thread state', data };
  }

  private async _warmLayer(action: OperatorAction, thread: Thread): Promise<ActionResult> {
    const layerId = action.target;
    if (!layerId) {
      return { ok: false, action: action.kind, message: 'layer:warm requires a target layer ID' };
    }
    const layer = thread.stack.layers.find((l) => l.id === layerId);
    if (!layer) {
      return { ok: false, action: action.kind, message: `Layer ${layerId} not found` };
    }
    try {
      await layer.warm();
      return { ok: true, action: action.kind, message: `Layer ${layerId} warmed` };
    } catch (err) {
      return {
        ok: false,
        action: action.kind,
        message: `Layer ${layerId} warming failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private _invalidateLayer(action: OperatorAction, thread: Thread): ActionResult {
    const layerId = action.target;
    if (!layerId) {
      return {
        ok: false,
        action: action.kind,
        message: 'layer:invalidate requires a target layer ID',
      };
    }
    const layer = thread.stack.layers.find((l) => l.id === layerId);
    if (!layer) {
      return { ok: false, action: action.kind, message: `Layer ${layerId} not found` };
    }
    layer.invalidate();
    return { ok: true, action: action.kind, message: `Layer ${layerId} invalidated` };
  }

  private async _dispatchAgent(action: OperatorAction, thread: Thread): Promise<ActionResult> {
    const agentId = action.target;
    if (!agentId) {
      return {
        ok: false,
        action: action.kind,
        message: 'agent:dispatch requires a target agent ID',
      };
    }
    try {
      const result = await thread.dispatch(agentId, action.payload ?? {});
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

  private _systemSnapshot(thread: Thread): ActionResult {
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
        contentLength: l.content.length,
      })),
      traces: thread === this._harness.thread ? this._harness.traces.length : null,
      recentDispatches: thread.dispatches.slice(-10).map((d) => ({
        agentId: d.agentId,
        timestamp: d.timestamp,
        durationMs: d.durationMs,
        contextHash: d.contextHash,
      })),
    };
    return { ok: true, action: 'system:snapshot', message: 'System snapshot', data };
  }
}
