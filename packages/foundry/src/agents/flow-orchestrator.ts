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
// Delivery model (read this before changing hydration):
//   The executor assembles every warm layer on every turn. The ledger's
//   `skipped` classification is therefore informational for stateless
//   providers, which need the full context re-sent, and only becomes an
//   omission instruction once a stateful native session path can prove the
//   session still holds that revision. Do not drop layers from the executor
//   context on the strength of the ledger alone.
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
  computeHash,
  copyMessageIdentity,
  type LogicalMessageIdentity,
  newId,
  type ContextStack,
  type LayerState,
  type MessageDecoration,
  type ParticipantRequest,
  type PromptBlock,
  type SignalBus,
  type Signal,
} from "@inixiative/foundry-core";

import type { Cartographer, RouteRequestEvidence, RouteResult } from "./cartographer";
import type {
  AdviceRequestEvidence,
  DomainLibrarian,
  ToolObservation,
  GuardCallEvidence,
  GuardFinding,
  GuardResult,
  GuardStatus,
  PhaseRequestEvidence,
} from "./domain-librarian";
import type { Librarian } from "./librarian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What one domain decided about one input.
 * - contribute / abstain: the domain answered.
 * - error: the domain's model call failed.
 * - timeout: the domain started but had not answered by its deadline (call still outstanding).
 * - excluded: the domain never started because the plan deadline passed while it was queued.
 * - omitted: the domain contributed but the composition budget excluded it.
 */
export type ContributionDecision = "contribute" | "abstain" | "error" | "timeout" | "excluded" | "omitted";

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
  readonly reason?: string;
  readonly layers: string[];
  readonly snippets: string[];
  readonly confidence: number;
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
export type RoutingStatus = "routed" | "fallback" | "timeout" | "error";

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
  readonly kind: "route" | "advise";
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
  readonly conflicts: Array<{ readonly kind: string; readonly domain: string; readonly detail: string }>;
  /** Provider calls still running when the plan was sealed. Not cancelled. */
  readonly outstanding: OutstandingCall[];
  /** When the plan was sealed. Nothing may change it afterwards. */
  readonly sealedAt: number;
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
}

/** What the executor demonstrably received. */
export interface DeliveryEvidence {
  layers: Array<{ id: string; hash: string }>;
}

/** Event emitted when the orchestrator detects a state change that invalidates the current plan. */
export interface InvalidationEvent {
  /** What triggered the invalidation. */
  reason: "eviction" | "rehydration" | "map_rebuild" | "compaction";
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
  readonly error?: string;
  /** Provider lifecycle classification of a failed call, "unknown", or "not-admitted" when the call was refused before the provider. */
  readonly admission?: GuardCallEvidence | "unknown" | "not-admitted";
  /** Revision of the domain's own thread understanding that was supplied. */
  readonly threadKnowledgeRevision?: number;
  /** The exact guard request supplied to the domain's provider, or why none was made. */
  readonly request?: ParticipantRequest;
}

/** Caller hooks for the post-action flow. `onRequest` fires at each domain's call boundary, before its answer. */
export interface GuardPhaseHooks {
  onRequest?: (domain: string, request: PhaseRequestEvidence, threadKnowledgeRevision: number) => void;
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
  /** Per-domain outcome, in configured order. Distinguishes a completed all-clear from a failed or malformed check. */
  outcomes: GuardOutcome[];
  /** Domains whose check did not complete: provider-error, invalid-response or not-admitted. No all-clear exists for them. */
  failed: string[];
  /** Time taken for the full guard flow (ms). */
  elapsed: number;
}

/** Timing and budget settings for the pre-message flow. All bounds are validated. */
export interface FlowTimingConfig {
  /**
   * Concurrency bound for domain assessment. Every enabled domain is still
   * consulted; this only limits how many assess at once. Positive integer. Default: 5.
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
}

// ---------------------------------------------------------------------------
// Flow Orchestrator
// ---------------------------------------------------------------------------

interface Participant {
  lib: DomainLibrarian;
  cache: string;
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

type Raced<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; reason: string };

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

  constructor(config: FlowOrchestratorConfig) {
    this._cartographer = config.cartographer;
    this._domains = config.domainLibrarians;
    this._librarian = config.librarian;
    this._stack = config.stack;
    this._signals = config.signals;
    this._maxAdviseParallel = positiveInteger("maxAdviseParallel", config.maxAdviseParallel, 5);
    this._adviseTimeoutMs = positiveFiniteMs("adviseTimeoutMs", config.adviseTimeoutMs, 10_000)!;
    this._routingTimeoutMs = positiveFiniteMs("routingTimeoutMs", config.routingTimeoutMs, 10_000)!;
    this._planTimeoutMs = positiveFiniteMs("planTimeoutMs", config.planTimeoutMs, undefined);
    this._contributionBudget = positiveBudget("contributionBudget", config.contributionBudget);

    // Subscribe to signals that invalidate the current plan
    this._unsubscribes.push(
      this._signals.onAny((signal) => this._handleInvalidation(signal)),
    );
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
  async preMessage(message: string, currentMessage?: LogicalMessageIdentity): Promise<InjectionPlan> {
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

    const plan = await this._runPreMessage(this._lastMessage, false, this._lastPlan?.input.currentMessage);

    this._lastPlan = plan;
    this._invalidated = false;
    this._pendingInvalidations = [];

    return plan;
  }

  private async _runPreMessage(message: string, fresh: boolean, currentMessage?: LogicalMessageIdentity): Promise<InjectionPlan> {
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
    const participants: Participant[] = [...this._domains.values()].map((lib) => ({
      lib,
      cache: lib.cache.content,
      cacheHash: lib.cache.hash,
      cacheState: lib.cache.checkStaleness(),
      cacheLastWarmed: lib.cache.lastWarmed,
      threadKnowledge: lib.threadKnowledge.content,
      threadKnowledgeRevision: lib.threadKnowledge.revision,
      threadKnowledgeHash: lib.threadKnowledge.hash,
    }));

    const planTimeoutMs = this._planTimeoutMs;
    const deadlineAt = planTimeoutMs !== undefined ? start + planTimeoutMs : undefined;
    const clock: PlanClock = {
      deadlineAt,
      planTimeoutMs,
      passed: () => deadlineAt !== undefined && Date.now() >= deadlineAt,
      remaining: () => (deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now())),
    };
    const outstanding: OutstandingCall[] = [];

    // 2. Assess: domains start immediately (bounded pool); routing runs alongside.
    const assessments = runBounded(participants, this._maxAdviseParallel, (p) => this._assess(p, input, clock, outstanding));
    const routing = this._route(message, threadState, clock, outstanding);
    const [route, contributions] = await Promise.all([routing, assessments]);

    // 3. Compose in configured order and seal.
    return this._compose(input, route, contributions, outstanding, start, fresh);
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
    const finish = (partial: Omit<RoutingOutcome, "startedAt" | "finishedAt" | "elapsedMs" | "request">): RoutingOutcome => {
      const finishedAt = Date.now();
      const request: ParticipantRequest = observed
        ? { status: "supplied", phase: observed.phase, providerId: observed.providerId, messages: observed.messages, capturedAt: observed.capturedAt }
        : { status: "not-sent", phase: "route", reason: partial.reason ?? `${partial.status} before any provider call` };
      return { ...partial, request, startedAt, finishedAt, elapsedMs: finishedAt - startedAt };
    };
    const empty = { layers: [] as string[], domains: [] as string[], confidence: 0 };

    const task = this._cartographer.route(message, threadState, { observeRequest: (evidence) => { observed = evidence; } }).then(
      (result) => ({ kind: "result" as const, result }),
      (err: unknown) => ({ kind: "error" as const, error: (err as Error)?.message ?? String(err) }),
    );
    const raced = await this._raceDeadline(task, this._routingTimeoutMs, "route", clock);

    if (raced.timedOut) {
      this._trackOutstanding(task);
      outstanding.push({ kind: "route", participant: "cartographer", startedAt });
      return finish({ ...empty, status: "timeout", reason: raced.reason });
    }
    const outcome = raced.value;
    if (outcome.kind === "error") return finish({ ...empty, status: "error", reason: outcome.error });

    const { result } = outcome;
    const status: RoutingStatus = result.source === "keyword-fallback" ? "fallback" : "routed";
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
    const request = (decision: ContributionDecision, reason: string | undefined): ParticipantRequest => observed
      ? { status: "supplied", phase: observed.phase, providerId: observed.providerId, messages: observed.messages, capturedAt: observed.capturedAt }
      : { status: "not-sent", phase: "advice", reason: reason ?? `${decision} before any provider call` };
    const decided = (
      decision: ContributionDecision,
      extra: Partial<Pick<DomainContribution, "reason" | "layers" | "snippets" | "confidence">> = {},
    ): DomainContribution => ({
      domain: p.lib.domain,
      decision,
      layers: [],
      snippets: [],
      confidence: 0,
      ...extra,
      segments,
      provenance: provenance(),
      request: request(decision, extra.reason),
    });

    // Queued behind the pool until the plan deadline passed: never started.
    if (clock.passed()) return decided("excluded", { reason: "deadline-queued" });
    if (!p.cache) return decided("abstain", { reason: "cold-cache" });

    const task = p.lib
      .advise(input.message, input.threadState, {
        cache: p.cache,
        threadKnowledge: p.threadKnowledge,
        observeRequest: (evidence) => { observed = evidence; },
      })
      .then(
        (result) => ({ kind: "result" as const, result }),
        (err: unknown) => ({ kind: "error" as const, error: (err as Error)?.message ?? String(err) }),
      );
    const raced = await this._raceDeadline(task, this._adviseTimeoutMs, "advise", clock);

    if (raced.timedOut) {
      // The late answer, whenever it arrives, is ignored: the plan is sealed.
      // The provider call itself is still running; count it until it settles.
      this._trackOutstanding(task);
      outstanding.push({ kind: "advise", participant: p.lib.domain, startedAt });
      return decided("timeout", { reason: raced.reason });
    }
    const outcome = raced.value;
    if (outcome.kind === "error") return decided("error", { reason: outcome.error });
    const { result } = outcome;
    if (result.error) return decided("error", { reason: result.error });
    if (result.abstain || (result.layers.length === 0 && result.snippets.length === 0)) {
      return decided("abstain", { reason: result.reason ?? "no relevant context", confidence: result.confidence });
    }
    return decided("contribute", {
      layers: [...result.layers],
      snippets: [...result.snippets],
      confidence: result.confidence,
    });
  }

  /**
   * Wait for `task` up to its own deadline or the plan deadline, whichever is
   * sooner. Reports which deadline fired. Never cancels the task.
   */
  private async _raceDeadline<T>(
    task: Promise<T>,
    perCallMs: number,
    kind: "route" | "advise",
    clock: PlanClock,
  ): Promise<Raced<T>> {
    const remaining = clock.remaining();
    const planBound = remaining !== undefined && remaining < perCallMs;
    const waitMs = planBound ? remaining : perCallMs;
    const reason = planBound
      ? `plan deadline ${clock.planTimeoutMs}ms reached before ${kind} answered`
      : `no ${kind === "route" ? "route" : "answer"} within ${perCallMs}ms`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
    });
    try {
      const outcome = await Promise.race([task.then((value) => ({ value })), deadline]);
      if (outcome === "timeout") return { timedOut: true, reason };
      return { timedOut: false, value: outcome.value };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private _trackOutstanding(task: Promise<unknown>): void {
    const token = Symbol("outstanding");
    this._outstanding.add(token);
    void task.finally(() => { this._outstanding.delete(token); });
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
      if (c.decision !== "contribute") return c;
      const size = c.snippets.join("\n").length;
      if (budgetUsed + size > this._contributionBudget) {
        omissions.push({ domain: c.domain, reason: "budget" });
        return { ...c, decision: "omitted" as const, reason: "budget" };
      }
      budgetUsed += size;
      for (const layer of c.layers) layerSet.add(layer);
      snippets.push(...c.snippets);
      if (route.status === "routed" && route.domains.length > 0 && !route.domains.includes(c.domain)) {
        conflicts.push({
          kind: "routing-excluded",
          domain: c.domain,
          detail: `router selected [${route.domains.join(", ")}]; ${c.domain} contributed ${c.snippets.length} snippet(s) and ${c.layers.length} layer(s) anyway`,
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
    for (const layer of this._stack.layers) layer.setFocus(plan.input.message, plan.input.currentMessage);

    // Warm only layers we need that aren't warm yet
    const toWarm = this._stack.layers.filter(
      (l) => (layerIds.has(l.id) || l.sources.some((s) => s.focusable)) && !l.isWarm,
    );
    if (toWarm.length > 0) {
      await Promise.all(toWarm.map((l) => l.warm()));
    }

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

      if (prev && prev.hash === layer.hash) {
        skipped.push(id);
        continue;
      }

      parts.push(layer.content);
      pending.push({ id, hash: layer.hash });

      if (prev) {
        reinjected.push(id);
      } else {
        injected.push(id);
      }
    }

    if (plan.snippets.length > 0) {
      parts.push(plan.snippets.join("\n"));
    }

    const deliveredByDomain = new Map<string, string>();
    for (const [domain, lib] of this._domains) deliveredByDomain.set(domain, lib.cache.hash);

    return {
      content: parts.join("\n\n---\n\n"),
      injected,
      skipped,
      reinjected,
      pending,
      revisions,
      decoration: composeDecoration(plan, deliveredByDomain),
    };
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
        id: newId("flow-inject"),
        kind: "context_loaded",
        source: "flow-orchestrator",
        content: { layerId: id, hash },
        timestamp: Date.now(),
      });
      committed.push(id);
    }
    return committed;
  }

  // -----------------------------------------------------------------------
  // Post-action flow — correctness checking
  // -----------------------------------------------------------------------

  /**
   * Run the post-action flow: trigger-gate the observation to the right
   * domain librarians and collect findings.
   */
  async postAction(observation: ToolObservation, hooks?: GuardPhaseHooks): Promise<GuardReport> {
    const start = Date.now();
    const threadState = this._librarian.layer.content;

    // The Librarian decides which domain librarians fire
    const domainsToCheck: DomainLibrarian[] = [];
    for (const [, domainLib] of this._domains) {
      if (domainLib.shouldGuard(observation.tool)) {
        domainsToCheck.push(domainLib);
      }
    }

    // Freeze each domain's OWN thread understanding before any await, so every guard checks
    // against one revision and no other domain's private interpretation can enter its request.
    const frozen = domainsToCheck.map((d) => ({ threadKnowledge: d.threadKnowledge.content, threadKnowledgeRevision: d.threadKnowledge.revision }));

    // Run guards in parallel. Each domain's exact request is observed at its call boundary (and handed to
    // the caller's hook before any answer). A guard that throws is a failed check, never an all-clear; if it
    // threw before its request was observed, the request is unobserved, not "not sent".
    const observed: Array<PhaseRequestEvidence | null> = domainsToCheck.map(() => null);
    const results: GuardResult[] = await Promise.all(
      domainsToCheck.map((d, i) => d.guard(observation, threadState, { ...frozen[i], observeRequest: (evidence) => {
        observed[i] = evidence; hooks?.onRequest?.(d.domain, evidence, frozen[i].threadKnowledgeRevision);
      } }).catch((err: unknown): GuardResult => {
        // A refusal raised at the boundary (e.g. the caller's journal refused the request) is not a provider error:
        // no provider call was admitted. The prepared input is retained either way.
        const refused = (err as { admission?: unknown })?.admission === "not-admitted";
        return {
          findings: [], ran: true, status: refused ? "not-admitted" : "provider-error", admission: refused ? "not-admitted" : "unknown",
          error: String((err as Error)?.message ?? err).slice(0, 200), threadKnowledgeRevision: frozen[i].threadKnowledgeRevision,
          request: observed[i]
            ? { status: "supplied", phase: observed[i]!.phase, providerId: observed[i]!.providerId, messages: observed[i]!.messages, capturedAt: observed[i]!.capturedAt }
            : { status: "unobserved", phase: "guard", reason: "guard threw before its request was observed" },
        };
      })),
    );

    // Collect findings and per-domain outcomes
    const findings: GuardFinding[] = [];
    const domainsChecked: string[] = [];
    const outcomes: GuardOutcome[] = [];
    for (let i = 0; i < domainsToCheck.length; i++) {
      const r = results[i];
      domainsChecked.push(domainsToCheck[i].domain);
      if (r.status === "completed") findings.push(...r.findings);
      outcomes.push({
        domain: domainsToCheck[i].domain, status: r.status, findings: r.status === "completed" ? r.findings.length : 0,
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.admission !== undefined ? { admission: r.admission } : {}),
        ...(r.threadKnowledgeRevision !== undefined ? { threadKnowledgeRevision: r.threadKnowledgeRevision } : {}),
        request: r.request,
      });
    }
    const failed = outcomes.filter((o) => o.status === "provider-error" || o.status === "invalid-response" || o.status === "not-admitted").map((o) => o.domain);

    const critical = findings.filter((f) => f.severity === "critical");
    const advisory = findings.filter((f) => f.severity === "advisory");

    // Emit tool observation signal for the Librarian's thread-state
    await this._signals.emit({
      id: newId("flow-obs"),
      kind: "tool_observation",
      source: "flow-orchestrator",
      content: {
        tool: observation.tool,
        input: observation.input,
        filesAffected: observation.filesAffected,
        guardsRan: domainsChecked,
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
      outcomes,
      failed,
      elapsed: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // Invalidation — eviction/rehydration awareness
  // -----------------------------------------------------------------------

  private _handleInvalidation(signal: Signal): void {
    if (!this._lastPlan) return; // no plan to invalidate

    let event: InvalidationEvent | null = null;

    switch (signal.kind) {
      case "context_evicted": {
        const layerId = (signal.content as any)?.layerId;
        if (layerId && this._lastPlan.layers.includes(layerId)) {
          // A layer we injected just got evicted — plan is invalid
          event = {
            reason: "eviction",
            affectedLayers: [layerId],
            timestamp: Date.now(),
          };
        }
        break;
      }
      case "context_loaded": {
        // A layer was loaded — if it's one we wanted but didn't have, routing may improve
        const layerId = (signal.content as any)?.layerId;
        if (layerId && signal.source !== "flow-orchestrator") {
          // External rehydration (not our own commit) — check if it matters
          const layer = this._stack.getLayer(layerId);
          if (layer && !this._lastPlan.layers.includes(layerId)) {
            event = {
              reason: "rehydration",
              affectedLayers: [layerId],
              timestamp: Date.now(),
            };
          }
        }
        break;
      }
      case "session_compacted": {
        // The underlying agent session was compacted (Claude Code auto-compact,
        // Codex session restart). Whatever layers we told the Librarian were
        // delivered may have been summarized away. Clear the ledger so the
        // next turn re-delivers from scratch, and invalidate the plan.
        const cleared = this._librarian.clearInjectionLedger();
        event = {
          reason: "compaction",
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

function positiveFiniteMs(name: string, value: number | undefined, fallback: number | undefined): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive number of milliseconds, got ${value}`);
  }
  return value;
}

function positiveBudget(name: string, value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (Infinity allowed), got ${value}`);
  }
  return value;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep item order. */
async function runBounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

/** Build the executor-facing decoration from a sealed plan. */
function composeDecoration(plan: InjectionPlan, deliveredByDomain: Map<string, string>): MessageDecoration {
  const blocks: PromptBlock[] = [];

  const decisions = plan.contributions.map((c) => `${c.domain}: ${c.decision}${c.reason ? ` (${c.reason})` : ""}`);
  const routingLine = plan.routing.status === "routed"
    ? `Router selected domains: ${plan.routing.domains.length ? plan.routing.domains.join(", ") : "none"} (confidence ${plan.routing.confidence}).`
    : `Routing ${plan.routing.status}${plan.routing.reason ? ` (${plan.routing.reason})` : ""}; no router selection was applied.`;
  blocks.push({
    role: "content",
    id: "decoration:routing",
    source: "cartographer",
    segment: "routing",
    text: [
      routingLine,
      `Domain decisions: ${decisions.join("; ") || "none"}.`,
      ...(plan.conflicts.length ? [`Unresolved conflicts: ${plan.conflicts.map((c) => `${c.domain} ${c.kind}`).join("; ")}.`] : []),
    ].join("\n"),
  });

  for (const c of plan.contributions) {
    if (c.decision !== "contribute") continue;
    blocks.push({
      role: "content",
      id: `decoration:${c.domain}`,
      source: c.domain,
      segment: "domain-knowledge",
      text: `## ${c.domain} advice\n${c.snippets.map((s) => `- ${s}`).join("\n")}`,
    });
  }

  return deepFreeze({
    input: { hash: plan.input.hash, capturedAt: plan.input.capturedAt,
      ...(plan.input.currentMessage ? { currentMessage: plan.input.currentMessage } : {}) },
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
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
