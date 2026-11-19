/**
 * @atlas
 * @kind helper
 * @partOf primitive:decisions
 */
import type { CallFailedCause, CallNotSentCause, NotSentCall } from '@inixiative/foundry-core';

/**
 * Latency budget for Foundry's pre-message decisions. Advisors must be fast: the
 * budget holds by structure (one concurrent round of decisions per message, each on
 * a warm primed session, slow ones hedged) and is checked live by
 * `scripts/measure-decisions.ts`. The deadline is a safety net, not the normal path.
 *
 * Numbers are live measurements on subscription Codex decisions (gpt-6-luna, low
 * effort, six experts, 2026-09-24). The model's own first-token latency (~2.2 s p50
 * alone, ~3.5 s under a nine-decision fan-out) sets the floor; a faster decision
 * model or provider moves it, the structure does not need to change.
 */

/**
 * Safety-net deadline for every pre-message decision (a Warden's advice).
 * Aron, 2026-11-01: "really extend the timeout limit, and then we can figure out how to make
 * things faster". At 10 s a 70-Warden chorus on 16 concurrent calls timed out on 11 of 70
 * (template replay, 2026-11-01), so the deadline was cutting answers, not catching hangs.
 */
export const DECISION_DEADLINE_MS = 60_000;

/** Upper bound a subscription policy may set for one decision's `callTimeoutMs`. */
export const DECISION_CALL_TIMEOUT_MAX_MS = 120_000;

export const DECISION_LATENCY_BUDGET = {
  /** The whole pre-message phase costs at most this many decision round-trips (controlled test). */
  messageToWorkerInDecisionRounds: 1.6,
  /** p95 of one warm decision under a full fan-out (live: p50 3.5–3.9 s, p95 5.5–7.4 s). */
  decisionP95Ms: 7_500,
  /**
   * p95 from message accepted to worker start with six experts and turns spaced like real use
   * (live, two runs: p50 6.5–7.2 s, p95 8.2–8.7 s; before this design p50 18.2 s, p95 22.7 s).
   * Turns caught in a provider-wide stall end at the safety net instead and are reported separately.
   */
  messageToWorkerP95Ms: 9_000,
} as const;

/**
 * Characters a decision's serialized messages may take; a native decision call refuses more. Above
 * DEFAULT_ROLE_BUDGET (a region Warden at the 40k-token hard cap plus its instructions) by the charter,
 * thread knowledge, thread state, the moment and its protocol, so the role budget's named error fires
 * first and this cap is the structural backstop.
 */
export const DECISION_INPUT_CAP = 160_000;

/** The refusal of held-only advice with no warm call held: the Warden was skipped unsent and catches up. */
export const NOT_HELD_REFUSAL = 'Warden not held warm on its project host; skipped unsent';

/** The capacity refusal while the decision login's usage is used up: skipped unsent until it resets. */
export const QUOTA_PAUSED_REFUSAL = "Wardens paused: the login's usage is used up until it resets";

/** Why the decision queue refused a call before any provider saw it: not held warm, or not admitted. */
export type RefusedUnsentCause = Extract<CallNotSentCause, 'not-held' | 'not-admitted'>;

/** Why a dispatched decision ended without an answer, when the queue knows: out of time, or cancelled. */
export type DecisionFailedCause = Extract<CallFailedCause, 'timeout' | 'aborted'>;

/** How a dispatched decision failed: the queue's timeout or cancellation, otherwise a provider error. */
export function decisionFailedCause(err: unknown): CallFailedCause {
  const cause = (err as { failedCause?: unknown } | null)?.failedCause;
  return cause === 'timeout' || cause === 'aborted' ? cause : 'provider-error';
}

/** The call as never sent when the decision queue refused it unsent; undefined when it failed. */
export function refusedUnsent(err: unknown): NotSentCall | undefined {
  const cause = (err as { notSentCause?: unknown } | null)?.notSentCause;
  if (cause !== 'not-held' && cause !== 'not-admitted') return undefined;
  return { cause, reason: (err as Error)?.message ?? String(err) };
}
