/**
 * @atlas
 * @kind service
 * @partOf feature:flow
 */
// ---------------------------------------------------------------------------
// Flow Orchestrator — wires the FLOW.md roles into a coherent pipeline
//
// Pre-message flow (parallel message decoration, CORE-002):
//   1. Freeze    — capture the user message, thread state and every domain's
//                  knowledge revision before any asynchronous work
//   2. Assess    — every enabled domain assesses that frozen input, in a
//                  bounded pool; each assessment has its own deadline and
//                  the whole plan may have one too
//   3. Compose   — merge in configured order into a sealed, immutable plan
//                  with explicit decisions, provenance, omissions, conflicts
//                  and still-outstanding calls
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
// Timeouts are not cancellations. A timed-out assessment is still
// running against its provider; the plan records it as outstanding and the
// orchestrator counts it until it settles. Native cancellation is G5.
//
// Post-action flow:
//   6. Correctness checking — Wardens guard tool observations
//   7. Signal reconciliation — Librarian already handles via signal bus
// ---------------------------------------------------------------------------

import {
  type AdviceOutcome,
  type AnswerRepair,
  adviceSpoke,
  type ContextStack,
  callOutcomeLabel,
  computeHash,
  copyMessageIdentity,
  type GuardCheckOutcome,
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
  type ClassifiedSummary,
  classifiedSummary,
  type DebugReasonReading,
  type WardenPointer,
} from '../classify';
import type { ChorusRemote } from '../providers/chorus-client';
import { DECISION_DEADLINE_MS, QUOTA_PAUSED_REFUSAL } from '../providers/decision-budget';
import { chorusRemoteMap, type RemoteAdvice } from './chorus-remote-map';
import type { Librarian } from './librarian';
import {
  type AdviceRequestEvidence,
  activityTools,
  adviceOutcomeOf,
  type CacheComposition,
  type EarlierMessages,
  type GuardCallEvidence,
  type GuardFinding,
  type GuardResult,
  type PhaseRequestEvidence,
  type TurnActivity,
  type Warden,
} from './warden';
import { WardenCatchUp } from './warden-catch-up';
import type { AdviceTrigger, TriggerPoint } from './warden-triggers';
import { clipMomentText } from './work-items';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
export interface WardenContribution {
  readonly domain: string;
  /**
   * How its advice call ended: not sent (cold, not held, not admitted), failed (timeout,
   * provider error, invalid response), or answered (spoke, no-comment, or omitted by the budget).
   */
  readonly outcome: AdviceOutcome;
  /** The trigger point it was asked at. */
  readonly trigger: TriggerPoint;
  readonly reason?: string;
  readonly layers: string[];
  readonly snippets: string[];
  readonly confidence: number;
  /** The charter's pointer read off the snippets (`Look over here: …`). */
  readonly pointer?: WardenPointer;
  /** The sloppy shapes the answer was let in from (protocol `AnswerRepair`); absent when it was exact. */
  readonly repairs?: readonly AnswerRepair[];
  readonly segments: ContributionSegments;
  readonly provenance: ContributionProvenance;
  /**
   * The exact provider input this domain was given at this phase, or why no call was made.
   * Observed at the call boundary; a late answer cannot rewrite it. Not evidence of native receipt.
   */
  readonly request: ParticipantRequest;
  /** A Warden with configured stages: its run, stage by stage (classify), and why it did or did not reach the thread. */
  readonly classified?: ClassifiedSummary;
  /** The exact input of every stage past the first (the first is `request`), each with its own composition. */
  readonly stageRequests?: readonly ParticipantRequest[];
  /** Skipped unsent on a user message (`not-held`): asked on it with the next one, so not degraded. */
  readonly catchesUp?: true;
  /** The missed user messages it was asked on with this one (`user-message` only). */
  readonly earlier?: { readonly count: number; readonly dropped: number };
}

/** Live debug: asks one Warden call's why, a call of its own, once its decision is journalled. */
export type DebugReasonAsk = () => Promise<DebugReasonReading>;

/** A contribution as `_assess` returns it: the ask rides beside it until the plan seals, never in it. */
type AssessedContribution = WardenContribution & { readonly askDebugReason?: DebugReasonAsk };

/** Splits the asks off the assessed contributions, so the sealed plan holds only data. */
function contributionsWithoutAsks(assessed: readonly AssessedContribution[]): {
  contributions: WardenContribution[];
  asks: Map<string, DebugReasonAsk>;
} {
  const asks = new Map<string, DebugReasonAsk>();
  const contributions = assessed.map(({ askDebugReason, ...contribution }) => {
    if (askDebugReason) asks.set(contribution.domain, askDebugReason);
    return contribution;
  });
  return { contributions, asks };
}

/** A cold Warden was given nothing: no call, so no inputs and no missed messages. */
export const givenNothing = (outcome: AdviceOutcome): boolean =>
  outcome.status === 'not-sent' && outcome.cause === 'cold';

/** The immutable input every participant assessed. */
export interface PlanInput {
  readonly message: string;
  readonly currentMessage?: LogicalMessageIdentity;
  readonly hash: string;
  readonly threadState: string;
  readonly threadStateHash: string;
  readonly capturedAt: number;
}

/** A provider call that had not settled when the plan was sealed. */
export interface OutstandingCall {
  readonly kind: 'advise';
  readonly participant: string;
  readonly startedAt: number;
}

/** Result of the pre-message flow — a sealed plan of what to inject. */
export interface InjectionPlan {
  /** Layer IDs to hydrate and include. */
  layers: string[];
  /** Inline snippets from contributing domains, in configured domain order. */
  snippets: string[];
  /** Time taken for the full pre-message flow (ms). */
  elapsed: number;
  /** Whether this plan was generated fresh or is a reuse of a previous plan. */
  fresh: boolean;
  /** The frozen input all participants saw. */
  readonly input: PlanInput;
  /** Every enabled domain, in configured order, with its decision. */
  readonly contributions: WardenContribution[];
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
  /** When the plan was sealed. Nothing may change it afterwards. */
  readonly sealedAt: number;
}

/** A call's frozen input as a journalled request, with the model that answered when known. */
function suppliedRequest(e: PhaseRequestEvidence, served?: ServedModel | null): ParticipantRequest {
  return {
    status: 'supplied',
    phase: e.phase,
    providerId: e.providerId,
    messages: e.messages,
    capturedAt: e.capturedAt,
    ...(served ? { served } : {}),
    ...(e.composition ? { composition: e.composition } : {}),
    ...(e.stage !== undefined ? { stage: e.stage } : {}),
  };
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

/** One domain guard's outcome for one observation. Only an `answered` outcome certifies its findings. */
export interface GuardOutcome {
  readonly domain: string;
  /** How the check ended; only `answered` certifies its findings. */
  readonly outcome: GuardCheckOutcome;
  readonly findings: number;
  /** What this domain said (its findings' descriptions), when it spoke. */
  readonly notes?: readonly string[];
  /** The check completed with NO_COMMENT: nothing to add. */
  readonly noComment?: true;
  /** The sloppy shapes the answer was let in from (protocol `AnswerRepair`); absent when it was exact. */
  readonly repairs?: readonly AnswerRepair[];
  readonly error?: string;
  /** Provider lifecycle classification of a failed call, "unknown", or "not-admitted" when the call was refused before the provider. */
  readonly admission?: GuardCallEvidence | 'unknown' | 'not-admitted';
  /** Revision of the domain's own thread understanding that was supplied. */
  readonly threadKnowledgeRevision?: number;
  /** The exact guard request supplied to the domain's provider, or why none was made. */
  readonly request?: ParticipantRequest;
  /** A Warden with configured stages: its run, stage by stage (classify). */
  readonly classified?: ClassifiedSummary;
  /** The exact input of every stage past the first (the first is `request`), each with its own composition. */
  readonly stageRequests?: readonly ParticipantRequest[];
}

/** Caller hooks for the post-action flow. `onRequest` fires at each domain's call boundary, before its answer. */
export interface GuardPhaseHooks {
  /** Ask only these Wardens (a retry of the ones that were degraded, FEAT-008); the rest are not asked. */
  only?: ReadonlySet<string>;
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
  /** Which domain guards were triggered (completed or not). */
  wardensChecked: string[];
  /** Domains whose guard triggers name none of the activity's tools: not asked. */
  skipped: string[];
  /** Per-domain outcome, in configured order. Distinguishes a completed all-clear from a failed or malformed check. */
  outcomes: GuardOutcome[];
  /** Domains whose check did not complete: any failure, or not sent because not held, not admitted or over budget. No all-clear exists for them. */
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

/** What a milestone call does (`turns/milestones.ts`). */
export type MilestoneKind = 'pull-request' | 'merge' | 'publish' | 'done' | 'rule-change';

/** A milestone the agent is about to reach (the `milestone` trigger): the call, as its input names it. */
export interface MilestoneMoment {
  /** One id per call: `milestone-call:<tool call id>`. */
  readonly milestoneId: string;
  readonly kind: MilestoneKind;
  readonly tool: string;
  /** What the call does: the command, the rule file's path, the status. */
  readonly detail: string;
  /**
   * When the chorus hears of it: `before` the call runs (Claude's pre-use gate), or once it has
   * `landed` (an observed call: Codex, Muse, or a Claude call the gate did not reach).
   */
  readonly when: 'before' | 'landed';
}

/** The message a turn handed back (the `hand-back` trigger), clipped like a work item. */
export interface HandBackMoment {
  readonly turnId: string;
  readonly text: string;
  /** Characters cut from the message's end, when it was clipped. */
  readonly clipped?: number;
}

/**
 * The chorus's answers at a moment between turns: a handoff (`subagent-spawn`, the brief), a work
 * item (`consumed`), a milestone call or a hand-back. Every Warden's decision, delivered on the next
 * turn, or beside a milestone call when it was asked before the call ran.
 */
export interface BriefReport {
  /** The moment the Wardens were given, frozen: the handoff or work item as text. */
  readonly input: PlanInput;
  /** Per Warden, in configured order: its call outcome (spoke with the brief, no comment, not sent or failed). */
  readonly contributions: WardenContribution[];
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
  /** Deadline per domain assessment. A late answer is recorded as a timeout. Default: `DECISION_DEADLINE_MS`. */
  adviseTimeoutMs?: number;
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
  /** Wardens, keyed by domain name. Map order is the configured order. */
  wardens: Map<string, Warden>;
  /** The signal reconciliation coordinator. */
  librarian: Librarian;
  /** The thread's context stack. */
  stack: ContextStack;
  /** Signal bus for emitting orchestration events. */
  signals: SignalBus;
  /**
   * Dev mode's remote Chorus for this thread's project, asked on every call so turning it on or off
   * takes effect on the next one: when it answers one, every Warden call is a `chorus.*` operation on it.
   */
  chorus?: () => ChorusRemote | undefined;
}

// ---------------------------------------------------------------------------
// Flow Orchestrator
// ---------------------------------------------------------------------------

interface Participant {
  warden: Warden;
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
  /**
   * Each sealed plan's, brief's and guard report's debug asks by domain. Kept beside the sealed object,
   * never on it: a plan is cloned as executor evidence, and a function cannot be.
   */
  private _debugReasonAsks = new WeakMap<object, ReadonlyMap<string, DebugReasonAsk>>();
  private _domains: Map<string, Warden>;
  private _librarian: Librarian;
  private _stack: ContextStack;
  private _signals: SignalBus;
  private _maxAdviseParallel: number;
  private _adviseTimeoutMs: number;
  private _planTimeoutMs: number | undefined;
  private _contributionBudget: number;
  private _chorus: (() => ChorusRemote | undefined) | undefined;

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
  /** Each Warden's cursor over the thread's user messages: what it missed, it is asked on next. */
  readonly catchUp = new WardenCatchUp();

  constructor(config: FlowOrchestratorConfig) {
    this._domains = config.wardens;
    this._librarian = config.librarian;
    this._stack = config.stack;
    this._signals = config.signals;
    this._chorus = config.chorus;
    this._maxAdviseParallel = positiveInteger(
      'maxAdviseParallel',
      config.maxAdviseParallel,
      Number.MAX_SAFE_INTEGER,
    );
    this._adviseTimeoutMs = positiveFiniteMs(
      'adviseTimeoutMs',
      config.adviseTimeoutMs,
      DECISION_DEADLINE_MS,
    )!;
    this._planTimeoutMs = positiveFiniteMs('planTimeoutMs', config.planTimeoutMs, undefined);
    this._contributionBudget = positiveBudget('contributionBudget', config.contributionBudget);

    // Subscribe to signals that invalidate the current plan
    this._unsubscribes.push(this._signals.onAny((signal) => this._handleInvalidation(signal)));
  }

  /** The deadlines, concurrency bound and contribution budget this orchestrator runs under, as resolved. */
  get timing(): Required<Omit<FlowTimingConfig, 'planTimeoutMs'>> & {
    readonly planTimeoutMs: number | undefined;
  } {
    return {
      maxAdviseParallel: this._maxAdviseParallel,
      adviseTimeoutMs: this._adviseTimeoutMs,
      planTimeoutMs: this._planTimeoutMs,
      contributionBudget: this._contributionBudget,
    };
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
   * assess it concurrently, and compose a sealed plan.
   *
   * The full message is passed to advising — no compression, no digestion.
   * Layers are decorators around the message, not summaries of it.
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
    //    any await, so every domain sees the same revision.
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
    // A re-fire asks on the same message again; a fresh message is the next one in the thread, and a
    // second prepare of the same logical message keeps its number.
    const seq =
      fresh || !this.catchUp.current
        ? this.catchUp.message(message, currentMessage?.messageId)
        : this.catchUp.current;

    const remote = this._chorus?.();
    if (remote) {
      const contributions = await this._assessRemote(
        remote,
        participants,
        input,
        clock,
        'user-message',
        (domain) => this.catchUp.missedBy(domain, seq),
      );
      this.catchUp.answered(seq, contributions);
      return this._compose(input, contributions, outstanding, start, fresh);
    }

    // 2. Assess: the user-message trigger point asks every Warden; each decides under the charter
    //    (bounded pool).
    const assessments = runBounded(participants, this._maxAdviseParallel, (p) =>
      this._assess(
        p,
        input,
        clock,
        outstanding,
        'user-message',
        this.catchUp.missedBy(p.warden.domain, seq),
        true,
      ),
    );
    const { contributions, asks } = contributionsWithoutAsks(await assessments);
    this.catchUp.answered(seq, contributions);

    // 3. Compose in configured order and seal.
    const plan = this._compose(input, contributions, outstanding, start, fresh);
    return this._sealedWithAsks(plan, asks);
  }

  /**
   * The debug asks of a sealed plan, brief or guard report, by domain, handed over once: whoever
   * journals the decision takes them, and a second take gets none, so no call's why is asked twice.
   */
  takeDebugReasons(
    sealed: InjectionPlan | BriefReport | GuardReport,
  ): ReadonlyMap<string, DebugReasonAsk> {
    const asks = this._debugReasonAsks.get(sealed) ?? new Map<string, DebugReasonAsk>();
    this._debugReasonAsks.delete(sealed);
    return asks;
  }

  private _sealedWithAsks<T extends object>(
    sealed: T,
    asks: ReadonlyMap<string, DebugReasonAsk>,
  ): T {
    if (asks.size) this._debugReasonAsks.set(sealed, asks);
    return sealed;
  }

  /** Every Warden with what it would assess against, frozen now, before any await. */
  private _participants(): Participant[] {
    return [...this._domains.values()].map((warden) => ({
      warden,
      cache: warden.cache.content,
      cacheComposition: warden.cacheComposition(),
      cacheHash: warden.cache.hash,
      cacheState: warden.cache.checkStaleness(),
      cacheLastWarmed: warden.cache.lastWarmed,
      threadKnowledge: warden.threadKnowledge.content,
      threadKnowledgeRevision: warden.threadKnowledge.revision,
      threadKnowledgeHash: warden.threadKnowledge.hash,
    }));
  }

  /** The shared deadline of one fan-out to the chorus, from `start`. */
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
   * The agent handed a task to a subagent: ask the chorus, once, what the subagent must know that
   * the task text leaves out. Every Warden decides under the charter through the advice protocol
   * (NO_COMMENT expected). Asked at the call (Claude's pre-use, `ThreadRuntime.briefHandoff`), it is awaited up to
   * its deadline and rides into the subagent's text; asked when the subagent starts, it never blocks.
   */
  async brief(handoff: HandoffMoment): Promise<BriefReport> {
    return this._between('subagent-spawn', handoffText(handoff));
  }

  /**
   * The agent took in a work item (the `consumed` trigger): ask the chorus, once, what of its domain
   * the work touches. Every Warden answers under the charter through the advice protocol (NO_COMMENT
   * expected); like a brief, it never blocks, and what is said rides with the next turn.
   */
  async consume(item: WorkItemMoment): Promise<BriefReport> {
    return this._between('consumed', workItemText(item));
  }

  /**
   * The agent is about to reach a milestone (the `milestone` trigger): ask the chorus, once, what its
   * domain says must happen first. Every Warden answers under the charter through the advice protocol
   * (NO_COMMENT expected). Asked at the call (Claude's pre-use, `ThreadRuntime.adviseMilestone`), it is
   * awaited up to its deadline and rides beside the call; asked when the call is observed, it never
   * blocks and rides the next turn.
   */
  async milestone(moment: MilestoneMoment): Promise<BriefReport> {
    return this._between('milestone', milestoneText(moment));
  }

  /**
   * A turn handed back (the `hand-back` trigger): ask the chorus, once, over the message the agent
   * handed back. The turn has landed, so what is said rides the next turn.
   */
  async handBack(moment: HandBackMoment): Promise<BriefReport> {
    return this._between('hand-back', handBackText(moment));
  }

  /**
   * Ask the named Wardens again on a moment where they were degraded (FEAT-008): the same moment
   * text, under its own trigger, with the current thread state. Like a brief, it never blocks, and
   * what is said rides with the next turn.
   */
  async retry(
    trigger: AdviceTrigger,
    message: string,
    domains: readonly string[],
  ): Promise<BriefReport> {
    const report = await this._between(trigger, message, new Set(domains));
    // A Retry on a user message that answers moves the Warden's cursor, so it is not asked again on it.
    if (trigger === 'user-message') this.catchUp.answeredMoment(message, report.contributions);
    return report;
  }

  /** One fan-out to the chorus at a moment between turns, through the advice protocol. */
  private async _between(
    trigger: AdviceTrigger,
    message: string,
    only?: ReadonlySet<string>,
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
    const participants = this._participants().filter((p) => !only || only.has(p.warden.domain));
    const clock = this._clock(start);
    const outstanding: OutstandingCall[] = [];
    const remote = this._chorus?.();
    const { contributions, asks } = remote
      ? {
          contributions: await this._assessRemote(remote, participants, input, clock, trigger),
          asks: new Map<string, DebugReasonAsk>(),
        }
      : contributionsWithoutAsks(
          await runBounded(participants, this._maxAdviseParallel, (p) =>
            this._assess(p, input, clock, outstanding, trigger),
          ),
        );
    return this._sealedWithAsks(
      deepFreeze({
        input,
        contributions,
        outstanding,
        elapsed: Date.now() - start,
        sealedAt: Date.now(),
      }),
      asks,
    );
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

  private async _assess(
    p: Participant,
    input: PlanInput,
    clock: PlanClock,
    outstanding: OutstandingCall[],
    trigger: AdviceTrigger = 'user-message',
    earlier?: EarlierMessages,
    /** A user message's own advice: served warm or skipped, and what it skips it catches up on. */
    catchingUp = false,
  ): Promise<AssessedContribution> {
    const startedAt = Date.now();
    // Three separately owned segments: configured instructions, configured
    // domain knowledge, and this domain's own generated understanding of the
    // thread. The global Librarian thread-state is passed to advise as a
    // fourth input but is never presented as the domain's thread knowledge.
    const segments: ContributionSegments = {
      instructions: p.warden.advisePrompt,
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
    const request = (outcome: AdviceOutcome, reason: string | undefined): ParticipantRequest =>
      observed
        ? suppliedRequest(observed, served)
        : {
            status: 'not-sent',
            phase: 'advice',
            reason: reason ?? `${callOutcomeLabel(outcome)} before any provider call`,
          };
    const decided = (
      outcome: AdviceOutcome,
      extra: Partial<
        Pick<
          AssessedContribution,
          | 'reason'
          | 'layers'
          | 'snippets'
          | 'confidence'
          | 'pointer'
          | 'repairs'
          | 'classified'
          | 'stageRequests'
          | 'catchesUp'
          | 'askDebugReason'
        >
      > = {},
    ): AssessedContribution => ({
      domain: p.warden.domain,
      outcome,
      trigger,
      layers: [],
      snippets: [],
      confidence: 0,
      ...extra,
      ...(earlier && !givenNothing(outcome)
        ? { earlier: { count: earlier.messages.length, dropped: earlier.dropped } }
        : {}),
      segments: givenNothing(outcome)
        ? { instructions: '', domainKnowledge: '', threadKnowledge: '' }
        : segments,
      provenance: provenance(),
      request: request(outcome, extra.reason),
    });
    const notSent = (cause: Extract<AdviceOutcome, { status: 'not-sent' }>['cause']) =>
      ({ status: 'not-sent', cause }) as const;
    const failed = (cause: Extract<AdviceOutcome, { status: 'failed' }>['cause']) =>
      ({ status: 'failed', cause }) as const;

    if (!p.cache) return decided(notSent('cold'), { reason: 'cold-cache' });
    // Queued behind the pool until the plan deadline passed: never sent.
    if (clock.passed()) return decided(notSent('not-admitted'), { reason: 'deadline-queued' });

    const task = p.warden
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
        ...(earlier ? { earlier } : {}),
        ...(catchingUp ? { heldOnly: true } : {}),
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
      outstanding.push({ kind: 'advise', participant: p.warden.domain, startedAt });
      return decided(failed('timeout'), { reason: raced.reason });
    }
    const settled = raced.value;
    if (settled.kind === 'error')
      return decided(failed('provider-error'), { reason: settled.error });
    const { result } = settled;
    // A staged Warden's run is journalled whatever it decided, with every later stage's exact input.
    const staged = {
      ...(result.classified ? { classified: classifiedSummary(result.classified) } : {}),
      ...(result.stageRequests?.length
        ? { stageRequests: result.stageRequests.map((e) => suppliedRequest(e)) }
        : {}),
    };
    const outcome = adviceOutcomeOf(result);
    if (outcome.status === 'failed') return decided(outcome, { reason: result.error, ...staged });
    if (outcome.status === 'not-sent')
      return decided(outcome, {
        reason: result.notSent?.reason,
        // Skipped unsent on a user message: it catches up on the next one, so it is not degraded.
        // A used-up quota is said once in the strip, not as a degraded Warden every round.
        ...(catchingUp &&
        (outcome.cause === 'not-held' || result.notSent?.reason === QUOTA_PAUSED_REFUSAL)
          ? { catchesUp: true as const }
          : {}),
        ...staged,
      });
    const repaired = {
      ...(result.repairs?.length ? { repairs: result.repairs } : {}),
      ...(result.askDebugReason ? { askDebugReason: result.askDebugReason } : {}),
    };
    if (outcome.result === 'no-comment') return decided(outcome, { ...repaired, ...staged });
    return decided(outcome, {
      layers: [...result.layers],
      snippets: [...result.snippets],
      confidence: result.confidence,
      ...(result.pointer ? { pointer: result.pointer } : {}),
      ...repaired,
      ...staged,
    });
  }

  /**
   * Dev mode: one `chorus.*` call for every participant, instead of one call each. Chorus holds the
   * Wardens, so there is no local cold gate and nothing outstanding; the plan deadline still holds,
   * and the Wardens are asked with the longest run of earlier messages any of them missed.
   */
  private async _assessRemote(
    remote: ChorusRemote,
    participants: readonly Participant[],
    input: PlanInput,
    clock: PlanClock,
    trigger: AdviceTrigger,
    missedBy?: (domain: string) => EarlierMessages | undefined,
  ): Promise<WardenContribution[]> {
    const startedAt = Date.now();
    let earlier: EarlierMessages | undefined;
    for (const p of participants) {
      const missed = missedBy?.(p.warden.domain);
      if (!missed) continue;
      if (
        earlier &&
        missed.messages.length + missed.dropped <= earlier.messages.length + earlier.dropped
      )
        continue;
      earlier = missed;
    }
    const contribution = (p: Participant, a: RemoteAdvice): WardenContribution => ({
      domain: p.warden.domain,
      outcome: a.outcome,
      trigger,
      ...(a.reason ? { reason: a.reason } : {}),
      layers: a.layers,
      snippets: a.snippets,
      confidence: a.confidence,
      ...(a.pointer ? { pointer: a.pointer } : {}),
      ...(a.classified ? { classified: a.classified } : {}),
      ...(a.catchesUp ? { catchesUp: true as const } : {}),
      ...(earlier && a.request.status === 'supplied'
        ? { earlier: { count: earlier.messages.length, dropped: earlier.dropped } }
        : {}),
      // Chorus holds the instructions and domain knowledge; only the thread knowledge goes from here.
      segments: { instructions: '', domainKnowledge: '', threadKnowledge: p.threadKnowledge },
      provenance: {
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
      },
      request: a.request,
    });
    if (clock.passed())
      return participants.map((p) =>
        contribution(p, {
          outcome: { status: 'not-sent', cause: 'not-admitted' },
          reason: 'deadline-queued',
          layers: [],
          snippets: [],
          confidence: 0,
          request: { status: 'not-sent', phase: 'advice', reason: 'deadline-queued' },
        }),
      );
    const asked = participants.map((p) => ({
      domain: p.warden.domain,
      threadKnowledge: p.threadKnowledge,
    }));
    const prepared = chorusRemoteMap.adviceCall({
      trigger,
      moment: input.message,
      threadState: input.threadState,
      asked,
      deadlineMs: Math.min(this._adviseTimeoutMs, clock.remaining() ?? Number.POSITIVE_INFINITY),
      ...(earlier ? { earlier } : {}),
      capturedAt: startedAt,
    });
    const outcome = prepared.evidence.size
      ? await remote.call(prepared.operation, prepared.input)
      : ({ ok: false, failure: 'rejected', message: 'no Warden Chorus can be asked' } as const);
    const answers = chorusRemoteMap.advice(
      prepared,
      outcome,
      asked.map((a) => a.domain),
      trigger === 'user-message' && missedBy !== undefined,
    );
    return participants.map((p) => contribution(p, answers.get(p.warden.domain)!));
  }

  /**
   * Dev mode's guard: one `chorus.guard` call for the gated Wardens. Each Warden's own slice of the call
   * is handed to `onRequest` first; one it refuses is not asked.
   */
  private async _guardRemote(
    remote: ChorusRemote,
    activity: TurnActivity,
    threadState: string,
    wardens: readonly Warden[],
    frozen: ReadonlyArray<{ threadKnowledge: string; threadKnowledgeRevision: number }>,
    hooks: GuardPhaseHooks | undefined,
  ): Promise<GuardResult[]> {
    if (!wardens.length) return [];
    const asked = wardens.map((w, i) => ({
      domain: w.domain,
      threadKnowledge: frozen[i]!.threadKnowledge,
    }));
    const call = (domains: typeof asked) =>
      chorusRemoteMap.guardCall({
        calls: activity.observations,
        threadState,
        asked: domains,
        deadlineMs: this._adviseTimeoutMs,
        capturedAt: Date.now(),
      });
    const refused = new Map<string, string>();
    const first = call(asked);
    wardens.forEach((w, i) => {
      const evidence = first.evidence.get(w.domain);
      if (!evidence) return;
      try {
        hooks?.onRequest?.(w.domain, evidence, frozen[i]!.threadKnowledgeRevision);
      } catch (err) {
        refused.set(w.domain, String((err as Error)?.message ?? err).slice(0, 200));
      }
    });
    const sent = asked.filter((a) => !refused.has(a.domain));
    const prepared = refused.size ? call(sent) : first;
    const outcome = prepared.evidence.size
      ? await remote.call('chorus.guard', prepared.input)
      : ({ ok: false, failure: 'rejected', message: 'no Warden Chorus can be asked' } as const);
    const answers = chorusRemoteMap.guard(
      prepared,
      outcome,
      sent.map((a) => a.domain),
    );
    return wardens.map((w, i): GuardResult => {
      const reason = refused.get(w.domain);
      const evidence = first.evidence.get(w.domain);
      if (reason !== undefined && evidence)
        return {
          findings: [],
          outcome: { status: 'not-sent', cause: 'not-admitted' },
          admission: 'not-admitted',
          error: reason,
          threadKnowledgeRevision: frozen[i]!.threadKnowledgeRevision,
          request: suppliedRequest(evidence),
        };
      return {
        ...answers.get(w.domain)!,
        threadKnowledgeRevision: frozen[i]!.threadKnowledgeRevision,
      };
    });
  }

  /**
   * Wait for `task` up to its own deadline or the plan deadline, whichever is
   * sooner. Reports which deadline fired. Never cancels the task.
   */
  private async _raceDeadline<T>(
    task: Promise<T>,
    perCallMs: number,
    kind: 'advise',
    clock: PlanClock,
  ): Promise<Raced<T>> {
    const remaining = clock.remaining();
    const planBound = remaining !== undefined && remaining < perCallMs;
    const waitMs = planBound ? remaining : perCallMs;
    const reason = planBound
      ? `plan deadline ${clock.planTimeoutMs}ms reached before ${kind} answered`
      : `no answer within ${perCallMs}ms`;

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
   * Merge contributions into a sealed plan. Order is the configured domain
   * order regardless of completion order. Budget exclusions become omissions.
   * The user message is carried verbatim, never rewritten.
   */
  private _compose(
    input: PlanInput,
    assessed: WardenContribution[],
    outstanding: OutstandingCall[],
    startTime: number,
    fresh: boolean,
  ): InjectionPlan {
    const layerSet = new Set<string>();
    const snippets: string[] = [];
    const omissions: Array<{ domain: string; reason: string }> = [];
    const conflicts: Array<{ kind: string; domain: string; detail: string }> = [];
    let budgetUsed = 0;

    const contributions = assessed.map((c) => {
      if (!adviceSpoke(c.outcome)) return c;
      const size = c.snippets.join('\n').length;
      if (budgetUsed + size > this._contributionBudget) {
        omissions.push({ domain: c.domain, reason: 'budget' });
        return {
          ...c,
          outcome: { status: 'answered', result: 'omitted-budget' } as const,
          reason: 'budget',
        };
      }
      budgetUsed += size;
      for (const layer of c.layers) layerSet.add(layer);
      snippets.push(...c.snippets);
      return c;
    });

    const plan: InjectionPlan = {
      layers: [...layerSet],
      snippets,
      elapsed: Date.now() - startTime,
      fresh,
      input,
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
    for (const [domain, warden] of this._domains) deliveredByDomain.set(domain, warden.cache.hash);

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
    for (const warden of this._domains.values()) if (warden.guardTriggers.has(tool)) return true;
    return false;
  }

  /**
   * Run the post-action flow over a turn's activity (one call in `per-call` mode): trigger-gate it
   * to the right Wardens, ask each once, and collect findings.
   */
  async postAction(activity: TurnActivity, hooks?: GuardPhaseHooks): Promise<GuardReport> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;

    // The agent-action trigger point asks every domain whose guard triggers name a call of the activity.
    const domainsToCheck: Warden[] = [];
    const skipped: string[] = [];
    for (const [, warden] of this._domains) {
      if (hooks?.only && !hooks.only.has(warden.domain)) continue;
      if (warden.guards(activity)) domainsToCheck.push(warden);
      else skipped.push(warden.domain);
    }

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
    const remote = this._chorus?.();
    const results: GuardResult[] = remote
      ? await this._guardRemote(remote, activity, threadState, domainsToCheck, frozen, hooks)
      : await Promise.all(
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
                  outcome: refused
                    ? { status: 'not-sent', cause: 'not-admitted' }
                    : { status: 'failed', cause: 'provider-error' },
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
    const wardensChecked: string[] = [];
    const outcomes: GuardOutcome[] = [];
    const asks = new Map<string, DebugReasonAsk>();
    for (let i = 0; i < domainsToCheck.length; i++) {
      const r = results[i];
      wardensChecked.push(domainsToCheck[i].domain);
      const answered = r.outcome.status === 'answered';
      if (answered) findings.push(...r.findings);
      outcomes.push({
        domain: domainsToCheck[i].domain,
        outcome: r.outcome,
        findings: answered ? r.findings.length : 0,
        ...(answered && r.findings.length
          ? { notes: r.findings.slice(0, 8).map((f) => f.description.slice(0, 500)) }
          : {}),
        ...(answered && r.noComment ? { noComment: true as const } : {}),
        ...(answered && r.repairs?.length ? { repairs: r.repairs } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.admission !== undefined ? { admission: r.admission } : {}),
        ...(r.threadKnowledgeRevision !== undefined
          ? { threadKnowledgeRevision: r.threadKnowledgeRevision }
          : {}),
        request: r.request,
        ...(r.classified ? { classified: classifiedSummary(r.classified) } : {}),
        ...(r.stageRequests?.length
          ? {
              stageRequests: r.stageRequests.map((e) => suppliedRequest(e)),
            }
          : {}),
      });
      if (r.askDebugReason) asks.set(domainsToCheck[i].domain, r.askDebugReason);
    }
    // Not completed: failed, or refused unsent by the queue or role budget (a cold Warden has nothing to check yet).
    const failed = outcomes
      .filter(
        (o) =>
          o.outcome.status === 'failed' ||
          (o.outcome.status === 'not-sent' &&
            (o.outcome.cause === 'not-admitted' ||
              o.outcome.cause === 'not-held' ||
              o.outcome.cause === 'over-budget')),
      )
      .map((o) => o.domain);

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
        guardsRan: wardensChecked,
        guardsSkipped: skipped,
        guardOutcomes: outcomes,
        guardsFailed: failed,
        findingsCount: findings.length,
      },
      timestamp: Date.now(),
    });

    return this._sealedWithAsks(
      {
        findings,
        wardensChecked,
        skipped,
        outcomes,
        failed,
        elapsed: Date.now() - start,
      },
      asks,
    );
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
        const layerId = (signal.content as { layerId?: string } | undefined)?.layerId;
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
        const layerId = (signal.content as { layerId?: string } | undefined)?.layerId;
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
          source: (signal.content as { source?: string } | undefined)?.source,
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
    .filter((c) => c.outcome.status === 'answered' && c.outcome.result === 'omitted-budget')
    .map((c) => `${c.domain}: omitted${c.reason ? ` (${c.reason})` : ''}`);
  if (decisions.length || plan.conflicts.length)
    blocks.push({
      role: 'content',
      id: 'decoration:decisions',
      source: 'foundry',
      segment: 'warden-decisions',
      text: [
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
    if (!adviceSpoke(c.outcome) || !c.snippets.length) continue;
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
        outcome: c.outcome,
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

/** What each milestone kind is, as a moment's text and its notes name it. */
const MILESTONE_ACTS: Readonly<Record<MilestoneKind, string>> = {
  'pull-request': 'open a pull request',
  merge: 'merge a pull request',
  publish: 'publish a package',
  done: 'mark the thread done',
  'rule-change': 'change a standing rule file',
};

/** The same acts once they have landed. */
const MILESTONE_DONE: Readonly<Record<MilestoneKind, string>> = {
  'pull-request': 'opened a pull request',
  merge: 'merged a pull request',
  publish: 'published a package',
  done: 'marked the thread done',
  'rule-change': 'changed a standing rule file',
};

/** A milestone as the Wardens read it: what the agent is about to do, and the call that does it. */
export function milestoneText(moment: MilestoneMoment): string {
  const { text, clipped } = clipMomentText(moment.detail);
  const lead =
    moment.when === 'before'
      ? `The main agent is about to ${MILESTONE_ACTS[moment.kind]} (${moment.tool}). What your domain says must happen before this lands is what to check, whatever the call says.`
      : `The main agent has just ${MILESTONE_DONE[moment.kind]} (${moment.tool}). What your domain says had to happen before this landed, or must happen now it has, is what to check, whatever the call says.`;
  return `${lead}\n\n${text}${clipped ? `\n… [${clipped} more chars not shown]` : ''}`;
}

/** What the journal keeps of a milestone's ask: its id, kind and tool, never the clipped detail twice. */
export function milestoneRecord(moment: MilestoneMoment): Record<string, unknown> {
  return {
    milestoneId: moment.milestoneId,
    kind: moment.kind,
    tool: moment.tool,
    detail: clipMomentText(moment.detail, 500).text,
  };
}

/** A hand-back as the Wardens read it: the message the agent ended its turn with. */
export function handBackText(moment: HandBackMoment): string {
  return `The main agent ended its turn and handed back this message. What it reports as done, and what it says comes next, is what to check against your domain.\n\n${moment.text || '(empty)'}${
    moment.clipped ? `\n… [${moment.clipped} more chars not shown]` : ''
  }`;
}

/**
 * The notes a moment between turns becomes on the next turn: the "chimed in" delivery, one per Warden
 * that spoke, under a heading that names the moment (`on the handoff to …`, `on the work item …`).
 */
function betweenTurnNotes(idPrefix: string, heading: string, report: BriefReport): PromptBlock[] {
  return report.contributions
    .filter((c) => adviceSpoke(c.outcome) && c.snippets.length)
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

/** The notes a milestone's answers become, naming what the agent was about to do. */
export function milestoneNotes(moment: MilestoneMoment, report: BriefReport): PromptBlock[] {
  return betweenTurnNotes(
    `milestone:${moment.milestoneId}`,
    moment.when === 'before'
      ? `as you were about to ${MILESTONE_ACTS[moment.kind]}`
      : `after you ${MILESTONE_DONE[moment.kind]}`,
    report,
  );
}

/** The notes a hand-back's answers become on the next turn. */
export function handBackNotes(moment: HandBackMoment, report: BriefReport): PromptBlock[] {
  return betweenTurnNotes(`hand-back:${moment.turnId}`, 'on your last hand-back', report);
}

/** The notes a retry's answers become on the next turn, naming the moment it asked again (FEAT-008). */
export function retryNotes(of: string, trigger: AdviceTrigger, report: BriefReport): PromptBlock[] {
  const moment =
    trigger === 'subagent-spawn'
      ? 'the earlier handoff'
      : trigger === 'consumed'
        ? 'the earlier work item'
        : trigger === 'milestone'
          ? 'the earlier milestone'
          : trigger === 'hand-back'
            ? 'your earlier hand-back'
            : 'your earlier message';
  return betweenTurnNotes(`retry:${of}`, `on ${moment} (asked again)`, report);
}

/** The notes a work item's answers become on the next turn, naming the item. */
export function consumedNotes(item: WorkItemMoment, report: BriefReport): PromptBlock[] {
  return betweenTurnNotes(`consumed:${item.itemId}`, `on the work item ${item.name}`, report);
}
