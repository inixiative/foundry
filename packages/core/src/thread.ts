/**
 * @atlas
 * @kind service
 * @partOf primitive:thread
 */
import type { BaseAgent, ExecutionResult } from './base-agent';
import { CacheLifecycle } from './cache-lifecycle';
import type { ContextStack, ContextStackView, LayerFilter } from './context-stack';
import { newId } from './id';
import type { InjectionArtifact } from './messages';
import { type DispatchContext, MiddlewareChain } from './middleware';
import { SignalBus } from './signal';
import type { TokenTracker } from './token-tracker';
import type { ToolCallObservation } from './tools';

export type ThreadStatus = 'idle' | 'active' | 'waiting' | 'archived';

/** A thread name and when it was set. */
export interface ThreadName {
  readonly text: string;
  readonly updatedAt: number;
}

/** Tracked work a thread links to, in Archive's integration-reference shape (`github` `owner/repo#12`, `linear` `ENG-4`). */
export interface ThreadReference {
  readonly integration: string;
  readonly ref: string;
  readonly url?: string;
}

/**
 * A thread's worktree record. `mode` is how its repository makes worktrees (`template`: slots via
 * `worktree:create`; `classic`: plain git; `none`: the thread works outside any git checkout).
 * `released` means the recorded checkout no longer exists on disk; the rest is what it was.
 */
export interface ThreadCheckout {
  readonly mode: 'template' | 'classic' | 'none';
  /** Worktree root (absent for `none`). */
  readonly path?: string;
  /** The repository's main checkout (absent for `none`). */
  readonly root?: string;
  /** The repository's main checkout rather than a linked worktree. */
  readonly main: boolean;
  /** Template mode: the slot the worktree holds (main checkout = 0). */
  readonly slot?: number;
  /** `recreating`: the mode's create is running for a released worktree. */
  readonly state: 'live' | 'released' | 'recreating';
  /** The last recreate failed: the command's error. */
  readonly error?: string;
}

/** One item of a plan section: a short line, and its detail when the line is not enough. */
export interface ThreadPlanItem {
  readonly text: string;
  readonly detail?: string;
}

/**
 * The thread's plan, written by its agent through Foundry's `set_plan` tool. Outcomes are what the
 * person gets (`you`: waits on the person); pains what hurts today; strategy how the work goes;
 * reasons why this way. Each technical row names, per concern (auth, permissions, db access,
 * requests, locks, jobs, events, errors…), the existing system it uses and where, or why none fits.
 */
export interface ThreadPlan {
  readonly outcomes: readonly (ThreadPlanItem & {
    readonly status: 'todo' | 'doing' | 'done' | 'you';
  })[];
  readonly pains: readonly ThreadPlanItem[];
  readonly strategy: readonly ThreadPlanItem[];
  readonly reasons: readonly ThreadPlanItem[];
  readonly technical: readonly {
    readonly concern: string;
    readonly decision: 'reuse' | 'extend' | 'new' | 'combine' | 'refactor' | 'migrate' | 'none';
    readonly system: string;
    readonly path?: string;
    readonly reason: string;
  }[];
  readonly updatedAt: number;
}

/**
 * A thread snoozed by its person: quiet until `until` (ISO), then cleared. `condition` names what
 * the time was resolved from (`quota-reset`: when the reached usage window resets). A snooze never
 * changes the thread's status, so clearing it leaves the thread as it was.
 */
export interface ThreadSnooze {
  readonly until: string;
  readonly condition?: 'quota-reset';
  readonly setAt: string;
}

/** Where a thread's work lives, as the runtime last observed it. */
export interface ThreadContext {
  /** `owner/repo` of the worktree's origin. */
  readonly repository?: string;
  /** Branch checked out in the worktree now (may differ from the assigned `branch`). */
  readonly branch?: string;
  /** Worktree root containing the thread's cwd. */
  readonly worktree?: string;
  /** The thread's checkout as a worktree record (FEAT-003): mode, slot and whether it still exists. */
  readonly checkout?: ThreadCheckout;
  readonly references: readonly ThreadReference[];
  readonly updatedAt: number;
}

/** The name a thread shows: a person's name overrides the one Foundry gives it. */
export function threadTitle(
  meta: Pick<ThreadMeta, 'name' | 'foundryName' | 'description'>,
): { text: string; source: 'human' | 'foundry' | 'description' } | undefined {
  if (meta.name?.text) return { text: meta.name.text, source: 'human' };
  if (meta.foundryName?.text) return { text: meta.foundryName.text, source: 'foundry' };
  return meta.description ? { text: meta.description, source: 'description' } : undefined;
}

/**
 * Where a forked thread came from: provenance, not nesting. A fork is a top-level thread (Aron,
 * 2026-11-01: delegated threads are top-level; nesting is for subagents), so it is not a
 * `parentThreadId`. Its first session is seeded with the source's conversation through `journalSeq`.
 */
export interface ThreadFork {
  readonly threadId: string;
  /** The source's journal seq the fork was cut at. */
  readonly journalSeq: number;
}

/** How a subagent thread came to be: who spawned it, through what, and its native identity. */
export interface ThreadSpawn {
  readonly via: 'foundry' | 'native-claude' | 'native-codex' | 'host-paseo' | 'host-t3';
  /** The parent's tool call that spawned it. */
  readonly toolCallId?: string;
  /** The native run's id (Claude task id, Codex child thread id). */
  readonly nativeTaskId?: string;
  readonly agentType?: string;
  readonly description?: string;
  /** The parent's `handoff` phase row for this spawn. */
  readonly handoffId?: string;
  /** Recorded from the native stream only: no Foundry middleware ran on it. */
  readonly observed?: boolean;
}

export interface ThreadMeta {
  /** Living description — what this thread is doing right now. */
  description: string;

  /** Name a person set. A hard override: agents never change it. */
  name?: ThreadName;

  /**
   * Name Foundry gives the thread from the person's messages (its first message, then again when
   * the work moves) while no person has named it. Never set once a person has.
   */
  foundryName?: ThreadName;

  /** Branch, worktree and linked PRs/tickets, derived by the runtime. */
  context?: ThreadContext;

  /** Classification tags — what kind of work this thread handles. */
  tags: string[];

  /** Current status. */
  status: ThreadStatus;

  /** The agent's plan for the thread's work (`set_plan`, the Plan view): what, why, and how. */
  plan?: ThreadPlan;

  /** Put out of mind until a time (or a condition, resolved to its time); status is untouched. */
  snooze?: ThreadSnooze;

  /** Working directory for this thread's tool execution (worktree path). */
  cwd?: string;

  /** Git branch this thread is assigned to. */
  branch?: string;

  /** Parent thread when this thread is a subagent spawned by another. */
  parentThreadId?: string;

  /** The parent's turn that spawned this thread (a subagent). */
  parentTurnId?: string;

  /** The thread and point this one was forked from (provenance; a fork is top-level). */
  forkedFrom?: ThreadFork;

  /** How this subagent thread was spawned. */
  spawn?: ThreadSpawn;

  /** 1 for a child of a main thread. */
  depth?: number;

  /**
   * Start-up of a thread whose Wardens are held in its own process (docs/THREAD-TREE.md spec C):
   * turns typed meanwhile wait as `queued` until it is `ready` (or `degraded`).
   */
  setup?: ThreadSetup;

  /** Project that owns this thread. Scopes memory sources and tool calls. */
  projectId?: string;

  /** When this thread was created. */
  readonly createdAt: number;

  /** Last time a dispatch happened on this thread. */
  lastActiveAt: number;

  /** When the thread was archived (if applicable). */
  archivedAt?: number;
}

export interface ThreadSetup {
  status: 'starting' | 'ready' | 'degraded';
  startedAt: number;
  readyAt?: number;
  /** Every configured Warden, those holding a spare, and those that did not by the deadline. */
  wardens: { expected: number; held: number; failed: string[] };
  runtime: 'claude-in-session' | 'codex-in-process' | 'side-session';
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
  readonly status: 'fulfilled' | 'rejected';
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
  nativeObservation?: Omit<import('./native-evidence').NativeObservation, 'owner'> & {
    generation: string;
  };
  recordNative?: (evidence: import('./native-evidence').NativeEvidence) => void;
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
  /**
   * What the agent itself receives when it differs from the payload that middleware and the
   * dispatch observation read: a host's instruction wrappers go to the agent verbatim, while
   * everything that learns from the message sees only the user's words.
   */
  agentPayload?: unknown;
  /** Images sent with the payload, for the agent alone (`ExecuteMeta.images`). */
  images?: readonly import('./types').ImageInput[];
  /** Lets this dispatch's middleware include an on-demand layer in its assembly (`RequestContext.requestLayer`). */
  requestLayer?: (layerId: string) => void;
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
  /** The thread and point this one was forked from. */
  forkedFrom?: ThreadFork;
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
      description: opts?.description ?? '',
      tags: opts?.tags ?? [],
      status: 'idle',
      cwd: opts?.cwd,
      branch: opts?.branch,
      parentThreadId: opts?.parentThreadId,
      ...(opts?.forkedFrom ? { forkedFrom: opts.forkedFrom } : {}),
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

  /** Set (or with an empty name, clear) the person-given name. */
  rename(name: string): void {
    const text = name.trim();
    if (!text) delete this.meta.name;
    else if (text !== this.meta.name?.text) this.meta.name = { text, updatedAt: Date.now() };
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
    this.meta.status = 'archived';
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
    if (this.meta.status === 'archived') {
      throw new Error(`Thread archived: ${this.id} cannot dispatch "${agentId}"`);
    }
    if (this._disposed) {
      throw new Error(`Thread disposed: ${this.id} cannot dispatch "${agentId}"`);
    }
    const agent = this._agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);

    this._activeDispatches++;
    this.meta.status = 'active';
    this.meta.lastActiveAt = Date.now();

    // Explicit identity for this dispatch. Middleware sees it, tool calls
    // executed on its behalf are observed with it, and the completion
    // observation carries it, so evidence never drifts to another completion.
    const dispatchId = newId('dispatch');
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
      ...(opts?.requestLayer ? { requestLayer: opts.requestLayer } : {}),
    };

    const start = performance.now();

    const meta = {
      cwd: this.meta.cwd,
      threadId: this.id,
      projectId: this.meta.projectId,
      messageId: ctx.messageId,
      dispatchId,
      observeTool: (observation: ToolCallObservation) => {
        void this.signals
          .emit({
            id: newId('sig-tool'),
            kind: 'tool_observation',
            source: `thread:${this.id}`,
            content: {
              threadId: this.id,
              dispatchId,
              agentId,
              ...observation,
              timestamp: Date.now(),
            },
            timestamp: Date.now(),
          })
          .catch((err) => {
            console.warn(
              `[Thread] tool observation failed for "${agentId}":`,
              (err as Error).message ?? err,
            );
          });
      },
      annotations: ctx.annotations,
      onDelta: opts?.onDelta,
      ...(opts?.images?.length ? { images: opts.images } : {}),
      recordInjection: opts?.recordInjection,
      recordNative: opts?.recordNative,
      recordCompleted: opts?.recordCompleted,
      nativeObservation: opts?.nativeObservation
        ? {
            preflight: opts.nativeObservation.preflight,
            bridge: opts.nativeObservation.bridge,
            register: opts.nativeObservation.register,
            observe: opts.nativeObservation.observe,
            interruptible: opts.nativeObservation.interruptible,
            thought: opts.nativeObservation.thought,
            owner: Object.freeze({
              threadId: this.id,
              projectId: this.meta.projectId,
              generation: opts.nativeObservation.generation,
              messageId: ctx.messageId,
              dispatchId,
            }),
          }
        : undefined,
    };

    try {
      const result = await this.middleware.execute(ctx, () =>
        agent.run(
          opts?.agentPayload !== undefined ? (opts.agentPayload as TPayload) : payload,
          filterOverride,
          meta,
        ),
      );

      const durationMs = performance.now() - start;

      // Auto-record token usage if tracker is configured
      if (this._tokenTracker && result.tokens) {
        const llm = agent.llm;
        this._tokenTracker.record({
          provider: llm?.provider ?? 'unknown',
          model: llm?.model ?? 'unknown',
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
      if (this._activeDispatches === 0 && this.meta.status === 'active') {
        this.meta.status = 'idle';
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
    const promise = this.dispatch(agentId, payload, filterOverride, opts).catch(async (err) => {
      console.warn(`[Thread] background dispatch "${agentId}" failed:`, (err as Error).message);
      return { output: null, contextHash: '' } as ExecutionResult;
    });
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
      agentIds.map((id) => this.dispatch(id, payload, filterOverride, opts)),
    );

    return settled.map((s, i) => {
      if (s.status === 'fulfilled') {
        return { agentId: agentIds[i], status: 'fulfilled' as const, result: s.value };
      } else {
        return { agentId: agentIds[i], status: 'rejected' as const, error: s.reason };
      }
    });
  }

  // -- Observation --

  private async _observe(
    agentId: string,
    payload: unknown,
    opts: DispatchOptions | undefined,
    dispatchId: string,
    outcome: Pick<DispatchObservation, 'durationMs' | 'ok' | 'error' | 'contextHash' | 'output'>,
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
        id: newId('sig-dispatch'),
        kind: 'dispatch',
        source: opts?.role ? `harness:${agentId}` : `thread:${this.id}`,
        content,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(
        `[Thread] dispatch observation failed for "${agentId}":`,
        (err as Error).message ?? err,
      );
    }
  }

  // -- Stack view --

  /** Create a live read-only view of the context stack for middleware. */
  private _createStackView(): ContextStackView {
    const stack = this.stack;
    return {
      hasLayer: (id) => {
        const l = stack.getLayer(id);
        return l ? l.assemblable : false;
      },
      getContent: (id) => {
        const l = stack.getLayer(id);
        return l?.assemblable ? l.content : '';
      },
      getState: (id) => stack.getLayer(id)?.state,
      get layerIds() {
        return stack.layers.map((l) => l.id);
      },
      get estimatedTokens() {
        return stack.estimateTokens();
      },
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
      throw new Error(
        `Thread disposed: ${this.id} cannot be started; create a new thread to restore it`,
      );
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
  if (typeof payload === 'string') {
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
