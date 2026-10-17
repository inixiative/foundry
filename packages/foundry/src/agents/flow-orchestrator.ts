// ---------------------------------------------------------------------------
// Flow Orchestrator — wires the five FLOW.md roles into a coherent pipeline
//
// Pre-message flow (parallel message decoration, CORE-002):
//   1. Freeze    — capture the user message, thread state and every domain's
//                  knowledge revision before any asynchronous work
//   2. Assess    — every enabled domain assesses that frozen input, in a
//                  bounded pool, concurrently with Cartographer routing;
//                  routing and each assessment have their own deadline and
//                  the whole plan may have one too
//   3. Compose   — merge in configured order into a sealed, immutable plan
//                  with explicit decisions, provenance, omissions, conflicts,
//                  routing outcome and still-outstanding calls
//   4. Prepare   — hydrateDelta warms and composes the decoration; it does
//                  NOT commit the delivery ledger, and it reports assessed
//                  versus delivered revisions separately
//   5. Commit    — commitDelivery records what the executor actually received
//
// Delivery model (read this before changing hydration; FLOW.md "Delivery"):
//   A native session holds its context. It starts with every standing part (warm layers and the
//   executor's instructions) in its base context, Claude's system prompt; after that a turn carries
//   only the parts whose hash the session does not hold, keyed by the ledger, plus the per-turn
//   decoration. The session provider reports what it delivered and the ledger commits exactly
//   that; a started session resets it, compaction clears it. Stateless providers still receive
//   every warm layer on every turn, so for them `skipped` stays informational.
//
// Timeouts are not cancellations. A timed-out route or assessment is still
// running against its provider; the plan records it as outstanding and the
// orchestrator counts it until it settles. Native cancellation is G5.
//
// Post-action flow:
//   6. Correctness checking — domain librarians guard tool observations
//   7. Signal reconciliation — Librarian already handles via signal bus
// ---------------------------------------------------------------------------

import {
  type ContextStack,
  computeHash,
  copyMessageIdentity,
  type LayerState,
  type LogicalMessageIdentity,
  layerPart,
  type MessageDecoration,
  newId,
  type ParticipantRequest,
  type PromptBlock,
  type ServedModel,
  type Signal,
  type SignalBus,
} from '@inixiative/foundry-core';
import {
  type PrefilterOutcome,
  type PrefilterSkip,
  prefilterSkip,
  type WardenPrefilter,
} from '../providers/warden-prefilter';
import type { Cartographer, RouteRequestEvidence, RouteResult } from './cartographer';
import {
  type AdviceRequestEvidence,
  activityTools,
  type CacheComposition,
  type DomainLibrarian,
  type GuardCallEvidence,
  type GuardFinding,
  type GuardResult,
  type GuardStatus,
  type PhaseRequestEvidence,
  renderTurnActivity,
  type TurnActivity,
} from './domain-librarian';
import type { Librarian } from './librarian';
import type { WardenPointer } from './warden-charter';
import type { AdviceTrigger, TriggerPoint } from './warden-triggers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What one domain decided about one input.
 * - contribute: the domain answered with something to add.
 * - no-comment: the domain answered NO_COMMENT; nothing reaches the thread.
 * - skipped: no call was made: it holds no knowledge yet (a cold cache), or the pre-filter was
 *   confident the moment is outside its domain (`prefilter` carries the score).
 * - error: the domain's model call failed.
 * - timeout: the domain started but had not answered by its deadline (call still outstanding).
 * - excluded: the domain never started: the plan deadline passed while it was queued, or the
 *   decision queue never admitted its call.
 * - omitted: the domain contributed but the composition budget excluded it.
 */
export type ContributionDecision =
  | 'contribute'
  | 'no-comment'
  | 'skipped'
  | 'error'
  | 'timeout'
  | 'excluded'
  | 'omitted';

/** The three named inputs a domain worked from. Explicit, never inferred. */
export interface ContributionSegments {
  /** Stable role guidance the domain advises with. */
  readonly instructions: string;
  /** The knowledge revision the domain assessed (frozen at capture). */
  readonly domainKnowledge: string;
  /** The thread-state revision the domain assessed (frozen at capture). */
  readonly threadKnowledge: string;
}

export interface ContributionProvenance {
  readonly inputHash: string;
  /** Hash of the knowledge revision the domain assessed. */
  readonly cacheHash: string;
  readonly cacheState: LayerState;
  readonly cacheLastWarmed: number | null;
  /** Hash of the global thread-state the domain was shown. */
  readonly threadStateHash: string;
  /** Revision of this domain's own thread knowledge that it assessed with. */
  readonly threadKnowledgeRevision: number;
  readonly threadKnowledgeHash: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly elapsedMs?: number;
}

/** One domain's recorded participation in a turn. */
export interface DomainContribution {
  readonly domain: string;
  readonly decision: ContributionDecision;
  /** The trigger point it was asked at. */
  readonly trigger: TriggerPoint;
  readonly reason?: string;
  /** Skipped by the pre-filter: its score and the threshold it fell below. */
  readonly prefilter?: PrefilterSkip;
  readonly layers: string[];
  readonly snippets: string[];
  readonly confidence: number;
  /** Under the classifier charter: the pointer read off the snippets (`Look over here: …`). */
  readonly pointer?: WardenPointer;
  readonly segments: ContributionSegments;
  readonly provenance: ContributionProvenance;
  /**
   * The exact provider input this domain was given at this phase, or why no call was made.
   * Observed at the call boundary; a late answer cannot rewrite it. Not evidence of native receipt.
   */
  readonly request: ParticipantRequest;
}

/** The immutable input every participant assessed. */
export interface PlanInput {
  readonly message: string;
  readonly currentMessage?: LogicalMessageIdentity;
  readonly hash: string;
  readonly threadState: string;
  readonly threadStateHash: string;
  readonly capturedAt: number;
}

/**
 * How routing ended.
 * - routed: the router's model answered.
 * - fallback: the router's model failed and a keyword fallback was used.
 * - timeout: no answer by the routing deadline (call still outstanding).
 * - error: the routing call rejected.
 */
export type RoutingStatus = 'routed' | 'fallback' | 'timeout' | 'error';

export interface RoutingOutcome extends RouteResult {
  readonly status: RoutingStatus;
  readonly reason?: string;
  /** The exact routing request supplied to the Cartographer's provider, or why none was made. */
  readonly request: ParticipantRequest;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly elapsedMs: number;
}

/** A provider call that had not settled when the plan was sealed. */
export interface OutstandingCall {
  readonly kind: 'route' | 'advise';
  readonly participant: string;
  readonly startedAt: number;
}

/** Result of the pre-message flow — a sealed plan of what to inject. */
export interface InjectionPlan {
  /** Layer IDs to hydrate and include. */
  layers: string[];
  /** Inline snippets from contributing domains, in configured domain order. */
  snippets: string[];
  /** Every domain that assessed the input, plus any the router named. */
  domainsConsulted: string[];
  /** Overall routing confidence (0 when routing did not complete normally). */
  confidence: number;
  /** Time taken for the full pre-message flow (ms). */
  elapsed: number;
  /** Whether this plan was generated fresh or is a reuse of a previous plan. */
  fresh: boolean;
  /** The frozen input all participants saw. */
  readonly input: PlanInput;
  /** The Cartographer's own outcome, kept separate from domain advice. */
  readonly routing: RoutingOutcome;
  /** Every enabled domain, in configured order, with its decision. */
  readonly contributions: DomainContribution[];
  /** Domains excluded by policy (budget), never silently. */
  readonly omissions: Array<{ readonly domain: string; readonly reason: string }>;
  /** Disagreements the composer noticed but did not resolve. */
  readonly conflicts: Array<{
    readonly kind: string;
    readonly domain: string;
    readonly detail: string;
  }>;
  /** Provider calls still running when the plan was sealed. Not cancelled. */
  readonly outstanding: OutstandingCall[];
  /** The pre-filter's call for this trigger, when it is on. `unavailable` asked every Warden. */
  readonly prefilter?: PrefilterRun;
  /** When the plan was sealed. Nothing may change it afterwards. */
  readonly sealedAt: number;
}

/** What the pre-filter did at one trigger: journalled with the Wardens' decisions. */
export type PrefilterRun =
  | { readonly status: 'scored'; readonly elapsedMs: number; readonly skipped: number }
  | { readonly status: 'unavailable'; readonly elapsedMs: number; readonly reason: string };

function prefilterRun(outcome: PrefilterOutcome, skipped: number): PrefilterRun {
  return outcome.status === 'scored'
    ? { status: 'scored', elapsedMs: outcome.elapsedMs, skipped }
    : { status: 'unavailable', elapsedMs: outcome.elapsedMs, reason: outcome.reason };
}

/** Assessed versus prepared revision of one layer. */
export interface LayerRevision {
  readonly id: string;
  /** Domain whose cache this layer is, when a domain assessed it. */
  readonly domain?: string;
  /** Hash the domain assessed; absent when no domain owns the layer. */
  readonly assessedHash?: string;
  /** Hash of the content prepared for delivery. */
  readonly deliveredHash: string;
  /** True when the layer changed between assessment and preparation. */
  readonly changed: boolean;
}

/** Result of delta-aware hydration — prepared, not yet delivered. */
export interface HydrationResult {
  /** Assembled context string for injection. */
  content: string;
  /** Layers that are new relative to the ledger. */
  injected: string[];
  /** Layers already in the session with the same hash (informational for stateless providers). */
  skipped: string[];
  /** Layers whose content changed since last delivery. */
  reinjected: string[];
  /** Ledger records to commit once delivery is evidenced. */
  pending: Array<{ id: string; hash: string }>;
  /** Assessed versus prepared revision for every plan layer that was warm. */
  revisions: LayerRevision[];
  /** The composed decoration for the executor. */
  decoration: MessageDecoration;
  /** Layers that did not warm within the deadline, or failed to; the turn went on without them. */
  warmShortfalls: WarmShortfall[];
}

/** A cache that did not warm in time, or failed to: recorded, never blocking. */
export interface WarmShortfall {
  readonly id: string;
  readonly outcome: 'timeout' | 'error';
  readonly reason: string;
}

/** What the executor demonstrably received. */
export interface DeliveryEvidence {
  layers: Array<{ id: string; hash: string }>;
}

/** Event emitted when the orchestrator detects a state change that invalidates the current plan. */
export interface InvalidationEvent {
  /** What triggered the invalidation. */
  reason: 'eviction' | 'rehydration' | 'map_rebuild' | 'compaction';
  /** Layer IDs affected. */
  affectedLayers: string[];
  /** Timestamp of the invalidation. */
  timestamp: number;
  /** Source runtime for compaction events (e.g., "claude-code", "codex"). */
  source?: string;
}

/** One domain guard's outcome for one observation. Only `completed` certifies its findings. */
export interface GuardOutcome {
  readonly domain: string;
  readonly status: GuardStatus;
  readonly findings: number;
  /** What this domain said (its findings' descriptions), when it spoke. */
  readonly notes?: readonly string[];
  /** The check completed with NO_COMMENT: nothing to add. */
  readonly noComment?: true;
  readonly error?: string;
  /** Provider lifecycle classification of a failed call, "unknown", or "not-admitted" when the call was refused before the provider. */
  readonly admission?: GuardCallEvidence | 'unknown' | 'not-admitted';
  /** Revision of the domain's own thread understanding that was supplied. */
  readonly threadKnowledgeRevision?: number;
  /** The exact guard request supplied to the domain's provider, or why none was made. */
  readonly request?: ParticipantRequest;
}

/** Caller hooks for the post-action flow. `onRequest` fires at each domain's call boundary, before its answer. */
export interface GuardPhaseHooks {
  onRequest?: (
    domain: string,
    request: PhaseRequestEvidence,
    threadKnowledgeRevision: number,
  ) => void;
}

/** Result of the post-action flow — findings from guard checks, and which checks did not complete. */
export interface GuardReport {
  /** All findings across all domains. */
  findings: GuardFinding[];
  /** Critical findings that should be pushed to the session immediately. */
  critical: GuardFinding[];
  /** Advisory findings that feed into writeback. */
  advisory: GuardFinding[];
  /** Which domain guards were triggered (completed or not). */
  domainsChecked: string[];
  /** Domains whose guard triggers name none of the activity's tools: not asked. */
  skipped: string[];
  /** Domains the pre-filter skipped: confident the activity is outside their domain. Not asked. */
  prefiltered: Array<{ domain: string } & PrefilterSkip>;
  /** The pre-filter's call for this activity, when it is on. */
  prefilter?: PrefilterRun;
  /** Per-domain outcome, in configured order. Distinguishes a completed all-clear from a failed or malformed check. */
  outcomes: GuardOutcome[];
  /** Domains whose check did not complete: provider-error, invalid-response or not-admitted. No all-clear exists for them. */
  failed: string[];
  /** Time taken for the full guard flow (ms). */
  elapsed: number;
}

/** A handoff the agent made: the task text a subagent starts from, and the child it became. */
export interface HandoffMoment {
  readonly childThreadId: string;
  readonly handoffId: string;
  readonly description?: string;
  readonly agentType?: string;
  readonly prompt: string;
}

/**
 * A work item the agent took in (the `consumed` trigger): a ticket or spec file it read, or an issue
 * or page it fetched. `text` is already clipped to the project's `chorus.consumed.maxChars`.
 */
export interface WorkItemMoment {
  /** One id per item: the tool and the file path or fetched id. */
  readonly itemId: string;
  /** How the main thread named it: the file path, or the issue or page id. */
  readonly name: string;
  readonly tool: string;
  readonly text: string;
  /** Characters cut from the item's end, when it was clipped. */
  readonly clipped?: number;
}

/**
 * The roster's answers at a moment between turns: a handoff (`subagent-spawn`, the brief) or a work
 * item (`consumed`). Every Warden's decision, delivered on the next turn.
 */
export interface BriefReport {
  /** The moment the Wardens were given, frozen: the handoff or work item as text. */
  readonly input: PlanInput;
  /** Per Warden, in configured order: contribute (the brief), no-comment, skipped, excluded, timeout or error. */
  readonly contributions: DomainContribution[];
  /** The pre-filter's call for this handoff, when it is on. */
  readonly prefilter?: PrefilterRun;
  /** Calls that timed out and are still running. */
  readonly outstanding: OutstandingCall[];
  readonly elapsed: number;
  readonly sealedAt: number;
}

/** Timing and budget settings for the pre-message flow. All bounds are validated. */
export interface FlowTimingConfig {
  /**
   * Concurrency bound for domain assessment. Every enabled domain is still
   * consulted; this only limits how many assess at once. Positive integer.
   * Default: every domain at once, so advice costs one decision's latency.
   */
  maxAdviseParallel?: number;
  /** Deadline per domain assessment. A late answer is recorded as a timeout. Default: 10 000 ms. */
  adviseTimeoutMs?: number;
  /** Deadline for routing. A late route is recorded as a timeout. Default: 10 000 ms. */
  routingTimeoutMs?: number;
  /**
   * Deadline for the whole pre-message flow. Started participants past it are
   * timeouts; queued ones are excluded. Default: none (per-call deadlines only).
   */
  planTimeoutMs?: number;
  /** Total snippet characters accepted per plan. Excess domains are recorded as omitted. Default: unlimited. */
  contributionBudget?: number;
}

/** Configuration for the flow orchestrator. */
export interface FlowOrchestratorConfig extends FlowTimingConfig {
  /** The context routing agent. */
  cartographer: Cartographer;
  /** Domain librarians, keyed by domain name. Map order is the configured order. */
  domainLibrarians: Map<string, DomainLibrarian>;
  /** The signal reconciliation coordinator. */
  librarian: Librarian;
  /** The thread's context stack. */
  stack: ContextStack;
  /** Signal bus for emitting orchestration events. */
  signals: SignalBus;
  /** The Warden pre-filter (settings `prefilter`, off by default); absent asks every Warden. */
  prefilter?: WardenPrefilter;
  /** The thread the pre-filter's calls are made for. */
  threadId?: string;
}

// ---------------------------------------------------------------------------
// Flow Orchestrator
// ---------------------------------------------------------------------------

interface Participant {
  lib: DomainLibrarian;
  cache: string;
  /** What `cache` is composed of and left out, frozen with it. */
  cacheComposition: CacheComposition;
  cacheHash: string;
  cacheState: LayerState;
  cacheLastWarmed: number | null;
  /** This domain's own thread understanding, frozen at capture. */
  threadKnowledge: string;
  threadKnowledgeRevision: number;
  threadKnowledgeHash: string;
}

/** Shared deadline for one pre-message run. */
interface PlanClock {
  readonly deadlineAt?: number;
  readonly planTimeoutMs?: number;
  passed(): boolean;
  /** Milliseconds left before the plan deadline, or undefined when unbounded. */
  remaining(): number | undefined;
}

type Raced<T> = { timedOut: false; value: T } | { timedOut: true; reason: string };

export class FlowOrchestrator {
  private _cartographer: Cartographer;
  private _domains: Map<string, DomainLibrarian>;
  private _librarian: Librarian;
  private _stack: ContextStack;
  private _signals: SignalBus;
  private _maxAdviseParallel: number;
  private _adviseTimeoutMs: number;
  private _routingTimeoutMs: number;
  private _planTimeoutMs: number | undefined;
  private _contributionBudget: number;
  private _prefilter: WardenPrefilter | undefined;
  private _threadId: string;

  /** Provider calls that timed out but are still running. */
  private _outstanding = new Set<symbol>();

  /** The last injection plan produced by preMessage(). */
  private _lastPlan: InjectionPlan | null = null;
  /** The last message that was routed (for re-firing after invalidation). */
  private _lastMessage: string | null = null;
  /** Whether the current plan has been invalidated by eviction/rehydration. */
  private _invalidated = false;
  /** Accumulated invalidation events since last preMessage(). */
  private _pendingInvalidations: InvalidationEvent[] = [];
  /** Listeners for invalidation events. */
  private _invalidationListeners: Array<(event: InvalidationEvent) => void> = [];
  /** Signal bus unsubscribe handles. */
  private _unsubscribes: Array<() => void> = [];
  /**
   * Notes that arrived between turns (a handoff brief) and ride with the next user message as
   * after-message blocks, the way a Warden chimes in on the message itself. No push path reaches a
   * running turn (CLAUDE.md, Communication Channels).
   */
  private _pendingNotes: PromptBlock[] = [];

  constructor(config: FlowOrchestratorConfig) {
    this._cartographer = config.cartographer;
    this._domains = config.domainLibrarians;
    this._librarian = config.librarian;
    this._stack = config.stack;
    this._signals = config.signals;
    this._maxAdviseParallel = positiveInteger(
      'maxAdviseParallel',
      config.maxAdviseParallel,
      Number.MAX_SAFE_INTEGER,
    );
    this._adviseTimeoutMs = positiveFiniteMs('adviseTimeoutMs', config.adviseTimeoutMs, 10_000)!;
    this._routingTimeoutMs = positiveFiniteMs('routingTimeoutMs', config.routingTimeoutMs, 10_000)!;
    this._planTimeoutMs = positiveFiniteMs('planTimeoutMs', config.planTimeoutMs, undefined);
    this._contributionBudget = positiveBudget('contributionBudget', config.contributionBudget);
    this._prefilter = config.prefilter;
    this._threadId = config.threadId ?? 'thread';

    // Subscribe to signals that invalidate the current plan
    this._unsubscribes.push(this._signals.onAny((signal) => this._handleInvalidation(signal)));
  }

  /** Whether the current injection plan is stale and should be re-fired. */
  get isInvalidated(): boolean {
    return this._invalidated;
  }

  /** Pending invalidation events since last preMessage(). */
  get pendingInvalidations(): ReadonlyArray<InvalidationEvent> {
    return this._pendingInvalidations;
  }

  /**
   * Provider calls that timed out and have not settled yet. A timeout only
   * stops waiting; it does not cancel the native request.
   */
  get outstandingCalls(): number {
    return this._outstanding.size;
  }

  /** Register a listener for invalidation events (e.g., to trigger re-injection). */
  onInvalidation(listener: (event: InvalidationEvent) => void): () => void {
    this._invalidationListeners.push(listener);
    return () => {
      const idx = this._invalidationListeners.indexOf(listener);
      if (idx !== -1) this._invalidationListeners.splice(idx, 1);
    };
  }

  /** Stop listening to signals. */
  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
  }

  // -----------------------------------------------------------------------
  // Pre-message flow — parallel decoration
  // -----------------------------------------------------------------------

  /**
   * Run the pre-message flow: freeze the input, let every enabled domain
   * assess it concurrently with routing, and compose a sealed plan.
   *
   * The full message is passed to routing and advising — no compression,
   * no digestion. Layers are decorators and routers around the message,
   * not summaries of it.
   */
  async preMessage(
    message: string,
    currentMessage?: LogicalMessageIdentity,
  ): Promise<InjectionPlan> {
    const plan = await this._runPreMessage(message, true, currentMessage);

    // Track for re-firing after invalidation
    this._lastPlan = plan;
    this._lastMessage = message;
    this._invalidated = false;
    this._pendingInvalidations = [];

    return plan;
  }

  /**
   * Re-fire the pre-message flow for the last message.
   * Call this after eviction or rehydration invalidates the current plan.
   * Returns null if there's no previous message to re-fire for.
   */
  async refire(): Promise<InjectionPlan | null> {
    if (!this._lastMessage) return null;

    const plan = await this._runPreMessage(
      this._lastMessage,
      false,
      this._lastPlan?.input.currentMessage,
    );

    this._lastPlan = plan;
    this._invalidated = false;
    this._pendingInvalidations = [];

    return plan;
  }

  private async _runPreMessage(
    message: string,
    fresh: boolean,
    currentMessage?: LogicalMessageIdentity,
  ): Promise<InjectionPlan> {
    const start = Date.now();

    // 1. Freeze: everything a participant may read is captured now, before
    //    any await, so every domain and the router see the same revision.
    const threadState = this._librarian.layer.content;
    const input: PlanInput = {
      message,
      ...(currentMessage ? { currentMessage: copyMessageIdentity(currentMessage) } : {}),
      hash: computeHash(message),
      threadState,
      threadStateHash: computeHash(threadState),
      capturedAt: start,
    };
    const participants = this._participants();
    const clock = this._clock(start);
    const outstanding: OutstandingCall[] = [];

    // 2. Assess: the user-message trigger point asks every Warden the pre-filter does not rule out;
    //    each decides under the charter (bounded pool). Routing starts alongside the pre-filter.
    const routing = this._route(message, threadState, clock, outstanding);
    const prefiltered = await this.prefilter(
      'user-message',
      message,
      threadState,
      participants.filter((p) => p.cache).map((p) => p.lib),
    );
    const assessments = runBounded(participants, this._maxAdviseParallel, (p) =>
      this._assess(p, input, clock, outstanding, prefilterSkip(prefiltered, p.lib.domain)),
    );
    const [route, contributions] = await Promise.all([routing, assessments]);

    // 3. Compose in configured order and seal.
    const plan = this._compose(input, route, contributions, outstanding, start, fresh);
    return prefiltered
      ? deepFreeze({
          ...plan,
          prefilter: prefilterRun(prefiltered, contributions.filter((c) => c.prefilter).length),
        })
      : plan;
  }

  /** Every Warden with what it would assess against, frozen now, before any await. */
  private _participants(): Participant[] {
    return [...this._domains.values()].map((lib) => ({
      lib,
      cache: lib.cache.content,
      cacheComposition: lib.cacheComposition(),
      cacheHash: lib.cache.hash,
      cacheState: lib.cache.checkStaleness(),
      cacheLastWarmed: lib.cache.lastWarmed,
      threadKnowledge: lib.threadKnowledge.content,
      threadKnowledgeRevision: lib.threadKnowledge.revision,
      threadKnowledgeHash: lib.threadKnowledge.hash,
    }));
  }

  /** The shared deadline of one fan-out to the roster, from `start`. */
  private _clock(start: number): PlanClock {
    const planTimeoutMs = this._planTimeoutMs;
    const deadlineAt = planTimeoutMs !== undefined ? start + planTimeoutMs : undefined;
    return {
      deadlineAt,
      planTimeoutMs,
      passed: () => deadlineAt !== undefined && Date.now() >= deadlineAt,
      remaining: () =>
        deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now()),
    };
  }

  // -----------------------------------------------------------------------
  // Handoff brief — the subagent-spawn trigger point
  // -----------------------------------------------------------------------

  /**
   * The agent handed a task to a subagent: ask the roster, once, what the subagent must know that
   * the task text leaves out. Every Warden decides under the charter through the advice protocol
   * (NO_COMMENT expected); the pre-filter, when on, rules out the ones it is confident the task is
   * outside of. The brief never blocks the handoff, which the harness has already made.
   */
  async brief(handoff: HandoffMoment): Promise<BriefReport> {
    return this._between('subagent-spawn', handoffText(handoff));
  }

  /**
   * The agent took in a work item (the `consumed` trigger): ask the roster, once, what of its domain
   * the work touches. Every Warden answers under the charter through the advice protocol (NO_COMMENT
   * expected); like a brief, it never blocks, and what is said rides with the next turn.
   */
  async consume(item: WorkItemMoment): Promise<BriefReport> {
    return this._between('consumed', workItemText(item));
  }

  /** One fan-out to the roster at a moment between turns, through the advice protocol. */
  private async _between(
    trigger: Extract<AdviceTrigger, 'subagent-spawn' | 'consumed'>,
    message: string,
  ): Promise<BriefReport> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;
    const input: PlanInput = {
      message,
      hash: computeHash(message),
      threadState,
      threadStateHash: computeHash(threadState),
      capturedAt: start,
    };
    const participants = this._participants();
    const clock = this._clock(start);
    const outstanding: OutstandingCall[] = [];
    const prefiltered = await this.prefilter(
      trigger,
      message,
      threadState,
      participants.filter((p) => p.cache).map((p) => p.lib),
    );
    const contributions = await runBounded(participants, this._maxAdviseParallel, (p) =>
      this._assess(p, input, clock, outstanding, prefilterSkip(prefiltered, p.lib.domain), trigger),
    );
    return deepFreeze({
      input,
      contributions,
      ...(prefiltered
        ? { prefilter: prefilterRun(prefiltered, contributions.filter((c) => c.prefilter).length) }
        : {}),
      outstanding,
      elapsed: Date.now() - start,
      sealedAt: Date.now(),
    });
  }

  /**
   * Notes for the next turn: appended to the end of the next user message as after-message blocks
   * (the "chimed in" delivery), since nothing reaches a running turn.
   */
  queueNotes(blocks: readonly PromptBlock[]): void {
    this._pendingNotes.push(...blocks);
  }

  /** Notes waiting for the next turn. */
  get pendingNotes(): readonly PromptBlock[] {
    return this._pendingNotes;
  }

  /**
   * The pre-filter's one call for a trigger, over the Wardens that would be asked. Undefined when
   * it is off. Never throws: an unavailable model comes back as `unavailable`, and every Warden is
   * asked.
   */
  async prefilter(
    trigger: TriggerPoint | 'post-turn',
    text: string,
    context: string | undefined,
    wardens: readonly DomainLibrarian[],
  ): Promise<PrefilterOutcome | undefined> {
    if (!this._prefilter || !wardens.length) return undefined;
    return this._prefilter.score(
      trigger,
      text,
      context,
      wardens.map((lib) => ({ domain: lib.domain, instructions: lib.advisePrompt })),
      this._threadId,
    );
  }

  /** Route with a deadline. Timeouts, errors and fallbacks are labelled, never hidden. */
  private async _route(
    message: string,
    threadState: string,
    clock: PlanClock,
    outstanding: OutstandingCall[],
  ): Promise<RoutingOutcome> {
    const startedAt = Date.now();
    // Invocation-scoped: the exact routing input, observed at the Cartographer's call boundary. A
    // timed-out or failed route keeps its request; an empty map or a never-started route records why.
    let observed: RouteRequestEvidence | null = null;
    let served: ServedModel | null = null;
    const finish = (
      partial: Omit<RoutingOutcome, 'startedAt' | 'finishedAt' | 'elapsedMs' | 'request'>,
    ): RoutingOutcome => {
      const finishedAt = Date.now();
      const request: ParticipantRequest = observed
        ? {
            status: 'supplied',
            phase: observed.phase,
            providerId: observed.providerId,
            messages: observed.messages,
            capturedAt: observed.capturedAt,
            ...(served ? { served } : {}),
          }
        : {
            status: 'not-sent',
            phase: 'route',
            reason: partial.reason ?? `${partial.status} before any provider call`,
          };
      return { ...partial, request, startedAt, finishedAt, elapsedMs: finishedAt - startedAt };
    };
    const empty = { layers: [] as string[], domains: [] as string[], confidence: 0 };

    const task = this._cartographer
      .route(message, threadState, {
        observeRequest: (evidence) => {
          observed = evidence;
        },
        observeServed: (value) => {
          served = value;
        },
        timeoutMs: Math.min(this._routingTimeoutMs, clock.remaining() ?? Number.POSITIVE_INFINITY),
      })
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (err: unknown) => ({
          kind: 'error' as const,
          error: (err as Error)?.message ?? String(err),
        }),
      );
    const raced = await this._raceDeadline(task, this._routingTimeoutMs, 'route', clock);

    if (raced.timedOut) {
      this._trackOutstanding(task);
      outstanding.push({ kind: 'route', participant: 'cartographer', startedAt });
      return finish({ ...empty, status: 'timeout', reason: raced.reason });
    }
    const outcome = raced.value;
    if (outcome.kind === 'error')
      return finish({ ...empty, status: 'error', reason: outcome.error });

    const { result } = outcome;
    const status: RoutingStatus = result.source === 'keyword-fallback' ? 'fallback' : 'routed';
    return finish({
      layers: [...result.layers],
      domains: [...result.domains],
      ...(result.concepts ? { concepts: [...result.concepts] } : {}),
      confidence: result.confidence,
      ...(result.source ? { source: result.source } : {}),
      status,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  private async _assess(
    p: Participant,
    input: PlanInput,
    clock: PlanClock,
    outstanding: OutstandingCall[],
    skip?: PrefilterSkip,
    trigger: AdviceTrigger = 'user-message',
  ): Promise<DomainContribution> {
    const startedAt = Date.now();
    // Three separately owned segments: configured instructions, configured
    // domain knowledge, and this domain's own generated understanding of the
    // thread. The global Librarian thread-state is passed to advise as a
    // fourth input but is never presented as the domain's thread knowledge.
    const segments: ContributionSegments = {
      instructions: p.lib.advisePrompt,
      domainKnowledge: p.cache,
      threadKnowledge: p.threadKnowledge,
    };
    const provenance = (): ContributionProvenance => ({
      inputHash: input.hash,
      cacheHash: p.cacheHash,
      cacheState: p.cacheState,
      cacheLastWarmed: p.cacheLastWarmed,
      threadStateHash: input.threadStateHash,
      threadKnowledgeRevision: p.threadKnowledgeRevision,
      threadKnowledgeHash: p.threadKnowledgeHash,
      startedAt,
      finishedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
    });
    // Invocation-scoped: the exact input this participant's provider was given, observed at the
    // call boundary by a closure that belongs to this assessment alone, so concurrent domains can
    // never be misattributed. A timed-out or failed call keeps its request; a call never made
    // records why. Recorded input is what the provider interface was given, not native receipt.
    let observed: AdviceRequestEvidence | null = null;
    let served: ServedModel | null = null;
    const request = (
      decision: ContributionDecision,
      reason: string | undefined,
    ): ParticipantRequest =>
      observed
        ? {
            status: 'supplied',
            phase: observed.phase,
            providerId: observed.providerId,
            messages: observed.messages,
            capturedAt: observed.capturedAt,
            ...(served ? { served } : {}),
            ...(observed.composition ? { composition: observed.composition } : {}),
          }
        : {
            status: 'not-sent',
            phase: 'advice',
            reason: reason ?? `${decision} before any provider call`,
          };
    const decided = (
      decision: ContributionDecision,
      extra: Partial<
        Pick<
          DomainContribution,
          'reason' | 'layers' | 'snippets' | 'confidence' | 'prefilter' | 'pointer'
        >
      > = {},
    ): DomainContribution => ({
      domain: p.lib.domain,
      decision,
      trigger,
      layers: [],
      snippets: [],
      confidence: 0,
      ...extra,
      // A skipped domain was given nothing: no call, so no inputs to record.
      segments:
        decision === 'skipped'
          ? { instructions: '', domainKnowledge: '', threadKnowledge: '' }
          : segments,
      provenance: provenance(),
      request: request(decision, extra.reason),
    });

    if (!p.cache) return decided('skipped', { reason: 'cold-cache' });
    if (skip) return decided('skipped', { reason: 'prefilter', prefilter: skip });
    // Queued behind the pool until the plan deadline passed: never started.
    if (clock.passed()) return decided('excluded', { reason: 'deadline-queued' });

    const task = p.lib
      .advise(input.message, input.threadState, {
        cache: p.cache,
        cacheComposition: p.cacheComposition,
        threadKnowledge: p.threadKnowledge,
        observeRequest: (evidence) => {
          observed = evidence;
        },
        observeServed: (value) => {
          served = value;
        },
        timeoutMs: Math.min(this._adviseTimeoutMs, clock.remaining() ?? Number.POSITIVE_INFINITY),
        trigger,
      })
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (err: unknown) => ({
          kind: 'error' as const,
          error: (err as Error)?.message ?? String(err),
        }),
      );
    const raced = await this._raceDeadline(task, this._adviseTimeoutMs, 'advise', clock);

    if (raced.timedOut) {
      // The late answer, whenever it arrives, is ignored: the plan is sealed.
      // The provider call itself is still running; count it until it settles.
      this._trackOutstanding(task);
      outstanding.push({ kind: 'advise', participant: p.lib.domain, startedAt });
      return decided('timeout', { reason: raced.reason });
    }
    const outcome = raced.value;
    if (outcome.kind === 'error') return decided('error', { reason: outcome.error });
    const { result } = outcome;
    if (result.error) return decided('error', { reason: result.error });
    if (result.skipped) return decided('skipped', { reason: result.skipped });
    if (result.notStarted) return decided('excluded', { reason: result.notStarted });
    if (result.noComment) return decided('no-comment');
    return decided('contribute', {
      layers: [...result.layers],
      snippets: [...result.snippets],
      confidence: result.confidence,
      ...(result.pointer ? { pointer: result.pointer } : {}),
    });
  }

  /**
   * Wait for `task` up to its own deadline or the plan deadline, whichever is
   * sooner. Reports which deadline fired. Never cancels the task.
   */
  private async _raceDeadline<T>(
    task: Promise<T>,
    perCallMs: number,
    kind: 'route' | 'advise',
    clock: PlanClock,
  ): Promise<Raced<T>> {
    const remaining = clock.remaining();
    const planBound = remaining !== undefined && remaining < perCallMs;
    const waitMs = planBound ? remaining : perCallMs;
    const reason = planBound
      ? `plan deadline ${clock.planTimeoutMs}ms reached before ${kind} answered`
      : `no ${kind === 'route' ? 'route' : 'answer'} within ${perCallMs}ms`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), waitMs);
    });
    try {
      const outcome = await Promise.race([task.then((value) => ({ value })), deadline]);
      if (outcome === 'timeout') return { timedOut: true, reason };
      return { timedOut: false, value: outcome.value };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private _trackOutstanding(task: Promise<unknown>): void {
    const token = Symbol('outstanding');
    this._outstanding.add(token);
    void task.finally(() => {
      this._outstanding.delete(token);
    });
  }

  /**
   * Merge routing + contributions into a sealed plan. Order is the configured
   * domain order regardless of completion order. Budget exclusions become
   * omissions; domains contributing against the router's selection become
   * conflicts. The user message is carried verbatim, never rewritten.
   */
  private _compose(
    input: PlanInput,
    route: RoutingOutcome,
    assessed: DomainContribution[],
    outstanding: OutstandingCall[],
    startTime: number,
    fresh: boolean,
  ): InjectionPlan {
    const layerSet = new Set<string>(route.layers);
    const snippets: string[] = [];
    const omissions: Array<{ domain: string; reason: string }> = [];
    const conflicts: Array<{ kind: string; domain: string; detail: string }> = [];
    let budgetUsed = 0;

    const contributions = assessed.map((c) => {
      if (c.decision !== 'contribute') return c;
      const size = c.snippets.join('\n').length;
      if (budgetUsed + size > this._contributionBudget) {
        omissions.push({ domain: c.domain, reason: 'budget' });
        return { ...c, decision: 'omitted' as const, reason: 'budget' };
      }
      budgetUsed += size;
      for (const layer of c.layers) layerSet.add(layer);
      snippets.push(...c.snippets);
      if (
        route.status === 'routed' &&
        route.domains.length > 0 &&
        !route.domains.includes(c.domain)
      ) {
        conflicts.push({
          kind: 'routing-excluded',
          domain: c.domain,
          detail: `router selected [${route.domains.join(', ')}]; ${c.domain} contributed ${c.snippets.length} snippet(s) and ${c.layers.length} layer(s) anyway`,
        });
      }
      return c;
    });

    const domainsConsulted: string[] = [];
    for (const domain of [...contributions.map((c) => c.domain), ...route.domains]) {
      if (!domainsConsulted.includes(domain)) domainsConsulted.push(domain);
    }

    const plan: InjectionPlan = {
      layers: [...layerSet],
      snippets,
      domainsConsulted,
      confidence: route.confidence,
      elapsed: Date.now() - startTime,
      fresh,
      input,
      routing: route,
      contributions,
      omissions,
      conflicts,
      outstanding,
      sealedAt: Date.now(),
    };
    return deepFreeze(plan);
  }

  /**
   * Hydrate the layers from an injection plan and return the assembled context.
   * Prepares only; see hydrateDelta() and commitDelivery().
   */
  async hydrate(plan: InjectionPlan): Promise<string> {
    const result = await this.hydrateDelta(plan);
    return result.content;
  }

  /**
   * Delta-aware preparation — warms what the plan needs, diffs it against the
   * Librarian's delivery ledger, and composes the decoration.
   *
   * Nothing is committed here. The ledger only changes through
   * commitDelivery(), after the executor has demonstrably received the turn.
   *
   * The plan assessed a frozen revision; preparation reads the layer as it is
   * now. Both hashes are reported per layer so a changed cache is visible
   * rather than mislabelled as the assessed one.
   */
  async hydrateDelta(plan: InjectionPlan): Promise<HydrationResult> {
    const layerIds = new Set(plan.layers);
    const ledger = this._librarian.state.injectedLayers;
    const ledgerMap = new Map(ledger.map((r) => [r.id, r]));
    const assessedByLayer = new Map<string, { domain: string; hash: string }>();
    for (const c of plan.contributions) {
      const cacheId = this._domains.get(c.domain)?.cache.id;
      if (cacheId) assessedByLayer.set(cacheId, { domain: c.domain, hash: c.provenance.cacheHash });
    }

    // Point selecting sources at the frozen message. Only layers with a
    // focusable source go stale for this; the executor includes every warm
    // layer, so focus applies to all of them, not just the plan's.
    for (const layer of this._stack.layers)
      layer.setFocus(plan.input.message, plan.input.currentMessage);

    // Warm only layers we need that aren't warm yet
    const toWarm = this._stack.layers.filter(
      (l) => (layerIds.has(l.id) || l.sources.some((s) => s.focusable)) && !l.isWarm,
    );
    const warmShortfalls = await this.warmWithin(
      toWarm.map((layer) => ({ id: layer.id, warm: () => layer.warm() })),
    );

    // Diff against ledger
    const injected: string[] = [];
    const skipped: string[] = [];
    const reinjected: string[] = [];
    const pending: Array<{ id: string; hash: string }> = [];
    const revisions: LayerRevision[] = [];
    const parts: string[] = [];

    for (const id of plan.layers) {
      const layer = this._stack.getLayer(id);
      if (!layer?.isWarm || !layer.content) continue;

      const assessed = assessedByLayer.get(id);
      revisions.push({
        id,
        ...(assessed ? { domain: assessed.domain, assessedHash: assessed.hash } : {}),
        deliveredHash: layer.hash,
        changed: assessed !== undefined && assessed.hash !== layer.hash,
      });

      const prev = ledgerMap.get(id);
      // The ledger keys a layer by the hash of the part the executor assembles (prompt + content).
      const part = layerPart(layer);

      if (prev && prev.hash === part.hash) {
        skipped.push(id);
        continue;
      }

      parts.push(layer.content);
      pending.push({ id, hash: part.hash });

      if (prev) {
        reinjected.push(id);
      } else {
        injected.push(id);
      }
    }

    if (plan.snippets.length > 0) {
      parts.push(plan.snippets.join('\n'));
    }

    const deliveredByDomain = new Map<string, string>();
    for (const [domain, lib] of this._domains) deliveredByDomain.set(domain, lib.cache.hash);

    return {
      content: parts.join('\n\n---\n\n'),
      injected,
      skipped,
      reinjected,
      pending,
      revisions,
      // Notes that arrived since the last turn (handoff briefs) ride with this one.
      decoration: composeDecoration(plan, deliveredByDomain, this._pendingNotes.splice(0)),
      warmShortfalls,
    };
  }

  /**
   * Warm caches without ever holding the turn: each gets the advise deadline, and a timeout or a
   * failure comes back as a shortfall instead of throwing. A late warm keeps running and lands for a
   * later turn.
   */
  async warmWithin(
    warms: ReadonlyArray<{ id: string; warm: () => Promise<unknown> }>,
  ): Promise<WarmShortfall[]> {
    const unbounded: PlanClock = { passed: () => false, remaining: () => undefined };
    const results = await Promise.all(
      warms.map(async ({ id, warm }): Promise<WarmShortfall | null> => {
        const settled = Promise.resolve()
          .then(warm)
          .then(
            () => null,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        const raced = await this._raceDeadline(settled, this._adviseTimeoutMs, 'advise', unbounded);
        if (raced.timedOut)
          return { id, outcome: 'timeout', reason: `not warm within ${this._adviseTimeoutMs}ms` };
        return raced.value === null ? null : { id, outcome: 'error', reason: raced.value };
      }),
    );
    return results.filter((shortfall): shortfall is WarmShortfall => shortfall !== null);
  }

  /**
   * Record what the executor actually received. Emits `context_loaded` per
   * layer so the Librarian's ledger reflects delivered content only. Returns
   * the committed layer ids.
   */
  async commitDelivery(evidence: DeliveryEvidence): Promise<string[]> {
    const committed: string[] = [];
    for (const { id, hash } of evidence.layers) {
      await this._signals.emit({
        id: newId('flow-inject'),
        kind: 'context_loaded',
        source: 'flow-orchestrator',
        content: { layerId: id, hash },
        timestamp: Date.now(),
      });
      committed.push(id);
    }
    return committed;
  }

  /**
   * Re-warm every layer on the thread's stack that has gone stale (an instruction or role file
   * edited since it loaded, a staleness window passed), so the executor assembles current content
   * and the change reaches the session as a delta. Bounded like every warm (`warmWithin`): a layer
   * that fails or is late keeps its last content (a stale or warming standing layer still
   * assembles) and lands for a later turn. Returns the ids re-warmed in time.
   */
  async refreshStale(): Promise<string[]> {
    const stale = this._stack.layers.filter(
      (layer) => layer.checkStaleness() === 'stale' && layer.lastWarmed !== null,
    );
    if (!stale.length) return [];
    const shortfalls = await this.warmWithin(
      stale.map((layer) => ({ id: layer.id, warm: () => layer.warm() })),
    );
    const missed = new Set(shortfalls.map((shortfall) => shortfall.id));
    return stale.map((layer) => layer.id).filter((id) => !missed.has(id));
  }

  // -----------------------------------------------------------------------
  // Post-action flow — correctness checking
  // -----------------------------------------------------------------------

  /** Whether some Warden's guard triggers name this tool: the calls a turn's activity collects. */
  guardsTool(tool: string): boolean {
    for (const lib of this._domains.values()) if (lib.guardTriggers.has(tool)) return true;
    return false;
  }

  /**
   * Run the post-action flow over a turn's activity (one call in `per-call` mode): trigger-gate it
   * to the right domain librarians, ask each once, and collect findings.
   */
  async postAction(activity: TurnActivity, hooks?: GuardPhaseHooks): Promise<GuardReport> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;

    // The agent-action trigger point asks every domain whose guard triggers name a call of the activity.
    const triggered: DomainLibrarian[] = [];
    const skipped: string[] = [];
    for (const [, domainLib] of this._domains) {
      if (domainLib.guards(activity)) triggered.push(domainLib);
      else skipped.push(domainLib.domain);
    }
    // The pre-filter rules out the Wardens it is confident the activity is outside of.
    const prefiltered = await this.prefilter(
      'agent-action',
      renderTurnActivity(activity),
      threadState,
      triggered,
    );
    const ruledOut: GuardReport['prefiltered'] = [];
    const domainsToCheck = triggered.filter((d) => {
      const skip = prefilterSkip(prefiltered, d.domain);
      if (skip) ruledOut.push({ domain: d.domain, ...skip });
      return !skip;
    });

    // Freeze each domain's OWN thread understanding before any await, so every guard checks
    // against one revision and no other domain's private interpretation can enter its request.
    const frozen = domainsToCheck.map((d) => ({
      threadKnowledge: d.threadKnowledge.content,
      threadKnowledgeRevision: d.threadKnowledge.revision,
    }));

    // Run guards in parallel. Each domain's exact request is observed at its call boundary (and handed to
    // the caller's hook before any answer). A guard that throws is a failed check, never an all-clear; if it
    // threw before its request was observed, the request is unobserved, not "not sent".
    const observed: Array<PhaseRequestEvidence | null> = domainsToCheck.map(() => null);
    const results: GuardResult[] = await Promise.all(
      domainsToCheck.map((d, i) =>
        d
          .guard(activity, threadState, {
            ...frozen[i],
            observeRequest: (evidence) => {
              observed[i] = evidence;
              hooks?.onRequest?.(d.domain, evidence, frozen[i].threadKnowledgeRevision);
            },
          })
          .catch((err: unknown): GuardResult => {
            // A refusal raised at the boundary (e.g. the caller's journal refused the request) is not a provider error:
            // no provider call was admitted. The prepared input is retained either way.
            const refused = (err as { admission?: unknown })?.admission === 'not-admitted';
            return {
              findings: [],
              ran: true,
              status: refused ? 'not-admitted' : 'provider-error',
              admission: refused ? 'not-admitted' : 'unknown',
              error: String((err as Error)?.message ?? err).slice(0, 200),
              threadKnowledgeRevision: frozen[i].threadKnowledgeRevision,
              request: observed[i]
                ? {
                    status: 'supplied',
                    phase: observed[i]!.phase,
                    providerId: observed[i]!.providerId,
                    messages: observed[i]!.messages,
                    capturedAt: observed[i]!.capturedAt,
                  }
                : {
                    status: 'unobserved',
                    phase: 'guard',
                    reason: 'guard threw before its request was observed',
                  },
            };
          }),
      ),
    );

    // Collect findings and per-domain outcomes
    const findings: GuardFinding[] = [];
    const domainsChecked: string[] = [];
    const outcomes: GuardOutcome[] = [];
    for (let i = 0; i < domainsToCheck.length; i++) {
      const r = results[i];
      domainsChecked.push(domainsToCheck[i].domain);
      if (r.status === 'completed') findings.push(...r.findings);
      outcomes.push({
        domain: domainsToCheck[i].domain,
        status: r.status,
        findings: r.status === 'completed' ? r.findings.length : 0,
        ...(r.status === 'completed' && r.findings.length
          ? { notes: r.findings.slice(0, 8).map((f) => f.description.slice(0, 500)) }
          : {}),
        ...(r.status === 'completed' && r.noComment ? { noComment: true as const } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.admission !== undefined ? { admission: r.admission } : {}),
        ...(r.threadKnowledgeRevision !== undefined
          ? { threadKnowledgeRevision: r.threadKnowledgeRevision }
          : {}),
        request: r.request,
      });
    }
    const failed = outcomes
      .filter(
        (o) =>
          o.status === 'provider-error' ||
          o.status === 'invalid-response' ||
          o.status === 'not-admitted',
      )
      .map((o) => o.domain);

    const critical = findings.filter((f) => f.severity === 'critical');
    const advisory = findings.filter((f) => f.severity === 'advisory');

    // Emit tool observation signal for the Librarian's thread-state
    await this._signals.emit({
      id: newId('flow-obs'),
      kind: 'tool_observation',
      source: 'flow-orchestrator',
      content: {
        tool: activityTools(activity).join(', '),
        tools: activityTools(activity),
        turnId: activity.turnId,
        calls: activity.observations.map((o) => ({
          tool: o.tool,
          ...(o.callId ? { callId: o.callId } : {}),
        })),
        filesAffected: [...new Set(activity.observations.flatMap((o) => o.filesAffected ?? []))],
        guardsRan: domainsChecked,
        guardsSkipped: skipped,
        guardsPrefiltered: ruledOut,
        guardOutcomes: outcomes,
        guardsFailed: failed,
        findingsCount: findings.length,
        criticalCount: critical.length,
      },
      timestamp: Date.now(),
    });

    return {
      findings,
      critical,
      advisory,
      domainsChecked,
      skipped,
      prefiltered: ruledOut,
      ...(prefiltered ? { prefilter: prefilterRun(prefiltered, ruledOut.length) } : {}),
      outcomes,
      failed,
      elapsed: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // Invalidation — eviction/rehydration awareness
  // -----------------------------------------------------------------------

  private _handleInvalidation(signal: Signal): void {
    // A compaction clears the delivery ledger whether or not a plan exists: a turn can deliver
    // (and commit) without one when pre-message failed, and what it delivered may be summarized away.
    const cleared =
      signal.kind === 'session_compacted' ? this._librarian.clearInjectionLedger() : [];
    if (!this._lastPlan) return; // no plan to invalidate

    let event: InvalidationEvent | null = null;

    switch (signal.kind) {
      case 'context_evicted': {
        const layerId = (signal.content as any)?.layerId;
        if (layerId && this._lastPlan.layers.includes(layerId)) {
          // A layer we injected just got evicted — plan is invalid
          event = {
            reason: 'eviction',
            affectedLayers: [layerId],
            timestamp: Date.now(),
          };
        }
        break;
      }
      case 'context_loaded': {
        // A layer was loaded — if it's one we wanted but didn't have, routing may improve
        const layerId = (signal.content as any)?.layerId;
        if (layerId && signal.source !== 'flow-orchestrator') {
          // External rehydration (not our own commit) — check if it matters
          const layer = this._stack.getLayer(layerId);
          if (layer && !this._lastPlan.layers.includes(layerId)) {
            event = {
              reason: 'rehydration',
              affectedLayers: [layerId],
              timestamp: Date.now(),
            };
          }
        }
        break;
      }
      case 'session_compacted': {
        // The underlying agent session was compacted (Claude Code auto-compact,
        // Codex session restart). Whatever layers we told the Librarian were
        // delivered may have been summarized away. Clear the ledger so the
        // next turn re-delivers from scratch (cleared above), and invalidate the plan.
        event = {
          reason: 'compaction',
          affectedLayers: cleared,
          timestamp: Date.now(),
          source: (signal.content as any)?.source as string | undefined,
        };
        break;
      }
    }

    if (event) {
      this._invalidated = true;
      this._pendingInvalidations.push(event);
      for (const listener of this._invalidationListeners) {
        listener(event);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function positiveFiniteMs(
  name: string,
  value: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds, got ${value}`);
  }
  return value;
}

function positiveBudget(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (Infinity allowed), got ${value}`);
  }
  return value;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep item order. */
async function runBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Build the executor-facing decoration from a sealed plan, plus notes held for this turn. */
function composeDecoration(
  plan: InjectionPlan,
  deliveredByDomain: Map<string, string>,
  notes: readonly PromptBlock[] = [],
): MessageDecoration {
  const blocks: PromptBlock[] = [];

  // Only a contribution the budget dropped is news to the session (its notes are missing). Silence,
  // skips and failures add nothing to the turn, not even a line; the journal keeps every decision.
  const decisions = plan.contributions
    .filter((c) => c.decision === 'omitted')
    .map((c) => `${c.domain}: ${c.decision}${c.reason ? ` (${c.reason})` : ''}`);
  const routingLine =
    plan.routing.status === 'routed'
      ? `Router selected domains: ${plan.routing.domains.length ? plan.routing.domains.join(', ') : 'none'} (confidence ${plan.routing.confidence}).`
      : `Routing ${plan.routing.status}${plan.routing.reason ? ` (${plan.routing.reason})` : ''}; no router selection was applied.`;
  blocks.push({
    role: 'content',
    id: 'decoration:routing',
    source: 'cartographer',
    segment: 'routing',
    text: [
      routingLine,
      ...(decisions.length ? [`Domain decisions: ${decisions.join('; ')}.`] : []),
      ...(plan.conflicts.length
        ? [
            `Unresolved conflicts: ${plan.conflicts.map((c) => `${c.domain} ${c.kind}`).join('; ')}.`,
          ]
        : []),
    ].join('\n'),
  });

  // Wardens are fresh each call and never hold the conversation: each one that contributed is
  // appended to the end of the user's message as its own note.
  // A contribution of layers only adds context; it has nothing to say.
  for (const c of plan.contributions) {
    if (c.decision !== 'contribute' || !c.snippets.length) continue;
    blocks.push({
      role: 'content',
      id: `decoration:${c.domain}`,
      source: c.domain,
      segment: 'domain-knowledge',
      placement: 'after-message',
      text: `The ${c.domain} Warden chimed in:\n${c.snippets.map((s) => `- ${s}`).join('\n')}`,
    });
  }
  // Notes from between turns (a Warden's brief at a handoff) land after the fresh advice.
  blocks.push(...notes);

  return deepFreeze({
    input: {
      hash: plan.input.hash,
      capturedAt: plan.input.capturedAt,
      ...(plan.input.currentMessage ? { currentMessage: plan.input.currentMessage } : {}),
    },
    blocks,
    participants: plan.contributions.map((c) => {
      const deliveredCacheHash = deliveredByDomain.get(c.domain);
      return {
        id: c.domain,
        decision: c.decision,
        ...(c.reason ? { reason: c.reason } : {}),
        segments: c.segments,
        request: c.request,
        provenance: {
          ...c.provenance,
          layers: c.layers,
          snippets: c.snippets,
          confidence: c.confidence,
          ...(c.pointer ? { pointer: c.pointer } : {}),
          ...(deliveredCacheHash !== undefined
            ? { deliveredCacheHash, revisionDrift: deliveredCacheHash !== c.provenance.cacheHash }
            : {}),
        },
      };
    }),
    omissions: plan.omissions.map((o) => ({ id: o.domain, reason: o.reason })),
    conflicts: plan.conflicts.map((c) => ({ kind: c.kind, id: c.domain, detail: c.detail })),
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** A handoff as the Wardens read it: who the task went to, then the task text the subagent starts from. */
export function handoffText(handoff: HandoffMoment): string {
  const to = [handoff.agentType, handoff.description && `"${handoff.description}"`]
    .filter(Boolean)
    .join(' ');
  return `The main agent is handing this task to a subagent${to ? ` (${to})` : ''}. The subagent starts from the task text alone.\n\nTask:\n${handoff.prompt || '(no task text recorded)'}`;
}

/** A work item as the Wardens read it: what the agent took in, how, and the item's text. */
export function workItemText(item: WorkItemMoment): string {
  return `The main agent took in this work item (${item.tool}: ${item.name}). The work it asks for is what to check against your domain, whatever it says to build.\n\n${item.text || '(empty)'}${
    item.clipped ? `\n… [${item.clipped} more chars not shown]` : ''
  }`;
}

/**
 * The notes a moment between turns becomes on the next turn: the "chimed in" delivery, one per Warden
 * that spoke, under a heading that names the moment (`on the handoff to …`, `on the work item …`).
 */
function betweenTurnNotes(idPrefix: string, heading: string, report: BriefReport): PromptBlock[] {
  return report.contributions
    .filter((c) => c.decision === 'contribute' && c.snippets.length)
    .map((c) => ({
      role: 'content' as const,
      id: `${idPrefix}:${c.domain}`,
      source: c.domain,
      segment: 'domain-knowledge',
      placement: 'after-message' as const,
      text: `The ${c.domain} Warden chimed in ${heading}:\n${c.snippets.map((s) => `- ${s}`).join('\n')}`,
    }));
}

/** The notes a Warden's brief becomes on the next turn, naming the handoff. */
export function briefNotes(handoff: HandoffMoment, report: BriefReport): PromptBlock[] {
  const to = handoff.description ?? handoff.agentType ?? handoff.childThreadId;
  return betweenTurnNotes(`brief:${handoff.handoffId}`, `on the handoff to ${to}`, report);
}

/** The notes a work item's answers become on the next turn, naming the item. */
export function consumedNotes(item: WorkItemMoment, report: BriefReport): PromptBlock[] {
  return betweenTurnNotes(`consumed:${item.itemId}`, `on the work item ${item.name}`, report);
}
