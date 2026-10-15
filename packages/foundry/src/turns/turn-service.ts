import type {
  EventStream,
  HarnessResult,
  InjectionArtifact,
  NativeBridgeSource,
  NativeEvidence,
  NativeInterrupt,
  NativeInterruptOutcome,
  NativeOwner,
  Thread,
  Trace,
} from '@inixiative/foundry-core';
import { Harness, newId } from '@inixiative/foundry-core';
import type { PostgresMemory } from '../adapters/postgres-memory';
import type { ThreadFactory } from '../agents/thread-factory';
import type { ThreadNamer } from '../agents/thread-namer';
import type { FeedbackService } from '../feedback/service';
import { enqueueJob } from '../jobs/enqueue';
import { isOpenTurn, type LocalSessionStore } from '../persistence/local-session-store';
import { serializeTrace } from '../persistence/trace-record';
import type { ConfigStore } from '../viewer/config';
import type { ViewerStreams } from '../viewer/data-streams';
import type { StreamBuffer } from '../viewer/stream-buffer';
import type { ViewerThreadDirectory } from '../viewer/thread-directory';
import { createSerializedQueue, type SerializedQueue } from '../ws/serialized-queue';
import { splitHostInstructions } from './host-instructions';

/**
 * The one turn path for messages: viewer sends and ACP prompts (and Oracle, when it drives turns
 * through the daemon) are accepted, queued on their thread, run through the thread's Harness,
 * settled and persisted here. Routes are thin callers. Operator `agent:dispatch` actions are
 * direct agent dispatches, not turns, and do not pass through here.
 *
 * A turn is accepted durably before it runs. A thread runs one turn at a time: a turn sent to a
 * busy thread waits in that thread's queue. A stop cancels a turn that has not reached native
 * dispatch, and asks the runtime to stop one that has.
 */
export interface TurnServiceDeps {
  harness: Harness;
  eventStream: EventStream;
  db: PostgresMemory | null;
  threadFactory?: ThreadFactory;
  configStore: ConfigStore;
  deviceIdentityPath?: string;
  namer?: ThreadNamer;
  /** The feedback lifecycle: reads each accepted turn; a blocking tuning prompt holds the turn. */
  feedback?: FeedbackService | null;
  /**
   * In-session Wardens (docs/THREAD-TREE.md spec C): opens the thread's native session and waits
   * (bounded) until its Wardens are held. The turn stays queued meanwhile, so a stop cancels it.
   */
  threadSetup?: ThreadSetupHost;
  localStore?: LocalSessionStore | null;
  directory: ViewerThreadDirectory;
  streams: ViewerStreams;
}

/** Opens a thread's native session ahead of its turn and waits for its in-session Wardens. */
export interface ThreadSetupHost {
  open(threadId: string, opts: { cwd?: string; bridge?: NativeBridgeSource }): Promise<void>;
  /** The thread's Wardens are not held yet (setup not run, or still starting). */
  pending(threadId: string): boolean;
}

export interface TurnRequest {
  threadId: string;
  turnId?: string;
  payload: string;
  /** The requesting client: it alone receives the full terminal on `thread:<threadId>`. */
  clientId?: string;
}

/** A settled turn's result as the routes and the requesting client receive it. */
export type CompletedTurn = ReturnType<TurnService['completeResult']>;

export type TurnOutcome =
  | { kind: 'completed'; completed: CompletedTurn; result: HarnessResult }
  | { kind: 'completed-after-failure'; completed: CompletedTurn; error: string }
  | {
      kind: 'failed';
      error: string;
      evidence: ReturnType<TurnService['recordFailure']>;
      cancelled: boolean;
    };

export type TurnAcceptance =
  | {
      ok: true;
      turnId: string;
      threadId: string;
      /** The thread was busy: this turn waits for the turns ahead of it. */
      queued: boolean;
      settled: Promise<TurnOutcome>;
    }
  | { ok: false; status: 404 | 409 | 503; body: Record<string, unknown> };

/**
 * `cancelled`: a queued turn, settled now without running. `requested`: a running turn not yet
 * natively admitted; it is refused at native preflight or registration, before anything is sent
 * (an executor that never seeks native admission runs to its end).
 * `unsupported`: admitted on a runtime that cannot stop a turn; it runs to its end. Otherwise the
 * runtime's own answer.
 */
export type InterruptOutcome = NativeInterruptOutcome | 'cancelled' | 'requested' | 'unsupported';
export type InterruptResult =
  | { ok: true; outcome: InterruptOutcome }
  | { ok: false; status: 404 | 409; error: string };

interface LiveTurn {
  readonly threadId: string;
  phase: 'queued' | 'running' | 'settled';
  cancelRequested: boolean;
  /** The executor's native admission is registered: native work is being sent. */
  admitted: boolean;
  /** The executor's native turn reached its terminal. */
  nativeSettled: boolean;
  interrupt?: NativeInterrupt;
  stopping?: Promise<NativeInterruptOutcome>;
  /** Settle a queued turn now, without running it. */
  cancelQueued(): void;
}

const STOP_TIMEOUT_MS = 5_000;
export const CANCELLED_BEFORE_START = 'Turn cancelled before it started';
export const CANCELLED_BEFORE_DISPATCH = 'Turn cancelled before native dispatch';

function configureHarness(harness: Harness, configStore: ConfigStore): void {
  const config = configStore.config;
  for (const [id, agentCfg] of Object.entries(config.agents)) {
    if (!agentCfg.enabled || !harness.thread.agents.has(id)) continue;
    if (agentCfg.kind === 'classifier') harness.setClassifier(id);
    else if (agentCfg.kind === 'router') harness.setRouter(id);
  }

  const executorId = Object.entries(config.agents).find(
    ([id, agent]) => agent.kind === 'executor' && agent.enabled && harness.thread.agents.has(id),
  )?.[0];
  harness.setDefaultExecutor(
    executorId ?? (harness.thread.agents.has('artificer') ? 'artificer' : ''),
  );
  harness.loadModes(config.agents, config.layers);
}

/**
 * Build layer-injection provenance for a turn.
 *
 * Read the dispatch snapshot, never the live stack after executor writeback.
 */
function buildInjectionProvenance(
  artifact: InjectionArtifact | undefined,
): Array<{ id: string; hash: string; tokens: number }> | undefined {
  // A session provider delivered only what its session lacked (and, once, its system prompt).
  const session = artifact?.sessionDelivery;
  const delivered = session
    ? new Set(
        [...session.sent, ...(session.session === 'started' ? session.base : [])].map((p) => p.id),
      )
    : undefined;
  const records = (artifact?.layers ?? [])
    .filter((layer) => layer.included && (!delivered || delivered.has(layer.id)))
    .map((layer) => ({
      id: layer.id,
      hash: layer.hash,
      tokens: Math.ceil(layer.content.length / 4),
    }));
  return records.length > 0 ? records : undefined;
}

export class TurnService {
  private readonly generation = newId('native-runtime');
  private readonly harnesses: Map<string, Harness>;
  private readonly nativeBridges = new WeakMap<Thread, NativeBridgeSource>();
  private readonly queues = new Map<string, SerializedQueue>();
  private readonly live = new Map<string, LiveTurn>();

  constructor(private readonly deps: TurnServiceDeps) {
    this.harnesses = new Map([[deps.harness.thread.id, deps.harness]]);
  }

  /** The Harness that runs a thread's turns, created on first use. */
  harness(threadId: string): Harness | null {
    const existing = this.harnesses.get(threadId);
    if (existing) return existing;
    const thread = this.deps.directory.get(threadId);
    if (!thread) return null;
    const scoped = new Harness(thread);
    configureHarness(scoped, this.deps.configStore);
    this.harnesses.set(threadId, scoped);
    return scoped;
  }

  /** Every Harness created so far, one per thread. */
  all(): Harness[] {
    return [...this.harnesses.values()];
  }

  /** Accept a turn durably, then run it after any turn already on its thread. */
  accept(request: TurnRequest): TurnAcceptance {
    const { clientId } = request;
    // A host's instruction wrappers go to the executor verbatim; everything that learns from the
    // message (and the journal's user message) reads only the user's words.
    const split = splitHostInstructions(request.payload);
    const payload = split?.userText ?? request.payload;
    const hostMeta = split
      ? { hostInstructions: split.instructions.map((block) => ({ ...block })) }
      : undefined;
    const { db, localStore, streams } = this.deps;
    const turnId = request.turnId ?? newId('turn');
    const threadId = request.threadId;
    const harness = this.harness(threadId);
    if (!harness) return { ok: false, status: 404, body: { error: 'thread not found' } };
    if (harness.thread.disposed)
      return { ok: false, status: 409, body: { error: 'thread is archived or disposed' } };
    // An observed subagent's thread is a record of native work, not a conversation Foundry runs.
    if (harness.thread.meta.spawn?.observed)
      return {
        ok: false,
        status: 409,
        body: { error: 'an observed subagent thread takes no turns; message its parent thread' },
      };
    if (localStore?.turn(turnId) || !streams.turns.canOpen(turnId))
      return {
        ok: false,
        status: 409,
        body: { error: 'turn already accepted or live capacity unavailable', id: turnId },
      };
    try {
      localStore?.beginTurn(harness.thread, turnId, payload, hostMeta);
    } catch (err) {
      return {
        ok: false,
        status: 503,
        body: { error: `Could not durably accept turn: ${(err as Error).message}` },
      };
    }

    // Optional remote mirror; the local acceptance is already committed.
    const userMsgId = newId('msg');
    enqueueJob('persistMessage', {
      id: userMsgId,
      threadId,
      turnId,
      actor: 'user',
      kind: 'text',
      content: payload,
      ...(hostMeta ? { meta: hostMeta } : {}),
    }).catch(() => {
      db?.writeMessage({
        id: userMsgId,
        threadId,
        turnId,
        actor: 'user',
        kind: 'text',
        content: payload,
        ...(hostMeta ? { meta: hostMeta } : {}),
      }).catch((err) => console.warn('[Turns] background op failed:', err.message ?? err));
    });

    const buffer = streams.turns.open(turnId, threadId, harness.thread.meta.projectId);
    streams.threadsChanged(threadId);
    try {
      this.deps.feedback?.turnAccepted(harness.thread, turnId, payload);
    } catch (error) {
      console.warn('[Feedback] capture not started:', (error as Error).message);
    }

    let queue = this.queues.get(threadId);
    if (!queue) {
      queue = createSerializedQueue();
      this.queues.set(threadId, queue);
    }
    const queued = queue.size() > 0;
    let resolveSettled!: (outcome: TurnOutcome) => void;
    const settled = new Promise<TurnOutcome>((resolve) => {
      resolveSettled = resolve;
    });
    const state: LiveTurn = {
      threadId,
      phase: 'queued',
      cancelRequested: false,
      admitted: false,
      nativeSettled: false,
      cancelQueued: () =>
        resolveSettled(this.cancelBeforeStart(harness.thread, turnId, buffer, clientId)),
    };
    this.live.set(turnId, state);
    const thread = queue;
    void thread
      .run(async () => {
        // A blocking tuning prompt holds the turn (still queued, so a stop cancels it) until answered.
        await this.deps.feedback?.held(turnId);
        // A thread setting up its in-session Wardens holds the turn (still queued) until they are held.
        if (state.phase !== 'settled' && this.deps.threadSetup)
          await this.deps.threadSetup
            .open(threadId, {
              ...(harness.thread.meta.cwd ? { cwd: harness.thread.meta.cwd } : {}),
              bridge: this.nativeBridge(harness.thread),
            })
            .catch((error) =>
              console.warn(`[Turns] thread setup failed: ${(error as Error).message ?? error}`),
            );
        // A queued turn cancelled while it waited has already settled.
        if (state.phase !== 'settled')
          resolveSettled(
            await this.run(
              harness,
              state,
              turnId,
              payload,
              buffer,
              clientId,
              split && request.payload,
            ),
          );
      })
      .finally(() => {
        state.phase = 'settled';
        this.live.delete(turnId);
        if (thread.size() === 0 && this.queues.get(threadId) === thread)
          this.queues.delete(threadId);
      });
    return { ok: true, turnId, threadId, queued, settled };
  }

  /** The turn running on a thread now (dequeued and not settled), if any. */
  runningTurn(threadId: string): string | null {
    for (const [turnId, state] of this.live)
      if (state.threadId === threadId && state.phase === 'running') return turnId;
    return null;
  }

  /** Stop a turn: cancel it before native dispatch, or ask the runtime to stop it after. */
  async interrupt(threadId: string, turnId: string): Promise<InterruptResult> {
    const state = this.live.get(turnId);
    if (!state || state.threadId !== threadId) {
      const stored = this.deps.localStore?.turn(turnId);
      if (stored && stored.threadId === threadId)
        return { ok: false, status: 409, error: `turn is not running (${stored.status})` };
      return { ok: false, status: 404, error: 'turn not found in this thread' };
    }
    if (state.phase === 'settled') return { ok: false, status: 409, error: 'turn is not running' };
    state.cancelRequested = true;
    if (state.phase === 'queued') {
      state.phase = 'settled';
      this.live.delete(turnId);
      this.deps.feedback?.release(turnId);
      state.cancelQueued();
      return { ok: true, outcome: 'cancelled' };
    }
    if (state.interrupt) return { ok: true, outcome: await this.stop(state) };
    return { ok: true, outcome: state.admitted ? 'unsupported' : 'requested' };
  }

  /**
   * Ask the runtime to stop, retrying while the admission is registered but not yet written. A
   * stop that was not acknowledged can be asked again.
   */
  private stop(state: LiveTurn): Promise<NativeInterruptOutcome> {
    state.stopping ??= (async () => {
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      for (;;) {
        const outcome = await state.interrupt!({
          timeoutMs: Math.max(1, deadline - Date.now()),
        }).catch(() => 'unacknowledged' as const);
        if (
          outcome !== 'no-turn' ||
          state.nativeSettled ||
          state.phase === 'settled' ||
          Date.now() >= deadline
        )
          return outcome;
        await Bun.sleep(50);
      }
    })().finally(() => {
      state.stopping = undefined;
    });
    return state.stopping;
  }

  /** A queued turn cancelled while it waited: journalled failed with cancelled evidence; nothing ran. */
  private cancelBeforeStart(
    thread: Thread,
    turnId: string,
    buffer: StreamBuffer,
    clientId?: string,
  ): TurnOutcome {
    const evidence = this.recordFailure(
      thread,
      turnId,
      CANCELLED_BEFORE_START,
      undefined,
      '',
      true,
    );
    this.publishTerminal(thread.id, clientId, turnId, 'error', {
      id: turnId,
      threadId: thread.id,
      error: CANCELLED_BEFORE_START,
      cancelled: true,
      ...evidence,
    });
    buffer.fail(CANCELLED_BEFORE_START, { id: turnId, error: CANCELLED_BEFORE_START, ...evidence });
    this.deps.streams.turns.drop(turnId);
    this.deps.streams.threadsChanged(thread.id);
    return { kind: 'failed', error: CANCELLED_BEFORE_START, evidence, cancelled: true };
  }

  private journalChanged(thread: Thread, turnId: string): boolean {
    try {
      this.deps.eventStream.push({
        kind: 'journal',
        threadId: thread.id,
        projectId: thread.meta.projectId,
        turnId,
        timestamp: Date.now(),
      });
      return true;
    } catch {
      return false;
    } // observer failure cannot replace executor/commit evidence
  }

  private nativeBridge(thread: Thread): NativeBridgeSource | undefined {
    const { threadFactory, localStore, eventStream, deviceIdentityPath } = this.deps;
    let source = this.nativeBridges.get(thread);
    if (!source) {
      source = threadFactory?.nativeBridge(
        thread,
        (record) => {
          if (!localStore) throw Error('Native tools require an owned journal');
          return localStore.persistNativeTool(thread, record, () => {
            try {
              eventStream.push({
                kind: 'journal',
                threadId: record.owner.threadId,
                projectId: record.owner.projectId,
                turnId: record.association.owner?.messageId ?? '',
                timestamp: Date.now(),
              });
              return true;
            } catch {
              return false;
            }
          });
        },
        deviceIdentityPath,
      );
      if (source) this.nativeBridges.set(thread, source);
    }
    return source;
  }

  private nativeObservation(thread: Thread, state: LiveTurn, turnId: string) {
    const { threadFactory, localStore, streams } = this.deps;
    return {
      generation: threadFactory?.runtime?.get(thread.id)?.generation ?? this.generation,
      bridge: this.nativeBridge(thread),
      preflight: (owner: NativeOwner) => {
        if (state.cancelRequested) throw Error(CANCELLED_BEFORE_DISPATCH);
        if (!localStore) throw Error('Native admission requires an available ownership journal');
        localStore.assertNativeCapacity(thread, owner);
      },
      // Registration precedes the native write, so a stop that arrived while the session was
      // starting refuses the admission here and nothing is sent.
      register: (evidence: NativeEvidence) => {
        if (state.cancelRequested) throw Error(CANCELLED_BEFORE_DISPATCH);
        if (!localStore) throw Error('Native admission requires an available ownership journal');
        localStore.registerNative(thread, evidence);
        if (evidence.owner?.providerSessionKey === thread.id) state.admitted = true;
        if (evidence.owner?.messageId)
          streams.turns.get(evidence.owner.messageId)?.register(evidence);
      },
      observe: (evidence: NativeEvidence) => {
        if (
          evidence.owner?.providerSessionKey === thread.id &&
          evidence.nativeOutcome !== 'unknown'
        )
          state.nativeSettled = true;
        if (evidence.owner?.messageId)
          streams.turns.get(evidence.owner.messageId)?.observe(evidence);
        localStore?.appendNative(thread, evidence);
        if (evidence.owner?.messageId) this.journalChanged(thread, evidence.owner.messageId);
      },
      interruptible: (interrupt: NativeInterrupt) => {
        state.interrupt = interrupt;
        if (state.cancelRequested) void this.stop(state);
      },
      thought: (text: string) => streams.turns.get(turnId)?.thought(text),
    };
  }

  completeResult(
    thread: Thread,
    turnId: string,
    result: Pick<HarnessResult, 'result' | 'trace' | 'classification' | 'route' | 'timestamp'>,
    postExecutionError?: string,
  ) {
    const { localStore } = this.deps;
    const output = result.result.output ?? null;
    const content = typeof output === 'string' ? output : JSON.stringify(output ?? null);
    const injection = result.result.meta?.injection as InjectionArtifact | undefined;
    const injectedLayers = buildInjectionProvenance(injection);
    const meta: Record<string, unknown> = {
      ...(result.result.meta ?? {}),
      ...(injectedLayers ? { injectedLayers } : {}),
      attemptOutcome: 'completed',
      executionOutcome: 'completed',
      ...(postExecutionError ? { attemptOutcome: 'failed', postExecutionError } : {}),
      // A successful Harness result does not establish provider/native protocol facts.
      providerOutcome: 'unknown',
      nativeOutcome:
        (result.result.meta?.native as { nativeOutcome?: string } | undefined)?.nativeOutcome ??
        'unknown',
      deliveryAcknowledgment: 'unavailable',
      inputEvidence: injection?.providerMessages
        ? 'provider-boundary-recorded'
        : injection
          ? 'prepared-only'
          : 'unavailable',
      turnStatus: localStore ? 'completed' : 'completed-unsaved',
      persistence: localStore ? 'committed' : 'unavailable',
    };
    // This catch belongs only to persistence. Never repair it by failing/replaying
    // an execution that already returned a completed result.
    try {
      localStore?.completeTurn(thread, turnId, content, meta, serializeTrace(result.trace));
    } catch (error) {
      meta.turnStatus = 'completed-unsaved';
      meta.persistence = 'failed';
      meta.persistenceError = error instanceof Error ? error.message : String(error);
      meta.retryable = false;
    }
    const unsaved = meta.persistence !== 'committed';
    if (!this.journalChanged(thread, turnId)) meta.notification = 'failed';
    if (unsaved) result.trace.root.annotations.completion = meta;
    return {
      id: turnId,
      output,
      content,
      meta,
      traceId: result.trace.id,
      trace: result.trace.summary(),
      // Preserve the full volatile trace for browser evidence before memory is lost.
      ...(unsaved ? { traceSnapshot: serializeTrace(result.trace) } : {}),
      classification: result.classification?.value ?? null,
      route: result.route?.value ?? null,
      timestamp: result.timestamp,
    };
  }

  recordFailure(
    thread: Thread,
    turnId: string,
    error: string,
    trace?: Trace,
    partialOutput?: string,
    cancelled = false,
  ) {
    const { localStore } = this.deps;
    const executeSpan = trace && [...trace.spans].reverse().find((span) => span.kind === 'execute');
    const injection = executeSpan?.annotations.injection as InjectionArtifact | undefined;
    const native = executeSpan?.annotations.native as NativeEvidence | undefined;
    const injectedLayers = buildInjectionProvenance(injection);
    const meta: Record<string, unknown> = {
      error,
      turnStatus: 'failed',
      persistence: localStore ? 'committed' : 'unavailable',
      inputEvidence: injection?.providerMessages
        ? 'provider-boundary-recorded'
        : injection
          ? 'prepared-only'
          : 'unavailable',
      // The local executor boundary does not acknowledge native delivery,
      // termination or cancellation. Preserve that uncertainty explicitly.
      deliveryAcknowledgment: 'unavailable',
      nativeOutcome: native?.nativeOutcome ?? 'unknown',
      ...(native ? { native, ...(native.content ? { partialOutput: native.content } : {}) } : {}),
      ...(injection ? { injection } : {}),
      ...(injectedLayers ? { injectedLayers } : {}),
      ...(partialOutput ? { partialOutput } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    };
    // Failure details travel with historical traces as well as message rows.
    // Keep the live annotation linked so a rejected transaction reads unsaved.
    if (trace) trace.root.annotations.failure = meta;
    try {
      if (localStore) {
        const status = localStore.turn(turnId)?.status;
        if (status && isOpenTurn(status)) {
          localStore.failTurn(thread, turnId, error, {
            meta,
            trace: trace ? serializeTrace(trace) : undefined,
          });
        } else meta.persistence = 'not-recorded';
      }
    } catch (err) {
      meta.persistence = 'failed';
      meta.persistenceError = err instanceof Error ? err.message : String(err);
      console.error('[Turns] could not persist failed turn', err);
    }
    if (!this.journalChanged(thread, turnId)) meta.notification = 'failed';
    return { traceId: trace?.id, trace: trace?.summary(), meta };
  }

  private completedAfterFailure(thread: Thread, turnId: string, error: string, trace?: Trace) {
    const span = trace && [...trace.spans].reverse().find((span) => span.kind === 'execute');
    const completed = span?.annotations.executorCompletion as { output: unknown } | undefined;
    const native = span?.annotations.native as NativeEvidence | undefined;
    if (!trace || (!completed && native?.nativeOutcome !== 'completed')) return undefined;
    return this.completeResult(
      thread,
      turnId,
      {
        trace,
        timestamp: Date.now(),
        result: {
          output: completed ? completed.output : (native!.content ?? ''),
          contextHash: '',
          meta: { injection: span?.annotations.injection, ...(native ? { native } : {}) },
        },
      },
      error,
    );
  }

  private observeFailure(message: string) {
    try {
      this.deps.eventStream.pushError('harness', `Execution failed: ${message}`);
    } catch (error) {
      console.warn('[Turns] error observer failed:', error);
    }
  }

  // A turn's full result goes to the requesting connection on its thread stream, ahead of the
  // bounded live turn's own terminal, so that client holds the full result first. Other viewers see
  // only the bounded turn. An observer failure cannot replace executor/commit evidence.
  private publishTerminal(
    threadId: string,
    clientId: string | undefined,
    turnId: string,
    kind: 'done' | 'error',
    result: Record<string, unknown>,
  ) {
    try {
      this.deps.streams.publishTerminal(threadId, clientId, { kind, turnId, result });
    } catch (error) {
      console.warn('[Turns] thread stream publish failed:', error);
    }
  }

  private persistAgentMessage(threadId: string, turnId: string, completed: CompletedTurn) {
    const { db } = this.deps;
    const agentMsgId = newId('msg');
    const message = {
      id: agentMsgId,
      threadId,
      turnId,
      actor: 'agent' as const,
      kind: 'text' as const,
      content: completed.content,
      traceId: completed.traceId,
      meta: completed.meta,
    };
    // Optional remote mirror follows the local response/artifact transaction.
    enqueueJob('persistMessage', message).catch(() => {
      db?.writeMessage(message).catch((err) =>
        console.warn('[Turns] background op failed:', err.message ?? err),
      );
    });
  }

  private persistTrace(turnId: string, trace: Trace) {
    const { db } = this.deps;
    enqueueJob('persistTrace', {
      traceId: trace.id,
      messageId: turnId,
      trace: serializeTrace(trace),
    }).catch(() => {
      db?.writeTrace(trace).catch((err) =>
        console.warn('[Turns] background op failed:', err.message ?? err),
      );
    });
  }

  // The turn is independent of any connection: with nobody watching it still runs and attempts
  // to persist its outcome. "done" means execution returned, not necessarily that its journal
  // commit succeeded.
  private async run(
    harness: Harness,
    state: LiveTurn,
    turnId: string,
    payload: string,
    buffer: StreamBuffer,
    clientId?: string,
    /** The verbatim prompt for the executor, when host instructions were split off `payload`. */
    executorPayload?: string | null,
  ): Promise<TurnOutcome> {
    const thread = harness.thread;
    const threadId = thread.id;
    let attemptTrace: Trace | undefined;
    try {
      if (state.cancelRequested) throw Error(CANCELLED_BEFORE_START);
      state.phase = 'running';
      const result = await harness.send(
        { id: turnId, payload },
        {
          nativeObservation: this.nativeObservation(thread, state, turnId),
          ...(executorPayload ? { executorPayload } : {}),
          onDelta: (text) => buffer.append(text),
          onTrace: (trace) => {
            attemptTrace = trace;
          },
          // The journal's queued → active: nothing reaches the runtime before this.
          onExecutorInput: () => {
            if (state.cancelRequested) return;
            try {
              this.deps.localStore?.startTurn(thread, turnId);
            } catch (error) {
              console.warn('[Turns] could not mark turn active:', error);
            }
          },
        },
      );
      const completed = this.completeResult(thread, turnId, result);
      this.publishTerminal(threadId, clientId, turnId, 'done', { threadId, ...completed });
      buffer.complete(completed);
      if (completed.meta.persistence !== 'failed') {
        this.persistAgentMessage(threadId, turnId, completed);
        this.persistTrace(turnId, result.trace);
        this.deps.namer?.turnCompleted(thread, { user: payload, agent: completed.content });
      }
      return { kind: 'completed', completed, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const completed = this.completedAfterFailure(thread, turnId, msg, attemptTrace);
      if (completed) {
        this.publishTerminal(threadId, clientId, turnId, 'done', { threadId, ...completed });
        buffer.complete(completed);
        return { kind: 'completed-after-failure', completed, error: msg };
      }
      const cancelled = state.cancelRequested;
      const evidence = this.recordFailure(
        thread,
        turnId,
        msg,
        attemptTrace,
        buffer.content,
        cancelled,
      );
      this.publishTerminal(threadId, clientId, turnId, 'error', {
        id: turnId,
        threadId,
        error: msg,
        ...(cancelled ? { cancelled: true } : {}),
        ...evidence,
      });
      buffer.fail(msg, { id: turnId, error: msg, ...evidence });
      // A stop someone asked for is not a harness failure.
      if (!cancelled) this.observeFailure(msg);
      return { kind: 'failed', error: msg, evidence, cancelled };
    } finally {
      this.deps.streams.turns.drop(turnId);
      this.deps.streams.threadsChanged(threadId);
    }
  }
}
