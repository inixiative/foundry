import { ContextStack } from "./context-stack";
import type { LayerFilter, ContextStackView } from "./context-stack";
import { CacheLifecycle } from "./cache-lifecycle";
import { BaseAgent, type ExecutionResult } from "./base-agent";
import { MiddlewareChain, type DispatchContext } from "./middleware";
import { SignalBus } from "./signal";
import type { TokenTracker } from "./token-tracker";
import type { ToolCallObservation } from "./tools";
import type { InjectionArtifact } from "./messages";
import { newId } from "./id";

export type ThreadStatus = "idle" | "active" | "waiting" | "archived";

export interface ThreadMeta {
  /** Living description — what this thread is doing right now. */
  description: string;

  /** Classification tags — what kind of work this thread handles. */
  tags: string[];

  /** Current status. */
  status: ThreadStatus;

  /** Working directory for this thread's tool execution (worktree path). */
  cwd?: string;

  /** Git branch this thread is assigned to. */
  branch?: string;

  /** Parent thread when this thread is a subagent spawned by another. */
  parentThreadId?: string;

  /** Project that owns this thread. Scopes memory sources and tool calls. */
  projectId?: string;

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

/**
 * Per-dispatch options. Correlation fields are supplied by whoever drives the
 * dispatch (a Harness stage, an on-demand request) and ride along on the
 * observation signal; the thread never invents them.
 */
export interface DispatchOptions {
  nativeObservation?: Omit<import("./native-evidence").NativeObservation, "owner"> & { generation: string };
  recordNative?: (evidence: import("./native-evidence").NativeEvidence) => void;
  recordCompleted?: (output: unknown) => void;
  /** Streaming sink for executor text deltas. */
  onDelta?: (text: string) => void;
  recordInjection?: (artifact: InjectionArtifact) => void;
  /** Pipeline role when dispatched by a Harness stage (classify, route, execute, ...). */
  role?: string;
  /** Harness message this dispatch serves, when there is one. */
  messageId?: string;
  /** How the caller invoked the agent: always, conditional, on-demand, background. */
  invocation?: string;
}

/**
 * Structured payload of a `dispatch` signal. Emitted exactly once per
 * dispatch at the thread boundary, for every entry point (direct, background,
 * fan, Harness stages), on the dispatching thread's own bus.
 */
export interface DispatchObservation {
  readonly threadId: string;
  /** Identity of the dispatch; tool observations for this work carry the same id. */
  readonly dispatchId: string;
  readonly agentId: string;
  /** Serialized payload, bounded to MAX_OBSERVED_PAYLOAD characters. */
  readonly payload: string;
  readonly durationMs: number;
  readonly ok: boolean;
  /** Error message when `ok` is false. */
  readonly error?: string;
  /** Context hash of the completed execution when `ok` is true. */
  readonly contextHash?: string;
  /** Serialized executor output when `ok` is true, bounded like `payload`. */
  readonly output?: string;
  readonly role?: string;
  readonly messageId?: string;
  readonly invocation?: string;
}

const MAX_OBSERVED_PAYLOAD = 2048;

export interface ThreadConfig {
  maxDispatches?: number;
  maxSignalHistory?: number;
  description?: string;
  tags?: string[];
  /** Working directory for this thread's tool execution (worktree path). */
  cwd?: string;
  /** Git branch this thread is assigned to. */
  branch?: string;
  /** Parent thread when this thread is a subagent spawned by another. */
  parentThreadId?: string;
  /** Project that owns this thread. Scopes memory sources and tool calls. */
  projectId?: string;
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
 *
 * Disposal is terminal: a disposed Thread object never dispatches again and
 * cannot be re-wired. Status (idle/active/waiting/archived) is a separate,
 * non-terminal concern; archiving is "set status archived, then dispose".
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
  private _disposers: Array<() => void> = [];
  private _disposed = false;
  private _activeDispatches = 0;

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
      cwd: opts?.cwd,
      branch: opts?.branch,
      parentThreadId: opts?.parentThreadId,
      projectId: opts?.projectId,
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

  /** Whether this thread has been disposed. Terminal. */
  get disposed(): boolean {
    return this._disposed;
  }

  /** Number of dispatches currently executing. */
  get activeDispatches(): number {
    return this._activeDispatches;
  }

  /**
   * Register cleanup that runs when this thread is archived or disposed.
   * Runtime wiring (middleware, subscriptions, owned layers) registers here so
   * whoever archives the thread tears it down without knowing the details.
   * Returns an unregister function.
   */
  onDispose(fn: () => void): () => void {
    this._disposers.push(fn);
    return () => {
      const idx = this._disposers.indexOf(fn);
      if (idx !== -1) this._disposers.splice(idx, 1);
    };
  }

  /**
   * Permanently close this thread: run registered cleanup exactly once, stop
   * the lifecycle, and refuse every later dispatch. Idempotent.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    const disposers = this._disposers;
    this._disposers = [];
    for (const fn of disposers) {
      try {
        fn();
      } catch (err) {
        console.warn(`[Thread] disposer failed for "${this.id}":`, (err as Error).message ?? err);
      }
    }
    this.stop();
  }

  /** Archive this thread. Sets the terminal status, then disposes. */
  archive(): void {
    this.meta.status = "archived";
    this.meta.archivedAt = Date.now();
    this.dispose();
  }

  // -- Dispatching (with middleware) --

  /**
   * The single dispatch boundary. Every entry point (direct, background, fan,
   * Harness stages) passes through here, so each dispatch is observed exactly
   * once on this thread's bus, including failures.
   */
  async dispatch<TPayload>(
    agentId: string,
    payload: TPayload,
    filterOverride?: LayerFilter,
    opts?: DispatchOptions,
  ): Promise<ExecutionResult> {
    // This dispatch's observation and middleware must retain the same logical
    // identity even if a caller later reuses/mutates its options object.
    opts = opts ? { ...opts } : undefined;
    if (this.meta.status === "archived") {
      throw new Error(`Thread archived: ${this.id} cannot dispatch "${agentId}"`);
    }
    if (this._disposed) {
      throw new Error(`Thread disposed: ${this.id} cannot dispatch "${agentId}"`);
    }
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    this._activeDispatches++;
    this.meta.status = "active";
    this.meta.lastActiveAt = Date.now();

    // Explicit identity for this dispatch. Middleware sees it, tool calls
    // executed on its behalf are observed with it, and the completion
    // observation carries it, so evidence never drifts to another completion.
    const dispatchId = newId("dispatch");
    const ctx: DispatchContext<TPayload> = {
      agentId,
      payload,
      timestamp: Date.now(),
      annotations: {},
      threadId: this.id,
      dispatchId,
      stack: this._createStackView(),
      projectId: this.meta.projectId,
      messageId: opts?.messageId,
    };

    const start = performance.now();

    const meta = {
      cwd: this.meta.cwd,
      threadId: this.id,
      projectId: this.meta.projectId,
      messageId: ctx.messageId,
      dispatchId,
      observeTool: (observation: ToolCallObservation) => {
        void this.signals.emit({
          id: newId("sig-tool"),
          kind: "tool_observation",
          source: `thread:${this.id}`,
          content: { threadId: this.id, dispatchId, agentId, ...observation, timestamp: Date.now() },
          timestamp: Date.now(),
        }).catch((err) => {
          console.warn(`[Thread] tool observation failed for "${agentId}":`, (err as Error).message ?? err);
        });
      },
      annotations: ctx.annotations,
      onDelta: opts?.onDelta,
      recordInjection: opts?.recordInjection,
      recordNative: opts?.recordNative,
      recordCompleted: opts?.recordCompleted,
      nativeObservation: opts?.nativeObservation ? {
        preflight: opts.nativeObservation.preflight,
        bridge: opts.nativeObservation.bridge,
        register: opts.nativeObservation.register, observe: opts.nativeObservation.observe,
        owner: Object.freeze({ threadId: this.id, projectId: this.meta.projectId, generation: opts.nativeObservation.generation,
          messageId: ctx.messageId, dispatchId }),
      } : undefined,
    };

    try {
      const result = await this.middleware.execute(ctx, () =>
        agent.run(payload, filterOverride, meta)
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

      await this._observe(agentId, payload, opts, dispatchId, {
        durationMs,
        ok: true,
        contextHash: result.contextHash,
        output: serializePayload(result.output),
      });

      return result;
    } catch (err) {
      await this._observe(agentId, payload, opts, dispatchId, {
        durationMs: performance.now() - start,
        ok: false,
        error: (err as Error)?.message ?? String(err),
      });
      throw err;
    } finally {
      this._activeDispatches--;
      // Only the last finishing dispatch returns the thread to idle, and a
      // late completion must not resurrect an archived (or paused) thread.
      if (this._activeDispatches === 0 && this.meta.status === "active") {
        this.meta.status = "idle";
      }
    }
  }

  /**
   * Fire-and-forget dispatch. Returns a handle with the promise
   * but does not block the caller. Errors are logged, not thrown.
   */
  dispatchBackground<TPayload>(
    agentId: string,
    payload: TPayload,
    filterOverride?: LayerFilter,
    opts?: DispatchOptions,
  ): BackgroundHandle {
    const promise = this.dispatch(agentId, payload, filterOverride, opts).catch(
      async (err) => {
        console.warn(`[Thread] background dispatch "${agentId}" failed:`, (err as Error).message);
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
    filterOverride?: LayerFilter,
    opts?: DispatchOptions,
  ): Promise<FanResult[]> {
    const settled = await Promise.allSettled(
      agentIds.map((id) => this.dispatch(id, payload, filterOverride, opts))
    );

    return settled.map((s, i) => {
      if (s.status === "fulfilled") {
        return { agentId: agentIds[i], status: "fulfilled" as const, result: s.value };
      } else {
        return { agentId: agentIds[i], status: "rejected" as const, error: s.reason };
      }
    });
  }

  // -- Observation --

  private async _observe(
    agentId: string,
    payload: unknown,
    opts: DispatchOptions | undefined,
    dispatchId: string,
    outcome: Pick<DispatchObservation, "durationMs" | "ok" | "error" | "contextHash" | "output">,
  ): Promise<void> {
    const content: DispatchObservation = {
      threadId: this.id,
      dispatchId,
      agentId,
      payload: serializePayload(payload),
      ...outcome,
      ...(opts?.role ? { role: opts.role } : {}),
      ...(opts?.messageId ? { messageId: opts.messageId } : {}),
      ...(opts?.invocation ? { invocation: opts.invocation } : {}),
    };
    try {
      await this.signals.emit({
        id: newId("sig-dispatch"),
        kind: "dispatch",
        source: opts?.role ? `harness:${agentId}` : `thread:${this.id}`,
        content,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`[Thread] dispatch observation failed for "${agentId}":`, (err as Error).message ?? err);
    }
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

  /**
   * Start (or resume) the cache lifecycle. Pause/resume is stop/start on a
   * live thread; a disposed thread is terminal and cannot be resumed, only
   * replaced by a new thread.
   */
  start(): void {
    if (this._disposed) {
      throw new Error(`Thread disposed: ${this.id} cannot be started; create a new thread to restore it`);
    }
    this.lifecycle.start();
  }

  stop(): void {
    this.lifecycle.stop();
  }
}

/** Serialize a dispatch payload for observation, bounded in size. */
function serializePayload(payload: unknown): string {
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else {
    try {
      text = JSON.stringify(payload) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  return text.length > MAX_OBSERVED_PAYLOAD ? text.slice(0, MAX_OBSERVED_PAYLOAD) : text;
}
