import {
  type CompletionOpts,
  ContextLayer,
  type ContextStack,
  type DeliveryRecord,
  type DispatchObservation,
  type EventStream,
  type InjectionArtifact,
  type LLMMessage,
  type LLMProvider,
  type NativeEvidence,
  type NativeOwner,
  newId,
  normalizeScope,
  type OwnershipScope,
  type ParticipantRequest,
  type Signal,
  SignalBus,
  sameNativeOwner,
  type Thread,
  type ThreadMeta,
  type ToolCallObservation,
} from '@inixiative/foundry-core';
import type { FeedbackPhase } from '../feedback/types';
import { roleComposition } from '../prompts/instruction-settings';
import type { SessionAdapter } from '../providers/session-adapter';
import {
  type PrefilterOutcome,
  prefilterSkip,
  type WardenPrefilter,
} from '../providers/warden-prefilter';
import type { FoundryConfig } from '../viewer/config';
import { resolveProjectView } from '../viewer/config-resolve';
import { Cartographer, DEFAULT_ROUTE_INSTRUCTIONS } from './cartographer';
import { cartographerRoleId, resolveThreadDomains } from './configured-experts';
import {
  activityTools,
  DomainLibrarian,
  isThreadKnowledgeLayerId,
  type KnowledgeEvidence,
  type LearningRecord,
  type PhaseRequestEvidence,
  type ReviewInput,
  type ReviewJob,
  type ReviewResult,
  type ThreadKnowledgeSnapshot,
  type ToolObservation,
  type TurnActivity,
  threadKnowledgeLayerId,
} from './domain-librarian';
import {
  briefNotes,
  FlowOrchestrator,
  type FlowTimingConfig,
  type HandoffMoment,
  type HydrationResult,
  type InjectionPlan,
} from './flow-orchestrator';
import { Librarian } from './librarian';
import { lowConfidenceRule, ReactiveMiddleware } from './reactive';
import {
  buildRoleLayer,
  buildRoleLayers,
  type ResolveSource,
  type RoleLayers,
  replaceRoleSources,
  roleSources,
} from './role-layers';
import { chorusSource, type WardenCharter, wardenCharter } from './warden-charter';
import type { GuardMode, TriggerPoint } from './warden-triggers';

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/**
 * Native session id for an auxiliary role of a thread (classifier, router,
 * cartographer, a Warden domain). The central executor keeps the bare thread
 * id; auxiliaries never share it, so their compaction and history never touch
 * the central session.
 */
/** A landed turn and the reviews that follow it coalesce into one Warden pre-start. */
const PRESTART_DEBOUNCE_MS = 250;
/** How long a landed turn's pre-start waits for its reviews before going out with what it has. */
const PRESTART_REVIEW_WAIT_MS = 30_000;

export function auxiliarySessionId(threadId: string, role: string): string {
  return `${threadId}:aux:${role}`;
}

/** At most this many calls are held for one turn's guard; later calls of the turn are counted, not held. */
const MAX_TURN_ACTIVITY = 400;
/** Observed subagent turns whose activity is held for their guard, at most. */
const MAX_SUBAGENT_TURNS = 64;

/** A `tool_observation` signal's content, as the executor's tool loop, the native projector or an observed subagent emit it. */
interface ToolSignalContent {
  tool?: string;
  input?: Record<string, unknown>;
  /** The native projector's bounded JSON of the input (`ToolCallObservation`). */
  inputSummary?: string;
  output?: string;
  outputSummary?: string;
  ok?: boolean;
  filesAffected?: string[];
  dispatchId?: string;
  callId?: string;
  agentId?: string;
  /** An observed subagent's call: its guard rows go on the subagent's node. */
  subagent?: { node: { id: string; meta: ThreadMeta }; turnId: string | null };
}

/** One observed call as the guard reads it: the native projector's summaries count as input and output. */
function toObservation(content: ToolSignalContent & { tool: string }): ToolObservation {
  let input = content.input;
  if (!input && typeof content.inputSummary === 'string') {
    try {
      const parsed: unknown = JSON.parse(content.inputSummary);
      input =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { summary: content.inputSummary };
    } catch {
      input = { summary: content.inputSummary };
    }
  }
  const output = content.output ?? content.outputSummary;
  return {
    tool: content.tool,
    input: input ?? {},
    ...(output !== undefined ? { output } : {}),
    ...(content.filesAffected ? { filesAffected: content.filesAffected } : {}),
    ...(typeof content.callId === 'string' ? { callId: content.callId } : {}),
    ...(typeof content.ok === 'boolean' ? { ok: content.ok } : {}),
  };
}

/** How a guard moment correlates to the thread's own turns. */
type GuardCorrelation =
  | 'live-dispatch'
  | 'dispatch-not-live'
  | 'no-dispatch-id'
  | 'subagent-turn'
  | 'subagent-call';

/** Who a guard moment belongs to: the identity its journal rows carry. */
interface GuardMomentOwner {
  /** Unique per moment: the signal id of a single call, or a fresh id for a turn's activity. */
  readonly momentId: string;
  readonly dispatchId: string | null;
  readonly correlation: GuardCorrelation;
  readonly agentId?: string;
  /** The live dispatch whose trace annotations the outcome is recorded on, when it is still live. */
  readonly live?: LiveDispatch;
  /** An observed subagent's node: its rows go there, under its own turn. */
  readonly node?: { id: string; meta: ThreadMeta };
}

interface LiveDispatch {
  annotations: Record<string, unknown>;
  guards: unknown[];
  messageId: string | null;
  /** The turn's tool activity so far (`guard: per-turn`): guarded once when the turn's tool activity ends. */
  activity: ToolObservation[];
  /** Calls past MAX_TURN_ACTIVITY: counted, not held. */
  overflow: number;
}

export interface ScopedProviderIdentity {
  threadId: string;
  /** Working directory, resolved per call so worktree reassignment is honored. */
  cwd?: string | (() => string | undefined);
}

/**
 * Wrap a provider so every call carries a fixed session identity. Methods
 * and caller options are preserved; only `threadId` and `cwd` are pinned.
 */
export function scopedProvider(
  provider: LLMProvider,
  identity: ScopedProviderIdentity,
): LLMProvider {
  let completedScope: Pick<CompletionOpts, 'threadId' | 'cwd'> | undefined;
  const scope = (opts?: CompletionOpts): CompletionOpts => {
    const cwd = typeof identity.cwd === 'function' ? identity.cwd() : identity.cwd;
    return { ...opts, threadId: identity.threadId, ...(cwd ? { cwd } : {}) };
  };
  const scoped: LLMProvider = {
    id: provider.id,
    nativeOwnership: provider.nativeOwnership,
    complete: async (messages, opts) => {
      const call = scope(opts);
      const owner = { threadId: call.threadId, cwd: call.cwd };
      try {
        return await provider.complete(messages, call);
      } finally {
        completedScope = owner;
      }
    },
    ...(provider.prestart
      ? {
          prestart: (messages: LLMMessage[], opts: CompletionOpts) =>
            provider.prestart!(messages, scope(opts)),
        }
      : {}),
    ...(provider.releaseThread
      ? { releaseThread: (id: string) => provider.releaseThread!(id) }
      : {}),
  };
  if (provider.completionLifecycle) {
    const lifecycle = provider.completionLifecycle;
    Object.assign(scoped, {
      completionLifecycle: {
        kind: lifecycle.kind,
        settlement: (outcome: Parameters<typeof lifecycle.settlement>[0]) =>
          lifecycle.settlement(outcome),
        ...(lifecycle.admission
          ? {
              admission: (outcome: Parameters<typeof lifecycle.settlement>[0]) =>
                lifecycle.admission!(outcome),
            }
          : {}),
        ...(lifecycle.inspectOwnedAdmission
          ? {
              inspectOwnedAdmission: (owner: NativeOwner, id: string) =>
                owner.providerSessionKey === identity.threadId
                  ? lifecycle.inspectOwnedAdmission!(owner, id)
                  : Promise.resolve(undefined),
            }
          : {}),
        ...(lifecycle.releaseOwnedAdmission
          ? {
              releaseOwnedAdmission: (owner: NativeOwner, id: string) =>
                owner.providerSessionKey === identity.threadId
                  ? lifecycle.releaseOwnedAdmission!(owner, id)
                  : Promise.resolve('unavailable' as const),
            }
          : {}),
        ...(lifecycle.releaseIdle
          ? {
              releaseIdle: (opts: CompletionOpts) =>
                completedScope
                  ? lifecycle.releaseIdle!({ ...opts, ...completedScope })
                  : Promise.resolve('unavailable' as const),
            }
          : {}),
      },
    });
  }
  if (typeof provider.stream === 'function') {
    const stream = provider.stream.bind(provider);
    scoped.stream = (messages, opts) => stream(messages, scope(opts));
  }
  return scoped;
}

// ---------------------------------------------------------------------------
// Signal sinks
// ---------------------------------------------------------------------------

/**
 * A persistence subscriber. The runtime calls it with the owning thread and
 * project of every signal, so a sink can record ownership instead of pooling
 * every thread's captures into one shared log. Plain SignalHandlers fit too.
 */
export type SignalSink = (signal: Signal, owner: OwnershipScope) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * A Warden registered in code (tests, research runs): which stack layer it reads and which tool calls
 * it guards. Configured Wardens read their composition view instead (`configured-experts.ts`).
 */
export interface ThreadDomainConfig {
  domain: string;
  layerId: string;
  guardTriggers: string[];
  advisePrompt?: string;
  guardPrompt?: string;
  reviewPrompt?: string;
  reviewOpts?: CompletionOpts;
  programmaticGuard?: boolean;
  /** Characters its instructions plus domain knowledge may take. Default: unbounded. */
  budget?: number;
}

/**
 * Built-in domain policy: the guard triggers (and programmatic guard) a configured Warden of that
 * domain uses when its settings name none. Passed as `domains`, they also register code Wardens over
 * layers of those names.
 */
export const DEFAULT_THREAD_DOMAINS: ThreadDomainConfig[] = [
  { domain: 'docs', layerId: 'docs', guardTriggers: ['file_write', 'Write'] },
  { domain: 'conventions', layerId: 'conventions', guardTriggers: ['file_write', 'Write', 'Edit'] },
  {
    domain: 'security',
    layerId: 'security',
    guardTriggers: ['file_write', 'Write', 'Edit', 'Bash', 'bash'],
  },
  { domain: 'architecture', layerId: 'architecture', guardTriggers: ['file_write', 'Write'] },
  { domain: 'memory', layerId: 'memory', guardTriggers: [], programmaticGuard: true },
];

export interface ThreadRuntimeDeps {
  /** Runtime config; agent kinds decide which dispatches get pre-message routing. */
  config: FoundryConfig;
  /** Cheap, fast LLM shared by the Cartographer and Wardens. Scoped per thread and role. */
  llm: LLMProvider;
  /** Unified event feed for the viewer. Optional in tests. */
  eventStream?: EventStream;
  /** Atlas-mapped repo root. Loaded asynchronously per thread; failures are logged, never thrown. */
  atlasRoot?: string;
  /** Wardens registered in code over stack layers. A configured Warden of the same domain wins. Default none. */
  domains?: ThreadDomainConfig[];
  /** Resolves configured source ids (a Warden's `domainKnowledge`); the factory passes its own on attach. */
  resolveSource?: ResolveSource;
  /** Already constructed phase providers, including explicit expert selections. */
  providers?: ReadonlyMap<string, LLMProvider>;
  /** Threshold for the built-in low-confidence reaction rule. Default 0.5. */
  lowConfidenceThreshold?: number;
  /** Pre-message deadlines, concurrency and budget. Validated by the orchestrator. */
  flow?: FlowTimingConfig;
  /** The process's Warden pre-filter (settings `prefilter`, off by default); absent asks every Warden. */
  prefilter?: WardenPrefilter;
  /** Post-work learning deadline and knowledge size. */
  learning?: LearningConfig;
  /** Persistence subscribers (file memory, postgres, muninn) attached to every thread's bus with that thread as owner. */
  signalSinks?: SignalSink[];
  /**
   * Native session adapter. Its lifecycle signals for the central session are
   * bound to the thread bus; auxiliary sessions are bound to a side bus and
   * re-emitted with an `auxiliary_` prefix so they never invalidate the ledger.
   */
  sessionAdapter?: SessionAdapter;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Snapshot of every domain's thread knowledge for one thread, qualified by
 * thread and project. Persisted by G4; produced and validated here.
 */
export interface ThreadKnowledgeBundle {
  readonly threadId: string;
  readonly projectId?: string;
  readonly capturedAt: number;
  readonly domains: Record<string, ThreadKnowledgeSnapshot>;
}

/** Post-work learning settings. */
export interface LearningConfig {
  /** Disable new knowledge reviews without disabling advice or action guards. */
  enabled?: boolean;
  /** Soft observation expiry: pending work becomes delayed, not ineligible. */
  timeoutMs?: number;
  /** Irreversible eligibility deadline; native occupancy may outlive it. Default 60s. */
  hardTimeoutMs?: number;
  /** Explicit background phase options; no central model fallback is substituted. */
  reviewOpts?: CompletionOpts;
  reviewProvider?: LLMProvider;
  /** Monotonic clock seam for deterministic deadline-boundary tests. */
  clock?: () => number;
  /** Deprecated compatibility setting. Validated, but central work never waits for review. */
  barrierMs?: number;
  /** Maximum characters a reviewer may write as thread knowledge. Default 4 000. */
  maxKnowledgeChars?: number;
}

/** Everything a thread owns beyond its stack and agents. Disposed as a unit. */
export interface ThreadRuntime {
  readonly thread: Thread;
  readonly librarian: Librarian;
  readonly cartographer: Cartographer;
  readonly domainLibrarians: ReadonlyMap<string, DomainLibrarian>;
  readonly flowOrchestrator: FlowOrchestrator;
  readonly reactive: ReactiveMiddleware;
  /** Native session ids used by this thread's auxiliaries (never the central id). */
  readonly auxiliarySessionIds: ReadonlyArray<string>;
  /** Resolves once async setup (atlas load) has settled. Never rejects. */
  readonly ready: Promise<void>;
  readonly disposed: boolean;
  /** Domain reviews not yet settled, including timed-out calls still running. */
  readonly learningOutstanding: number;
  readonly generation: string;
  readonly learningState: LearningState;
  reviewEligible(job: ReviewJob): boolean;
  /** Tool observations held for open dispatches, and those that could not be attributed. */
  readonly toolEvidence: ToolEvidenceState;
  /** Resolves once every queued review has been handled. */
  learningSettled(): Promise<void>;
  /** Every domain's thread knowledge, ready for persistence. */
  knowledgeSnapshot(): ThreadKnowledgeBundle;
  /** Restore every domain's thread knowledge. Validates all before applying any. */
  restoreKnowledge(bundle: ThreadKnowledgeBundle): void;
  /** Restore a durable unresolved capacity marker; never resumes native work. */
  restoreReviewClosure(domain: string, reason: string, retained?: LearningRecord): void;
  /** Explicit capacity reconciliation from already retained settlement; never sends work. */
  reconcileReviewCapacity(domain: string): boolean;
  /** Exact retained job inspection only. Never admits queued/replacement work. */
  reconcileNativeReview(domain: string, jobId: string): Promise<boolean>;
  /**
   * Apply edited settings from the next turn: Cartographer and Warden instructions and Warden guard
   * triggers. Returns what only a new thread picks up (added, removed or remapped Wardens).
   */
  reconfigure(config: FoundryConfig, domains: ReturnType<typeof resolveThreadDomains>): string[];
  dispose(): void;
}

export interface LearningState {
  readonly domains: Record<
    string,
    {
      status: string;
      queued: number;
      queuedEvidence: KnowledgeEvidence[];
      job?: ReviewJob;
      persistence?: string;
      localSettled?: boolean;
      nativeOutcome?: NativeEvidence['nativeOutcome'];
      native?: NativeEvidence;
      localOutcome?: NativeEvidence['localOutcome'];
      localError?: string;
      rpcOutcome?: NativeEvidence['rpcOutcome'];
      transportOutcome?: NativeEvidence['transportOutcome'];
      capacity?: 'settled' | 'unknown';
      closed?: boolean;
      cleanup?: string;
      phase?: {
        providerId: string;
        requestedModel?: string;
        modelSelection: 'explicit' | 'provider-default';
        executionKind?: 'request' | 'session';
        lifecycleEvidence: 'available' | 'unavailable';
      };
    }
  >;
}
export type KnowledgeCommitter = (
  runtime: ThreadRuntime,
  job: ReviewJob,
  candidate: ThreadKnowledgeSnapshot,
  signal: Signal,
) => 'durable' | 'stale' | 'duplicate';

/**
 * One immutable phase record for the owned journal: the exact input supplied at a call boundary
 * (route, advice, guard-request) or a later outcome row that references it (guard-outcome). Turn and
 * dispatch identity come from the live dispatch when known; otherwise they are null and the record
 * says so. Recording an input is not evidence of native receipt.
 */
export interface PhaseRecordInput {
  /** The tree node the row belongs to when it is not this thread: an observed subagent's guards. */
  readonly node?: { readonly id: string; readonly meta: ThreadMeta };
  readonly id: string;
  readonly turnId: string | null;
  readonly dispatchId: string | null;
  readonly phase:
    | 'route'
    | 'advice'
    | 'guard-request'
    | 'guard-outcome'
    | 'gate-request'
    | 'gate-outcome'
    | 'middleware-reduced'
    | 'handoff'
    | 'handoff-return'
    | FeedbackPhase;
  readonly record: Record<string, unknown>;
}
export type PhaseJournal = (runtime: ThreadRuntime, record: PhaseRecordInput) => void;
/** Outcome of one phase journal write: durable, absent (no journal configured) or failed (configured journal refused). */
export type PhaseJournalOutcome = 'durable' | 'absent' | 'failed';
export type LearningJournal = (runtime: ThreadRuntime, signal: Signal) => void;

/** A tool observation with whatever identity its signal carried. */
export interface CorrelatedToolObservation extends ToolCallObservation {
  readonly signalId: string;
  readonly threadId?: string;
  readonly dispatchId?: string;
  readonly agentId?: string;
  /** Fields that arrived malformed and were zeroed or dropped. */
  readonly malformed?: string[];
  /** Why this observation could not be attributed, when it could not. */
  readonly reason?: string;
}

/** What the runtime currently holds as tool evidence. */
export interface ToolEvidenceState {
  /** Dispatches with observed tool calls whose completion has not arrived. */
  readonly pendingDispatches: number;
  /** Observations that named no dispatch of this thread. Never attributed. */
  readonly uncorrelated: ReadonlyArray<CorrelatedToolObservation>;
}

const REACTIVE_MIDDLEWARE_ID = 'reactive';
const FLOW_MIDDLEWARE_ID = 'flow-pre-message';
const MAX_REVIEWED_IDS = 500;
const MAX_QUEUED_REVIEWS = 8;
interface ReviewState {
  status: string;
  job: ReviewJob;
  persistence?: string;
  localSettled: boolean;
  nativeOutcome: NativeEvidence['nativeOutcome'];
  native?: NativeEvidence;
  localOutcome?: NativeEvidence['localOutcome'];
  localError?: string;
  rpcOutcome?: NativeEvidence['rpcOutcome'];
  transportOutcome?: NativeEvidence['transportOutcome'];
  capacity: 'settled' | 'unknown';
  cleanup?: string;
  deadlineAt: number;
  settledAt?: number;
  committedAt?: number;
  /** Whether the "requested" review record reached the durable journal before the answer. */
  requestJournal?: 'durable' | 'absent' | 'failed';
}
const MAX_TOOL_BUCKETS = 50;
const MAX_TOOLS_PER_DISPATCH = 20;
const MAX_UNCORRELATED_TOOLS = 50;
/** Bound applied to every external observation field at the receiving boundary. */
const MAX_EXTERNAL_FIELD = 1024;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function positiveMs(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds, got ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/**
 * Attaches the per-thread runtime (Librarian, Cartographer, Wardens,
 * FlowOrchestrator, reactive rules, event bridges, persistence sinks, native
 * session bindings) to threads and tears it down again. One manager per
 * process; one runtime per live thread id. Attach is idempotent for the same
 * Thread object and rejects a different object with a live id. Dispose is
 * idempotent and also runs when the thread itself is archived.
 */
export class ThreadRuntimeManager {
  private _deps: ThreadRuntimeDeps;
  private _runtimes = new Map<string, ThreadRuntimeImpl>();
  private _stacks = new Map<string, ContextStack>();
  private _sinks = new Set<SignalSink>();
  private _sinkUnsubs = new Map<SignalSink, Map<string, () => void>>();
  private _knowledgeCommitter?: KnowledgeCommitter;
  private _publicationFailure?: (runtime: ThreadRuntime, job: ReviewJob, error: unknown) => void;
  private _reviewOwners = new Map<string, string>();
  private _learningJournal?: LearningJournal;
  private _restoreRuntime?: (runtime: ThreadRuntime) => void;
  private _phaseJournal?: PhaseJournal;

  /** Durable phase records (routing, advice, guard request/outcome) for current AND future runtimes. */
  setPhaseJournal(journal: PhaseJournal): () => void {
    if (this._phaseJournal) throw Error('Phase journal already attached');
    this._phaseJournal = journal;
    return () => {
      if (this._phaseJournal === journal) this._phaseJournal = undefined;
    };
  }

  /** Audit/restore authority is independent of fallible signal observers. */
  setLearningJournal(
    journal: LearningJournal,
    restore: (runtime: ThreadRuntime) => void,
  ): () => void {
    if (this._learningJournal) throw Error('Learning journal already attached');
    this._learningJournal = journal;
    this._restoreRuntime = restore;
    return () => {
      if (this._learningJournal === journal) {
        this._learningJournal = undefined;
        this._restoreRuntime = undefined;
      }
    };
  }

  /** Synchronous transaction boundary: installed for current AND future runtimes. */
  setKnowledgeCommitter(
    commit: KnowledgeCommitter,
    publicationFailure?: (runtime: ThreadRuntime, job: ReviewJob, error: unknown) => void,
  ): () => void {
    if (this._knowledgeCommitter) throw new Error('Knowledge committer already attached');
    this._knowledgeCommitter = commit;
    this._publicationFailure = publicationFailure;
    return () => {
      if (this._knowledgeCommitter === commit) {
        this._knowledgeCommitter = undefined;
        this._publicationFailure = undefined;
      }
    };
  }

  constructor(deps: ThreadRuntimeDeps) {
    this._deps = deps;
    for (const sink of deps.signalSinks ?? []) this._sinks.add(sink);
  }

  get runtimes(): ReadonlyMap<string, ThreadRuntime> {
    return this._runtimes;
  }

  /** Live stacks keyed by thread id. Updated on attach and dispose; handed to in-process jobs. */
  get stacks(): Map<string, ContextStack> {
    return this._stacks;
  }

  get(threadId: string): ThreadRuntime | undefined {
    return this._runtimes.get(threadId);
  }

  has(threadId: string): boolean {
    return this._runtimes.has(threadId);
  }

  /**
   * Wire a thread. Returns the existing runtime for the same Thread object;
   * throws if a different Thread object already holds this id live.
   */
  attach(
    thread: Thread,
    configuration?: FoundryConfig,
    resolveSource?: ResolveSource,
  ): ThreadRuntime {
    if (thread.disposed) {
      throw new Error(
        `Thread "${thread.id}" is disposed; restore by creating a new thread, not by reattaching this object`,
      );
    }
    const existing = this._runtimes.get(thread.id);
    if (existing && !existing.disposed) {
      if (existing.thread !== thread) {
        throw new Error(`Thread id "${thread.id}" is already live for a different Thread object`);
      }
      return existing;
    }

    const config = structuredClone(
      configuration ??
        (thread.meta.projectId
          ? resolveProjectView(this._deps.config, thread.meta.projectId)?.config
          : undefined) ??
        this._deps.config,
    );
    // All mappings, provider selections and generated-layer collisions are
    // checked before Librarian, middleware, subscriptions or layers attach.
    const domains = resolveThreadDomains(
      config,
      new Map(thread.stack.layers.map((l) => [l.id, l])),
      {
        policy: this._deps.domains ?? DEFAULT_THREAD_DOMAINS,
        programmatic: this._deps.domains ?? [],
        llm: this._deps.llm,
        providers: this._deps.providers,
        learning: this._deps.learning,
        warn: this._deps.warn ?? ((line) => console.warn(line)),
      },
    );
    const runtime: ThreadRuntimeImpl = new ThreadRuntimeImpl(
      thread,
      { ...this._deps, config, resolveSource: resolveSource ?? this._deps.resolveSource },
      domains,
      (job, candidate, signal) =>
        this._knowledgeCommitter
          ? this._knowledgeCommitter(runtime, job, candidate, signal)
          : 'memory',
      () => {
        if (this._runtimes.get(thread.id) === runtime) this._runtimes.delete(thread.id);
        if (this._stacks.get(thread.id) === thread.stack) this._stacks.delete(thread.id);
        for (const perThread of this._sinkUnsubs.values()) perThread.delete(thread.id);
      },
      (job, error) => this._publicationFailure?.(runtime, job, error),
      (domain, release) => {
        const key = JSON.stringify([thread.id, runtime.owner.projectId ?? null, domain, 'review']);
        const owner = this._reviewOwners.get(key);
        if (release) {
          if (owner === runtime.generation) this._reviewOwners.delete(key);
          return true;
        }
        if (owner && owner !== runtime.generation) return false;
        this._reviewOwners.set(key, runtime.generation);
        return true;
      },
      (signal) => {
        if (!this._learningJournal) return false;
        this._learningJournal(runtime, signal);
        return true;
      },
      (record) => {
        if (!this._phaseJournal) return 'absent';
        this._phaseJournal(runtime, record);
        return 'durable';
      },
    );
    this._runtimes.set(thread.id, runtime);
    this._stacks.set(thread.id, thread.stack);
    for (const sink of this._sinks) this._subscribeSink(sink, runtime);
    this._restoreRuntime?.(runtime);
    return runtime;
  }

  /**
   * Subscribe a persistence sink to every current and future thread. Each
   * call receives the emitting thread as owner. The returned function
   * detaches it from every thread it ever reached.
   */
  addSignalSink(handler: SignalSink): () => void {
    this._sinks.add(handler);
    for (const runtime of this._runtimes.values()) this._subscribeSink(handler, runtime);
    return () => {
      this._sinks.delete(handler);
      const perThread = this._sinkUnsubs.get(handler);
      if (perThread) {
        for (const unsub of perThread.values()) unsub();
        this._sinkUnsubs.delete(handler);
      }
    };
  }

  /**
   * Settings changed: future threads attach with `config`; live threads take the new instructions on
   * their next turn. Returns per-thread changes that need a new thread.
   */
  reconfigure(config: FoundryConfig): string[] {
    this._deps = { ...this._deps, config };
    const deferred: string[] = [];
    for (const runtime of this._runtimes.values()) {
      const projectId = runtime.thread.meta.projectId;
      const view = structuredClone(
        (projectId ? resolveProjectView(config, projectId)?.config : undefined) ?? config,
      );
      try {
        const domains = resolveThreadDomains(
          view,
          new Map(
            runtime.thread.stack.layers
              .filter((l) => !isThreadKnowledgeLayerId(l.id))
              .map((l) => [l.id, l]),
          ),
          {
            policy: this._deps.domains ?? DEFAULT_THREAD_DOMAINS,
            programmatic: this._deps.domains ?? [],
            llm: this._deps.llm,
            providers: this._deps.providers,
            learning: this._deps.learning,
          },
        );
        for (const change of runtime.reconfigure(view, domains))
          deferred.push(`${runtime.thread.id}: ${change}`);
      } catch (error) {
        deferred.push(`${runtime.thread.id}: ${(error as Error).message}`);
      }
    }
    return deferred;
  }

  dispose(threadId: string): boolean {
    const runtime = this._runtimes.get(threadId);
    if (!runtime) return false;
    runtime.dispose();
    return true;
  }

  disposeAll(): void {
    for (const runtime of [...this._runtimes.values()]) runtime.dispose();
  }

  private _subscribeSink(handler: SignalSink, runtime: ThreadRuntimeImpl): void {
    let perThread = this._sinkUnsubs.get(handler);
    if (!perThread) {
      perThread = new Map();
      this._sinkUnsubs.set(handler, perThread);
    }
    if (perThread.has(runtime.thread.id)) return;
    perThread.set(runtime.thread.id, runtime.addSink(handler));
  }
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

class ThreadRuntimeImpl implements ThreadRuntime {
  readonly generation = newId('runtime');
  readonly thread: Thread;
  readonly librarian: Librarian;
  readonly cartographer: Cartographer;
  readonly domainLibrarians: Map<string, DomainLibrarian>;
  readonly flowOrchestrator: FlowOrchestrator;
  readonly reactive: ReactiveMiddleware;
  readonly auxiliarySessionIds: string[];
  readonly ready: Promise<void>;

  private _unsubs: Array<() => void> = [];
  private _disposed = false;
  private _prestartTimer?: ReturnType<typeof setTimeout>;
  /** Providers that may hold pre-started work for this thread (released on dispose). */
  private _wardenProviders = new Set<LLMProvider>();
  private _eventStream: EventStream | undefined;
  private _onDisposed: () => void;
  private _knowledgeLayers: ContextLayer[] = [];
  private _scope!: OwnershipScope;
  private _resolveSource: ResolveSource | undefined;
  private _cartographerRole!: string;
  private _cartographerInstructions!: ContextLayer;
  /** Each configured Warden's composed slots, by domain. */
  private _roleLayers = new Map<string, { role: string } & RoleLayers>();
  /** The charter this thread's Wardens run under (what its chorus is built from), journalled with every call. */
  private _charter!: WardenCharter;
  private _learningTimeoutMs = 10_000;
  private _hardTimeoutMs = 60_000;
  private _epoch = 0;
  private _clock: () => number;
  readonly owner: Readonly<{ threadId: string; projectId?: string }>;
  private _reviewStates = new Map<string, ReviewState>();
  private _nativeReconcilers = new Map<
    string,
    { job: ReviewJob; inspect: () => Promise<boolean> }
  >();
  private _queuedEvidence = new Map<string, ReviewInput[]>();
  private _closedReviews = new Map<
    string,
    { promise: Promise<void>; close: () => void; closed: boolean; reason?: string }
  >();
  /** Per-domain serial queues: revisions follow observation order within a domain; domains run independently. */
  private _learningQueues = new Map<string, Promise<void>>();
  private _learningOutstanding = 0;
  private _reviewed = new Set<string>();
  /** The pre-filter's one call per completed turn, shared by every Warden's review of it. */
  private _reviewPrefilter = new WeakMap<ReviewInput, Promise<PrefilterOutcome | undefined>>();
  /** Tool calls keyed by dispatch id, then call id: exactly one entry per executed call. */
  private _toolsByDispatch = new Map<string, Map<string, CorrelatedToolObservation>>();
  /** Observations that named no dispatch of this thread. Visible, never attributed. */
  private _uncorrelatedTools: CorrelatedToolObservation[] = [];
  /** Dispatch ids currently executing on this thread; only these may receive evidence. */
  /** Live dispatches by id, with the trace annotations that guard outcomes are recorded on. */
  private _liveDispatches = new Map<string, LiveDispatch>();
  /** An observed subagent turn's tool activity (`<node>:<turn>`), guarded once when its turn ends. */
  private _subagentActivity = new Map<
    string,
    {
      node: { id: string; meta: ThreadMeta };
      turnId: string | null;
      observations: ToolObservation[];
    }
  >();
  /** How often the guard fires (settings `guard`, default `per-turn`). */
  private readonly _guardMode: GuardMode;
  private readonly _log: (line: string) => void;
  private readonly _warn: (line: string) => void;

  constructor(
    thread: Thread,
    deps: ThreadRuntimeDeps,
    domains: ReturnType<typeof resolveThreadDomains>,
    private readonly _commitKnowledge: (
      job: ReviewJob,
      candidate: ThreadKnowledgeSnapshot,
      signal: Signal,
    ) => 'memory' | 'durable' | 'stale' | 'duplicate',
    onDisposed: () => void,
    private readonly _publicationFailure: (job: ReviewJob, error: unknown) => void,
    private readonly _reviewLease: (domain: string, release: boolean) => boolean,
    private readonly _journalLearning: (signal: Signal) => boolean,
    /** "durable" when journalled, "absent" when no phase journal is configured; throws when a configured journal refuses. */
    private readonly _journalPhase: (record: PhaseRecordInput) => 'durable' | 'absent' = () =>
      'absent',
  ) {
    const log = deps.log ?? ((line) => console.log(line));
    const warn = deps.warn ?? ((line) => console.warn(line));
    this._log = log;
    this._warn = warn;
    this._guardMode = deps.config.guard ?? 'per-turn';
    const { stack, signals } = thread;
    const cwd = () => thread.meta.cwd;
    this.thread = thread;
    this.owner = Object.freeze({ threadId: thread.id, projectId: thread.meta.projectId });
    this._eventStream = deps.eventStream;
    this._onDisposed = onDisposed;
    this._clock = deps.learning?.clock ?? (() => performance.now());
    this.auxiliarySessionIds = [];

    // The shared factual thread record is not an expert's private interpretation.
    // Keep full learning signals on the original owned bus/journal for inspection;
    // only outcome metadata enters the shared state every domain reads. Project
    // at the typed signal boundary, never by filtering rendered activity text.
    const factualSignals = new SignalBus(0); // transient projection, no second history
    this.librarian = new Librarian({ signals: factualSignals, stack });
    this._unsubs.push(
      signals.onAny((signal) => {
        if (signal.kind !== 'domain_learning') return factualSignals.emit(signal);
        const record = signal.content as
          | (Partial<LearningRecord> & { domain?: string })
          | undefined;
        // Silence is not activity: a NO_COMMENT or pre-filtered review adds nothing to the shared state.
        if (record?.decision === 'no-comment' || record?.decision === 'prefiltered') return;
        return factualSignals.emit({
          ...signal,
          content: {
            domain: record?.domain,
            decision: record?.decision,
            ...(record?.revision !== undefined ? { revision: record.revision } : {}),
          },
        });
      }),
    );
    this._unsubs.push(() => factualSignals.clearHistory());

    // Every model-backed middleware role composes its slots from the composition view, bound to
    // this thread's cwd and project. Private layers: never on the stack, never sent to the executor.
    this._scope = {
      threadId: thread.id,
      get projectId() {
        return thread.meta.projectId as string | undefined;
      },
      get cwd() {
        return thread.meta.cwd;
      },
    };
    this._resolveSource = deps.resolveSource;
    const cartographerRole = cartographerRoleId(deps.config);
    this._cartographerRole = cartographerRole;
    // The Cartographer receives instructions only; its domain knowledge is the map it builds.
    this._cartographerInstructions = buildRoleLayer(
      deps.config,
      cartographerRole,
      'instructions',
      ['instructions'],
      { builtIn: DEFAULT_ROUTE_INSTRUCTIONS, scope: this._scope },
    );
    const cartographerId = auxiliarySessionId(thread.id, 'cartographer');
    this.auxiliarySessionIds.push(cartographerId);
    this.cartographer = new Cartographer({
      stack,
      signals,
      llm: scopedProvider(deps.llm, { threadId: cartographerId, cwd }),
      llmOpts: { maxTokens: 256, temperature: 0 },
      instructions: this._cartographerInstructions,
      role: cartographerRole,
      budget: roleComposition(deps.config.composition, cartographerRole).budget,
      atlasRoot: deps.atlasRoot,
    });
    this.cartographer.buildMap();

    this.domainLibrarians = new Map();
    const charter = wardenCharter(
      chorusSource(deps.config, thread.meta.projectId as string | undefined),
    );
    this._charter = charter;
    this._learningTimeoutMs = positiveMs('learning.timeoutMs', deps.learning?.timeoutMs, 10_000);
    // Retained configuration is validated for compatibility, but never adds a central wait.
    positiveMs('learning.barrierMs', deps.learning?.barrierMs, 5_000);
    this._hardTimeoutMs = positiveMs(
      'learning.hardTimeoutMs',
      deps.learning?.hardTimeoutMs,
      60_000,
    );
    for (const dc of domains) {
      const role = dc.expert?.agentId;
      const slots = role
        ? buildRoleLayers(deps.config, role, {
            resolveSource: deps.resolveSource,
            scope: this._scope,
          })
        : undefined;
      if (role && slots) this._roleLayers.set(dc.domain, { role, ...slots });
      const cache = slots?.domainKnowledge ?? (dc.layerId ? stack.getLayer(dc.layerId) : undefined);
      if (!cache) continue;
      const domainId = auxiliarySessionId(thread.id, `domain:${dc.domain}`);
      this.auxiliarySessionIds.push(domainId);
      // A review generation never resumes a possibly unknown operation from an old runtime.
      // Existing advice/guard and historical review bindings remain untouched.
      const reviewId = auxiliarySessionId(
        thread.id,
        `review:${this.generation}:domain:${dc.domain}`,
      );
      this.auxiliarySessionIds.push(reviewId);
      let close!: () => void;
      const promise = new Promise<void>((resolve) => {
        close = resolve;
      });
      this._closedReviews.set(dc.domain, { promise, close, closed: false });
      // Generated, thread-private: this domain's understanding of this thread.
      // It lives on this thread's stack only, next to the configured cache,
      // and is never part of the project template.
      const threadKnowledgeLayer = new ContextLayer({
        id: threadKnowledgeLayerId(dc.domain),
        owner: { threadId: thread.id, projectId: thread.meta.projectId as string | undefined },
        prompt: `What the ${dc.domain} domain has learned about this thread (generated, thread-private).`,
        segment: 'thread-knowledge',
      });
      stack.addLayer(threadKnowledgeLayer);
      this._knowledgeLayers.push(threadKnowledgeLayer);
      this.domainLibrarians.set(
        dc.domain,
        new DomainLibrarian({
          domain: dc.domain,
          cache,
          ...(slots ? { instructions: slots.instructions, role } : {}),
          ...(dc.budget !== undefined ? { budget: dc.budget } : {}),
          charter: charter.text,
          signals,
          llm: scopedProvider(dc.adviseProvider ?? deps.llm, { threadId: domainId, cwd }),
          llmOpts: dc.adviseOpts ?? { maxTokens: 512, temperature: 0 },
          reviewLlm: scopedProvider(
            dc.reviewProvider ?? deps.learning?.reviewProvider ?? deps.llm,
            { threadId: reviewId, cwd },
          ),
          reviewOpts: dc.expert
            ? dc.reviewOpts
            : { ...deps.learning?.reviewOpts, ...dc.reviewOpts },
          reviewPrompt: dc.reviewPrompt,
          guardTriggers: dc.guardTriggers,
          advisePrompt: dc.advisePrompt,
          guardPrompt: dc.guardPrompt,
          programmaticGuard: dc.programmaticGuard,
          threadKnowledgeLayer,
          maxKnowledgeChars: deps.learning?.maxKnowledgeChars,
        }),
      );
    }

    // Classifier/router auxiliaries are named by the factory-built agents
    // (see thread-factory.ts); list them so their native events can be bound.
    for (const [agentId, agentCfg] of Object.entries(deps.config.agents)) {
      if (!agentCfg.enabled) continue;
      if (agentCfg.kind === 'classifier' || agentCfg.kind === 'router') {
        this.auxiliarySessionIds.push(auxiliarySessionId(thread.id, `agent:${agentId}`));
      }
    }

    this.flowOrchestrator = new FlowOrchestrator({
      cartographer: this.cartographer,
      domainLibrarians: this.domainLibrarians,
      librarian: this.librarian,
      stack,
      signals,
      ...deps.flow,
      ...(deps.prefilter ? { prefilter: deps.prefilter, threadId: thread.id } : {}),
    });

    for (const dc of domains) this._wardenProviders.add(dc.adviseProvider ?? deps.llm);
    // Pre-start every Warden as soon as its composed context is warm, so the first trigger starts at
    // once. Only a provider that pre-starts warms anything here; otherwise caches warm on first use.
    if ([...this._wardenProviders].some((provider) => provider.prestart))
      void Promise.all(
        [...this.domainLibrarians.values()].map((lib) => lib.warm().catch(() => undefined)),
      ).then(() => this._schedulePrestart());

    this.reactive = new ReactiveMiddleware({ stack, signals });
    this.reactive.addRule(lowConfidenceRule(deps.lowConfidenceThreshold ?? 0.5));
    thread.middleware.use(REACTIVE_MIDDLEWARE_ID, this.reactive.asMiddleware());

    // Pre-message decoration: every domain assesses the frozen input in
    // parallel with routing; the sealed plan and composed decoration reach
    // the executor through dispatch annotations. The delivery ledger is
    // committed only after the executor demonstrably received the turn.
    const flow = this.flowOrchestrator;
    const domainLibrarians = this.domainLibrarians;
    // One concurrent pre-message phase: the Cartographer and every domain assessment start on the
    // message's first decision dispatch (classify/route, themselves concurrent), against the same
    // frozen input, and the executor dispatch picks up the sealed plan. Without a decision stage the
    // executor dispatch starts it. Composition stays deterministic (configured order, hashes).
    // The input is frozen when the message arrives: thread state is as of the previous turn, so this
    // message's own classification is not part of what the Cartographer and Wardens assess. Layer
    // hydration (focus, warming) happens only in the executor dispatch that uses the plan.
    const prepare = async (
      message: string,
      identity: { messageId: string; threadId: string; projectId?: string } | undefined,
    ) => {
      // Snapshot pending reviews without waiting. A later turn uses the latest
      // committed revision; this turn's historical preparation stays immutable.
      const barrier = await this._awaitPendingLearning();
      // Newly resolved project experts read their actual owned sources on the first pre-hook, not
      // only the global template. Wardens never block: a warm that is late or fails is recorded and
      // the turn goes on (that Warden advises from what it holds, or is skipped with a cold cache).
      const warmShortfalls = await flow.warmWithin(
        domains
          .filter((d) => d.expert)
          .map((d) => ({ id: d.domain, warm: () => domainLibrarians.get(d.domain)!.warm() })),
      );
      for (const shortfall of warmShortfalls)
        warn(
          `  [flow:${thread.id}] ${shortfall.id} Warden cache not warm (${shortfall.outcome}): ${shortfall.reason}`,
        );
      let plan: InjectionPlan | undefined, failure: Error | undefined;
      try {
        plan = await flow.preMessage(message, identity);
      } catch (error) {
        failure = error as Error;
      }
      return { barrier, plan, failure, warmShortfalls };
    };
    const early = new Map<
      string,
      { message: string; startedAt: number; preparation: ReturnType<typeof prepare> }
    >();
    // A preparation whose message never reaches an executor (a failed or non-executor route) is dropped after ten minutes.
    const pruneEarly = setInterval(() => {
      for (const [id, entry] of early) if (Date.now() - entry.startedAt > 600_000) early.delete(id);
    }, 60_000);
    (pruneEarly as { unref?: () => void }).unref?.();
    this._unsubs.push(() => {
      clearInterval(pruneEarly);
      early.clear();
    });
    const identityOf = (ctx: { messageId?: string; threadId?: string; projectId?: string }) =>
      ctx.messageId && ctx.threadId
        ? { messageId: ctx.messageId, threadId: ctx.threadId, projectId: ctx.projectId }
        : undefined;
    thread.middleware.use(FLOW_MIDDLEWARE_ID, async (ctx, next) => {
      const agentCfg = deps.config.agents[ctx.agentId];
      if (typeof ctx.payload !== 'string') return next();
      if ((agentCfg?.kind === 'classifier' || agentCfg?.kind === 'router') && ctx.messageId) {
        if (!early.has(ctx.messageId)) {
          const preparation = prepare(ctx.payload, identityOf(ctx));
          preparation.catch(() => undefined); // observed by the executor dispatch that consumes it
          early.set(ctx.messageId, { message: ctx.payload, startedAt: Date.now(), preparation });
        }
        return next();
      }
      if (agentCfg?.kind !== 'executor') return next();

      // This dispatch is live from here until it returns: only a live
      // dispatch can receive tool evidence, so an arbitrary or stale id
      // never opens a bucket.
      const liveId = ctx.dispatchId;
      if (liveId)
        this._liveDispatches.set(liveId, {
          annotations: ctx.annotations as Record<string, unknown>,
          guards: [],
          messageId: ctx.messageId ?? null,
          activity: [],
          overflow: 0,
        });
      try {
        const started = ctx.messageId ? early.get(ctx.messageId) : undefined;
        if (ctx.messageId) early.delete(ctx.messageId);
        const {
          barrier,
          plan: preparedPlan,
          failure,
          warmShortfalls,
        } = await (started && started.message === ctx.payload
          ? started.preparation
          : prepare(ctx.payload, identityOf(ctx)));

        let prepared: HydrationResult | undefined;
        try {
          if (failure || !preparedPlan) throw failure ?? Error('pre-message produced no plan');
          const plan = preparedPlan;
          prepared = await flow.hydrateDelta(plan);
          // The plan's layers are what routing and the Wardens asked for: on-demand ones join this assembly.
          for (const id of plan.layers) ctx.requestLayer?.(id);
          ctx.annotations.injectionPlan = plan;
          ctx.annotations.decoration = prepared.decoration;
          // Durable at seal, before the central call: the routing request and every expert's advice request
          // with its three parts survive a failed or interrupted central turn. Journal failure is explicit.
          const sealedTurn = ctx.messageId ?? null,
            sealedDispatch = ctx.dispatchId ?? null;
          // A refused configured journal is recorded as failed and warned, never as durable; the central turn is not blocked.
          const journalSealed = (
            phase: 'route' | 'advice',
            record: Record<string, unknown>,
          ): PhaseJournalOutcome => {
            try {
              return this._journalPhase({
                id: newId('phase'),
                turnId: sealedTurn,
                dispatchId: sealedDispatch,
                phase,
                record,
              });
            } catch (error) {
              warn(
                `  [flow:${thread.id}] ${phase} phase journal failed: ${(error as Error)?.message ?? error}`,
              );
              return 'failed';
            }
          };
          const routeJournal = journalSealed('route', {
            inputHash: plan.input.hash,
            sealedAt: plan.sealedAt,
            routing: plan.routing,
          });
          // Every Warden's decision is journalled, silence and skips included, so the silence rate is
          // measurable; a skipped (cold) Warden was given nothing, so its row carries no inputs.
          const adviceJournal = journalSealed('advice', {
            trigger: 'user-message' satisfies TriggerPoint,
            charter: charter.version,
            inputHash: plan.input.hash,
            sealedAt: plan.sealedAt,
            participants: plan.contributions
              .filter((c) => c.decision !== 'skipped')
              .map((c) => ({
                domain: c.domain,
                decision: c.decision,
                ...(c.reason ? { reason: c.reason } : {}),
                // What it chimed in with (empty for NO_COMMENT).
                snippets: c.snippets,
                segments: c.segments,
                request: c.request,
                threadKnowledgeRevision: c.provenance.threadKnowledgeRevision,
                cacheHash: c.provenance.cacheHash,
              })),
            // A Warden the pre-filter ruled out is one row with its score: auditable later.
            ...(plan.prefilter ? { prefilter: plan.prefilter } : {}),
            prefiltered: plan.contributions
              .filter((c) => c.prefilter)
              .map((c) => ({ domain: c.domain, ...c.prefilter })),
            skipped: Object.fromEntries(
              Object.entries(
                Object.groupBy(
                  plan.contributions.filter((c) => c.decision === 'skipped'),
                  (c) => c.reason ?? 'skipped',
                ),
              ).map(([reason, list]) => [reason, (list ?? []).map((c) => c.domain)]),
            ),
            ...(warmShortfalls.length || prepared.warmShortfalls.length
              ? { warm: { wardens: warmShortfalls, layers: prepared.warmShortfalls } }
              : {}),
          });
          ctx.annotations.phaseJournal = { route: routeJournal, advice: adviceJournal };
          const decided = plan.contributions.map((c) => `${c.domain}:${c.decision}`).join(', ');
          log(
            `  [flow:${thread.id}] decorated: ${decided || 'no domains'} → ${plan.layers.length} layers, ${plan.snippets.length} snippets (${plan.elapsed}ms)`,
          );
        } catch (err) {
          warn(`  [flow:${thread.id}] pre-message failed: ${(err as Error).message}`);
        }

        // Whatever went stale since the last turn (an edited CLAUDE.md, MEMORY.md or role file, a
        // passed staleness window) re-warms before assembly, whether or not pre-message succeeded,
        // so the change reaches the session as a delta this turn.
        await flow.refreshStale();

        // The delivery ledger: what this thread's native session holds, so a session provider sends
        // only standing context the session lacks (Executor → SessionDelivery.held).
        ctx.annotations.heldLayers = Object.fromEntries(
          this.librarian.state.injectedLayers.map((record) => [record.id, record.hash]),
        );
        const ledgerEpoch = this.librarian.ledgerEpoch;
        const result = await next();
        // The turn's tool activity has ended: the guard, once, over everything the turn did, in order.
        // Not awaited: Wardens comment, they never hold the hand-back (the pending entry is on the
        // dispatch's guards before the turn's meta is read below; the outcome reconciles it later).
        const landed = liveId ? this._liveDispatches.get(liveId) : undefined;
        if (landed?.activity.length)
          void this._guardActivity(
            { turnId: landed.messageId, observations: landed.activity.splice(0) },
            {
              momentId: newId('guard'),
              dispatchId: liveId!,
              correlation: 'live-dispatch',
              agentId: ctx.agentId,
              live: landed,
            },
            landed.overflow,
          );
        // The turn landed: Wardens are pre-started again with the thread as it now stands.
        this._schedulePrestart();

        // Historical phase record carried on the turn's own result meta (the journalled agent message):
        // the sealed routing outcome with its request, and the guard entries recorded on this live
        // dispatch under their observation identities. Entries still pending here stay pending in the
        // record unless they report before the journal serializes; none becomes an all-clear.
        const phases = () => {
          const sealed = ctx.annotations.injectionPlan as InjectionPlan | undefined;
          return {
            ...(sealed ? { routing: sealed.routing } : {}),
            guards: liveId ? (this._liveDispatches.get(liveId)?.guards ?? []) : [],
            ...(ctx.annotations.phaseJournal ? { journal: ctx.annotations.phaseJournal } : {}),
          };
        };

        // Delivery evidence: the executor recorded its provider input and the
        // dispatch completed. Anything less (no artifact, thrown before send)
        // leaves the ledger untouched. The ledger records what was delivered;
        // the plan keeps what was assessed, and drift between them is explicit.
        const artifact = result.meta?.injection as InjectionArtifact | undefined;
        const plan = ctx.annotations.injectionPlan as InjectionPlan | undefined;
        // A session provider reports what it delivered: a session that started holds its base
        // context and nothing from an earlier session; otherwise it now also holds what was sent.
        const session = artifact?.providerMessages ? artifact.sessionDelivery : undefined;
        const commitSession = async () => {
          if (!session) return undefined;
          // Compacted while the turn ran: what rode in its message may be summarized away. Only the
          // system prompt (base) is still held for certain.
          const compacted = this.librarian.ledgerEpoch !== ledgerEpoch;
          // A relaunch that resumed the ledger's own conversation keeps it (a Codex base is empty).
          if (session.session === 'started' && !session.ledgerKept)
            this.librarian.clearInjectionLedger();
          // One record per part: what was sent this turn supersedes the same part in the base.
          const parts = new Map(
            [
              ...(session.session === 'started' ? session.base : []),
              ...(compacted ? [] : session.sent),
            ].map((part) => [part.id, part] as const),
          );
          return flow.commitDelivery({ layers: [...parts.values()] });
        };
        if (prepared && plan && artifact?.providerMessages && artifact.layers) {
          // What each participant assessed, per layer it owns: the configured cache by hash, and its own
          // thread understanding by hash AND revision. The delivered side comes from the layer's own version
          // mark at assembly; a revision is never inferred from the hash.
          const assessedByLayer = new Map<
            string,
            { domain: string; hash: string; revision?: number }
          >();
          for (const c of plan.contributions) {
            const lib = domainLibrarians.get(c.domain);
            if (!lib) continue;
            assessedByLayer.set(lib.cache.id, { domain: c.domain, hash: c.provenance.cacheHash });
            assessedByLayer.set(lib.threadKnowledge.layer.id, {
              domain: c.domain,
              hash: c.provenance.threadKnowledgeHash,
              revision: c.provenance.threadKnowledgeRevision,
            });
          }
          const layers = artifact.layers
            .filter((l) => l.included)
            .map((l) => {
              const assessed = assessedByLayer.get(l.id);
              const mark = l.version && l.version.hash === l.hash ? l.version : undefined;
              const relation =
                assessed?.revision === undefined
                  ? undefined
                  : mark === undefined
                    ? ('unknown' as const)
                    : mark.revision === assessed.revision
                      ? assessed.hash === l.hash
                        ? ('assessed' as const)
                        : ('inconsistent' as const)
                      : mark.revision > assessed.revision
                        ? ('advanced' as const)
                        : ('inconsistent' as const);
              return {
                id: l.id,
                threadId: l.threadId,
                projectId: l.projectId,
                ...(assessed ? { domain: assessed.domain, assessedHash: assessed.hash } : {}),
                ...(assessed?.revision !== undefined
                  ? { assessedRevision: assessed.revision }
                  : {}),
                deliveredHash: l.hash,
                ...(mark ? { deliveredRevision: mark.revision } : {}),
                ...(relation ? { relation } : {}),
                drift: assessed !== undefined && assessed.hash !== l.hash,
              };
            });
          const committed =
            (await commitSession()) ??
            // A stateless provider received every assembled part; the ledger keys parts by their own hash.
            (layers.length > 0
              ? await flow.commitDelivery({
                  layers: (artifact.standingParts ?? []).filter((part) =>
                    layers.some((l) => l.id === part.id),
                  ),
                })
              : []);
          const delivery: DeliveryRecord = {
            layers,
            committed,
            ...(session ? { session } : {}),
            learningBarrier: barrier,
          };
          return { ...result, meta: { ...(result.meta ?? {}), delivery, phases: phases() } };
        }
        return {
          ...result,
          meta: {
            ...(result.meta ?? {}),
            delivery: {
              layers: [],
              committed: (await commitSession()) ?? [],
              ...(session ? { session } : {}),
              learningBarrier: barrier,
            },
            phases: phases(),
          },
        };
      } finally {
        if (liveId) this._liveDispatches.delete(liveId);
      }
    });

    // Post-action: the guard. One moment per turn over the turn's tool activity in call order
    // (`guard: "per-turn"`, the default), asked when the turn's tool activity ends (the flow middleware
    // above); or one moment per tool call (`guard: "per-call"`). An observed subagent's own turn is
    // guarded the same way, on its node, when its turn ends. Reads and other calls no Warden's
    // triggers name never enter a turn's moment.
    this._unsubs.push(
      signals.onAny(async (signal) => {
        if (signal.kind !== 'tool_observation') return;
        if (signal.source === 'flow-orchestrator') return;
        const content = signal.content as ToolSignalContent | undefined;
        if (!content?.tool) return;
        const observation = toObservation(content as ToolSignalContent & { tool: string });
        const dispatchId = typeof content.dispatchId === 'string' ? content.dispatchId : null;
        const live = dispatchId ? this._liveDispatches.get(dispatchId) : undefined;
        const agentId = typeof content.agentId === 'string' ? content.agentId : undefined;
        const node = content.subagent?.node;
        if (this._guardMode === 'per-call') {
          // Correlation is the live dispatch's own turn id or nothing; never the latest turn or the tool
          // name. A subagent's call belongs to the subagent's own turn.
          await this._guardActivity(
            {
              turnId: content.subagent ? content.subagent.turnId : (live?.messageId ?? null),
              observations: [observation],
            },
            {
              momentId: signal.id,
              dispatchId,
              correlation: content.subagent
                ? 'subagent-call'
                : live
                  ? 'live-dispatch'
                  : dispatchId
                    ? 'dispatch-not-live'
                    : 'no-dispatch-id',
              ...(agentId ? { agentId } : {}),
              ...(live ? { live } : {}),
              ...(node ? { node } : {}),
            },
          );
          return;
        }
        if (!flow.guardsTool(content.tool)) return;
        if (content.subagent) {
          const key = `${content.subagent.node.id}:${content.subagent.turnId ?? 'none'}`;
          let held = this._subagentActivity.get(key);
          if (!held) {
            if (this._subagentActivity.size >= MAX_SUBAGENT_TURNS) {
              const oldest = this._subagentActivity.keys().next().value;
              if (oldest !== undefined) this._subagentActivity.delete(oldest);
            }
            held = {
              node: content.subagent.node,
              turnId: content.subagent.turnId,
              observations: [],
            };
            this._subagentActivity.set(key, held);
          }
          if (held.observations.length < MAX_TURN_ACTIVITY) held.observations.push(observation);
          return;
        }
        if (live) {
          if (live.activity.length < MAX_TURN_ACTIVITY) live.activity.push(observation);
          else live.overflow++;
          return;
        }
        // No live dispatch to hold it for: guarded now as its own moment, visibly uncorrelated.
        await this._guardActivity(
          { turnId: null, observations: [observation] },
          {
            momentId: signal.id,
            dispatchId,
            correlation: dispatchId ? 'dispatch-not-live' : 'no-dispatch-id',
            ...(agentId ? { agentId } : {}),
          },
        );
      }),
    );
    // An observed subagent's turn ended: its held activity is guarded once, on its node.
    this._unsubs.push(
      signals.on('subagent_turn', async (signal) => {
        const content = signal.content as
          | { node?: { id: string; meta: ThreadMeta }; turnId?: string | null }
          | undefined;
        if (!content?.node) return;
        const key = `${content.node.id}:${content.turnId ?? 'none'}`;
        const held = this._subagentActivity.get(key);
        this._subagentActivity.delete(key);
        if (!held?.observations.length) return;
        await this._guardActivity(
          { turnId: held.turnId, observations: held.observations },
          {
            momentId: signal.id,
            dispatchId: null,
            correlation: 'subagent-turn',
            agentId: 'subagent',
            node: held.node,
          },
        );
      }),
    );
    // The agent handed a task to a subagent: the roster briefs the handoff (the subagent-spawn trigger).
    this._unsubs.push(
      signals.on('subagent_spawn', async (signal) => {
        const content = signal.content as
          | (HandoffMoment & {
              parent?: { id: string; meta: ThreadMeta };
              parentTurnId?: string | null;
            })
          | undefined;
        if (!content?.handoffId || !content.childThreadId) return;
        await this._briefHandoff(signal.id, content);
      }),
    );

    // Post-work learning: completed executor work and tool observations feed
    // every domain reviewer (text-only auxiliary). Each observation is
    // reviewed once; per-domain reviews are serialized so revisions follow
    // observation order; a timed-out or post-disposal answer never mutates.
    this._unsubs.push(
      signals.on('tool_observation', (signal) => {
        if (signal.source === 'flow-orchestrator') return;
        // A subagent's call is guarded here, never learned from (its own thread records it).
        if ((signal.content as { subagent?: unknown } | undefined)?.subagent) return;
        if (deps.learning?.enabled === false || deps.config.learning?.enabled === false) return;
        this._recordToolObservation(signal);
      }),
    );
    this._unsubs.push(
      signals.on('dispatch', (signal) => {
        if (deps.learning?.enabled === false || deps.config.learning?.enabled === false) return;
        const observation = signal.content as DispatchObservation | undefined;
        if (!observation?.agentId) return;
        if (deps.config.agents[observation.agentId]?.kind !== 'executor') return;
        this._onCompletedWork(signal.id, observation);
      }),
    );

    // Native session bindings. The central session id is the thread id and
    // binds straight to the thread bus, so its compaction invalidates the
    // ledger. Auxiliary sessions bind to a side bus whose signals are
    // re-emitted with an `auxiliary_` prefix: visible in thread-state and
    // activity, but never mistaken for central compaction.
    const adapter = deps.sessionAdapter;
    if (adapter?.bindSignals) {
      this._unsubs.push(adapter.bindSignals(thread.id, signals));
      const auxBus = new SignalBus();
      this._unsubs.push(
        auxBus.onAny(async (signal) => {
          await signals.emit({ ...signal, kind: `auxiliary_${signal.kind}` });
        }),
      );
      for (const auxId of this.auxiliarySessionIds) {
        this._unsubs.push(adapter.bindSignals(auxId, auxBus));
      }
    }

    // Event bridge: every lifecycle and signal event carries this thread's id.
    const eventStream = deps.eventStream;
    if (eventStream) {
      const threadId = thread.id;
      this._unsubs.push(
        thread.lifecycle.on('layer:warm', async (event) => {
          eventStream.push({ kind: 'layer', threadId, event });
        }),
      );
      this._unsubs.push(
        thread.lifecycle.on('layer:stale', async (event) => {
          eventStream.push({ kind: 'layer', threadId, event });
        }),
      );
      this._unsubs.push(
        signals.onAny(async (signal) => {
          eventStream.push({ kind: 'signal', threadId, signal });
        }),
      );
      eventStream.push({
        kind: 'session',
        event: { type: 'thread:added', threadId, timestamp: Date.now() },
      });
    }

    // Archiving the thread tears down this runtime.
    this._unsubs.push(thread.onDispose(() => this.dispose()));

    thread.start();

    this.ready = deps.atlasRoot
      ? this.cartographer
          .loadAtlas()
          .then((atlas) => {
            if (atlas)
              log(
                `[Cartographer:${thread.id}] atlas loaded: ${atlas.concepts.length} concepts (${atlas.source}) from ${deps.atlasRoot}`,
              );
          })
          .catch((err) => {
            warn(`[Cartographer:${thread.id}] atlas load failed: ${(err as Error).message}`);
          })
      : Promise.resolve();
  }

  get disposed(): boolean {
    return this._disposed;
  }

  get learningOutstanding(): number {
    return this._learningOutstanding;
  }

  /** Frozen deep copies: exported evidence can never reach live state. */
  get toolEvidence(): ToolEvidenceState {
    return Object.freeze({
      pendingDispatches: this._toolsByDispatch.size,
      uncorrelated: Object.freeze(
        this._uncorrelatedTools.map((o) => deepFreeze(structuredClone(o))),
      ),
    });
  }

  /**
   * The guard, over one moment: a turn's tool activity in call order, or one call. Every asked
   * domain's exact request is journalled the moment it is observed, before any answer (a
   * `guard-request` row per domain); one `guard-outcome` row then wraps the whole moment and
   * references the request rows. Both go on the observed subagent's node when the moment is its
   * turn's. The outcome is also recorded on the live dispatch's trace annotations, first as pending,
   * then as reported; a dispatch that has already left the runtime has no live annotations, nothing
   * is guessed, and the report stays in the journal only.
   */
  private async _guardActivity(
    activity: TurnActivity,
    owner: GuardMomentOwner,
    overflow = 0,
  ): Promise<void> {
    if (this._disposed) return;
    const flow = this.flowOrchestrator;
    const { dispatchId, live, node, correlation } = owner;
    const turnId = activity.turnId;
    const single = activity.observations.length === 1 ? activity.observations[0] : undefined;
    // The moment's identity, carried by every row and trace entry about it: one call's own ids, or the
    // turn's. The viewer joins outcome and request rows on it.
    const observation = {
      momentId: owner.momentId,
      tool: activityTools(activity).join(', '),
      calls: activity.observations.length,
      ...(single?.callId ? { callId: single.callId } : {}),
      ...(dispatchId ? { dispatchId } : {}),
      ...(owner.agentId ? { agentId: owner.agentId } : {}),
      ...(turnId ? { turnId } : {}),
    };
    // What the moment wraps: a call, or a turn. Reduced entries carry it (spec A).
    const wraps =
      single?.callId && this._guardMode === 'per-call' ? single.callId : `turn:${turnId ?? 'none'}`;
    const calls = activity.observations.slice(0, 200).map((o) => ({
      tool: o.tool,
      ...(o.callId ? { callId: o.callId } : {}),
      ...(o.ok !== undefined ? { ok: o.ok } : {}),
    }));
    const entry: Record<string, unknown> = {
      observation,
      wraps,
      status: 'pending',
      startedAt: Date.now(),
      correlation,
    };
    if (live) {
      live.guards.push(entry);
      live.annotations.guards = live.guards;
    }
    // Each domain's exact request is journalled the moment it is observed, before any answer, under the
    // moment's identity; the later outcome row references these request rows instead of repeating them.
    const requestRows = new Map<string, { id: string; journal: PhaseJournalOutcome }>();
    // Reference map for the outcome row: the request row id when durable; otherwise the explicit journal state.
    const requestsJournal = () =>
      Object.fromEntries(
        [...requestRows].map(([domain, row]) => [
          domain,
          row.journal === 'durable' ? row.id : row.journal,
        ]),
      );
    const requestJournalStates = () =>
      Object.fromEntries([...requestRows].map(([domain, row]) => [domain, row.journal]));
    const journalOutcome = (record: Record<string, unknown>): PhaseJournalOutcome => {
      try {
        return this._journalPhase({
          ...(node ? { node } : {}),
          id: newId('phase'),
          turnId,
          dispatchId,
          phase: 'guard-outcome',
          record,
        });
      } catch (error) {
        this._warn(
          `  [flow:${this.thread.id}] guard outcome journal failed: ${(error as Error)?.message ?? error}`,
        );
        return 'failed';
      }
    };
    try {
      const report = await flow.postAction(activity, {
        onRequest: (domain, request, threadKnowledgeRevision) => {
          const id = newId('phase');
          try {
            const journal = this._journalPhase({
              ...(node ? { node } : {}),
              id,
              turnId,
              dispatchId,
              phase: 'guard-request',
              record: {
                observation,
                wraps,
                correlation,
                domain,
                threadKnowledgeRevision,
                requestedAt: request.capturedAt,
                request: { status: 'supplied', ...request },
              },
            });
            requestRows.set(domain, { id, journal });
          } catch (error) {
            // Configured persistence refused the supplied input: the guard call is not admitted. The original failure is kept.
            requestRows.set(domain, { id, journal: 'failed' });
            throw Object.assign(
              new Error(
                `guard request journal failed; not admitted: ${(error as Error)?.message ?? error}`,
              ),
              { admission: 'not-admitted', cause: error },
            );
          }
        },
      });
      const outcomeJournal = journalOutcome({
        trigger: 'agent-action' satisfies TriggerPoint,
        mode: this._guardMode,
        charter: this._charter.version,
        observation,
        wraps,
        // The turn's activity the Wardens were given, as identity: tool, call id and outcome per call.
        activity: { turnId, calls, ...(overflow ? { overflow } : {}) },
        correlation,
        status: 'reported',
        finishedAt: Date.now(),
        domainsChecked: report.domainsChecked,
        skipped: report.skipped,
        prefiltered: report.prefiltered,
        ...(report.prefilter ? { prefilter: report.prefilter } : {}),
        failed: report.failed,
        findings: report.findings.length,
        critical: report.critical.length,
        // What the Wardens said: a comment on the turn's actions (shown to hosts), never a block.
        notes: report.findings.slice(0, 16).map((finding) => ({
          severity: finding.severity,
          description: finding.description.slice(0, 500),
          ...(finding.location ? { location: finding.location.slice(0, 200) } : {}),
          ...(finding.suggestion ? { suggestion: finding.suggestion.slice(0, 500) } : {}),
        })),
        elapsed: report.elapsed,
        requests: requestsJournal(),
        requestJournal: requestJournalStates(),
        outcomes: report.outcomes.map(({ request, ...rest }) => ({
          ...rest,
          requestRecord:
            requestRows.get(rest.domain)?.journal === 'durable'
              ? requestRows.get(rest.domain)!.id
              : null,
          requestState: request?.status ?? 'not-recorded',
          ...(request?.status === 'supplied' && request.served ? { served: request.served } : {}),
        })),
      });
      Object.assign(entry, {
        status: 'reported',
        finishedAt: Date.now(),
        domainsChecked: report.domainsChecked,
        outcomes: report.outcomes,
        failed: report.failed,
        findings: report.findings.length,
        critical: report.critical.length,
        elapsed: report.elapsed,
        journal: { requests: requestJournalStates(), outcome: outcomeJournal },
      });
      if (report.critical.length > 0) {
        this._warn(
          `  [flow:${this.thread.id}] CRITICAL findings (${report.domainsChecked.join(', ')}):`,
        );
        for (const f of report.critical) {
          this._warn(`    ⚠ ${f.description}${f.location ? ` at ${f.location}` : ''}`);
        }
      } else if (report.findings.length > 0) {
        this._log(
          `  [flow:${this.thread.id}] guard: ${report.findings.length} advisory findings from ${report.domainsChecked.join(', ')} over ${activity.observations.length} call(s) (${report.elapsed}ms)`,
        );
      }
    } catch (err) {
      const error = String((err as Error)?.message ?? err).slice(0, 200);
      const outcomeJournal = journalOutcome({
        observation,
        wraps,
        activity: { turnId, calls },
        correlation,
        status: 'failed',
        finishedAt: Date.now(),
        error,
        requests: requestsJournal(),
        requestJournal: requestJournalStates(),
        outcomes: [],
      });
      Object.assign(entry, {
        status: 'failed',
        finishedAt: Date.now(),
        error,
        journal: { requests: requestJournalStates(), outcome: outcomeJournal },
      });
      this._warn(`  [flow:${this.thread.id}] post-action failed: ${(err as Error).message}`);
    }
  }

  /**
   * The subagent-spawn trigger: the roster briefs a handoff the agent made. Every Warden's decision
   * is journalled on the parent node as an `advice` row wrapping the handoff (silence included, so
   * the silence rate is measurable), and what they said is queued as "chimed in on the handoff"
   * notes for the parent's next turn: no push path reaches the running turn, and the harness has
   * already composed what the subagent received.
   */
  private async _briefHandoff(
    signalId: string,
    handoff: HandoffMoment & {
      parent?: { id: string; meta: ThreadMeta };
      parentTurnId?: string | null;
    },
  ): Promise<void> {
    if (this._disposed) return;
    const flow = this.flowOrchestrator;
    // The parent's node: the thread itself, or the observed subagent that issued the spawn.
    const node =
      handoff.parent && handoff.parent.id !== this.thread.id ? handoff.parent : undefined;
    const turnId = handoff.parentTurnId ?? null;
    const moment: HandoffMoment = {
      childThreadId: handoff.childThreadId,
      handoffId: handoff.handoffId,
      ...(handoff.description ? { description: handoff.description } : {}),
      ...(handoff.agentType ? { agentType: handoff.agentType } : {}),
      prompt: handoff.prompt ?? '',
    };
    let report: Awaited<ReturnType<FlowOrchestrator['brief']>>;
    try {
      report = await flow.brief(moment);
    } catch (error) {
      this._warn(
        `  [flow:${this.thread.id}] handoff brief failed: ${(error as Error)?.message ?? error}`,
      );
      return;
    }
    if (this._disposed) return;
    try {
      this._journalPhase({
        ...(node ? { node } : {}),
        id: newId('phase'),
        turnId,
        dispatchId: null,
        phase: 'advice',
        record: {
          trigger: 'subagent-spawn' satisfies TriggerPoint,
          charter: this._charter.version,
          wraps: handoff.handoffId,
          handoff: {
            childThreadId: handoff.childThreadId,
            handoffId: handoff.handoffId,
            signalId,
            ...(handoff.description ? { description: handoff.description } : {}),
            ...(handoff.agentType ? { agentType: handoff.agentType } : {}),
          },
          inputHash: report.input.hash,
          sealedAt: report.sealedAt,
          participants: report.contributions
            .filter((c) => c.decision !== 'skipped')
            .map((c) => ({
              domain: c.domain,
              decision: c.decision,
              ...(c.reason ? { reason: c.reason } : {}),
              snippets: c.snippets,
              segments: c.segments,
              request: c.request,
              threadKnowledgeRevision: c.provenance.threadKnowledgeRevision,
              cacheHash: c.provenance.cacheHash,
            })),
          ...(report.prefilter ? { prefilter: report.prefilter } : {}),
          prefiltered: report.contributions
            .filter((c) => c.prefilter)
            .map((c) => ({ domain: c.domain, ...c.prefilter })),
          skipped: Object.fromEntries(
            Object.entries(
              Object.groupBy(
                report.contributions.filter((c) => c.decision === 'skipped'),
                (c) => c.reason ?? 'skipped',
              ),
            ).map(([reason, list]) => [reason, (list ?? []).map((c) => c.domain)]),
          ),
          elapsed: report.elapsed,
        },
      });
    } catch (error) {
      this._warn(
        `  [flow:${this.thread.id}] handoff brief journal failed: ${(error as Error)?.message ?? error}`,
      );
    }
    const notes = briefNotes(moment, report);
    if (notes.length) {
      flow.queueNotes(notes);
      this._log(
        `  [flow:${this.thread.id}] handoff brief: ${notes.map((n) => n.source).join(', ')} chimed in on ${handoff.handoffId} (${report.elapsed}ms)`,
      );
    }
  }

  /**
   * Correlate one tool observation to the dispatch that produced it. Identity
   * comes only from the signal itself (thread + dispatch id) and only a
   * dispatch that is live right now can receive evidence; nothing is inferred
   * from what this thread happens to be doing. Every external field is
   * bounded at this boundary with truncation provenance, an absent outcome
   * stays unknown, malformed numbers are zeroed and flagged, duplicate calls
   * keep their first report, buckets are bounded, and unmatched observations
   * stay visible with the reason they did not correlate.
   */
  private _recordToolObservation(signal: Signal): void {
    const c = signal.content as Record<string, unknown> | undefined;
    if (!c || typeof c.tool !== 'string' || !c.tool) return;

    const truncated: { input?: number; output?: number; error?: number } = {};
    const malformed: string[] = [];
    const bound = (field: 'input' | 'output' | 'error', value: string): string => {
      if (value.length <= MAX_EXTERNAL_FIELD) return value;
      truncated[field] = value.length;
      // The marker fits inside the bound, so the stored field never exceeds it.
      const marker = `… [truncated; original ${value.length} chars]`;
      return `${value.slice(0, MAX_EXTERNAL_FIELD - marker.length)}${marker}`;
    };
    let rawInput: string;
    if (typeof c.inputSummary === 'string') rawInput = c.inputSummary;
    else if (c.input === undefined) rawInput = '';
    else {
      try {
        rawInput = typeof c.input === 'string' ? c.input : (JSON.stringify(c.input) ?? '');
      } catch {
        rawInput = '[unserializable input]';
      }
    }
    const finite = (field: 'durationMs' | 'sequence'): number => {
      const v = c[field];
      if (v === undefined) return 0;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        malformed.push(field);
        return 0;
      }
      return v;
    };
    const id = (field: 'threadId' | 'dispatchId' | 'agentId' | 'callId'): string | undefined => {
      const v = c[field];
      if (v === undefined) return undefined;
      if (typeof v !== 'string' || !v) {
        malformed.push(field);
        return undefined;
      }
      return v;
    };
    const ok = typeof c.ok === 'boolean' ? c.ok : undefined;
    if (c.ok !== undefined && ok === undefined) malformed.push('ok');
    const durationMs = finite('durationMs');
    const sequence = finite('sequence');
    const threadId = id('threadId');
    const dispatchId = id('dispatchId');
    const agentId = id('agentId');
    const callId = id('callId') ?? signal.id;
    const inputSummary = bound('input', rawInput);
    const outputSummary =
      typeof c.outputSummary === 'string' ? bound('output', c.outputSummary) : undefined;
    const error = typeof c.error === 'string' ? bound('error', c.error) : undefined;
    if (c.truncated && typeof c.truncated === 'object') {
      for (const [k, v] of Object.entries(c.truncated as Record<string, unknown>)) {
        if (
          (k === 'input' || k === 'output' || k === 'error') &&
          typeof v === 'number' &&
          Number.isFinite(v) &&
          truncated[k] === undefined
        )
          truncated[k] = v;
      }
    }

    const base = {
      signalId: signal.id,
      callId,
      tool: c.tool,
      inputSummary,
      ...(ok !== undefined ? { ok } : {}),
      ...(outputSummary !== undefined ? { outputSummary } : {}),
      ...(error !== undefined ? { error } : {}),
      durationMs,
      sequence,
      ...(Object.keys(truncated).length ? { truncated } : {}),
      ...(malformed.length ? { malformed } : {}),
      ...(threadId ? { threadId } : {}),
      ...(dispatchId ? { dispatchId } : {}),
      ...(agentId ? { agentId } : {}),
    };

    let reason: string | undefined;
    if (!dispatchId) reason = 'no dispatch id';
    else if (threadId !== this.thread.id)
      reason = `thread "${threadId ?? 'none'}" is not this thread`;
    else if (!this._liveDispatches.has(dispatchId)) reason = `no live dispatch "${dispatchId}"`;
    if (reason) {
      this._uncorrelatedTools.push({ ...base, reason });
      if (this._uncorrelatedTools.length > MAX_UNCORRELATED_TOOLS)
        this._uncorrelatedTools.splice(0, this._uncorrelatedTools.length - MAX_UNCORRELATED_TOOLS);
      return;
    }

    let bucket = this._toolsByDispatch.get(dispatchId!);
    if (!bucket) {
      bucket = new Map();
      this._toolsByDispatch.set(dispatchId!, bucket);
      if (this._toolsByDispatch.size > MAX_TOOL_BUCKETS) {
        const oldest = this._toolsByDispatch.keys().next().value;
        if (oldest !== undefined) this._toolsByDispatch.delete(oldest);
      }
    }
    if (bucket.has(callId)) return; // same call reported twice: keep the first
    if (bucket.size >= MAX_TOOLS_PER_DISPATCH) return; // bounded per dispatch
    bucket.set(callId, base);
  }

  /** Waits for eligible review processing, or an irreversible closed lease. Unknown calls may still run. */
  async learningSettled(): Promise<void> {
    // Reviews enqueue asynchronously from signal handlers; loop until every queue is stable.
    for (;;) {
      const heads = [...this._learningQueues.values()];
      await Promise.all(
        [...this._learningQueues].map(([domain, head]) =>
          Promise.race([
            head,
            // Yield once for already delivered settlement callbacks. Closed/unknown
            // work still returns without waiting for a model or its hard deadline.
            this._closedReviews
              .get(domain)!
              .promise.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))),
          ]),
        ),
      );
      const same =
        [...this._learningQueues.values()].every((p, i) => p === heads[i]) &&
        heads.length === this._learningQueues.size;
      if (same) return;
    }
  }

  /** Compatibility-shaped observation only: never waits for a model result. */
  private async _awaitPendingLearning(): Promise<NonNullable<DeliveryRecord['learningBarrier']>> {
    const closed = [...this._closedReviews]
      .filter(([, lease]) => lease.closed)
      .map(([domain, lease]) => ({ domain, reason: lease.reason ?? 'review admission closed' }));
    const pending = [...this.domainLibrarians.keys()]
      .filter((domain) => !this._closedReviews.get(domain)?.closed)
      .map(
        (domain) =>
          [
            domain,
            (this._queuedEvidence.get(domain)?.length ?? 0) +
              (['pending', 'delayed'].includes(this._reviewStates.get(domain)?.status ?? '')
                ? 1
                : 0),
          ] as const,
      )
      .filter(([, reviews]) => reviews > 0)
      .map(([domain, reviews]) => ({ domain, reviews }));
    return {
      outcome: pending.length ? 'pending' : closed.length ? 'closed' : 'none',
      waitedMs: 0,
      pending,
      closed,
      stale: [...pending.map((p) => p.domain), ...closed.map((p) => p.domain)],
    };
  }

  get learningState(): LearningState {
    return structuredClone({
      domains: Object.fromEntries(
        [...this.domainLibrarians.keys()].map((domain) => [
          domain,
          {
            ...this._reviewStates.get(domain),
            status:
              this._reviewStates.get(domain)?.status ??
              (this._closedReviews.get(domain)?.closed ? 'closed' : 'idle'),
            closed: this._closedReviews.get(domain)?.closed ?? false,
            phase: {
              providerId: this.domainLibrarians.get(domain)!.reviewProviderId,
              requestedModel: this.domainLibrarians.get(domain)!.reviewOptions.model,
              modelSelection: this.domainLibrarians.get(domain)!.reviewOptions.model
                ? 'explicit'
                : 'provider-default',
              executionKind: this.domainLibrarians.get(domain)!.reviewExecutionKind,
              lifecycleEvidence: this.domainLibrarians.get(domain)!.reviewExecutionKind
                ? 'available'
                : 'unavailable',
            },
            queued: this._queuedEvidence.get(domain)?.length ?? 0,
            queuedEvidence: (this._queuedEvidence.get(domain) ?? []).map((input) => input.evidence),
          },
        ]),
      ),
    });
  }

  restoreReviewClosure(domain: string, reason: string, retained?: LearningRecord): void {
    if (!this.domainLibrarians.has(domain))
      throw Error(`Stored review domain requires migration: ${domain}`);
    if (retained?.job) {
      const job = retained.job;
      if (
        job.threadId !== this.thread.id ||
        job.projectId !== this.thread.meta.projectId ||
        job.domain !== domain
      )
        throw Error('Stored review job owner mismatch');
      // Historical generation is evidence, never a live inspection/commit authority.
      this._reviewStates.set(domain, {
        status: 'closed',
        job: freezeOwned(structuredClone(job)),
        localSettled: false,
        native: retained.native && freezeOwned(structuredClone(retained.native)),
        nativeOutcome: retained.native?.nativeOutcome ?? 'unknown',
        capacity: retained.capacity ?? 'unknown',
        cleanup: retained.cleanup,
        deadlineAt: 0,
      });
    }
    this._reviewLease(domain, false);
    this._closeReview(domain, reason);
  }

  reconcileReviewCapacity(domain: string): boolean {
    const state = this._reviewStates.get(domain);
    if (
      this._disposed ||
      !state?.localSettled ||
      state.capacity !== 'settled' ||
      state.status !== 'expired' ||
      this._learningQueues.has(domain) ||
      !this._closedReviews.get(domain)?.closed
    )
      return false;
    // Reopening capacity cannot change this expired job's deadline, identity or outcome.
    // No queued payload survives closure, and nothing is sent here.
    let close!: () => void;
    const promise = new Promise<void>((resolve) => {
      close = resolve;
    });
    this._closedReviews.set(domain, { promise, close, closed: false });
    void this._emitLearning(
      domain,
      this.domainLibrarians.get(domain)!.threadKnowledge.record({
        decision: 'capacity-settled',
        evidence: state.job.evidence,
        job: state.job,
        capacity: 'settled',
        author: 'runtime',
        reason:
          'explicit reconciliation of observed settlement; expired work and deferred evidence were not replayed',
      }),
    );
    return !this._disposed;
  }

  async reconcileNativeReview(domain: string, jobId: string): Promise<boolean> {
    const retained = this._nativeReconcilers.get(domain);
    if (!retained || retained.job.id !== jobId) return false;
    return retained.inspect();
  }

  private _closeReview(domain: string, reason: string): void {
    const lease = this._closedReviews.get(domain)!;
    lease.closed = true;
    lease.reason = reason;
    lease.close();
    // Release payloads, but first retain every evidence link through the journal.
    for (const input of this._queuedEvidence.get(domain)?.splice(0) ?? [])
      this._deferReview(domain, input, reason);
  }

  private _deferReview(domain: string, input: ReviewInput, reason: string): void {
    const record = this.domainLibrarians.get(domain)!.threadKnowledge.record({
      decision: 'deferred',
      reason,
      evidence: input.evidence,
      owner: input.owner,
      generation: input.generation,
      author: 'runtime',
    });
    void this._emitLearning(domain, record);
  }

  reviewEligible(job: ReviewJob): boolean {
    const current = this._reviewStates.get(job.domain)?.job;
    const knowledge = this.domainLibrarians.get(job.domain)?.threadKnowledge;
    return (
      !this._disposed &&
      current === job &&
      job.generation === this.generation &&
      job.epoch === this._epoch &&
      job.threadId === this.thread.id &&
      job.projectId === this.thread.meta.projectId &&
      !this._closedReviews.get(job.domain)?.closed &&
      this._clock() < (this._reviewStates.get(job.domain)?.deadlineAt ?? 0) &&
      knowledge?.revision === job.base.revision &&
      knowledge.hash === job.base.hash
    );
  }

  private _owner(): { threadId: string; projectId?: string } {
    return {
      threadId: this.thread.id,
      ...(this.thread.meta.projectId ? { projectId: this.thread.meta.projectId } : {}),
    };
  }

  knowledgeSnapshot(): ThreadKnowledgeBundle {
    const owner = this._owner();
    const domains: Record<string, ThreadKnowledgeSnapshot> = {};
    for (const [domain, lib] of this.domainLibrarians) {
      domains[domain] = lib.threadKnowledge.snapshot(owner);
    }
    return { ...owner, capturedAt: Date.now(), domains };
  }

  /**
   * Restore every domain's thread knowledge. Ownership is checked on the
   * bundle and on every child snapshot; shape is validated for every child;
   * nothing is applied unless all of it is valid.
   */
  restoreKnowledge(bundle: ThreadKnowledgeBundle): void {
    if (this._disposed) throw new Error(`Runtime for thread "${this.thread.id}" is disposed`);
    const owner = this._owner();
    if (!bundle || typeof bundle !== 'object')
      throw new Error('Knowledge bundle must be an object');
    if (bundle.threadId !== owner.threadId) {
      throw new Error(
        `Knowledge bundle is for thread "${bundle.threadId}", not "${owner.threadId}"`,
      );
    }
    if ((bundle.projectId ?? undefined) !== (owner.projectId ?? undefined)) {
      throw new Error(
        `Knowledge bundle is owned by project "${bundle.projectId}", not "${owner.projectId}"`,
      );
    }
    if (typeof bundle.capturedAt !== 'number' || !Number.isFinite(bundle.capturedAt)) {
      throw new Error(
        `Knowledge bundle capturedAt must be a finite number, got ${bundle.capturedAt}`,
      );
    }
    const entries = Object.entries(bundle.domains ?? {});
    for (const [domain, snapshot] of entries) {
      const lib = this.domainLibrarians.get(domain);
      if (!lib) throw new Error(`Knowledge bundle names unknown domain "${domain}"`);
      lib.threadKnowledge.validate(snapshot, owner);
    }
    this._epoch += 1;
    for (const [domain, snapshot] of entries) {
      const record = this.domainLibrarians
        .get(domain)!
        .threadKnowledge.restore(snapshot, `bundle:${bundle.capturedAt}`, owner);
      void this._emitLearning(domain, record);
    }
    this._schedulePrestart();
  }

  /** Route one completed executor observation to every domain reviewer, exactly once. */
  private _onCompletedWork(signalId: string, observation: DispatchObservation): void {
    if (this._disposed) return;
    if (observation.threadId && observation.threadId !== this.thread.id) {
      for (const lib of this.domainLibrarians.values())
        lib.threadKnowledge.record({
          decision: 'foreign',
          author: 'runtime',
          reason: 'dispatch names another thread; private payload was not admitted',
          evidence: { kind: 'signal', id: signalId, timestamp: Date.now() },
        });
      return;
    }
    if (this._reviewed.has(signalId)) return;
    this._reviewed.add(signalId);
    if (this._reviewed.size > MAX_REVIEWED_IDS) {
      const oldest = this._reviewed.values().next().value;
      if (oldest !== undefined) this._reviewed.delete(oldest);
    }

    const evidence: KnowledgeEvidence = {
      kind: 'dispatch',
      id: signalId,
      agentId: observation.agentId,
      ...(observation.messageId ? { messageId: observation.messageId } : {}),
      ok: observation.ok,
      timestamp: Date.now(),
    };
    // Only this dispatch's own tool calls, in call order. A failed dispatch
    // drops its bucket: its evidence is never handed to a later completion.
    const bucket = observation.dispatchId
      ? this._toolsByDispatch.get(observation.dispatchId)
      : undefined;
    if (observation.dispatchId) this._toolsByDispatch.delete(observation.dispatchId);
    const toolObservations = bucket
      ? [...bucket.values()]
          .sort((a, b) => a.sequence - b.sequence)
          .map((t) => ({
            tool: t.tool,
            callId: t.callId,
            dispatchId: t.dispatchId,
            input: t.inputSummary,
            ...(t.ok !== undefined ? { ok: t.ok } : {}),
            ...(t.outputSummary !== undefined ? { output: t.outputSummary } : {}),
            ...(t.error !== undefined ? { error: t.error } : {}),
            ...(t.truncated ? { truncated: t.truncated } : {}),
          }))
      : [];

    if (!observation.ok) {
      // Failed work is evidence of failure only. Nothing it produced is promoted.
      for (const [domain, lib] of this.domainLibrarians) {
        const record = lib.threadKnowledge.record({
          decision: 'rejected',
          reason: `failed work is not promoted: ${observation.error ?? 'unknown error'}`,
          evidence,
          author: 'runtime',
        });
        void this._emitLearning(domain, record);
      }
      return;
    }

    const input: ReviewInput = freezeOwned({
      owner: this._owner(),
      generation: this.generation,
      epoch: this._epoch,
      evidence,
      agentId: observation.agentId,
      ...(observation.messageId ? { messageId: observation.messageId } : {}),
      userMessage: observation.payload.slice(0, 1000),
      output: (observation.output ?? '').slice(0, 2000),
      truncated: {
        userMessage: Math.max(0, observation.payload.length - 1000),
        output: Math.max(0, (observation.output?.length ?? 0) - 2000),
      },
      ok: true,
      toolObservations,
    });
    // The post-turn trigger: one pre-filter call over the finished work, before any review runs.
    this._reviewPrefilter.set(
      input,
      this.flowOrchestrator
        .prefilter(
          'post-turn',
          [
            input.userMessage,
            input.output,
            toolObservations.map((t) => `${t.tool}: ${JSON.stringify(t.input)}`).join('\n'),
          ]
            .filter(Boolean)
            .join('\n\n'),
          undefined,
          [...this.domainLibrarians.values()].filter((lib) => lib.cache.content),
        )
        .catch(() => undefined),
    );
    for (const [domain, lib] of this.domainLibrarians) {
      const lease = this._closedReviews.get(domain)!;
      if (lease.closed) {
        this._deferReview(
          domain,
          input,
          lease.reason ?? 'review admission closed; explicit capacity reconciliation required',
        );
        continue;
      }
      const queued = this._queuedEvidence.get(domain) ?? [];
      if (queued.length >= MAX_QUEUED_REVIEWS) {
        this._deferReview(
          domain,
          input,
          'hot review queue is full; completed turn evidence remains in the journal',
        );
        continue;
      }
      queued.push(input);
      this._queuedEvidence.set(domain, queued);
      if (this._learningQueues.has(domain)) continue;
      const next = Promise.resolve()
        .then(async () => {
          while (!this._closedReviews.get(domain)!.closed && !this._disposed) {
            const nextInput = this._queuedEvidence.get(domain)?.shift();
            if (!nextInput) break;
            await this._reviewWith(domain, lib, nextInput);
          }
        })
        .catch((err) => {
          this._closeReview(domain, `review infrastructure failed: ${String(err).slice(0, 500)}`);
        })
        .finally(() => {
          this._learningQueues.delete(domain);
          if (this._reviewStates.get(domain)?.capacity === 'settled')
            void this._releaseReview(domain, lib);
        });
      this._learningQueues.set(domain, next);
    }
  }

  private async _reviewWith(
    domain: string,
    lib: DomainLibrarian,
    input: ReviewInput,
  ): Promise<void> {
    const knowledge = lib.threadKnowledge;
    const author = `${domain}-reviewer`;
    if (this._disposed) {
      void this._emitLearning(
        domain,
        knowledge.record({
          decision: 'discarded',
          reason: 'runtime disposed before review started',
          evidence: input.evidence,
          author,
        }),
      );
      return;
    }
    if (
      input.owner?.threadId !== this.thread.id ||
      input.owner.projectId !== this.thread.meta.projectId
    ) {
      knowledge.record({
        decision: 'foreign',
        reason: 'queued evidence belongs to a previous owner',
        evidence: input.evidence,
        author,
      });
      return; // Never emit the previous owner's evidence through the new owner's persistence sinks.
    }
    if (input.generation !== this.generation || input.epoch !== this._epoch) {
      await this._emitLearning(
        domain,
        knowledge.record({
          decision: 'stale',
          reason: 'queued evidence owner or runtime generation changed',
          evidence: input.evidence,
          author,
        }),
      );
      return;
    }

    const lease = this._closedReviews.get(domain)!;
    if (lease.closed) {
      this._deferReview(domain, input, lease.reason ?? 'review admission closed');
      return;
    }
    // Ruled out by the pre-filter: no review call, one journalled record with the score.
    const skip = prefilterSkip(await this._reviewPrefilter.get(input), domain);
    if (skip) {
      await this._emitLearning(
        domain,
        knowledge.record({
          decision: 'prefiltered',
          reason: `pre-filter score ${skip.score.toFixed(3)} < ${skip.skipBelow}`,
          evidence: input.evidence,
          author,
        }),
      );
      return;
    }
    // A composition over the role's budget is a configuration error, reported per review; the lane
    // stays open so a settings change (a raised budget, an opt-out) takes effect on the next one.
    const segments = lib.reviewContext();
    // Captured with the segments: what they are composed of (journalled as version ids).
    const composition = lib.composition('review');
    const over = lib.budgetError(segments.instructions, segments.domainKnowledge);
    if (over) {
      await this._emitLearning(
        domain,
        knowledge.record({ decision: 'error', reason: over, evidence: input.evidence, author }),
      );
      return;
    }
    const admittedAt = Date.now();
    const job: ReviewJob = freezeOwned({
      id: newId('review'),
      domain,
      ...this._owner(),
      generation: this.generation,
      epoch: this._epoch,
      evidence: structuredClone(input.evidence),
      base: knowledge.snapshot(this._owner()),
      admittedAt,
      eligibleUntil: admittedAt + this._hardTimeoutMs,
      segments,
      requested: lib.reviewOptions,
      providerId: lib.reviewProviderId,
      budgets: {
        maxKnowledgeChars: knowledge.maxChars,
        maxResponseChars: 20_000,
        nativeTokens: ['claude-code', 'codex'].includes(lib.reviewProviderId)
          ? 'requested-unenforced'
          : 'requested-unverified',
        nativeEffort:
          lib.reviewOptions.thinking === undefined
            ? 'not-requested'
            : ['claude-code', 'codex'].includes(lib.reviewProviderId)
              ? 'requested-unenforced'
              : 'requested-unverified',
      },
    });
    const state: ReviewState = {
      status: 'pending',
      job,
      localSettled: false,
      nativeOutcome: 'unknown',
      capacity: 'unknown',
      deadlineAt: this._clock() + this._hardTimeoutMs,
      persistence: undefined as string | undefined,
      settledAt: undefined as number | undefined,
      committedAt: undefined as number | undefined,
      requestJournal: undefined as 'durable' | 'absent' | 'failed' | undefined,
    };
    this._reviewStates.set(domain, state);
    if (!this._reviewLease(domain, false)) {
      state.status = 'blocked-previous-occupancy';
      state.localSettled = true;
      this._closeReview(domain, 'previous runtime still owns unresolved review capacity');
      this._deferReview(
        domain,
        input,
        'previous runtime still owns unresolved review capacity; not admitted',
      );
      return;
    }
    this._queuedEvidence.set(
      domain,
      (this._queuedEvidence.get(domain) ?? []).filter((queued) => queued !== input),
    );
    // The exact review request, observed once at the reviewer's call boundary by this job's own closure.
    // Every record of this job carries it (or the fact that no call was made); a late answer cannot change it.
    let reviewRequest: PhaseRequestEvidence | undefined;
    const request = (): ParticipantRequest =>
      reviewRequest
        ? {
            status: 'supplied',
            phase: reviewRequest.phase,
            providerId: reviewRequest.providerId,
            messages: reviewRequest.messages,
            capturedAt: reviewRequest.capturedAt,
            ...(reviewRequest.composition ? { composition: reviewRequest.composition } : {}),
          }
        : { status: 'not-sent', phase: 'review', reason: 'review call not started' };
    const record = (
      decision: LearningRecord['decision'],
      reason?: string,
      persistence?: LearningRecord['persistence'],
    ) =>
      knowledge.record({
        decision,
        reason,
        evidence: job.evidence,
        author,
        job,
        persistence,
        capacity: state.capacity,
        native: state.native,
        cleanup: state.cleanup,
        eligibility: lease.closed ? 'closed' : 'open',
        localError: state.localError,
        request: request(),
        ...(state.requestJournal ? { requestJournal: state.requestJournal } : {}),
      });
    const expire = () => {
      if (lease.closed) return;
      // Irreversible before emitting signals or awaiting any observer.
      if (!state.committedAt) state.status = 'expired';
      this._closeReview(domain, 'hard eligibility expired; capacity reconciliation required');
      void this._emitLearning(
        domain,
        record('expired', 'hard eligibility deadline; native occupancy remains owned'),
      );
    };
    const soft = setTimeout(() => {
      if (lease.closed || state.capacity === 'settled') return;
      state.status = 'delayed';
      void this._emitLearning(
        domain,
        record('delayed', 'soft observation expired; review remains eligible and owned'),
      );
    }, this._learningTimeoutMs);
    const hard = setTimeout(expire, this._hardTimeoutMs);
    this._learningOutstanding += 1;
    let outstanding = true,
      registered: NativeEvidence | undefined,
      retained: NativeEvidence | undefined;
    let inspecting: Promise<boolean> | undefined,
      finished = false,
      settledAudited = false;
    let nativeReady!: (result: ReviewResult) => void;
    const nativeResult = new Promise<ReviewResult>((resolve) => {
      nativeReady = resolve;
    });
    const settleOutstanding = () => {
      if (outstanding) {
        outstanding = false;
        this._learningOutstanding -= 1;
      }
    };
    const auditNative = (native: NativeEvidence) => {
      const { content, text, toolInput, toolOutput, ...facts } = native;
      if (JSON.stringify(state.native) === JSON.stringify(facts)) return;
      state.native = freezeOwned(facts);
      state.nativeOutcome = native.nativeOutcome;
      state.localOutcome = native.localOutcome;
      state.rpcOutcome = native.rpcOutcome;
      state.transportOutcome = native.transportOutcome;
      if (job.threadId !== this.thread.id || job.projectId !== this.thread.meta.projectId) return;
      this._journalLearning(
        freezeOwned(
          this._learningSignal(domain, {
            ...record('native-evidence'),
            reason: `Public review payload omitted: content ${content?.length ?? 0}, text ${text?.length ?? 0}, tool output ${toolOutput?.length ?? 0} chars.`,
            owner: { threadId: job.threadId, projectId: job.projectId },
            generation: job.generation,
            native: facts,
          }),
        ),
      );
    };
    const inspect = (): Promise<boolean> => {
      if (inspecting) return inspecting;
      inspecting = (async () => {
        if (!registered?.admissionId || !registered.owner || !lib.canInspectReview) return false;
        const snapshot = await lib.inspectReview(registered.owner, registered.admissionId);
        if (
          !snapshot ||
          snapshot.evidence.admissionId !== registered.admissionId ||
          !sameNativeOwner(snapshot.evidence.owner, registered.owner)
        )
          return false;
        // The provider reads its original pool entry. Current request/owner never supplies a join.
        retained = snapshot.evidence;
        state.capacity = snapshot.capacity;
        auditNative(retained);
        if (retained.nativeOutcome === 'completed')
          nativeReady({
            ...lib.parseReviewAnswer(retained.content),
            admission: 'attempted',
            capacity: state.capacity,
          });
        else if (retained.nativeOutcome === 'failed')
          nativeReady({
            decision: 'error',
            facts: [],
            admission: 'attempted',
            capacity: state.capacity,
            reason: `Native review failed: ${retained.terminal?.reason ?? retained.terminal?.subtype ?? 'confirmed failure'}`,
          });
        if (state.localSettled && state.capacity === 'settled') {
          settleOutstanding();
          if (finished && !settledAudited) {
            settledAudited = true;
            void this._emitLearning(
              domain,
              record(
                'capacity-settled',
                'exact native admission and RPC settled; closed eligibility and deferred evidence remain closed',
              ),
            );
            await this._releaseReview(domain, lib, state);
          }
        }
        return true;
      })()
        .catch((error) => {
          state.localError ??= `Native inspection unavailable: ${String(error).slice(0, 500)}`;
          return false;
        })
        .finally(() => {
          inspecting = undefined;
        });
      return inspecting;
    };
    this._nativeReconcilers.set(domain, { job, inspect });
    const localFinished = (result: ReviewResult) => {
      state.localSettled = true;
      state.settledAt = Date.now();
      if (result.decision === 'error') {
        state.localError = result.reason;
        if (registered)
          void this._emitLearning(
            domain,
            record(
              'native-evidence',
              'original local review observation error retained separately from native outcome',
            ),
          );
      }
      if (registered) void inspect();
      return result;
    };
    let outcome: ReviewResult;
    try {
      const local = lib
        .review(
          freezeOwned(structuredClone(input)),
          job,
          {
            owner: freezeOwned({
              threadId: this.thread.id,
              projectId: this.thread.meta.projectId,
              generation: job.generation,
              messageId: job.evidence.messageId,
              dispatchId: job.evidence.id,
              reviewJobId: job.id,
            }),
            register: (native) => {
              if (lease.closed || !this.reviewEligible(job) || this._clock() >= state.deadlineAt)
                throw Error('Review eligibility closed before native write; not admitted');
              const expected = {
                threadId: job.threadId,
                projectId: job.projectId,
                generation: job.generation,
                messageId: job.evidence.messageId,
                dispatchId: job.evidence.id,
                reviewJobId: job.id,
                providerSessionKey: auxiliarySessionId(
                  job.threadId,
                  `review:${job.generation}:domain:${domain}`,
                ),
              };
              if (!native.admissionId || registered || !sameNativeOwner(native.owner, expected))
                throw Error('Foreign or duplicate native review registration; not admitted');
              if (
                !this._journalLearning(
                  freezeOwned(
                    this._learningSignal(domain, {
                      ...record('native-admission'),
                      owner: { threadId: job.threadId, projectId: job.projectId },
                      generation: job.generation,
                      native,
                    }),
                  ),
                )
              )
                throw Error('Native review requires a durable ownership journal; not admitted');
              registered = freezeOwned(native);
              state.native = registered;
            },
            observe: (native) => {
              if (
                !registered ||
                native.admissionId !== registered.admissionId ||
                !sameNativeOwner(native.owner, registered.owner)
              )
                return;
              auditNative(native);
              // Inspection happens after the producer callback; it cannot veto native completion.
              void Promise.resolve().then(inspect);
            },
          },
          {
            composition,
            observeRequest: (evidence) => {
              reviewRequest = evidence;
              // Durable before the answer or any deadline: the exact request under the job's own identity. This
              // record carries no capacity or native claim, so restoration never reads it as closure evidence.
              // Journal-only: it is not a learning outcome, so it never enters the expert's in-memory history, and a
              // failing journal makes the request status explicit instead of breaking the review.
              const requested: LearningRecord = {
                decision: 'requested',
                reason: 'review request supplied to the provider; answer pending',
                evidence: job.evidence,
                author,
                job,
                eligibility: lease.closed ? 'closed' : 'open',
                request: request(),
                at: Date.now(),
                owner: { threadId: job.threadId, projectId: job.projectId },
                generation: job.generation,
              };
              // Absent optional persistence is recorded and the review proceeds; a configured journal that refuses the
              // supplied input keeps its original failure and refuses admission: no provider is called for this job.
              try {
                state.requestJournal = this._journalLearning(
                  freezeOwned(this._learningSignal(domain, requested)),
                )
                  ? 'durable'
                  : 'absent';
              } catch (error) {
                state.requestJournal = 'failed';
                throw Object.assign(
                  new Error(
                    `review request journal failed; not admitted: ${(error as Error)?.message ?? error}`,
                  ),
                  { admission: 'not-admitted', cause: error },
                );
              }
            },
          },
        )
        .then(localFinished, (error) =>
          localFinished({
            decision: 'error',
            facts: [],
            reason: String(error).slice(0, 1000),
            ...((error as { admission?: unknown })?.admission === 'not-admitted'
              ? { admission: 'not-admitted' as const, capacity: 'settled' as const }
              : {}),
          }),
        );
      // Native completion and the local/RPC waiter are independent observations.
      // Both are retained, but only this one continuation can promote a candidate.
      outcome = await Promise.race([local, nativeResult]);
    } catch (error) {
      outcome = localFinished({
        decision: 'error',
        facts: [],
        reason: String(error).slice(0, 1000),
      });
    }
    // Capability and current observation availability are separate. A read miss
    // or transient exception cannot close an admitted job's bounded eligibility.
    const inspectable = !!registered && lib.canInspectReview;
    if (inspectable) {
      const observed = await inspect();
      // Older adapters can explicitly establish local settlement without an
      // inspectable attempt. Preserve that evidence; absence alone proves nothing.
      if (!observed && !retained && outcome.capacity === 'settled') state.capacity = 'settled';
      if (state.localError)
        void this._emitLearning(
          domain,
          record(
            'native-evidence',
            'local reviewer observation rejected; original error retained independently of native outcome',
          ),
        );
      // Only a bounded background observer waits. Central dispatch never awaits this loop.
      // After closure, events/explicit read-only inspection can reconcile capacity, never eligibility.
      while (
        !lease.closed &&
        this.reviewEligible(job) &&
        state.capacity === 'unknown' &&
        (!retained || retained.nativeOutcome === 'unknown')
      ) {
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, this._hardTimeoutMs))),
          lease.promise,
        ]);
        await inspect();
      }
      if (retained?.nativeOutcome === 'completed')
        outcome = {
          ...lib.parseReviewAnswer(retained.content),
          admission: 'attempted',
          capacity: state.capacity,
        };
      else if (retained?.nativeOutcome === 'failed')
        outcome = {
          decision: 'error',
          facts: [],
          admission: 'attempted',
          capacity: state.capacity,
          reason: `Native review failed: ${retained.terminal?.reason ?? retained.terminal?.subtype ?? 'confirmed failure'}`,
        };
    } else
      state.capacity = outcome.capacity ?? (outcome.decision === 'error' ? 'unknown' : 'settled');
    clearTimeout(soft);
    try {
      if (state.capacity === 'settled' || !inspectable) {
        settleOutstanding();
        settledAudited = true;
      }
      // Physical call occupancy is distinct from commit/publication eligibility.
      // Release with the original captured owner, including after disposal/restore.
      if (state.capacity === 'settled' && !inspectable) this._reviewLease(domain, true);
      if (this._clock() >= state.deadlineAt) expire();
      if (lease.closed) {
        await this._emitLearning(
          domain,
          record(
            this._disposed
              ? 'discarded'
              : state.capacity === 'settled'
                ? 'capacity-settled'
                : 'discarded',
            `${this._disposed ? 'runtime disposed; ' : ''}late local result retained; closed eligibility never reopens or drains deferred work`,
          ),
        );
        return;
      }
      if (!this.reviewEligible(job)) {
        state.status = this._disposed
          ? 'discarded'
          : job.projectId !== this.thread.meta.projectId
            ? 'foreign'
            : 'stale';
        if (inspectable)
          this._closeReview(
            domain,
            'original review owner/base is no longer eligible; deferred work cannot replay',
          );
        await this._emitLearning(
          domain,
          record(
            state.status as LearningRecord['decision'],
            'runtime disposed or owner/generation/base changed',
          ),
        );
        return;
      }
      if (outcome.decision !== 'learn') {
        if (outcome.admission === 'not-admitted' && outcome.decision === 'error') {
          state.status = 'deferred';
          this._closeReview(
            domain,
            `review was not admitted: ${outcome.reason ?? 'provider refused admission'}`,
          );
          await this._emitLearning(domain, {
            ...record(
              'deferred',
              `review was not admitted: ${outcome.reason ?? 'provider refused admission'}`,
            ),
            admission: 'not-admitted',
          });
          return;
        }
        state.status = outcome.decision;
        if (state.capacity === 'unknown' && !inspectable)
          this._closeReview(
            domain,
            'provider outcome does not establish available review capacity',
          );
        await this._emitLearning(domain, record(outcome.decision, outcome.reason));
        return;
      }
      const candidate = knowledge.candidate(
        outcome.knowledge!,
        job.evidence,
        author,
        this._owner(),
      );
      const learned: LearningRecord = {
        decision: 'learned',
        revision: candidate.revision,
        evidence: job.evidence,
        author,
        at: candidate.updatedAt,
        job,
        capacity: state.capacity,
        request: request(),
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
      };
      let persistence: 'durable' | 'memory' | 'stale' | 'duplicate';
      try {
        persistence = this._commitKnowledge(
          job,
          candidate,
          this._learningSignal(domain, learned, job.id),
        );
      } catch (error) {
        state.status = 'write-failed';
        state.persistence = 'failed';
        this._closeReview(domain, 'knowledge write failed; review admission quarantined');
        await this._emitLearning(
          domain,
          record('write-failed', String(error).slice(0, 1000), 'failed'),
        );
        return;
      }
      if (persistence === 'stale' || persistence === 'duplicate') {
        if (this._clock() >= state.deadlineAt) {
          expire();
          return;
        }
        state.status = persistence;
        await this._emitLearning(
          domain,
          record(persistence, 'journal compare-and-set did not promote candidate'),
        );
        return;
      }
      state.persistence = persistence;
      state.committedAt = Date.now();
      try {
        knowledge.publish(candidate, this._owner());
      } catch (error) {
        state.status = 'reconciliation-needed';
        this._closeReview(domain, 'durable knowledge needs publication reconciliation');
        // Critical reconciliation bypasses fallible signal observers. Durable state stays durable.
        const entry = record(
          'reconciliation-needed',
          `committed ${persistence}; publication failed: ${String(error).slice(0, 500)}`,
          'reconciliation-needed',
        );
        const notified = this._emitLearning(domain, entry); // journals synchronously before any observer await
        this._publicationFailure(job, error);
        void notified;
        return;
      }
      state.status = 'learned';
      // This Warden's understanding of the thread changed: its pre-started context follows.
      this._schedulePrestart();
      const entry = knowledge.record({ ...learned, persistence });
      if (state.capacity === 'unknown' && !inspectable)
        this._closeReview(domain, 'completed local result; native capacity remains unacknowledged');
      // The commit event already exists durably. Signals remain observers, never a commit ACK.
      await this._emitLearning(domain, entry, job.id);
    } finally {
      // A valid native candidate can commit while RPC remains occupied. The
      // original queue/lease still waits; commit never grants execution capacity.
      while (inspectable && state.capacity === 'unknown' && !lease.closed) {
        if (this._clock() >= state.deadlineAt) {
          expire();
          break;
        }
        if (job.epoch !== this._epoch || job.projectId !== this.thread.meta.projectId) {
          this._closeReview(domain, 'review owner/base changed while awaiting physical settlement');
          break;
        }
        await Promise.race([
          new Promise<void>((resolve) => setTimeout(resolve, Math.min(20, this._hardTimeoutMs))),
          lease.promise,
        ]);
        await inspect();
      }
      clearTimeout(hard);
      finished = true;
    }
  }

  private _learningSignal(domain: string, record: LearningRecord, id = newId('sig-learn')): Signal {
    return {
      id,
      kind: 'domain_learning',
      source: `${domain}-reviewer`,
      content: { domain, ...record },
      timestamp: record.at,
    };
  }

  private async _emitLearning(domain: string, record: LearningRecord, id?: string): Promise<void> {
    if (
      record.job &&
      (record.job.threadId !== this.thread.id ||
        record.job.projectId !== this.thread.meta.projectId)
    )
      return;
    if (
      record.owner &&
      (record.owner.threadId !== this.thread.id ||
        record.owner.projectId !== this.thread.meta.projectId)
    )
      return;
    const signal = freezeOwned(
      this._learningSignal(
        domain,
        {
          ...record,
          owner: record.owner ?? this.owner,
          generation: record.generation ?? this.generation,
        },
        id,
      ),
    );
    try {
      // Durable first. Observers cannot mutate or veto the owned audit record.
      this._journalLearning(signal);
      if (!this._disposed) await this.thread.signals.emit(signal);
    } catch (err) {
      console.warn(
        `[ThreadRuntime] learning signal failed for ${domain}:`,
        (err as Error).message ?? err,
      );
    }
  }

  private async _releaseReview(
    domain: string,
    lib: DomainLibrarian,
    state = this._reviewStates.get(domain),
  ): Promise<void> {
    if (!state || state.capacity !== 'settled' || state.cleanup) return;
    state.cleanup = 'releasing';
    const nativeOwned = !!state.native?.admissionId && lib.canInspectReview;
    const audit = () => {
      void this._emitLearning(
        domain,
        lib.threadKnowledge.record({
          decision: 'native-cleanup',
          job: state.job,
          evidence: state.job.evidence,
          author: 'runtime',
          native: state.native,
          cleanup: state.cleanup,
          capacity: state.cleanup === 'released' ? 'settled' : 'unknown',
          eligibility: this._closedReviews.get(domain)?.closed ? 'closed' : 'open',
          reason: `Original owned review cleanup: ${state.cleanup}; no admission or replay`,
        }),
      );
    };
    // A process cleanup lease survives reconstruction independently of a settled call.
    if (nativeOwned) {
      state.capacity = 'unknown';
      audit();
    }
    try {
      state.cleanup = await lib.releaseReviewIdle(state.native);
    } catch {
      state.cleanup = 'failed';
    }
    if (nativeOwned) {
      state.capacity = state.cleanup === 'released' ? 'settled' : 'unknown';
      audit();
    }
    if (state.cleanup === 'released' && this._reviewStates.get(domain) === state)
      this._reviewLease(domain, true);
  }

  /** Subscribe a sink to this thread's bus; every signal is attributed to this thread. */
  addSink(handler: SignalSink): () => void {
    if (this._disposed) return () => {};
    const thread = this.thread;
    const unsub = thread.signals.onAny((signal) =>
      handler(signal, normalizeScope({ threadId: thread.id, projectId: thread.meta.projectId })),
    );
    this._unsubs.push(unsub);
    return () => {
      unsub();
      const idx = this._unsubs.indexOf(unsub);
      if (idx !== -1) this._unsubs.splice(idx, 1);
    };
  }

  reconfigure(config: FoundryConfig, domains: ReturnType<typeof resolveThreadDomains>): string[] {
    if (this._disposed) return [];
    const deferred: string[] = [];
    const next = new Set<string>();
    // Every replacement is built before any is applied: an edit that cannot be built changes nothing.
    const swaps: Array<() => void> = [];
    if (
      wardenCharter(chorusSource(config, this.thread.meta.projectId as string | undefined))
        .version !== this._charter.version
    )
      deferred.push('Warden charter change (chorus setting) applies to new threads');
    const cartographerRole = cartographerRoleId(config);
    if (cartographerRole === this._cartographerRole) {
      const fresh = roleSources(config, cartographerRole, 'instructions', ['instructions'], {
        builtIn: DEFAULT_ROUTE_INSTRUCTIONS,
      });
      const budget = roleComposition(config.composition, cartographerRole).budget;
      swaps.push(() => {
        replaceRoleSources(this._cartographerInstructions, fresh, this._scope);
        this.cartographer.setBudget(budget);
      });
    } else deferred.push('Cartographer role change applies to new threads');
    for (const dc of domains) {
      next.add(dc.domain);
      const lib = this.domainLibrarians.get(dc.domain);
      const held = this._roleLayers.get(dc.domain);
      const same = dc.expert
        ? held?.role === dc.expert.agentId
        : !!dc.layerId && lib?.cache === this.thread.stack.getLayer(dc.layerId);
      if (!lib || !same) {
        deferred.push(`Warden ${dc.domain} applies to new threads`);
        continue;
      }
      // Settings edits reach the composed slots on the next turn's warm.
      const fresh = held
        ? (['instructions', 'domainKnowledge'] as const).map(
            (slot) =>
              [
                held[slot],
                roleSources(config, held.role, slot, ['instructions', 'domainKnowledge'], {
                  resolveSource: this._resolveSource,
                }),
              ] as const,
          )
        : [];
      swaps.push(() => {
        for (const [layer, sources] of fresh) replaceRoleSources(layer, sources, this._scope);
        lib.reconfigure(dc);
      });
    }
    for (const swap of swaps) swap();
    for (const domain of this.domainLibrarians.keys())
      if (!next.has(domain)) deferred.push(`Warden ${domain} stays until the thread is replaced`);
    return deferred;
  }
  /**
   * Ask every Warden to stay pre-started with its current thread understanding (debounced: a landed
   * turn and its reviews coalesce). A provider without pre-start ignores it.
   */
  private _schedulePrestart(since = Date.now()): void {
    // Nothing pre-starts unless a Warden's provider does (the in-session runtime only).
    if (this._disposed || ![...this._wardenProviders].some((provider) => provider.prestart)) return;
    clearTimeout(this._prestartTimer);
    this._prestartTimer = setTimeout(() => {
      if (this._disposed) return;
      // Reviews of the landed turn change what the Wardens know: pre-start once they settle (bounded).
      const reviewing = [...this.domainLibrarians.keys()].some(
        (domain) =>
          (this._queuedEvidence.get(domain)?.length ?? 0) > 0 ||
          ['pending', 'delayed'].includes(this._reviewStates.get(domain)?.status ?? ''),
      );
      if (reviewing && Date.now() - since < PRESTART_REVIEW_WAIT_MS) {
        this._schedulePrestart(since);
        return;
      }
      for (const lib of this.domainLibrarians.values()) lib.prestart();
    }, PRESTART_DEBOUNCE_MS);
    (this._prestartTimer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    clearTimeout(this._prestartTimer);
    for (const provider of this._wardenProviders) void provider.releaseThread?.(this.thread.id);
    for (const [domain, lib] of this.domainLibrarians) {
      this._closeReview(domain, 'runtime disposed; queued work was not admitted');
      if (this._reviewStates.get(domain)?.capacity === 'settled')
        void this._releaseReview(domain, lib);
    }

    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];

    this.thread.middleware.remove(REACTIVE_MIDDLEWARE_ID);
    this.thread.middleware.remove(FLOW_MIDDLEWARE_ID);

    this.flowOrchestrator.dispose();
    this.cartographer.dispose();
    this.librarian.dispose();
    this.thread.stack.removeLayer(this.librarian.layer.id);
    for (const layer of this._knowledgeLayers) this.thread.stack.removeLayer(layer.id);
    this._toolsByDispatch.clear();
    this._uncorrelatedTools = [];
    this._liveDispatches.clear();

    this._eventStream?.push({
      kind: 'session',
      event: { type: 'thread:removed', threadId: this.thread.id, timestamp: Date.now() },
    });

    // Disposing the runtime closes the Thread object itself: it must never be
    // left as a runnable thread with no middleware, knowledge or bridges.
    // Idempotent in both directions (thread.dispose() reaches here through
    // the disposer registered above; the flag stops the loop).
    this.thread.dispose();
    this._onDisposed();
  }
}

/** One owned copy per admission, not a copy of session history per event. */
function freezeOwned<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}
