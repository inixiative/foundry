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

/** Safety-net deadline for every pre-message decision (classify, route, Cartographer, advice). */
export const DECISION_DEADLINE_MS = 10_000;

export const DECISION_LATENCY_BUDGET = {
  /** The whole pre-message phase costs at most this many decision round-trips (controlled test). */
  messageToWorkerInDecisionRounds: 1.6,
  /** p95 of one warm decision under a full fan-out (live: p50 3.5 s, p95 5.5 s). */
  decisionP95Ms: 5_500,
  /**
   * p95 from message accepted to worker start with six experts, over turns the provider
   * served (live: p50 5.5 s; the slowest served turn 7.1 s). Turns caught in a provider-wide
   * stall end at the safety net instead and are reported separately.
   */
  messageToWorkerP95Ms: 7_500,
} as const;
