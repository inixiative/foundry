import { ContextLayer } from "./context-layer";
import { ContextStack } from "./context-stack";
import { Thread } from "./thread";
import type { BaseAgent } from "./base-agent";
import type { ExecutionResult } from "./base-agent";
import type { LayerFilter } from "./context-stack";

/**
 * A recipe for creating a thread on demand.
 * When a Router sends something to a destination that doesn't exist yet,
 * the SessionManager looks for a blueprint that matches and uses it
 * to spin up the thread with the right context.
 */
export interface ThreadBlueprint {
  /** Pattern to match against route destinations. String = exact, RegExp = pattern. */
  readonly match: string | RegExp;

  /**
   * Build the thread. Receives the destination id and the parent thread
   * (if the route originated from an existing thread).
   */
  create(
    destinationId: string,
    parent?: Thread
  ): Thread | Promise<Thread>;
}

/**
 * Policy for how layers transfer from parent to child thread.
 */
export interface LayerInheritance {
  /** Layer ids to share by reference (both threads see the same layer instance). */
  share?: string[];

  /** Layer ids to copy (child gets a snapshot, independent from parent). */
  copy?: string[];

  /** Copy all warm layers from parent. Overridden by share/copy for specific ids. */
  copyAll?: boolean;
}

/**
 * SessionManager — manages a tree of threads.
 *
 * Threads are created lazily. When a dispatch targets a destination
 * that doesn't exist as a local agent, the SessionManager checks if
 * it's a known thread or can be spawned from a blueprint.
 *
 * The Router doesn't need to know about forking — it just says
 * "this goes to feature-auth" and if that thread doesn't exist,
 * it gets created. Same code path either way.
 */
export class SessionManager {
  private _threads: Map<string, Thread> = new Map();
  private _blueprints: ThreadBlueprint[] = [];
  private _parentOf: Map<string, string> = new Map(); // child → parent
  private _listeners: Array<(event: SessionEvent) => void> = [];

  /** Register an existing thread. */
  add(thread: Thread): void {
    this._threads.set(thread.id, thread);
    this._emit({ type: "thread:added", threadId: thread.id, timestamp: Date.now() });
  }

  /** Remove a thread. */
  remove(id: string): boolean {
    const removed = this._threads.delete(id);
    if (removed) {
      this._parentOf.delete(id);
      this._emit({ type: "thread:removed", threadId: id, timestamp: Date.now() });
    }
    return removed;
  }

  /** Get a thread by id. */
  get(id: string): Thread | undefined {
    return this._threads.get(id);
  }

  /** All threads. */
  get threads(): ReadonlyMap<string, Thread> {
    return this._threads;
  }

  /** Threads currently active or idle (not archived). */
  get active(): Thread[] {
    return [...this._threads.values()].filter(
      (t) => t.meta.status !== "archived"
    );
  }

  /** Archived threads. */
  get archived(): Thread[] {
    return [...this._threads.values()].filter(
      (t) => t.meta.status === "archived"
    );
  }

  /** Register a blueprint for lazy thread creation. */
  addBlueprint(blueprint: ThreadBlueprint): void {
    this._blueprints.push(blueprint);
  }

  /** Get the parent thread of a child. */
  parentOf(childId: string): Thread | undefined {
    const parentId = this._parentOf.get(childId);
    return parentId ? this._threads.get(parentId) : undefined;
  }

  /** Get all children of a thread. */
  childrenOf(parentId: string): Thread[] {
    const children: Thread[] = [];
    for (const [childId, pId] of this._parentOf) {
      if (pId === parentId) {
        const thread = this._threads.get(childId);
        if (thread) children.push(thread);
      }
    }
    return children;
  }

  /**
   * Resolve a destination — find an existing thread or spawn one.
   *
   * This is the core primitive. The Router says "send to X".
   * resolve("X") returns the thread, creating it if needed.
   */
  async resolve(
    destinationId: string,
    parent?: Thread
  ): Promise<Thread | undefined> {
    // Already exists?
    const existing = this._threads.get(destinationId);
    if (existing) return existing;

    // Match a blueprint
    for (const bp of this._blueprints) {
      const matches =
        typeof bp.match === "string"
          ? bp.match === destinationId
          : bp.match.test(destinationId);

      if (matches) {
        const thread = await bp.create(destinationId, parent);
        this._threads.set(thread.id, thread);

        if (parent) {
          this._parentOf.set(thread.id, parent.id);
        }

        this._emit({
          type: "thread:spawned",
          threadId: thread.id,
          parentId: parent?.id,
          timestamp: Date.now(),
        });

        return thread;
      }
    }

    return undefined;
  }

  /**
   * Dispatch to a destination — resolves the thread and dispatches.
   * If the destination is a local agent on the source thread, dispatches there.
   * If it's another thread, resolves (or spawns) that thread and dispatches.
   */
  async dispatch<T>(
    destinationId: string,
    payload: T,
    opts?: {
      sourceThread?: Thread;
      agentId?: string;
      filterOverride?: LayerFilter;
    }
  ): Promise<ExecutionResult> {
    const source = opts?.sourceThread;

    // If source thread has this agent locally, dispatch there
    if (source && source.getAgent(destinationId)) {
      return source.dispatch(destinationId, payload, opts?.filterOverride);
    }

    // Resolve the target thread
    const targetThread = await this.resolve(destinationId, source);
    if (!targetThread) {
      throw new Error(
        `Cannot resolve destination: ${destinationId}. No thread or blueprint matches.`
      );
    }

    // Dispatch to the target thread's specified agent, or its default
    const agentId = opts?.agentId ?? this._findDefaultAgent(targetThread);
    if (!agentId) {
      throw new Error(
        `Thread ${targetThread.id} has no agents registered`
      );
    }

    return targetThread.dispatch(agentId, payload, opts?.filterOverride);
  }

  // -- Observation --

  onSession(listener: (event: SessionEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  // -- Helpers --

  /**
   * Copy layers from a parent thread to a new stack, applying inheritance rules.
   * Utility for blueprint.create() implementations.
   */
  static inheritLayers(
    parent: Thread,
    rules: LayerInheritance
  ): ContextStack {
    const stack = new ContextStack();
    const shareSet = new Set(rules.share ?? []);
    const copySet = new Set(rules.copy ?? []);

    for (const layer of parent.stack.layers) {
      if (shareSet.has(layer.id)) {
        // Share by reference — same instance
        stack.addLayer(layer);
      } else if (copySet.has(layer.id) || rules.copyAll) {
        // Copy — new layer with same content
        const copy = new ContextLayer({ id: layer.id, trust: layer.trust });
        if (layer.isWarm) {
          copy.set(layer.content);
        }
        stack.addLayer(copy);
      }
    }

    return stack;
  }

  // -- Internal --

  private _findDefaultAgent(thread: Thread): string | undefined {
    // Return the first registered agent
    const first = thread.agents.entries().next();
    return first.done ? undefined : first.value[0];
  }

  private _emit(event: SessionEvent): void {
    for (const listener of this._listeners) {
      listener(event);
    }
  }
}

export interface SessionEvent {
  readonly type: "thread:added" | "thread:removed" | "thread:spawned";
  readonly threadId: string;
  readonly parentId?: string;
  readonly timestamp: number;
}
